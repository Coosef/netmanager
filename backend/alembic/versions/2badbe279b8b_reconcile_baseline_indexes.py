"""reconcile_baseline_indexes

Revision ID: 2badbe279b8b
Revises: 2b6c64e3a91e
Create Date: 2026-05-13 12:17:50.665744

Manually curated from autogenerate output. Only safe changes applied.

DB audit findings before this migration:
  - escalation_notification_logs: BOTH ix_esc_notif_log_* (from main.py) AND
    ix_escalation_notification_logs_* (from create_all) already exist.
    Upgrade: drop old names. Downgrade: re-create old names.
  - device_availability_snapshots: has device_availability_snapshots_ts_idx +
    ix_das_device_ts (non-standard). Replace with convention names.
  - discovery_results: has ix_discovery_results_agent (non-standard). Rename.
  - syslog_events: has ix_syslog_agent_received + ix_syslog_events_received.
    Add new standard names, drop old after.
  - devices/audit_logs/invite_tokens/mac_address_entries/agent_credential_bundles:
    missing model-defined indexes.

EXCLUDED (deferred):
  - server_default=None changes (cosmetic, no functional impact)
  - JSONB->JSON type changes (no benefit, table rewrite risk)
  - Index drops without replacements (network_events, snmp/synthetic hypertable indexes)

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '2badbe279b8b'
down_revision: Union[str, None] = '2b6c64e3a91e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── agent_credential_bundles ─────────────────────────────────────────────
    op.drop_constraint('agent_credential_bundles_agent_id_key', 'agent_credential_bundles', type_='unique')
    op.create_index(op.f('ix_agent_credential_bundles_agent_id'), 'agent_credential_bundles', ['agent_id'], unique=True)
    op.create_index(op.f('ix_agent_credential_bundles_id'), 'agent_credential_bundles', ['id'], unique=False)

    # ── audit_logs ───────────────────────────────────────────────────────────
    op.create_index(op.f('ix_audit_logs_request_id'), 'audit_logs', ['request_id'], unique=False)

    # ── device_availability_snapshots ────────────────────────────────────────
    op.drop_index('device_availability_snapshots_ts_idx', table_name='device_availability_snapshots')
    op.drop_index('ix_das_device_ts', table_name='device_availability_snapshots')
    op.create_index(op.f('ix_device_availability_snapshots_device_id'), 'device_availability_snapshots', ['device_id'], unique=False)
    op.create_index(op.f('ix_device_availability_snapshots_ts'), 'device_availability_snapshots', ['ts'], unique=False)

    # ── devices ──────────────────────────────────────────────────────────────
    op.create_index(op.f('ix_devices_agent_id'), 'devices', ['agent_id'], unique=False)
    op.create_index(op.f('ix_devices_credential_profile_id'), 'devices', ['credential_profile_id'], unique=False)

    # ── discovery_results ────────────────────────────────────────────────────
    op.drop_index('ix_discovery_results_agent', table_name='discovery_results')
    op.create_index(op.f('ix_discovery_results_agent_id'), 'discovery_results', ['agent_id'], unique=False)
    op.create_index(op.f('ix_discovery_results_id'), 'discovery_results', ['id'], unique=False)

    # ── escalation_notification_logs ─────────────────────────────────────────
    # New-named indexes already exist (created by create_all). Drop old names only.
    op.drop_index('ix_esc_notif_log_incident_id', table_name='escalation_notification_logs')
    op.drop_index('ix_esc_notif_log_rule_id', table_name='escalation_notification_logs')
    op.drop_index('ix_esc_notif_log_sent_at', table_name='escalation_notification_logs')

    # ── invite_tokens ────────────────────────────────────────────────────────
    op.create_index(op.f('ix_invite_tokens_org_id'), 'invite_tokens', ['org_id'], unique=False)

    # ── mac_address_entries ──────────────────────────────────────────────────
    op.create_index(op.f('ix_mac_address_entries_oui_vendor'), 'mac_address_entries', ['oui_vendor'], unique=False)

    # ── syslog_events ────────────────────────────────────────────────────────
    # ix_syslog_agent_received and ix_syslog_events_received both exist (non-standard names).
    # Add new convention-named indexes, then drop old ones.
    op.create_index(op.f('ix_syslog_events_agent_id'), 'syslog_events', ['agent_id'], unique=False)
    op.create_index(op.f('ix_syslog_events_id'), 'syslog_events', ['id'], unique=False)
    op.create_index(op.f('ix_syslog_events_received_at'), 'syslog_events', ['received_at'], unique=False)
    op.drop_index('ix_syslog_agent_received', table_name='syslog_events')
    op.drop_index('ix_syslog_events_received', table_name='syslog_events')


def downgrade() -> None:
    # ── syslog_events ────────────────────────────────────────────────────────
    op.create_index('ix_syslog_events_received', 'syslog_events', ['received_at'], unique=False)
    op.create_index('ix_syslog_agent_received', 'syslog_events', ['agent_id', 'received_at'], unique=False)
    op.drop_index(op.f('ix_syslog_events_received_at'), table_name='syslog_events')
    op.drop_index(op.f('ix_syslog_events_id'), table_name='syslog_events')
    op.drop_index(op.f('ix_syslog_events_agent_id'), table_name='syslog_events')

    # ── mac_address_entries ──────────────────────────────────────────────────
    op.drop_index(op.f('ix_mac_address_entries_oui_vendor'), table_name='mac_address_entries')

    # ── invite_tokens ────────────────────────────────────────────────────────
    op.drop_index(op.f('ix_invite_tokens_org_id'), table_name='invite_tokens')

    # ── escalation_notification_logs ─────────────────────────────────────────
    op.create_index('ix_esc_notif_log_sent_at', 'escalation_notification_logs', ['sent_at'], unique=False)
    op.create_index('ix_esc_notif_log_rule_id', 'escalation_notification_logs', ['rule_id'], unique=False)
    op.create_index('ix_esc_notif_log_incident_id', 'escalation_notification_logs', ['incident_id'], unique=False)

    # ── discovery_results ────────────────────────────────────────────────────
    op.drop_index(op.f('ix_discovery_results_id'), table_name='discovery_results')
    op.drop_index(op.f('ix_discovery_results_agent_id'), table_name='discovery_results')
    op.create_index('ix_discovery_results_agent', 'discovery_results', ['agent_id'], unique=False)

    # ── devices ──────────────────────────────────────────────────────────────
    op.drop_index(op.f('ix_devices_credential_profile_id'), table_name='devices')
    op.drop_index(op.f('ix_devices_agent_id'), table_name='devices')

    # ── device_availability_snapshots ────────────────────────────────────────
    op.drop_index(op.f('ix_device_availability_snapshots_ts'), table_name='device_availability_snapshots')
    op.drop_index(op.f('ix_device_availability_snapshots_device_id'), table_name='device_availability_snapshots')
    op.create_index('ix_das_device_ts', 'device_availability_snapshots', ['device_id', 'ts'], unique=False)
    op.create_index('device_availability_snapshots_ts_idx', 'device_availability_snapshots', [sa.text('ts DESC')], unique=False)

    # ── audit_logs ───────────────────────────────────────────────────────────
    op.drop_index(op.f('ix_audit_logs_request_id'), table_name='audit_logs')

    # ── agent_credential_bundles ─────────────────────────────────────────────
    op.drop_index(op.f('ix_agent_credential_bundles_id'), table_name='agent_credential_bundles')
    op.drop_index(op.f('ix_agent_credential_bundles_agent_id'), table_name='agent_credential_bundles')
    op.create_unique_constraint('agent_credential_bundles_agent_id_key', 'agent_credential_bundles', ['agent_id'])
