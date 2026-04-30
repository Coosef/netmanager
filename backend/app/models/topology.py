from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class TopologyLink(Base):
    __tablename__ = "topology_links"

    id: Mapped[int] = mapped_column(primary_key=True)

    # Source side (always a known device)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    local_port: Mapped[str] = mapped_column(String(128))

    # Neighbor side (may or may not be in our inventory)
    neighbor_hostname: Mapped[str] = mapped_column(String(255), index=True)
    neighbor_ip: Mapped[Optional[str]] = mapped_column(String(45))
    neighbor_port: Mapped[str] = mapped_column(String(128))
    neighbor_platform: Mapped[Optional[str]] = mapped_column(String(255))

    # Matched to inventory device (NULL if unknown)
    neighbor_device_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL"), index=True, nullable=True
    )

    protocol: Mapped[str] = mapped_column(String(16))  # lldp | cdp
    neighbor_type: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)  # switch|ap|phone|printer|camera|router|other

    # Extended port attributes collected during topology discovery
    local_duplex: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)   # full | half | auto
    local_port_mode: Mapped[Optional[str]] = mapped_column(String(16), nullable=True) # access | trunk | routed
    local_vlan: Mapped[Optional[int]] = mapped_column(nullable=True)                  # access vlan or native vlan (trunk)
    local_poe_enabled: Mapped[Optional[bool]] = mapped_column(nullable=True)
    local_poe_mw: Mapped[Optional[int]] = mapped_column(nullable=True)               # PoE power in milliwatts

    last_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )

    __table_args__ = (
        UniqueConstraint("device_id", "local_port", "neighbor_hostname", name="uq_topology_link"),
    )
