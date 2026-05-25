"""compliance_profiles — kullanıcı bazlı uyumluluk tarama setleri

Revision ID: f8a8compliance
Revises: f8a7mfauserfields
Create Date: 2026-05-25

T8.4 — parametrik uyumluluk denetimi:
  - Tek tablo, JSONB enabled_rule_ids ile built-in kuralları toggle eder.
  - organization_id FK + index (RLS scope için zaten policy + RLS ek
    migration'da değil; mevcut FORCE RLS politika seti otomatik kapsayacak
    şekilde policy'leri uygula).
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "f8a8compliance"
down_revision = "f8a7mfauserfields"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "compliance_profiles",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "enabled_rule_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "organization_id",
            sa.Integer(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_compliance_profiles_org", "compliance_profiles", ["organization_id"])

    # Faz 7 RLS — org isolation policy (mevcut tabloların pattern'i).
    op.execute("ALTER TABLE compliance_profiles ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE compliance_profiles FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY org_isolation ON compliance_profiles
            USING ( current_setting('app.is_super_admin', true) = 'on'
                 OR organization_id = current_setting('app.current_org_id', true)::int )
            WITH CHECK ( current_setting('app.is_super_admin', true) = 'on'
                 OR organization_id = current_setting('app.current_org_id', true)::int )
    """)


def downgrade():
    op.execute("DROP POLICY IF EXISTS org_isolation ON compliance_profiles")
    op.drop_index("ix_compliance_profiles_org", table_name="compliance_profiles")
    op.drop_table("compliance_profiles")
