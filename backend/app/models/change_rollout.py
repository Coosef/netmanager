from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChangeRollout(Base):
    __tablename__ = "change_rollouts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # What to apply — either a template or raw commands list
    template_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("config_templates.id", ondelete="SET NULL"), nullable=True, index=True
    )
    template_variables: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    raw_commands: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # list[str]

    # Target devices
    device_ids: Mapped[list] = mapped_column(JSON, default=list)

    # status: draft → pending_approval → approved → running → done | failed | rolled_back
    status: Mapped[str] = mapped_column(String(32), default="draft", index=True)

    # Approval fields
    submitted_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    approved_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    rejection_note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Execution fields
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    # Per-device results: {device_id: {hostname, status, backup_id, output, diff, error}}
    device_results: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Counters
    total_devices: Mapped[int] = mapped_column(Integer, default=0)
    success_devices: Mapped[int] = mapped_column(Integer, default=0)
    failed_devices: Mapped[int] = mapped_column(Integer, default=0)
    rolled_back_devices: Mapped[int] = mapped_column(Integer, default=0)

    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
