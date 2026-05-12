"""
Synthetic Probe Task — Faz 3B

Periodically runs user-defined probes (icmp/tcp/dns/http) via proxy agents
and wires failures/recoveries into the correlation engine.

Beat schedule: every 60 s (lightweight dispatcher — heavy work is on the agent).

Correlation rules:
  - probe failure (agent online) → process_event(is_problem=True,  source="synthetic")
  - probe recovery               → process_event(is_problem=False, source="synthetic")
  - agent offline                → result stored, NO correlation (cannot distinguish
                                    device fault from agent fault)
"""

import asyncio
import logging
from datetime import datetime, timezone

import redis as redis_sync
from sqlalchemy import select, desc

from app.core.config import settings
from app.core.database import make_worker_session
from app.models.synthetic_probe import SyntheticProbe, SyntheticProbeResult
from app.services.agent_manager import agent_manager
from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)

_redis = redis_sync.from_url(settings.REDIS_URL, decode_responses=True)


# ── Probe → correlation mappings ──────────────────────────────────────────────

def _probe_event_type(probe: SyntheticProbe) -> tuple[str, str]:
    """Return (event_type, component) for the correlation engine."""
    if probe.probe_type == "icmp":
        return "device_unreachable", "device"
    if probe.probe_type == "tcp":
        return "port_down", f"tcp:{probe.port or 80}"
    if probe.probe_type == "http":
        return "service_unavailable", f"http:{(probe.target or '')[:32]}"
    return "dns_failure", f"dns:{(probe.target or '')[:32]}"


def _probe_severity(probe_type: str) -> str:
    return "critical" if probe_type in ("icmp", "tcp") else "warning"


# ── Pure helpers — unit-testable ──────────────────────────────────────────────

def _probe_kwargs(probe: SyntheticProbe) -> dict:
    """Extra kwargs forwarded to execute_synthetic_probe."""
    if probe.probe_type == "tcp":
        return {"port": probe.port or 80}
    if probe.probe_type == "http":
        return {
            "url":             probe.target,
            "http_method":     probe.http_method or "GET",
            "expected_status": probe.expected_status or 200,
        }
    if probe.probe_type == "dns":
        return {"dns_record_type": probe.dns_record_type or "A"}
    return {}


def _should_run(probe: SyntheticProbe, last_result: SyntheticProbeResult | None, now: datetime) -> bool:
    """True when the probe interval has elapsed since the last measurement."""
    if last_result is None:
        return True
    elapsed = (now - last_result.measured_at).total_seconds()
    return elapsed >= probe.interval_secs


def _needs_problem_event(result_success: bool, last_result: SyntheticProbeResult | None) -> bool:
    """Should we fire a problem correlation event?"""
    if result_success:
        return False
    if last_result is None:
        return True                          # first run, already failing
    return last_result.success              # transition: was ok, now failing


def _needs_recovery_event(result_success: bool, last_result: SyntheticProbeResult | None) -> bool:
    """Should we fire a recovery correlation event?"""
    if not result_success:
        return False
    if last_result is None:
        return False                         # first run and ok — nothing to recover from
    return not last_result.success           # transition: was failing, now ok


# ══════════════════════════════════════════════════════════════════════════════
# Async runner
# ══════════════════════════════════════════════════════════════════════════════

async def _run_probes():
    from app.services.correlation_engine import process_event

    now = datetime.now(timezone.utc)
    ran = 0

    async with make_worker_session()() as db:
        probes = (await db.execute(
            select(SyntheticProbe).where(SyntheticProbe.enabled == True)  # noqa: E712
        )).scalars().all()

        for probe in probes:
            # Skip probes with no agent assigned
            if not probe.agent_id:
                continue

            last = (await db.execute(
                select(SyntheticProbeResult)
                .where(SyntheticProbeResult.probe_id == probe.id)
                .order_by(desc(SyntheticProbeResult.measured_at))
                .limit(1)
            )).scalar_one_or_none()

            if not _should_run(probe, last, now):
                continue

            result = await agent_manager.execute_synthetic_probe(
                agent_id=probe.agent_id,
                probe_type=probe.probe_type,
                target=probe.target,
                timeout=probe.timeout_secs,
                **_probe_kwargs(probe),
            )

            db.add(SyntheticProbeResult(
                probe_id=probe.id,
                success=result["success"],
                latency_ms=result.get("latency_ms"),
                detail=(result.get("detail") or "")[:512],
                measured_at=now,
            ))

            # Correlation — only when agent was online (not an agent-side failure)
            agent_offline = result.get("detail") == "agent offline"
            if probe.device_id and not agent_offline:
                event_type, component = _probe_event_type(probe)
                if _needs_problem_event(result["success"], last):
                    try:
                        await process_event(
                            device_id=probe.device_id,
                            event_type=event_type,
                            component=component,
                            source="synthetic",
                            is_problem=True,
                            db=db,
                            sync_redis=_redis,
                            severity=_probe_severity(probe.probe_type),
                        )
                    except Exception:
                        log.exception("synthetic: correlation (problem) failed, probe=%d", probe.id)
                elif _needs_recovery_event(result["success"], last):
                    try:
                        await process_event(
                            device_id=probe.device_id,
                            event_type=event_type,
                            component=component,
                            source="synthetic",
                            is_problem=False,
                            db=db,
                            sync_redis=_redis,
                            severity=_probe_severity(probe.probe_type),
                        )
                    except Exception:
                        log.exception("synthetic: correlation (recovery) failed, probe=%d", probe.id)

            ran += 1

        await db.commit()

    log.info("synthetic: ran %d probe(s)", ran)


# ══════════════════════════════════════════════════════════════════════════════
# Celery task
# ══════════════════════════════════════════════════════════════════════════════

@celery_app.task(
    name="app.workers.tasks.synthetic_tasks.run_synthetic_probes",
    max_retries=0,
)
def run_synthetic_probes():
    """Periodic dispatcher — runs all due synthetic probes (beat: every 60 s)."""
    asyncio.run(_run_probes())
