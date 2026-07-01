"""RBAC-SPRINT-2.2B2 — Services authorization hardening

Adds one new permission module — `services` — to every existing
permission_set row. Pre-Sprint-2.2B2 all 7 endpoints in services.py
were auth-only. Frontend RoleRoute(minRole="org_admin") gated the
/services page but a direct API caller with a valid token bypassed
the guard entirely and could POST / PATCH / DELETE services (org-wide
impact analysis state).

Backfill policy (mirrors f9ak name-opt-in-only pattern):

  1. Present keys ALWAYS win. Explicit false on any new verb is
     preserved verbatim; migration never overwrites.

  2. Missing keys default FALSE. Safe baseline — every custom set
     gets the new verbs but they stay OFF until an operator explicitly
     enables them via the Permission Matrix UI.

  3. NO view carry-over. Sprint 2.2B2 does NOT carry over
     monitoring.view / config.view / any other pre-existing verb to
     services.view or services.manage. Product decision per operator
     brief: the route still gates on RoleRoute(minRole="org_admin")
     so no location_admin reaches the page today. Services model has
     NO location_id column, so location-scoped delegation isn't
     possible without a schema change (out of scope). The org_admin
     PermissionEngine bypass at engine.py:75-78 keeps every current
     org_admin working.

  4. Name-based opt-in for TAM YETKİ / ORG ADMIN templates:
     if `name ∈ {"Tam Yetki", "Org Admin"}` both new verbs = true.
     Matches Phase 1 f9ah + Sprint 2.1 f9ai + Sprint 2.2A f9aj +
     Sprint 2.2B1 f9ak opt-in policy.

  5. Fail-closed on malformed rows. Non-dict permissions payload →
     reset to DEFAULT_PERMISSIONS; non-dict module block → all-false
     regardless of any opt-in default.

Downgrade strips the services module block entirely; PermissionEngine
ignores unknown keys, so the pre-migration row shape is restored
byte-identically.

Revision ID: f9alservicesauth
Revises: f9akslapoeauth
"""
import json

from alembic import op
import sqlalchemy as sa


revision = "f9alservicesauth"
down_revision = "f9akslapoeauth"
branch_labels = None
depends_on = None


# ── Constants ─────────────────────────────────────────────────────────────


_FULL_ACCESS_OPT_IN_NAMES = frozenset({"Tam Yetki", "Org Admin"})

# Single new module × 2 verbs = 2 new keys per row.
_NEW_MODULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("services", ("view", "manage")),
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
    """Apply the services backfill to one row's full permissions dict
    and return a NEW dict. Unknown modules + unknown keys are preserved
    verbatim — this migration only adds, never removes.
    """
    if not isinstance(permissions, dict):
        from app.models.shared.permission_set import DEFAULT_PERMISSIONS
        return dict(DEFAULT_PERMISSIONS)

    # Name-based opt-in is the ONLY source of TRUE on Sprint 2.2B2.
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
