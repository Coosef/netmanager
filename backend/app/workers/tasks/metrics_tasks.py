"""
Infrastructure metrics collection — Faz 5C.

Runs every 60 seconds (celery beat) and updates Prometheus gauges for:
  - Redis queue depth (default / bulk / monitor queues)
  - TimescaleDB background job status (last_successful_finish, total_failures)
  - SQLAlchemy async pool stats (checked_out, overflow)

Results are written into the shared prometheus multiprocess dir (if configured)
so they appear at the FastAPI /metrics endpoint.
"""
import asyncio
import logging

from sqlalchemy import text

from app.core.config import settings
from app.core.database import async_engine, make_worker_session
from app.core.metrics import (
    DB_POOL_CHECKED_OUT,
    DB_POOL_OVERFLOW,
    REDIS_QUEUE_DEPTH,
    TIMESCALE_JOB_FAILURES_TOTAL,
    TIMESCALE_JOB_LAST_SUCCESS_TS,
)
from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)

_CELERY_QUEUES = ["default", "bulk", "monitor"]

# TimescaleDB job_stats query — confirmed columns from timescaledb_information.job_stats
_TS_JOBS_QUERY = text("""
    SELECT j.proc_name,
           js.last_successful_finish,
           js.total_failures
    FROM timescaledb_information.job_stats js
    JOIN timescaledb_information.jobs j USING (job_id)
    WHERE j.proc_schema = '_timescaledb_internal'
""")


@celery_app.task(
    name="app.workers.tasks.metrics_tasks.collect_infrastructure_metrics",
    max_retries=0,
    ignore_result=True,
)
def collect_infrastructure_metrics():
    asyncio.run(_run())


async def _run():
    await _collect_redis_queue_depth()
    await _collect_timescale_job_stats()
    _collect_db_pool_stats()


async def _collect_redis_queue_depth():
    try:
        import redis.asyncio as aioredis
        r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        for queue in _CELERY_QUEUES:
            depth = await r.llen(queue) or 0
            REDIS_QUEUE_DEPTH.labels(queue=queue).set(depth)
        await r.aclose()
    except Exception as exc:
        log.warning("metrics: redis queue depth collection failed: %s", exc)


async def _collect_timescale_job_stats():
    try:
        async with make_worker_session()() as db:
            rows = (await db.execute(_TS_JOBS_QUERY)).fetchall()
            for row in rows:
                job_name = row.proc_name or f"job_unknown"
                if row.last_successful_finish:
                    TIMESCALE_JOB_LAST_SUCCESS_TS.labels(job_name=job_name).set(
                        row.last_successful_finish.timestamp()
                    )
                TIMESCALE_JOB_FAILURES_TOTAL.labels(job_name=job_name).set(
                    row.total_failures or 0
                )
    except Exception as exc:
        # Expected to fail in dev/test (SQLite / no TimescaleDB)
        log.debug("metrics: timescale job stats unavailable: %s", exc)


def _collect_db_pool_stats():
    try:
        pool = async_engine.pool
        DB_POOL_CHECKED_OUT.set(pool.checkedout())
        DB_POOL_OVERFLOW.set(pool.overflow())
    except AttributeError:
        pass  # NullPool has no checkedout()/overflow()
    except Exception as exc:
        log.debug("metrics: db pool stats unavailable: %s", exc)
