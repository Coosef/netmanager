"""faz7 phase6c — audit_logs Row-Level Security

The audit_logs table carries organization_id (added by M1, backfilled by
M2). This migration enables RLS on it so an organization only ever sees
its own audit trail — un-bypassably, the same way devices/agents are
scoped.

Policy shape:
  USING       super-admin OR organization_id = current org
              (NULL-org rows — pre-auth events such as failed logins —
              are visible to super-admins only)
  WITH CHECK  super-admin OR organization_id IS NULL OR org match
              (the IS NULL branch keeps no-context system / pre-auth
              audit inserts from being rejected)

Revision ID: f7a8auditrls
Revises: f7a7softdel
Create Date: 2026-05-18
"""
from alembic import op

revision = "f7a8auditrls"
down_revision = "f7a7softdel"
branch_labels = None
depends_on = None

_ORG = (
    "current_setting('app.is_super_admin', true) = 'on' "
    "OR organization_id = "
    "NULLIF(current_setting('app.current_org_id', true), '')::int"
)
_CHECK = (
    "current_setting('app.is_super_admin', true) = 'on' "
    "OR organization_id IS NULL "
    "OR organization_id = "
    "NULLIF(current_setting('app.current_org_id', true), '')::int"
)


def upgrade() -> None:
    op.execute("ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS org_isolation ON audit_logs")
    op.execute(
        f"CREATE POLICY org_isolation ON audit_logs "
        f"USING ({_ORG}) WITH CHECK ({_CHECK})"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS org_isolation ON audit_logs")
    op.execute("ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY")
