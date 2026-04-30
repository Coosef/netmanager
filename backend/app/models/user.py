from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class UserRole(str, Enum):
    SUPER_ADMIN = "super_admin"
    ADMIN = "admin"
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
    UserRole.OPERATOR: [
        "device:view", "device:connect",
        "config:view", "config:push", "config:backup",
        "task:view", "task:create",
        "audit:view",
        "monitor:view",
        "approval:view",
    ],
    UserRole.VIEWER: [
        "device:view",
        "config:view",
        "task:view",
        "audit:view",
        "monitor:view",
    ],
}


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[Optional[str]] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(32), default=UserRole.VIEWER, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
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

    def has_permission(self, permission: str) -> bool:
        perms = ROLE_PERMISSIONS.get(self.role, [])
        return "*" in perms or permission in perms
