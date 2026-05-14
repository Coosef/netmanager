"""
Enhanced health endpoints — Faz 5C.

/health          → backward-compatible simple check (always 200)
/health/live     → Kubernetes liveness  (always 200 if process alive)
/health/ready    → Kubernetes readiness (200 ok | 503 degraded)
                    Checks: PostgreSQL, Redis, TimescaleDB
"""
import asyncio

import structlog
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core.metrics import HEALTH_COMPONENT_UP

router = APIRouter(tags=["Health"])
log = structlog.get_logger("netmanager.health")


# ── Individual checks ─────────────────────────────────────────────────────────

async def _check_db() -> dict:
    try:
        from app.core.database import async_engine
        from sqlalchemy import text
        async with async_engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return {"status": "ok"}
    except Exception as exc:
        return {"status": "error", "detail": str(exc)[:120]}


async def _check_redis() -> dict:
    try:
        from app.core.redis_client import get_redis
        await get_redis().ping()
        return {"status": "ok"}
    except Exception as exc:
        return {"status": "error", "detail": str(exc)[:120]}


async def _check_timescaledb() -> dict:
    """Returns 'unavailable' instead of 'error' when TimescaleDB extension is absent
    (e.g. SQLite test environment) so that /health/ready does not return 503."""
    try:
        from app.core.database import async_engine
        from sqlalchemy import text
        async with async_engine.connect() as conn:
            result = await conn.execute(
                text("SELECT count(*) FROM timescaledb_information.hypertables")
            )
            count = result.scalar()
        return {"status": "ok", "hypertable_count": count}
    except Exception:
        return {"status": "unavailable"}


async def _safe_check(coro, timeout: float = 3.0) -> dict:
    try:
        return await asyncio.wait_for(coro, timeout=timeout)
    except asyncio.TimeoutError:
        return {"status": "timeout"}


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/health", include_in_schema=False)
async def health_simple():
    """Backward-compatible health check — always returns 200."""
    return {"status": "ok", "app": "NetManager"}


@router.get("/health/live", include_in_schema=False)
async def liveness():
    """Kubernetes liveness probe — 200 as long as the process is running."""
    return {"status": "ok"}


@router.get("/health/ready", include_in_schema=False)
async def readiness():
    """Kubernetes readiness probe — 503 if any critical dependency is down."""
    checks = {
        "db":          await _safe_check(_check_db()),
        "redis":       await _safe_check(_check_redis()),
        "timescaledb": await _safe_check(_check_timescaledb()),
    }

    # Update Prometheus health gauges
    for component, result in checks.items():
        up = 1 if result["status"] in ("ok", "unavailable") else 0
        HEALTH_COMPONENT_UP.labels(component=component).set(up)

    # timescaledb "unavailable" is not critical (may be absent in dev)
    critical_down = [
        k for k, v in checks.items()
        if v["status"] not in ("ok", "unavailable") and k != "timescaledb"
    ]

    overall = "ok" if not critical_down else "degraded"
    if critical_down:
        log.warning("health_check_degraded", failing=critical_down)
        return JSONResponse(status_code=503, content={"status": overall, "checks": checks})

    return {"status": overall, "checks": checks}
