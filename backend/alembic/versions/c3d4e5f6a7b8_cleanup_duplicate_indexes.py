"""cleanup_duplicate_indexes

Revision ID: c3d4e5f6a7b8
Revises: 2badbe279b8b
Create Date: 2026-05-13 14:00:00.000000

Drop single-column legacy indexes whose Alembic-convention duplicates already exist.
Rename ix_network_events_acked -> ix_network_events_acknowledged (model convention).
Restore ix_syslog_agent_received composite (accidentally dropped in reconcile revision).

DB state before this migration has BOTH old-named (main.py) AND convention-named
(create_all) indexes for the same columns. Old-named are safe to drop.

Composite / partial indexes (ix_apl_agent_to_ts, ix_config_backups_device_created,
ix_network_events_*, ix_notification_logs_channel_source, ix_snmp_poll_results_device_polled,
ix_spr_probe_ts) are retained and mirrored in __table_args__ instead.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, None] = '2badbe279b8b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── agent_peer_latencies ─────────────────────────────────────────────────
    # ix_agent_peer_latencies_agent_from already exists (create_all convention name).
    op.drop_index('ix_apl_agent_from', table_name='agent_peer_latencies')

    # ── audit_logs ───────────────────────────────────────────────────────────
    # ix_audit_logs_created_at already exists (create_all convention name).
    op.drop_index('ix_audit_logs_created', table_name='audit_logs')

    # ── network_events ───────────────────────────────────────────────────────
    # Rename: acknowledged column index to Alembic convention name.
    op.drop_index('ix_network_events_acked', table_name='network_events')
    op.create_index(
        op.f('ix_network_events_acknowledged'), 'network_events', ['acknowledged'], unique=False
    )

    # ── notification_logs ────────────────────────────────────────────────────
    # ix_notification_logs_sent_at already exists (create_all convention name).
    op.drop_index('ix_notification_logs_sent', table_name='notification_logs')

    # ── synthetic_probes ─────────────────────────────────────────────────────
    # ix_synthetic_probes_agent_id and ix_synthetic_probes_device_id already exist.
    op.drop_index('ix_synthetic_probes_agent', table_name='synthetic_probes')
    op.drop_index('ix_synthetic_probes_device', table_name='synthetic_probes')

    # ── syslog_events ────────────────────────────────────────────────────────
    # Composite (agent_id, received_at) was accidentally dropped in reconcile revision.
    # Model explicitly declares Index("ix_syslog_agent_received", ...) — restore it.
    op.create_index(
        'ix_syslog_agent_received', 'syslog_events', ['agent_id', 'received_at'], unique=False
    )


def downgrade() -> None:
    # ── syslog_events ────────────────────────────────────────────────────────
    op.drop_index('ix_syslog_agent_received', table_name='syslog_events')

    # ── synthetic_probes ─────────────────────────────────────────────────────
    op.create_index('ix_synthetic_probes_device', 'synthetic_probes', ['device_id'], unique=False)
    op.create_index('ix_synthetic_probes_agent', 'synthetic_probes', ['agent_id'], unique=False)

    # ── notification_logs ────────────────────────────────────────────────────
    op.create_index('ix_notification_logs_sent', 'notification_logs', ['sent_at'], unique=False)

    # ── network_events ───────────────────────────────────────────────────────
    op.drop_index(op.f('ix_network_events_acknowledged'), table_name='network_events')
    op.create_index('ix_network_events_acked', 'network_events', ['acknowledged'], unique=False)

    # ── audit_logs ───────────────────────────────────────────────────────────
    op.create_index('ix_audit_logs_created', 'audit_logs', ['created_at'], unique=False)

    # ── agent_peer_latencies ─────────────────────────────────────────────────
    op.create_index('ix_apl_agent_from', 'agent_peer_latencies', ['agent_from'], unique=False)
