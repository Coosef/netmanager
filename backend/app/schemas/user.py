from datetime import datetime
from typing import Optional
from pydantic import BaseModel, EmailStr


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

    model_config = {"from_attributes": True}
