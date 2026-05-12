"""
Correlation Engine Celery tasks — Faz 2C

Tasks:
  open_incident_after_wait    — creates an Incident after group_wait expires
  confirm_recovery            — ping-verifies recovery before closing (Faz 2C)
  confirm_stale_recovering    — periodic sweep: closes stuck RECOVERING incidents
"""
import logging
import subprocess
import sys
from datetime import datetime, timezone

import redis as redis_sync
from sqlalchemy import select

from app.core.config import settings
from app.models.incident import Incident, IncidentState
from app.services.correlation_engine import (
    make_fingerprint,
    RECOVERY_CONFIRM_SEC,
    SOURCE_CONFIDENCE,
)
from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)

_redis = redis_sync.from_url(settings.REDIS_URL, decode_responses=True)


def _get_db():
    from app.core.database import SyncSessionLocal
    return SyncSessionLocal()


# ─────────────────────────────────────────────────────────────────────────────
# Sync ICMP ping helper — used by confirm_recovery (Celery task, sync context)
# ─────────────────────────────────────────────────────────────────────────────

def _ping_sync(ip: str, timeout: int = 3) -> bool | None:
    """
    Synchronous ICMP ping for Celery task context.

    Returns:
      True  — host responded (reachable)
      False — host did not respond (unreachable, ping completed cleanly)
      None  — ping mechanism failed (subprocess error, timeout, binary missing)
              Callers should treat None as "unknown" and fall back to CLOSED.
    """
    flag = "-n" if sys.platform == "win32" else "-c"
    w_flag = ["-w", str(timeout * 1000)] if sys.platform == "win32" else ["-W", str(timeout)]
    try:
        result = subprocess.run(
            ["ping", flag, "1", *w_flag, ip],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout + 2,
        )
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        return None   # mechanism timeout — caller fallback
    except Exception:
        return None   # binary missing, permission error, etc. — caller fallback


# ─────────────────────────────────────────────────────────────────────────────
# Task 1 — open_incident_after_wait
# ─────────────────────────────────────────────────────────────────────────────

@celery_app.task(
    name="app.workers.tasks.correlation_tasks.open_incident_after_wait",
    max_retries=3,
    default_retry_delay=10,
)
def open_incident_after_wait(
    *,
    device_id: int,
    event_type: str,
    component: str,
    source: str,
    severity: str,
    confidence: float,
):
    """
    Called by correlation_engine.process_event() after GROUP_WAIT_SEC.

    If the problem is still unresolved (no recovery event arrived during group_wait),
    create the Incident. Also check whether upstream suppression applies.
    """
    fp = make_fingerprint(device_id, event_type, component)
    db = _get_db()
    try:
        # Idempotency: another execution of this task may have already opened it
        existing = db.execute(
            select(Incident).where(
                Incident.fingerprint == fp,
                Incident.state.not_in([IncidentState.CLOSED]),
            ).limit(1)
        ).scalar_one_or_none()

        if existing:
            log.debug("corr: incident already exists for %s — skip open", fp)
            return

        # Check if a recovery arrived during group_wait — Redis group_wait key gone means
        # recovery was processed and cleared the key. In that case don't open.
        gw_key = f"corr:gw:{fp}"
        if not _redis.exists(gw_key):
            log.debug("corr: group_wait key gone for %s — problem resolved before opening", fp)
            return

        now = datetime.now(timezone.utc)
        inc = Incident(
            fingerprint   = fp,
            device_id     = device_id,
            event_type    = event_type,
            component     = component,
            severity      = severity,
            state         = IncidentState.OPEN,
            opened_at     = now,
            sources       = [{"source": source, "ts": now.isoformat(),
                               "confidence": confidence}],
            timeline      = [{"ts": now.isoformat(), "state": IncidentState.OPEN,
                               "reason": f"First confirmed by {source} after group_wait"}],
        )
        db.add(inc)
        db.commit()
        db.refresh(inc)

        log.info("corr: incident #%d opened — %s @ device %d (source=%s)",
                 inc.id, event_type, device_id, source)

        # Check upstream suppression (Statseeker 35s settle already covered by group_wait)
        _check_upstream_suppression_sync(inc, db)

    except Exception as exc:
        db.rollback()
        log.exception("corr: open_incident_after_wait failed for device %d: %s", device_id, exc)
        raise
    finally:
        db.close()


def _check_upstream_suppression_sync(incident: Incident, db) -> bool:
    """
    Sync BFS upstream suppression — mirrors correlation_engine.check_upstream_suppression.
    Fetches all topology links once, builds upstream_of map, traverses BFS up to
    UPSTREAM_BFS_MAX_DEPTH hops with a visited-set cycle guard.
    """
    from app.models.topology import TopologyLink
    from app.services.correlation_engine import UPSTREAM_BFS_MAX_DEPTH

    all_links = db.execute(
        select(TopologyLink.device_id, TopologyLink.neighbor_device_id)
        .where(TopologyLink.neighbor_device_id.is_not(None))
    ).fetchall()

    if not all_links:
        return False

    upstream_of: dict[int, set[int]] = {}
    for dev_id, nbr_id in all_links:
        upstream_of.setdefault(dev_id, set()).add(nbr_id)

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

    upstream_inc = db.execute(
        select(Incident).where(
            Incident.device_id.in_(visited),
            Incident.event_type.in_(["device_unreachable", "port_down", "device_restart"]),
            Incident.state.in_([IncidentState.OPEN, IncidentState.DEGRADED]),
        ).limit(1)
    ).scalar_one_or_none()

    if not upstream_inc:
        return False

    incident.state        = IncidentState.SUPPRESSED
    incident.suppressed_by = upstream_inc.id
    incident.log_transition(
        IncidentState.SUPPRESSED,
        f"Upstream incident #{upstream_inc.id} active (device_id={upstream_inc.device_id}, "
        f"BFS depth ≤ {UPSTREAM_BFS_MAX_DEPTH})",
    )
    db.commit()
    log.info("corr: incident #%d SUPPRESSED by upstream incident #%d (BFS, depth≤%d)",
             incident.id, upstream_inc.id, UPSTREAM_BFS_MAX_DEPTH)
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Task 2 — confirm_recovery
# ─────────────────────────────────────────────────────────────────────────────

@celery_app.task(
    name="app.workers.tasks.correlation_tasks.confirm_recovery",
    max_retries=2,
    default_retry_delay=30,
)
def confirm_recovery(*, incident_id: int):
    """
    Called RECOVERY_CONFIRM_SEC after a recovery event arrives.

    Faz 2C — ping-gated recovery:
      1. If incident is no longer RECOVERING → noop (re-trigger already re-opened it).
      2. Look up the device's IP address.
         - Device not found → fallback CLOSED (device removed from inventory).
      3. ICMP ping the device:
         - reachable (True)  → CLOSED (confirmed recovery)
         - unreachable (False) → re-open to OPEN (still down, false clear)
         - mechanism error (None) → fallback CLOSED (ping infra unavailable)
      4. All ping exceptions are non-fatal to the incident lifecycle.
    """
    db = _get_db()
    try:
        inc = db.get(Incident, incident_id)
        if not inc:
            return

        if inc.state != IncidentState.RECOVERING:
            log.debug("corr: confirm_recovery for #%d — state is %s, skip", incident_id, inc.state)
            return

        # ── Device lookup ─────────────────────────────────────────────────────
        from app.models.device import Device
        ip_address = db.execute(
            select(Device.ip_address).where(Device.id == inc.device_id)
        ).scalar_one_or_none()

        now = datetime.now(timezone.utc)

        if ip_address is None:
            # Device no longer in inventory — close safely without ping
            inc.state     = IncidentState.CLOSED
            inc.closed_at = now
            inc.log_transition(
                IncidentState.CLOSED,
                "Recovery confirmed — device no longer in inventory (fallback close)",
            )
            db.commit()
            log.info("corr: incident #%d CLOSED — device_id=%d not in inventory",
                     incident_id, inc.device_id or -1)
            return

        # ── Ping verification ─────────────────────────────────────────────────
        reachable = _ping_sync(ip_address)

        if reachable is True:
            inc.state     = IncidentState.CLOSED
            inc.closed_at = now
            inc.log_transition(
                IncidentState.CLOSED,
                f"Recovery confirmed by ping — {ip_address} reachable",
            )
            db.commit()
            log.info("corr: incident #%d CLOSED — ping confirmed reachable (%s)",
                     incident_id, ip_address)

        elif reachable is False:
            # Device still unreachable — the recovery signal was a false clear
            inc.state         = IncidentState.OPEN
            inc.recovering_at = None
            inc.log_transition(
                IncidentState.OPEN,
                f"Ping verification failed — {ip_address} still unreachable; false recovery signal",
            )
            db.commit()
            log.info("corr: incident #%d re-opened to OPEN — ping failed (%s)",
                     incident_id, ip_address)

        else:
            # Ping mechanism unavailable — fall back to safe CLOSED
            inc.state     = IncidentState.CLOSED
            inc.closed_at = now
            inc.log_transition(
                IncidentState.CLOSED,
                f"Recovery confirmed — ping mechanism unavailable for {ip_address} (fallback close)",
            )
            db.commit()
            log.warning("corr: incident #%d CLOSED — ping mechanism failed for %s (fallback)",
                        incident_id, ip_address)

    except Exception as exc:
        db.rollback()
        log.exception("corr: confirm_recovery failed for incident %d: %s", incident_id, exc)
        raise
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────────────
# Task 3 — confirm_stale_recovering  (KL-3 fix)
# ─────────────────────────────────────────────────────────────────────────────

@celery_app.task(
    name="app.workers.tasks.correlation_tasks.confirm_stale_recovering",
    max_retries=1,
    default_retry_delay=60,
)
def confirm_stale_recovering():
    """
    Periodic sweep — runs every 5 minutes via Celery beat.

    Closes incidents that are stuck in RECOVERING because confirm_recovery
    could not be scheduled (Celery broker was temporarily down, KL-3).

    Threshold: incidents still RECOVERING after RECOVERY_CONFIRM_SEC * 2
    seconds have clearly had no re-trigger — safe to close.
    """
    from datetime import timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=RECOVERY_CONFIRM_SEC * 2)
    db = _get_db()
    try:
        stale = db.execute(
            select(Incident).where(
                Incident.state == IncidentState.RECOVERING,
                Incident.recovering_at < cutoff,
            )
        ).scalars().all()

        closed = 0
        for inc in stale:
            now = datetime.now(timezone.utc)
            inc.state     = IncidentState.CLOSED
            inc.closed_at = now
            inc.log_transition(
                IncidentState.CLOSED,
                f"Recovery sweep — stuck in RECOVERING >{RECOVERY_CONFIRM_SEC * 2}s, "
                "no re-trigger detected",
            )
            closed += 1

        if closed:
            db.commit()
            log.info("corr: recovery sweep closed %d stale RECOVERING incident(s)", closed)

    except Exception as exc:
        db.rollback()
        log.exception("corr: confirm_stale_recovering failed: %s", exc)
        raise
    finally:
        db.close()
