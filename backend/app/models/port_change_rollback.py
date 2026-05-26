"""PortChangeRollback — port toggle / PoE değişiklik audit + safety timer
(T9 Tur 4 #8+E2)."""
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PortChangeRollback(Base):
    __tablename__ = "port_change_rollbacks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    location_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL"), nullable=True,
    )

    interface_name: Mapped[str] = mapped_column(String(64), nullable=False)
    # 'admin' (shutdown/no shutdown) | 'poe'
    change_type: Mapped[str] = mapped_column(String(16), nullable=False)
    # admin: 'up'/'down'; poe: 'on'/'off'
    requested_state: Mapped[str] = mapped_column(String(8), nullable=False)
    forward_cmds: Mapped[Any] = mapped_column(JSONB, nullable=False)
    rollback_cmds: Mapped[Any] = mapped_column(JSONB, nullable=False)
    forward_output: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    rollback_output: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # 'pending' | 'committed' | 'rolled_back' | 'failed'
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    apply_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    rollback_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
