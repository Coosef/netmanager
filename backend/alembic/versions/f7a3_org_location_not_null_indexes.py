"""faz7 M3 — NOT NULL + indexes for organization_id / location_id

Multi-tenant isolation rework, migration 3 of 6. Locks in the scoping
columns now that M2 has backfilled them and the before_insert hook
(app/models/_scoping.py) stamps every new row.

- organization_id → NOT NULL on every scoped table EXCEPT audit_logs and
  api_tokens — a failed-login audit row or a super-admin's token
  legitimately has no organization (same rationale as users /
  invite_tokens).
- location_id → NOT NULL on devices, agents, and the device-bound child
  tables whose device_id is itself NOT NULL (so a location is always
  derivable). Child tables with a nullable device_id keep location_id
  nullable.
- Single-column indexes ix_<table>_organization_id (every scoped table)
  and ix_<table>_location_id (device-bound tables), created CONCURRENTLY
  so the migration never holds a long write lock. These match the
  index=True declarations on the model columns and back the RLS predicate.
- locations: the old global UNIQUE on name is replaced by UNIQUE
  (organization_id, name) — the same location name may now exist in
  different organizations.

Revision ID: f7a3notnull
Revises: f7a2backfill
Create Date: 2026-05-18
"""
from alembic import op

revision = "f7a3notnull"
down_revision = "f7a2backfill"
branch_labels = None
depends_on = None


# Every scoped table — gets an organization_id index (RLS predicate).
_ORG_INDEXED = [
    "api_tokens", "locations", "device_groups", "config_templates",
    "credential_profiles", "playbooks", "playbook_runs", "tasks",
    "change_rollouts", "agent_credential_bundles", "maintenance_windows",
    "services", "rotation_policies", "racks", "rack_items",
    "topology_snapshots", "escalation_rules", "escalation_notification_logs",
    "notification_channels", "notification_logs", "discovery_results",
    "ipam_subnets", "audit_logs", "backup_schedules", "driver_templates",
    "sla_policies", "ai_settings", "agent_peer_latencies",
    "synthetic_probe_results", "syslog_events",
    "devices", "agents", "config_backups", "approval_requests",
    "security_audits", "agent_device_latencies", "alert_rules",
    "command_executions", "agent_command_logs", "ipam_addresses",
    "network_baselines", "asset_lifecycle", "synthetic_probes",
    "topology_links", "incidents", "mac_address_entries", "arp_entries",
    "network_events", "snmp_poll_results", "device_availability_snapshots",
]

# organization_id → NOT NULL — every scoped table except the two whose
# rows may legitimately have no org (platform / super-admin scope).
_ORG_NOT_NULL = [t for t in _ORG_INDEXED if t not in ("audit_logs", "api_tokens")]

# location_id → NOT NULL — entity tables + device-bound children whose
# device_id is NOT NULL (location always derivable).
_LOC_NOT_NULL = [
    "devices", "agents", "config_backups", "approval_requests",
    "command_executions", "network_baselines", "asset_lifecycle",
    "topology_links", "mac_address_entries", "arp_entries",
    "agent_device_latencies", "snmp_poll_results",
    "device_availability_snapshots",
]

# Every device-bound table has a location_id column → gets an index.
_LOC_INDEXED = [
    "devices", "agents", "config_backups", "approval_requests",
    "security_audits", "agent_device_latencies", "alert_rules",
    "command_executions", "agent_command_logs", "ipam_addresses",
    "network_baselines", "asset_lifecycle", "synthetic_probes",
    "topology_links", "incidents", "mac_address_entries", "arp_entries",
    "network_events", "snmp_poll_results", "device_availability_snapshots",
]

# Device-bound child tables — org + location derivable from the device.
_DEVICE_BOUND_CHILDREN = [
    "config_backups", "approval_requests", "security_audits",
    "agent_device_latencies", "alert_rules", "command_executions",
    "agent_command_logs", "ipam_addresses", "network_baselines",
    "asset_lifecycle", "synthetic_probes", "topology_links", "incidents",
    "mac_address_entries", "arp_entries", "network_events",
    "snmp_poll_results", "device_availability_snapshots",
]

_DEFAULT_ORG = "(SELECT id FROM organizations ORDER BY id LIMIT 1)"

# TimescaleDB hypertables — CREATE INDEX CONCURRENTLY is unsupported on
# them; a plain CREATE INDEX is used instead (TimescaleDB indexes each
# chunk with per-chunk locking).
_HYPERTABLES = {
    "snmp_poll_results", "device_availability_snapshots",
    "agent_peer_latencies", "synthetic_probe_results", "syslog_events",
}


def _create_index(name: str, table: str, column: str) -> None:
    concurrently = "" if table in _HYPERTABLES else "CONCURRENTLY "
    op.execute(
        f"CREATE INDEX {concurrently}IF NOT EXISTS {name} ON {table} ({column})"
    )


def _drop_index(name: str, table: str) -> None:
    concurrently = "" if table in _HYPERTABLES else "CONCURRENTLY "
    op.execute(f"DROP INDEX {concurrently}IF EXISTS {name}")


def upgrade() -> None:
    # ── 0. Catch-up backfill ──────────────────────────────────────────────
    # M2 backfilled everything, but any row inserted between M2 and M3 by
    # an app process that predates the org-stamping hook may still be
    # NULL. Re-derive idempotently so the NOT NULL alters below cannot
    # fail. (Self-healing — also makes M3 safe to re-run.)
    #
    # Order matters: devices/agents must be fully scoped FIRST, then the
    # device-bound children derive org+location from them, then a
    # default-org fallback sweeps anything left.
    op.execute(
        "SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0"
    )
    # 0a. devices + agents — org, then Unassigned location.
    for tbl in ("devices", "agents"):
        op.execute(
            f"UPDATE {tbl} SET organization_id = {_DEFAULT_ORG} "
            f"WHERE organization_id IS NULL"
        )
    for tbl in ("devices", "agents"):
        op.execute(
            f"UPDATE {tbl} t SET location_id = l.id "
            f"FROM locations l, organizations o "
            f"WHERE o.id = t.organization_id "
            f"  AND l.organization_id = t.organization_id "
            f"  AND l.name = 'Unassigned — ' || o.slug "
            f"  AND t.location_id IS NULL"
        )
    # 0b. device-bound children inherit org + location from the device.
    for tbl in _DEVICE_BOUND_CHILDREN:
        op.execute(
            f"UPDATE {tbl} c "
            f"SET organization_id = d.organization_id, location_id = d.location_id "
            f"FROM devices d "
            f"WHERE c.device_id = d.id "
            f"  AND (c.organization_id IS NULL OR c.location_id IS NULL)"
        )
    # 0c. agent-derived org-only tables.
    op.execute(
        "UPDATE agent_peer_latencies a SET organization_id = ag.organization_id "
        "FROM agents ag WHERE a.agent_to = ag.id AND a.organization_id IS NULL"
    )
    op.execute(
        "UPDATE syslog_events s SET organization_id = ag.organization_id "
        "FROM agents ag WHERE s.agent_id = ag.id AND s.organization_id IS NULL"
    )
    # 0d. default-org fallback for anything still NULL.
    for tbl in _ORG_NOT_NULL:
        op.execute(
            f"UPDATE {tbl} SET organization_id = {_DEFAULT_ORG} "
            f"WHERE organization_id IS NULL"
        )
    # 0e. location fallback → org's Unassigned, for any location-NOT-NULL
    #     table still lacking one (e.g. a child whose device_id is an
    #     orphan — no FK constraint, the device was deleted).
    for tbl in _LOC_NOT_NULL:
        op.execute(
            f"UPDATE {tbl} t SET location_id = l.id "
            f"FROM locations l, organizations o "
            f"WHERE o.id = t.organization_id "
            f"  AND l.organization_id = t.organization_id "
            f"  AND l.name = 'Unassigned — ' || o.slug "
            f"  AND t.location_id IS NULL"
        )

    # ── 1. organization_id → NOT NULL ─────────────────────────────────────
    for tbl in _ORG_NOT_NULL:
        op.alter_column(tbl, "organization_id", nullable=False)

    # ── 2. location_id → NOT NULL (where always derivable) ────────────────
    for tbl in _LOC_NOT_NULL:
        op.alter_column(tbl, "location_id", nullable=False)

    # ── 3. locations uniqueness: global name → (organization_id, name) ────
    # Idempotent — earlier migration steps commit before the CONCURRENTLY
    # index block, so M3 must be safe to re-run.
    op.execute("DROP INDEX IF EXISTS ix_locations_name")
    op.execute("CREATE INDEX IF NOT EXISTS ix_locations_name ON locations (name)")
    op.execute("ALTER TABLE locations DROP CONSTRAINT IF EXISTS uq_locations_org_name")
    op.execute(
        "ALTER TABLE locations "
        "ADD CONSTRAINT uq_locations_org_name UNIQUE (organization_id, name)"
    )

    # ── 4. Indexes — CONCURRENTLY on regular tables, plain on hypertables ─
    with op.get_context().autocommit_block():
        for tbl in _ORG_INDEXED:
            _create_index(f"ix_{tbl}_organization_id", tbl, "organization_id")
        for tbl in _LOC_INDEXED:
            _create_index(f"ix_{tbl}_location_id", tbl, "location_id")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for tbl in _LOC_INDEXED:
            _drop_index(f"ix_{tbl}_location_id", tbl)
        for tbl in _ORG_INDEXED:
            _drop_index(f"ix_{tbl}_organization_id", tbl)

    op.drop_constraint("uq_locations_org_name", "locations", type_="unique")
    op.execute("DROP INDEX IF EXISTS ix_locations_name")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_locations_name ON locations (name)"
    )

    for tbl in _LOC_NOT_NULL:
        op.alter_column(tbl, "location_id", nullable=True)
    for tbl in _ORG_NOT_NULL:
        op.alter_column(tbl, "organization_id", nullable=True)
