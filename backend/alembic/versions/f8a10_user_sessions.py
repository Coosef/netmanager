"""user_sessions — active JWT-backed login sessions

Revision ID: f8a10sessions
Revises: f8a9vlansnap
Create Date: 2026-05-25

T8.4 — Super admin "Canlı Oturumlar" özelliği için. JWT'ye jti claim
eklendi; bu tabloya bakarak revoke kontrolü yapılır. RLS YOK — kullanıcı
oturumları cross-org bilgi (super admin tek görür, endpoint gate eder).
"""
from alembic import op
import sqlalchemy as sa


revision = "f8a10sessions"
down_revision = "f8a9vlansnap"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "user_sessions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("jti", sa.String(length=64), nullable=False, unique=True),
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ip", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=512), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.Column("last_activity", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("revoked_reason", sa.String(length=32), nullable=True),
    )
    op.create_index("ix_user_sessions_jti", "user_sessions", ["jti"])
    op.create_index("ix_user_sessions_user", "user_sessions", ["user_id"])
    op.create_index("ix_user_sessions_created", "user_sessions", ["created_at"])
    op.create_index("ix_user_sessions_last_activity", "user_sessions", ["last_activity"])
    op.create_index("ix_user_sessions_revoked", "user_sessions", ["revoked_at"])


def downgrade():
    op.drop_index("ix_user_sessions_revoked", table_name="user_sessions")
    op.drop_index("ix_user_sessions_last_activity", table_name="user_sessions")
    op.drop_index("ix_user_sessions_created", table_name="user_sessions")
    op.drop_index("ix_user_sessions_user", table_name="user_sessions")
    op.drop_index("ix_user_sessions_jti", table_name="user_sessions")
    op.drop_table("user_sessions")
