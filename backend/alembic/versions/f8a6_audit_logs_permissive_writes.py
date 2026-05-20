"""m6 production-readiness — relax audit_logs WITH CHECK

The Faz 7 phase 6c `audit_logs` RLS policy (`f7a8auditrls`) declared a
strict three-way WITH CHECK:

    is_super_admin = on
    OR organization_id IS NULL
    OR organization_id = current_org GUC

In production this turned out to reject both pre-auth audit rows
(login_failed — NULL org, RETURNING re-runs USING which rejects NULL) and
the immediately-post-auth `login` audit row (the auth endpoint runs on
the unscoped `get_db` session, so `current_org_id` GUC is still empty
when log_action fires — `user.organization_id ≠ NULL` fails the third
disjunct). Both cases reproduce as a 500 against `/api/v1/auth/login`.

Threat model review:

  * Read side (USING clause) is the actual confidentiality boundary —
    org A must not see org B's audit trail. That stays untouched and
    super-admin-restricted for NULL-org rows.
  * Write side (WITH CHECK) was meant to prevent spoofing audit rows
    for another org. Every production write path goes through
    `audit_service.log_action`, which is trusted server code that
    sources `organization_id` from the authenticated user. Relaxing
    WITH CHECK to permissive does not enable a new attack surface
    accessible to API clients — they cannot reach the audit_logs
    table directly; the auth/RLS layer above the API still gates
    every endpoint.

Fix: keep USING strict (read isolation = unchanged), make WITH CHECK
permissive (write allowed regardless of GUC state, so pre-auth and
just-post-auth audit inserts work).

Revision ID: f8a6auditpermissivewrites
Revises: f8a5droplegacytenant
Create Date: 2026-05-20
"""
from alembic import op

revision = "f8a6auditpermissivewrites"
down_revision = "f8a5droplegacytenant"
branch_labels = None
depends_on = None

_ORG_READ = (
    "current_setting('app.is_super_admin', true) = 'on' "
    "OR organization_id = "
    "NULLIF(current_setting('app.current_org_id', true), '')::int"
)


def upgrade() -> None:
    # Recreate the policy with strict USING + permissive WITH CHECK.
    op.execute("DROP POLICY IF EXISTS org_isolation ON audit_logs")
    op.execute(
        f"CREATE POLICY org_isolation ON audit_logs "
        f"USING ({_ORG_READ}) "
        f"WITH CHECK (true)"
    )


def downgrade() -> None:
    """Restore the original strict WITH CHECK from f7a8."""
    _CHECK = (
        "current_setting('app.is_super_admin', true) = 'on' "
        "OR organization_id IS NULL "
        "OR organization_id = "
        "NULLIF(current_setting('app.current_org_id', true), '')::int"
    )
    op.execute("DROP POLICY IF EXISTS org_isolation ON audit_logs")
    op.execute(
        f"CREATE POLICY org_isolation ON audit_logs "
        f"USING ({_ORG_READ}) "
        f"WITH CHECK ({_CHECK})"
    )
