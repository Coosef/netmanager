from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Rack(Base):
    __tablename__ = "racks"

    id: Mapped[int] = mapped_column(primary_key=True)
    rack_name: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    total_u: Mapped[int] = mapped_column(Integer, nullable=False, default=42)
    description: Mapped[Optional[str]] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    # Faz 7 — multi-tenant isolation
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )


class RackItem(Base):
    __tablename__ = "rack_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    rack_name: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    item_type: Mapped[str] = mapped_column(String(32), nullable=False, default="other")
    unit_start: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_height: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Faz 7 — multi-tenant isolation
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
