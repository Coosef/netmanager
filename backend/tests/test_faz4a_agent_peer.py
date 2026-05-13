"""
Faz 4A — True Agent-to-Agent Latency

Tests for AgentManager.measure_ab_peer_latency():
  - All (A, B) ordered pairs with known last_ip are measured
  - Self-pair (A→A) is never measured
  - < 2 online agents → noop
  - Agents without last_ip are excluded
  - Failed probe stored as reachable=False, latency_ms=None
  - Successful probe stores latency_ms correctly
  - DB commit called exactly once per sweep
  - No interaction with Celery (FastAPI bg task only)
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, call, patch


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_manager():
    """Create a fresh AgentManager with mocked _connections dict."""
    from app.services.agent_manager import AgentManager
    mgr = AgentManager.__new__(AgentManager)
    mgr._connections = {}
    mgr._pending = {}
    return mgr


def _db_with_agents(agent_rows: list[tuple[str, str | None]]):
    """
    Return an AsyncMock DB whose execute().all() returns rows with .id and .last_ip.
    agent_rows: [(agent_id, last_ip), ...]  — last_ip=None is excluded by WHERE clause.
    """
    db = AsyncMock()
    filtered = [
        MagicMock(id=aid, last_ip=ip)
        for aid, ip in agent_rows
        if ip is not None
    ]
    db.execute = AsyncMock(return_value=MagicMock(all=lambda: filtered))
    return db


# ── Tests ─────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_no_online_agents_noop():
    """No online agents → returns 0, no DB interaction."""
    mgr = _make_manager()
    db = AsyncMock()
    count = await mgr.measure_ab_peer_latency(db)
    assert count == 0
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_single_online_agent_noop():
    """One agent → no pairs possible → noop."""
    mgr = _make_manager()
    mgr._connections = {"agent_a": MagicMock()}
    db = AsyncMock()
    count = await mgr.measure_ab_peer_latency(db)
    assert count == 0
    db.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_two_agents_produces_two_measurements():
    """Two online agents → A→B and B→A = 2 measurements."""
    mgr = _make_manager()
    mgr._connections = {"agent_a": MagicMock(), "agent_b": MagicMock()}
    mgr.execute_synthetic_probe = AsyncMock(
        return_value={"success": True, "latency_ms": 1.5, "detail": ""}
    )
    db = _db_with_agents([("agent_a", "10.0.0.1"), ("agent_b", "10.0.0.2")])

    count = await mgr.measure_ab_peer_latency(db)

    assert count == 2
    assert mgr.execute_synthetic_probe.call_count == 2
    assert db.add.call_count == 2
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_three_agents_produces_six_measurements():
    """Three agents → 3×2 = 6 ordered pairs."""
    mgr = _make_manager()
    mgr._connections = {
        "agent_a": MagicMock(), "agent_b": MagicMock(), "agent_c": MagicMock()
    }
    mgr.execute_synthetic_probe = AsyncMock(
        return_value={"success": True, "latency_ms": 2.0, "detail": ""}
    )
    db = _db_with_agents([
        ("agent_a", "10.0.0.1"),
        ("agent_b", "10.0.0.2"),
        ("agent_c", "10.0.0.3"),
    ])

    count = await mgr.measure_ab_peer_latency(db)

    assert count == 6
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_self_pair_never_measured():
    """A→A pair must never be dispatched."""
    mgr = _make_manager()
    mgr._connections = {"agent_a": MagicMock(), "agent_b": MagicMock()}
    probe = AsyncMock(return_value={"success": True, "latency_ms": 1.0, "detail": ""})
    mgr.execute_synthetic_probe = probe
    db = _db_with_agents([("agent_a", "10.0.0.1"), ("agent_b", "10.0.0.2")])

    await mgr.measure_ab_peer_latency(db)

    for c in probe.call_args_list:
        a_from = c.args[0]
        target  = c.kwargs.get("target") or c.args[2]
        # agent_a pinging itself would have target="10.0.0.1" when a_from="agent_a"
        if a_from == "agent_a":
            assert target != "10.0.0.1"
        if a_from == "agent_b":
            assert target != "10.0.0.2"


@pytest.mark.asyncio
async def test_agent_without_last_ip_excluded():
    """Agent with last_ip=None must not appear in any probe pair."""
    mgr = _make_manager()
    mgr._connections = {
        "agent_a": MagicMock(), "agent_b": MagicMock(), "agent_c": MagicMock()
    }
    probe = AsyncMock(return_value={"success": True, "latency_ms": 1.0, "detail": ""})
    mgr.execute_synthetic_probe = probe
    # agent_c has no last_ip
    db = _db_with_agents([("agent_a", "10.0.0.1"), ("agent_b", "10.0.0.2"), ("agent_c", None)])

    count = await mgr.measure_ab_peer_latency(db)

    # Only A and B have IPs → 2 pairs (A→B and B→A)
    assert count == 2
    assert probe.call_count == 2


@pytest.mark.asyncio
async def test_failed_probe_stored_as_unreachable():
    """Probe returning success=False → AgentPeerLatency(reachable=False, latency_ms=None)."""
    mgr = _make_manager()
    mgr._connections = {"agent_a": MagicMock(), "agent_b": MagicMock()}
    mgr.execute_synthetic_probe = AsyncMock(
        return_value={"success": False, "latency_ms": None, "detail": "timeout"}
    )
    db = _db_with_agents([("agent_a", "10.0.0.1"), ("agent_b", "10.0.0.2")])

    await mgr.measure_ab_peer_latency(db)

    added = [c.args[0] for c in db.add.call_args_list]
    for obj in added:
        assert obj.reachable is False
        assert obj.latency_ms is None


@pytest.mark.asyncio
async def test_successful_probe_stores_latency():
    """Probe returning latency_ms → stored on AgentPeerLatency."""
    mgr = _make_manager()
    mgr._connections = {"agent_a": MagicMock(), "agent_b": MagicMock()}
    mgr.execute_synthetic_probe = AsyncMock(
        return_value={"success": True, "latency_ms": 4.2, "detail": ""}
    )
    db = _db_with_agents([("agent_a", "10.0.0.1"), ("agent_b", "10.0.0.2")])

    await mgr.measure_ab_peer_latency(db)

    added = [c.args[0] for c in db.add.call_args_list]
    for obj in added:
        assert obj.reachable is True
        assert abs(obj.latency_ms - 4.2) < 0.001


@pytest.mark.asyncio
async def test_stored_records_have_correct_agent_ids():
    """agent_from / agent_to on stored records match the probe source and target."""
    mgr = _make_manager()
    mgr._connections = {"agent_a": MagicMock(), "agent_b": MagicMock()}
    mgr.execute_synthetic_probe = AsyncMock(
        return_value={"success": True, "latency_ms": 1.0, "detail": ""}
    )
    db = _db_with_agents([("agent_a", "10.0.0.1"), ("agent_b", "10.0.0.2")])

    await mgr.measure_ab_peer_latency(db)

    added = [c.args[0] for c in db.add.call_args_list]
    pairs = {(obj.agent_from, obj.agent_to) for obj in added}
    # Exactly A→B and B→A; no A→A or B→B
    assert ("agent_a", "agent_b") in pairs
    assert ("agent_b", "agent_a") in pairs
    assert ("agent_a", "agent_a") not in pairs
    assert ("agent_b", "agent_b") not in pairs
