"""P2-CATALOG-A — canonical permission keys + safe backfill

Closes the catalog mismatch between the stored PermissionSet payload,
the frontend `useAuthStore.can(module, action)` call sites, and the
backend `has_permission` verb evren. Before this migration the stored
payload only knew about:

    devices:        view / edit / delete / ssh
    config_backups: view / edit / delete

So a frontend check like `can('devices', 'connect')` could never find
an explicit entry on the row and fell back to the role-default map.
A `can('config_backups', 'backup')` was identical. The operator's
permission_set toggles for "SSH" did NOT actually drive the "Bilgi
Çek" button — DEFAULT_ROLE_GRANTS did. The result: tightening
"devices.ssh = false" on a row had no UI effect; loosening it had no
UI effect either.

This migration installs five canonical keys on every existing
permission_set row, with backfill values chosen to NEVER silently
revoke access an operator already had:

  devices.connect  ← devices.ssh
        (anyone who could open an SSH session could already run
         Bilgi Çek / test_connection; preserving the bit)
  config_backups.backup  ← config_backups.edit
        (anyone who could edit a backup row could already take one)
  config_backups.restore ← config_backups.edit
        (anyone who could edit could already trigger a restore)
  devices.move     ← (name in {"Tam Yetki", "Org Admin"})
        (destructive ownership transfer — only the two opt-in
         templates get TRUE by default; every other row defaults
         to FALSE per operator brief)
  devices.create   ← (name in {"Tam Yetki", "Org Admin"})
        (admin device add — same opt-in policy as move)

Already-canonical rows: if a key is already present on the row, the
existing value wins over the backfill. The migration is idempotent.

Downgrade: removes the five new keys from every permission_set row.
PermissionEngine ignores unknown keys, so the rollback target sees the
exact pre-migration JSON shape on every row.

Revision ID: f9agcanonperms
Revises: f9afuserlangperms
"""
import json

from alembic import op
import sqlalchemy as sa


revision = "f9agcanonperms"
down_revision = "f9afuserlangperms"
branch_labels = None
depends_on = None


# ── Constants ─────────────────────────────────────────────────────────────


# Canonical-but-new keys this migration installs on every
# permission_set row. Order matters only for test fixtures —
# Python dicts preserve insertion order which keeps the migrated
# rows visually scannable in psql.
_DEVICES_NEW_KEYS = ("connect", "move", "create")
_CONFIG_BACKUPS_NEW_KEYS = ("backup", "restore")

# Permission set NAMES that flip `devices.move` and `devices.create`
# to True. Per operator brief: only the two "default-everything"
# templates get the destructive ownership verbs. Every other row
# (including operator-customised sets that happen to enable everything
# else) stays at False until an admin opts in via the UI.
_DESTRUCTIVE_OPT_IN_NAMES = frozenset({"Tam Yetki", "Org Admin"})


# ── Transform helpers (pure, idempotent) ──────────────────────────────────


def _backfill_devices_block(devices_before: dict, set_name: str) -> dict:
    """Add the three new device keys to a single permission_set row's
    `devices` sub-dict, preserving any existing values.

    Returns a NEW dict — the caller decides whether to write it back.
    Pure function so the unit test can exercise the transform without
    a DB connection.
    """
    if not isinstance(devices_before, dict):
        # Defensive: a non-dict means the row is malformed; emit a
        # fail-closed canonical block instead of crashing the
        # migration.
        return {
            "view": False, "edit": False, "delete": False, "ssh": False,
            "connect": False, "move": False, "create": False,
        }

    result = dict(devices_before)
    ssh_val = bool(result.get("ssh", False))
    is_opt_in_template = set_name in _DESTRUCTIVE_OPT_IN_NAMES

    # connect: existing value wins; otherwise inherits ssh.
    if "connect" not in result:
        result["connect"] = ssh_val
    # move: existing value wins; otherwise template-controlled default.
    if "move" not in result:
        result["move"] = is_opt_in_template
    # create: existing value wins; otherwise template-controlled default.
    if "create" not in result:
        result["create"] = is_opt_in_template

    return result


def _backfill_config_backups_block(cb_before: dict) -> dict:
    """Add `backup` and `restore` to a single permission_set row's
    `config_backups` sub-dict. Both inherit the `edit` bit on backfill
    (existing edit grant covered both flows in practice)."""
    if not isinstance(cb_before, dict):
        return {
            "view": False, "edit": False, "delete": False,
            "backup": False, "restore": False,
        }

    result = dict(cb_before)
    edit_val = bool(result.get("edit", False))

    if "backup" not in result:
        result["backup"] = edit_val
    if "restore" not in result:
        result["restore"] = edit_val

    return result


def _backfill_row(permissions: dict, set_name: str) -> dict:
    """Apply both block-level transforms to one row's full permissions
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
    modules_after["devices"] = _backfill_devices_block(
        modules_before.get("devices", {}), set_name,
    )
    modules_after["config_backups"] = _backfill_config_backups_block(
        modules_before.get("config_backups", {}),
    )
    result["modules"] = modules_after
    return result


# ── Upgrade ───────────────────────────────────────────────────────────────


def upgrade() -> None:
    bind = op.get_bind()

    # Read every permission_set row + its name. Name drives the
    # `devices.move` / `devices.create` opt-in policy.
    rows = bind.execute(
        sa.text("SELECT id, name, permissions FROM permission_sets")
    ).fetchall()

    touched = 0
    for row in rows:
        permissions = row.permissions if isinstance(row.permissions, dict) else None
        if permissions is None:
            continue
        before = permissions
        after = _backfill_row(before, row.name or "")
        if before == after:
            continue
        # JSON cast for psycopg2 compatibility — same trick used by
        # the f9afuserlangperms migration so the dict-to-jsonb hand-off
        # works under both sync (Alembic / psycopg2) and async
        # (asyncpg) drivers.
        bind.execute(
            sa.text(
                "UPDATE permission_sets SET permissions = CAST(:p AS json) WHERE id = :id"
            ),
            {"p": json.dumps(after), "id": row.id},
        )
        touched += 1


# ── Downgrade ─────────────────────────────────────────────────────────────


def _strip_devices_keys(devices_after: dict) -> dict:
    """Remove the three new keys; preserve everything else."""
    if not isinstance(devices_after, dict):
        return {}
    return {k: v for k, v in devices_after.items() if k not in _DEVICES_NEW_KEYS}


def _strip_config_backups_keys(cb_after: dict) -> dict:
    if not isinstance(cb_after, dict):
        return {}
    return {k: v for k, v in cb_after.items() if k not in _CONFIG_BACKUPS_NEW_KEYS}


def _downgrade_row(permissions: dict) -> dict:
    if not isinstance(permissions, dict):
        return permissions
    result = dict(permissions)
    modules = result.get("modules")
    if not isinstance(modules, dict):
        return result
    new_modules = dict(modules)
    if "devices" in new_modules:
        new_modules["devices"] = _strip_devices_keys(new_modules["devices"])
    if "config_backups" in new_modules:
        new_modules["config_backups"] = _strip_config_backups_keys(new_modules["config_backups"])
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
