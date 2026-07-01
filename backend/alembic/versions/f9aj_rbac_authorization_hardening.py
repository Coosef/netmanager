"""RBAC-SPRINT-2.2A — backend authorization hardening + carry-over backfill

Adds five new permission modules — `config_drift`, `security_audit`,
`asset_lifecycle`, `terminal_sessions`, `mac_arp` — to every existing
permission_set row. Pre-Sprint-2.2A the corresponding backend endpoints
(38 total across the five .py files) had ZERO permission gates and
relied entirely on the frontend `RoleRoute` / `PermRoute` for access
control, which a direct API caller with a valid token bypasses. This
migration + the code changes it accompanies close that hole.

Backfill policy (mirrors f9ah / f9ai idempotent pattern):

  1. Present keys ALWAYS win. Explicit `false` on any of the new
     verbs is preserved verbatim; the migration never overwrites.

  2. Missing keys default to FALSE. This is the safe baseline — every
     custom permission set gets the new verbs but they stay OFF until
     an operator explicitly enables them via the Permission Matrix UI.

  3. Carry-over rules for VIEW verbs — six one-way rules that
     preserve current operator access on deploy:

        monitoring.view = true    →   security_audit.view = true
                                  →   asset_lifecycle.view = true
                                  →   mac_arp.view       = true
        audit_logs.view = true    →   terminal_sessions.view = true
        config_backups.view = true →  config_drift.view  = true
        config.view = true        →   mac_arp.collect    = true
            (semantic-fix carry-over — mac_arp.py:311 was WRONG-gated
             on `config:view` pre-2.2A; every operator who could
             collect MAC/ARP data under the old wrong gate keeps
             that access under the new correct verb)

  4. Name-based opt-in for TAM YETKİ / ORG ADMIN templates. If the
     row's `name ∈ {"Tam Yetki", "Org Admin"}`, EVERY verb of EVERY
     new module = true — including the mutating verbs (manage, run,
     profile_manage, summarize, collect). This matches the Phase 1
     f9ah and Sprint 2.1 f9ai opt-in policy.

  5. Mutating verbs (config_drift.manage, config_drift.run,
     security_audit.profile_manage, security_audit.run,
     asset_lifecycle.manage, terminal_sessions.summarize,
     mac_arp.collect) get TRUE only via the name-based opt-in
     (rule 4) or the semantic-fix carry-over (rule 3, mac_arp.collect
     only). Custom sets never inherit mutating verbs from a view
     carry-over — a viewer of monitoring dashboards does not
     automatically become a compliance-profile CRUD administrator.

  6. Fail-closed on malformed rows. A non-dict `permissions` payload
     or non-dict `modules` sub-payload triggers a canonical reset;
     a non-dict module block gets a `{verb: False}` fresh dict
     regardless of any opt-in default. A corrupt row must never
     silently elevate access.

Downgrade strips the five new module blocks entirely; PermissionEngine
ignores unknown keys so the pre-migration row shape is restored
byte-identically.

Revision ID: f9ajauthhard
Revises: f9ainotifmod
"""
import json

from alembic import op
import sqlalchemy as sa


revision = "f9ajauthhard"
down_revision = "f9ainotifmod"
branch_labels = None
depends_on = None


# ── Constants ─────────────────────────────────────────────────────────────


# Two opt-in templates: every verb of every new module = true.
# Same policy as f9ah (Phase 1) + f9ai (Sprint 2.1).
_FULL_ACCESS_OPT_IN_NAMES = frozenset({"Tam Yetki", "Org Admin"})


# Module name → tuple of (verbs) that this migration installs.
# Order matters only for visual scan in psql; the pure-function
# tests exercise each module independently.
_NEW_MODULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("config_drift",      ("view", "manage", "run")),
    ("security_audit",    ("view", "profile_manage", "run")),
    ("asset_lifecycle",   ("view", "manage")),
    ("terminal_sessions", ("view", "summarize")),
    ("mac_arp",           ("view", "collect")),
)


# View-carry-over rules — source_module.source_verb → list of
# (target_module, target_verb) tuples. Each rule preserves current
# access when the operator had the source verb turned on.
_VIEW_CARRY_OVER: tuple[tuple[tuple[str, str], tuple[tuple[str, str], ...]], ...] = (
    (("monitoring", "view"), (
        ("security_audit", "view"),
        ("asset_lifecycle", "view"),
        ("mac_arp", "view"),
    )),
    (("audit_logs", "view"), (
        ("terminal_sessions", "view"),
    )),
    (("config_backups", "view"), (
        ("config_drift", "view"),
    )),
    (("config", "view"), (
        # Semantic-fix carry-over — mac_arp.py:311 was wrong-gated on
        # config:view pre-2.2A. Preserve the access under the correct
        # new verb.
        ("mac_arp", "collect"),
    )),
)


# ── Transform helpers (pure, idempotent) ──────────────────────────────────


def _lookup_verb_true(modules_before: dict, module: str, verb: str) -> bool:
    """Look up modules_before[module][verb] safely.

    Returns True only when the exact `True` bit is set; any missing
    key or non-bool-True value counts as False. Prevents 1, "true"
    or other truthy values from accidentally carrying over.
    """
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
    """Combine the opt-in and carry-over rules into the single
    `default_value` the block builder needs for one (module, verb)
    pair.

    Rule 4 (name-based opt-in) applies to EVERY verb of the new
    modules — including mutating verbs.

    Rule 3 (view carry-over) applies only when the (module, verb)
    pair is the target of a specific carry-over rule.

    Existing values on the row still win (rule 1) — this default
    is only used when the target key is missing.
    """
    # Rule 4 — name-based opt-in ONLY for TAM YETKİ / ORG ADMIN.
    if set_name in _FULL_ACCESS_OPT_IN_NAMES:
        return True
    # Rule 3 — view carry-over from source verbs.
    for (src_mod, src_verb), targets in _VIEW_CARRY_OVER:
        if (module, verb) in targets and _lookup_verb_true(modules_before, src_mod, src_verb):
            return True
    # Default fail-safe FALSE.
    return False


def _backfill_module_block(
    module_before: dict | None,
    verbs: tuple[str, ...],
    default_for_verb,
) -> dict:
    """Add the new verbs to a single permission_set row's module
    sub-dict, preserving any existing values.

    `default_for_verb` is a callable that returns the default bool
    for each verb — the caller uses this to inject per-verb opt-in +
    carry-over logic without leaking the row context into this pure
    block-level function.

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
        # Malformed (string, list, etc) — fail-closed, ignore default.
        return {verb: False for verb in verbs}

    result = dict(module_before)
    for verb in verbs:
        if verb not in result:
            result[verb] = default_for_verb(verb)
    return result


def _backfill_row(permissions: dict, set_name: str) -> dict:
    """Apply the five module backfills to one row's full permissions
    dict and return a NEW dict. Unknown modules + unknown keys are
    preserved verbatim — this migration only adds, never removes.
    """
    if not isinstance(permissions, dict):
        # Reset to canonical empty on a malformed row.
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
