"""faz7 M1 — add organization_id / location_id / deleted_at columns

Multi-tenant isolation rework, migration 1 of 6. Adds the new scoping
columns as NULLABLE (backfilled by M2, made NOT NULL by M3). No indexes,
no DEFAULT — a non-null default would rewrite every hypertable chunk.

- Bucket A (org-direct): organization_id only.
- Bucket B (device-bound): organization_id + location_id.
- agents / devices: organization_id + location_id (devices is the anchor;
  an agent is bound to one location — see Faz 7 plan Phase 6e).
- users.org_id is renamed to users.organization_id (one column name
  everywhere simplifies the RLS policy generator).
- deleted_at added to organizations / locations / devices / agents (soft
  delete — Phase 6b).
- Hypertables get plain integer columns (no inline FK) — adding an FK
  constraint to a hypertable is restricted; RLS only needs the column.

Revision ID: f7a1addorgloc
Revises: d5e6f7a8b9c0
Create Date: 2026-05-18
"""
from alembic import op
import sqlalchemy as sa

revision = "f7a1addorgloc"
down_revision = "d5e6f7a8b9c0"
branch_labels = None
depends_on = None


# ── Table classification (authoritative — see Faz 7 plan Phase 1) ─────────────

_HYPERTABLES = {
    "snmp_poll_results", "device_availability_snapshots",
    "agent_peer_latencies", "synthetic_probe_results", "syslog_events",
}

# Bucket A — org-direct: organization_id only. (users + invite_tokens are
# handled separately below — they already have an `org_id` column that is
# renamed rather than duplicated.)
_ORG_ONLY = [
    "api_tokens", "locations", "device_groups", "config_templates",
    "credential_profiles", "playbooks", "playbook_runs", "tasks",
    "change_rollouts", "agent_credential_bundles",
    "maintenance_windows", "services", "rotation_policies", "racks",
    "rack_items", "topology_snapshots", "escalation_rules",
    "escalation_notification_logs", "notification_channels",
    "notification_logs", "discovery_results", "ipam_subnets", "audit_logs",
    "backup_schedules", "driver_templates", "sla_policies", "ai_settings",
    "agent_peer_latencies", "synthetic_probe_results", "syslog_events",
]

# Bucket B — device-bound: organization_id + location_id.
_ORG_LOCATION = [
    "devices", "agents", "config_backups", "approval_requests",
    "security_audits", "agent_device_latencies", "alert_rules",
    "command_executions", "agent_command_logs", "ipam_addresses",
    "network_baselines", "asset_lifecycle", "synthetic_probes",
    "topology_links", "incidents", "mac_address_entries", "arp_entries",
    "network_events", "snmp_poll_results", "device_availability_snapshots",
]

# Soft-delete gravestone.
_DELETED_AT = ["organizations", "locations", "devices", "agents"]


def _add_org(table: str) -> None:
    """Add nullable organization_id — FK on regular tables, plain int on
    hypertables (TimescaleDB restricts FK constraints on hypertables)."""
    if table in _HYPERTABLES:
        op.add_column(table, sa.Column("organization_id", sa.Integer(), nullable=True))
    else:
        op.add_column(table, sa.Column(
            "organization_id", sa.Integer(),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True,
        ))


def _add_location(table: str) -> None:
    if table in _HYPERTABLES:
        op.add_column(table, sa.Column("location_id", sa.Integer(), nullable=True))
    else:
        op.add_column(table, sa.Column(
            "location_id", sa.Integer(),
            sa.ForeignKey("locations.id", ondelete="SET NULL"), nullable=True,
        ))


def upgrade() -> None:
    # users / invite_tokens already have an `org_id` FK to organizations —
    # rename it so every scoped table uses the same column name.
    op.alter_column("users", "org_id", new_column_name="organization_id")
    op.alter_column("invite_tokens", "org_id", new_column_name="organization_id")

    for table in _ORG_ONLY:
        _add_org(table)

    for table in _ORG_LOCATION:
        _add_org(table)
        _add_location(table)

    for table in _DELETED_AT:
        op.add_column(table, sa.Column(
            "deleted_at", sa.DateTime(timezone=True), nullable=True,
        ))


def downgrade() -> None:
    for table in _DELETED_AT:
        op.drop_column(table, "deleted_at")

    for table in _ORG_LOCATION:
        op.drop_column(table, "location_id")
        op.drop_column(table, "organization_id")

    for table in _ORG_ONLY:
        op.drop_column(table, "organization_id")

    op.alter_column("users", "organization_id", new_column_name="org_id")
    op.alter_column("invite_tokens", "organization_id", new_column_name="org_id")
