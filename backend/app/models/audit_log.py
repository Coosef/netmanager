from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, String, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    action: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    resource_type: Mapped[Optional[str]] = mapped_column(String(64), index=True)
    resource_id: Mapped[Optional[str]] = mapped_column(String(64))
    resource_name: Mapped[Optional[str]] = mapped_column(String(255))
    details: Mapped[Optional[dict]] = mapped_column(JSON)
    client_ip: Mapped[Optional[str]] = mapped_column(String(45))
    user_agent: Mapped[Optional[str]] = mapped_column(String(512))
    status: Mapped[str] = mapped_column(String(16), default="success")  # success | failure
    # Forensics fields
    request_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True, index=True)
    duration_ms: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    before_state: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    after_state: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
