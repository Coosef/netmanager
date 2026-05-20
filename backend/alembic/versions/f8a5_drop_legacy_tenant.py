"""m6 — drop the legacy tenant layer

Final M6 migration. Removes the legacy multi-tenancy artefacts now that
isolation has fully moved to `organization_id` + Postgres RLS (Faz 7
M5 / Faz 8 Phases A–H + M6 blockers B1–B4):

  * the `tenant_id` foreign-key column + index from every dependent
    table (12 tables — full list in _TENANT_FK_TABLES);
  * the `users.role` column (legacy UserRole values; user authorisation
    moved to `system_role` in Faz 7 M4 and the final endpoint
    callsites in M6-B4);
  * the `tenants` table itself (its 1:1 mapped data is now on
    `organizations`).

Downgrade is **recreate-empty-schema**: the previous code revision can
boot again (tables / columns are re-created with default values + nulls
+ FKs), but the actual row data is gone. A real rollback to live tenancy
needs a DB backup restored from before this migration.

Revision ID: f8a5droplegacytenant
Revises: f8a4orgmgmt
Create Date: 2026-05-20
"""
from alembic import op

revision = "f8a5droplegacytenant"
down_revision = "f8a4orgmgmt"
branch_labels = None
depends_on = None

# Every table that carries a `tenant_id` FK to `tenants`. Order does not
# matter for the drop (each FK + column is dropped in isolation), but is
# matched on the downgrade so re-creation respects table dependencies.
_TENANT_FK_TABLES = (
    ("users", "n"),               # confdeltype 'n' = SET NULL
    ("devices", "n"),
    ("playbooks", "n"),
    ("tasks", "n"),
    ("alert_rules", "n"),
    ("ipam_subnets", "n"),
    ("approval_requests", "n"),
    ("change_rollouts", "n"),
    ("config_backups", "n"),
    ("invite_tokens", "c"),       # 'c' = CASCADE
    ("locations", "c"),
    ("agents", "n"),
)

_DELTYPE_SQL = {"n": "SET NULL", "c": "CASCADE", "r": "RESTRICT", "a": "NO ACTION"}


def upgrade() -> None:
    # ── drop FKs + tenant_id columns from every dependent table ──────────────
    for tbl, _del in _TENANT_FK_TABLES:
        op.execute(f"ALTER TABLE {tbl} DROP CONSTRAINT IF EXISTS {tbl}_tenant_id_fkey")
        op.execute(f"DROP INDEX IF EXISTS ix_{tbl}_tenant_id")
        op.execute(f"ALTER TABLE {tbl} DROP COLUMN IF EXISTS tenant_id")

    # ── drop the legacy role column ─────────────────────────────────────────
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS role")

    # ── drop the tenants table itself ───────────────────────────────────────
    op.execute("DROP TABLE IF EXISTS tenants CASCADE")


def downgrade() -> None:
    """Recreate-empty-schema rollback. The previous code revision can
    boot again, but the legacy row data is gone — real recovery needs a
    DB backup taken before this migration ran."""

    # Recreate the tenants table with the columns the old code expected
    # (matched against models/tenant.py at the M6-B4 commit point).
    op.execute("""
        CREATE TABLE IF NOT EXISTS tenants (
          id              SERIAL PRIMARY KEY,
          name            VARCHAR(128) NOT NULL,
          slug            VARCHAR(64) UNIQUE NOT NULL,
          description     TEXT,
          is_active       BOOLEAN NOT NULL DEFAULT TRUE,
          contact_email   VARCHAR(255),
          plan_tier       VARCHAR(32) NOT NULL DEFAULT 'free',
          max_devices     INTEGER NOT NULL DEFAULT 50,
          max_users       INTEGER NOT NULL DEFAULT 5,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """)

    # Re-add users.role with a sensible default.
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS "
        "role VARCHAR(32) NOT NULL DEFAULT 'viewer'"
    )

    # Re-add every tenant_id column + index + FK with the matched delete rule.
    for tbl, deltype in _TENANT_FK_TABLES:
        rule = _DELTYPE_SQL.get(deltype, "SET NULL")
        op.execute(f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS tenant_id INTEGER")
        op.execute(
            f"CREATE INDEX IF NOT EXISTS ix_{tbl}_tenant_id ON {tbl}(tenant_id)"
        )
        op.execute(
            f"ALTER TABLE {tbl} ADD CONSTRAINT {tbl}_tenant_id_fkey "
            f"FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE {rule}"
        )
