from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Index
from app.core.database import Base


class SyslogEvent(Base):
    __tablename__ = "syslog_events"

    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(String(32), nullable=False, index=True)
    source_ip = Column(String(45), nullable=False)
    facility = Column(Integer, nullable=False, default=0)
    severity = Column(Integer, nullable=False, default=7)
    message = Column(String(4096), nullable=False, default="")
    received_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )

    __table_args__ = (
        Index("ix_syslog_agent_received", "agent_id", "received_at"),
    )
