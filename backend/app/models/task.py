from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, JSON, Boolean
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class TaskType(str, Enum):
    PING = "ping"
    GET_CONFIG = "get_config"
    BACKUP_CONFIG = "backup_config"
    PUSH_CONFIG = "push_config"
    RESTORE_CONFIG = "restore_config"
    BULK_PASSWORD_CHANGE = "bulk_password_change"
    BULK_COMMAND = "bulk_command"
    PORT_TOGGLE = "port_toggle"
    VLAN_PUSH = "vlan_push"
    FIRMWARE_UPGRADE = "firmware_upgrade"
    MONITOR_POLL = "monitor_poll"


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    celery_task_id: Mapped[Optional[str]] = mapped_column(String(255), index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default=TaskStatus.PENDING, index=True)

    # JSON fields for flexibility
    device_ids: Mapped[Optional[list]] = mapped_column(JSON)  # list of device IDs
    parameters: Mapped[Optional[dict]] = mapped_column(JSON)  # task-specific params
    result: Mapped[Optional[dict]] = mapped_column(JSON)       # per-device results
    error: Mapped[Optional[str]] = mapped_column(Text)

    total_devices: Mapped[int] = mapped_column(Integer, default=0)
    completed_devices: Mapped[int] = mapped_column(Integer, default=0)
    failed_devices: Mapped[int] = mapped_column(Integer, default=0)

    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    tenant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("tenants.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
