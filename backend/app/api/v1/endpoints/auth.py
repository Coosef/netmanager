import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.core.mfa import (
    verify_and_consume_recovery_code,
    verify_stored_totp,
)
from app.core.security import (
    create_access_token,
    create_mfa_challenge_token,
    decode_mfa_challenge_token,
    hash_password,
    new_jti,
    verify_password,
)
from app.core.config import settings as _app_settings
from app.models.invite_token import InviteToken
from app.models.user import User, SystemRole
from app.schemas.auth import (
    InviteAcceptRequest,
    LoginRequest,
    MfaChallengeResponse,
    MfaVerifyRequest,
    TokenResponse,
)
from app.schemas.user import UserResponse
from app.services.audit_service import log_action

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


async def _build_token_response(
    db: AsyncSession, user: User, request: Optional[Request] = None,
) -> TokenResponse:
    """Build a TokenResponse enriched with the user's full permission set.

    T8.4 — Her login'de UserSession kaydı oluşturulur; JWT'nin jti claim'i
    bu satırın anahtarıdır. Super admin "Canlı Oturumlar" panelinden
    revoke edebilsin diye ip + user_agent de kaydedilir.
    """
    from app.services.rbac.engine import permission_engine
    from app.models.user_session import UserSession
    permissions = await permission_engine.get_permissions(db, user)

    # T8.4 — jti + session create
    jti = new_jti()
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=_app_settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    ip = None
    user_agent = None
    if request is not None:
        ip = request.client.host if request.client else None
        user_agent = (request.headers.get("user-agent") or None)
        if user_agent and len(user_agent) > 512:
            user_agent = user_agent[:512]
    db.add(UserSession(
        jti=jti, user_id=user.id, ip=ip, user_agent=user_agent,
        created_at=now, last_activity=now, expires_at=expires_at,
    ))
    await db.commit()

    return TokenResponse(
        access_token=create_access_token({"sub": str(user.id), "jti": jti}),
        user_id=user.id,
        username=user.username,
        # M6 final drop — legacy `role` column gone; surface `system_role`
        # as `role` for the frontend (which expects the field). The new
        # `system_role` field still carries the same value for callers
        # that have already migrated to it.
        role=user.system_role,
        system_role=user.system_role,
        org_id=user.organization_id,
        permissions=permissions,
    )


def _mask_email(email: Optional[str]) -> Optional[str]:
    """Mask 'alice@example.com' → 'a***e@example.com' for the MFA UI.
    Falsy / malformed emails return None — the UI just hides the line."""
    if not email or "@" not in email:
        return None
    name, _, domain = email.partition("@")
    if len(name) <= 2:
        masked = name[0] + "*"
    else:
        masked = name[0] + "*" * max(1, len(name) - 2) + name[-1]
    return f"{masked}@{domain}"


@router.post("/login", response_model=Union[TokenResponse, MfaChallengeResponse])
@limiter.limit("10/minute")
async def login(
    payload: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(User).where(User.username == payload.username, User.is_active == True)
    )
    user = result.scalar_one_or_none()

    if not user or not verify_password(payload.password, user.hashed_password):
        await log_action(
            db, None, "login_failed",
            details={"username": payload.username},
            status="failure",
            request=request,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    # ── MFA branch ──────────────────────────────────────────────────────
    # The password is now confirmed. If the user opted into MFA, do NOT
    # issue an access token — hand back a short-lived challenge token
    # the client trades at /auth/mfa/verify. Audit the password step
    # separately so a 2FA-protected account still leaves a breadcrumb on
    # password-only success.
    if user.mfa_enabled:
        await log_action(
            db, user, "login_mfa_challenge",
            details={"methods": (user.mfa_methods or "totp").split(",")},
            request=request,
        )
        methods = [m.strip() for m in (user.mfa_methods or "totp").split(",") if m.strip()]
        return MfaChallengeResponse(
            challenge_token=create_mfa_challenge_token(user.id),
            mfa_methods=methods,
            mfa_default_method=methods[0] if methods else "totp",
            masked_email=_mask_email(user.email),
        )

    # ── No MFA — proceed as before ──────────────────────────────────────
    await db.execute(
        update(User).where(User.id == user.id).values(last_login=datetime.now(timezone.utc))
    )
    await db.commit()
    await db.refresh(user)

    token_resp = await _build_token_response(db, user, request=request)
    await log_action(db, user, "login", request=request)
    return token_resp


@router.post("/mfa/verify", response_model=TokenResponse)
@limiter.limit("10/minute")
async def mfa_verify(
    payload: MfaVerifyRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Trade an MFA challenge token + a valid OTP (or recovery code) for
    a real access token. The challenge token alone cannot reach this —
    it has scope='mfa-challenge' which decode_access_token rejects, and
    this endpoint requires the code in the same call."""
    user_id = decode_mfa_challenge_token(payload.challenge_token)
    if user_id is None:
        await log_action(
            db, None, "mfa_verify_failed",
            details={"reason": "invalid_or_expired_challenge"},
            status="failure", request=request,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="MFA challenge expired — please log in again",
        )

    user = await db.get(User, user_id)
    if user is None or not user.is_active or not user.mfa_enabled:
        # Defense in depth — the challenge token already vouches for the
        # user but the account could have been disabled / MFA removed in
        # the 5-minute window.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")

    method = (payload.method or "totp").lower()
    ok = False
    consumed_recovery = False

    if method == "totp":
        ok = verify_stored_totp(user.mfa_totp_secret, payload.code)
    elif method == "recovery":
        stored = list(user.mfa_recovery_codes or [])
        ok, remaining = verify_and_consume_recovery_code(stored, payload.code)
        if ok:
            user.mfa_recovery_codes = remaining
            consumed_recovery = True
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported MFA method: {method}")

    if not ok:
        await log_action(
            db, user, "mfa_verify_failed",
            details={"method": method},
            status="failure", request=request,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Geçersiz kod")

    # ── Success — promote to a real session ─────────────────────────────
    user.last_login = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)

    token_resp = await _build_token_response(db, user, request=request)
    audit_details: dict = {"method": method}
    if consumed_recovery:
        audit_details["recovery_codes_remaining"] = len(user.mfa_recovery_codes or [])
    await log_action(db, user, "login_mfa_success", details=audit_details, request=request)
    return token_resp


@router.post("/logout", status_code=204)
async def logout(
    request: Request,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """T8.4 — Server-side session revoke. Client localStorage'dan token'ı
    silmeden önce çağırır; bu jti tabloda revoked_at=now olarak işaretlenir,
    sonraki request'lerde get_current_user 401 döner. Best-effort: client
    bağlanamazsa zaten localStorage temizleyip yeniden login flow başlar."""
    from app.models.user_session import UserSession
    from sqlalchemy import update as _update
    auth_header = request.headers.get("Authorization") or ""
    if auth_header.lower().startswith("bearer "):
        from app.core.security import decode_access_token
        payload = decode_access_token(auth_header.split(" ", 1)[1])
        jti = (payload or {}).get("jti")
        if jti:
            await db.execute(
                _update(UserSession)
                .where(UserSession.jti == jti, UserSession.revoked_at.is_(None))
                .values(revoked_at=datetime.now(timezone.utc),
                        revoked_by_id=current_user.id,
                        revoked_reason="logout")
            )
            await db.commit()
    await log_action(db, current_user, "logout", request=request)
    return None


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: CurrentUser):
    return current_user


@router.get("/me/permissions")
async def get_my_permissions(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Return the current user's full permissions dict (used by frontend sidebar)."""
    from app.services.rbac.engine import permission_engine
    permissions = await permission_engine.get_permissions(db, current_user)
    return {"permissions": permissions, "system_role": current_user.system_role}


@router.post("/invite/accept", response_model=TokenResponse)
async def accept_invite(
    payload: InviteAcceptRequest,
    db: AsyncSession = Depends(get_db),
):
    """Accept an invite token and create a new user account."""
    result = await db.execute(
        select(InviteToken).where(
            InviteToken.token == payload.token,
            InviteToken.used_at.is_(None),
            InviteToken.expires_at > datetime.now(timezone.utc),
        )
    )
    invite = result.scalar_one_or_none()
    if invite is None:
        raise HTTPException(status_code=400, detail="Geçersiz veya süresi dolmuş davet linki")

    # Check username uniqueness
    existing = await db.execute(
        select(User).where(User.username == payload.username)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Bu kullanıcı adı zaten kullanılıyor")

    # Check email uniqueness
    existing_email = await db.execute(
        select(User).where(User.email == invite.email)
    )
    if existing_email.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Bu e-posta adresi zaten kayıtlı")

    # M6-B2 — invitee inherits the invite's organization (the legacy
    # `tenant_id` column stays nullable in the DB until the M6 final
    # drop; we no longer write to it).
    user = User(
        username=payload.username,
        email=invite.email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name or invite.full_name,
        is_active=True,
        role="viewer",   # legacy column, retired in B4
        system_role=invite.system_role,
        organization_id=invite.organization_id,
    )
    db.add(user)
    await db.flush()  # get user.id

    # Assign permission set if specified in invite
    if invite.permission_set_id and invite.organization_id:
        from app.models.shared.user_location_perm import UserLocationPerm
        ulp = UserLocationPerm(
            user_id=user.id,
            location_id=None,  # org-wide default
            permission_set_id=invite.permission_set_id,
            assigned_by=invite.created_by,
        )
        db.add(ulp)

    # Mark invite as used
    invite.used_at = datetime.now(timezone.utc)
    invite.used_by_user_id = user.id
    db.add(invite)

    await db.commit()
    await db.refresh(user)

    return await _build_token_response(db, user, request=request)
