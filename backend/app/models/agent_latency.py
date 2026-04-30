from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Float, Integer, String, Boolean, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentDeviceLatency(Base):
    __tablename__ = "agent_device_latencies"
    __table_args__ = (
        UniqueConstraint("agent_id", "device_id", name="uq_agent_device"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    device_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    latency_ms: Mapped[Optional[float]] = mapped_column(Float)
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    measured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
