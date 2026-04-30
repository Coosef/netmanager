from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class NetworkEvent(Base):
    __tablename__ = "network_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[Optional[int]] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"), index=True)
    device_hostname: Mapped[Optional[str]] = mapped_column(String(255))

    # stp_anomaly | loop_detected | device_offline | device_online | config_change | backup_failed | port_change | high_cpu
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    # critical | warning | info
    severity: Mapped[str] = mapped_column(String(16), index=True, default="warning")

    title: Mapped[str] = mapped_column(String(255))
    message: Mapped[Optional[str]] = mapped_column(Text)
    details: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
