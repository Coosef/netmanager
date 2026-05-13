from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class NetworkEvent(Base):
    __tablename__ = "network_events"
    __table_args__ = (
        Index("ix_network_events_created_sev", "created_at", "severity"),
        Index("ix_network_events_device_created", "device_id", text("created_at DESC")),
        Index("ix_network_events_unacked", text("created_at DESC"),
              postgresql_where=text("acknowledged = FALSE")),
    )

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

    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
