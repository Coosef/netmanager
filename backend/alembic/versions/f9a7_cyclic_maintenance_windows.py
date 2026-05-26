"""T9 Tur 6A — Cyclic maintenance windows.

Adds recurrence fields to `maintenance_windows` so a single template row can
spawn periodic instance rows (daily / weekly / monthly). A Celery beat job
(`spawn_cyclic_maintenance_windows`) materializes the next N occurrences
ahead of time so the existing alert-suppression check (start_time<=now<=end_time)
keeps working unchanged.

Columns added:
  recurrence              VARCHAR(16)  NULL    -- 'daily'|'weekly'|'monthly'
  recur_days_of_week      JSONB        NULL    -- list[int 0-6] (Mon=0)
  recur_day_of_month      INTEGER      NULL    -- 1-28 (every month safe)
  recur_count_max         INTEGER      NULL    -- cap instances spawned
  recur_until             TIMESTAMPTZ  NULL    -- stop after this time
  recur_instances_spawned INTEGER      NOT NULL DEFAULT 0
  parent_window_id        INTEGER      NULL    -- self-FK; instance → template

Index: ix_maint_parent_start (parent_window_id, start_time)
Constraint: CHECK recurrence IN ('daily','weekly','monthly') OR NULL.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# Revision identifiers, used by Alembic.
revision = "f9a7cyclicmw"
down_revision = "f9a6portchg"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("maintenance_windows", sa.Column("recurrence", sa.String(16), nullable=True))
    op.add_column("maintenance_windows", sa.Column("recur_days_of_week", JSONB(), nullable=True))
    op.add_column("maintenance_windows", sa.Column("recur_day_of_month", sa.Integer(), nullable=True))
    op.add_column("maintenance_windows", sa.Column("recur_count_max", sa.Integer(), nullable=True))
    op.add_column("maintenance_windows", sa.Column("recur_until", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "maintenance_windows",
        sa.Column("recur_instances_spawned", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "maintenance_windows",
        sa.Column("parent_window_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_maint_windows_parent_self",
        "maintenance_windows",
        "maintenance_windows",
        ["parent_window_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_maint_parent_start",
        "maintenance_windows",
        ["parent_window_id", "start_time"],
    )
    op.create_check_constraint(
        "ck_maint_recurrence_enum",
        "maintenance_windows",
        "recurrence IS NULL OR recurrence IN ('daily', 'weekly', 'monthly')",
    )
    op.create_check_constraint(
        "ck_maint_recur_day_of_month_range",
        "maintenance_windows",
        "recur_day_of_month IS NULL OR (recur_day_of_month BETWEEN 1 AND 28)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_maint_recur_day_of_month_range", "maintenance_windows", type_="check")
    op.drop_constraint("ck_maint_recurrence_enum", "maintenance_windows", type_="check")
    op.drop_index("ix_maint_parent_start", table_name="maintenance_windows")
    op.drop_constraint("fk_maint_windows_parent_self", "maintenance_windows", type_="foreignkey")
    op.drop_column("maintenance_windows", "parent_window_id")
    op.drop_column("maintenance_windows", "recur_instances_spawned")
    op.drop_column("maintenance_windows", "recur_until")
    op.drop_column("maintenance_windows", "recur_count_max")
    op.drop_column("maintenance_windows", "recur_day_of_month")
    op.drop_column("maintenance_windows", "recur_days_of_week")
    op.drop_column("maintenance_windows", "recurrence")
