from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column, relationship  # noqa: F401

from app.core.database import Base


class ConfigBackup(Base):
    __tablename__ = "config_backups"
    __table_args__ = (
        Index("ix_config_backups_device_created", "device_id", text("created_at DESC")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id"), index=True)
    config_text: Mapped[str] = mapped_column(Text, nullable=False)
    config_hash: Mapped[str] = mapped_column(String(64))  # SHA256 for change detection
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[Optional[str]] = mapped_column(String(512))
    created_by: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"))
    task_id: Mapped[Optional[int]] = mapped_column(ForeignKey("tasks.id"))
    is_golden: Mapped[bool] = mapped_column(Boolean, default=False)
    golden_set_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )

    device: Mapped["Device"] = relationship("Device", back_populates="config_backups")
