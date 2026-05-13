"""
Faz 4C — Synthetic SLA Threshold Evaluator

Tests for app.services.sla_evaluator.compute_sla_status():
  - Fewer than _MIN_SAMPLES results → compliant=True, insufficient_data=True
  - Zero results → same as insufficient
  - Success rate below threshold → breach_reason="success_rate"
  - Success rate at or above threshold → compliant
  - Latency threshold breach → breach_reason="latency"
  - Latency threshold=None → no latency breach
  - success_rate breach takes priority over latency breach
  - Exact threshold boundary → compliant (not a breach)
  - Null latency_ms values excluded from avg computation
  - All-null latency rows → avg_latency_ms=None (no latency breach possible)
"""

import pytest
from dataclasses import dataclass
from typing import Optional

from app.services.sla_evaluator import compute_sla_status, _MIN_SAMPLES


# ── Fixture helpers ───────────────────────────────────────────────────────────

@dataclass
class R:
    """Minimal ResultLike stand-in."""
    success: bool
    latency_ms: Optional[float] = None


def _ok(lat=None):  return R(success=True,  latency_ms=lat)
def _fail(lat=None): return R(success=False, latency_ms=lat)


def _results(n_ok: int, n_fail: int, lat_ok=1.0, lat_fail=None):
    return [_ok(lat_ok)] * n_ok + [_fail(lat_fail)] * n_fail


# ── Insufficient data ─────────────────────────────────────────────────────────

def test_zero_results_insufficient():
    s = compute_sla_status([], 99.0, None, 24)
    assert s.insufficient_data is True
    assert s.compliant is True
    assert s.sample_count == 0


def test_below_min_samples_insufficient():
    s = compute_sla_status([_ok()] * (_MIN_SAMPLES - 1), 99.0, None, 24)
    assert s.insufficient_data is True
    assert s.compliant is True
    assert s.success_rate_pct is None
    assert s.avg_latency_ms is None


def test_exactly_min_samples_evaluates():
    s = compute_sla_status([_ok()] * _MIN_SAMPLES, 99.0, None, 24)
    assert s.insufficient_data is False


# ── Success rate ──────────────────────────────────────────────────────────────

def test_success_rate_breach():
    """40% success vs 99% threshold → breach."""
    s = compute_sla_status(_results(4, 6), 99.0, None, 24)
    assert s.compliant is False
    assert s.breach_reason == "success_rate"
    assert s.success_rate_pct == pytest.approx(40.0)


def test_success_rate_compliant():
    """100% success → compliant."""
    s = compute_sla_status(_results(10, 0), 99.0, None, 24)
    assert s.compliant is True
    assert s.breach_reason is None
    assert s.success_rate_pct == pytest.approx(100.0)


def test_success_rate_exact_threshold_is_compliant():
    """success_rate == threshold → NOT a breach (boundary condition)."""
    # 99 out of 100 = 99.0% which equals the threshold → compliant
    s = compute_sla_status(_results(99, 1), 99.0, None, 24)
    assert s.compliant is True
    assert s.success_rate_pct == pytest.approx(99.0)


# ── Latency ───────────────────────────────────────────────────────────────────

def test_latency_breach():
    """Avg latency above threshold → breach_reason='latency'."""
    results = [_ok(200.0)] * _MIN_SAMPLES  # all success, high latency
    s = compute_sla_status(results, 99.0, 100.0, 24)
    assert s.compliant is False
    assert s.breach_reason == "latency"
    assert s.avg_latency_ms == pytest.approx(200.0)


def test_latency_compliant():
    """Avg latency below threshold → compliant."""
    results = [_ok(50.0)] * _MIN_SAMPLES
    s = compute_sla_status(results, 99.0, 100.0, 24)
    assert s.compliant is True
    assert s.breach_reason is None


def test_latency_threshold_none_no_breach():
    """sla_latency_ms=None → latency is not checked, high latency OK."""
    results = [_ok(9999.0)] * _MIN_SAMPLES
    s = compute_sla_status(results, 99.0, None, 24)
    assert s.compliant is True
    assert s.breach_reason is None


def test_success_rate_breach_takes_priority_over_latency():
    """When both conditions fail, breach_reason='success_rate' (checked first)."""
    # 4/10 success (breach) + high latency (also breach)
    results = [_ok(500.0)] * 4 + [_fail(500.0)] * 6
    s = compute_sla_status(results, 99.0, 100.0, 24)
    assert s.breach_reason == "success_rate"


def test_null_latency_excluded_from_avg():
    """latency_ms=None rows must not affect average calculation."""
    results = [_ok(10.0)] * 3 + [_ok(None)] * 2  # 3 with 10ms, 2 with no latency
    s = compute_sla_status(results, 99.0, 100.0, 24)
    assert s.avg_latency_ms == pytest.approx(10.0)
    assert s.compliant is True


def test_all_null_latency_no_avg():
    """All latency_ms=None → avg_latency_ms=None, no latency breach."""
    results = [_ok(None)] * _MIN_SAMPLES
    s = compute_sla_status(results, 99.0, 50.0, 24)
    assert s.avg_latency_ms is None
    assert s.compliant is True  # no latency data → can't breach latency SLA


# ── Metadata ──────────────────────────────────────────────────────────────────

def test_window_hours_passed_through():
    s = compute_sla_status(_results(10, 0), 99.0, None, 72)
    assert s.window_hours == 72


def test_sample_count_correct():
    s = compute_sla_status(_results(7, 3), 99.0, None, 24)
    assert s.sample_count == 10
