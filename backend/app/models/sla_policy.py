from datetime import datetime
from typing import Optional
from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base


class SlaPolicy(Base):
    __tablename__ = "sla_policies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    target_uptime_pct: Mapped[float] = mapped_column(Float, default=99.0)
    measurement_window_days: Mapped[int] = mapped_column(Integer, default=30)
    # JSON arrays of IDs — empty list means "all devices"
    device_ids: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    group_ids: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    notify_on_breach: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow
    )
