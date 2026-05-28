"""T10 Faz C C1 — security policy RLS (ENABLE+FORCE+policy) + org bazlı preset seed.

RLS: Faz 7 deseni (org_isolation USING+WITH CHECK). Seed: her org için 3 switch
(Default/CCTV-IoT/Backbone) + 7 port (default/uplink/pc/printer/kamera/ap/pos) preset.
Her org'da bir switch + bir port `is_default=true`. Migration superuser ile koşar
(env.py app.is_super_admin GUC) → RLS bypass, insert org_id explicit.

NOT: pos preset'inde auto_quarantine_on_nth_flap=3 — gerçek shutdown C5 global
kill-switch'iyle KAPALI (v1 dry-run); değer yalnız öneri eşiği.

Revision ID: f9adsecrls
Revises: f9acdevsecfk
Create Date: 2026-05-29
"""
from alembic import op
from sqlalchemy import text

revision = "f9adsecrls"
down_revision = "f9acdevsecfk"
branch_labels = None
depends_on = None


def _rls(table: str, policy: str) -> None:
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    op.execute(f"""
        CREATE POLICY {policy} ON {table}
        USING (
            current_setting('app.is_super_admin', true) = 'on'
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        )
        WITH CHECK (
            current_setting('app.is_super_admin', true) = 'on'
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        )
    """)


# Preset tanımları (yalnız non-NULL alanlar; gerisi NULL = kontrol kapalı).
_SWITCH_PRESETS = [
    dict(name="Default", is_default=True, description="Genel access switch baseline",
         cpu_warning=70, cpu_critical=85, memory_warning=80, memory_critical=90,
         temp_warning=55, temp_critical=70, cve_check_enabled=True,
         snapshot_interval_min=60, snapshot_retention_days=30, offline_timeout_min=5,
         ssh_login_severity="info", telnet_login_severity="critical",
         console_login_severity="warning", web_login_severity="warning",
         business_hours_window="09-18",
         bpdu_guard_severity="critical", loop_detected_severity="critical",
         dhcp_snooping_severity="critical", arp_inspection_severity="critical",
         port_security_severity="warning", dot1x_severity="warning",
         storm_control_severity="warning",
         poe_budget_warning_pct=80, poe_budget_critical_pct=95,
         config_change_policy="info"),
    dict(name="CCTV-IoT", is_default=False, description="Kapalı sistem appliance (kamera/IoT)",
         cpu_warning=80, cpu_critical=95, memory_warning=85, memory_critical=95,
         temp_warning=60, temp_critical=75, cve_check_enabled=False,
         snapshot_interval_min=360, snapshot_retention_days=30, offline_timeout_min=15,
         ssh_login_severity="info", telnet_login_severity="critical",
         bpdu_guard_severity="critical", loop_detected_severity="critical",
         config_change_policy="auto_ack"),
    dict(name="Backbone", is_default=False, description="Çekirdek/dağıtım (uplink yoğun)",
         cpu_warning=60, cpu_critical=75, memory_warning=75, memory_critical=85,
         temp_warning=50, temp_critical=65,
         snapshot_interval_min=15, snapshot_retention_days=60, offline_timeout_min=2,
         firmware_drift_alert_enabled=True, speed_drift_alert_enabled=True,
         allowed_management_source_ips="10.0.0.0/8",
         ssh_login_severity="info", telnet_login_severity="critical",
         bpdu_guard_severity="critical", loop_detected_severity="critical",
         dhcp_snooping_severity="critical", arp_inspection_severity="critical",
         poe_budget_warning_pct=70, poe_budget_critical_pct=90,
         ntp_drift_warning_sec=60, ntp_drift_critical_sec=300,
         config_change_policy="require_ack"),
]

_PORT_PRESETS = [
    dict(name="default", is_default=True, description="Oda TV / genel amaçlı",
         mac_flood_warning=5, mac_flood_critical=10, vlan_change_alert_enabled=True,
         new_mac_alert_enabled=True, bandwidth_alert_pct=90),
    dict(name="uplink", is_default=False, description="Uplink/cascade",
         bandwidth_alert_pct=95, new_mac_alert_enabled=False,
         optic_rx_warning_dbm=-22, optic_rx_critical_dbm=-28,
         optic_temp_warning_c=70, optic_temp_critical_c=80),
    dict(name="pc", is_default=False, description="Kurum içi PC (tek kullanıcı)",
         mac_flood_warning=2, mac_flood_critical=5, new_mac_alert_enabled=True,
         vlan_change_alert_enabled=True),
    dict(name="printer", is_default=False, description="Yazıcı (MAC sabit)",
         mac_flood_warning=1, mac_flood_critical=2, link_up_alert_enabled=True,
         new_mac_alert_enabled=True),
    dict(name="kamera", is_default=False, description="IP kamera (MAC sabit)",
         mac_flood_warning=1, mac_flood_critical=2, link_up_alert_enabled=True,
         new_mac_alert_enabled=True),
    dict(name="ap", is_default=False, description="Wi-Fi AP (yüzlerce client)",
         mac_flood_warning=50, mac_flood_critical=200, bandwidth_alert_pct=80,
         new_mac_alert_enabled=False),
    dict(name="pos", is_default=False, description="POS/kasa (en sıkı; auto-quar v1 dry-run)",
         mac_flood_warning=1, mac_flood_critical=2, link_up_alert_enabled=True,
         new_mac_alert_enabled=True, mac_flap_window_min=5, mac_flap_min_transitions=3,
         auto_quarantine_on_nth_flap=3),
]


def _seed(conn, table: str, org_id: int, presets: list) -> None:
    for p in presets:
        cols = ["organization_id"] + list(p.keys())
        vals = {"organization_id": org_id, **p}
        placeholders = ", ".join(f":{c}" for c in cols)
        conn.execute(
            text(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders})"),
            vals,
        )


def upgrade() -> None:
    _rls("switch_security_policies", "switch_sec_pol_org_isolation")
    _rls("port_security_policies", "port_sec_pol_org_isolation")

    conn = op.get_bind()
    org_ids = [r[0] for r in conn.execute(text(
        "SELECT id FROM organizations WHERE deleted_at IS NULL"
    )).fetchall()]
    for oid in org_ids:
        _seed(conn, "switch_security_policies", oid, _SWITCH_PRESETS)
        _seed(conn, "port_security_policies", oid, _PORT_PRESETS)


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS port_sec_pol_org_isolation ON port_security_policies")
    op.execute("DROP POLICY IF EXISTS switch_sec_pol_org_isolation ON switch_security_policies")
    op.execute("ALTER TABLE port_security_policies NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE port_security_policies DISABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE switch_security_policies NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE switch_security_policies DISABLE ROW LEVEL SECURITY")
    # Seed satırları tablo drop'unda (f9ab downgrade) gider; burada RLS'i geri al.