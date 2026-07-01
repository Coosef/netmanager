"""RBAC-SPRINT-2.2B1 — SLA + PoE authorization hardening

Adds two new permission modules — `sla` and `poe` — to every existing
permission_set row. Pre-Sprint-2.2B1 both surfaces (SLA + PoE) had ZERO
backend permission gates on 12 endpoints total (SLA 8, PoE 4). Frontend
RoleRoute(minRole="org_admin") gated the pages but a direct API caller
with a valid token bypassed the guard entirely.

Backfill policy (mirrors f9aj / f9ai / f9ah idempotent pattern, but
STRIPPED — no view carry-over from any pre-existing verb):

  1. Present keys ALWAYS win. Explicit false on any new verb is
     preserved verbatim; migration never overwrites.

  2. Missing keys default FALSE. Safe baseline — every custom set
     gets the new verbs but they stay OFF until an operator explicitly
     enables them via the Permission Matrix UI.

  3. NO view carry-over. Sprint 2.2B1 does NOT carry over
     monitoring.view / config.view / any other pre-existing verb to
     sla.view or poe.view. Product decision per operator brief: SLA
     and PoE routes still gate on RoleRoute(minRole="org_admin") in
     this PR, so no location_admin reaches them today. The org_admin
     PermissionEngine bypass at engine.py:75-78 keeps every current
     org_admin working — they hit the frontend gate + the backend
     bypass on every endpoint. A future PR that flips SLA/PoE routes
     to PermRoute + expands location_admin visibility WILL need to
     add a carry-over rule; deferred here.

  4. Name-based opt-in for TAM YETKİ / ORG ADMIN templates:
     if `name ∈ {"Tam Yetki", "Org Admin"}` every verb of both new
     modules = true. Matches Phase 1 f9ah + Sprint 2.1 f9ai + Sprint
     2.2A f9aj opt-in policy.

  5. Fail-closed on malformed rows. Non-dict permissions payload → reset
     to DEFAULT_PERMISSIONS; non-dict module block → all-false regardless
     of any opt-in default.

Downgrade strips the two new module blocks entirely; PermissionEngine
ignores unknown keys, so the pre-migration row shape is restored
byte-identically.

NOTE ON POE.REFRESH SEMANTICS:
The poe.py endpoint `GET /devices/{device_id}/realtime` is documented
in this PR as a MUTATING endpoint despite its GET verb — it executes an
SSH command on the target device AND writes the parsed PoE power
result back to PoEPortSnapshot (`db.commit()` at poe.py:237). The
HTTP-method rename to POST is out of scope for this PR; the test suite
pins the mutation for a future semantic-fix PR.

Revision ID: f9akslapoeauth
Revises: f9ajauthhard
"""
import json

from alembic import op
import sqlalchemy as sa


revision = "f9akslapoeauth"
down_revision = "f9ajauthhard"
branch_labels = None
depends_on = None


# ── Constants ─────────────────────────────────────────────────────────────


_FULL_ACCESS_OPT_IN_NAMES = frozenset({"Tam Yetki", "Org Admin"})

# Module name → verb tuple. Sprint 2.2B1 is the smallest possible
# addition — 2 modules × 2 verbs = 4 new keys per row.
_NEW_MODULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("sla", ("view", "manage_policies")),
    ("poe", ("view", "refresh")),
)


# ── Transform helpers (pure, idempotent) ──────────────────────────────────


def _backfill_module_block(
    module_before: dict | None,
    verbs: tuple[str, ...],
    default_value: bool,
) -> dict:
    """Add the new verbs to a single permission_set row's module
    sub-dict, preserving any existing values.

    Cases for `module_before`:
      - dict (possibly empty) — preserve every key, fill missing verbs
                                with `default_value`
      - None                  — module absent pre-migration; seed every
                                verb with `default_value`
      - other                 — MALFORMED; fail-closed with
                                {verb: False} regardless of default
    """
    if module_before is None:
        return {verb: default_value for verb in verbs}
    if not isinstance(module_before, dict):
        return {verb: False for verb in verbs}

    result = dict(module_before)
    for verb in verbs:
        if verb not in result:
            result[verb] = default_value
    return result


def _backfill_row(permissions: dict, set_name: str) -> dict:
    """Apply the sla + poe backfills to one row's full permissions
    dict and return a NEW dict. Unknown modules + unknown keys are
    preserved verbatim — this migration only adds, never removes.
    """
    if not isinstance(permissions, dict):
        from app.models.shared.permission_set import DEFAULT_PERMISSIONS
        return dict(DEFAULT_PERMISSIONS)

    # Name-based opt-in is the ONLY source of TRUE on Sprint 2.2B1.
    default_value = set_name in _FULL_ACCESS_OPT_IN_NAMES

    result = dict(permissions)
    modules_before = result.get("modules", {})
    if not isinstance(modules_before, dict):
        modules_before = {}

    modules_after = dict(modules_before)
    for module_name, verbs in _NEW_MODULES:
        modules_after[module_name] = _backfill_module_block(
            modules_before.get(module_name),
            verbs,
            default_value,
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
