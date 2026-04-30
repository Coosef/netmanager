from datetime import datetime, date, timezone
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class AssetLifecycle(Base):
    __tablename__ = "asset_lifecycle"
    __table_args__ = (UniqueConstraint("device_id", name="uq_asset_lifecycle_device"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True)
    device_hostname: Mapped[Optional[str]] = mapped_column(String(255))

    # Lifecycle dates
    purchase_date: Mapped[Optional[date]] = mapped_column(Date)
    warranty_expiry: Mapped[Optional[date]] = mapped_column(Date)
    eol_date: Mapped[Optional[date]] = mapped_column(Date, comment="End of Life date announced by vendor")
    eos_date: Mapped[Optional[date]] = mapped_column(Date, comment="End of Support date")

    # Commercial info
    purchase_cost: Mapped[Optional[float]] = mapped_column(Float)
    currency: Mapped[str] = mapped_column(String(8), default="TRY")
    po_number: Mapped[Optional[str]] = mapped_column(String(128))
    vendor_contract: Mapped[Optional[str]] = mapped_column(String(255))
    support_tier: Mapped[Optional[str]] = mapped_column(String(64))  # Gold / Silver / Standard / None

    # Notes
    maintenance_notes: Mapped[Optional[str]] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    device: Mapped["Device"] = relationship("Device")  # noqa: F821
