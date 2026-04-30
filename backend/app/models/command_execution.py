from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class CommandExecution(Base):
    """
    Raw output archive for every SSH command execution.
    Retention policy (enforced by cleanup task):
      - parse_success=True  → keep last 5 per (device_id, command_type)
      - parse_success=False → keep up to 50 per (device_id, command_type) for debugging
    """
    __tablename__ = "command_executions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    device_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    template_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    os_type: Mapped[str] = mapped_column(String(64), nullable=False)
    firmware_version: Mapped[str | None] = mapped_column(String(128), nullable=True)
    command_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    command_string: Mapped[str] = mapped_column(String(512), nullable=False)

    # raw_output stored only when parse_success=False to keep storage manageable
    raw_output: Mapped[str | None] = mapped_column(Text, nullable=True)
    parsed_output: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON string

    parse_success: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    validation_success: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    execution_time_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )
