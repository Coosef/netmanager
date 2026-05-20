"""faz7 M4 — consolidate system roles to the 4-role model

Multi-tenant isolation rework — RBAC consolidation (plan name "M4"; 5th
faz7 migration chronologically).

The platform carried two role systems: the legacy 8-value UserRole
(users.role) and the 3-value SystemRole (users.system_role:
super_admin / org_admin / member). Faz 7 collapses them into ONE coarse
system role with four values:

    super_admin      platform-wide (bypasses RLS)
    org_admin        full access within their organization
    location_admin   manages their assigned location(s)
    viewer           read-only, org/location scoped

Row visibility is enforced by RLS (M5); action-level rights remain with
PermissionSet / PermissionEngine. This migration only normalises
users.system_role / invite_tokens.system_role, derived from whichever of
the two legacy columns is most privileged. The legacy `role` column is
left in place (dropped in the Phase 7 cleanup migration).

Revision ID: f7a6roles
Revises: f7a5approle
Create Date: 2026-05-18
"""
from alembic import op

revision = "f7a6roles"
down_revision = "f7a5approle"
branch_labels = None
depends_on = None

# Most-privileged-wins remap, applied to both users and invite_tokens.
_REMAP = """
    UPDATE {tbl} SET system_role = CASE
        WHEN system_role = 'super_admin' OR role = 'super_admin'
            THEN 'super_admin'
        WHEN system_role = 'org_admin' OR role = 'admin'
            THEN 'org_admin'
        WHEN role IN ('location_manager', 'location_operator')
            THEN 'location_admin'
        ELSE 'viewer'
    END
"""


def upgrade() -> None:
    op.execute(_REMAP.format(tbl="users"))
    op.execute(_REMAP.format(tbl="invite_tokens"))


def downgrade() -> None:
    # 'member' was the pre-Faz-7 default for the unprivileged role.
    op.execute("UPDATE users SET system_role = 'member' WHERE system_role = 'viewer'")
    op.execute(
        "UPDATE invite_tokens SET system_role = 'member' WHERE system_role = 'viewer'"
    )
