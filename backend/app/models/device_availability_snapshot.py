from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DeviceAvailabilitySnapshot(Base):
    __tablename__ = "device_availability_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    availability_24h: Mapped[float] = mapped_column(Float, nullable=False)
    availability_7d: Mapped[float] = mapped_column(Float, nullable=False)
    mtbf_hours: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    experience_score: Mapped[float] = mapped_column(Float, nullable=False)

    # Faz 7 — multi-tenant isolation (HYPERTABLE — plain Integer, no FK)
    organization_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    location_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
