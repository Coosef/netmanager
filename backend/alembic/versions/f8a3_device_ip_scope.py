"""faz8 phase G — device IP uniqueness scoped to (organization, location)

A device's IP address was GLOBALLY unique (the unique index
`ix_devices_ip_address`). That made it impossible for two locations to
use overlapping private IP ranges — a normal multi-location scenario
(every branch office runs 192.168.1.0/24).

Phase G scopes the uniqueness: an IP is unique WITHIN a location, never
across the fleet. The plain lookup index on `ip_address` is kept so
discovery / device lookups stay fast.

This is the schema half of the Phase G guarantee that IP-only matching
can never reassign a device across locations — the application match is
already org+location scoped (RLS); this lets the two same-IP devices
actually coexist.

Revision ID: f8a3deviceip
Revises: f8a2lochier
Create Date: 2026-05-19
"""
from alembic import op

revision = "f8a3deviceip"
down_revision = "f8a2lochier"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop the global unique index; keep a plain (non-unique) lookup index.
    op.execute("DROP INDEX IF EXISTS ix_devices_ip_address")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_devices_ip_address ON devices (ip_address)"
    )
    # An IP is unique only within one (organization, location).
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_org_loc_ip "
        "ON devices (organization_id, location_id, ip_address)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_devices_org_loc_ip")
    op.execute("DROP INDEX IF EXISTS ix_devices_ip_address")
    op.execute(
        "CREATE UNIQUE INDEX ix_devices_ip_address ON devices (ip_address)"
    )
