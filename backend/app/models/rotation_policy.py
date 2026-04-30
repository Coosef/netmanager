from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RotationPolicy(Base):
    __tablename__ = "rotation_policies"

    id: Mapped[int] = mapped_column(primary_key=True)
    credential_profile_id: Mapped[int] = mapped_column(
        ForeignKey("credential_profiles.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
        index=True,
    )
    interval_days: Mapped[int] = mapped_column(Integer, default=90)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Runtime state
    status: Mapped[str] = mapped_column(String(16), default="idle")  # idle|running|success|failed
    last_rotated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    next_rotate_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_result: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
