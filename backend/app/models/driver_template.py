from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


# Template health status derived from metrics
HEALTH_HEALTHY_THRESHOLD = 0.80   # success_rate >= 80% → healthy
HEALTH_WARNING_THRESHOLD = 0.50   # success_rate 50-80% → warning
# below 50% → broken


class CommandType(str, Enum):
    SHOW_VERSION = "show_version"
    SHOW_INTERFACES = "show_interfaces"
    SHOW_VLAN = "show_vlan"
    SHOW_LLDP = "show_lldp"
    SHOW_CDP = "show_cdp"
    SHOW_MAC_TABLE = "show_mac_table"
    SHOW_ARP = "show_arp"
    SHOW_RUNNING_CONFIG = "show_running_config"
    SHOW_POWER_INLINE = "show_power_inline"
    SHOW_SWITCHPORT = "show_switchport"


class ParserType(str, Enum):
    REGEX = "regex"
    TEXTFSM = "textfsm"
    RAW = "raw"


class DriverTemplate(Base):
    __tablename__ = "driver_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Target: which OS / version does this apply to?
    os_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # Regex matched against device firmware string; NULL = matches any version
    os_version_pattern: Mapped[str | None] = mapped_column(String(256), nullable=True)

    command_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    command_string: Mapped[str] = mapped_column(String(512), nullable=False)

    parser_type: Mapped[str] = mapped_column(String(32), nullable=False, default="regex")
    # Regex pattern or TextFSM template body; NULL for raw
    parser_template: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Representative sample output used for testing / AI generation
    sample_output: Mapped[str | None] = mapped_column(Text, nullable=True)

    # False = AI-generated, awaiting user review
    is_verified: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Selection priority — higher wins when multiple templates match same scope
    priority: Mapped[int] = mapped_column(Integer, default=100, nullable=False)

    # Runtime health tracking — updated by TemplateResolver after each use
    success_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failure_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_failure_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    @property
    def success_rate(self) -> float | None:
        total = self.success_count + self.failure_count
        return self.success_count / total if total >= 5 else None

    @property
    def health_status(self) -> str:
        rate = self.success_rate
        if rate is None:
            return "unknown"
        if rate >= HEALTH_HEALTHY_THRESHOLD:
            return "healthy"
        if rate >= HEALTH_WARNING_THRESHOLD:
            return "warning"
        return "broken"
