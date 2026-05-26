"""T9 Tur 8 — Firmware management.

Two tables:
  firmware_artifacts   — catalog of firmware images. Hybrid source:
                         'uploaded' (file on backend disk) or 'url'
                         (vendor / S3 / mirror). Per-vendor metadata
                         (vendor, os_type, model, version, sha256,
                         release_date, severity). RLS-scoped.
  firmware_install_jobs— per-device install run. State machine:
                         pending → transferring → transferred →
                         awaiting_reload → reloading → verifying →
                         success / failed / cancelled. Reload is
                         OPERATOR-GATED — the worker stops at
                         awaiting_reload until POST /jobs/{id}/approve-reload.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "f9aafirmware"
down_revision = "f9a9ipamrebld"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "firmware_artifacts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("version", sa.String(64), nullable=False),
        sa.Column("vendor", sa.String(64), nullable=False),
        sa.Column("os_type", sa.String(64), nullable=False),
        sa.Column("model", sa.String(128), nullable=True),
        sa.Column("source_type", sa.String(16), nullable=False),
        # 'uploaded' | 'url'
        sa.Column("file_path", sa.Text(), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("file_size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("sha256", sa.String(64), nullable=True),
        sa.Column("checksum_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("release_notes_url", sa.Text(), nullable=True),
        sa.Column("release_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("severity", sa.String(32), nullable=False, server_default="maintenance"),
        # 'maintenance' | 'major' | 'critical_cve'
        sa.Column("install_commands", JSONB(), nullable=True),
        # Vendor-specific command list — see services/firmware_service.py
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("location_id", sa.Integer(),
                  sa.ForeignKey("locations.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("created_by", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("source_type IN ('uploaded','url')",
                           name="ck_firmware_src_type"),
        sa.CheckConstraint("severity IN ('maintenance','major','critical_cve')",
                           name="ck_firmware_severity"),
    )
    op.create_index("ix_firmware_org", "firmware_artifacts", ["organization_id"])
    op.create_index("ix_firmware_vendor_os", "firmware_artifacts", ["vendor", "os_type"])

    op.create_table(
        "firmware_install_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("artifact_id", sa.Integer(),
                  sa.ForeignKey("firmware_artifacts.id", ondelete="RESTRICT"),
                  nullable=False),
        sa.Column("device_id", sa.Integer(),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        # pending | transferring | transferred | awaiting_reload |
        # reloading | verifying | success | failed | cancelled
        sa.Column("transfer_method", sa.String(16), nullable=False, server_default="scp"),
        # scp | tftp | agent
        sa.Column("pre_version", sa.String(64), nullable=True),
        sa.Column("post_version", sa.String(64), nullable=True),
        sa.Column("reload_required", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("reload_approved", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("reload_approved_by", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("reload_approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("log", JSONB(), nullable=True),
        # list of {ts, stage, message, level}
        sa.Column("celery_task_id", sa.String(255), nullable=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("location_id", sa.Integer(),
                  sa.ForeignKey("locations.id", ondelete="RESTRICT"),
                  nullable=False),
        sa.Column("created_by", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending','transferring','transferred','awaiting_reload',"
            "'reloading','verifying','success','failed','cancelled')",
            name="ck_firmware_job_status",
        ),
        sa.CheckConstraint(
            "transfer_method IN ('scp','tftp','agent')",
            name="ck_firmware_job_transfer",
        ),
    )
    op.create_index("ix_fw_job_artifact", "firmware_install_jobs", ["artifact_id"])
    op.create_index("ix_fw_job_device", "firmware_install_jobs", ["device_id"])
    op.create_index("ix_fw_job_org_status", "firmware_install_jobs",
                    ["organization_id", "status"])

    # ── Faz 7 RLS ────────────────────────────────────────────────────────
    for table in ("firmware_artifacts", "firmware_install_jobs"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""
            CREATE POLICY {table}_org_isolation ON {table}
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
    for table in ("firmware_install_jobs", "firmware_artifacts"):
        op.execute(f"DROP POLICY IF EXISTS {table}_org_isolation ON {table}")
    op.drop_index("ix_fw_job_org_status", table_name="firmware_install_jobs")
    op.drop_index("ix_fw_job_device", table_name="firmware_install_jobs")
    op.drop_index("ix_fw_job_artifact", table_name="firmware_install_jobs")
    op.drop_table("firmware_install_jobs")
    op.drop_index("ix_firmware_vendor_os", table_name="firmware_artifacts")
    op.drop_index("ix_firmware_org", table_name="firmware_artifacts")
    op.drop_table("firmware_artifacts")
