"""T10 Faz C — Security Policy Engine modelleri (switch + port).

İki katmanlı politika: switch-level (cihaz sağlığı + L2 davranış) ve port-level
(MAC/VLAN/optic/counter). Bir cihaza `devices.security_policy_id`, bir arayüze
`interfaces.security_policy_id` ile atanır.

NULL semantiği (KRİTİK): eşik/severity alanlarının çoğu nullable. **NULL = "bu
kontrolü yapma, sessiz ol"**. Vendor heterojenliği (Ruijie/Cisco/Mikrotik) ve cihaz
çeşitliliği (CCTV/Office/Backbone) tek kod tabanından, sadece DB konfigüyle yönetilir.

Multi-tenant: her policy bir org'a ait (organization_id NOT NULL, Faz 7 RLS FORCE).
`is_default` org başına tek (partial unique index — f9ad migration). Cihaz/arayüzün
policy'si NULL ise resolver org'un is_default'unu, o da yoksa hardcoded fallback'i kullanır.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Integer, String, Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SwitchSecurityPolicy(Base):
    """Switch seviyesi güvenlik politikası (~30 alan). docx: network_switch_security_policies."""
    __tablename__ = "switch_security_policies"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # ── Sağlık eşikleri (SNMP poll) — NULL = kontrol kapalı ──────────────────
    cpu_warning: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    cpu_critical: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    memory_warning: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    memory_critical: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    temp_warning: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    temp_critical: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Davranış pencereleri ─────────────────────────────────────────────────
    alert_suppression_window_min: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    mac_flap_batch_suppress_threshold: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    offline_timeout_min: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Snapshot ─────────────────────────────────────────────────────────────
    snapshot_interval_min: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    snapshot_retention_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Anomaly toggle'ları (NULL = varsayılan/kapalı) ───────────────────────
    cve_check_enabled: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    topology_change_alert_enabled: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    firmware_drift_alert_enabled: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    speed_drift_alert_enabled: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)

    # ── Yetkisiz erişim / login ──────────────────────────────────────────────
    auth_failure_threshold: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    console_login_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    ssh_login_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    web_login_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    telnet_login_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    allowed_management_source_ips: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # CSV/CIDR
    business_hours_window: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)  # "09-18"

    # ── L2 güvenlik trap severity'leri (NULL = trap işleme) — v2'de tüketilir ─
    bpdu_guard_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    loop_detected_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    dhcp_snooping_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    arp_inspection_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    port_security_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    dot1x_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    storm_control_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)

    # ── PoE budget (NULL = kontrol kapalı) ───────────────────────────────────
    poe_budget_warning_pct: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    poe_budget_critical_pct: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Operasyonel hijyen ───────────────────────────────────────────────────
    hardware_drift_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    firmware_downgrade_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    inventory_drift_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    silent_reboot_severity: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    ntp_drift_warning_sec: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    ntp_drift_critical_sec: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    config_backup_max_age_days: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # info | require_ack | auto_ack
    config_change_policy: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class PortSecurityPolicy(Base):
    """Port seviyesi güvenlik politikası (~18 alan). docx: network_port_security_policies."""
    __tablename__ = "port_security_policies"

    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # ── MAC sayısı (NULL = sayma; uplink'te yüzlerce MAC normal) ─────────────
    mac_flood_warning: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    mac_flood_critical: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── MAC flap (oszilasyon) ────────────────────────────────────────────────
    mac_flap_window_min: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    mac_flap_min_transitions: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    mac_flap_min_quiet_min: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # NULL = otomatik karantina kapalı (v1 default-OFF; sadece dry-run öneri)
    auto_quarantine_on_nth_flap: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── VLAN ─────────────────────────────────────────────────────────────────
    vlan_change_alert_enabled: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    allowed_vlans: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # CSV whitelist

    # ── MAC değişikliği / link-up ────────────────────────────────────────────
    new_mac_alert_enabled: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)
    link_up_alert_enabled: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)

    # ── Bant genişliği ───────────────────────────────────────────────────────
    bandwidth_alert_pct: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Counter rate'leri (PPM = milyonda) ───────────────────────────────────
    if_error_rate_ppm_warning: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    if_error_rate_ppm_critical: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    if_discard_rate_ppm_warning: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    if_discard_rate_ppm_critical: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Optic DOM (sadece SFP) — v2'de tüketilir ─────────────────────────────
    optic_rx_warning_dbm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    optic_rx_critical_dbm: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    optic_temp_warning_c: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    optic_temp_critical_c: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
