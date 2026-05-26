"""T9 Tur 6B — PoE per-port snapshot.

One row per device + port. Periodic beat task upserts the row; reads
power the org/loc PoE dashboard.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PoEPortSnapshot(Base):
    __tablename__ = "poe_port_snapshots"
    __table_args__ = (
        UniqueConstraint("device_id", "port", name="uq_poe_port_snapshot_devport"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    port: Mapped[str] = mapped_column(String(64), nullable=False)
    oper_status: Mapped[str] = mapped_column(String(16), nullable=False, default="off")
    admin_status: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    power_mw: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_mw: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    device_class: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="cli")

    # Faz 7 multi-tenant isolation
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    location_id: Mapped[int] = mapped_column(
        ForeignKey("locations.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
