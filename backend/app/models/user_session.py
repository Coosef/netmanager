"""UserSession — active JWT-backed login sessions, revocation-capable.

T8.4 — Mevcut sistem stateless JWT (jti yok, server-side session yok).
Bu tablo her başarılı login'de bir satır oluşturur; JWT payload'una `jti`
(uuid) eklenir. `get_current_user` token.jti → bu tabloya bakar:
revoked_at IS NOT NULL ise 401 (Invalid session) döner — token cryptografik
olarak hâlâ geçerli olsa bile.

Super admin "Canlı Oturumlar" panelinden başka kullanıcıların oturumlarını
sonlandırabilir (DELETE /super-admin/sessions/{id}). Kullanıcı /logout
çağırınca da kendi session'ı revoke olur.

Son aktivite (last_activity) get_current_user'da rate-limited update — sadece
60 saniyeden eski ise yeniden yazılır (her request'te yazma yükünü engeller).
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class UserSession(Base):
    __tablename__ = "user_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    jti: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    ip: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
    )
    last_activity: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
    )
    # Token expiry — JWT exp claim'iyle aynı; super admin paneli "geçerlilik"
    # gösterimi için doğrudan tablo okur (JWT decode gerekmez).
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )

    revoked_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    revoked_by_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # 'logout' | 'admin' | 'expired' — UI etiketleme için
    revoked_reason: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
