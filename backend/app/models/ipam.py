"""T9 Tur 7 — IPAM models (enterprise rebuild).

Three-tier hierarchy:
  IpamZone       → container (site, environment, RIR block, VPC)
  IpamSubnet     → CIDR ranges inside a zone (parent_subnet_id supports
                   nested supernet/subnet relationships, e.g.
                   10.0.0.0/8 → 10.10.0.0/16 → 10.10.5.0/24)
  IpamAssignment → per-IP allocation; source tag records ARP/LLDP origin
                   so the sync task can upsert without clobbering manual.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer,
    String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import CIDR, INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class IpamZone(Base):
    __tablename__ = "ipam_zones"
    __table_args__ = (
        UniqueConstraint("organization_id", "name", name="uq_ipam_zone_org_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    zone_type: Mapped[str] = mapped_column(String(32), nullable=False, default="site")
    parent_zone_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("ipam_zones.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    location_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL"), nullable=True,
    )
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class IpamSubnet(Base):
    __tablename__ = "ipam_subnets"
    __table_args__ = (
        UniqueConstraint("organization_id", "cidr", name="uq_ipam_subnet_org_cidr"),
        CheckConstraint("utilization_warn_pct BETWEEN 1 AND 100",
                        name="ck_ipam_subnet_util_pct"),
        CheckConstraint("vlan_id IS NULL OR vlan_id BETWEEN 1 AND 4094",
                        name="ck_ipam_subnet_vlan_range"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    zone_id: Mapped[int] = mapped_column(
        ForeignKey("ipam_zones.id", ondelete="RESTRICT"), nullable=False, index=True,
    )
    cidr: Mapped[str] = mapped_column(CIDR(), nullable=False)
    name: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    vlan_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    gateway: Mapped[Optional[str]] = mapped_column(INET(), nullable=True)
    dhcp_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    dhcp_server: Mapped[Optional[str]] = mapped_column(INET(), nullable=True)
    dhcp_range_start: Mapped[Optional[str]] = mapped_column(INET(), nullable=True)
    dhcp_range_end: Mapped[Optional[str]] = mapped_column(INET(), nullable=True)
    dns_servers: Mapped[Optional[list]] = mapped_column(JSONB(), nullable=True)
    parent_subnet_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("ipam_subnets.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    utilization_warn_pct: Mapped[int] = mapped_column(Integer, nullable=False, default=80)
    site_hint: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    location_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL"), nullable=True,
    )
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class IpamAssignment(Base):
    __tablename__ = "ipam_assignments"
    __table_args__ = (
        UniqueConstraint("subnet_id", "ip_address", name="uq_ipam_assign_subnet_ip"),
        CheckConstraint(
            "type IN ('static','dhcp','reserved','gateway','broadcast','network','dynamic')",
            name="ck_ipam_assign_type",
        ),
        CheckConstraint(
            "source IN ('manual','lldp','arp','dhcp-lease','discovery')",
            name="ck_ipam_assign_source",
        ),
        Index("ix_ipam_assign_mac", "mac_address"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    subnet_id: Mapped[int] = mapped_column(
        ForeignKey("ipam_subnets.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    ip_address: Mapped[str] = mapped_column(INET(), nullable=False, index=True)
    hostname: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    mac_address: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    type: Mapped[str] = mapped_column(String(16), nullable=False, default="static")
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="manual")
    device_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    interface: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    location_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL"), nullable=True,
    )
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


# Backwards-compat aliases for the limited external referrers; new code
# should use the explicit class names.
IpamAddress = IpamAssignment  # legacy alias — to be removed in a follow-up.
