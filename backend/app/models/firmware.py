"""T9 Tur 8 — Firmware management models.

FirmwareArtifact   — catalog row. Either uploaded (file_path) OR url-sourced
                     (source_url). Per-vendor install_commands JSON drives
                     the worker.
FirmwareInstallJob — per-device install run. State machine via `status`
                     column; reload is operator-gated.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Index,
    Integer, String, Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class FirmwareArtifact(Base):
    __tablename__ = "firmware_artifacts"
    __table_args__ = (
        CheckConstraint("source_type IN ('uploaded','url')", name="ck_firmware_src_type"),
        CheckConstraint("severity IN ('maintenance','major','critical_cve')",
                        name="ck_firmware_severity"),
        Index("ix_firmware_vendor_os", "vendor", "os_type"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    version: Mapped[str] = mapped_column(String(64), nullable=False)
    vendor: Mapped[str] = mapped_column(String(64), nullable=False)
    os_type: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    source_type: Mapped[str] = mapped_column(String(16), nullable=False)
    file_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    file_size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    sha256: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    checksum_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    release_notes_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    release_date: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    severity: Mapped[str] = mapped_column(String(32), nullable=False, default="maintenance")
    install_commands: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    location_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL"), nullable=True,
    )
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class FirmwareInstallJob(Base):
    __tablename__ = "firmware_install_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','transferring','transferred','awaiting_reload',"
            "'reloading','verifying','success','failed','cancelled')",
            name="ck_firmware_job_status",
        ),
        CheckConstraint("transfer_method IN ('scp','tftp','agent')",
                        name="ck_firmware_job_transfer"),
        Index("ix_fw_job_org_status", "organization_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    artifact_id: Mapped[int] = mapped_column(
        ForeignKey("firmware_artifacts.id", ondelete="RESTRICT"), nullable=False, index=True,
    )
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    transfer_method: Mapped[str] = mapped_column(String(16), nullable=False, default="scp")
    pre_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    post_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    reload_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    reload_approved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    reload_approved_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    reload_approved_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    log: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    celery_task_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False,
    )
    location_id: Mapped[int] = mapped_column(
        ForeignKey("locations.id", ondelete="RESTRICT"), nullable=False,
    )
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False,
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
