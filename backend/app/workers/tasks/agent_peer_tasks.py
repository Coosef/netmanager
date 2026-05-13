"""
Agent Peer Latency Task — Faz 3C

Measures backend-to-agent reachability and round-trip latency every 15 minutes.
Uses direct subprocess ICMP ping from the Celery worker to each active agent's
last_ip — no WebSocket dependency, works correctly from worker processes.

Stored as AgentPeerLatency(agent_from="backend", agent_to=<agent_id>).
"""

import asyncio
import logging
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select

from app.core.database import make_worker_session
from app.models.agent import Agent
from app.models.agent_peer_latency import AgentPeerLatency
from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)

# Matches "time=2.34 ms" or "time<1 ms" in ping stdout
_RTT_RE = re.compile(r"time[<=](\d+\.?\d*)\s*ms", re.IGNORECASE)


# ── Pure helper ───────────────────────────────────────────────────────────────

def _measure_latency(ip: str, timeout: int = 3) -> tuple[bool, Optional[float]]:
    """
    Send one ICMP ping to `ip` and return (reachable, latency_ms).

    Returns:
      (True,  float) — host responded; latency_ms from RTT or elapsed wall time
      (False, None)  — host unreachable or ping returncode != 0
      (False, None)  — subprocess timeout / binary missing / permission error
    """
    flag = "-n" if sys.platform == "win32" else "-c"
    w_flag = ["-w", str(timeout * 1000)] if sys.platform == "win32" else ["-W", str(timeout)]
    t0 = time.perf_counter()
    try:
        result = subprocess.run(
            ["ping", flag, "1", *w_flag, ip],
            capture_output=True,
            text=True,
            timeout=timeout + 2,
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000
        if result.returncode != 0:
            return False, None
        m = _RTT_RE.search(result.stdout)
        latency = float(m.group(1)) if m else round(elapsed_ms, 2)
        return True, latency
    except subprocess.TimeoutExpired:
        return False, None
    except Exception:
        return False, None


# ── Async core ────────────────────────────────────────────────────────────────

async def _run() -> None:
    now = datetime.now(timezone.utc)
    async with make_worker_session()() as db:
        agents = (
            await db.execute(
                select(Agent).where(
                    Agent.is_active == True,
                    Agent.last_ip.isnot(None),
                )
            )
        ).scalars().all()

        for agent in agents:
            reachable, latency_ms = _measure_latency(agent.last_ip)
            db.add(
                AgentPeerLatency(
                    agent_from="backend",
                    agent_to=agent.id,
                    target_ip=agent.last_ip,
                    latency_ms=latency_ms,
                    reachable=reachable,
                    measured_at=now,
                )
            )
            log.debug(
                "peer-latency agent=%s ip=%s reachable=%s latency_ms=%s",
                agent.id, agent.last_ip, reachable, latency_ms,
            )

        await db.commit()
        log.info("agent peer latency sweep complete — %d agents measured", len(agents))


# ── Celery task ───────────────────────────────────────────────────────────────

@celery_app.task(
    name="app.workers.tasks.agent_peer_tasks.measure_agent_peer_latency",
    max_retries=1,
    default_retry_delay=60,
)
def measure_agent_peer_latency():
    asyncio.run(_run())
