"""RBAC-PHASE-1 — feature module catalog backfill (discovery/vlan/racks/maps)

Adds four new module blocks to every existing permission_set row so the
permission grid can drive route visibility for Discovery, VLAN, Racks,
and Floor Plan (Map). Pre-migration these four pages were gated by
RoleRoute(minRole="org_admin") which is orthogonal to the PermissionSet
payload — a location_admin user with "Tam Yetki" still could not reach
them. The new module blocks let the same permission set toggle drive
both UI visibility AND backend gate.

Backfill policy (mirrors f9ag_canonical_permission_keys.py):

  - Present keys ALWAYS win — existing values are preserved verbatim
    (idempotent).
  - Missing keys default to FALSE for every row.
  - EXCEPT: for the two opt-in default templates whose name is in
    {"Tam Yetki", "Org Admin"} every missing key defaults to TRUE.
    Rationale: those presets are already documented as "everything on
    except users"; they must include the new modules to deliver on
    that promise after a backfill, OR else operators would have to
    manually re-toggle four modules × ~9 actions for every existing
    "Tam Yetki" row in production.

PermissionEngine ignores unknown keys, so the rollback target (this
migration's downgrade) sees the exact pre-migration JSON shape on
every row.

Revision ID: f9ahfeatmod
Revises: f9agcanonperms
"""
import json

from alembic import op
import sqlalchemy as sa


revision = "f9ahfeatmod"
down_revision = "f9agcanonperms"
branch_labels = None
depends_on = None


# ── Constants ─────────────────────────────────────────────────────────────


# Permission set NAMES that flip the new module blocks to True by default.
# Same opt-in policy as f9ag (devices.move + devices.create).
_FULL_ACCESS_OPT_IN_NAMES = frozenset({"Tam Yetki", "Org Admin"})

# Module name → ordered list of action verbs to backfill.
# Order matters only for visual scan in psql; Python dicts preserve
# insertion order so the new keys land in the same order across rows.
_NEW_MODULE_VERBS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("discovery", ("view", "run")),
    ("vlan",      ("view", "edit", "push")),
    ("racks",     ("view", "edit", "delete")),
    ("maps",      ("view",)),
)


# ── Transform helpers (pure, idempotent) ──────────────────────────────────


def _backfill_module_block(
    module_before: dict | None,
    verbs: tuple[str, ...],
    default_value: bool,
) -> dict:
    """Add the new verbs to a single permission_set row's module
    sub-dict, preserving any existing values.

    Returns a NEW dict. Pure function so the unit test can exercise
    the transform without a DB connection.

    Three cases for `module_before`:
      - dict (possibly empty)        — preserve every key, fill in any
                                       missing verb with `default_value`
      - None                         — module did not exist on the row
                                       pre-migration; seed every verb
                                       with `default_value`
      - any other type               — row is MALFORMED; emit a
                                       fail-closed block (NEVER inherits
                                       the opt-in TRUE — a corrupt row
                                       should not silently elevate access)
    """
    if module_before is None:
        return {verb: default_value for verb in verbs}
    if not isinstance(module_before, dict):
        # Malformed (string, list, etc) — fail-closed.
        return {verb: False for verb in verbs}

    result = dict(module_before)
    for verb in verbs:
        if verb not in result:
            result[verb] = default_value
    return result


def _backfill_row(permissions: dict, set_name: str) -> dict:
    """Apply all four module-level transforms to one row's full
    permissions dict and return a NEW dict. Unknown modules + unknown
    keys are preserved verbatim — this migration only adds, never
    removes.
    """
    if not isinstance(permissions, dict):
        # Reset to canonical empty on a malformed row.
        from app.models.shared.permission_set import DEFAULT_PERMISSIONS
        return dict(DEFAULT_PERMISSIONS)

    is_opt_in_template = set_name in _FULL_ACCESS_OPT_IN_NAMES
    default_value = bool(is_opt_in_template)

    result = dict(permissions)
    modules_before = result.get("modules", {})
    if not isinstance(modules_before, dict):
        modules_before = {}

    modules_after = dict(modules_before)
    for module_name, verbs in _NEW_MODULE_VERBS:
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

    # Read every permission_set row + its name. Name drives the
    # full-access opt-in policy (Tam Yetki / Org Admin only).
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
        # JSON cast for psycopg2 compatibility — same trick used by
        # f9ag_canonical_permission_keys so the dict-to-jsonb hand-off
        # works under both sync (Alembic / psycopg2) and async
        # (asyncpg) drivers.
        bind.execute(
            sa.text(
                "UPDATE permission_sets SET permissions = CAST(:p AS json) WHERE id = :id"
            ),
            {"p": json.dumps(after), "id": row.id},
        )


# ── Downgrade ─────────────────────────────────────────────────────────────


def _strip_module_block(modules_after: dict, module_name: str) -> dict:
    """Remove the module's entry entirely (the module did not exist
    pre-migration, so the post-downgrade row matches pre-upgrade
    shape exactly)."""
    if not isinstance(modules_after, dict):
        return {}
    return {k: v for k, v in modules_after.items() if k != module_name}


def _downgrade_row(permissions: dict) -> dict:
    if not isinstance(permissions, dict):
        return permissions
    result = dict(permissions)
    modules = result.get("modules")
    if not isinstance(modules, dict):
        return result
    new_modules = dict(modules)
    for module_name, _verbs in _NEW_MODULE_VERBS:
        new_modules = _strip_module_block(new_modules, module_name)
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
