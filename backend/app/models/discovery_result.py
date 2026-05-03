from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, JSON
from app.core.database import Base


class DiscoveryResult(Base):
    __tablename__ = "discovery_results"

    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(String(32), nullable=False, index=True)
    subnet = Column(String(64), nullable=False)
    triggered_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    completed_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(16), nullable=False, default="running")  # running|completed|failed
    total_discovered = Column(Integer, nullable=False, default=0)
    scanned_count = Column(Integer, nullable=False, default=0)
    results = Column(JSON, nullable=False, default=list)
