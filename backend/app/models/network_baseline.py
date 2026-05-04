from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class NetworkBaseline(Base):
    """Rolling 7-day baseline per device per metric — used by behavior analytics."""
    __tablename__ = "network_baselines"
    __table_args__ = (UniqueConstraint("device_id", "metric_type", name="uq_baseline_device_metric"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), index=True
    )
    # mac_count | traffic_in_pct | traffic_out_pct | vlan_count
    metric_type: Mapped[str] = mapped_column(String(32), index=True)
    baseline_value: Mapped[float] = mapped_column(Float, default=0.0)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    known_vlans: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    last_updated: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
