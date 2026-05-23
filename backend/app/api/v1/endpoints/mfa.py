"""MFA enrollment / management — /users/me/mfa/*.

Login itself (challenge + verify) lives in endpoints.auth. This module
owns the enrollment lifecycle:

    GET    /me/mfa/status                — read state for Settings UI
    POST   /me/mfa/enroll/totp           — start: returns secret + URI
    POST   /me/mfa/confirm               — finish: verify first code, enable
    POST   /me/mfa/disable               — turn off (re-confirms password)
    POST   /me/mfa/recovery-codes/regen  — generate a fresh batch

Password re-confirmation guards disabling, so a session hijack on an
already-authenticated tab can't silently strip MFA off the account.
Enrollment writes pending_secret first; only /confirm flips mfa_enabled
on, so a half-finished setup never locks the user out.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.core.mfa import (
    encrypt_secret,
    generate_recovery_codes,
    generate_totp_secret,
    hash_recovery_codes,
    otpauth_uri,
    verify_and_consume_recovery_code,
    verify_stored_totp,
    verify_totp,
)
from app.core.security import verify_password
from app.models.user import User
from app.schemas.auth import (
    MfaConfirmRequest,
    MfaConfirmResponse,
    MfaDisableRequest,
    MfaEnrollResponse,
    MfaStatusResponse,
)
from app.services.audit_service import log_action

router = APIRouter()

_DEFAULT_ISSUER = "Charon"


def _issuer() -> str:
    """The label that shows up in the authenticator app's UI."""
    try:
        from app.core.config import settings
        return getattr(settings, "MFA_ISSUER", _DEFAULT_ISSUER)
    except Exception:
        return _DEFAULT_ISSUER


@router.get("/me/mfa/status", response_model=MfaStatusResponse)
async def mfa_status(current_user: CurrentUser):
    """Read-only state for the Settings UI's MFA card."""
    recovery = current_user.mfa_recovery_codes or []
    methods = [m.strip() for m in (current_user.mfa_methods or "").split(",") if m.strip()]
    return MfaStatusResponse(
        mfa_enabled=bool(current_user.mfa_enabled),
        methods=methods,
        recovery_codes_remaining=len(recovery),
        enrolled_at=(
            current_user.mfa_enrolled_at.isoformat()
            if current_user.mfa_enrolled_at else None
        ),
    )


@router.post("/me/mfa/enroll/totp", response_model=MfaEnrollResponse)
async def mfa_enroll_totp(
    request: Request,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Start TOTP enrollment. Returns the base32 secret + the otpauth URI
    the frontend renders as a QR. The secret is stored Fernet-encrypted
    in `mfa_pending_secret` — MFA is not active until /confirm validates
    a code from the authenticator. Re-calling overwrites the pending
    secret, which is the right behaviour (user scanned the wrong QR)."""
    secret = generate_totp_secret()
    user = await db.get(User, current_user.id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    user.mfa_pending_secret = encrypt_secret(secret)
    await db.commit()

    account = user.email or user.username
    uri = otpauth_uri(secret=secret, account_name=account, issuer=_issuer())

    await log_action(
        db, user, "mfa_enroll_started",
        details={"method": "totp"}, request=request,
    )
    return MfaEnrollResponse(secret=secret, otpauth_uri=uri, issuer=_issuer())


@router.post("/me/mfa/confirm", response_model=MfaConfirmResponse)
async def mfa_confirm(
    payload: MfaConfirmRequest,
    request: Request,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Finish enrollment by proving the user can read the authenticator —
    promote pending_secret → totp_secret, flip mfa_enabled on, mint the
    one-time recovery codes (plaintext returned ONCE; bcrypt-hashed for
    storage). Idempotent re-confirmation rotates recovery codes if the
    user is already enrolled (they're effectively re-enrolling)."""
    user = await db.get(User, current_user.id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if not user.mfa_pending_secret:
        raise HTTPException(
            status_code=400,
            detail="Önce /me/mfa/enroll/totp çağırın",
        )

    if not verify_stored_totp(user.mfa_pending_secret, payload.code):
        await log_action(
            db, user, "mfa_confirm_failed",
            details={"reason": "bad_code"}, status="failure", request=request,
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Geçersiz kod")

    plain_recovery = generate_recovery_codes()
    user.mfa_totp_secret = user.mfa_pending_secret
    user.mfa_pending_secret = None
    user.mfa_recovery_codes = hash_recovery_codes(plain_recovery)
    user.mfa_methods = "totp"
    user.mfa_enabled = True
    user.mfa_enrolled_at = datetime.now(timezone.utc)
    await db.commit()

    await log_action(
        db, user, "mfa_enabled",
        details={"method": "totp", "recovery_codes_issued": len(plain_recovery)},
        request=request,
    )
    return MfaConfirmResponse(recovery_codes=plain_recovery)


@router.post("/me/mfa/disable")
async def mfa_disable(
    payload: MfaDisableRequest,
    request: Request,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Turn MFA off. Requires the account password (re-auth in a hijacked
    tab) and, if a `code` is supplied, a valid TOTP or recovery code.
    Recommended flow from the UI always sends both."""
    user = await db.get(User, current_user.id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if not verify_password(payload.password, user.hashed_password):
        await log_action(
            db, user, "mfa_disable_failed",
            details={"reason": "bad_password"}, status="failure", request=request,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Geçersiz şifre")

    if not user.mfa_enabled:
        # idempotent — nothing to undo
        return {"mfa_enabled": False}

    if payload.code:
        if not (
            verify_stored_totp(user.mfa_totp_secret, payload.code)
            or verify_and_consume_recovery_code(
                list(user.mfa_recovery_codes or []), payload.code
            )[0]
        ):
            await log_action(
                db, user, "mfa_disable_failed",
                details={"reason": "bad_code"}, status="failure", request=request,
            )
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Geçersiz kod")

    user.mfa_enabled = False
    user.mfa_totp_secret = None
    user.mfa_pending_secret = None
    user.mfa_recovery_codes = None
    user.mfa_methods = None
    user.mfa_enrolled_at = None
    await db.commit()

    await log_action(db, user, "mfa_disabled", request=request)
    return {"mfa_enabled": False}


@router.post("/me/mfa/recovery-codes/regenerate", response_model=MfaConfirmResponse)
async def mfa_regenerate_recovery_codes(
    payload: MfaConfirmRequest,    # reuse — needs a current TOTP to authorise
    request: Request,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Roll the recovery codes — old ones become invalid immediately.
    Requires a current TOTP so a hijacked session cannot rotate the
    user's last-ditch fallbacks. Returns the new batch ONCE."""
    user = await db.get(User, current_user.id)
    if user is None or not user.mfa_enabled:
        raise HTTPException(status_code=400, detail="MFA aktif değil")

    if not verify_stored_totp(user.mfa_totp_secret, payload.code):
        await log_action(
            db, user, "mfa_recovery_regen_failed",
            details={"reason": "bad_code"}, status="failure", request=request,
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Geçersiz kod")

    plain_recovery = generate_recovery_codes()
    user.mfa_recovery_codes = hash_recovery_codes(plain_recovery)
    await db.commit()
    await log_action(db, user, "mfa_recovery_codes_regenerated", request=request)
    return MfaConfirmResponse(recovery_codes=plain_recovery)
