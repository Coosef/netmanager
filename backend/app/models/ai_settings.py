from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AISettings(Base):
    __tablename__ = "ai_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    active_provider: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    claude_api_key_enc: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    claude_model: Mapped[str] = mapped_column(String(64), default="claude-sonnet-4-6")

    openai_api_key_enc: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    openai_model: Mapped[str] = mapped_column(String(64), default="gpt-4o")

    gemini_api_key_enc: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    gemini_model: Mapped[str] = mapped_column(String(64), default="gemini-3-flash-preview")

    ollama_base_url: Mapped[Optional[str]] = mapped_column(String(256), nullable=True, default="http://localhost:11434")
    ollama_model: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, default="llama3.2")

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
