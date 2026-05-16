"""
Aggregation Cache Warmer — Faz 6B G5

Celery beat task (every 60s, `default` queue) that keeps the KI-1 hot
aggregation caches warm:

  - /sla/fleet-summary       (no-filter + per dirty-tenant)
  - /intelligence/fleet/risk (no-filter + per dirty-tenant)

How it works:
  1. AGG_CACHE_ENABLED=false → immediate no-op.
  2. Single-runner lock (SETNX agg:warmer:lock, 120s TTL) — overlapping
     beat ticks skip instead of double-running heavy aggregations.
  3. Snapshot the dirty sets written by cache_invalidation (G4):
       agg:dirty:device  — devices whose data changed
       agg:dirty:tenant  — tenants whose fleet caches need rebuild
  4. Build a deduplicated target list: always no-filter sla+risk, plus
     sla+risk for every dirty tenant.
  5. Warm targets with asyncio.Semaphore(5) — bounds concurrent DB
     aggregations so the warmer never stampedes Postgres.
  6. Drain dirty markers with SREM (member-specific, NOT DEL) — markers
     added *during* the run survive for the next cycle, and a tenant's
     marker is only removed if BOTH its sla and risk warmed successfully.

Safety properties:
  * Redis errors → task returns a status dict, never raises (system stays up).
  * Per-target failure is isolated (asyncio.gather return_exceptions=True).
  * Crash before drain → dirty markers survive → next run retries.
  * AggregationCache single-flight SETNX (G1) + warmer lock + target dedup
    → no duplicate warmup storm for the same key.
  * Runs on the `default` queue (task_default_queue) — never touches the
    agent_cmd or monitor worker pools.
"""
import asyncio
import logging

from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)

_WARMER_LOCK_KEY = "agg:warmer:lock"
_WARMER_LOCK_TTL_SECS = 120          # must exceed worst-case warm duration
_WARM_CONCURRENCY = 5                # Semaphore — concurrent DB aggregations
_DIRTY_DEVICE_SET = "agg:dirty:device"
_DIRTY_TENANT_SET = "agg:dirty:tenant"

# Defaults must match the endpoint Query() defaults so warmed keys are the
# ones real requests hit.
_DEFAULT_WINDOW_DAYS = 30            # /sla/fleet-summary
_DEFAULT_RISK_LIMIT = 20             # /intelligence/fleet/risk


# ── Pure helper — testable without Redis ──────────────────────────────────────

def build_warm_targets(dirty_tenants) -> list[tuple[str, object]]:
    """
    Build the deduplicated list of (kind, tenant_id) warm targets.

    Always includes the two no-filter targets (tenant_id=None). For each
    dirty tenant that parses as an int, adds its sla + risk targets.
    Non-integer members are skipped.
    """
    targets: list[tuple[str, object]] = [("sla", None), ("risk", None)]
    for raw in dirty_tenants:
        try:
            tid = int(raw)
        except (TypeError, ValueError):
            continue
        targets.append(("sla", tid))
        targets.append(("risk", tid))
    # dict.fromkeys preserves insertion order while dropping duplicates
    return list(dict.fromkeys(targets))


# ── Celery task ───────────────────────────────────────────────────────────────

@celery_app.task(name="app.workers.tasks.cache_warmer_tasks.warm_aggregation_cache")
def warm_aggregation_cache():
    """Beat entry point — warms aggregation caches. Never raises."""
    try:
        return asyncio.run(_warm())
    except Exception:
        log.exception("warmer: unexpected failure")
        return {"status": "error", "warmed": 0}


async def _warm() -> dict:
    """
    Warmer body. Creates a FRESH async Redis client + AggregationCache per
    invocation.

    Why fresh, not the get_redis() / get_aggregation_cache() singletons:
    every Celery task run does its own `asyncio.run()`, which builds a new
    event loop. The module-level async redis client binds its connection
    pool to whatever loop was current at construction — reusing it on a
    later run raises "future attached to a different loop". A per-run
    client is bound to the current loop and closed in `finally`.
    """
    from app.core.config import settings

    if not settings.AGG_CACHE_ENABLED:
        return {"status": "disabled", "warmed": 0}

    import redis.asyncio as aioredis
    from app.services.cache import AggregationCache

    redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    cache = AggregationCache(redis)

    try:
        # Single-runner lock — overlapping beat ticks skip rather than double-run.
        try:
            got_lock = await redis.set(
                _WARMER_LOCK_KEY, "1", nx=True, ex=_WARMER_LOCK_TTL_SECS,
            )
        except Exception as exc:
            log.warning("warmer: redis unavailable, skipping cycle — %s", exc)
            return {"status": "redis_down", "warmed": 0}

        if not got_lock:
            log.debug("warmer: previous run still active, skipping cycle")
            return {"status": "locked", "warmed": 0}

        try:
            return await _run_warm(redis, cache, settings)
        finally:
            try:
                await redis.delete(_WARMER_LOCK_KEY)
            except Exception:
                pass
    finally:
        try:
            await redis.aclose()
        except Exception:
            pass


async def _run_warm(redis, cache, settings) -> dict:
    # Non-destructive snapshot of dirty sets.
    try:
        dirty_devices = set(await redis.smembers(_DIRTY_DEVICE_SET))
        dirty_tenants = set(await redis.smembers(_DIRTY_TENANT_SET))
    except Exception as exc:
        log.warning("warmer: failed to read dirty sets — %s", exc)
        dirty_devices, dirty_tenants = set(), set()

    targets = build_warm_targets(dirty_tenants)

    sem = asyncio.Semaphore(_WARM_CONCURRENCY)
    results = await asyncio.gather(
        *(_warm_target(kind, tid, sem, settings, cache) for kind, tid in targets),
        return_exceptions=True,
    )

    # Map each target to its success bool.
    success: dict[tuple[str, object], bool] = {}
    for (kind, tid), res in zip(targets, results):
        success[(kind, tid)] = res is True

    warmed = sum(1 for ok in success.values() if ok)
    errors = len(success) - warmed

    # Drain dirty markers — only members fully warmed this cycle.
    no_filter_ok = success.get(("sla", None)) and success.get(("risk", None))
    drained_tenants = 0
    try:
        fully_warmed = [
            raw for raw in dirty_tenants
            if _tenant_fully_warmed(raw, success)
        ]
        if fully_warmed:
            drained_tenants = await redis.srem(_DIRTY_TENANT_SET, *fully_warmed)
        # Device markers only signal "fleet changed" — clear them once the
        # no-filter fleet caches are confirmed warm. If that failed, keep
        # them so the next cycle retries.
        if no_filter_ok and dirty_devices:
            await redis.srem(_DIRTY_DEVICE_SET, *dirty_devices)
    except Exception as exc:
        log.warning("warmer: failed to drain dirty sets — %s", exc)

    stats = {
        "status": "ok",
        "warmed": warmed,
        "errors": errors,
        "targets": len(targets),
        "dirty_devices_seen": len(dirty_devices),
        "dirty_tenants_drained": drained_tenants,
    }
    log.info("warmer: %s", stats)
    return stats


def _tenant_fully_warmed(raw_tenant, success: dict) -> bool:
    """A tenant marker is removable only if BOTH its sla and risk warmed."""
    try:
        tid = int(raw_tenant)
    except (TypeError, ValueError):
        # Unparseable marker — never produced a target; drop it so it can't
        # accumulate forever.
        return True
    return bool(success.get(("sla", tid)) and success.get(("risk", tid)))


async def _warm_target(
    kind: str, tenant_id, sem: asyncio.Semaphore, settings, cache,
) -> bool:
    """
    Warm one fleet cache entry. Returns True on success, False on failure.

    `cache` is the per-invocation AggregationCache (bound to this run's
    event loop — see _warm() docstring). Uses get_or_compute so:
      - an invalidated key (version bumped) → MISS → compute + write
      - a still-fresh key → cache hit, no redundant DB aggregation
    """
    from app.core.metrics import CACHE_OPS

    async with sem:
        try:
            from app.core.database import make_worker_session

            async with make_worker_session()() as db:
                if kind == "sla":
                    from app.api.v1.endpoints.sla import (
                        _SLA_FLEET_VERSION_KEY,
                        _compute_fleet_summary,
                        fleet_summary_cache_key,
                    )
                    version = await cache.read_version(_SLA_FLEET_VERSION_KEY)
                    key = fleet_summary_cache_key(
                        version, tenant_id, None, _DEFAULT_WINDOW_DAYS, None,
                    )

                    async def _compute():
                        return await _compute_fleet_summary(
                            db, _DEFAULT_WINDOW_DAYS, None, None, tenant_id,
                        )

                    await cache.get_or_compute(
                        key=key, compute=_compute,
                        fresh_secs=settings.AGG_CACHE_FRESH_SECS,
                        stale_secs=settings.AGG_CACHE_STALE_SECS,
                        key_pattern="sla_fleet",
                    )
                else:  # "risk"
                    from app.api.v1.endpoints.intelligence import (
                        _RISK_FLEET_VERSION_KEY,
                        _compute_fleet_risk,
                        fleet_risk_cache_key,
                    )
                    version = await cache.read_version(_RISK_FLEET_VERSION_KEY)
                    key = fleet_risk_cache_key(
                        version, tenant_id, None, _DEFAULT_RISK_LIMIT,
                    )

                    async def _compute():
                        return await _compute_fleet_risk(
                            db, _DEFAULT_RISK_LIMIT, None, tenant_id,
                        )

                    await cache.get_or_compute(
                        key=key, compute=_compute,
                        fresh_secs=settings.AGG_CACHE_FRESH_SECS,
                        stale_secs=settings.AGG_CACHE_STALE_SECS,
                        key_pattern="risk_fleet",
                    )

            _safe_metric(CACHE_OPS, kind, "ok")
            return True
        except Exception:
            log.exception("warmer: failed to warm %s tenant=%s", kind, tenant_id)
            _safe_metric(CACHE_OPS, kind, "error")
            return False


def _safe_metric(counter, kind: str, result: str) -> None:
    try:
        counter.labels(operation="warm", key_pattern=f"{kind}_fleet", result=result).inc()
    except Exception:
        pass
