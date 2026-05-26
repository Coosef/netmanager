"""port_change_rollbacks — port toggle/PoE 5dk safety rollback (T9 Tur 4 #8+E2)

Revision ID: f9a6portchg
Revises: f9a5lifecycle
Create Date: 2026-05-26

T9 Tur 4 E2 — Port toggle veya PoE komutu uygulandıktan sonra 5 dakika
içinde kullanıcı "onayla" basmazsa otomatik rollback (önceki duruma dön).

Akış:
  1) User "Port 3 shutdown" der → backend forward_cmds çalıştırır + DB'ye
     pending kayıt yazar (apply_at=now, rollback_at=now+5min, status='pending')
  2) Celery countdown task → 5dk sonra status hala 'pending' ise inverse_cmds
     çalıştır + status='rolled_back'
  3) User "Onayla" basarsa → endpoint status='committed' set eder + opsiyonel
     write_config (kalıcı kayıt)
  4) User "Geri Al" basarsa → hemen rollback + status='rolled_back'

audit_logs'a port_toggle_applied / port_toggle_rolled_back / port_toggle_committed
event'leri yazılır.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f9a6portchg"
down_revision = "f9a5lifecycle"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "port_change_rollbacks",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("device_id", sa.Integer(),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"),
                  nullable=True, index=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("location_id", sa.Integer(),
                  sa.ForeignKey("locations.id", ondelete="SET NULL"),
                  nullable=True),

        sa.Column("interface_name", sa.String(64), nullable=False),
        # 'admin' (shutdown/no shutdown) | 'poe' (power inline)
        sa.Column("change_type", sa.String(16), nullable=False),
        # 'up'/'down' for admin; 'on'/'off' for poe
        sa.Column("requested_state", sa.String(8), nullable=False),
        sa.Column("forward_cmds", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("rollback_cmds", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("forward_output", sa.Text(), nullable=True),
        sa.Column("rollback_output", sa.Text(), nullable=True),

        # 'pending' (5dk bekliyor) | 'committed' (onaylandı) | 'rolled_back'
        # | 'failed' (forward apply başarısız)
        sa.Column("status", sa.String(16),
                  nullable=False, server_default="pending"),
        sa.Column("apply_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.func.now()),
        sa.Column("rollback_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_pcr_status_rollback_at", "port_change_rollbacks",
                    ["status", "rollback_at"])

    op.execute("ALTER TABLE port_change_rollbacks ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE port_change_rollbacks FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY pcr_isolation ON port_change_rollbacks
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


def downgrade():
    op.execute("DROP POLICY IF EXISTS pcr_isolation ON port_change_rollbacks")
    op.drop_index("ix_pcr_status_rollback_at", table_name="port_change_rollbacks")
    op.drop_table("port_change_rollbacks")
