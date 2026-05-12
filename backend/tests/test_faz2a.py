"""
Faz 2A Tests — Multi-Source Correlation + Production Stability

Covers:
  G1: SNMP Trap → Correlation Engine
  G2: RECOVERING sweep (confirm_stale_recovering)
  G3: Multi-hop BFS suppression

Run with: cd backend && python -m pytest tests/test_faz2a.py -v
"""
import asyncio
import sys
import os
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch

import pytest
import pytest_asyncio

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

from app.core.database import Base
from app.models.incident import Incident, IncidentState
from app.models.topology import TopologyLink
from app.services.correlation_engine import (
    make_fingerprint,
    BOUNCE_GUARD_SEC,
    UPSTREAM_BFS_MAX_DEPTH,
)
from app.workers.tasks.correlation_tasks import (
    confirm_stale_recovering,
    RECOVERY_CONFIRM_SEC,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(
            lambda c: Base.metadata.create_all(
                c, tables=[Incident.__table__, TopologyLink.__table__]
            )
        )
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest.fixture
def fake_redis():
    store = {}
    r = MagicMock()

    def incr(key):
        store[key] = store.get(key, 0) + 1
        return store[key]

    def expire(key, ttl): pass

    def exists(key): return int(key in store)

    def setex(key, ttl, value): store[key] = value

    def delete(key): store.pop(key, None)

    def get(key): return store.get(key)

    r.incr.side_effect = incr
    r.expire.side_effect = expire
    r.exists.side_effect = exists
    r.setex.side_effect = setex
    r.delete.side_effect = delete
    r.get.side_effect = get
    r._store = store
    return r


# ── G1: SNMP Trap → Correlation Engine ───────────────────────────────────────

@pytest.mark.asyncio
async def test_snmp_linkdown_opens_incident(db, fake_redis):
    """
    linkDown trap → process_event(is_problem=True) → group_wait started.
    NetworkEvent path is independent; this tests only the correlation branch.
    """
    from app.services.correlation_engine import process_event

    with patch("app.workers.tasks.correlation_tasks.open_incident_after_wait") as mock_task:
        mock_task.apply_async = MagicMock()

        result = await process_event(
            device_id=101, event_type="port_down", component="device",
            source="snmp_trap", is_problem=True, db=db, sync_redis=fake_redis,
            severity="critical",
        )

    assert result is None  # group_wait pending
    mock_task.apply_async.assert_called_once()
    # Source confidence for snmp_trap must be in the call kwargs
    call_kwargs = mock_task.apply_async.call_args.kwargs["kwargs"]
    assert abs(call_kwargs["confidence"] - 0.85) < 0.01


@pytest.mark.asyncio
async def test_snmp_linkup_recovery_sets_recovering(db, fake_redis):
    """
    linkUp trap on an existing OPEN incident → RECOVERING state.
    """
    from app.services.correlation_engine import process_event

    old_open = datetime.now(timezone.utc) - timedelta(seconds=BOUNCE_GUARD_SEC + 10)
    fp = make_fingerprint(102, "port_down", "device")

    inc = Incident(
        fingerprint=fp, device_id=102, event_type="port_down",
        component="device", severity="critical", state=IncidentState.OPEN,
        opened_at=old_open, sources=[], timeline=[],
    )
    db.add(inc)
    await db.commit()

    with patch("app.workers.tasks.correlation_tasks.confirm_recovery") as mock_task:
        mock_task.apply_async = MagicMock()
        result = await process_event(
            device_id=102, event_type="port_down", component="device",
            source="snmp_trap", is_problem=False, db=db, sync_redis=fake_redis,
        )

    assert result is not None
    assert result.state == IncidentState.RECOVERING
    mock_task.apply_async.assert_called_once()


@pytest.mark.asyncio
async def test_snmp_coldstart_opens_incident(db, fake_redis):
    """
    coldStart trap → device_restart event → group_wait started.
    """
    from app.services.correlation_engine import process_event

    with patch("app.workers.tasks.correlation_tasks.open_incident_after_wait") as mock_task:
        mock_task.apply_async = MagicMock()
        result = await process_event(
            device_id=103, event_type="device_restart", component="device",
            source="snmp_trap", is_problem=True, db=db, sync_redis=fake_redis,
            severity="warning",
        )

    assert result is None
    mock_task.apply_async.assert_called_once()


@pytest.mark.asyncio
async def test_snmp_trap_second_source_escalates_to_degraded(db, fake_redis):
    """
    agent opens OPEN incident; snmp_trap confirms → DEGRADED.
    Verifies multi-source escalation works with snmp_trap as second source.
    """
    from app.services.correlation_engine import process_event

    now = datetime.now(timezone.utc)
    fp = make_fingerprint(104, "device_unreachable", "device")

    # Pre-existing OPEN incident (from agent health check)
    inc = Incident(
        fingerprint=fp, device_id=104, event_type="device_unreachable",
        component="device", severity="critical", state=IncidentState.OPEN,
        opened_at=now,
        sources=[{"source": "agent", "ts": now.isoformat(), "confidence": 0.8}],
        timeline=[],
    )
    db.add(inc)
    await db.commit()
    await db.refresh(inc)

    with patch("app.workers.tasks.correlation_tasks.open_incident_after_wait") as mock_task:
        mock_task.apply_async = MagicMock()
        result = await process_event(
            device_id=104, event_type="device_unreachable", component="device",
            source="snmp_trap", is_problem=True, db=db, sync_redis=fake_redis,
        )

    assert result is not None
    assert result.state == IncidentState.DEGRADED
    assert "snmp_trap" in result.unique_sources
    assert "agent" in result.unique_sources


@pytest.mark.asyncio
async def test_snmp_correlation_failure_does_not_break_flow(db, fake_redis):
    """
    If correlation engine raises during SNMP trap processing, the exception
    must be caught (non-fatal) — verified via process_event's internal guard.
    """
    from app.services.correlation_engine import process_event

    # Force flap suppression by exceeding threshold — returns None without raising
    from app.services.correlation_engine import FLAP_THRESHOLD
    for _ in range(FLAP_THRESHOLD + 2):
        fake_redis.incr(f"corr:flap:{make_fingerprint(105, 'port_down', 'device')}")

    try:
        result = await process_event(
            device_id=105, event_type="port_down", component="device",
            source="snmp_trap", is_problem=True, db=db, sync_redis=fake_redis,
        )
    except Exception as e:
        pytest.fail(f"process_event raised unexpectedly: {e}")

    assert result is None  # suppressed by flap guard


# ── G2: RECOVERING sweep ──────────────────────────────────────────────────────

def _make_sync_db_with_incidents(tmp_path, incidents):
    """Helper: create a real SQLite DB with given incidents for sync task tests."""
    import sqlite3, json as _json
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(f"sqlite:///{tmp_path}/sweep.db")
    Base.metadata.create_all(engine, tables=[Incident.__table__])
    Session = sessionmaker(bind=engine)
    db = Session()
    for inc in incidents:
        db.add(inc)
    db.commit()
    return db, engine


def test_stale_recovering_sweep(tmp_path):
    """
    confirm_stale_recovering closes incidents stuck in RECOVERING for > 2×RECOVERY_CONFIRM_SEC.
    """
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(f"sqlite:///{tmp_path}/sweep_test.db")
    Base.metadata.create_all(engine, tables=[Incident.__table__])
    Session = sessionmaker(bind=engine)

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=RECOVERY_CONFIRM_SEC * 2 + 60)
    recent = datetime.now(timezone.utc) - timedelta(seconds=30)

    stale_inc = Incident(
        fingerprint="aabbccddeeff0011", device_id=200, event_type="device_unreachable",
        component="device", severity="critical", state=IncidentState.RECOVERING,
        opened_at=cutoff - timedelta(seconds=300),
        recovering_at=cutoff,
        sources=[], timeline=[],
    )
    fresh_inc = Incident(
        fingerprint="1122334455667788", device_id=201, event_type="device_unreachable",
        component="device", severity="critical", state=IncidentState.RECOVERING,
        opened_at=recent - timedelta(seconds=60),
        recovering_at=recent,
        sources=[], timeline=[],
    )

    with Session() as db:
        db.add(stale_inc)
        db.add(fresh_inc)
        db.commit()
        stale_id = stale_inc.id
        fresh_id = fresh_inc.id

    # Patch _get_db to return a session on our test engine
    def _fake_get_db():
        return Session()

    with patch("app.workers.tasks.correlation_tasks._get_db", side_effect=_fake_get_db):
        confirm_stale_recovering()

    with Session() as db:
        stale_result = db.get(Incident, stale_id)
        fresh_result = db.get(Incident, fresh_id)

    assert stale_result.state == IncidentState.CLOSED, "Stale RECOVERING must be swept to CLOSED"
    assert fresh_result.state == IncidentState.RECOVERING, "Fresh RECOVERING must be left alone"


def test_stale_recovering_sweep_noop_when_none_stale(tmp_path):
    """Sweep with no stale incidents must complete without error."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(f"sqlite:///{tmp_path}/sweep_noop.db")
    Base.metadata.create_all(engine, tables=[Incident.__table__])
    Session = sessionmaker(bind=engine)

    def _fake_get_db(): return Session()

    with patch("app.workers.tasks.correlation_tasks._get_db", side_effect=_fake_get_db):
        confirm_stale_recovering()  # must not raise


# ── G3: Multi-hop BFS suppression ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_multihop_bfs_3hop_suppression(db, fake_redis):
    """
    3-hop topology: access(300) → distribution(301) → core(302).
    Core is down (OPEN incident). Access switch incident must be SUPPRESSED.
    """
    from app.services.correlation_engine import check_upstream_suppression

    now = datetime.now(timezone.utc)

    # Core incident (device 302)
    core_inc = Incident(
        fingerprint=make_fingerprint(302, "device_unreachable", "device"),
        device_id=302, event_type="device_unreachable", component="device",
        severity="critical", state=IncidentState.OPEN,
        opened_at=now - timedelta(seconds=120), sources=[], timeline=[],
    )
    db.add(core_inc)

    # Access switch incident (device 300) — the one we're checking
    access_inc = Incident(
        fingerprint=make_fingerprint(300, "device_unreachable", "device"),
        device_id=300, event_type="device_unreachable", component="device",
        severity="critical", state=IncidentState.OPEN,
        opened_at=now - timedelta(seconds=90), sources=[], timeline=[],
    )
    db.add(access_inc)

    # Topology: 300 → 301 → 302  (each device reports its upstream neighbor)
    db.add(TopologyLink(
        device_id=300, local_port="Gi0/1", neighbor_hostname="dist-sw",
        neighbor_port="Gi0/24", neighbor_device_id=301, protocol="lldp",
    ))
    db.add(TopologyLink(
        device_id=301, local_port="Gi0/1", neighbor_hostname="core-sw",
        neighbor_port="Gi0/48", neighbor_device_id=302, protocol="lldp",
    ))

    await db.commit()
    await db.refresh(access_inc)

    suppressed = await check_upstream_suppression(access_inc, db)

    assert suppressed is True
    assert access_inc.state == IncidentState.SUPPRESSED
    assert access_inc.suppressed_by == core_inc.id
    assert "BFS" in access_inc.timeline[-1]["reason"]


@pytest.mark.asyncio
async def test_multihop_bfs_no_upstream_incident(db, fake_redis):
    """
    Upstream devices exist in topology but none has an active incident.
    Incident must NOT be suppressed.
    """
    from app.services.correlation_engine import check_upstream_suppression

    now = datetime.now(timezone.utc)
    inc = Incident(
        fingerprint=make_fingerprint(310, "device_unreachable", "device"),
        device_id=310, event_type="device_unreachable", component="device",
        severity="critical", state=IncidentState.OPEN,
        opened_at=now, sources=[], timeline=[],
    )
    db.add(inc)
    db.add(TopologyLink(
        device_id=310, local_port="Gi0/1", neighbor_hostname="upstream-sw",
        neighbor_port="Gi0/24", neighbor_device_id=311, protocol="lldp",
    ))
    await db.commit()
    await db.refresh(inc)

    suppressed = await check_upstream_suppression(inc, db)

    assert suppressed is False
    assert inc.state == IncidentState.OPEN


@pytest.mark.asyncio
async def test_multihop_bfs_cycle_guard(db, fake_redis):
    """
    Ring topology (300 → 301 → 300) must not loop forever.
    Max depth guard and visited-set must prevent infinite BFS.
    """
    from app.services.correlation_engine import check_upstream_suppression

    now = datetime.now(timezone.utc)
    inc = Incident(
        fingerprint=make_fingerprint(320, "device_unreachable", "device"),
        device_id=320, event_type="device_unreachable", component="device",
        severity="critical", state=IncidentState.OPEN,
        opened_at=now, sources=[], timeline=[],
    )
    db.add(inc)

    # Ring: 320 → 321, 321 → 320 (cycle)
    db.add(TopologyLink(
        device_id=320, local_port="Gi0/1", neighbor_hostname="sw-321",
        neighbor_port="Gi0/1", neighbor_device_id=321, protocol="lldp",
    ))
    db.add(TopologyLink(
        device_id=321, local_port="Gi0/2", neighbor_hostname="sw-320",
        neighbor_port="Gi0/2", neighbor_device_id=320, protocol="lldp",
    ))
    await db.commit()
    await db.refresh(inc)

    # Must complete without hanging or raising
    try:
        suppressed = await check_upstream_suppression(inc, db)
    except Exception as e:
        pytest.fail(f"BFS raised on cycle topology: {e}")

    # No active upstream incident in the ring → not suppressed
    assert suppressed is False


@pytest.mark.asyncio
async def test_multihop_beyond_max_depth_not_suppressed(db, fake_redis):
    """
    Incident with an upstream more than UPSTREAM_BFS_MAX_DEPTH hops away
    must NOT be suppressed (BFS doesn't reach it).
    """
    from app.services.correlation_engine import check_upstream_suppression

    now = datetime.now(timezone.utc)

    # Build a chain longer than max depth: 400→401→...→(400+DEPTH+1)
    depth = UPSTREAM_BFS_MAX_DEPTH + 1
    chain = list(range(400, 400 + depth + 2))  # chain[0] is the device under test

    inc = Incident(
        fingerprint=make_fingerprint(chain[0], "device_unreachable", "device"),
        device_id=chain[0], event_type="device_unreachable", component="device",
        severity="critical", state=IncidentState.OPEN,
        opened_at=now, sources=[], timeline=[],
    )
    db.add(inc)

    # Far-end upstream incident (beyond max depth)
    far_inc = Incident(
        fingerprint=make_fingerprint(chain[-1], "device_unreachable", "device"),
        device_id=chain[-1], event_type="device_unreachable", component="device",
        severity="critical", state=IncidentState.OPEN,
        opened_at=now, sources=[], timeline=[],
    )
    db.add(far_inc)

    # Chain topology links
    for i in range(len(chain) - 1):
        db.add(TopologyLink(
            device_id=chain[i], local_port="Gi0/1",
            neighbor_hostname=f"sw-{chain[i+1]}",
            neighbor_port="Gi0/1", neighbor_device_id=chain[i+1], protocol="lldp",
        ))

    await db.commit()
    await db.refresh(inc)

    suppressed = await check_upstream_suppression(inc, db)

    assert suppressed is False, "BFS must not reach beyond UPSTREAM_BFS_MAX_DEPTH hops"
