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
    # M6 final drop — legacy `tenant_id` removed. `role` is kept (now
    # carries the SystemRole value) so existing frontend code that
    # reads `res.role` keeps working.
    role: str
    system_role: str
    org_id: Optional[int] = None
    permissions: Optional[dict] = None


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
