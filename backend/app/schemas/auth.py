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
    # T9 Tur 2 #3 — Password policy hints (UI'da zorla şifre değişim modali için)
    must_change_password: bool = False
    password_expired: bool = False


class MfaChallengeResponse(BaseModel):
    """Returned by /auth/login when the user has MFA enabled. The
    client trades `challenge_token` + the user's OTP at /auth/mfa/verify
    for a real access token. No access_token here — by design."""
    mfa_required: bool = True
    challenge_token: str
    mfa_methods: list[str]              # e.g. ['totp']
    mfa_default_method: str             # frontend picks this initially
    masked_email: Optional[str] = None  # for the 'email' method later


class MfaVerifyRequest(BaseModel):
    challenge_token: str
    code: str           # 6-digit TOTP, or a recovery code if method='recovery'
    method: str = "totp"


class MfaEnrollResponse(BaseModel):
    """Payload returned from /users/me/mfa/enroll/totp. The secret is
    shown ONCE — the client renders the otpauth URI as a QR. The user
    completes setup by POSTing a valid code to /confirm."""
    secret: str
    otpauth_uri: str
    issuer: str


class MfaConfirmRequest(BaseModel):
    code: str           # First code from the authenticator, proves setup OK


class MfaConfirmResponse(BaseModel):
    mfa_enabled: bool = True
    recovery_codes: list[str]   # plaintext, shown ONCE


class MfaDisableRequest(BaseModel):
    password: str       # Re-confirm password to disable MFA
    code: Optional[str] = None  # OPTIONAL: TOTP or recovery; recommended


class MfaStatusResponse(BaseModel):
    mfa_enabled: bool
    methods: list[str]
    recovery_codes_remaining: int
    enrolled_at: Optional[str] = None


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
