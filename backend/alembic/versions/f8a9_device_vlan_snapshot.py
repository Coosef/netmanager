"""device_vlan_snapshots — VLAN sayfası snapshot cache (DB)

Revision ID: f8a9vlansnap
Revises: f8a8compliance
Create Date: 2026-05-25

T8.4 — VLAN Yönetimi sayfası her açılışta paralel SSH atmasın diye
device başına son VLAN snapshot'unu tutan tablo. Faz 7 RLS pattern'i
ile org isolation.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f8a9vlansnap"
down_revision = "f8a8compliance"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "device_vlan_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("device_id", sa.Integer(),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("vlans", postgresql.JSONB(astext_type=sa.Text()),
                  nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("fetched_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.Column("fetched_by", sa.String(length=64), nullable=True),
        sa.Column("error", sa.String(length=255), nullable=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("location_id", sa.Integer(),
                  sa.ForeignKey("locations.id", ondelete="SET NULL"), nullable=True),
        sa.UniqueConstraint("device_id", name="uq_device_vlan_snapshot_device"),
    )
    op.create_index("ix_device_vlan_snapshots_device", "device_vlan_snapshots", ["device_id"])
    op.create_index("ix_device_vlan_snapshots_org", "device_vlan_snapshots", ["organization_id"])

    # Faz 7 RLS — org isolation
    op.execute("ALTER TABLE device_vlan_snapshots ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE device_vlan_snapshots FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY org_isolation ON device_vlan_snapshots
            USING ( current_setting('app.is_super_admin', true) = 'on'
                 OR organization_id = current_setting('app.current_org_id', true)::int )
            WITH CHECK ( current_setting('app.is_super_admin', true) = 'on'
                 OR organization_id = current_setting('app.current_org_id', true)::int )
    """)


def downgrade():
    op.execute("DROP POLICY IF EXISTS org_isolation ON device_vlan_snapshots")
    op.drop_index("ix_device_vlan_snapshots_org", table_name="device_vlan_snapshots")
    op.drop_index("ix_device_vlan_snapshots_device", table_name="device_vlan_snapshots")
    op.drop_table("device_vlan_snapshots")
