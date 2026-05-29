"""T10 C7.A — port_policy_assignments tablosu (per-port policy override).

C6b'de cihaz-geneli `devices.port_security_policy_id` tek bir default veriyordu;
port-bazlı override yoktu. C7'de kalıcı interfaces tablosu açmadan port başına
override eklenebilmesi için bu dar tablo geliyor (v2.1'de canonical device_ports
değerlendirilecek — bkz. docs/T10_C7_PLAN.md).

Resolver zinciri (security_policy_service.resolve_port_policy) buna göre güncellenir:
  1) port_policy_assignments (device_id+port_name)   ← YENİ ADIM
  2) devices.port_security_policy_id                 (cihaz-default — C6b)
  3) organizations is_default=true port policy        (org default — C2)
  4) hardcoded fallback                                (en güvenli baseline — C2)

port_name v1'de exact-match + raw string (vendor format'ı aynen tutulur — Cisco
`GigabitEthernet1/0/1`, Aruba `1/1/1`, vb). Vendor-alias normalization açık risk.

RLS: Faz 7 deseni (org_isolation USING+WITH CHECK). FORCE.
Grant: netmgr_app SELECT/INSERT/UPDATE/DELETE (f7a5 default privileges otomatik
verir ama explicit ekliyoruz — idempotent).

Revision ID: f9aeportpol
Revises: f9adsecrls
"""
from alembic import op
import sqlalchemy as sa

revision = "f9aeportpol"
down_revision = "f9adsecrls"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "port_policy_assignments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("device_id", sa.Integer(),
                  sa.ForeignKey("devices.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("port_name", sa.Text(), nullable=False),
        sa.Column("port_security_policy_id", sa.Integer(),
                  sa.ForeignKey("port_security_policies.id", ondelete="RESTRICT"),
                  nullable=False),
        # RLS pin (Faz 7) — _scoping hook device_id'den otomatik damgalar ama
        # NOT NULL constraint cross-org leak'i şema seviyesinde de kapatır.
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("assigned_by", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("device_id", "port_name", name="uq_ppa_device_port"),
    )
    op.create_index("ix_ppa_device_id", "port_policy_assignments", ["device_id"])
    op.create_index("ix_ppa_organization_id", "port_policy_assignments", ["organization_id"])
    op.create_index("ix_ppa_policy_id", "port_policy_assignments", ["port_security_policy_id"])

    # RLS FORCE — f9ad'deki org_isolation deseninin aynısı.
    op.execute("ALTER TABLE port_policy_assignments ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE port_policy_assignments FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY ppa_org_isolation ON port_policy_assignments
        USING (
            current_setting('app.is_super_admin', true) = 'on'
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        )
        WITH CHECK (
            current_setting('app.is_super_admin', true) = 'on'
            OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
        )
    """)

    # netmgr_app grant (f7a5 default privileges zaten verir; idempotent explicit).
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON port_policy_assignments TO netmgr_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE port_policy_assignments_id_seq TO netmgr_app"
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS ppa_org_isolation ON port_policy_assignments")
    op.execute("ALTER TABLE port_policy_assignments DISABLE ROW LEVEL SECURITY")
    op.drop_index("ix_ppa_policy_id", table_name="port_policy_assignments")
    op.drop_index("ix_ppa_organization_id", table_name="port_policy_assignments")
    op.drop_index("ix_ppa_device_id", table_name="port_policy_assignments")
    op.drop_table("port_policy_assignments")
