"""faz7 M5 — enable Row-Level Security policies

Multi-tenant isolation rework — the RLS gate (plan name "M5"; 4th faz7
migration chronologically). Turns on PostgreSQL Row-Level Security so
the database itself scopes every query to the caller's organization /
location, regardless of what the application code does.

Each scoped table gets:
  ENABLE ROW LEVEL SECURITY
  FORCE ROW LEVEL SECURITY   -- netmgr owns the tables; owners bypass RLS
                             -- unless FORCE-d, so this is required
  CREATE POLICY org_isolation ...

The policy reads the per-transaction GUCs set by app/core/rls.py:
  * super-admin bypass  → current_setting('app.is_super_admin') = 'on'
  * org match           → organization_id = app.current_org_id
  * (device-bound only) location match on SELECT/UPDATE/DELETE visibility;
    writes (WITH CHECK) are org-only so an org-admin in ALL-LOCATIONS
    mode can still create rows.

Fail-closed: with no context the GUCs are NULL → the predicate is NULL →
zero rows visible / writable.

NOT covered (deliberately): users, invite_tokens, api_tokens, audit_logs,
organizations, plans, permission_sets, tenants, user_locations — auth /
audit / platform-infra tables accessed before a context exists (login,
invite-accept) or by explicit id. audit_logs RLS is a Faz 7 Phase 6a item.

Also NOT covered: snmp_poll_results — a compressed (columnstore)
TimescaleDB hypertable; PostgreSQL/TimescaleDB does not permit RLS on a
compressed hypertable. Its org isolation is enforced at the query layer
(callers filter by organization_id). The other four hypertables are
uncompressed and DO get RLS.

Revision ID: f7a4rls
Revises: f7a3notnull
Create Date: 2026-05-18
"""
from alembic import op

revision = "f7a4rls"
down_revision = "f7a3notnull"
branch_labels = None
depends_on = None


# Org-direct tables — org-only policy.
_ORG_ONLY = [
    "locations", "device_groups", "config_templates", "credential_profiles",
    "playbooks", "playbook_runs", "tasks", "change_rollouts",
    "agent_credential_bundles", "maintenance_windows", "services",
    "rotation_policies", "racks", "rack_items", "topology_snapshots",
    "escalation_rules", "escalation_notification_logs", "notification_channels",
    "notification_logs", "discovery_results", "ipam_subnets",
    "backup_schedules", "driver_templates", "sla_policies", "ai_settings",
    "agent_peer_latencies", "synthetic_probe_results", "syslog_events",
]

# Device-bound tables — org policy + a location filter on read visibility.
# snmp_poll_results is intentionally absent — it is a compressed hypertable
# and RLS cannot be enabled on one (see the module docstring).
_DEVICE_BOUND = [
    "devices", "agents", "config_backups", "approval_requests",
    "security_audits", "agent_device_latencies", "alert_rules",
    "command_executions", "agent_command_logs", "ipam_addresses",
    "network_baselines", "asset_lifecycle", "synthetic_probes",
    "topology_links", "incidents", "mac_address_entries", "arp_entries",
    "network_events", "device_availability_snapshots",
]

_ALL = _ORG_ONLY + _DEVICE_BOUND

# Super-admin bypass OR the row's org equals the session org.
_ORG = (
    "current_setting('app.is_super_admin', true) = 'on' "
    "OR organization_id = "
    "NULLIF(current_setting('app.current_org_id', true), '')::int"
)
# Location filter — empty session location ⇒ all locations in the org.
_LOC = (
    "NULLIF(current_setting('app.current_location_id', true), '') IS NULL "
    "OR location_id = "
    "NULLIF(current_setting('app.current_location_id', true), '')::int"
)


def upgrade() -> None:
    for tbl in _ALL:
        op.execute(f"ALTER TABLE {tbl} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {tbl} FORCE ROW LEVEL SECURITY")

    for tbl in _ORG_ONLY:
        op.execute(
            f"CREATE POLICY org_isolation ON {tbl} "
            f"USING ({_ORG}) WITH CHECK ({_ORG})"
        )
    for tbl in _DEVICE_BOUND:
        # Read/update/delete visibility = org AND location; writes = org only.
        op.execute(
            f"CREATE POLICY org_isolation ON {tbl} "
            f"USING (({_ORG}) AND ({_LOC})) "
            f"WITH CHECK ({_ORG})"
        )


def downgrade() -> None:
    for tbl in _ALL:
        op.execute(f"DROP POLICY IF EXISTS org_isolation ON {tbl}")
        op.execute(f"ALTER TABLE {tbl} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {tbl} DISABLE ROW LEVEL SECURITY")
