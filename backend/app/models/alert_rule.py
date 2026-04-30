from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AlertRule(Base):
    __tablename__ = "alert_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)

    # NULL = applies to all devices
    device_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), index=True, nullable=True
    )

    # fnmatch pattern; NULL or "" = all interfaces (e.g. "Gi0/*", "Te*")
    if_name_pattern: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

    # in_util_pct | out_util_pct | max_util_pct | error_rate
    metric: Mapped[str] = mapped_column(String(32), nullable=False, default="max_util_pct")

    threshold_value: Mapped[float] = mapped_column(Float, nullable=False)

    # How many consecutive polls must breach the threshold before firing
    consecutive_count: Mapped[int] = mapped_column(Integer, nullable=False, default=2)

    severity: Mapped[str] = mapped_column(String(16), nullable=False, default="warning")  # warning | critical

    # Minimum minutes between repeated notifications for the same rule+interface
    cooldown_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=60)

    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
