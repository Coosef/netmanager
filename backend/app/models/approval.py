from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class ApprovalRequest(Base):
    __tablename__ = "approval_requests"

    id: Mapped[int] = mapped_column(primary_key=True)

    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    device_hostname: Mapped[str] = mapped_column(String(255))  # denormalized

    command: Mapped[str] = mapped_column(Text, nullable=False)
    risk_level: Mapped[str] = mapped_column(String(16), default="medium")  # medium | high

    requester_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    requester_username: Mapped[str] = mapped_column(String(64))

    # pending | approved | rejected | executed | cancelled | expired
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)

    reviewer_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"), nullable=True)
    reviewer_username: Mapped[Optional[str]] = mapped_column(String(64))
    review_note: Mapped[Optional[str]] = mapped_column(Text)

    result_success: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    result_output: Mapped[Optional[str]] = mapped_column(Text)
    result_error: Mapped[Optional[str]] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc) + timedelta(hours=24),
    )
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    executed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
    )
