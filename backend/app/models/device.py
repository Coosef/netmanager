from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, JSON, String, Text  # noqa: F401
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class DeviceType(str, Enum):
    SWITCH = "switch"
    ROUTER = "router"
    FIREWALL = "firewall"
    AP = "ap"
    UPS = "ups"
    SERVER = "server"
    OTHER = "other"


class VendorType(str, Enum):
    CISCO = "cisco"
    ARUBA = "aruba"
    RUIJIE = "ruijie"
    FORTINET = "fortinet"
    PALOALTO = "paloalto"
    MIKROTIK = "mikrotik"
    JUNIPER = "juniper"
    UBIQUITI = "ubiquiti"
    H3C = "h3c"
    APC = "apc"
    OTHER = "other"


class OSType(str, Enum):
    # Cisco
    CISCO_IOS = "cisco_ios"
    CISCO_IOS_XE = "cisco_ios"  # netmiko uses same driver
    CISCO_NXOS = "cisco_nxos"
    CISCO_SG300 = "cisco_sg300"
    # Aruba / HP
    ARUBA_OSSWITCH = "aruba_osswitch"
    ARUBA_AOSCX = "aruba_aoscx"
    HP_PROCURVE = "hp_procurve"
    # Ruijie
    RUIJIE_OS = "ruijie_os"
    # Fortinet
    FORTIOS = "fortios"
    # Palo Alto
    PANOS = "panos"
    # MikroTik
    MIKROTIK_ROUTEROS = "mikrotik_routeros"
    # Juniper
    JUNOS = "junos"
    # H3C / HPE Comware
    H3C_COMWARE = "h3c_comware"
    # Generic (SNMP-only / no SSH CLI)
    GENERIC_SNMP = "generic_snmp"
    # Generic
    GENERIC = "generic"


class DeviceStatus(str, Enum):
    ONLINE = "online"
    OFFLINE = "offline"
    UNKNOWN = "unknown"
    UNREACHABLE = "unreachable"


class DeviceGroup(Base):
    __tablename__ = "device_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("device_groups.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    devices: Mapped[list["Device"]] = relationship("Device", back_populates="group")
    children: Mapped[list["DeviceGroup"]] = relationship("DeviceGroup")


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(primary_key=True)
    hostname: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False, unique=True, index=True)
    device_type: Mapped[str] = mapped_column(String(32), default=DeviceType.SWITCH)
    vendor: Mapped[str] = mapped_column(String(32), default=VendorType.OTHER)
    os_type: Mapped[str] = mapped_column(String(64), default=OSType.CISCO_IOS)
    model: Mapped[Optional[str]] = mapped_column(String(128))
    serial_number: Mapped[Optional[str]] = mapped_column(String(128))
    firmware_version: Mapped[Optional[str]] = mapped_column(String(128))
    location: Mapped[Optional[str]] = mapped_column(String(255))
    description: Mapped[Optional[str]] = mapped_column(Text)
    tags: Mapped[Optional[str]] = mapped_column(String(512))  # comma-separated
    alias: Mapped[Optional[str]] = mapped_column(String(255))
    layer: Mapped[Optional[str]] = mapped_column(String(32))  # core|distribution|access|edge|wireless
    site: Mapped[Optional[str]] = mapped_column(String(64))
    building: Mapped[Optional[str]] = mapped_column(String(64))
    floor: Mapped[Optional[str]] = mapped_column(String(32))

    # SSH Credentials (encrypted)
    ssh_username: Mapped[str] = mapped_column(String(128), nullable=False)
    ssh_password_enc: Mapped[str] = mapped_column(Text, nullable=False)
    ssh_port: Mapped[int] = mapped_column(Integer, default=22)
    enable_secret_enc: Mapped[Optional[str]] = mapped_column(Text)

    # SNMP v1/v2c
    snmp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    snmp_community: Mapped[Optional[str]] = mapped_column(String(512))
    snmp_version: Mapped[str] = mapped_column(String(8), default="v2c")
    snmp_port: Mapped[int] = mapped_column(Integer, default=161)

    # SNMP v3 (USM)
    snmp_v3_username: Mapped[Optional[str]] = mapped_column(String(128))
    snmp_v3_auth_protocol: Mapped[Optional[str]] = mapped_column(String(8))   # md5 | sha1
    snmp_v3_auth_passphrase: Mapped[Optional[str]] = mapped_column(Text)
    snmp_v3_priv_protocol: Mapped[Optional[str]] = mapped_column(String(8))   # des | aes128
    snmp_v3_priv_passphrase: Mapped[Optional[str]] = mapped_column(Text)

    # Status
    status: Mapped[str] = mapped_column(String(32), default=DeviceStatus.UNKNOWN)
    last_seen: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_backup: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_readonly: Mapped[bool] = mapped_column(Boolean, default=True)  # blocks non-show CLI commands
    approval_required: Mapped[bool] = mapped_column(Boolean, default=False)  # config changes need admin approval

    # Availability scoring — computed daily by availability_tasks.compute_availability_scores
    availability_24h:  Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=None)
    availability_7d:   Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=None)
    mtbf_hours:        Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=None)
    experience_score:  Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=None)

    agent_id: Mapped[Optional[str]] = mapped_column(String(32), index=True)
    # Ordered list of fallback agent IDs — tried in sequence if primary is offline
    fallback_agent_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # If set, SSH/SNMP credentials are taken from this profile instead of device fields
    credential_profile_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("credential_profiles.id", ondelete="SET NULL"), nullable=True, index=True
    )

    group_id: Mapped[Optional[int]] = mapped_column(ForeignKey("device_groups.id"))
    group: Mapped[Optional[DeviceGroup]] = relationship("DeviceGroup", back_populates="devices")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Rack placement
    rack_name: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    rack_unit: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    rack_height: Mapped[int] = mapped_column(Integer, default=1)

    config_backups: Mapped[list["ConfigBackup"]] = relationship(
        "ConfigBackup", back_populates="device", order_by="ConfigBackup.created_at.desc()"
    )
