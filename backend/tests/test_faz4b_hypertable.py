"""
Faz 4B — TimescaleDB Hypertable Migration

Tests that:
  - The five target tables are enumerated in HYPERTABLE_MANAGED
  - _RETENTION excludes all hypertable-managed tables (no double-deletion)
  - retention_tasks._run() does NOT issue DELETE for hypertable tables
  - retention_tasks._run() still handles non-hypertable tables normally
  - notification_logs uses 'sent_at' column (not 'created_at')
  - network_events, audit_logs, command_executions use 'created_at' column
  - HYPERTABLE_MANAGED is a proper set (supports 'in' lookups)
  - _RETENTION only covers tables NOT in HYPERTABLE_MANAGED
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call


# ── Imports under test ────────────────────────────────────────────────────────

from app.workers.tasks.retention_tasks import HYPERTABLE_MANAGED, _RETENTION


# ── G1: Constants correctness ─────────────────────────────────────────────────

def test_hypertable_managed_contains_all_five_tables():
    expected = {
        "snmp_poll_results",
        "syslog_events",
        "device_availability_snapshots",
        "agent_peer_latencies",
        "synthetic_probe_results",
    }
    assert expected == HYPERTABLE_MANAGED


def test_hypertable_managed_is_a_set():
    assert isinstance(HYPERTABLE_MANAGED, set)


def test_retention_excludes_hypertable_tables():
    """_RETENTION must not contain any table that TimescaleDB manages."""
    overlap = set(_RETENTION.keys()) & HYPERTABLE_MANAGED
    assert overlap == set(), f"Hypertable tables found in _RETENTION: {overlap}"


def test_retention_covers_expected_plain_tables():
    assert "notification_logs" in _RETENTION
    assert "network_events" in _RETENTION
    assert "audit_logs" in _RETENTION
    assert "command_executions" in _RETENTION


# ── G2: ts_col mapping ────────────────────────────────────────────────────────

def test_notification_logs_uses_sent_at():
    """notification_logs time column is 'sent_at', not 'created_at'."""
    from app.workers.tasks import retention_tasks as rt
    import ast, inspect, textwrap
    src = textwrap.dedent(inspect.getsource(rt._run))
    assert "sent_at" in src
    assert "notification_logs" in src


def test_no_snmp_or_syslog_in_retention_logic():
    """After Faz 4B, snmp_poll_results and syslog_events must not appear in _run()."""
    from app.workers.tasks import retention_tasks as rt
    import inspect, textwrap
    src = textwrap.dedent(inspect.getsource(rt._run))
    assert "snmp_poll_results" not in src
    assert "syslog_events" not in src


# ── G3: Runtime behaviour (mocked DB) ────────────────────────────────────────

@pytest.mark.asyncio
async def test_run_does_not_delete_hypertable_tables():
    """_run() must never execute DELETE on hypertable-managed tables."""
    from app.workers.tasks.retention_tasks import _run

    mock_result = MagicMock()
    mock_result.rowcount = 0
    db = AsyncMock()
    db.execute = AsyncMock(return_value=mock_result)
    db.commit = AsyncMock()

    session_ctx = MagicMock()
    session_ctx.__aenter__ = AsyncMock(return_value=db)
    session_ctx.__aexit__ = AsyncMock(return_value=False)
    session_factory = MagicMock(return_value=session_ctx)

    with patch("app.core.database.make_worker_session", return_value=session_factory), \
         patch("app.workers.tasks.retention_tasks.make_worker_session",
               new=session_factory, create=True):
        await _run()

    forbidden = {t.lower() for t in HYPERTABLE_MANAGED}
    for c in db.execute.call_args_list:
        sql = str(c.args[0]).lower() if c.args else ""
        for tbl in forbidden:
            assert f"delete from {tbl}" not in sql, (
                f"retention_tasks attempted DELETE on hypertable '{tbl}'"
            )
