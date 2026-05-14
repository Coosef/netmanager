"""faz5d_snmpv3_passphrase_text

Expand snmp_v3_auth_passphrase and snmp_v3_priv_passphrase columns from
VARCHAR(256) to TEXT in both devices and credential_profiles tables.
Fernet-encrypted values are ~120-180 chars; VARCHAR(256) is too tight.

Revision ID: d5e6f7a8b9c0
Revises: c3d4e5f6a7b8
Create Date: 2026-05-14 12:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "d5e6f7a8b9c0"
down_revision = "c3d4e5f6a7b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "devices", "snmp_v3_auth_passphrase",
        existing_type=sa.String(256), type_=sa.Text(), existing_nullable=True,
    )
    op.alter_column(
        "devices", "snmp_v3_priv_passphrase",
        existing_type=sa.String(256), type_=sa.Text(), existing_nullable=True,
    )
    op.alter_column(
        "credential_profiles", "snmp_v3_auth_passphrase",
        existing_type=sa.String(256), type_=sa.Text(), existing_nullable=True,
    )
    op.alter_column(
        "credential_profiles", "snmp_v3_priv_passphrase",
        existing_type=sa.String(256), type_=sa.Text(), existing_nullable=True,
    )


def downgrade() -> None:
    # WARNING: downgrade will truncate any encrypted values longer than 256 chars.
    op.alter_column(
        "devices", "snmp_v3_auth_passphrase",
        existing_type=sa.Text(), type_=sa.String(256), existing_nullable=True,
    )
    op.alter_column(
        "devices", "snmp_v3_priv_passphrase",
        existing_type=sa.Text(), type_=sa.String(256), existing_nullable=True,
    )
    op.alter_column(
        "credential_profiles", "snmp_v3_auth_passphrase",
        existing_type=sa.Text(), type_=sa.String(256), existing_nullable=True,
    )
    op.alter_column(
        "credential_profiles", "snmp_v3_priv_passphrase",
        existing_type=sa.Text(), type_=sa.String(256), existing_nullable=True,
    )
