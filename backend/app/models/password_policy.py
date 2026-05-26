"""PasswordPolicy — org bazlı şifre kuralları (T9 Tur 2 #3).

Org bazlı tek satır + global default. Çözünürlük:
  1. organization_id = X kaydı → onu kullan
  2. organization_id IS NULL → global default
  3. Kod-içi DEFAULTS fallback
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PasswordPolicy(Base):
    __tablename__ = "password_policies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    organization_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=True, unique=True, index=True,
    )
    min_length: Mapped[int] = mapped_column(Integer, nullable=False, default=8)
    require_uppercase: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    require_lowercase: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    require_digit: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    require_special: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Son N şifre tekrar edilmesin (bcrypt hash karşılaştırması).
    # 0 = history check yok.
    history_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # 0 = expire yok; >0 = bu kadar gün sonra zorla değişim
    expiry_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Yeni kullanıcılar (create) veya reset sonrası must_change_password=True olur
    force_change_on_first_login: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
