from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    agent_key_hash: Mapped[str] = mapped_column(Text, nullable=False)

    tenant_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True)

    status: Mapped[str] = mapped_column(String(16), default="offline")
    last_heartbeat: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_ip: Mapped[Optional[str]] = mapped_column(String(64))
    local_ip: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    platform: Mapped[Optional[str]] = mapped_column(String(32))
    machine_hostname: Mapped[Optional[str]] = mapped_column(String(255))
    version: Mapped[Optional[str]] = mapped_column(String(32))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_by: Mapped[Optional[int]] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    # ── Security fields ───────────────────────────────────────────────────────
    # 'all' | 'whitelist' | 'blacklist'
    command_mode: Mapped[str] = mapped_column(String(16), default="all")
    # JSON array of allowed/blocked command prefixes, e.g. '["show","ping","traceroute"]'
    allowed_commands: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Comma-separated trusted source IPs/CIDRs (backend IPs allowed to send commands)
    allowed_ips: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Brute-force protection: consecutive failed auth attempts
    failed_auth_count: Mapped[int] = mapped_column(Integer, default=0)
    # When key was last rotated
    key_last_rotated: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    # ── Connection stats ──────────────────────────────────────────────────────
    last_connected_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_disconnected_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    total_connections: Mapped[int] = mapped_column(Integer, default=0)
