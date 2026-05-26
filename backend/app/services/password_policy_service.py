"""PasswordPolicyService — org bazlı şifre kuralı çözünürlüğü + validation.

T9 Tur 2 #3.

Kullanım:
  policy = await get_effective_policy(db, user.organization_id)
  ok, errors = validate_password(new_pw, policy)
  if not ok: raise HTTPException(400, errors)

  await check_history(db, user, new_pw_plain)  # last N reuse check
  await register_change(db, user, new_pw_plain)  # history append + ts
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password, verify_password
from app.models.password_policy import PasswordPolicy
from app.models.user import User


@dataclass
class EffectivePolicy:
    """Org bazlı veya global default'tan derlenmiş kural seti."""
    min_length: int = 8
    require_uppercase: bool = False
    require_lowercase: bool = True
    require_digit: bool = True
    require_special: bool = False
    history_count: int = 0
    expiry_days: int = 0
    force_change_on_first_login: bool = False
    source: str = "code-default"   # "org-X" | "global" | "code-default"


_SPECIAL_RE = re.compile(r"[^A-Za-z0-9\s]")


async def get_effective_policy(
    db: AsyncSession, organization_id: Optional[int] = None,
) -> EffectivePolicy:
    """Org bazlı policy → global default → kod-içi DEFAULTS."""
    # 1) Org-specific
    if organization_id is not None:
        row = (await db.execute(
            select(PasswordPolicy).where(PasswordPolicy.organization_id == organization_id)
        )).scalar_one_or_none()
        if row is not None:
            return _from_row(row, source=f"org-{organization_id}")
    # 2) Global default
    row = (await db.execute(
        select(PasswordPolicy).where(PasswordPolicy.organization_id.is_(None))
    )).scalar_one_or_none()
    if row is not None:
        return _from_row(row, source="global")
    # 3) Kod default
    return EffectivePolicy()


def _from_row(row: PasswordPolicy, source: str) -> EffectivePolicy:
    return EffectivePolicy(
        min_length=row.min_length,
        require_uppercase=row.require_uppercase,
        require_lowercase=row.require_lowercase,
        require_digit=row.require_digit,
        require_special=row.require_special,
        history_count=row.history_count,
        expiry_days=row.expiry_days,
        force_change_on_first_login=row.force_change_on_first_login,
        source=source,
    )


def validate_password(password: str, policy: EffectivePolicy) -> tuple[bool, list[str]]:
    """Düz metin şifreyi policy'ye karşı doğrula. Returns (ok, list of errors)."""
    errors: list[str] = []
    if not password or not isinstance(password, str):
        errors.append("Şifre boş olamaz")
        return False, errors

    if len(password) < policy.min_length:
        errors.append(f"En az {policy.min_length} karakter olmalı")
    if policy.require_uppercase and not any(c.isupper() for c in password):
        errors.append("En az bir BÜYÜK harf içermeli")
    if policy.require_lowercase and not any(c.islower() for c in password):
        errors.append("En az bir küçük harf içermeli")
    if policy.require_digit and not any(c.isdigit() for c in password):
        errors.append("En az bir rakam içermeli")
    if policy.require_special and not _SPECIAL_RE.search(password):
        errors.append("En az bir özel karakter içermeli (.!?@#$ vb)")

    return (len(errors) == 0), errors


def is_reused(password: str, history: list[str] | None) -> bool:
    """Mevcut bcrypt hash geçmişinde aynı şifre var mı?"""
    if not history:
        return False
    for h in history:
        if verify_password(password, h):
            return True
    return False


def is_expired(user: User, policy: EffectivePolicy) -> bool:
    """Kullanıcının şifresi policy'ye göre süresi dolmuş mu?"""
    if policy.expiry_days <= 0:
        return False
    if user.password_changed_at is None:
        return False  # ts yok → geçmişe atfet, expired sayma
    age_days = (datetime.now(timezone.utc) - user.password_changed_at).days
    return age_days >= policy.expiry_days


def register_password_change(
    user: User, new_password_plain: str, policy: EffectivePolicy,
) -> None:
    """Şifre değişimini kullanıcıda işle:
      - hashed_password yenile
      - password_changed_at = now
      - password_history'e mevcut hash'i ekle (max history_count tutulur)
      - must_change_password = False (eğer set ise temizle)
    DB commit ÇAĞRI YAPMAZ; çağıran commit eder.
    """
    new_hash = hash_password(new_password_plain)
    # History'e eski hash'i ekle (eski şifre tekrar engeli için)
    history: list[str] = list(user.password_history or [])
    if user.hashed_password and user.hashed_password not in history:
        history.append(user.hashed_password)
    # Max history_count tut
    if policy.history_count > 0 and len(history) > policy.history_count:
        history = history[-policy.history_count:]
    user.hashed_password = new_hash
    user.password_changed_at = datetime.now(timezone.utc)
    user.password_history = history
    user.must_change_password = False
