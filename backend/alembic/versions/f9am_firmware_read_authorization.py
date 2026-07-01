"""RBAC-SPRINT-2.2C-A — Firmware read authorization + carry-over backfill

Adds one new permission module — `firmware` — to every existing
permission_set row. Pre-Sprint-2.2C-A the three read endpoints in
firmware.py (GET /artifacts, GET /jobs, GET /jobs/{id}) were auth-only.
Frontend RoleRoute(minRole="org_admin") gated /firmware but a direct
API caller with a valid token bypassed the guard entirely and could
enumerate the ORG-WIDE firmware artifact catalog + every install job
(including SSH logs that may contain device IPs and CLI traces).

This migration + the code changes it accompanies close the read leak.
The four mutating verbs (upload, assign, install, approve_reload) are
DECLARED here so the Permission Matrix UI can render every future
firmware verb column immediately, but the backend gates for the
mutating endpoints are DEFERRED to a separate high-risk PR (see the
Sprint 2.2C-B / 2.2C-C design in docs/RBAC-SPRINT-2.2C.md).

Backfill policy (mirrors f9aj carry-over + f9ak/f9al opt-in patterns):

  1. Present keys ALWAYS win. Explicit false on any of the six new
     verbs is preserved verbatim; the migration never overwrites.

  2. Missing keys default FALSE. Safe baseline — every custom
     permission set gets the six new verbs but they stay OFF until an
     operator explicitly enables them via the Permission Matrix UI.

  3. Carry-over rule for READ verbs — ONE one-way rule that preserves
     current operator READ access on deploy:

        monitoring.view = true    →   firmware.view           = true
                                  →   firmware.rollout_status = true

     Rationale: operators who could already view monitoring dashboards
     were the same operators who reached the firmware page under the
     pre-migration RoleRoute-only guard. Keeping the two read verbs
     ON for that population prevents a visible-loss of information on
     deploy day, while still enforcing the new backend gate against
     direct API callers who never went through the frontend.

  4. Name-based opt-in for TAM YETKİ / ORG ADMIN templates. If the
     row's `name ∈ {"Tam Yetki", "Org Admin"}`, EVERY verb of the
     firmware module = true — including the mutating verbs (upload,
     assign, install, approve_reload). This matches the Phase 1 f9ah,
     Sprint 2.1 f9ai, Sprint 2.2A f9aj, Sprint 2.2B1 f9ak, and
     Sprint 2.2B2 f9al opt-in policy.

  5. Mutating verbs (firmware.upload, firmware.assign, firmware.install,
     firmware.approve_reload) get TRUE only via the name-based opt-in
     (rule 4). Custom sets NEVER inherit mutating verbs from a view
     carry-over — a monitoring viewer does not automatically become a
     firmware installer or a reboot-approver. This is the strongest
     write-verb isolation rule in the RBAC suite: pushing firmware +
     rebooting a device is HIGHEST RISK (irreversible, device downtime).

  6. NO carry-over from `device:edit` or `config:push`. Sprint 2.2C-A
     is READ-ONLY hardening; the mutating firmware verbs remain
     unwired at the backend layer and must NOT be silently granted
     from unrelated pre-existing verbs. The high-risk deferred PR
     that wires POST /install / /approve-reload / /artifacts CRUD
     gates will make its own explicit backfill decision at that time.

  7. Fail-closed on malformed rows. A non-dict `permissions` payload
     triggers a canonical reset; a non-dict module block gets a
     `{verb: False}` fresh dict regardless of any opt-in default. A
     corrupt row must never silently elevate access.

Downgrade strips the firmware module block entirely; PermissionEngine
ignores unknown keys, so the pre-migration row shape is restored
byte-identically.

Revision ID: f9amfirmwarereadauth
Revises: f9alservicesauth
"""
import json

from alembic import op
import sqlalchemy as sa


revision = "f9amfirmwarereadauth"
down_revision = "f9alservicesauth"
branch_labels = None
depends_on = None


# ── Constants ─────────────────────────────────────────────────────────────


_FULL_ACCESS_OPT_IN_NAMES = frozenset({"Tam Yetki", "Org Admin"})

# Single new module × 6 verbs = 6 new keys per row.
_NEW_MODULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("firmware", (
        "view",
        "rollout_status",
        "upload",
        "assign",
        "install",
        "approve_reload",
    )),
)

# Read-verb carry-over — source_module.source_verb → list of
# (target_module, target_verb) tuples. Sprint 2.2C-A only carries over
# to the two READ verbs; mutating firmware verbs are never targets.
_READ_CARRY_OVER: tuple[tuple[tuple[str, str], tuple[tuple[str, str], ...]], ...] = (
    (("monitoring", "view"), (
        ("firmware", "view"),
        ("firmware", "rollout_status"),
    )),
)


# ── Transform helpers (pure, idempotent) ──────────────────────────────────


def _lookup_verb_true(modules_before: dict, module: str, verb: str) -> bool:
    """Return True only when modules_before[module][verb] is exactly the
    bool True. Any missing key or non-bool value counts as False; a
    truthy int 1 or string "true" does NOT trigger the carry-over."""
    if not isinstance(modules_before, dict):
        return False
    mod = modules_before.get(module)
    if not isinstance(mod, dict):
        return False
    return mod.get(verb) is True


def _default_true_for_verb(
    modules_before: dict,
    set_name: str,
    module: str,
    verb: str,
) -> bool:
    """Combine opt-in + carry-over into a single default for one
    (module, verb) pair.

    Existing values on the row still win (rule 1) — this default is
    only used when the target key is missing from `modules_before`.
    """
    if set_name in _FULL_ACCESS_OPT_IN_NAMES:
        return True
    for (src_mod, src_verb), targets in _READ_CARRY_OVER:
        if (module, verb) in targets and _lookup_verb_true(modules_before, src_mod, src_verb):
            return True
    return False


def _backfill_module_block(
    module_before: dict | None,
    verbs: tuple[str, ...],
    default_for_verb,
) -> dict:
    """Add the new verbs to a single permission_set row's module
    sub-dict, preserving any existing values.

    Cases for `module_before`:
      - dict (possibly empty) — preserve every key, fill missing verb
                                with default_for_verb(verb)
      - None                  — module fresh, seed every verb with
                                default_for_verb(verb)
      - other                 — MALFORMED, fail-closed with
                                {verb: False} regardless of default
    """
    if module_before is None:
        return {verb: default_for_verb(verb) for verb in verbs}
    if not isinstance(module_before, dict):
        return {verb: False for verb in verbs}

    result = dict(module_before)
    for verb in verbs:
        if verb not in result:
            result[verb] = default_for_verb(verb)
    return result


def _backfill_row(permissions: dict, set_name: str) -> dict:
    """Apply the firmware backfill to one row's full permissions dict
    and return a NEW dict. Unknown modules + unknown keys are preserved
    verbatim — this migration only adds, never removes.
    """
    if not isinstance(permissions, dict):
        from app.models.shared.permission_set import DEFAULT_PERMISSIONS
        return dict(DEFAULT_PERMISSIONS)

    result = dict(permissions)
    modules_before = result.get("modules", {})
    if not isinstance(modules_before, dict):
        modules_before = {}

    modules_after = dict(modules_before)
    for module_name, verbs in _NEW_MODULES:
        modules_after[module_name] = _backfill_module_block(
            modules_before.get(module_name),
            verbs,
            lambda verb, mod=module_name: _default_true_for_verb(
                modules_before, set_name, mod, verb,
            ),
        )
    result["modules"] = modules_after
    return result


# ── Upgrade ───────────────────────────────────────────────────────────────


def upgrade() -> None:
    bind = op.get_bind()

    rows = bind.execute(
        sa.text("SELECT id, name, permissions FROM permission_sets")
    ).fetchall()

    for row in rows:
        permissions = row.permissions if isinstance(row.permissions, dict) else None
        if permissions is None:
            continue
        before = permissions
        after = _backfill_row(before, row.name or "")
        if before == after:
            continue
        bind.execute(
            sa.text(
                "UPDATE permission_sets SET permissions = CAST(:p AS json) WHERE id = :id"
            ),
            {"p": json.dumps(after), "id": row.id},
        )


# ── Downgrade ─────────────────────────────────────────────────────────────


_NEW_MODULE_NAMES = frozenset(mod for mod, _ in _NEW_MODULES)


def _downgrade_row(permissions: dict) -> dict:
    if not isinstance(permissions, dict):
        return permissions
    result = dict(permissions)
    modules = result.get("modules")
    if not isinstance(modules, dict):
        return result
    new_modules = {k: v for k, v in modules.items() if k not in _NEW_MODULE_NAMES}
    result["modules"] = new_modules
    return result


def downgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, permissions FROM permission_sets")
    ).fetchall()
    for row in rows:
        permissions = row.permissions if isinstance(row.permissions, dict) else None
        if permissions is None:
            continue
        before = permissions
        after = _downgrade_row(before)
        if before == after:
            continue
        bind.execute(
            sa.text(
                "UPDATE permission_sets SET permissions = CAST(:p AS json) WHERE id = :id"
            ),
            {"p": json.dumps(after), "id": row.id},
        )
