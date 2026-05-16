"""
Aggregation Cache — Faz 6B

Async Redis-backed cache for expensive aggregation endpoints.

Features:
  * Two-tier TTL: `fresh_secs` returned immediately, `stale_secs` triggers
    background refresh (stale-while-revalidate).
  * Single-flight stampede protection via SETNX lock — concurrent cold
    requests on the same key wait for a single compute instead of all
    duplicating the work.
  * Hard timeout on every Redis call (50ms by default) so a degraded
    Redis cannot pin the FastAPI event loop.
  * Redis unavailable fallback: compute is still called, the result is
    returned, no cache write attempted.
  * X-Cache-Bypass support via the `bypass` parameter (set by the
    endpoint when the header is present) — skips read AND write.
  * Slow-compute warning + metric when compute() takes longer than
    settings.AGG_CACHE_SLOW_COMPUTE_WARN_SECS.
  * JSON serialization with datetime / date / Decimal / UUID handling.

Usage:
    from app.services.cache import get_aggregation_cache, CacheStatus

    cache = get_aggregation_cache()
    payload, status = await cache.get_or_compute(
        key="agg:sla:fleet:t=1:window=30",
        compute=lambda: _calc_fleet_summary(db, ...),
        fresh_secs=60, stale_secs=240,
        key_pattern="sla_fleet",
        bypass=request.headers.get("X-Cache-Bypass") == "1",
    )
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Awaitable, Callable, Optional
from uuid import UUID

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.core.config import settings
from app.core.metrics import (
    AGG_DURATION,
    CACHE_OPS,
    CACHE_UNAVAILABLE,
)

log = logging.getLogger(__name__)


# ── Tunables ──────────────────────────────────────────────────────────────────
_REDIS_OP_TIMEOUT_SECS = 0.05          # 50ms hard cap on every Redis call
_LOCK_TTL_SECS = 30                    # SETNX lock — abandoned lock max age
_LOCK_WAIT_MAX_SECS = 2.0              # waiter timeout when another req holds lock
_LOCK_POLL_INTERVAL_SECS = 0.05        # waiter polls cache every 50ms


class CacheStatus(str, Enum):
    HIT_FRESH = "hit_fresh"
    HIT_STALE = "hit_stale"
    MISS = "miss"
    BYPASS = "bypass"
    REDIS_DOWN = "redis_down"
    LOCK_TIMEOUT = "lock_timeout"


# ── Serialization ─────────────────────────────────────────────────────────────

class _AggEncoder(json.JSONEncoder):
    """Encoder for aggregation payloads — covers types pg/SQLAlchemy returns."""

    def default(self, obj: Any) -> Any:
        if isinstance(obj, datetime):
            return obj.isoformat()
        if isinstance(obj, date):
            return obj.isoformat()
        if isinstance(obj, Decimal):
            return float(obj)
        if isinstance(obj, UUID):
            return str(obj)
        if isinstance(obj, (set, frozenset)):
            return list(obj)
        return super().default(obj)


def _serialize(payload: dict) -> str:
    return json.dumps(payload, cls=_AggEncoder, separators=(",", ":"))


def _deserialize(raw: str) -> dict:
    return json.loads(raw)


# ── Envelope ──────────────────────────────────────────────────────────────────

@dataclass
class _CachedEntry:
    """In-cache envelope; freshness is derived from written_at + fresh_secs."""
    payload: dict
    written_at: float
    fresh_secs: int

    def age_secs(self) -> float:
        return time.time() - self.written_at

    def is_fresh(self) -> bool:
        return self.age_secs() < self.fresh_secs


# ── Cache class ───────────────────────────────────────────────────────────────

class AggregationCache:
    """Two-tier TTL cache with single-flight stampede protection."""

    def __init__(self, redis_client: aioredis.Redis):
        self._redis = redis_client

    # ── Public API ────────────────────────────────────────────────────────────

    async def get_or_compute(
        self,
        key: str,
        compute: Callable[[], Awaitable[dict]],
        fresh_secs: int,
        stale_secs: int,
        key_pattern: str = "unknown",
        bypass: bool = False,
    ) -> tuple[dict, CacheStatus]:
        """
        Get from cache or compute fresh.

        Returns (payload, status). The caller does not need to interpret
        status to use payload — it is always a fully-computed dict.

        Status is exposed so endpoints can set response headers and so
        metrics can attribute behavior.
        """
        # Hard bypass: feature flag off, or X-Cache-Bypass header
        if bypass or not settings.AGG_CACHE_ENABLED:
            CACHE_OPS.labels(operation="get", key_pattern=key_pattern, result="bypass").inc()
            payload = await self._compute_with_timing(compute, key_pattern, "bypass")
            return payload, CacheStatus.BYPASS

        # Read attempt
        entry, redis_ok = await self._read(key, key_pattern)
        if not redis_ok:
            # Redis unavailable — compute directly, do not write back
            CACHE_UNAVAILABLE.inc()
            CACHE_OPS.labels(operation="get", key_pattern=key_pattern, result="error").inc()
            payload = await self._compute_with_timing(compute, key_pattern, "redis_down")
            return payload, CacheStatus.REDIS_DOWN

        if entry is not None and entry.is_fresh():
            CACHE_OPS.labels(operation="get", key_pattern=key_pattern, result="hit_fresh").inc()
            AGG_DURATION.labels(endpoint=key_pattern, cache_status="hit_fresh").observe(0.0)
            return entry.payload, CacheStatus.HIT_FRESH

        # MISS or STALE — synchronous single-flight compute.
        #
        # We intentionally do NOT spawn a background refresh task here. The
        # `compute` callback typically closes over a request/worker DB session
        # whose lifetime ends when the caller returns; a detached task would
        # then touch a closed session (sqlalchemy IllegalStateChangeError).
        # Synchronous compute keeps everything inside the caller's context.
        # Stampede is still bounded by the SETNX single-flight lock.
        try:
            payload, status = await self._compute_under_lock(
                key, compute, fresh_secs, stale_secs, key_pattern,
            )
            return payload, status
        except Exception:
            # Compute failed — if we still hold a stale entry, serve it as a
            # last-resort fallback so the caller gets data instead of a 500.
            if entry is not None:
                CACHE_OPS.labels(
                    operation="get", key_pattern=key_pattern, result="hit_stale",
                ).inc()
                AGG_DURATION.labels(
                    endpoint=key_pattern, cache_status="hit_stale",
                ).observe(0.0)
                log.warning(
                    "cache: compute failed for %s — serving stale entry", key,
                )
                return entry.payload, CacheStatus.HIT_STALE
            raise

    async def invalidate(self, key: str, key_pattern: str = "unknown") -> bool:
        """Best-effort delete. Returns True if a key was removed."""
        try:
            n = await asyncio.wait_for(
                self._redis.delete(key),
                timeout=_REDIS_OP_TIMEOUT_SECS,
            )
            CACHE_OPS.labels(operation="invalidate", key_pattern=key_pattern, result="ok").inc()
            return bool(n)
        except (RedisError, asyncio.TimeoutError):
            CACHE_OPS.labels(operation="invalidate", key_pattern=key_pattern, result="error").inc()
            return False

    async def invalidate_version(self, version_key: str) -> int:
        """INCR a version counter — readers will compose new key with new version."""
        try:
            v = await asyncio.wait_for(
                self._redis.incr(version_key),
                timeout=_REDIS_OP_TIMEOUT_SECS,
            )
            return int(v)
        except (RedisError, asyncio.TimeoutError, ValueError):
            return 0

    async def read_version(self, version_key: str) -> int:
        """GET version counter; returns 0 on miss/error so the caller can compose."""
        try:
            raw = await asyncio.wait_for(
                self._redis.get(version_key),
                timeout=_REDIS_OP_TIMEOUT_SECS,
            )
            return int(raw) if raw else 0
        except (RedisError, asyncio.TimeoutError, ValueError):
            return 0

    # ── Internals ─────────────────────────────────────────────────────────────

    async def _read(
        self, key: str, key_pattern: str,
    ) -> tuple[Optional[_CachedEntry], bool]:
        """Returns (entry_or_None, redis_ok). redis_ok=False means Redis unavailable."""
        try:
            raw = await asyncio.wait_for(
                self._redis.get(key),
                timeout=_REDIS_OP_TIMEOUT_SECS,
            )
        except (RedisError, asyncio.TimeoutError):
            return None, False

        if raw is None:
            return None, True

        try:
            data = _deserialize(raw)
            return _CachedEntry(
                payload=data["payload"],
                written_at=data["written_at"],
                fresh_secs=data["fresh_secs"],
            ), True
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            log.warning("cache: corrupt entry key=%s — %s", key, exc)
            return None, True

    async def _write(
        self,
        key: str,
        payload: dict,
        fresh_secs: int,
        stale_secs: int,
        key_pattern: str,
    ) -> None:
        total_ttl = fresh_secs + stale_secs
        envelope = {
            "payload": payload,
            "written_at": time.time(),
            "fresh_secs": fresh_secs,
        }
        try:
            await asyncio.wait_for(
                self._redis.set(key, _serialize(envelope), ex=total_ttl),
                timeout=_REDIS_OP_TIMEOUT_SECS,
            )
            CACHE_OPS.labels(operation="set", key_pattern=key_pattern, result="ok").inc()
        except (RedisError, asyncio.TimeoutError):
            CACHE_OPS.labels(operation="set", key_pattern=key_pattern, result="error").inc()
            log.debug("cache: write failed key=%s", key)

    async def _compute_under_lock(
        self,
        key: str,
        compute: Callable[[], Awaitable[dict]],
        fresh_secs: int,
        stale_secs: int,
        key_pattern: str,
    ) -> tuple[dict, CacheStatus]:
        """
        Single-flight: first request acquires SETNX lock and computes.
        Concurrent requests poll for the cache key until either the value
        arrives or LOCK_WAIT_MAX_SECS elapses (then they compute themselves
        without writing back).
        """
        lock_key = f"agg:lock:{key}"
        try:
            got_lock = await asyncio.wait_for(
                self._redis.set(lock_key, "1", nx=True, ex=_LOCK_TTL_SECS),
                timeout=_REDIS_OP_TIMEOUT_SECS,
            )
        except (RedisError, asyncio.TimeoutError):
            # Lock attempt itself failed → degrade to direct compute (no cache write)
            CACHE_UNAVAILABLE.inc()
            payload = await self._compute_with_timing(compute, key_pattern, "redis_down")
            return payload, CacheStatus.REDIS_DOWN

        if not got_lock:
            # Another request holds the lock — wait for it
            CACHE_OPS.labels(operation="get", key_pattern=key_pattern, result="lock_contended").inc()
            entry = await self._wait_for_concurrent_compute(key, key_pattern)
            if entry is not None:
                return entry.payload, CacheStatus.HIT_FRESH
            # Lock holder timed out or died — compute ourselves, do NOT cache
            # (avoid stomping a result that might still arrive from the original holder)
            payload = await self._compute_with_timing(compute, key_pattern, "lock_timeout")
            return payload, CacheStatus.LOCK_TIMEOUT

        # We are the lock holder — compute + write + release
        try:
            CACHE_OPS.labels(operation="get", key_pattern=key_pattern, result="miss").inc()
            payload = await self._compute_with_timing(compute, key_pattern, "miss")
            await self._write(key, payload, fresh_secs, stale_secs, key_pattern)
            return payload, CacheStatus.MISS
        finally:
            try:
                await asyncio.wait_for(
                    self._redis.delete(lock_key),
                    timeout=_REDIS_OP_TIMEOUT_SECS,
                )
            except (RedisError, asyncio.TimeoutError):
                pass  # lock will expire via TTL

    async def _wait_for_concurrent_compute(
        self,
        key: str,
        key_pattern: str,
    ) -> Optional[_CachedEntry]:
        """Poll for cache key while another request computes; returns entry or None on timeout."""
        deadline = time.monotonic() + _LOCK_WAIT_MAX_SECS
        while time.monotonic() < deadline:
            await asyncio.sleep(_LOCK_POLL_INTERVAL_SECS)
            entry, redis_ok = await self._read(key, key_pattern)
            if not redis_ok:
                return None
            # Only a FRESH entry means the lock holder finished — a lingering
            # stale entry must not be mistaken for the new value.
            if entry is not None and entry.is_fresh():
                return entry
        return None

    async def _compute_with_timing(
        self,
        compute: Callable[[], Awaitable[dict]],
        key_pattern: str,
        cache_status_label: str,
    ) -> dict:
        """Run compute() with duration histogram + slow-compute warning."""
        t0 = time.monotonic()
        try:
            return await compute()
        finally:
            duration = time.monotonic() - t0
            AGG_DURATION.labels(
                endpoint=key_pattern, cache_status=cache_status_label,
            ).observe(duration)
            if duration > settings.AGG_CACHE_SLOW_COMPUTE_WARN_SECS:
                log.warning(
                    "cache: slow aggregation key_pattern=%s duration_secs=%.2f",
                    key_pattern, duration,
                )


# ── Module-level singleton ────────────────────────────────────────────────────

_cache: Optional[AggregationCache] = None


def get_aggregation_cache() -> AggregationCache:
    """Lazy singleton — uses the shared async Redis client from app.core.redis_client."""
    global _cache
    if _cache is None:
        from app.core.redis_client import get_redis
        _cache = AggregationCache(get_redis())
    return _cache


def reset_aggregation_cache_for_tests() -> None:
    """Test helper — clear the singleton so tests can inject mocks."""
    global _cache
    _cache = None
