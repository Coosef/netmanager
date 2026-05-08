from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


# ---------------------------------------------------------------------------
# Legacy role system (kept for backward compat during RBAC migration)
# ---------------------------------------------------------------------------

class UserRole(str, Enum):
    SUPER_ADMIN = "super_admin"
    ADMIN = "admin"
    ORG_VIEWER = "org_viewer"
    LOCATION_MANAGER = "location_manager"
    LOCATION_OPERATOR = "location_operator"
    LOCATION_VIEWER = "location_viewer"
    OPERATOR = "operator"
    VIEWER = "viewer"


ROLE_PERMISSIONS: dict[str, list[str]] = {
    UserRole.SUPER_ADMIN: ["*"],
    UserRole.ADMIN: [
        "device:view", "device:create", "device:edit", "device:delete",
        "device:connect",
        "config:view", "config:push", "config:backup", "config:restore",
        "task:view", "task:create", "task:cancel",
        "user:view",
        "audit:view",
        "bulk:password_change", "bulk:config_push", "bulk:command",
        "monitor:view",
        "approval:view", "approval:review",
    ],
    UserRole.ORG_VIEWER: [
        "device:view", "config:view", "task:view", "audit:view", "monitor:view",
    ],
    UserRole.LOCATION_MANAGER: [
        "device:view", "device:create", "device:edit",
        "config:view", "config:push", "config:backup", "config:restore",
        "task:view", "task:create", "audit:view", "monitor:view", "approval:view",
    ],
    UserRole.LOCATION_OPERATOR: [
        "device:view", "device:connect",
        "config:view", "config:push", "config:backup",
        "task:view", "task:create", "monitor:view",
    ],
    UserRole.LOCATION_VIEWER: [
        "device:view", "config:view", "task:view", "monitor:view",
    ],
    UserRole.OPERATOR: [
        "device:view", "device:connect",
        "config:view", "config:push", "config:backup",
        "task:view", "task:create", "audit:view", "monitor:view", "approval:view",
    ],
    UserRole.VIEWER: [
        "device:view", "config:view", "task:view", "audit:view", "monitor:view",
    ],
}


# ---------------------------------------------------------------------------
# New RBAC system roles
# ---------------------------------------------------------------------------

class SystemRole(str, Enum):
    SUPER_ADMIN = "super_admin"  # Platform-wide; unrestricted
    ORG_ADMIN = "org_admin"      # Full access within their org; manages users/perms
    MEMBER = "member"            # Access governed by PermissionSet assignments


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[Optional[str]] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text)

    # --- Legacy role fields (kept during RBAC migration) ---
    role: Mapped[str] = mapped_column(String(32), default=UserRole.VIEWER, nullable=False)
    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # --- New RBAC fields ---
    system_role: Mapped[str] = mapped_column(
        String(32), default=SystemRole.MEMBER, nullable=False
    )
    org_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True, index=True
    )

    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # --- Legacy helpers (kept for backward compat) ---
    def has_permission(self, permission: str) -> bool:
        perms = ROLE_PERMISSIONS.get(self.role, [])
        return "*" in perms or permission in perms

    @property
    def is_tenant_wide(self) -> bool:
        return self.role in (UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.ORG_VIEWER)

    @property
    def is_location_scoped(self) -> bool:
        return self.role in (
            UserRole.LOCATION_MANAGER, UserRole.LOCATION_OPERATOR, UserRole.LOCATION_VIEWER,
            UserRole.OPERATOR, UserRole.VIEWER,
        )

    # --- New RBAC helpers ---
    @property
    def is_super_admin(self) -> bool:
        return self.system_role == SystemRole.SUPER_ADMIN

    @property
    def is_org_admin(self) -> bool:
        return self.system_role == SystemRole.ORG_ADMIN
