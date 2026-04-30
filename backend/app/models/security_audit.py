from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SecurityAudit(Base):
    __tablename__ = "security_audits"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL"), index=True
    )
    device_hostname: Mapped[Optional[str]] = mapped_column(String(255))
    score: Mapped[int] = mapped_column(Integer, default=0)   # 0-100
    grade: Mapped[str] = mapped_column(String(2), default="F")  # A/B/C/D/F
    findings: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    # pending | running | done | error
    status: Mapped[str] = mapped_column(String(16), default="pending")
    error: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )
