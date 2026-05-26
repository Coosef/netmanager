from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class MaintenanceWindow(Base):
    __tablename__ = "maintenance_windows"
    __table_args__ = (
        Index("ix_maint_parent_start", "parent_window_id", "start_time"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    start_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # If True → suppresses alerts for all devices; if False → only device_ids list
    applies_to_all: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # JSON list of device IDs: [1, 2, 3] — null means no devices (use applies_to_all=True for global)
    device_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    # ── T9 Tur 6A — Cyclic recurrence ─────────────────────────────────────────
    # NULL = one-shot window. Setting `recurrence` turns this row into a
    # *template*: the spawn beat task creates child instance rows (with
    # parent_window_id pointing back here) at each recurrence point. The
    # children are normal one-shot windows for the suppression check.
    recurrence: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    recur_days_of_week: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # for weekly
    recur_day_of_month: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # 1-28
    recur_count_max: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    recur_until: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    recur_instances_spawned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    parent_window_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("maintenance_windows.id", ondelete="CASCADE"), nullable=True,
    )

    # Faz 7 — multi-tenant isolation
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
