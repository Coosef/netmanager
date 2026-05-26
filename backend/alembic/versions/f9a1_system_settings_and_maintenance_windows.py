"""system_settings tablosu — T9 Tur 1 #1 (1A)

Revision ID: f9a1sysset
Revises: f8a9vlansnap
Create Date: 2026-05-26

T9 Tur 1 (1A kapsamı) — Org bazlı sistem ayarları:
  - Tarama frekansları (poll/snmp/mac_arp/baseline/anomaly/topology/probe)
  - Maintenance window aktifken polling relaxed factor

Çözünürlük (SystemSettingsService):
  1. organization_id = X kaydı → onu döndür
  2. organization_id IS NULL (global default) → onu döndür
  3. Kod-içi varsayılan (service'te tanımlı)

NOT: Tur 1B (sonraya, Tur 6 ile birlikte) maintenance_windows tablosuna
cyclic alanlar ekleyecek + dynamic Celery scheduler getirecek. Şu an
sadece system_settings tablosu + UI ile başlıyoruz; beat schedule
restart gerektirir (UI uyarı verir).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f9a1sysset"
down_revision = "f8a9vlansnap"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "system_settings",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "organization_id", sa.Integer(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=True,  # NULL → global default
            index=True,
        ),
        sa.Column("key", sa.String(128), nullable=False, index=True),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by_user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.UniqueConstraint("organization_id", "key",
                            name="uq_system_settings_org_key"),
    )

    # Faz 7 RLS — system_settings org-isolated.
    # SELECT: kendi org + global default'ları görür.
    # MODIFY: sadece kendi org satırlarına yazabilir; global default'a yalnız
    # super-admin yazabilir (is_super_admin GUC bypass'i ile).
    op.execute("ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE system_settings FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY system_settings_select ON system_settings
        FOR SELECT
        USING (
            current_setting('app.is_super_admin', true) = 'on'
            OR organization_id IS NULL
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        )
    """)
    op.execute("""
        CREATE POLICY system_settings_modify ON system_settings
        FOR ALL
        USING (
            current_setting('app.is_super_admin', true) = 'on'
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        )
        WITH CHECK (
            current_setting('app.is_super_admin', true) = 'on'
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        )
    """)

    # Global default scan settings — kodda mevcut Celery beat frekanslarıyla
    # aynı. Bir org override yapmadığı sürece bunlar geçerli kalır.
    op.execute("""
        INSERT INTO system_settings (organization_id, key, value, description) VALUES
        (NULL, 'scan.poll_device_status_sec', '300'::jsonb,
         'Cihaz erisilebilirlik (ping/SSH check) polling, saniye. Min: 60s'),
        (NULL, 'scan.poll_snmp_sec', '300'::jsonb,
         'SNMP arayuz sayaclari polling, saniye. Min: 60s (cihaz CPU yukselir)'),
        (NULL, 'scan.mac_arp_sec', '900'::jsonb,
         'MAC + ARP tablosu toplama, saniye. Min: 300s'),
        (NULL, 'scan.update_baselines_sec', '86400'::jsonb,
         'Davranis baseline guncelleme, saniye. Tipik: gunluk (86400s)'),
        (NULL, 'scan.detect_anomalies_sec', '1800'::jsonb,
         'Anomaly detection frekansi, saniye. Min: 600s'),
        (NULL, 'scan.topology_discovery_sec', '21600'::jsonb,
         'LLDP/CDP topology rescan. Tipik: 6 saat (21600s)'),
        (NULL, 'scan.synthetic_probe_sec', '60'::jsonb,
         'Synthetic probe (TCP/HTTP latency) frekansi'),
        (NULL, 'scan.relaxed_factor_in_maintenance', '0.5'::jsonb,
         'Maintenance window aktifken polling frekansi bu faktorle dusulur (1B sonra etkin)')
    """)


def downgrade():
    op.execute("DROP POLICY IF EXISTS system_settings_modify ON system_settings")
    op.execute("DROP POLICY IF EXISTS system_settings_select ON system_settings")
    op.drop_table("system_settings")
