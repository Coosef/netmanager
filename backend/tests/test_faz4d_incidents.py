"""
Faz 4D — Incident RCA API

Tests for app.api.v1.endpoints.incidents helpers and behavior:
  - _duration() returns correct seconds from opened_at to closed_at
  - _duration() uses now when incident is still open (closed_at=None)
  - _duration() returns None when opened_at is None
  - _sources() returns [] for None sources
  - _sources() returns list for valid sources
  - _timeline() returns [] for None timeline
  - _source_summary() aggregates correctly
  - _source_summary() handles empty input
  - List endpoint: returns empty paginated result when no incidents
  - GET /{id}: returns 404 for non-existent incident
  - GET /{id}/rca: same 404 behavior
"""

import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from app.api.v1.endpoints.incidents import (
    _duration, _sources, _timeline, _source_summary, Incident
)


# ── Pure helper tests ─────────────────────────────────────────────────────────

def _make_incident(**kwargs):
    inc = MagicMock(spec=Incident)
    inc.opened_at = kwargs.get("opened_at")
    inc.closed_at = kwargs.get("closed_at")
    inc.sources   = kwargs.get("sources")
    inc.timeline  = kwargs.get("timeline")
    return inc


def test_duration_closed():
    now = datetime.now(timezone.utc)
    opened = now - timedelta(hours=2)
    closed = now - timedelta(hours=1)
    inc = _make_incident(opened_at=opened, closed_at=closed)
    dur = _duration(inc)
    assert dur == pytest.approx(3600, abs=2)


def test_duration_open_uses_now():
    opened = datetime.now(timezone.utc) - timedelta(minutes=30)
    inc = _make_incident(opened_at=opened, closed_at=None)
    dur = _duration(inc)
    assert dur is not None
    assert 1700 < dur < 1900   # ~1800s ± small delta


def test_duration_no_opened_at():
    inc = _make_incident(opened_at=None, closed_at=None)
    assert _duration(inc) is None


def test_sources_none():
    inc = _make_incident(sources=None)
    assert _sources(inc) == []


def test_sources_list():
    srcs = [{"source": "snmp_trap", "ts": "2026-01-01T00:00:00Z", "confidence": 0.85}]
    inc = _make_incident(sources=srcs)
    assert _sources(inc) == srcs


def test_timeline_none():
    inc = _make_incident(timeline=None)
    assert _timeline(inc) == []


def test_timeline_list():
    tl = [{"ts": "2026-01-01T00:00:00Z", "state": "OPEN", "reason": "first event"}]
    inc = _make_incident(timeline=tl)
    assert _timeline(inc) == tl


def test_source_summary_empty():
    assert _source_summary([]) == {}


def test_source_summary_aggregates():
    srcs = [
        {"source": "snmp_trap"},
        {"source": "syslog"},
        {"source": "snmp_trap"},
        {"source": "synthetic"},
    ]
    s = _source_summary(srcs)
    assert s["snmp_trap"] == 2
    assert s["syslog"] == 1
    assert s["synthetic"] == 1


# ── API endpoint tests (mocked DB) ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_list_incidents_empty():
    """Empty DB → returns empty paginated response."""
    from app.api.v1.endpoints.incidents import list_incidents

    mock_result_total = MagicMock()
    mock_result_total.scalar_one = MagicMock(return_value=0)

    mock_result_rows = MagicMock()
    mock_result_rows.scalars = MagicMock(return_value=MagicMock(all=MagicMock(return_value=[])))

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[mock_result_total, mock_result_rows])

    result = await list_incidents(db=db, current_user=None, state=None, severity=None, device_id=None, hours=168, limit=20, offset=0)
    assert result.total == 0
    assert result.items == []
    assert result.offset == 0
    assert result.limit == 20


@pytest.mark.asyncio
async def test_get_incident_rca_not_found():
    """Non-existent incident ID → 404."""
    from fastapi import HTTPException
    from app.api.v1.endpoints.incidents import get_incident_rca

    db = AsyncMock()
    db.get = AsyncMock(return_value=None)

    with pytest.raises(HTTPException) as exc:
        await get_incident_rca(incident_id=9999, db=db, current_user=None)
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_get_incident_rca_alias_not_found():
    """RCA alias endpoint also returns 404 for missing incident."""
    from fastapi import HTTPException
    from app.api.v1.endpoints.incidents import get_incident_rca_alias

    db = AsyncMock()
    db.get = AsyncMock(return_value=None)

    with pytest.raises(HTTPException) as exc:
        await get_incident_rca_alias(incident_id=1234, db=db, current_user=None)
    assert exc.value.status_code == 404
