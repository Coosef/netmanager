from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt as pyjwt
from cryptography.fernet import Fernet, MultiFernet
from jwt.exceptions import InvalidTokenError as JWTError  # noqa: F401 — re-exported for callers
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

_multi: Optional[MultiFernet] = None


def _get_fernet() -> MultiFernet:
    global _multi
    if _multi is None:
        keys = [Fernet(settings.CREDENTIAL_ENCRYPTION_KEY.encode())]
        if settings.CREDENTIAL_ENCRYPTION_KEY_OLD:
            keys.append(Fernet(settings.CREDENTIAL_ENCRYPTION_KEY_OLD.encode()))
        _multi = MultiFernet(keys)
    return _multi


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """T8.4 — JWT'ye `jti` (uuid) eklendi. Caller jti'yi caller'a verirse
    UserSession kaydında aynı jti ile session yaratılır → revoke kontrolü
    için get_current_user bu jti'yi tabloya bakar."""
    import uuid as _uuid
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    # Caller jti vermediyse otomatik üret. Login flow `_build_token_response`
    # explicit jti vererek session ile binding kurar; eski callerlar (testler,
    # tek-seferlik token'lar) tabloya yazılmaz, sadece jti claim'i alır
    # (revoke kontrolü session yoksa pas geçer — backward compat).
    if "jti" not in to_encode:
        to_encode["jti"] = _uuid.uuid4().hex
    to_encode.update({"exp": expire})
    return pyjwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def new_jti() -> str:
    """T8.4 — UserSession yaratmadan önce jti üret, sonra token ile birlikte
    aynı jti'yi geç. Çift-uuid önler (sym aynı id)."""
    import uuid as _uuid
    return _uuid.uuid4().hex


def decode_access_token(token: str) -> Optional[dict]:
    try:
        return pyjwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return None


# ── MFA challenge tokens ─────────────────────────────────────────────────────
# Short-lived JWT returned by /auth/login when the user has MFA enabled.
# Carries the user id with scope='mfa-challenge'; the client trades it
# (plus the OTP) at /auth/mfa/verify for a real access token. Five-minute
# expiry — long enough to fish the phone out of a pocket, short enough
# that a stolen browser tab can't sit on it. The scope claim isolates
# this token from a normal access token: even if leaked it can ONLY be
# spent at /auth/mfa/verify, never to call protected endpoints.

MFA_CHALLENGE_SCOPE = "mfa-challenge"
MFA_CHALLENGE_TTL = timedelta(minutes=5)


def create_mfa_challenge_token(user_id: int) -> str:
    """Issue a short-lived JWT proving the user passed password but not
    yet MFA. Never grants access; only valid at /auth/mfa/verify."""
    return pyjwt.encode(
        {
            "sub": str(user_id),
            "scope": MFA_CHALLENGE_SCOPE,
            "exp": datetime.now(timezone.utc) + MFA_CHALLENGE_TTL,
        },
        settings.SECRET_KEY,
        algorithm=settings.ALGORITHM,
    )


def decode_mfa_challenge_token(token: str) -> Optional[int]:
    """Return the user_id encoded in a valid MFA challenge token, else
    None. Rejects tokens missing or with a wrong scope so an access
    token can never be replayed as a challenge."""
    try:
        payload = pyjwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM],
        )
    except JWTError:
        return None
    if payload.get("scope") != MFA_CHALLENGE_SCOPE:
        return None
    try:
        return int(payload.get("sub"))
    except (TypeError, ValueError):
        return None


def encrypt_credential(plaintext: str) -> str:
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt_credential(ciphertext: str) -> str:
    return _get_fernet().decrypt(ciphertext.encode()).decode()


def decrypt_credential_safe(value: Optional[str]) -> Optional[str]:
    """Decrypt a Fernet-encrypted credential; return the original string if it is not
    encrypted (e.g. values written before encryption was enabled)."""
    if not value:
        return None
    try:
        return decrypt_credential(value)
    except Exception:
        return value
