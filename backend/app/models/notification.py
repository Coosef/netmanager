from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class NotificationChannel(Base):
    __tablename__ = "notification_channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # email | slack | telegram
    type: Mapped[str] = mapped_column(String(32), nullable=False)

    # email: {smtp_host, smtp_port, smtp_use_tls, smtp_username, smtp_password, recipients: []}
    # slack: {webhook_url}
    # telegram: {bot_token, chat_id}
    config: Mapped[dict] = mapped_column(JSON, default=dict)

    # List of event categories to notify on:
    # device_offline | critical_event | warning_event | approval_request |
    # playbook_failure | backup_failure | any_event
    notify_on: Mapped[list] = mapped_column(JSON, default=list)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class NotificationLog(Base):
    """Tracks sent notifications to prevent duplicate sends."""
    __tablename__ = "notification_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("notification_channels.id", ondelete="CASCADE"), index=True)

    # Source that triggered this notification
    source_type: Mapped[str] = mapped_column(String(64), index=True)  # network_event | approval | playbook_run
    source_id: Mapped[int] = mapped_column(index=True)

    success: Mapped[bool] = mapped_column(Boolean, default=True)
    error: Mapped[Optional[str]] = mapped_column(Text)
    sent_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
