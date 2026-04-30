from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt as pyjwt
from cryptography.fernet import Fernet
from jwt.exceptions import InvalidTokenError as JWTError  # noqa: F401 — re-exported for callers
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

_fernet: Optional[Fernet] = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(settings.CREDENTIAL_ENCRYPTION_KEY.encode())
    return _fernet


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return pyjwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> Optional[dict]:
    try:
        return pyjwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
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
