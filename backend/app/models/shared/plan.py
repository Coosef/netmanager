from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import SharedBase


class Plan(SharedBase):
    __tablename__ = "plans"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    slug: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Hard limits enforced at API level
    max_devices: Mapped[int] = mapped_column(Integer, default=50, nullable=False)
    max_users: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    max_locations: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    max_agents: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    # Feature flags — arbitrary JSON for extensibility
    # e.g. {"ai_probe": true, "topology": false, "sla": true, "api_tokens": true}
    features: Mapped[Optional[dict]] = mapped_column(JSON, default=dict)

    price_monthly: Mapped[Optional[int]] = mapped_column(Integer)  # cents
    price_yearly: Mapped[Optional[int]] = mapped_column(Integer)   # cents

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
