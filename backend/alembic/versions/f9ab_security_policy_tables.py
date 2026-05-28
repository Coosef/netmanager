"""T10 Faz C C1 — switch_security_policies + port_security_policies (schema).

docx (Sancak) → multi-tenant: her policy org'a ait (organization_id NOT NULL).
Eşik/severity alanları nullable (NULL = kontrol kapalı/sessiz). RLS + FK + seed
sonraki revision'larda (f9ac FK+grant, f9ad RLS+seed).

Revision ID: f9absecpol
Revises: f9aafirmware
Create Date: 2026-05-29
"""
import sqlalchemy as sa
from alembic import op

revision = "f9absecpol"
down_revision = "f9aafirmware"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "switch_security_policies",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        # health thresholds
        sa.Column("cpu_warning", sa.Integer()), sa.Column("cpu_critical", sa.Integer()),
        sa.Column("memory_warning", sa.Integer()), sa.Column("memory_critical", sa.Integer()),
        sa.Column("temp_warning", sa.Integer()), sa.Column("temp_critical", sa.Integer()),
        # behavior windows
        sa.Column("alert_suppression_window_min", sa.Integer()),
        sa.Column("mac_flap_batch_suppress_threshold", sa.Integer()),
        sa.Column("offline_timeout_min", sa.Integer()),
        # snapshot
        sa.Column("snapshot_interval_min", sa.Integer()),
        sa.Column("snapshot_retention_days", sa.Integer()),
        # anomaly toggles
        sa.Column("cve_check_enabled", sa.Boolean()),
        sa.Column("topology_change_alert_enabled", sa.Boolean()),
        sa.Column("firmware_drift_alert_enabled", sa.Boolean()),
        sa.Column("speed_drift_alert_enabled", sa.Boolean()),
        # auth / login
        sa.Column("auth_failure_threshold", sa.Integer()),
        sa.Column("console_login_severity", sa.String(16)),
        sa.Column("ssh_login_severity", sa.String(16)),
        sa.Column("web_login_severity", sa.String(16)),
        sa.Column("telnet_login_severity", sa.String(16)),
        sa.Column("allowed_management_source_ips", sa.Text()),
        sa.Column("business_hours_window", sa.String(32)),
        # L2 trap severities (v2 consumes)
        sa.Column("bpdu_guard_severity", sa.String(16)),
        sa.Column("loop_detected_severity", sa.String(16)),
        sa.Column("dhcp_snooping_severity", sa.String(16)),
        sa.Column("arp_inspection_severity", sa.String(16)),
        sa.Column("port_security_severity", sa.String(16)),
        sa.Column("dot1x_severity", sa.String(16)),
        sa.Column("storm_control_severity", sa.String(16)),
        # PoE budget
        sa.Column("poe_budget_warning_pct", sa.Integer()),
        sa.Column("poe_budget_critical_pct", sa.Integer()),
        # operational hygiene
        sa.Column("hardware_drift_severity", sa.String(16)),
        sa.Column("firmware_downgrade_severity", sa.String(16)),
        sa.Column("inventory_drift_severity", sa.String(16)),
        sa.Column("silent_reboot_severity", sa.String(16)),
        sa.Column("ntp_drift_warning_sec", sa.Integer()),
        sa.Column("ntp_drift_critical_sec", sa.Integer()),
        sa.Column("config_backup_max_age_days", sa.Integer()),
        sa.Column("config_change_policy", sa.String(16)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_switch_sec_pol_org", "switch_security_policies", ["organization_id"])
    # Org başına tek default (partial unique).
    op.execute(
        "CREATE UNIQUE INDEX uq_switch_sec_pol_one_default "
        "ON switch_security_policies (organization_id) WHERE is_default"
    )

    op.create_table(
        "port_security_policies",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        # MAC count
        sa.Column("mac_flood_warning", sa.Integer()),
        sa.Column("mac_flood_critical", sa.Integer()),
        # MAC flap
        sa.Column("mac_flap_window_min", sa.Integer()),
        sa.Column("mac_flap_min_transitions", sa.Integer()),
        sa.Column("mac_flap_min_quiet_min", sa.Integer()),
        sa.Column("auto_quarantine_on_nth_flap", sa.Integer()),
        # VLAN
        sa.Column("vlan_change_alert_enabled", sa.Boolean()),
        sa.Column("allowed_vlans", sa.Text()),
        # MAC change / link-up
        sa.Column("new_mac_alert_enabled", sa.Boolean()),
        sa.Column("link_up_alert_enabled", sa.Boolean()),
        # bandwidth
        sa.Column("bandwidth_alert_pct", sa.Integer()),
        # counter rates (PPM)
        sa.Column("if_error_rate_ppm_warning", sa.Integer()),
        sa.Column("if_error_rate_ppm_critical", sa.Integer()),
        sa.Column("if_discard_rate_ppm_warning", sa.Integer()),
        sa.Column("if_discard_rate_ppm_critical", sa.Integer()),
        # optic DOM (v2 consumes)
        sa.Column("optic_rx_warning_dbm", sa.Float()),
        sa.Column("optic_rx_critical_dbm", sa.Float()),
        sa.Column("optic_temp_warning_c", sa.Integer()),
        sa.Column("optic_temp_critical_c", sa.Integer()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_index("ix_port_sec_pol_org", "port_security_policies", ["organization_id"])
    op.execute(
        "CREATE UNIQUE INDEX uq_port_sec_pol_one_default "
        "ON port_security_policies (organization_id) WHERE is_default"
    )


def downgrade() -> None:
    op.drop_table("port_security_policies")
    op.drop_table("switch_security_policies")
