from datetime import datetime
from typing import Optional
from pydantic import BaseModel, EmailStr, field_validator


# Supported UI locales — the frontend i18n runtime carries these four
# language packs. The supported set is the single source of truth for
# both the user-preference PATCH endpoint and the auth /me response so
# any change has exactly one place to update.
SUPPORTED_LANGUAGES: frozenset[str] = frozenset({"tr", "en", "de", "ru"})


class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str
    full_name: Optional[str] = None
    role: str = "viewer"
    notes: Optional[str] = None
    # M6 — `organization_id` is authoritative; the legacy `tenant_id`
    # field is gone with the column.
    organization_id: Optional[int] = None


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    full_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    notes: Optional[str] = None
    organization_id: Optional[int] = None
    # T9 Tur 2 #4 — IP allowlist. Comma-separated CIDR (boş/None → kısıt yok)
    allowed_ips: Optional[str] = None


class UserPasswordChange(BaseModel):
    current_password: str
    new_password: str


class AdminPasswordReset(BaseModel):
    new_password: str


class UserLocationItem(BaseModel):
    location_id: int
    location_name: str
    loc_role: str

    model_config = {"from_attributes": True}


class UserResponse(BaseModel):
    id: int
    username: str
    email: str
    full_name: Optional[str]
    role: str
    is_active: bool
    notes: Optional[str]
    # M6 — `organization_id` is authoritative; `tenant_id` / `tenant_name`
    # are gone with the legacy column.
    organization_id: Optional[int] = None
    organization_name: Optional[str] = None
    last_login: Optional[datetime]
    created_at: datetime
    locations: list[UserLocationItem] = []
    # MFA status — read-only here; managed via /users/me/mfa/*. The Users
    # admin page needs `mfa_enabled` for the "MFA AÇIK" KPI; the rest of
    # the MFA state (totp_secret, recovery codes) stays per-user-only.
    mfa_enabled: bool = False
    # T9 Tur 2 #4 — IP allowlist (NULL/"" → kısıt yok)
    allowed_ips: Optional[str] = None
    # User-preferred UI language. NULL → no explicit preference; the
    # runtime falls back to org default → browser Accept-Language →
    # app default 'tr'. Updates go through PATCH /users/me/preferences
    # so a fresh login on any device picks up the value the user chose
    # last instead of leaning on localStorage.
    preferred_language: Optional[str] = None

    model_config = {"from_attributes": True}


# ── User preferences (PATCH /users/me/preferences) ────────────────────────


class UserPreferencesUpdate(BaseModel):
    """Mass-assignment-safe preferences payload. The endpoint only ever
    sets `preferred_language`; every other field on UserUpdate
    (role/tenant/IP-allowlist/etc.) is rejected by Pydantic's
    `extra='forbid'` so a malicious client cannot smuggle a privilege
    change through `/users/me/preferences`."""

    # Use Optional[str] (not Optional[Literal[...]]) so we can return a
    # 422 with a human-readable message via the validator below; a raw
    # Literal mismatch yields an opaque "input_value_error" that doesn't
    # name the allowed set.
    preferred_language: Optional[str] = None

    model_config = {"extra": "forbid"}

    @field_validator("preferred_language")
    @classmethod
    def _normalise_language(cls, value: Optional[str]) -> Optional[str]:
        # NULL clears the preference and re-engages the fallback chain.
        if value is None:
            return None
        # Reject empty / whitespace explicitly — Pydantic happily passes
        # "" through, but storing an empty string in the column would
        # break the NULL-means-no-preference contract.
        normalised = value.strip().lower()
        if not normalised:
            raise ValueError(
                "preferred_language must be a non-empty locale code "
                "or null; empty string is not allowed"
            )
        if normalised not in SUPPORTED_LANGUAGES:
            raise ValueError(
                "preferred_language must be one of: "
                + ", ".join(sorted(SUPPORTED_LANGUAGES))
            )
        return normalised


class UserPreferencesResponse(BaseModel):
    """The response intentionally exposes ONLY preference fields, not
    any other user attribute. A future addition (timezone, date-format,
    etc.) lands here without leaking unrelated user state."""

    preferred_language: Optional[str] = None

    model_config = {"from_attributes": True}
