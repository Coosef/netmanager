"""T9 Tur 6B — PoE per-port snapshot table.

Topology already collects PoE-per-port via `show power inline`, but it
ONLY stores it for ports that have a discovered LLDP/CDP neighbor —
exactly the wrong subset for energy reporting (IP phones, APs, cameras
often don't advertise LLDP).

This table is the dedicated home for the periodic PoE snapshot. One row
per device+port, upserted by `snapshot_poe_status` beat task (15-minute
cadence). Reads: per-device drill-down + org-wide aggregation.
"""
from alembic import op
import sqlalchemy as sa


revision = "f9a8poesnap"
down_revision = "f9a7cyclicmw"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "poe_port_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("device_id", sa.Integer(),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("port", sa.String(64), nullable=False),
        # 'on' / 'off' / 'denied' / 'searching' / 'faulty'  (vendor-normalized)
        sa.Column("oper_status", sa.String(16), nullable=False, server_default="off"),
        sa.Column("admin_status", sa.String(16), nullable=True),
        sa.Column("power_mw", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_mw", sa.Integer(), nullable=True),
        sa.Column("device_class", sa.String(16), nullable=True),  # Class 0..8 if reported
        sa.Column("source", sa.String(16), nullable=False, server_default="cli"),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("location_id", sa.Integer(),
                  sa.ForeignKey("locations.id", ondelete="RESTRICT"),
                  nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("device_id", "port", name="uq_poe_port_snapshot_devport"),
    )
    op.create_index("ix_poe_port_snapshots_org", "poe_port_snapshots", ["organization_id"])
    op.create_index("ix_poe_port_snapshots_dev", "poe_port_snapshots", ["device_id"])
    op.create_index("ix_poe_port_snapshots_org_loc", "poe_port_snapshots",
                    ["organization_id", "location_id"])

    # Faz 7 RLS — match the pattern of the device-bound tables.
    op.execute("ALTER TABLE poe_port_snapshots ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE poe_port_snapshots FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY poe_snap_org_isolation ON poe_port_snapshots
        USING (
            current_setting('app.is_super_admin', true) = 'on'
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        )
        WITH CHECK (
            current_setting('app.is_super_admin', true) = 'on'
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        )
    """)


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS poe_snap_org_isolation ON poe_port_snapshots")
    op.drop_index("ix_poe_port_snapshots_org_loc", table_name="poe_port_snapshots")
    op.drop_index("ix_poe_port_snapshots_dev", table_name="poe_port_snapshots")
    op.drop_index("ix_poe_port_snapshots_org", table_name="poe_port_snapshots")
    op.drop_table("poe_port_snapshots")
