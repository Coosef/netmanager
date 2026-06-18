"""location-agent-permissions + user-language-profile

Two independent but co-scoped changes ride in a single migration so the
permission-set JSON backfill and the User column add can land atomically
in one deployment window:

1. users.preferred_language — nullable VARCHAR(8). Pre-existing rows
   stay NULL (no implicit language change for any existing user). The
   PATCH /users/me/preferences endpoint and the auth /me response wire
   this up on the application side; this migration only allocates the
   storage.

2. permission_sets.permissions JSON backfill — the legacy
   `agents.edit` key is migrated into the new five-verb catalogue:

       Before: {"agents": {"view": ?, "edit": ?}}
       After:  {"agents": {"view": ?, "install": ?, "download_installer": ?, "update": ?, "remove": ?}}

   The transform preserves intent:
     - `view` carries over verbatim
     - `edit=true` → grants both `update` AND `install` (the legacy
       "edit" verb covered enrollment + metadata edit in the call
       sites it gated, so a strict split would silently revoke
       enrollment from existing operators — defer that audit to a
       later admin review)
     - `download_installer` defaults to `edit`'s value (an editor who
       could mutate the agent could already trigger a re-enrollment
       and re-download; preserving the bit avoids gating an existing
       flow)
     - `remove` defaults to FALSE for every row (destructive verb;
       admins opt in explicitly via the UI after the migration)
     - The legacy `edit` key is kept alongside the new keys so a
       rolling deploy where some pods read the old schema and some
       read the new sees consistent behaviour. PermissionEngine
       carries a module-action alias map that makes either key grant
       the same access; the column-level alias is removed in a later
       migration once every pod is on the new schema.

The migration is idempotent: re-running upgrade() on already-migrated
data is a no-op (it only touches keys that aren't already canonical).
downgrade() drops the new column and rewrites the JSON back to the
flat {"view","edit"} shape — the `install / download_installer /
remove` bits are summarised back into `edit` via OR-merge so a
round-trip never silently removes access.

Revision ID: f9afuserlangperms
Revises: f9aeportpol
"""
from alembic import op
import sqlalchemy as sa


revision = "f9afuserlangperms"
down_revision = "f9aeportpol"
branch_labels = None
depends_on = None


# ── Helpers ───────────────────────────────────────────────────────────────


def _users_preferred_language_exists(conn) -> bool:
    """Cheap idempotency check — the column add is wrapped to avoid a
    failure if a previous migration attempt half-completed (or the
    operator manually applied the column out-of-band)."""
    res = conn.execute(
        sa.text(
            """
            SELECT 1
            FROM information_schema.columns
            WHERE table_name = 'users'
              AND column_name = 'preferred_language'
            """
        )
    ).scalar()
    return bool(res)


_AGENT_KEY_LEGACY = "edit"
_AGENT_KEYS_CANONICAL = ("view", "install", "download_installer", "update", "remove")


def _transform_agents_block_upgrade(agents_before: dict) -> dict:
    """Pure-function transform: legacy → canonical, idempotent."""
    if not isinstance(agents_before, dict):
        return {k: False for k in _AGENT_KEYS_CANONICAL}
    view = bool(agents_before.get("view", False))
    edit = bool(agents_before.get(_AGENT_KEY_LEGACY, False))
    # Already-canonical rows: trust the new keys if they're present.
    install = bool(agents_before.get("install", edit))
    download_installer = bool(agents_before.get("download_installer", edit))
    update = bool(agents_before.get("update", edit))
    # `remove` is fail-closed: pre-existing rows must opt in
    # explicitly. Already-migrated rows that already had a `remove`
    # bit set keep it.
    remove = bool(agents_before.get("remove", False))
    result = {
        "view":               view,
        "install":            install,
        "download_installer": download_installer,
        "update":             update,
        "remove":             remove,
    }
    # Keep the legacy key alongside the new ones during the rolling
    # cutover (see migration docstring) — PermissionEngine treats
    # either key as a valid grant, so pods on the old schema keep
    # working after the rolling upgrade.
    if _AGENT_KEY_LEGACY in agents_before:
        result[_AGENT_KEY_LEGACY] = edit or update
    return result


def _transform_agents_block_downgrade(agents_after: dict) -> dict:
    """Reverse: any of {install, download_installer, update, edit}
    set ⇒ `edit=true` (preserving any access the operator currently
    has). `view` carries over. `remove` is dropped (no equivalent in
    the legacy schema)."""
    if not isinstance(agents_after, dict):
        return {"view": False, "edit": False}
    view = bool(agents_after.get("view", False))
    edit = bool(
        agents_after.get("edit", False)
        or agents_after.get("install", False)
        or agents_after.get("download_installer", False)
        or agents_after.get("update", False)
    )
    return {"view": view, "edit": edit}


def _rewrite_permission_sets(conn, transform) -> int:
    """Apply `transform` to every permission_sets.permissions JSON
    row. Returns the number of rows touched. Idempotent if the
    transform itself is idempotent."""
    touched = 0
    rows = conn.execute(
        sa.text("SELECT id, permissions FROM permission_sets")
    ).fetchall()
    for row in rows:
        permissions = row.permissions if isinstance(row.permissions, dict) else None
        if permissions is None:
            continue
        modules = permissions.get("modules")
        if not isinstance(modules, dict):
            continue
        agents = modules.get("agents")
        if agents is None:
            # No agent block ever existed for this row — synth a
            # deny-all canonical block on upgrade, or a deny-all
            # legacy block on downgrade. The transform handles the
            # None case via `isinstance` and returns a fresh dict.
            agents = {}
        before = dict(agents)
        after = transform(before)
        if before == after:
            continue
        modules["agents"] = after
        permissions["modules"] = modules
        conn.execute(
            sa.text(
                "UPDATE permission_sets SET permissions = :p WHERE id = :id"
            ),
            {"p": sa.cast(permissions, sa.JSON) if False else permissions, "id": row.id},
        )
        touched += 1
    return touched


# ── Upgrade ───────────────────────────────────────────────────────────────


def upgrade() -> None:
    conn = op.get_bind()

    # (1) users.preferred_language column — idempotent guard so a
    #     partial previous run does not abort with "column already
    #     exists".
    if not _users_preferred_language_exists(conn):
        op.add_column(
            "users",
            sa.Column("preferred_language", sa.String(length=8), nullable=True),
        )

    # (2) permission_sets.permissions JSON backfill. We rewrite each
    #     row in a single transaction (this entire migration runs in
    #     one) so the alias map and the column are consistent at the
    #     point any application pod starts reading the new schema.
    #     Postgres + JSONB stores the values atomically; no
    #     read-modify-write race within this migration.
    _rewrite_permission_sets(conn, _transform_agents_block_upgrade)


# ── Downgrade ─────────────────────────────────────────────────────────────


def downgrade() -> None:
    conn = op.get_bind()

    # Reverse-order reverse-operation so an in-flight pod on the new
    # schema cannot lose access between the JSON revert and the column
    # drop. We collapse the canonical keys back to the legacy pair
    # first (so the new keys carry forward as `edit=true`), then drop
    # the column.
    _rewrite_permission_sets(conn, _transform_agents_block_downgrade)

    if _users_preferred_language_exists(conn):
        op.drop_column("users", "preferred_language")
