"""devices.lifecycle_status — envanter durumu (T9 Tur 4 #7+#14)

Revision ID: f9a5lifecycle
Revises: f9a4termses
Create Date: 2026-05-26

T9 Tur 4 — Cihaz yaşam döngüsü durumu:
  - production  (aktif kullanımda, default)
  - passive     (geçici devre dışı ama envanterde)
  - stock       (depoda, henüz kullanılmamış)
  - archived    (devreden çıkmış; geri alma yalnız super_admin tarafından)

DeviceStatus (online/offline/unknown) real-time erişilebilirlik durumu —
buna karışmıyor. `lifecycle_status` operasyonel kullanıcı kararı.

Mevcut `is_active` boolean'ı bırakıyoruz (geriye dönük uyum). Yeni cihazlar
production'da başlar (is_active=True, lifecycle_status='production').

State değişiklikleri audit_logs'a yazılır (lifecycle_changed event).
"""
from alembic import op
import sqlalchemy as sa


revision = "f9a5lifecycle"
down_revision = "f9a4termses"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "devices",
        sa.Column("lifecycle_status", sa.String(16),
                  nullable=False, server_default="production"),
    )
    # state geçişleri için filter index
    op.create_index("ix_devices_lifecycle_status", "devices", ["lifecycle_status"])


def downgrade():
    op.drop_index("ix_devices_lifecycle_status", table_name="devices")
    op.drop_column("devices", "lifecycle_status")
