from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class IncidentState(str, Enum):
    OPEN       = "OPEN"
    DEGRADED   = "DEGRADED"      # 2+ independent sources confirmed the problem
    RECOVERING = "RECOVERING"    # source cleared; waiting for synthetic confirmation
    CLOSED     = "CLOSED"
    SUPPRESSED = "SUPPRESSED"    # upstream device/port is also down — cascade


class Incident(Base):
    __tablename__ = "incidents"

    id:          Mapped[int]           = mapped_column(primary_key=True)

    # 16-char SHA-256 prefix — fingerprint(device_id, event_type, component)
    fingerprint: Mapped[str]           = mapped_column(String(16), nullable=False)

    device_id:   Mapped[Optional[int]] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True
    )
    event_type:  Mapped[str]           = mapped_column(String(64), nullable=False)
    component:   Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    severity:    Mapped[str]           = mapped_column(String(16), default="warning")

    state:       Mapped[str]           = mapped_column(
        String(16), nullable=False, default=IncidentState.OPEN, index=True
    )

    # Contributing sources: [{"source":"snmp_trap","ts":"...","confidence":0.85}, ...]
    sources:     Mapped[Optional[dict]] = mapped_column(JSON, default=list)

    # Lifecycle timestamps
    opened_at:     Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    degraded_at:   Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    recovering_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at:     Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    # Points to the upstream incident that caused suppression
    suppressed_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("incidents.id", ondelete="SET NULL"), nullable=True
    )

    # Audit trail: [{"ts":"...","state":"OPEN","reason":"..."}, ...]
    timeline:    Mapped[Optional[dict]] = mapped_column(JSON, default=list)

    device = relationship("Device", foreign_keys=[device_id], lazy="select")

    __table_args__ = (
        # Fast lookup: "is there an open incident for this fingerprint?"
        Index("ix_incident_fp_state",    "fingerprint", "state"),
        # Fast lookup: "all active incidents for a device"
        Index("ix_incident_device_state", "device_id",  "state"),
        # Time-range queries for dashboards
        Index("ix_incident_opened_at",   "opened_at"),
    )

    def add_source(self, source: str, confidence: float) -> None:
        """Append a contributing source record."""
        if self.sources is None:
            self.sources = []
        self.sources = self.sources + [{
            "source": source,
            "ts": datetime.now(timezone.utc).isoformat(),
            "confidence": confidence,
        }]

    def log_transition(self, new_state: str, reason: str) -> None:
        """Append a state-change record to the timeline."""
        if self.timeline is None:
            self.timeline = []
        self.timeline = self.timeline + [{
            "ts": datetime.now(timezone.utc).isoformat(),
            "state": new_state,
            "reason": reason,
        }]

    @property
    def unique_sources(self) -> set[str]:
        return {s["source"] for s in (self.sources or [])}
