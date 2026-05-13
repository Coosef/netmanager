from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import Boolean, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.core.database import Base


class EscalationRule(Base):
    __tablename__ = "escalation_rules"

    id:         Mapped[int]  = mapped_column(Integer, primary_key=True)
    name:       Mapped[str]  = mapped_column(String(200), nullable=False)
    enabled:    Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Matchers (all null = match everything) ────────────────────────────────
    # JSON arrays stored as Text: '["critical","warning"]' or null
    match_severity:    Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    match_event_types: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    match_sources:     Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Only fire when incident has been open at least this long
    min_duration_secs: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Incident states that trigger this rule (JSON array); default ["OPEN","DEGRADED"]
    match_states:      Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Webhook action ────────────────────────────────────────────────────────
    webhook_type: Mapped[str] = mapped_column(String(20), nullable=False)  # slack|jira|generic
    webhook_url:  Mapped[str] = mapped_column(String(500), nullable=False)
    # Extra headers as JSON: '{"Authorization": "Bearer token"}' — stored plaintext, masked in API
    webhook_headers: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Cooldown ──────────────────────────────────────────────────────────────
    # Don't re-notify for the same incident within this window (seconds)
    cooldown_secs: Mapped[int] = mapped_column(Integer, default=3600, nullable=False)

    # ── Audit ─────────────────────────────────────────────────────────────────
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    created_by: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    logs: Mapped[list["EscalationNotificationLog"]] = relationship(
        "EscalationNotificationLog", back_populates="rule", cascade="all, delete-orphan"
    )


class EscalationNotificationLog(Base):
    __tablename__ = "escalation_notification_logs"

    id:          Mapped[int] = mapped_column(Integer, primary_key=True)
    rule_id:     Mapped[int] = mapped_column(
        Integer, ForeignKey("escalation_rules.id", ondelete="CASCADE"), nullable=False, index=True
    )
    incident_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)

    channel:       Mapped[str] = mapped_column(String(20), nullable=False)   # slack|jira|generic
    status:        Mapped[str] = mapped_column(String(20), nullable=False)   # sent|failed|dry_run
    response_code: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    error_msg:     Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    sent_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
    )

    rule: Mapped["EscalationRule"] = relationship("EscalationRule", back_populates="logs")
