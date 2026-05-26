"""password_policies + user password tracking — T9 Tur 2 #3

Revision ID: f9a3pwpolicy
Revises: f9a2userips
Create Date: 2026-05-26

T9 Tur 2 #3 — Org bazlı password policy + per-user şifre geçmişi/expiry.

Tablolar:
  password_policies  — org bazlı kural seti (org-direkt)
    Default policy: min_length=8, lowercase + digit zorunlu (gevşek baseline)

  users tablosuna:
    password_changed_at      — son şifre değişim tarihi (expiry check için)
    password_history (JSONB) — son N bcrypt hash (reuse engelleme için)
    must_change_password     — yeni hesap / reset sonrası zorla değiştir flag
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f9a3pwpolicy"
down_revision = "f9a2userips"
branch_labels = None
depends_on = None


def upgrade():
    # ── password_policies ─────────────────────────────────────────────────────
    op.create_table(
        "password_policies",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "organization_id", sa.Integer(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=True,  # NULL → global default
            unique=True, index=True,
        ),
        sa.Column("min_length", sa.Integer(), nullable=False, server_default="8"),
        sa.Column("require_uppercase", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("require_lowercase", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("require_digit", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("require_special", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("history_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("expiry_days", sa.Integer(), nullable=False, server_default="0"),  # 0 = expire yok
        sa.Column("force_change_on_first_login", sa.Boolean(),
                  nullable=False, server_default=sa.false()),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.func.now()),
        sa.Column("updated_by_user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )

    # Faz 7 RLS — password_policies. Org-isolated. Global default tüm orgleri görür.
    op.execute("ALTER TABLE password_policies ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE password_policies FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY pwpolicy_select ON password_policies
        FOR SELECT
        USING (
            current_setting('app.is_super_admin', true) = 'on'
            OR organization_id IS NULL
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        )
    """)
    op.execute("""
        CREATE POLICY pwpolicy_modify ON password_policies
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

    # Global default policy (gevşek baseline; org admin sıkılaştırabilir)
    op.execute("""
        INSERT INTO password_policies (
            organization_id, min_length,
            require_uppercase, require_lowercase, require_digit, require_special,
            history_count, expiry_days, force_change_on_first_login
        ) VALUES (
            NULL, 8,
            FALSE, TRUE, TRUE, FALSE,
            3, 0, FALSE
        )
    """)

    # ── users tablosu password tracking ───────────────────────────────────────
    op.add_column(
        "users",
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("password_history", postgresql.JSONB(astext_type=sa.Text()),
                  nullable=True),  # List[str] of bcrypt hashes
    )
    op.add_column(
        "users",
        sa.Column("must_change_password", sa.Boolean(),
                  nullable=False, server_default=sa.false()),
    )


def downgrade():
    op.drop_column("users", "must_change_password")
    op.drop_column("users", "password_history")
    op.drop_column("users", "password_changed_at")

    op.execute("DROP POLICY IF EXISTS pwpolicy_modify ON password_policies")
    op.execute("DROP POLICY IF EXISTS pwpolicy_select ON password_policies")
    op.drop_table("password_policies")
