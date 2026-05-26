"""MFA Email OTP service — kod üretim, gönderim, Redis store/verify.

T9 Tur 2 #2b. Mevcut SMTP altyapısı yeniden kullanılır:
  - Kullanıcının org'unda tanımlı ilk aktif `notification_channels` (type='email')
    kanalının SMTP config'i alınır (smtp_host/port/tls/user/pass)
  - Receiver: user.email (NotificationChannel.config['recipients'] DEĞİL — MFA
    için kullanıcının kendi email'ine gönderiyoruz)
  - Email kanalı yok ise net hata: "Önce Settings → Bildirimler'de email
    kanalı tanımlamalısınız."

Redis kontratı:
  mfa:otp:enroll:email:{user_id}    → bcrypt hash, TTL 600s
  mfa:otp:challenge:email:{user_id} → bcrypt hash, TTL 600s
  mfa:otp:resend:email:{user_id}    → "1", TTL 60s (resend rate-limit)
"""
from __future__ import annotations

import logging
from typing import Optional

import redis as _redis_sync
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import mfa as _mfa
from app.core.config import settings
from app.models.notification import NotificationChannel
from app.models.user import User

log = logging.getLogger(__name__)


def _redis():
    return _redis_sync.from_url(settings.REDIS_URL, decode_responses=True, socket_timeout=2)


def _key(purpose: str, user_id: int) -> str:
    # purpose: 'enroll' | 'challenge' | 'resend'
    return f"mfa:otp:{purpose}:email:{user_id}"


async def _resolve_smtp_config(db: AsyncSession, user: User) -> dict:
    """User'ın org'unda tanımlı ilk aktif email channel config'ini döndürür.
    Yoksa ValueError raise eder.
    """
    if user.organization_id is None:
        raise ValueError(
            "Kullanıcının organizasyonu yok — MFA email gönderilemez"
        )
    row = (await db.execute(
        select(NotificationChannel).where(
            NotificationChannel.type == "email",
            NotificationChannel.is_active == True,  # noqa: E712
            NotificationChannel.organization_id == user.organization_id,
        ).limit(1)
    )).scalar_one_or_none()
    if row is None:
        raise ValueError(
            "Organizasyonunuzda aktif email bildirim kanalı bulunamadı. "
            "Önce Settings → Bildirimler'de email kanalı tanımlayın."
        )
    return row.config or {}


def can_resend(user_id: int) -> tuple[bool, int]:
    """Rate-limit check. Returns (allowed, remaining_seconds)."""
    try:
        r = _redis()
        ttl = r.ttl(_key("resend", user_id))
        if ttl and ttl > 0:
            return False, int(ttl)
        return True, 0
    except Exception:
        return True, 0  # Redis down → permissive


def _store_otp(user_id: int, purpose: str, otp_plain: str) -> None:
    """OTP'yi bcrypt hash olarak Redis'te sakla (TTL ile)."""
    h = _mfa.hash_otp(otp_plain)
    r = _redis()
    r.setex(_key(purpose, user_id), _mfa.OTP_DEFAULT_TTL_SEC, h)
    # Resend rate-limit flag
    r.setex(_key("resend", user_id), _mfa.OTP_RESEND_COOLDOWN_SEC, "1")


def verify_and_consume(user_id: int, purpose: str, code: str) -> bool:
    """Redis'teki hash ile karşılaştır + match ise sil (single-use)."""
    try:
        r = _redis()
        key = _key(purpose, user_id)
        stored = r.get(key)
        if not stored:
            return False
        if _mfa.verify_otp_hash(code, stored):
            r.delete(key)
            return True
        return False
    except Exception as e:
        log.warning("mfa_email_service.verify_and_consume redis hata: %r", e)
        return False


async def send_otp(
    db: AsyncSession, user: User, purpose: str,
    *, target_email: Optional[str] = None,
) -> dict:
    """Generate + send + store. Returns {ok, email_masked, message}.

    purpose: 'enroll' (settings'te yeni kanal kuruyor) veya
             'challenge' (login esnasında 2. faktör).
    target_email: enrollment sırasında farklı bir email vermek istenirse
                  (default: user.email).
    """
    if purpose not in ("enroll", "challenge"):
        raise ValueError("invalid purpose")

    to_addr = (target_email or user.email or "").strip()
    if not to_addr:
        return {"ok": False, "message": "Kullanıcının kayıtlı email adresi yok"}

    allowed, retry_in = can_resend(user.id)
    if not allowed:
        return {
            "ok": False,
            "message": f"Çok sık deneme — {retry_in} saniye sonra tekrar deneyin",
            "retry_in_sec": retry_in,
        }

    try:
        smtp_cfg = await _resolve_smtp_config(db, user)
    except ValueError as e:
        return {"ok": False, "message": str(e)}

    otp = _mfa.generate_otp()
    # Mevcut _send_email helper'ı recipients listesinden alıyor — bizim için
    # tek alıcı: target_email. Config'i kopyala, recipients'ı override et.
    cfg_for_send = dict(smtp_cfg)
    cfg_for_send["recipients"] = [to_addr]

    # Asenkron çağrı — notification_service'in mevcut _send_email
    from app.services.notification_service import _send_email
    subject = "Charon — MFA Doğrulama Kodu"
    body = (
        f"Merhaba,\n\n"
        f"Charon hesabınız için doğrulama kodu: {otp}\n\n"
        f"Bu kod {_mfa.OTP_DEFAULT_TTL_SEC // 60} dakika geçerlidir. "
        f"Eğer bu işlemi siz başlatmadıysanız bu emaili dikkate almayın.\n\n"
        f"— Charon Network Manager"
    )
    ok, err = await _send_email(cfg_for_send, subject, body)
    if not ok:
        log.warning("mfa_email send fail user=%s: %s", user.id, err)
        return {"ok": False, "message": f"Email gönderilemedi: {err}"}

    _store_otp(user.id, purpose, otp)

    # Mask: a***e@example.com
    name, _, dom = to_addr.partition("@")
    if dom and len(name) >= 2:
        masked = f"{name[0]}***{name[-1]}@{dom}"
    else:
        masked = to_addr
    return {
        "ok": True,
        "email_masked": masked,
        "ttl_sec": _mfa.OTP_DEFAULT_TTL_SEC,
    }
