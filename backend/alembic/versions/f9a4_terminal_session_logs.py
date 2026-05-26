"""terminal_session_logs — interaktif SSH session audit (T9 Tur 3A)

Revision ID: f9a4termses
Revises: f9a3pwpolicy
Create Date: 2026-05-26

T9 Tur 3A — Browser SSH terminal session'larının audit log'u. Her
session başlangıçta insert, kapanışta update. Keystroke-level yerine
**komut bazlı** + byte counts + output excerpt (perf-safe MVP).

Sonraki increment (3B): ai_summary alanına Claude API ile özetle.
Bu turda alanı NULL olarak tut + status='pending' init.

Faz 7 RLS: org-scoped (kullanıcı kendi org'undakini görür; super-admin
hepsini görür).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f9a4termses"
down_revision = "f9a3pwpolicy"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "terminal_session_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("session_id", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("device_id", sa.Integer(),
                  sa.ForeignKey("devices.id", ondelete="SET NULL"), nullable=True, index=True),
        sa.Column("agent_id", sa.String(64), nullable=True, index=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("location_id", sa.Integer(),
                  sa.ForeignKey("locations.id", ondelete="SET NULL"),
                  nullable=True, index=True),

        sa.Column("client_ip", sa.String(64), nullable=True),
        sa.Column("user_agent", sa.String(512), nullable=True),
        # Geliş yolu: 'agent_relay' | 'direct_paramiko'
        sa.Column("connection_path", sa.String(32), nullable=True),

        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        # 'user_closed' | 'idle_timeout' | 'agent_disconnected' | 'paramiko_error' | 'ws_error'
        sa.Column("exit_reason", sa.String(32), nullable=True),

        sa.Column("input_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_bytes", sa.Integer(), nullable=False, server_default="0"),
        # Çıkartılan komutlar: [{"t": ts_ms, "cmd": "show vlan brief"}]
        sa.Column("commands_extracted", postgresql.JSONB(astext_type=sa.Text()),
                  nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("commands_count", sa.Integer(), nullable=False, server_default="0"),
        # Output'un son ~10KB'i (truncated) — incident response için hızlı bakış
        sa.Column("output_excerpt", sa.Text(), nullable=True),

        # T9 Tur 3B placeholder — AI özet
        sa.Column("ai_summary", sa.Text(), nullable=True),
        # 'pending' | 'completed' | 'failed' | NULL (disabled / not requested)
        sa.Column("ai_summary_status", sa.String(16), nullable=True),
    )
    op.create_index("ix_term_ses_org_started", "terminal_session_logs",
                    ["organization_id", "started_at"])

    # RLS — org-scoped. Faz 7 pattern.
    op.execute("ALTER TABLE terminal_session_logs ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE terminal_session_logs FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY term_ses_isolation ON terminal_session_logs
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
    op.execute("DROP POLICY IF EXISTS term_ses_isolation ON terminal_session_logs")
    op.drop_index("ix_term_ses_org_started", table_name="terminal_session_logs")
    op.drop_table("terminal_session_logs")
