"""faz8 phase H — organization management: status, licence window, quota

Finalises the multi-tenant model with an explicit organization lifecycle
and enforceable per-organization quota:

  * ``status`` — active / suspended / archived (the authoritative
    operational gate; backfilled from the legacy is_active / deleted_at)
  * ``license_started_at`` / ``license_expires_at`` — the licence window
    (license_expires_at backfilled from the legacy subscription_ends_at)
  * ``max_locations`` / ``max_devices`` / ``max_agents`` / ``max_users``
    / ``max_retention_days`` — the enforced per-org quota, seeded from
    the organization's plan where one is assigned

Revision ID: f8a4orgmgmt
Revises: f8a3deviceip
Create Date: 2026-05-19
"""
from alembic import op

revision = "f8a4orgmgmt"
down_revision = "f8a3deviceip"
branch_labels = None
depends_on = None

_QUOTA_DEFAULTS = (
    ("max_locations", 5),
    ("max_devices", 200),
    ("max_agents", 10),
    ("max_users", 20),
    ("max_retention_days", 90),
)


def upgrade() -> None:
    # ── lifecycle status ─────────────────────────────────────────────────────
    op.execute(
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "
        "status VARCHAR(16) NOT NULL DEFAULT 'active'"
    )
    # Backfill from the legacy flags: a soft-deleted org → archived, an
    # inactive (but not deleted) org → suspended, everything else active.
    op.execute(
        "UPDATE organizations SET status = 'archived' WHERE deleted_at IS NOT NULL"
    )
    op.execute(
        "UPDATE organizations SET status = 'suspended' "
        "WHERE deleted_at IS NULL AND is_active = false"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_organizations_status "
        "ON organizations(status)"
    )

    # ── licence window ───────────────────────────────────────────────────────
    op.execute(
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "
        "license_started_at TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "
        "license_expires_at TIMESTAMPTZ"
    )
    op.execute(
        "UPDATE organizations SET license_expires_at = subscription_ends_at "
        "WHERE license_expires_at IS NULL AND subscription_ends_at IS NOT NULL"
    )

    # ── per-organization quota ───────────────────────────────────────────────
    for col, default in _QUOTA_DEFAULTS:
        op.execute(
            f"ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "
            f"{col} INTEGER NOT NULL DEFAULT {default}"
        )
    # Seed quota from the organization's plan where one is assigned; orgs
    # with no plan keep the column defaults above.
    op.execute("""
        UPDATE organizations o SET
            max_locations = p.max_locations,
            max_devices   = p.max_devices,
            max_agents    = p.max_agents,
            max_users     = p.max_users
        FROM plans p
        WHERE o.plan_id = p.id
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_organizations_status")
    for col in (
        "status", "license_started_at", "license_expires_at",
        "max_locations", "max_devices", "max_agents", "max_users",
        "max_retention_days",
    ):
        op.execute(f"ALTER TABLE organizations DROP COLUMN IF EXISTS {col}")
