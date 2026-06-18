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
        # T8.4 F2 — locations:view artık explicit izin; viewer da görür
        # (lokasyon switcher sidebar için gerekli) ama org_admin tam yönetir.
        "locations:view", "locations:edit", "locations:delete",
        # Agent management — five-verb catalogue. Org admin holds the
        # full set; location admin gets four (remove withheld by
        # default, see below); viewer gets read-only. The legacy
        # `agents:edit` grant is preserved as a back-compat verb in
        # `has_permission()` via the alias map below so any place that
        # still asks for "agents:edit" keeps working until the call
        # sites migrate.
        "agents:view", "agents:install", "agents:download_installer",
        "agents:update", "agents:remove",
    ],
    SystemRole.LOCATION_ADMIN: [
        "device:view", "device:create", "device:edit", "device:connect",
        "device:move",
        "config:view", "config:push", "config:backup", "config:restore",
        "task:view", "task:create",
        "audit:view", "monitor:view", "approval:view",
        "locations:view",  # kendi atanmış lokasyonlarını görür (scope RLS'de)
        # Location admins manage the agents in THEIR locations; the
        # default grant covers the four lifecycle verbs they need to
        # bring an agent on-line and keep it healthy. `agents:remove`
        # is withheld by default — an org_admin must grant it
        # explicitly via a permission_set override. Rationale: removal
        # is destructive (soft-delete + audit record) and the install
        # field tech who toggles installer downloads shouldn't be one
        # accidental click away from de-enrolling a production agent.
        "agents:view", "agents:install", "agents:download_installer",
        "agents:update",
    ],
    SystemRole.VIEWER: [
        # T8.4 F2 / CyberStrike pentest — viewer minimal grant'a indirildi.
        # Eski set'te `task:view` ve `audit:view` vardı; frontend permission_set
        # (_role_default_permissions / DEFAULT_PERMISSIONS) bu key'leri viewer'a
        # vermiyordu → mismatch, raporda "viewer /tasks ve /audit-log'a
        # erişebiliyor" High bulgusunun kökeni. Şimdi backend has_permission()
        # ile permission_set frontend görünümü hizalı.
        "device:view", "config:view", "monitor:view",
        "locations:view",  # sidebar location switcher için
        # Viewer sees agents but cannot enroll, download, change or
        # remove. The download verb is deliberately NOT granted to
        # viewer — a viewer who could pull the installer file (and
        # therefore the embedded agent_key) is functionally an
        # enroller, which contradicts the "read-only" contract.
        "agents:view",
    ],
    SystemRole.MEMBER: [
        # Deprecated alias of VIEWER. Permission grants kept in sync so
        # any row still carrying system_role='member' does not silently
        # gain or lose access at migration time.
        "device:view", "config:view", "monitor:view", "locations:view",
        "agents:view",
    ],
}


# ── Back-compat permission aliases ────────────────────────────────────────
# A user who has been granted the legacy `agents:edit` verb (either via
# SYSTEM_ROLE_PERMISSIONS or via an old PermissionSet row that still
# carries {"agents": {"edit": true}}) implicitly satisfies any check for
# `agents:update`. The aliases run in both directions inside
# `has_permission()` so call sites can adopt the new verbs at their own
# pace without breaking existing customers.
#
# The migration backfills `agents.edit=true` → `agents.update=true` on
# PermissionSet rows so the alias is a transitional safety net, not a
# permanent dependency. Removing the alias later requires zero call-site
# audits because every place that checks one verb already accepts the
# other.
AGENT_PERMISSION_ALIASES: dict[str, list[str]] = {
    "agents:update": ["agents:edit"],
    "agents:edit":   ["agents:update"],
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

    # ── Login IP allowlist (T9 Tur 2 #4) ─────────────────────────────────────
    # Comma-separated CIDR'lar. NULL veya boş string → kısıt yok (mevcut
    # davranış aynen). Tek IP de "/32" ile veya tek IP olarak verilebilir
    # (ipaddress.ip_network'a strict=False ile geçirilir).
    # Auth endpoint login + mfa/verify'da check eder; eşleşmezse 403.
    allowed_ips: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Password tracking (T9 Tur 2 #3 — password policy) ────────────────────
    password_changed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    # bcrypt hash listesi — son N şifre tekrar engellemek için. JSON dizisi.
    password_history: Mapped[Optional[Any]] = mapped_column(JSON, nullable=True)
    # Yeni hesap / reset sonrası login'de zorla şifre değiştir
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # ── Preferred UI language (location-agent-permissions work) ──────────────
    # Server-persisted user-preferred locale code. Allowed values match the
    # frontend i18n locale set (currently tr, en, de, ru). NULL means
    # "no explicit preference" and the runtime falls back through the
    # ordered chain documented in `users.preferences` endpoint:
    #   1. user.preferred_language
    #   2. organization.default_language (future, not in this column today)
    #   3. browser Accept-Language
    #   4. application default ('tr')
    # The column is intentionally a short VARCHAR(8) — long enough for
    # BCP-47 regional tags like 'pt-BR' if we ever support them, but
    # short enough that an attacker cannot stuff a payload into it.
    # The endpoint that updates this column rejects anything outside the
    # supported set; the column itself stays permissive so existing rows
    # are not invalidated if the supported set later contracts.
    preferred_language: Mapped[Optional[str]] = mapped_column(
        String(8), nullable=True
    )

    def has_permission(self, permission: str) -> bool:
        """Simple permission check driven by the user's system role.
        Returns True if the role's default grants include `permission`
        (or wildcard `*` for super-admin). For per-location / per-user
        overrides, callers should use `PermissionEngine.resolve` directly.

        Alias-aware: a role granted `agents:edit` (the legacy verb)
        also satisfies a check for `agents:update`, and vice versa.
        The alias map is `AGENT_PERMISSION_ALIASES` above; see its
        docstring for the migration rationale."""
        perms = SYSTEM_ROLE_PERMISSIONS.get(self.system_role, [])
        if "*" in perms:
            return True
        if permission in perms:
            return True
        for alias in AGENT_PERMISSION_ALIASES.get(permission, ()):
            if alias in perms:
                return True
        return False

    @property
    def role(self) -> str:
        """Back-compat shim — the legacy `role` column was dropped in
        the M6 final drop; readers like UserResponse.from_attributes still
        expect a `role` attribute. We surface the authoritative
        `system_role` here so the frontend / token responses keep working
        without coordination."""
        return self.system_role

    @role.setter
    def role(self, value: str) -> None:
        """Back-compat writer — accept the legacy `role` kwarg from older
        call sites (UserCreate.role, UserUpdate.role, invite acceptance)
        and forward it to system_role. Without this setter `User(role=…)`
        and `setattr(user, "role", …)` both raise AttributeError because
        Mapped attributes don't fall back to the @property shim above.
        Legacy values are normalised: 'admin' → 'org_admin',
        'org_viewer' → 'viewer', 'operator' → 'viewer',
        'location_*' → 'location_admin'. Anything that already matches a
        live SystemRole passes through unchanged."""
        if value is None:
            return
        v = str(value).strip().lower()
        legacy_map = {
            # Faz 7 / M4 consolidation: old free-form values → 4-role model.
            "admin":              "org_admin",
            "org_viewer":         "viewer",
            "operator":           "viewer",
            "location_manager":   "location_admin",
            "location_operator":  "location_admin",
            "location_viewer":    "viewer",
            "member":             "viewer",  # deprecated alias
        }
        self.system_role = legacy_map.get(v, v)

    @property
    def is_super_admin(self) -> bool:
        return self.system_role == SystemRole.SUPER_ADMIN

    @property
    def is_org_admin(self) -> bool:
        return self.system_role == SystemRole.ORG_ADMIN
