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
    # M6-B1 — `organization_id` is the authoritative field; `tenant_id`
    # is a deprecated alias kept so older clients (and Faz 7 lockfiles)
    # do not 422. Server-side `tenant_id` is ignored at create time.
    organization_id: Optional[int] = None
    tenant_id: Optional[int] = None


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    full_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    notes: Optional[str] = None
    # M6-B1 — see UserCreate; `tenant_id` accepted-and-ignored for back-compat.
    organization_id: Optional[int] = None
    tenant_id: Optional[int] = None


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
    # M6-B1 — organisation is now authoritative. `tenant_id`/`tenant_name`
    # stay as deprecated aliases (populated server-side from the user's
    # organization so the existing frontend keeps rendering); both are
    # removed in the M6 final drop.
    organization_id: Optional[int] = None
    organization_name: Optional[str] = None
    tenant_id: Optional[int] = None
    tenant_name: Optional[str] = None
    last_login: Optional[datetime]
    created_at: datetime
    locations: list[UserLocationItem] = []

    model_config = {"from_attributes": True}
