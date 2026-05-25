"""ComplianceProfile — kullanıcının uyumluluk taraması için seçtiği kural seti.

T8.4 parametrik uyumluluk denetimi:
  - System (built-in) kurallar kataloğu services/security_audit_service.py
    içindeki BUILTIN_RULES listesinde tanımlı.
  - Kullanıcı bu kataloğu seçerek bir Profile oluşturur (enabled_rule_ids
    JSONB list). Bir org birden çok profile barındırabilir, biri default
    işaretlenir (is_default=True).
  - Tarama (run audit) çağrısında profile_id parametresi verilirse, audit
    çıktısı sadece o profile'ın enabled_rule_ids set'i ile filtrelenir.
  - Custom rule (kullanıcı kendi regex pattern'ini ekler) v2'ye bırakıldı;
    bu sürüm sadece built-in toggle.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ComplianceProfile(Base):
    __tablename__ = "compliance_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # JSONB list of built-in rule_id strings. ["ssh_v2", "telnet_disabled", ...]
    # Empty list = profile mevcut ama hiçbir kural seçili değil (audit anlamsız).
    enabled_rule_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)

    # Org içinde varsayılan olarak kullanılan profile. Aynı org içinde tek
    # row True olabilir (uygulamada endpoint enforce eder; DB partial unique
    # index v2'de).
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    created_by_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
