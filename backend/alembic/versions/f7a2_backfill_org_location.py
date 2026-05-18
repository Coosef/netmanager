"""faz7 M2 — backfill organization_id / location_id

Multi-tenant isolation rework, migration 2 of 6. Pure data migration:
populates the columns M1 added, so M3 can make them NOT NULL.

Strategy:
  1. Ensure an Organization exists per Tenant (idempotent — mirrors
     main.py::_ensure_default_org). Guarantee at least one org.
  2. Backfill organization_id on tenant-bearing tables via the
     tenant→organization slug join.
  3. Create one "Unassigned" location per organization.
  4. devices.location_id ← case-insensitive match of devices.site to a
     location name in the same org; unmatched devices → Unassigned.
  5. agents.location_id ← the most common location among the devices the
     agent manages; agents with none → Unassigned.
  6. Device-bound tables ← organization_id + location_id from the parent
     device.
  7. Default-org fallback for any row still lacking an organization_id
     (config tables with no tenant_id and no device link).
  8. Sanity assertions — fail the migration if any scoped table still
     has a NULL organization_id (users / invite_tokens excluded — a
     super-admin legitimately belongs to no org).

Revision ID: f7a2backfill
Revises: f7a1addorgloc
Create Date: 2026-05-18
"""
from alembic import op

revision = "f7a2backfill"
down_revision = "f7a1addorgloc"
branch_labels = None
depends_on = None


# Tables that already carry tenant_id — org is backfilled via tenant→org.
# (ipam_addresses has no tenant_id — it is device-bound, see _DEVICE_BOUND.)
_TENANT_TABLES = [
    "tasks", "playbooks", "alert_rules", "devices", "ipam_subnets",
    "locations", "config_backups", "agents",
    "approval_requests", "change_rollouts",
]

# Device-bound tables — organization_id + location_id come from the device.
_DEVICE_BOUND = [
    "config_backups", "approval_requests", "security_audits",
    "agent_device_latencies", "alert_rules", "command_executions",
    "agent_command_logs", "ipam_addresses", "network_baselines",
    "asset_lifecycle", "synthetic_probes", "topology_links", "incidents",
    "mac_address_entries", "arp_entries", "network_events",
    "snmp_poll_results", "device_availability_snapshots",
]

# Every scoped table (org-direct + device-bound) — must end NOT-NULL on
# organization_id. users / invite_tokens are intentionally absent.
_ALL_SCOPED = [
    # org-direct
    "api_tokens", "locations", "device_groups", "config_templates",
    "credential_profiles", "playbooks", "playbook_runs", "tasks",
    "change_rollouts", "agent_credential_bundles", "maintenance_windows",
    "services", "rotation_policies", "racks", "rack_items",
    "topology_snapshots", "escalation_rules", "escalation_notification_logs",
    "notification_channels", "notification_logs", "discovery_results",
    "ipam_subnets", "audit_logs", "backup_schedules", "driver_templates",
    "sla_policies", "ai_settings", "agent_peer_latencies",
    "synthetic_probe_results", "syslog_events",
    # device-bound
    "devices", "agents", "config_backups", "approval_requests",
    "security_audits", "agent_device_latencies", "alert_rules",
    "command_executions", "agent_command_logs", "ipam_addresses",
    "network_baselines", "asset_lifecycle", "synthetic_probes",
    "topology_links", "incidents", "mac_address_entries", "arp_entries",
    "network_events", "snmp_poll_results", "device_availability_snapshots",
]

# "default org" = the oldest organization row.
_DEFAULT_ORG = "(SELECT id FROM organizations ORDER BY id LIMIT 1)"


def upgrade() -> None:
    # Backfilling compressed TimescaleDB hypertables (snmp_poll_results,
    # device_availability_snapshots, syslog_events, …) decompresses their
    # chunks; the default per-DML decompression cap (100k tuples) is too
    # low. Lift it for this migration. NOTE for production: on a very
    # large hypertable this rewrites every chunk — run M2 in a maintenance
    # window, and the compression policy will recompress afterwards.
    op.execute(
        "SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0"
    )

    # ── 1. Ensure organizations exist ─────────────────────────────────────
    op.execute(
        "INSERT INTO organizations (name, slug, is_active, created_at, updated_at) "
        "SELECT 'Default Organization', 'default', true, NOW(), NOW() "
        "WHERE NOT EXISTS (SELECT 1 FROM organizations)"
    )
    op.execute(
        "INSERT INTO organizations "
        "  (name, slug, description, contact_email, is_active, created_at, updated_at) "
        "SELECT t.name, t.slug, t.description, t.contact_email, "
        "       COALESCE(t.is_active, true), NOW(), NOW() "
        "FROM tenants t "
        "WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.slug = t.slug)"
    )

    # ── 2. Backfill organization_id from the tenant→org slug join ──────────
    for tbl in _TENANT_TABLES:
        op.execute(
            f"UPDATE {tbl} SET organization_id = o.id "
            f"FROM tenants t JOIN organizations o ON o.slug = t.slug "
            f"WHERE {tbl}.tenant_id = t.id AND {tbl}.organization_id IS NULL"
        )

    # ── 3. Default-org fallback — every scoped table gets an org NOW, so
    #       the device/agent location backfill below can rely on it.
    #       (Device-bound tables are refined to the device's exact org in
    #       step 6; in a single-org deployment that is the same org.)
    for tbl in _ALL_SCOPED:
        op.execute(
            f"UPDATE {tbl} SET organization_id = {_DEFAULT_ORG} "
            f"WHERE organization_id IS NULL"
        )

    # ── 4. One "Unassigned" location per organization ─────────────────────
    op.execute(
        "INSERT INTO locations (name, organization_id, created_at) "
        "SELECT 'Unassigned — ' || o.slug, o.id, NOW() "
        "FROM organizations o "
        "WHERE NOT EXISTS ("
        "  SELECT 1 FROM locations l "
        "  WHERE l.organization_id = o.id AND l.name = 'Unassigned — ' || o.slug)"
    )

    # ── 5. devices.location_id ← site match, then Unassigned ──────────────
    op.execute(
        "UPDATE devices d SET location_id = l.id "
        "FROM locations l "
        "WHERE l.organization_id = d.organization_id "
        "  AND lower(l.name) = lower(d.site) "
        "  AND d.site IS NOT NULL AND d.site <> '' "
        "  AND d.location_id IS NULL"
    )
    op.execute(
        "UPDATE devices d SET location_id = l.id "
        "FROM locations l, organizations o "
        "WHERE o.id = d.organization_id "
        "  AND l.organization_id = d.organization_id "
        "  AND l.name = 'Unassigned — ' || o.slug "
        "  AND d.location_id IS NULL"
    )

    # ── 6. agents.location_id ← most-common managed-device location ───────
    op.execute(
        "UPDATE agents a SET location_id = sub.location_id "
        "FROM ("
        "  SELECT agent_id, location_id, "
        "         ROW_NUMBER() OVER ("
        "           PARTITION BY agent_id ORDER BY COUNT(*) DESC) AS rn "
        "  FROM devices "
        "  WHERE agent_id IS NOT NULL AND location_id IS NOT NULL "
        "  GROUP BY agent_id, location_id"
        ") sub "
        "WHERE sub.agent_id = a.id AND sub.rn = 1 AND a.location_id IS NULL"
    )
    op.execute(
        "UPDATE agents a SET location_id = l.id "
        "FROM locations l, organizations o "
        "WHERE o.id = a.organization_id "
        "  AND l.organization_id = a.organization_id "
        "  AND l.name = 'Unassigned — ' || o.slug "
        "  AND a.location_id IS NULL"
    )

    # ── 7. Device-bound tables ← organization_id + location_id from device ─
    for tbl in _DEVICE_BOUND:
        op.execute(
            f"UPDATE {tbl} c "
            f"SET organization_id = d.organization_id, location_id = d.location_id "
            f"FROM devices d WHERE c.device_id = d.id"
        )

    # ── 8. Sanity assertions ──────────────────────────────────────────────
    for tbl in _ALL_SCOPED:
        op.execute(
            f"DO $$ BEGIN "
            f"  IF EXISTS (SELECT 1 FROM {tbl} WHERE organization_id IS NULL) THEN "
            f"    RAISE EXCEPTION 'M2 backfill incomplete: {tbl}.organization_id has NULLs'; "
            f"  END IF; END $$;"
        )
    for tbl in ("devices", "agents"):
        op.execute(
            f"DO $$ BEGIN "
            f"  IF EXISTS (SELECT 1 FROM {tbl} WHERE location_id IS NULL) THEN "
            f"    RAISE EXCEPTION 'M2 backfill incomplete: {tbl}.location_id has NULLs'; "
            f"  END IF; END $$;"
        )


def downgrade() -> None:
    # Data migration — no-op. M1's downgrade drops the columns entirely;
    # the backfilled values and the auto-created "Unassigned" locations are
    # harmless to leave in place if the chain is only rolled back to M2.
    pass
