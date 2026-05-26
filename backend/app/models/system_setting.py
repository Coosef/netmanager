"""SystemSetting — org bazlı / global anahtar-değer ayarları.

T9 Tur 1 #1+E4. Kullanım örnekleri:
    scan.poll_snmp_sec          → 300 (her org farklı override edebilir)
    scan.update_baselines_sec   → 86400
    scan.relaxed_factor_in_maintenance → 0.5

Çözünürlük (SystemSettingsService):
    1. organization_id = X kaydı varsa onu döndür
    2. organization_id IS NULL (global default) kaydı varsa onu
    3. Kod-içi fallback (service'te tanımlı)
"""
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SystemSetting(Base):
    __tablename__ = "system_settings"
    __table_args__ = (
        UniqueConstraint("organization_id", "key", name="uq_system_settings_org_key"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # NULL → global default (super-admin tarafından set edilir)
    organization_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True,
    )
    key: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_by_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
    )
