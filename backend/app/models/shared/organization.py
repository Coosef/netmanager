from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import SharedBase


class Organization(SharedBase):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    contact_email: Mapped[Optional[str]] = mapped_column(String(255))

    plan_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("plans.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # PostgreSQL schema name: org_{id} — set after INSERT when id is known
    schema_name: Mapped[Optional[str]] = mapped_column(String(64), unique=True)
    # Auto-generated per-schema PG role (for future row-level security extension)
    pg_role_name: Mapped[Optional[str]] = mapped_column(String(64), unique=True)
    pg_pass_enc: Mapped[Optional[str]] = mapped_column(String(512))

    # Subscription tracking
    trial_ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    subscription_ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
