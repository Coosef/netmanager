from typing import Optional
from pydantic import BaseModel, EmailStr


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: int
    username: str
    role: str           # legacy
    system_role: str    # new RBAC
    tenant_id: Optional[int] = None   # legacy
    org_id: Optional[int] = None      # new RBAC
    permissions: Optional[dict] = None  # full permissions dict for frontend


class InviteRequest(BaseModel):
    email: EmailStr
    full_name: Optional[str] = None
    system_role: str = "member"
    permission_set_id: Optional[int] = None


class InviteAcceptRequest(BaseModel):
    token: str
    username: str
    password: str
    full_name: Optional[str] = None


class RegisterOrgRequest(BaseModel):
    """Self-service org registration (if enabled)."""
    org_name: str
    org_slug: str
    admin_username: str
    admin_email: EmailStr
    admin_password: str
    admin_full_name: Optional[str] = None
    plan_slug: str = "free"
