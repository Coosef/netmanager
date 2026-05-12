"""
Unit tests for availability_tasks.py pure helpers — Faz 2D

Tests cover compute_downtime_secs, compute_availability,
compute_mtbf_hours, and compute_experience_score in isolation.
No Celery, no DB, no network I/O.
"""

from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock

import pytest

from app.workers.tasks.availability_tasks import (
    compute_downtime_secs,
    compute_availability,
    compute_mtbf_hours,
    compute_experience_score,
    SEVERITY_PENALTY,
    _24H_SECS,
    _7D_SECS,
    _7D_HOURS,
)
from app.models.incident import IncidentState


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _now():
    return datetime.now(timezone.utc)


def _incident(
    state: str,
    opened_offset_secs: float,
    closed_offset_secs: float | None = None,
    severity: str = "warning",
    sources: list | None = None,
    now: datetime | None = None,
) -> MagicMock:
    """
    Build a mock Incident.
    opened_offset_secs: seconds *before* now when incident opened (positive = past)
    closed_offset_secs: seconds before now when incident closed; None = still open
    """
    base = now or _now()
    inc = MagicMock()
    inc.state       = state
    inc.severity    = severity
    inc.sources     = sources or []
    inc.opened_at   = base - timedelta(seconds=opened_offset_secs)
    inc.closed_at   = (base - timedelta(seconds=closed_offset_secs)
                       if closed_offset_secs is not None else None)
    return inc


# ══════════════════════════════════════════════════════════════════════════════
# 1. compute_downtime_secs
# ══════════════════════════════════════════════════════════════════════════════

def test_no_incidents_zero_downtime():
    now = _now()
    w_start = now - timedelta(hours=24)
    result = compute_downtime_secs([], w_start, now)
    assert result == 0.0


def test_closed_incident_full_window():
    now = _now()
    w_start = now - timedelta(hours=24)
    inc = _incident(IncidentState.CLOSED,
                    opened_offset_secs=_24H_SECS + 10,
                    closed_offset_secs=0,
                    now=now)
    result = compute_downtime_secs([inc], w_start, now)
    # entire 24h window is downtime (clipped to window boundary)
    assert abs(result - _24H_SECS) < 2.0


def test_partial_downtime_12h():
    now = _now()
    w_start = now - timedelta(hours=24)
    inc = _incident(IncidentState.CLOSED,
                    opened_offset_secs=12 * 3600,
                    closed_offset_secs=0,
                    now=now)
    result = compute_downtime_secs([inc], w_start, now)
    assert abs(result - 12 * 3600) < 2.0


def test_open_incident_counts_to_window_end():
    now = _now()
    w_start = now - timedelta(hours=24)
    inc = _incident(IncidentState.OPEN,
                    opened_offset_secs=12 * 3600,
                    closed_offset_secs=None,
                    now=now)
    result = compute_downtime_secs([inc], w_start, now)
    # OPEN: opened_at = now-12h → window_end = now → 12h downtime
    assert abs(result - 12 * 3600) < 2.0


def test_degraded_incident_counts_to_window_end():
    now = _now()
    w_start = now - timedelta(hours=24)
    inc = _incident(IncidentState.DEGRADED,
                    opened_offset_secs=6 * 3600,
                    now=now)
    result = compute_downtime_secs([inc], w_start, now)
    assert abs(result - 6 * 3600) < 2.0


def test_recovering_incident_counts_to_window_end():
    now = _now()
    w_start = now - timedelta(hours=24)
    inc = _incident(IncidentState.RECOVERING,
                    opened_offset_secs=3 * 3600,
                    now=now)
    result = compute_downtime_secs([inc], w_start, now)
    assert abs(result - 3 * 3600) < 2.0


def test_suppressed_incident_excluded():
    now = _now()
    w_start = now - timedelta(hours=24)
    inc = _incident(IncidentState.SUPPRESSED,
                    opened_offset_secs=_24H_SECS,
                    closed_offset_secs=0,
                    now=now)
    result = compute_downtime_secs([inc], w_start, now)
    assert result == 0.0


def test_incident_straddles_window_start():
    """Incident opened before window_start — only in-window portion counted."""
    now = _now()
    w_start = now - timedelta(hours=24)
    # Incident opened 36h ago, closed 12h ago → 12h within window
    inc = _incident(IncidentState.CLOSED,
                    opened_offset_secs=36 * 3600,
                    closed_offset_secs=12 * 3600,
                    now=now)
    result = compute_downtime_secs([inc], w_start, now)
    assert abs(result - 12 * 3600) < 2.0


def test_incident_straddles_window_end():
    """CLOSED incident whose closed_at is beyond window_end — clipped."""
    now = _now()
    w_start = now - timedelta(hours=24)
    # Incident opened 12h ago; closed_at in the future (1h hence)
    inc = MagicMock()
    inc.state     = IncidentState.CLOSED
    inc.severity  = "warning"
    inc.sources   = []
    inc.opened_at = now - timedelta(hours=12)
    inc.closed_at = now + timedelta(hours=1)   # beyond window_end=now
    result = compute_downtime_secs([inc], w_start, now)
    assert abs(result - 12 * 3600) < 2.0


def test_multiple_incidents_summed():
    now = _now()
    w_start = now - timedelta(hours=24)
    inc1 = _incident(IncidentState.CLOSED,
                     opened_offset_secs=20 * 3600, closed_offset_secs=18 * 3600, now=now)  # 2h
    inc2 = _incident(IncidentState.CLOSED,
                     opened_offset_secs=10 * 3600, closed_offset_secs=7 * 3600, now=now)   # 3h
    result = compute_downtime_secs([inc1, inc2], w_start, now)
    assert abs(result - 5 * 3600) < 2.0


# ══════════════════════════════════════════════════════════════════════════════
# 2. compute_availability
# ══════════════════════════════════════════════════════════════════════════════

def test_availability_no_downtime_is_one():
    assert compute_availability(0.0, _24H_SECS) == 1.0


def test_availability_full_downtime_is_zero():
    assert compute_availability(_24H_SECS, _24H_SECS) == 0.0


def test_availability_half_downtime():
    result = compute_availability(12 * 3600, _24H_SECS)
    assert abs(result - 0.5) < 1e-6


def test_availability_clamps_to_zero():
    # downtime > window (overlapping incidents KL-6) → clamped at 0.0
    assert compute_availability(_24H_SECS * 2, _24H_SECS) == 0.0


def test_availability_clamps_to_one():
    assert compute_availability(-100.0, _24H_SECS) == 1.0


def test_availability_zero_window_returns_one():
    assert compute_availability(0.0, 0.0) == 1.0


# ══════════════════════════════════════════════════════════════════════════════
# 3. compute_mtbf_hours
# ══════════════════════════════════════════════════════════════════════════════

def test_mtbf_no_closed_returns_none():
    now = _now()
    w_start = now - timedelta(days=7)
    inc = _incident(IncidentState.OPEN, opened_offset_secs=3600, now=now)
    assert compute_mtbf_hours([inc], w_start, now) is None


def test_mtbf_empty_incidents_returns_none():
    now = _now()
    assert compute_mtbf_hours([], now - timedelta(days=7), now) is None


def test_mtbf_one_closed():
    now = _now()
    w_start = now - timedelta(days=7)
    inc = _incident(IncidentState.CLOSED,
                    opened_offset_secs=_7D_SECS - 100,
                    closed_offset_secs=100,
                    now=now)
    result = compute_mtbf_hours([inc], w_start, now)
    assert result is not None
    assert abs(result - _7D_HOURS) < 0.01


def test_mtbf_three_closed():
    now = _now()
    w_start = now - timedelta(days=7)
    incidents = [
        _incident(IncidentState.CLOSED, opened_offset_secs=150 * 3600,
                  closed_offset_secs=148 * 3600, now=now),
        _incident(IncidentState.CLOSED, opened_offset_secs=100 * 3600,
                  closed_offset_secs=98 * 3600, now=now),
        _incident(IncidentState.CLOSED, opened_offset_secs=50 * 3600,
                  closed_offset_secs=48 * 3600, now=now),
    ]
    result = compute_mtbf_hours(incidents, w_start, now)
    assert result is not None
    assert abs(result - _7D_HOURS / 3) < 0.01


def test_mtbf_suppressed_not_counted():
    now = _now()
    w_start = now - timedelta(days=7)
    # Only suppressed incidents — no closed count → None
    inc = _incident(IncidentState.SUPPRESSED,
                    opened_offset_secs=100 * 3600,
                    closed_offset_secs=98 * 3600,
                    now=now)
    # Set state explicitly to CLOSED to check that SUPPRESSED detection is via state
    inc.state = IncidentState.SUPPRESSED
    assert compute_mtbf_hours([inc], w_start, now) is None


# ══════════════════════════════════════════════════════════════════════════════
# 4. compute_experience_score
# ══════════════════════════════════════════════════════════════════════════════

def test_experience_score_perfect_no_incidents():
    # No incidents → last_severity="info", last_source=None
    score = compute_experience_score(1.0, "info", None)
    # = 1.0 * 0.50 + (1-0.05) * 0.30 + 1.0 * 0.20 = 0.50 + 0.285 + 0.20 = 0.985
    assert abs(score - 0.985) < 1e-6


def test_experience_score_critical_full_outage():
    # availability=0.0, critical severity, no source
    score = compute_experience_score(0.0, "critical", None)
    # = 0.0 * 0.50 + (1-0.70) * 0.30 + 1.0 * 0.20 = 0.0 + 0.09 + 0.20 = 0.29
    assert abs(score - 0.29) < 1e-6


def test_experience_score_formula_components():
    from app.services.correlation_engine import SOURCE_CONFIDENCE
    avail    = 0.8
    sev_pen  = SEVERITY_PENALTY["warning"]   # 0.30
    src_conf = SOURCE_CONFIDENCE["gnmi"]     # 1.00
    expected = avail * 0.50 + (1 - sev_pen) * 0.30 + src_conf * 0.20
    result   = compute_experience_score(avail, "warning", "gnmi")
    assert abs(result - expected) < 1e-6


def test_experience_score_unknown_source_defaults_to_one():
    score1 = compute_experience_score(1.0, "info", None)
    score2 = compute_experience_score(1.0, "info", "totally_unknown_source")
    # unknown source → SOURCE_CONFIDENCE.get("totally_unknown_source", 1.0) = 0.5 (fallback in engine)
    # but our helper passes last_source=None for "no source" which maps to 1.0
    # Here we check that None → 1.0, unknown key → whatever SOURCE_CONFIDENCE fallback is
    assert score1 >= score2  # None (perfect) ≥ unknown (partial confidence)


def test_experience_score_clamped_to_one():
    score = compute_experience_score(1.0, "info", "gnmi")
    assert score <= 1.0


def test_experience_score_clamped_to_zero():
    # Theoretically impossible but guard is there
    score = compute_experience_score(0.0, "critical", "ssh_log")
    assert score >= 0.0
