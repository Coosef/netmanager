"""T10 Faz C C1 — devices'e security policy FK'leri + netmgr_app grant.

Kalıcı interfaces tablosu olmadığı için port policy cihaz-geneli bağlanır:
  devices.security_policy_id      → switch policy
  devices.port_security_policy_id → cihaz-geneli varsayılan port policy (v1).
Per-port override v2 (ayrı tablo / canonical interface modeli).

Revision ID: f9acdevsecfk
Revises: f9absecpol
Create Date: 2026-05-29
"""
import sqlalchemy as sa
from alembic import op

revision = "f9acdevsecfk"
down_revision = "f9absecpol"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("devices", sa.Column(
        "security_policy_id", sa.Integer(),
        sa.ForeignKey("switch_security_policies.id", ondelete="SET NULL"), nullable=True,
    ))
    op.add_column("devices", sa.Column(
        "port_security_policy_id", sa.Integer(),
        sa.ForeignKey("port_security_policies.id", ondelete="SET NULL"), nullable=True,
    ))
    op.create_index("ix_devices_security_policy_id", "devices", ["security_policy_id"])
    op.create_index("ix_devices_port_security_policy_id", "devices", ["port_security_policy_id"])

    # netmgr_app grant — f7a5 ALTER DEFAULT PRIVILEGES yeni public tabloları kapsar,
    # ama idempotent + explicit güvence (rol yoksa sessiz geç).
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'netmgr_app') THEN
            GRANT SELECT, INSERT, UPDATE, DELETE ON switch_security_policies TO netmgr_app;
            GRANT SELECT, INSERT, UPDATE, DELETE ON port_security_policies TO netmgr_app;
            GRANT USAGE, SELECT ON SEQUENCE switch_security_policies_id_seq TO netmgr_app;
            GRANT USAGE, SELECT ON SEQUENCE port_security_policies_id_seq TO netmgr_app;
          END IF;
        END $$;
    """)


def downgrade() -> None:
    op.drop_index("ix_devices_port_security_policy_id", "devices")
    op.drop_index("ix_devices_security_policy_id", "devices")
    op.drop_column("devices", "port_security_policy_id")
    op.drop_column("devices", "security_policy_id")
