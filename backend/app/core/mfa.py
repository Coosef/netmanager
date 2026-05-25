"""
Multi-factor authentication primitives.

The first cut covers RFC 6238 TOTP — the lowest-friction common
denominator for Google Authenticator, Microsoft Authenticator, Authy
and 1Password. Per-user state lives on the `users` table (see the
f8a7 migration); this module is the only place that talks to pyotp.

TOTP secrets are Fernet-encrypted at rest via ``core.security`` so a
database dump alone does not yield enrolment tokens. Recovery codes
are bcrypt-hashed (same KDF as passwords) and consumed on use — the
caller deletes the matched hash from the list so the visible count
drops.

The clock-skew window (±1 step, 30 s default) and 6-digit format are
the RFC defaults and what every authenticator app uses; do not change
them without verifying the matching frontend QR provisioning URI.
"""
from __future__ import annotations

import hashlib
import secrets
from typing import Iterable, Optional
from urllib.parse import quote

import pyotp
from passlib.context import CryptContext

from app.core.config import settings
from app.core.security import (
    decrypt_credential,
    decrypt_credential_safe,
    encrypt_credential,
)

# Separate context from the password one so a recovery-code rehash
# upgrade can't accidentally drift the password scheme.
_recovery_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ── TOTP ─────────────────────────────────────────────────────────────────────

TOTP_DIGITS = 6
TOTP_STEP_SECONDS = 30
# ±1 step ⇒ accept the previous, current and next code (≈90 s window).
# Matches Google/Microsoft Authenticator's own tolerance.
TOTP_VALID_WINDOW = 1


def generate_totp_secret() -> str:
    """A fresh base32 secret suitable for any RFC 6238 authenticator."""
    return pyotp.random_base32()


def encrypt_secret(secret: str) -> str:
    """Fernet-encrypt before persistence."""
    return encrypt_credential(secret)


def decrypt_secret(encrypted: str) -> str:
    """Decrypt a stored TOTP secret. Raises on Fernet errors — callers
    should treat that as 'enrolment broken, re-enrol'."""
    return decrypt_credential(encrypted)


def otpauth_uri(*, secret: str, account_name: str, issuer: Optional[str] = None) -> str:
    """Build the otpauth:// URI authenticator apps consume from a QR.

    The issuer is also URL-encoded into the label per the spec so the
    app shows e.g. "Charon (alice@…)". Frontend renders the QR client-
    side from this string — we do not generate PNGs server-side."""
    issuer_label = issuer or getattr(settings, "MFA_ISSUER", "Charon")
    return pyotp.totp.TOTP(
        secret,
        digits=TOTP_DIGITS,
        interval=TOTP_STEP_SECONDS,
    ).provisioning_uri(
        name=account_name,
        issuer_name=issuer_label,
    )


def verify_totp(secret: str, code: str) -> bool:
    """Constant-time verification with ±1 step tolerance. Code may
    contain spaces (some apps insert a thin space mid-code) and is
    matched against the secret."""
    if not secret or not code:
        return False
    cleaned = code.replace(" ", "").strip()
    if len(cleaned) != TOTP_DIGITS or not cleaned.isdigit():
        return False
    totp = pyotp.TOTP(secret, digits=TOTP_DIGITS, interval=TOTP_STEP_SECONDS)
    return totp.verify(cleaned, valid_window=TOTP_VALID_WINDOW)


def verify_stored_totp(encrypted_secret: Optional[str], code: str) -> bool:
    """Convenience wrapper for the columns. Returns False on any
    decryption failure rather than raising — keeps the auth path safe."""
    if not encrypted_secret:
        return False
    secret = decrypt_credential_safe(encrypted_secret)
    if not secret:
        return False
    return verify_totp(secret, code)


# ── Recovery codes ───────────────────────────────────────────────────────────

# Ten codes by default — long enough that "lost my phone" is recoverable
# without writing a novel of one-shots into the user's notes app.
RECOVERY_CODE_COUNT = 10
# 10 chars from a 32-symbol alphabet (Crockford-ish, no ambiguous chars)
# = 50 bits of entropy each; comfortably beyond brute-force in the bcrypt
# wrapper time, and ~bbbb-bbbb friendly to read aloud.
_RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
RECOVERY_CODE_LEN = 10


def generate_recovery_codes(count: int = RECOVERY_CODE_COUNT) -> list[str]:
    """Plaintext codes — the API returns them ONCE on enrolment / regen.
    Format: 'XXXXX-XXXXX' so users can read them off a printout."""
    out: list[str] = []
    for _ in range(count):
        raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(RECOVERY_CODE_LEN))
        out.append(f"{raw[:5]}-{raw[5:]}")
    return out


def hash_recovery_codes(codes: Iterable[str]) -> list[str]:
    """Bcrypt-hash a list of recovery codes for persistence. Returns one
    hash per input code; ordering is preserved so display order matches
    storage order — useful for "code 3 of 10" UX someday."""
    return [_recovery_context.hash(_normalize(c)) for c in codes]


def verify_and_consume_recovery_code(
    stored_hashes: list[str], code: str,
) -> tuple[bool, list[str]]:
    """If `code` matches one of `stored_hashes`, return (True, hashes
    minus the matched one). Otherwise (False, hashes unchanged). The
    caller persists the returned list."""
    candidate = _normalize(code)
    if not candidate:
        return False, stored_hashes
    for i, h in enumerate(stored_hashes):
        if _recovery_context.verify(candidate, h):
            remaining = stored_hashes[:i] + stored_hashes[i + 1:]
            return True, remaining
    return False, stored_hashes


def _normalize(code: str) -> str:
    """Strip user-typed dashes/spaces and uppercase for comparison."""
    return code.replace("-", "").replace(" ", "").strip().upper()


def recovery_code_fingerprint(code: str) -> str:
    """Short fingerprint to log a consumption event without revealing the
    code itself (the bcrypt hash is per-code-salted so isn't comparable
    cross-row). SHA-256 truncated to 12 hex chars = log-safe identifier."""
    return hashlib.sha256(_normalize(code).encode()).hexdigest()[:12]
