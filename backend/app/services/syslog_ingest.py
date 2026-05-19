"""
Syslog ingest — Faz 6C

Shared syslog persistence + correlation logic, used by:
  * the event_consumer service (G3) — drains the `ingest:syslog` stream and
    bulk-persists batches;
  * the agent_manager fallback path (G2) — bounded direct insert used only
    when the event bus is unavailable.

Keeping this in one place means the stream path and the fallback path write
syslog rows + fire correlation identically.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from app.core.config import settings

log = logging.getLogger(__name__)

# Bounds the fallback path so a burst can't open one DB connection per event
# (the original KI-4 failure mode). Module-level — shared across all callers.
_fallback_sem = asyncio.Semaphore(settings.SYSLOG_FALLBACK_CONCURRENCY)


def _parse_dt(value) -> datetime:
    """Accept a datetime (fallback path) or an ISO string (stream path)."""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            pass
    return datetime.now(timezone.utc)


async def persist_and_correlate(db, payloads: list[dict], sync_redis) -> int:
    """
    Bulk-insert syslog rows in ONE commit, then run correlation for each
    availability-impacting event. Returns the number of rows persisted.

    db          — caller-supplied AsyncSession (consumer batch session, or
                  the fallback's per-call session).
    payloads    — list of dicts: agent_id, source_ip, facility, severity,
                  message, received_at.
    sync_redis  — sync redis client for correlation_engine's flap guard.

    Correlation failures are non-fatal — the raw rows are always persisted.
    """
    if not payloads:
        return 0

    from sqlalchemy import select

    from app.models.syslog_event import SyslogEvent
    from app.models.agent import Agent
    from app.services.syslog_normalizer import AVAILABILITY_EVENT_TYPES, normalize

    # Faz 8 phase C — resolve organization + location from the originating
    # agent. A payload whose agent is unknown cannot be scoped (org is
    # NOT NULL) → it is dropped and logged, never silently misattributed.
    agent_ids = {p.get("agent_id") for p in payloads if p.get("agent_id")}
    scope: dict = {}
    if agent_ids:
        for aid, oid, lid in (await db.execute(
            select(Agent.id, Agent.organization_id, Agent.location_id)
            .where(Agent.id.in_(agent_ids))
        )).all():
            scope[aid] = (oid, lid)

    rows = []
    dropped = 0
    for p in payloads:
        sc = scope.get(p.get("agent_id"))
        if sc is None:
            dropped += 1
            continue
        rows.append(SyslogEvent(
            agent_id=p.get("agent_id"),
            source_ip=p.get("source_ip", ""),
            facility=p.get("facility", 0),
            severity=p.get("severity", 7),
            message=p.get("message", ""),
            received_at=_parse_dt(p.get("received_at")),
            organization_id=sc[0],
            location_id=sc[1],
        ))
    if dropped:
        log.warning(
            "syslog_ingest: dropped %d event(s) — unknown/unscopable agent", dropped,
            extra={"dropped": dropped, "reason": "agent not resolvable to org/location"},
        )
    if not rows:
        return 0
    db.add_all(rows)
    await db.commit()

    # Correlation — only availability-impacting events. Raw rows are already
    # committed above regardless of what happens here.
    from sqlalchemy import select

    from app.models.device import Device
    from app.services.correlation_engine import process_event

    for p in payloads:
        normalized = normalize(
            p.get("facility", 0), p.get("severity", 7), p.get("message", ""),
        )
        if not normalized or normalized.event_type not in AVAILABILITY_EVENT_TYPES:
            continue
        # Faz 8 Phase D — the correlated device must be in the originating
        # agent's own org (+ location): two locations may legitimately use
        # the same source_ip, so an unscoped ip match could correlate a
        # foreign location's device. A payload with no resolvable agent
        # scope was already dropped from `rows` above.
        sc = scope.get(p.get("agent_id"))
        if sc is None:
            continue
        device_q = select(Device.id).where(
            Device.ip_address == p.get("source_ip", ""),
            Device.organization_id == sc[0],
        )
        if sc[1] is not None:
            device_q = device_q.where(Device.location_id == sc[1])
        device_id = (await db.execute(device_q)).scalar_one_or_none()
        if not device_id:
            continue
        try:
            await process_event(
                device_id=device_id,
                event_type=normalized.event_type,
                component=normalized.component,
                source="syslog",
                is_problem=normalized.is_problem,
                db=db,
                sync_redis=sync_redis,
                severity=normalized.severity,
            )
        except Exception as exc:
            log.warning("syslog_ingest: correlation failed (non-fatal) — %s", exc)

    return len(rows)


async def fallback_persist(payload: dict, sync_redis) -> bool:
    """
    Bounded single-event persist — used by the agent_manager fallback when the
    event bus publish fails (Redis unavailable).

    A module-level Semaphore caps concurrent fallback inserts so a burst
    cannot exhaust the DB pool — even in degraded mode the failure mode that
    caused KI-4 cannot recur. Returns True on success.
    """
    async with _fallback_sem:
        try:
            from app.core.database import make_worker_session
            async with make_worker_session()() as db:
                await persist_and_correlate(db, [payload], sync_redis)
            return True
        except Exception as exc:
            log.warning("syslog_ingest: fallback persist failed — %s", exc)
            return False
