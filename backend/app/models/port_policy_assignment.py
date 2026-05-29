"""T10 C7.A — Port Policy Assignment modeli (per-port override).

`port_policy_assignments` tablosu (migration f9ae). Bir cihazın belirli portu için
`port_security_policies` referansı tutar. UNIQUE(device_id, port_name) → bir port
bir override.

Resolver zinciri (security_policy_service.resolve_port_policy):
  1) PortPolicyAssignment (device_id+port_name)   ← bu model
  2) Device.port_security_policy_id               (cihaz default — C6b)
  3) Org is_default=true PortSecurityPolicy        (org default — C2)
  4) hardcoded fallback                            (C2)

port_name v1: exact-match + raw vendor string. Normalization v2 (T10_C7_PLAN.md risk).
Multi-tenant: organization_id NOT NULL, Faz 7 RLS FORCE (migration f9ae).
"""
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PortPolicyAssignment(Base):
    __tablename__ = "port_policy_assignments"
    __table_args__ = (
        UniqueConstraint("device_id", "port_name", name="uq_ppa_device_port"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    port_name: Mapped[str] = mapped_column(Text, nullable=False)
    port_security_policy_id: Mapped[int] = mapped_column(
        ForeignKey("port_security_policies.id", ondelete="RESTRICT"),
        nullable=False, index=True
    )
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True
    )
    assigned_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    deleted_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
