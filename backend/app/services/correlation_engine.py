"""
Correlation Engine — Faz 1 MVP

Converts raw monitoring events into stateful Incidents.

Design principles:
- Additive: NetworkEvent writes are unchanged; this layer sits on top.
- Non-blocking: all heavy work is delegated to Celery tasks.
- Idempotent: duplicate calls for the same fingerprint converge safely.
- Conservative: group_wait prevents noise from transient blips.

State machine:
  OPEN → DEGRADED (2+ independent sources confirmed) → RECOVERING → CLOSED
       ↘ SUPPRESSED (upstream also down — cascade, not a root cause)
"""

import hashlib
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.incident import Incident, IncidentState

log = logging.getLogger(__name__)

# ── Timing constants ──────────────────────────────────────────────────────────
GROUP_WAIT_SEC       = 30    # buffer before opening — filters single-poll glitches
BOUNCE_GUARD_SEC     = 60    # min open duration before RECOVERING is accepted
RECOVERY_CONFIRM_SEC = 120   # RECOVERING → CLOSED confirmation window
UPSTREAM_SETTLE_SEC  = 35    # wait for upstream status before suppressing downstream
FLAP_WINDOW_SEC      = 300   # sliding window for flap detection
FLAP_THRESHOLD       = 8     # events in window → suppress as flapping

# ── Source confidence weights ─────────────────────────────────────────────────
SOURCE_CONFIDENCE: dict[str, float] = {
    "gnmi":      1.00,
    "synthetic": 0.90,
    "agent":     0.80,   # device_status_report from agent health check
    "snmp_trap": 0.85,
    "syslog":    0.70,
    "snmp_poll": 0.60,
    "ssh_log":   0.40,
}


def make_fingerprint(device_id: int, event_type: str, component: str) -> str:
    """
    Stable 16-char identifier for (device, event_type, component).
    Same tuple always produces the same fingerprint — used for dedup.
    """
    raw = f"{device_id}:{event_type}:{component}".lower()
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


async def process_event(
    *,
    device_id: int,
    event_type: str,
    component: str,
    source: str,
    is_problem: bool,
    db: AsyncSession,
    sync_redis,          # sync redis.Redis client — matches existing agent_manager pattern
    severity: str = "warning",
) -> Incident | None:
    """
    Core entry point. Call this after writing a NetworkEvent.

    Uses a sync Redis client (same pattern as the rest of agent_manager.py)
    for fast atomic ops (INCR, EXPIRE, EXISTS, SETEX).

    Returns the affected Incident or None (suppressed / group_wait pending).
    """
    fp = make_fingerprint(device_id, event_type, component)
    confidence = SOURCE_CONFIDENCE.get(source, 0.5)

    # ── 1. Flap guard (Redis counter) ─────────────────────────────────────
    flap_key = f"corr:flap:{fp}"
    try:
        flap_count = sync_redis.incr(flap_key)
        if flap_count == 1:
            sync_redis.expire(flap_key, FLAP_WINDOW_SEC)
    except Exception:
        flap_count = 0  # Redis unavailable — don't drop the event

    if flap_count > FLAP_THRESHOLD:
        log.debug("corr: flap-suppressed %s (count=%d)", fp, flap_count)
        return None

    # ── 2. Find active incident for this fingerprint ───────────────────────
    result = await db.execute(
        select(Incident)
        .where(
            Incident.fingerprint == fp,
            Incident.state.not_in([IncidentState.CLOSED, IncidentState.SUPPRESSED]),
        )
        .order_by(Incident.opened_at.desc())
        .limit(1)
    )
    incident: Incident | None = result.scalar_one_or_none()

    if is_problem:
        result = await _handle_problem(
            fp, device_id, event_type, component, source,
            severity, confidence, incident, db, sync_redis,
        )
    else:
        result = await _handle_recovery(incident, source, db)

    # Faz 6B G4: invalidate aggregation cache for this event.
    # Non-fatal; cache_invalidation itself swallows Redis errors, but we
    # also guard against import failures so correlation never breaks.
    try:
        from app.services.cache_invalidation import invalidate_for_event
        invalidate_for_event(sync_redis, device_id, event_type)
    except Exception:
        log.debug("corr: cache invalidation failed (non-fatal)", exc_info=True)

    return result


# ── Problem path ──────────────────────────────────────────────────────────────

async def _handle_problem(
    fp, device_id, event_type, component, source,
    severity, confidence, incident, db, sync_redis,
):
    now = datetime.now(timezone.utc)

    if incident is None:
        # group_wait: only open if no pending token exists
        gw_key = f"corr:gw:{fp}"
        try:
            already_pending = sync_redis.exists(gw_key)
        except Exception:
            already_pending = False

        if already_pending:
            return None  # group_wait is still running — absorb duplicate

        try:
            # TTL is GROUP_WAIT_SEC + 15 so the key outlives the task's countdown
            # and is still present when open_incident_after_wait checks it.
            sync_redis.setex(gw_key, GROUP_WAIT_SEC + 15, "1")
        except Exception:
            pass

        # Delegate actual creation to a Celery task after GROUP_WAIT_SEC
        try:
            from app.workers.tasks.correlation_tasks import open_incident_after_wait
            open_incident_after_wait.apply_async(
                kwargs=dict(
                    device_id=device_id,
                    event_type=event_type,
                    component=component,
                    source=source,
                    severity=severity,
                    confidence=confidence,
                ),
                countdown=GROUP_WAIT_SEC,
            )
            log.debug("corr: group_wait started for %s (device=%d)", fp, device_id)
        except Exception as task_err:
            # Celery broker unreachable — clear the group_wait key so the next
            # event can retry scheduling rather than being permanently absorbed.
            log.warning("corr: failed to schedule open_incident_after_wait for %s: %s", fp, task_err)
            try:
                sync_redis.delete(gw_key)
            except Exception:
                pass
        return None

    # Incident already open — add this source, maybe escalate to DEGRADED
    incident.add_source(source, confidence)

    if (
        len(incident.unique_sources) >= 2
        and incident.state == IncidentState.OPEN
    ):
        incident.state = IncidentState.DEGRADED
        incident.degraded_at = now
        incident.log_transition(
            IncidentState.DEGRADED,
            f"Confirmed by multiple sources: {sorted(incident.unique_sources)}",
        )
        log.info("corr: incident #%d DEGRADED (device=%d, sources=%s)",
                 incident.id, device_id, incident.unique_sources)

    await db.commit()
    return incident


# ── Recovery path ─────────────────────────────────────────────────────────────

async def _handle_recovery(incident: Incident | None, source: str, db: AsyncSession):
    if incident is None:
        return None

    now = datetime.now(timezone.utc)
    open_duration = (now - incident.opened_at).total_seconds()

    if open_duration < BOUNCE_GUARD_SEC:
        log.debug("corr: bounce-guard absorbed recovery for incident #%d", incident.id)
        return None

    if incident.state not in (IncidentState.CLOSED, IncidentState.SUPPRESSED):
        incident.state = IncidentState.RECOVERING
        incident.recovering_at = now
        incident.log_transition(
            IncidentState.RECOVERING,
            f"Cleared by {source}",
        )
        await db.commit()

        try:
            from app.workers.tasks.correlation_tasks import confirm_recovery
            confirm_recovery.apply_async(
                kwargs={"incident_id": incident.id},
                countdown=RECOVERY_CONFIRM_SEC,
            )
            log.info("corr: incident #%d RECOVERING (will confirm in %ds)",
                     incident.id, RECOVERY_CONFIRM_SEC)
        except Exception as task_err:
            # Broker unreachable — incident stays RECOVERING; the periodic
            # recovery sweeper (Faz 2) will close it. Log for observability.
            log.warning("corr: failed to schedule confirm_recovery for #%d: %s",
                        incident.id, task_err)

    return incident


# ── Upstream suppression (multi-hop BFS) ─────────────────────────────────────

# Maximum hops to traverse when looking for an upstream root-cause incident.
# Covers access → distribution → core topologies (typically 2-3 hops).
UPSTREAM_BFS_MAX_DEPTH = 5


async def check_upstream_suppression(incident: Incident, db: AsyncSession) -> bool:
    """
    BFS upstream traversal — find whether any ancestor device has an active
    incident, and if so suppress this one as a cascade.

    Uses TopologyLink: TopologyLink(device_id=X, neighbor_device_id=Y) means
    "device X discovered Y as its LLDP/CDP upstream neighbor."
    So upstreams of X = {Y for TopologyLink where device_id == X}.

    Fetches all links in one query and does BFS in-memory — avoids N+1 queries
    on large topologies.  Max depth = UPSTREAM_BFS_MAX_DEPTH (cycle guard via
    visited set).

    Call after GROUP_WAIT_SEC so upstream status has had time to settle
    (Statseeker 35s pattern).  Returns True if incident was suppressed.
    """
    from sqlalchemy import select as sa_select
    from app.models.topology import TopologyLink

    # Single query: all topology links (upstream_of map)
    all_links = (await db.execute(
        sa_select(TopologyLink.device_id, TopologyLink.neighbor_device_id)
        .where(TopologyLink.neighbor_device_id.is_not(None))
    )).fetchall()

    if not all_links:
        return False

    # upstream_of[X] = set of direct upstream neighbors of X
    upstream_of: dict[int, set[int]] = {}
    for dev_id, nbr_id in all_links:
        upstream_of.setdefault(dev_id, set()).add(nbr_id)

    # BFS from incident.device_id upward
    visited: set[int] = set()
    frontier = list(upstream_of.get(incident.device_id, []))
    depth = 0
    while frontier and depth < UPSTREAM_BFS_MAX_DEPTH:
        next_frontier: list[int] = []
        for node in frontier:
            if node in visited:
                continue
            visited.add(node)
            next_frontier.extend(upstream_of.get(node, []))
        frontier = next_frontier
        depth += 1

    # Remove the incident's own device — it can't be its own upstream suppressor
    visited.discard(incident.device_id)
    if not visited:
        return False

    # Does any reachable upstream device have an active incident?
    upstream_inc_result = await db.execute(
        sa_select(Incident)
        .where(
            Incident.device_id.in_(visited),
            Incident.event_type.in_(["device_unreachable", "port_down", "device_restart"]),
            Incident.state.in_([IncidentState.OPEN, IncidentState.DEGRADED]),
        )
        .limit(1)
    )
    upstream_inc = upstream_inc_result.scalar_one_or_none()
    if not upstream_inc:
        return False

    incident.state        = IncidentState.SUPPRESSED
    incident.suppressed_by = upstream_inc.id
    incident.log_transition(
        IncidentState.SUPPRESSED,
        f"Upstream incident #{upstream_inc.id} active (device_id={upstream_inc.device_id}, "
        f"BFS depth ≤ {UPSTREAM_BFS_MAX_DEPTH})",
    )
    await db.commit()
    log.info("corr: incident #%d SUPPRESSED by upstream incident #%d (BFS, depth≤%d)",
             incident.id, upstream_inc.id, UPSTREAM_BFS_MAX_DEPTH)
    return True
