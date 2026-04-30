from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SnmpPollResult(Base):
    """One SNMP poll snapshot per interface per device."""
    __tablename__ = "snmp_poll_results"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    polled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )

    # Interface identity
    if_index: Mapped[int] = mapped_column(Integer)
    if_name: Mapped[Optional[str]] = mapped_column(String(128))
    speed_mbps: Mapped[Optional[int]] = mapped_column(Integer)

    # 64-bit HC counters
    in_octets: Mapped[Optional[int]] = mapped_column(BigInteger)
    out_octets: Mapped[Optional[int]] = mapped_column(BigInteger)
    in_errors: Mapped[Optional[int]] = mapped_column(Integer)
    out_errors: Mapped[Optional[int]] = mapped_column(Integer)

    # Derived utilization (filled in by the next poll that calculates delta)
    in_utilization_pct: Mapped[Optional[float]] = mapped_column(Float)
    out_utilization_pct: Mapped[Optional[float]] = mapped_column(Float)
