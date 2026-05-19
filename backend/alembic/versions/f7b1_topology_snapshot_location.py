"""topology T0 — add location_id to topology_snapshots

The topology "Final Gold Release" workstream (T0 foundation hardening)
gives TopologySnapshot an optional location scope so a golden baseline
can capture one location's fabric rather than the whole organization —
enabling location-scoped drift diffs.

NULL location_id ⇒ an org-wide snapshot (the existing behaviour, so no
backfill is needed). The column is nullable; topology_snapshots stays an
org-direct table with its existing org-only RLS policy — location_id is
an advisory filter, not a second hard boundary.

Revision ID: f7b1toposnaploc
Revises: f7a8auditrls
Create Date: 2026-05-19
"""
from alembic import op
import sqlalchemy as sa

revision = "f7b1toposnaploc"
down_revision = "f7a8auditrls"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "topology_snapshots",
        sa.Column("location_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "topology_snapshots_location_id_fkey",
        "topology_snapshots", "locations",
        ["location_id"], ["id"], ondelete="SET NULL",
    )
    op.create_index(
        "ix_topology_snapshots_location_id",
        "topology_snapshots", ["location_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_topology_snapshots_location_id", "topology_snapshots")
    op.drop_constraint(
        "topology_snapshots_location_id_fkey", "topology_snapshots",
        type_="foreignkey",
    )
    op.drop_column("topology_snapshots", "location_id")
