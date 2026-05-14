from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class CredentialProfile(Base):
    __tablename__ = "credential_profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    description: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    # SSH
    ssh_username: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    ssh_password_enc: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ssh_port: Mapped[int] = mapped_column(Integer, default=22)
    enable_secret_enc: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # SNMP v1/v2c
    snmp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    snmp_community: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    snmp_version: Mapped[str] = mapped_column(String(8), default="v2c")
    snmp_port: Mapped[int] = mapped_column(Integer, default=161)

    # SNMP v3
    snmp_v3_username: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    snmp_v3_auth_protocol: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    snmp_v3_auth_passphrase: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    snmp_v3_priv_protocol: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    snmp_v3_priv_passphrase: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
