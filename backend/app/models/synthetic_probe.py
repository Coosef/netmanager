from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SyntheticProbe(Base):
    __tablename__ = "synthetic_probes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    device_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True
    )
    agent_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)

    probe_type: Mapped[str] = mapped_column(String(16), nullable=False)   # icmp|tcp|http|dns
    target: Mapped[str] = mapped_column(String(255), nullable=False)       # IP, hostname, URL

    # TCP
    port: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # HTTP
    http_method: Mapped[str] = mapped_column(String(8), default="GET")
    expected_status: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # DNS
    dns_record_type: Mapped[str] = mapped_column(String(8), default="A")

    interval_secs: Mapped[int] = mapped_column(Integer, default=300)   # how often to probe
    timeout_secs: Mapped[int] = mapped_column(Integer, default=5)

    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class SyntheticProbeResult(Base):
    __tablename__ = "synthetic_probe_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    probe_id: Mapped[int] = mapped_column(
        ForeignKey("synthetic_probes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    latency_ms: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    detail: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    measured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
