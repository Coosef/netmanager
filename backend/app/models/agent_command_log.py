from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AgentCommandLog(Base):
    """Audit trail of every SSH command dispatched through an agent."""
    __tablename__ = "agent_command_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    device_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)
    device_ip: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # 'ssh_command' | 'ssh_config' | 'ssh_test'
    command_type: Mapped[str] = mapped_column(String(16), nullable=False)
    # The actual command text (or "config:<N> commands" summary for config pushes)
    command: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    success: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # True if the command was rejected by the security policy before being sent
    blocked: Mapped[bool] = mapped_column(Boolean, default=False)
    block_reason: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

    request_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    executed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )
