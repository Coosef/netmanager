from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class MacAddressEntry(Base):
    __tablename__ = "mac_address_entries"
    __table_args__ = (
        Index("ix_mac_entries_device_active", "device_id", "is_active"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), index=True
    )
    device_hostname: Mapped[str] = mapped_column(String(255))
    mac_address: Mapped[str] = mapped_column(String(32), index=True)
    vlan_id: Mapped[Optional[int]] = mapped_column(Integer)
    port: Mapped[Optional[str]] = mapped_column(String(128))
    entry_type: Mapped[str] = mapped_column(String(16), default="dynamic")
    oui_vendor: Mapped[Optional[str]] = mapped_column(String(128), index=True)
    device_type: Mapped[Optional[str]] = mapped_column(String(32), index=True)
    first_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class ArpEntry(Base):
    __tablename__ = "arp_entries"
    __table_args__ = (
        Index("ix_arp_entries_device_active", "device_id", "is_active"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), index=True
    )
    device_hostname: Mapped[str] = mapped_column(String(255))
    ip_address: Mapped[str] = mapped_column(String(45), index=True)
    mac_address: Mapped[str] = mapped_column(String(32), index=True)
    interface: Mapped[Optional[str]] = mapped_column(String(128))
    first_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    last_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
