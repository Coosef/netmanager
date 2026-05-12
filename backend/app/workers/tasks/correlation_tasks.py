"""
Correlation Engine Celery tasks — Faz 1 MVP

Two tasks:
  open_incident_after_wait  — creates an Incident after group_wait expires
  confirm_recovery          — closes a RECOVERING Incident if no re-trigger arrived
"""
import logging
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
    Sync version of correlation_engine.check_upstream_suppression.
    Uses TopologyLink to find upstream devices and checks for active incidents.
    """
    from app.models.topology import TopologyLink

    upstream_rows = db.execute(
        select(TopologyLink.neighbor_device_id)
        .where(
            TopologyLink.device_id == incident.device_id,
            TopologyLink.neighbor_device_id.is_not(None),
        )
        .limit(5)
    ).fetchall()
    upstream_ids = [r[0] for r in upstream_rows]

    if not upstream_ids:
        return False

    upstream_inc = db.execute(
        select(Incident).where(
            Incident.device_id.in_(upstream_ids),
            Incident.event_type.in_(["device_unreachable", "port_down"]),
            Incident.state.in_([IncidentState.OPEN, IncidentState.DEGRADED]),
        ).limit(1)
    ).scalar_one_or_none()

    if not upstream_inc:
        return False

    incident.state = IncidentState.SUPPRESSED
    incident.suppressed_by = upstream_inc.id
    incident.log_transition(
        IncidentState.SUPPRESSED,
        f"Upstream incident #{upstream_inc.id} active on device_id={upstream_inc.device_id}",
    )
    db.commit()
    log.info("corr: incident #%d SUPPRESSED by upstream incident #%d",
             incident.id, upstream_inc.id)
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

    If the Incident is still RECOVERING (no new problem event re-opened it),
    transition to CLOSED. If a new problem arrived, the state will be OPEN or
    DEGRADED again — in that case do nothing.
    """
    db = _get_db()
    try:
        inc = db.get(Incident, incident_id)
        if not inc:
            return

        if inc.state == IncidentState.RECOVERING:
            now = datetime.now(timezone.utc)
            inc.state     = IncidentState.CLOSED
            inc.closed_at = now
            inc.log_transition(
                IncidentState.CLOSED,
                f"Recovery confirmed — no re-trigger within {RECOVERY_CONFIRM_SEC}s window",
            )
            db.commit()
            log.info("corr: incident #%d CLOSED after recovery confirmation", incident_id)
        else:
            log.debug("corr: confirm_recovery for #%d — state is %s, skip close",
                      incident_id, inc.state)
    except Exception as exc:
        db.rollback()
        log.exception("corr: confirm_recovery failed for incident %d: %s", incident_id, exc)
        raise
    finally:
        db.close()
