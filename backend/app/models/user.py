from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SystemRole(str, Enum):
    """The consolidated 4-role system model (Faz 7 M4). Row visibility is
    enforced by Postgres RLS; this is the coarse system role. Action-
    level rights are governed by PermissionSet / PermissionEngine
    (services.rbac.engine) — `has_permission` below is the simple
    callsite-friendly entry point that wraps the role-default grants."""
    SUPER_ADMIN = "super_admin"        # Platform-wide; bypasses RLS
    ORG_ADMIN = "org_admin"            # Full access within their organization
    LOCATION_ADMIN = "location_admin"  # Manage their assigned location(s)
    VIEWER = "viewer"                  # Read-only, org/location scoped

    # Deprecated alias — pre-Faz-7 value; M4 remaps existing rows to VIEWER.
    MEMBER = "member"


# M6 final drop — system-role-keyed permission grants. The legacy
# UserRole enum + ROLE_PERMISSIONS map are gone; `has_permission` now
# reads `self.system_role`. This is the simple "does role X get verb Y"
# default-grant table; per-user / per-location overrides are still
# managed via `PermissionSet` rows (PermissionEngine).
SYSTEM_ROLE_PERMISSIONS: dict[str, list[str]] = {
    SystemRole.SUPER_ADMIN: ["*"],
    SystemRole.ORG_ADMIN: [
        "device:view", "device:create", "device:edit", "device:delete",
        "device:connect", "device:move",
        "config:view", "config:push", "config:backup", "config:restore",
        "task:view", "task:create", "task:cancel",
        "user:view",
        "audit:view",
        "bulk:password_change", "bulk:config_push", "bulk:command",
        "monitor:view",
        "approval:view", "approval:review",
    ],
    SystemRole.LOCATION_ADMIN: [
        "device:view", "device:create", "device:edit", "device:connect",
        "device:move",
        "config:view", "config:push", "config:backup", "config:restore",
        "task:view", "task:create",
        "audit:view", "monitor:view", "approval:view",
    ],
    SystemRole.VIEWER: [
        "device:view", "config:view", "task:view", "audit:view", "monitor:view",
    ],
    SystemRole.MEMBER: [
        "device:view", "config:view", "task:view", "monitor:view",
    ],
}


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[Optional[str]] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notes: Mapped[Optional[str]] = mapped_column(Text)

    # M6 final drop — the legacy `role` column + `tenant_id` FK are gone.
    # `system_role` is the authoritative role; `organization_id` is the
    # authoritative tenant key.
    system_role: Mapped[str] = mapped_column(
        String(32), default=SystemRole.VIEWER, nullable=False
    )
    organization_id: Mapped[Optional[int]] = mapped_column(
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

    # ── Multi-factor auth (Faz NM-MFA) ───────────────────────────────────────
    # TOTP only for the first cut (RFC 6238) — covers Google Authenticator,
    # Microsoft Authenticator, Authy and 1Password. Email + SMS land later as
    # additional methods stored in mfa_methods.
    #
    # Secret is stored Fernet-encrypted (see core.security encrypt/decrypt);
    # the pending_secret column carries the not-yet-confirmed enrollment
    # secret so a half-finished setup doesn't lock the user out. Recovery
    # codes are bcrypt-hashed and single-use; consuming one removes it from
    # the list so the count visibly drops in the UI.
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    mfa_totp_secret: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    mfa_pending_secret: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # CSV: 'totp' | 'totp,email' — primary first. Frontend picks default.
    mfa_methods: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # List[str] of bcrypt hashes; popped on use.
    mfa_recovery_codes: Mapped[Optional[Any]] = mapped_column(JSON, nullable=True)
    mfa_enrolled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    def has_permission(self, permission: str) -> bool:
        """Simple permission check driven by the user's system role.
        Returns True if the role's default grants include `permission`
        (or wildcard `*` for super-admin). For per-location / per-user
        overrides, callers should use `PermissionEngine.resolve` directly."""
        perms = SYSTEM_ROLE_PERMISSIONS.get(self.system_role, [])
        return "*" in perms or permission in perms

    @property
    def role(self) -> str:
        """Back-compat shim — the legacy `role` column was dropped in
        the M6 final drop; readers like UserResponse.from_attributes still
        expect a `role` attribute. We surface the authoritative
        `system_role` here so the frontend / token responses keep working
        without coordination."""
        return self.system_role

    @property
    def is_super_admin(self) -> bool:
        return self.system_role == SystemRole.SUPER_ADMIN

    @property
    def is_org_admin(self) -> bool:
        return self.system_role == SystemRole.ORG_ADMIN
