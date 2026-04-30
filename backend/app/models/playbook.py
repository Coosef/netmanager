from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, JSON, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Playbook(Base):
    __tablename__ = "playbooks"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)

    # Ordered list of steps: [{command, description, stop_on_error}]
    steps: Mapped[list] = mapped_column(JSON, default=list)

    # Target: either a group OR explicit device ids (empty = all active devices)
    target_group_id: Mapped[Optional[int]] = mapped_column(ForeignKey("device_groups.id"), nullable=True)
    target_device_ids: Mapped[list] = mapped_column(JSON, default=list)  # [] means use group/all

    # Schedule: interval-based auto-run (0 = disabled)
    is_scheduled: Mapped[bool] = mapped_column(Boolean, default=False)
    schedule_interval_hours: Mapped[int] = mapped_column(Integer, default=0)
    next_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    # Event-based trigger: manual | scheduled | event
    trigger_type: Mapped[str] = mapped_column(String(16), default="manual")
    trigger_event_type: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # Take a backup before running (rollback point)
    pre_run_backup: Mapped[bool] = mapped_column(Boolean, default=False)

    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    runs: Mapped[list["PlaybookRun"]] = relationship(
        "PlaybookRun", back_populates="playbook", order_by="PlaybookRun.created_at.desc()"
    )


class PlaybookRun(Base):
    __tablename__ = "playbook_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    playbook_id: Mapped[int] = mapped_column(ForeignKey("playbooks.id"), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|running|success|partial|failed|dry_run
    triggered_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    triggered_by_username: Mapped[str] = mapped_column(String(64))  # denormalized
    is_dry_run: Mapped[bool] = mapped_column(Boolean, default=False)

    # {device_id: {hostname, steps: [{command, output, success, error}], ok, error_msg}}
    device_results: Mapped[Optional[dict]] = mapped_column(JSON)

    total_devices: Mapped[int] = mapped_column(Integer, default=0)
    success_devices: Mapped[int] = mapped_column(Integer, default=0)
    failed_devices: Mapped[int] = mapped_column(Integer, default=0)

    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )

    playbook: Mapped["Playbook"] = relationship("Playbook", back_populates="runs")
