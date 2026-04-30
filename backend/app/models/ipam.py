from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class IpamSubnet(Base):
    __tablename__ = "ipam_subnets"

    id: Mapped[int] = mapped_column(primary_key=True)
    network: Mapped[str] = mapped_column(String(50), nullable=False, unique=True, index=True)  # e.g. 192.168.1.0/24
    name: Mapped[Optional[str]] = mapped_column(String(128))
    description: Mapped[Optional[str]] = mapped_column(Text)
    vlan_id: Mapped[Optional[int]] = mapped_column(Integer)
    site: Mapped[Optional[str]] = mapped_column(String(64))
    gateway: Mapped[Optional[str]] = mapped_column(String(45))
    dns_servers: Mapped[Optional[str]] = mapped_column(String(255))  # comma-separated
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class IpamAddress(Base):
    __tablename__ = "ipam_addresses"

    id: Mapped[int] = mapped_column(primary_key=True)
    subnet_id: Mapped[int] = mapped_column(
        ForeignKey("ipam_subnets.id", ondelete="CASCADE"), index=True
    )
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False, index=True)
    mac_address: Mapped[Optional[str]] = mapped_column(String(32))
    hostname: Mapped[Optional[str]] = mapped_column(String(255))
    description: Mapped[Optional[str]] = mapped_column(Text)
    # status: dynamic (seen in ARP), static (manual), reserved (manual hold), free (explicitly marked)
    status: Mapped[str] = mapped_column(String(16), default="dynamic", index=True)
    device_id: Mapped[Optional[int]] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"))
    last_seen: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
