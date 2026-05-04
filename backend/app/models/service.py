from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Service(Base):
    __tablename__ = "services"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # critical | high | medium | low
    priority: Mapped[str] = mapped_column(String(16), default="medium")
    # business context
    business_owner: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

    # Which devices are critical for this service (device IDs)
    device_ids: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True, default=list)
    # Which VLANs are used by this service
    vlan_ids: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True, default=list)

    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
