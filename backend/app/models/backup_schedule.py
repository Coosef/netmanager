from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class BackupSchedule(Base):
    __tablename__ = "backup_schedules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # 'daily' | 'weekly' | 'interval'
    schedule_type: Mapped[str] = mapped_column(String(16), default="daily", nullable=False)

    # Time of day for daily/weekly (ignored for interval)
    run_hour: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    run_minute: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Comma-separated day numbers 0=Mon..6=Sun; NULL means every day
    days_of_week: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    # Interval hours (only for schedule_type='interval')
    interval_hours: Mapped[int] = mapped_column(Integer, default=24, nullable=False)

    # Device scope: 'all' | 'stale' | 'never' | 'site'
    device_filter: Mapped[str] = mapped_column(String(16), default="all", nullable=False)
    site: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # Runtime tracking
    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    next_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_task_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_by: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.utcnow(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.utcnow(), onupdate=lambda: datetime.utcnow(), nullable=False
    )
