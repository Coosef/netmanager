"""
Aggregation Cache Warmer — Faz 6B G5 (Faz 9 #4 — tenant loop retired)

Celery beat task (every 60s, `default` queue) that keeps the KI-1 hot
aggregation caches warm:

  - /sla/fleet-summary
  - /intelligence/fleet/risk

How it works:
  1. AGG_CACHE_ENABLED=false → immediate no-op.
  2. Single-runner lock (SETNX agg:warmer:lock, 120s TTL) — overlapping
     beat ticks skip instead of double-running heavy aggregations.
  3. Snapshot the device-dirty set written by cache_invalidation (G4):
       agg:dirty:device  — devices whose data changed
  4. Two warm targets per cycle: no-filter sla + no-filter risk. (The
     per-tenant per-device variants were retired in M6 — RLS scopes
     reads at the DB layer now, so there's a single fleet cache key
     per kind and the warmer only needs to keep those two warm. The
     legacy `agg:dirty:tenant` set was already drained at module-load
     by `_cleanup_legacy_keys()` below and never written by anyone.)
  5. Warm targets with asyncio.Semaphore(2) — only 2 targets exist so
     a small bound is enough; protects Postgres from a pile-up if the
     queries slow down.
  6. Drain device markers with SREM (member-specific, NOT DEL) — markers
     added *during* the run survive for the next cycle; they're cleared
     only when both no-filter fleet caches were confirmed warm.

Safety properties:
  * Redis errors → task returns a status dict, never raises (system stays up).
  * Per-target failure is isolated (asyncio.gather return_exceptions=True).
  * Crash before drain → device markers survive → next run retries.
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
_WARM_CONCURRENCY = 2                # Semaphore — only 2 targets, bounded
_DIRTY_DEVICE_SET = "agg:dirty:device"
# Faz 9 #4 — legacy `agg:dirty:tenant` set retired. No publisher writes to
# it (the SADD in cache_invalidation.py was removed in M6 final drop) and
# we no longer iterate it. A best-effort one-time DEL runs on first warm
# cycle in case any stale members from before M6 still linger.
_LEGACY_DIRTY_TENANT_SET = "agg:dirty:tenant"

# Defaults must match the endpoint Query() defaults so warmed keys are the
# ones real requests hit.
_DEFAULT_WINDOW_DAYS = 30            # /sla/fleet-summary
_DEFAULT_RISK_LIMIT = 20             # /intelligence/fleet/risk


# ── Pure helper — testable without Redis ──────────────────────────────────────

def build_warm_targets() -> list[str]:
    """The two no-filter warm targets per cycle: sla + risk.

    Returns a stable 2-element list. Faz 9 #4 — the per-tenant variant
    (previously expanded by `dirty_tenants`) is retired; with RLS scoping
    reads at the DB layer there is exactly one fleet cache key per kind
    and warming the no-filter variants is sufficient.
    """
    return ["sla", "risk"]


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
            await _cleanup_legacy_keys(redis)
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


async def _cleanup_legacy_keys(redis) -> None:
    """Faz 9 #4 — best-effort one-time DEL of the legacy `agg:dirty:tenant`
    set. No producer writes to it post-M6, but a Redis instance that lived
    through the M6 upgrade may still hold stale members. A DEL is cheap on
    an empty/small set and idempotent across cycles. Never raises."""
    try:
        await redis.delete(_LEGACY_DIRTY_TENANT_SET)
    except Exception as exc:
        log.debug("warmer: legacy dirty-tenant DEL failed — %s", exc)


async def _run_warm(redis, cache, settings) -> dict:
    # Non-destructive snapshot of the device-dirty set. Used downstream to
    # decide whether to clear the markers after the no-filter warm succeeds.
    try:
        dirty_devices = set(await redis.smembers(_DIRTY_DEVICE_SET))
    except Exception as exc:
        log.warning("warmer: failed to read dirty set — %s", exc)
        dirty_devices = set()

    targets = build_warm_targets()

    sem = asyncio.Semaphore(_WARM_CONCURRENCY)
    results = await asyncio.gather(
        *(_warm_target(kind, sem, settings, cache) for kind in targets),
        return_exceptions=True,
    )

    # Map each target to its success bool.
    success: dict[str, bool] = {
        kind: (res is True) for kind, res in zip(targets, results)
    }

    warmed = sum(1 for ok in success.values() if ok)
    errors = len(success) - warmed

    # Drain device markers — only when both no-filter caches confirmed warm.
    # If either failed, keep the markers so the next cycle retries.
    no_filter_ok = success.get("sla") and success.get("risk")
    try:
        if no_filter_ok and dirty_devices:
            await redis.srem(_DIRTY_DEVICE_SET, *dirty_devices)
    except Exception as exc:
        log.warning("warmer: failed to drain dirty set — %s", exc)

    stats = {
        "status": "ok",
        "warmed": warmed,
        "errors": errors,
        "targets": len(targets),
        "dirty_devices_seen": len(dirty_devices),
    }
    log.info("warmer: %s", stats)
    return stats


async def _warm_target(
    kind: str, sem: asyncio.Semaphore, settings, cache,
) -> bool:
    """
    Warm one fleet cache entry. Returns True on success, False on failure.

    `cache` is the per-invocation AggregationCache (bound to this run's
    event loop — see _warm() docstring). Uses get_or_compute so:
      - an invalidated key (version bumped) → MISS → compute + write
      - a still-fresh key → cache hit, no redundant DB aggregation

    Faz 9 #4 — `tenant_id` argument retired. The `fleet_summary_cache_key`
    and `fleet_risk_cache_key` helpers still accept the legacy positional
    args for back-compat; we pass `None` for both, matching what the
    endpoints themselves do post Faz 9 #3.
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
                        version, None, None, _DEFAULT_WINDOW_DAYS, None,
                    )

                    async def _compute():
                        return await _compute_fleet_summary(
                            db, _DEFAULT_WINDOW_DAYS, None, None, None,
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
                        version, None, None, _DEFAULT_RISK_LIMIT,
                    )

                    async def _compute():
                        return await _compute_fleet_risk(
                            db, _DEFAULT_RISK_LIMIT, None, None,
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
            log.exception("warmer: failed to warm %s", kind)
            _safe_metric(CACHE_OPS, kind, "error")
            return False


def _safe_metric(counter, kind: str, result: str) -> None:
    try:
        counter.labels(operation="warm", key_pattern=f"{kind}_fleet", result=result).inc()
    except Exception:
        pass
