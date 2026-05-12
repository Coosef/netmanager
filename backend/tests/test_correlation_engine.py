"""
Tests for CorrelationEngine — stateful Incident lifecycle.

Uses an in-memory SQLite database (via SQLAlchemy) and a mock Redis client.
No external services required.

Run with: cd backend && python -m pytest tests/test_correlation_engine.py -v
"""
import asyncio
import hashlib
import sys
import os
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone

import pytest
import pytest_asyncio

# Minimal stubs so we can import correlation_engine without the full FastAPI stack
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ── In-memory DB setup ────────────────────────────────────────────────────────

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase

# Re-use the same Base so Incident metadata is registered
from app.core.database import Base
from app.models.incident import Incident, IncidentState


@pytest_asyncio.fixture
async def db():
    """In-memory async SQLite session — fresh for every test."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        # Only create the Incident table — other registered models use JSONB/PostgreSQL types
        await conn.run_sync(
            lambda c: Base.metadata.create_all(c, tables=[Incident.__table__])
        )

    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session

    await engine.dispose()


@pytest.fixture
def fake_redis():
    """Minimal mock Redis that supports INCR, EXPIRE, EXISTS, SETEX."""
    store = {}
    r = MagicMock()

    def incr(key):
        store[key] = store.get(key, 0) + 1
        return store[key]

    def expire(key, ttl):
        pass  # not needed for unit tests

    def exists(key):
        return int(key in store)

    def setex(key, ttl, value):
        store[key] = value

    def delete(key):
        store.pop(key, None)

    r.incr.side_effect = incr
    r.expire.side_effect = expire
    r.exists.side_effect = exists
    r.setex.side_effect = setex
    r.delete.side_effect = delete
    r._store = store  # expose for assertions
    return r


# ── Import helpers ────────────────────────────────────────────────────────────

from app.services.correlation_engine import (
    make_fingerprint,
    process_event,
    GROUP_WAIT_SEC,
    BOUNCE_GUARD_SEC,
    FLAP_THRESHOLD,
    FLAP_WINDOW_SEC,
)


# ── make_fingerprint ──────────────────────────────────────────────────────────

def test_fingerprint_stable():
    """Same inputs always produce same fingerprint."""
    fp1 = make_fingerprint(42, "device_unreachable", "device")
    fp2 = make_fingerprint(42, "device_unreachable", "device")
    assert fp1 == fp2


def test_fingerprint_case_insensitive():
    fp1 = make_fingerprint(1, "Device_Unreachable", "Device")
    fp2 = make_fingerprint(1, "device_unreachable", "device")
    assert fp1 == fp2


def test_fingerprint_length():
    fp = make_fingerprint(1, "port_down", "GigabitEthernet0/1")
    assert len(fp) == 16


def test_fingerprint_different_inputs():
    fp1 = make_fingerprint(1, "device_unreachable", "device")
    fp2 = make_fingerprint(2, "device_unreachable", "device")
    fp3 = make_fingerprint(1, "port_down", "device")
    assert fp1 != fp2
    assert fp1 != fp3


# ── process_event: group_wait ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_group_wait_absorbs_first_event(db, fake_redis):
    """First problem event starts group_wait — no Incident created immediately."""
    with patch(
        "app.workers.tasks.correlation_tasks.open_incident_after_wait"
    ) as mock_task:
        mock_task.apply_async = MagicMock()

        result = await process_event(
            device_id=1, event_type="device_unreachable", component="device",
            source="agent", is_problem=True, db=db, sync_redis=fake_redis,
        )

    assert result is None  # group_wait pending — no incident yet
    # Celery task must have been scheduled
    mock_task.apply_async.assert_called_once()


@pytest.mark.asyncio
async def test_group_wait_deduplicates_second_call(db, fake_redis):
    """Second call during group_wait is absorbed (key already set)."""
    with patch(
        "app.workers.tasks.correlation_tasks.open_incident_after_wait"
    ) as mock_task:
        mock_task.apply_async = MagicMock()

        await process_event(
            device_id=1, event_type="device_unreachable", component="device",
            source="agent", is_problem=True, db=db, sync_redis=fake_redis,
        )
        # Second call — key already set
        result = await process_event(
            device_id=1, event_type="device_unreachable", component="device",
            source="agent", is_problem=True, db=db, sync_redis=fake_redis,
        )

    assert result is None
    # Only one task scheduled, not two
    assert mock_task.apply_async.call_count == 1


# ── process_event: escalation to DEGRADED ────────────────────────────────────

@pytest.mark.asyncio
async def test_second_source_escalates_to_degraded(db, fake_redis):
    """When 2 different sources confirm a problem, state → DEGRADED."""
    now = datetime.now(timezone.utc)
    fp = make_fingerprint(10, "device_unreachable", "device")

    # Pre-create an OPEN incident (simulating what open_incident_after_wait would do)
    inc = Incident(
        fingerprint=fp, device_id=10, event_type="device_unreachable",
        component="device", severity="critical", state=IncidentState.OPEN,
        opened_at=now, sources=[{"source": "agent", "ts": now.isoformat(), "confidence": 0.8}],
        timeline=[],
    )
    db.add(inc)
    await db.commit()
    await db.refresh(inc)

    # Second confirmation from snmp_poll
    with patch("app.workers.tasks.correlation_tasks.open_incident_after_wait") as mock_task:
        mock_task.apply_async = MagicMock()
        result = await process_event(
            device_id=10, event_type="device_unreachable", component="device",
            source="snmp_poll", is_problem=True, db=db, sync_redis=fake_redis,
        )

    assert result is not None
    assert result.state == IncidentState.DEGRADED
    assert result.degraded_at is not None
    assert "snmp_poll" in result.unique_sources
    assert "agent" in result.unique_sources


# ── process_event: recovery + bounce guard ────────────────────────────────────

@pytest.mark.asyncio
async def test_bounce_guard_blocks_fast_recovery(db, fake_redis):
    """Recovery arriving within BOUNCE_GUARD_SEC is ignored."""
    now = datetime.now(timezone.utc)
    fp = make_fingerprint(20, "device_unreachable", "device")

    inc = Incident(
        fingerprint=fp, device_id=20, event_type="device_unreachable",
        component="device", severity="critical", state=IncidentState.OPEN,
        opened_at=now,  # opened just now
        sources=[], timeline=[],
    )
    db.add(inc)
    await db.commit()

    result = await process_event(
        device_id=20, event_type="device_unreachable", component="device",
        source="agent", is_problem=False, db=db, sync_redis=fake_redis,
    )

    assert result is None  # bounce guard blocked it
    await db.refresh(inc)
    assert inc.state == IncidentState.OPEN  # unchanged


@pytest.mark.asyncio
async def test_recovery_after_bounce_guard_sets_recovering(db, fake_redis):
    """Recovery after BOUNCE_GUARD_SEC transitions to RECOVERING."""
    from datetime import timedelta

    old_open = datetime.now(timezone.utc) - timedelta(seconds=BOUNCE_GUARD_SEC + 10)
    fp = make_fingerprint(30, "device_unreachable", "device")

    inc = Incident(
        fingerprint=fp, device_id=30, event_type="device_unreachable",
        component="device", severity="critical", state=IncidentState.OPEN,
        opened_at=old_open, sources=[], timeline=[],
    )
    db.add(inc)
    await db.commit()

    with patch("app.workers.tasks.correlation_tasks.confirm_recovery") as mock_task:
        mock_task.apply_async = MagicMock()
        result = await process_event(
            device_id=30, event_type="device_unreachable", component="device",
            source="agent", is_problem=False, db=db, sync_redis=fake_redis,
        )

    assert result is not None
    assert result.state == IncidentState.RECOVERING
    assert result.recovering_at is not None
    mock_task.apply_async.assert_called_once()


# ── process_event: flap guard ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_flap_guard_suppresses_storm(db, fake_redis):
    """Events beyond FLAP_THRESHOLD within FLAP_WINDOW are suppressed."""
    with patch("app.workers.tasks.correlation_tasks.open_incident_after_wait") as mock_task:
        mock_task.apply_async = MagicMock()

        results = []
        for _ in range(FLAP_THRESHOLD + 5):
            r = await process_event(
                device_id=99, event_type="device_unreachable", component="device",
                source="agent", is_problem=True, db=db, sync_redis=fake_redis,
            )
            results.append(r)

    # Once flap threshold is exceeded, events return None
    assert results[-1] is None
    # Task was NOT called beyond threshold
    assert mock_task.apply_async.call_count <= FLAP_THRESHOLD


# ── Incident model helpers ────────────────────────────────────────────────────

def test_incident_add_source():
    inc = Incident(sources=[])
    inc.add_source("agent", 0.8)
    inc.add_source("snmp_poll", 0.6)
    assert len(inc.sources) == 2
    assert inc.unique_sources == {"agent", "snmp_poll"}


def test_incident_log_transition():
    inc = Incident(timeline=[])
    inc.log_transition(IncidentState.DEGRADED, "Confirmed by 2 sources")
    assert len(inc.timeline) == 1
    assert inc.timeline[0]["state"] == IncidentState.DEGRADED
    assert "2 sources" in inc.timeline[0]["reason"]
