"""
SLA compliance evaluator for synthetic probes — Faz 4C.

Pure functions — no DB, no I/O. Fully unit-testable.

Design:
  - A single probe failure never constitutes a breach; SLA is window-based.
  - If fewer than _MIN_SAMPLES results exist, evaluation is deferred
    (compliant=True, insufficient_data=True) — safe default for new probes.
  - SLA breach is an observability metric only: it does NOT create incidents
    directly. Per-probe failure transitions (via _needs_problem_event) still
    drive correlation. Incident linking for SLA breach is Faz 4D scope.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Protocol, runtime_checkable

_MIN_SAMPLES = 5  # evaluate only when enough data is present


@runtime_checkable
class ResultLike(Protocol):
    """Duck-typed interface — works with ORM rows and plain objects."""
    success: bool
    latency_ms: Optional[float]


@dataclass(frozen=True)
class SLAStatus:
    compliant: bool
    success_rate_pct: Optional[float]  # None when insufficient_data
    avg_latency_ms: Optional[float]    # None when no latency data or insufficient
    breach_reason: Optional[str]       # "success_rate" | "latency" | None
    window_hours: int
    sample_count: int
    insufficient_data: bool


def compute_sla_status(
    results: list[ResultLike],
    sla_success_rate_pct: float,
    sla_latency_ms: Optional[float],
    window_hours: int,
) -> SLAStatus:
    """
    Compute window-based SLA compliance from a list of probe results.

    results        — all results within the probe's SLA window (caller filters by time)
    sla_success_rate_pct — minimum acceptable success % (e.g. 99.0)
    sla_latency_ms — maximum acceptable average latency, or None to skip check
    window_hours   — informational; used for display only
    """
    n = len(results)
    if n < _MIN_SAMPLES:
        return SLAStatus(
            compliant=True,
            success_rate_pct=None,
            avg_latency_ms=None,
            breach_reason=None,
            window_hours=window_hours,
            sample_count=n,
            insufficient_data=True,
        )

    success_count = sum(1 for r in results if r.success)
    success_rate = success_count / n * 100

    valid_lats = [r.latency_ms for r in results if r.latency_ms is not None]
    avg_latency: Optional[float] = (sum(valid_lats) / len(valid_lats)) if valid_lats else None

    breach_reason: Optional[str] = None
    if success_rate < sla_success_rate_pct:
        breach_reason = "success_rate"
    elif (
        sla_latency_ms is not None
        and avg_latency is not None
        and avg_latency > sla_latency_ms
    ):
        breach_reason = "latency"

    return SLAStatus(
        compliant=breach_reason is None,
        success_rate_pct=round(success_rate, 2),
        avg_latency_ms=round(avg_latency, 2) if avg_latency is not None else None,
        breach_reason=breach_reason,
        window_hours=window_hours,
        sample_count=n,
        insufficient_data=False,
    )
