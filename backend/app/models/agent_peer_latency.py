from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, String, Boolean
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentPeerLatency(Base):
    __tablename__ = "agent_peer_latencies"
    __table_args__ = (
        Index("ix_apl_agent_to_ts", "agent_to", "measured_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # "backend" for v1 (direct probe from backend server); future: source agent_id
    agent_from: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    agent_to: Mapped[str] = mapped_column(
        String(32), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    target_ip: Mapped[str] = mapped_column(String(64), nullable=False)
    latency_ms: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    reachable: Mapped[bool] = mapped_column(Boolean, nullable=False)
    measured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )
