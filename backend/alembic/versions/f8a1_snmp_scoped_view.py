"""faz8 phase A — snmp_poll_results org/location isolation via a scoped view

`snmp_poll_results` is a TimescaleDB hypertable with columnstore
(compression) enabled — PostgreSQL Row-Level Security CANNOT be enabled
on it ("operation not supported on hypertables that have columnstore
enabled"). The audit proved it leaked: every org's metrics were readable
in every context, including no-context.

Fix — a SECURITY BARRIER view, DB-enforced:
  * the hypertable is renamed `snmp_poll_results_raw`
  * a security-barrier view named `snmp_poll_results` re-applies the same
    org + location predicate the RLS policies use elsewhere
  * the application role's direct access to the raw hypertable is REVOKED
    — it may only ever touch the scoped view

The view is a simple single-table view, so it stays auto-updatable:
INSERT/UPDATE/DELETE route transparently into the hypertable. Every
existing reader (ORM model + raw SQL in dashboard.py / snmp.py /
snmp_tasks.py) is transparently scoped; a forgotten reader cannot reach
the raw table — it is not granted.

Revision ID: f8a1snmpview
Revises: f7b1toposnaploc
Create Date: 2026-05-19
"""
from alembic import op

revision = "f8a1snmpview"
down_revision = "f7b1toposnaploc"
branch_labels = None
depends_on = None

_PREDICATE = (
    "current_setting('app.is_super_admin', true) = 'on' "
    "OR (organization_id = "
    "    NULLIF(current_setting('app.current_org_id', true), '')::int "
    "    AND (NULLIF(current_setting('app.current_location_id', true), '') IS NULL "
    "         OR location_id = "
    "            NULLIF(current_setting('app.current_location_id', true), '')::int))"
)


def upgrade() -> None:
    op.execute("ALTER TABLE snmp_poll_results RENAME TO snmp_poll_results_raw")
    op.execute(
        "CREATE VIEW snmp_poll_results WITH (security_barrier) AS "
        f"SELECT * FROM snmp_poll_results_raw WHERE {_PREDICATE}"
    )
    # the app role may touch ONLY the scoped view, never the raw hypertable
    op.execute(
        "DO $$ BEGIN "
        "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'netmgr_app') THEN "
        "    REVOKE ALL ON snmp_poll_results_raw FROM netmgr_app; "
        "    GRANT SELECT, INSERT, UPDATE, DELETE ON snmp_poll_results TO netmgr_app; "
        "  END IF; "
        "END $$;"
    )


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS snmp_poll_results")
    op.execute("ALTER TABLE snmp_poll_results_raw RENAME TO snmp_poll_results")
    op.execute(
        "DO $$ BEGIN "
        "  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'netmgr_app') THEN "
        "    GRANT SELECT, INSERT, UPDATE, DELETE ON snmp_poll_results TO netmgr_app; "
        "  END IF; "
        "END $$;"
    )
