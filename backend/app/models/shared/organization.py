from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import SharedBase


class OrgStatus(str, Enum):
    """Faz 8 Phase H — organization lifecycle.

      * active    — normal operation
      * suspended — read-only: existing data stays visible, write /
                    operational actions are refused (e.g. unpaid licence)
      * archived  — fully retired: no access for normal users
    """
    ACTIVE = "active"
    SUSPENDED = "suspended"
    ARCHIVED = "archived"


# Default per-organization quota — used when no plan-derived value exists.
DEFAULT_ORG_QUOTA = {
    "max_locations": 5,
    "max_devices": 200,
    "max_agents": 10,
    "max_users": 20,
    "max_retention_days": 90,
}


class Organization(SharedBase):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    contact_email: Mapped[Optional[str]] = mapped_column(String(255))

    plan_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("plans.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # PostgreSQL schema name: org_{id} — set after INSERT when id is known
    schema_name: Mapped[Optional[str]] = mapped_column(String(64), unique=True)
    # Auto-generated per-schema PG role (for future row-level security extension)
    pg_role_name: Mapped[Optional[str]] = mapped_column(String(64), unique=True)
    pg_pass_enc: Mapped[Optional[str]] = mapped_column(String(512))

    # Subscription tracking
    trial_ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    subscription_ends_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    # ── Faz 8 Phase H — organization management ──────────────────────────────
    # Lifecycle status — the authoritative operational gate (is_active /
    # deleted_at are kept for backward compatibility).
    status: Mapped[str] = mapped_column(
        String(16), default=OrgStatus.ACTIVE.value, nullable=False, index=True
    )
    # Licence window (informational + a basis for expiry handling).
    license_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    license_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    # Per-organization quota — the ENFORCED limits. Seeded from the plan at
    # creation, editable per-org by a super-admin. New-resource creation is
    # refused once a limit is reached (app/services/org_management.py).
    max_locations: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    max_devices: Mapped[int] = mapped_column(Integer, default=200, nullable=False)
    max_agents: Mapped[int] = mapped_column(Integer, default=10, nullable=False)
    max_users: Mapped[int] = mapped_column(Integer, default=20, nullable=False)
    max_retention_days: Mapped[int] = mapped_column(Integer, default=90, nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Faz 7 — multi-tenant isolation
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
