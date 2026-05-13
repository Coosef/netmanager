"""
Availability Scoring Task — Faz 3A

Computes per-device availability metrics daily from incident history.
All functions are pure (no I/O) to make them directly unit-testable.

Metrics written to Device:
  availability_24h  — fraction of last 24 h without active incidents (0.0–1.0)
  availability_7d   — same for last 7 days
  mtbf_hours        — mean time between failures over last 7 days (hours)
  experience_score  — composite quality-of-service score (0.0–1.0)

Each run also appends a DeviceAvailabilitySnapshot row for trend history.

KL-6 (resolved Faz 3A): overlapping incident intervals are now merged before
summing downtime, so concurrent incidents on the same device no longer
double-count downtime. SUPPRESSED incidents remain excluded.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)

# ── Scoring constants ─────────────────────────────────────────────────────────

SEVERITY_PENALTY: dict[str, float] = {
    "critical": 0.70,
    "warning":  0.30,
    "info":     0.05,
}

_24H_SECS  = 86_400.0
_7D_SECS   = 604_800.0
_7D_HOURS  = 168.0


# ══════════════════════════════════════════════════════════════════════════════
# Pure helpers — no I/O, fully unit-testable
# ══════════════════════════════════════════════════════════════════════════════

def _merge_intervals(
    intervals: list[tuple[datetime, datetime]],
) -> list[tuple[datetime, datetime]]:
    """
    Merge overlapping or adjacent datetime intervals.

    Input must not be empty. Intervals are sorted by start before merging.
    Example: [(t0,t2),(t1,t3)] → [(t0,t3)] when t1 < t2.
    """
    sorted_ivs = sorted(intervals, key=lambda x: x[0])
    merged: list[list] = [list(sorted_ivs[0])]
    for start, end in sorted_ivs[1:]:
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(s, e) for s, e in merged]


def compute_downtime_secs(
    incidents: list,
    window_start: datetime,
    window_end: datetime,
) -> float:
    """
    Total seconds the device was in a non-SUPPRESSED incident state within
    [window_start, window_end].

    CLOSED incidents:                opened_at … closed_at (clipped to window)
    OPEN / DEGRADED / RECOVERING:    opened_at … window_end (still active)
    SUPPRESSED:                      0 s (cascade event, not a local fault)

    Overlapping incident intervals are merged before summing (KL-6 resolved).
    """
    from app.models.incident import IncidentState

    window_secs = (window_end - window_start).total_seconds()
    if window_secs <= 0:
        return 0.0

    raw_intervals: list[tuple[datetime, datetime]] = []

    for inc in incidents:
        if inc.state == IncidentState.SUPPRESSED:
            continue

        inc_start = inc.opened_at
        if inc_start is None:
            continue

        if inc.state == IncidentState.CLOSED:
            inc_end = inc.closed_at or window_end
        else:
            inc_end = window_end

        # Clip to window
        effective_start = max(inc_start, window_start)
        effective_end   = min(inc_end,   window_end)

        if effective_end > effective_start:
            raw_intervals.append((effective_start, effective_end))

    if not raw_intervals:
        return 0.0

    merged = _merge_intervals(raw_intervals)
    return sum((e - s).total_seconds() for s, e in merged)


def compute_availability(downtime_secs: float, window_secs: float) -> float:
    """(window - downtime) / window, clamped to [0.0, 1.0]."""
    if window_secs <= 0:
        return 1.0
    raw = (window_secs - downtime_secs) / window_secs
    return max(0.0, min(1.0, raw))


def compute_mtbf_hours(
    incidents: list,
    window_start: datetime,
    window_end: datetime,
) -> float | None:
    """
    MTBF = window_hours / closed_incident_count.
    Returns None when there are fewer than 1 closed incidents
    (insufficient failure history).
    SUPPRESSED incidents excluded.
    """
    from app.models.incident import IncidentState

    window_hours = (window_end - window_start).total_seconds() / 3600.0
    closed_count = sum(
        1 for inc in incidents
        if inc.state == IncidentState.CLOSED
        and inc.state != IncidentState.SUPPRESSED
    )
    if closed_count < 1:
        return None
    return window_hours / closed_count


def compute_experience_score(
    availability_24h: float,
    last_severity: str,
    last_source: str | None,
) -> float:
    """
    Composite experience score (0.0–1.0):

      experience_score = availability_24h * 0.50
                       + (1 - severity_penalty) * 0.30
                       + source_confidence * 0.20

    last_severity: severity string of most recent incident; "info" when none
    last_source:   source key of first entry in incident.sources; None → 1.0
                   (no incidents = perfect source confidence)
    """
    from app.services.correlation_engine import SOURCE_CONFIDENCE

    severity_pen = SEVERITY_PENALTY.get(last_severity, SEVERITY_PENALTY["warning"])
    source_conf  = SOURCE_CONFIDENCE.get(last_source, 1.0) if last_source else 1.0

    score = (
        availability_24h * 0.50
        + (1.0 - severity_pen) * 0.30
        + source_conf * 0.20
    )
    return max(0.0, min(1.0, score))


# ══════════════════════════════════════════════════════════════════════════════
# Async runner + Celery task
# ══════════════════════════════════════════════════════════════════════════════

async def _run():
    from sqlalchemy import select
    from app.core.database import make_worker_session
    from app.models.device import Device
    from app.models.incident import Incident
    from app.models.device_availability_snapshot import DeviceAvailabilitySnapshot

    now   = datetime.now(timezone.utc)
    w24   = now - timedelta(hours=24)
    w7d   = now - timedelta(days=7)

    updated = 0
    async with make_worker_session()() as db:
        device_ids = (await db.execute(
            select(Device.id).where(Device.is_active == True)  # noqa: E712
        )).scalars().all()

        for device_id in device_ids:
            incidents = (await db.execute(
                select(Incident).where(
                    Incident.device_id == device_id,
                    Incident.opened_at >= w7d,
                )
            )).scalars().all()

            dt_24h    = compute_downtime_secs(incidents, w24, now)
            dt_7d     = compute_downtime_secs(incidents, w7d, now)
            avail_24h = compute_availability(dt_24h, _24H_SECS)
            avail_7d  = compute_availability(dt_7d,  _7D_SECS)
            mtbf      = compute_mtbf_hours(incidents, w7d, now)

            # Most recent incident drives severity/source for experience score
            last_inc  = max(incidents, key=lambda i: i.opened_at, default=None)
            last_sev  = last_inc.severity if last_inc else "info"
            last_src  = None
            if last_inc and last_inc.sources:
                last_src = last_inc.sources[0].get("source") if last_inc.sources else None

            exp = compute_experience_score(avail_24h, last_sev, last_src)

            dev = await db.get(Device, device_id)
            if dev:
                dev.availability_24h = avail_24h
                dev.availability_7d  = avail_7d
                dev.mtbf_hours       = mtbf
                dev.experience_score = exp
                db.add(DeviceAvailabilitySnapshot(
                    device_id=device_id,
                    ts=now,
                    availability_24h=avail_24h,
                    availability_7d=avail_7d,
                    mtbf_hours=mtbf,
                    experience_score=exp,
                ))
                updated += 1

        await db.commit()

    log.info("availability: scored %d device(s)", updated)


@celery_app.task(
    name="app.workers.tasks.availability_tasks.compute_availability_scores",
    max_retries=1,
    default_retry_delay=300,
)
def compute_availability_scores():
    """Daily task — compute availability metrics for all active devices."""
    asyncio.run(_run())
