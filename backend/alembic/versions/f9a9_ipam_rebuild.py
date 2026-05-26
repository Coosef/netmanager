"""T9 Tur 7 — IPAM rebuild (sıfırdan).

Drops the old ipam_subnets / ipam_addresses tables (operator confirmed
data loss) and rebuilds with an enterprise hierarchical schema:

  ipam_zones        — top-level containers (site, environment, RIR block,
                      VPC). Self-FK for nested zones.
  ipam_subnets      — CIDR ranges within a zone. Native PostgreSQL CIDR
                      type. Self-FK for parent/child subnet hierarchy
                      (e.g. 10.0.0.0/8 → 10.10.0.0/16 → 10.10.5.0/24).
                      Carries vlan_id, gateway, dhcp metadata, dns_servers
                      (JSONB), utilization warn threshold.
  ipam_assignments  — per-IP allocation. INET type. Type enum
                      (static/dhcp/reserved/gateway/broadcast/network/dynamic).
                      Source tag (manual/lldp/arp/dhcp-lease) — so the
                      ARP/MAC sync task can upsert without clobbering
                      manual entries.

All three RLS-scoped to organization_id with FORCE ROW LEVEL SECURITY.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import CIDR, INET, JSONB


revision = "f9a9ipamrebld"
down_revision = "f9a8poesnap"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1. Drop legacy IPAM tables ────────────────────────────────────────
    op.execute("DROP TABLE IF EXISTS ipam_addresses CASCADE")
    op.execute("DROP TABLE IF EXISTS ipam_subnets CASCADE")

    # ── 2. ipam_zones — top-level containers ─────────────────────────────
    op.create_table(
        "ipam_zones",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("zone_type", sa.String(32), nullable=False, server_default="site"),
        # site | environment | vpc | rir_block | custom
        sa.Column("parent_zone_id", sa.Integer(),
                  sa.ForeignKey("ipam_zones.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("location_id", sa.Integer(),
                  sa.ForeignKey("locations.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("created_by", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("organization_id", "name", name="uq_ipam_zone_org_name"),
    )
    op.create_index("ix_ipam_zones_org", "ipam_zones", ["organization_id"])
    op.create_index("ix_ipam_zones_parent", "ipam_zones", ["parent_zone_id"])

    # ── 3. ipam_subnets — CIDR ranges ────────────────────────────────────
    op.create_table(
        "ipam_subnets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("zone_id", sa.Integer(),
                  sa.ForeignKey("ipam_zones.id", ondelete="RESTRICT"),
                  nullable=False),
        sa.Column("cidr", CIDR(), nullable=False),
        sa.Column("name", sa.String(128), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("vlan_id", sa.Integer(), nullable=True),
        sa.Column("gateway", INET(), nullable=True),
        sa.Column("dhcp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("dhcp_server", INET(), nullable=True),
        sa.Column("dhcp_range_start", INET(), nullable=True),
        sa.Column("dhcp_range_end", INET(), nullable=True),
        sa.Column("dns_servers", JSONB(), nullable=True),  # list[str]
        sa.Column("parent_subnet_id", sa.Integer(),
                  sa.ForeignKey("ipam_subnets.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("utilization_warn_pct", sa.Integer(), nullable=False,
                  server_default="80"),
        sa.Column("site_hint", sa.String(64), nullable=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("location_id", sa.Integer(),
                  sa.ForeignKey("locations.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("created_by", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("organization_id", "cidr", name="uq_ipam_subnet_org_cidr"),
        sa.CheckConstraint("utilization_warn_pct BETWEEN 1 AND 100",
                           name="ck_ipam_subnet_util_pct"),
        sa.CheckConstraint("vlan_id IS NULL OR vlan_id BETWEEN 1 AND 4094",
                           name="ck_ipam_subnet_vlan_range"),
    )
    op.create_index("ix_ipam_subnets_zone", "ipam_subnets", ["zone_id"])
    op.create_index("ix_ipam_subnets_org", "ipam_subnets", ["organization_id"])
    op.create_index("ix_ipam_subnets_parent", "ipam_subnets", ["parent_subnet_id"])
    # GIST for CIDR contains queries (>>, <<, &&) — the killer feature for
    # "is this IP within any subnet?"
    op.execute("CREATE INDEX ix_ipam_subnets_cidr_gist ON ipam_subnets USING gist (cidr inet_ops)")

    # ── 4. ipam_assignments — per-IP allocation ───────────────────────────
    op.create_table(
        "ipam_assignments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("subnet_id", sa.Integer(),
                  sa.ForeignKey("ipam_subnets.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("ip_address", INET(), nullable=False),
        sa.Column("hostname", sa.String(255), nullable=True),
        sa.Column("mac_address", sa.String(32), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("type", sa.String(16), nullable=False, server_default="static"),
        # static | dhcp | reserved | gateway | broadcast | network | dynamic
        sa.Column("source", sa.String(16), nullable=False, server_default="manual"),
        # manual | lldp | arp | dhcp-lease | discovery
        sa.Column("device_id", sa.Integer(),
                  sa.ForeignKey("devices.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("interface", sa.String(64), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("organization_id", sa.Integer(),
                  sa.ForeignKey("organizations.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("location_id", sa.Integer(),
                  sa.ForeignKey("locations.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("created_by", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="SET NULL"),
                  nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("subnet_id", "ip_address", name="uq_ipam_assign_subnet_ip"),
        sa.CheckConstraint(
            "type IN ('static','dhcp','reserved','gateway','broadcast','network','dynamic')",
            name="ck_ipam_assign_type",
        ),
        sa.CheckConstraint(
            "source IN ('manual','lldp','arp','dhcp-lease','discovery')",
            name="ck_ipam_assign_source",
        ),
    )
    op.create_index("ix_ipam_assign_subnet", "ipam_assignments", ["subnet_id"])
    op.create_index("ix_ipam_assign_org", "ipam_assignments", ["organization_id"])
    op.create_index("ix_ipam_assign_ip", "ipam_assignments", ["ip_address"])
    op.create_index("ix_ipam_assign_mac", "ipam_assignments", ["mac_address"])
    op.create_index("ix_ipam_assign_device", "ipam_assignments", ["device_id"])

    # ── 5. Faz 7 RLS — enable + force + org policies ──────────────────────
    for table in ("ipam_zones", "ipam_subnets", "ipam_assignments"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"""
            CREATE POLICY {table}_org_isolation ON {table}
            USING (
                current_setting('app.is_super_admin', true) = 'on'
                OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
            )
            WITH CHECK (
                current_setting('app.is_super_admin', true) = 'on'
                OR organization_id = NULLIF(current_setting('app.current_org_id', true), '')::int
            )
        """)


def downgrade() -> None:
    for table in ("ipam_assignments", "ipam_subnets", "ipam_zones"):
        op.execute(f"DROP POLICY IF EXISTS {table}_org_isolation ON {table}")
    op.drop_index("ix_ipam_assign_device", table_name="ipam_assignments")
    op.drop_index("ix_ipam_assign_mac", table_name="ipam_assignments")
    op.drop_index("ix_ipam_assign_ip", table_name="ipam_assignments")
    op.drop_index("ix_ipam_assign_org", table_name="ipam_assignments")
    op.drop_index("ix_ipam_assign_subnet", table_name="ipam_assignments")
    op.drop_table("ipam_assignments")

    op.execute("DROP INDEX IF EXISTS ix_ipam_subnets_cidr_gist")
    op.drop_index("ix_ipam_subnets_parent", table_name="ipam_subnets")
    op.drop_index("ix_ipam_subnets_org", table_name="ipam_subnets")
    op.drop_index("ix_ipam_subnets_zone", table_name="ipam_subnets")
    op.drop_table("ipam_subnets")

    op.drop_index("ix_ipam_zones_parent", table_name="ipam_zones")
    op.drop_index("ix_ipam_zones_org", table_name="ipam_zones")
    op.drop_table("ipam_zones")

    # NB: we do not restore the old ipam_subnets / ipam_addresses tables —
    # the upgrade explicitly drops them. Roll forward instead of back.
