"""
Event Bus — Faz 6C

Redis Streams abstraction that decouples ingestion (receiving syslog / SNMP
events) from processing (persisting them + correlation). Producers `publish`
to a stream in microseconds without touching the DB; a separate consumer
service drains the stream in controlled batches.

Why Redis Streams (not Pub/Sub — which Faz 6A's bridge uses):
  * Persistent — entries survive a consumer restart (Pub/Sub drops them).
  * Consumer groups + XACK — at-least-once delivery.
  * XAUTOCLAIM — a fresh consumer reclaims a crashed consumer's unacked
    entries → zero loss.
  * MAXLEN ~ — bounded memory / backpressure.

Usage — backend (publish side, one persistent event loop):
    from app.services.event_bus import get_event_bus, STREAM_SYSLOG
    entry_id = await get_event_bus().publish(STREAM_SYSLOG, payload)
    if entry_id is None:
        ...  # Redis unavailable — caller falls back

Usage — event_consumer service (own event loop, own redis client):
    bus = EventBus(aioredis.from_url(...))   # socket_timeout > block_ms!
    await bus.ensure_group(STREAM_SYSLOG, GROUP_PERSIST)
    batch = await bus.consume_batch(STREAM_SYSLOG, GROUP_PERSIST, "c1")
    ...persist...
    await bus.ack(STREAM_SYSLOG, GROUP_PERSIST, [e.id for e in batch])
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional

from redis.exceptions import RedisError, ResponseError

log = logging.getLogger(__name__)

# ── Stream / group names ──────────────────────────────────────────────────────
STREAM_SYSLOG = "ingest:syslog"
STREAM_SNMP = "ingest:snmp"
GROUP_PERSIST = "cg:persist"

# ── Tunables ──────────────────────────────────────────────────────────────────
_REDIS_OP_TIMEOUT_SECS = 5.0       # non-blocking ops (publish/ack/claim/xlen)
_DEFAULT_MAXLEN = 500_000          # ~cap on stream length (approx trim)
_DEAD_LETTER_MAXLEN = 50_000


# ── Serialization ─────────────────────────────────────────────────────────────

class _EventEncoder(json.JSONEncoder):
    """Handles datetime/date in event payloads (everything else must be JSON-safe)."""

    def default(self, obj):
        if isinstance(obj, (datetime, date)):
            return obj.isoformat()
        return super().default(obj)


@dataclass
class StreamEntry:
    """A consumed stream entry: Redis entry id + decoded payload dict."""
    id: str
    data: dict


def _parse_pairs(pairs) -> list[StreamEntry]:
    """Turn [(entry_id, {"data": json}), ...] into [StreamEntry, ...]; skip bad rows."""
    out: list[StreamEntry] = []
    for entry_id, fields in pairs or []:
        raw = fields.get("data") if fields else None
        if raw is None:
            continue
        try:
            out.append(StreamEntry(id=entry_id, data=json.loads(raw)))
        except (json.JSONDecodeError, TypeError):
            log.warning("event_bus: skipping unparseable entry %s", entry_id)
    return out


def _parse_xreadgroup(resp) -> list[StreamEntry]:
    """xreadgroup → [[stream, [(id, fields), ...]], ...]."""
    out: list[StreamEntry] = []
    for _stream, pairs in resp or []:
        out.extend(_parse_pairs(pairs))
    return out


# ── EventBus ──────────────────────────────────────────────────────────────────

class EventBus:
    """Async Redis Streams wrapper. The redis client is injected so the backend
    (publish-only, shared client) and the consumer service (own client tuned
    for blocking reads) can each supply an appropriate one."""

    def __init__(self, redis_client):
        self._redis = redis_client

    # ── Producer ──────────────────────────────────────────────────────────────

    async def publish(
        self,
        stream: str,
        payload: dict,
        maxlen: int = _DEFAULT_MAXLEN,
    ) -> Optional[str]:
        """
        XADD `payload` (JSON-encoded into a single `data` field) to `stream`,
        approximately capped at `maxlen` entries.

        Returns the entry id on success, or None on any failure — the caller
        is expected to fall back (e.g. bounded direct insert). Never raises.
        """
        try:
            raw = json.dumps(payload, cls=_EventEncoder, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            log.warning("event_bus: payload not serializable for %s — %s", stream, exc)
            return None
        try:
            return await asyncio.wait_for(
                self._redis.xadd(stream, {"data": raw}, maxlen=maxlen, approximate=True),
                timeout=_REDIS_OP_TIMEOUT_SECS,
            )
        except (RedisError, asyncio.TimeoutError) as exc:
            log.warning("event_bus: publish to %s failed — %s", stream, exc)
            return None

    # ── Consumer group lifecycle ──────────────────────────────────────────────

    async def ensure_group(self, stream: str, group: str) -> None:
        """Create the consumer group (and the stream, via MKSTREAM) if absent.
        Idempotent — an existing group (BUSYGROUP) is not an error."""
        try:
            await self._redis.xgroup_create(stream, group, id="0", mkstream=True)
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise
        except (RedisError, asyncio.TimeoutError) as exc:
            log.warning("event_bus: ensure_group %s/%s failed — %s", stream, group, exc)

    # ── Consumer ──────────────────────────────────────────────────────────────

    async def consume_batch(
        self,
        stream: str,
        group: str,
        consumer: str,
        count: int = 200,
        block_ms: int = 2000,
    ) -> list[StreamEntry]:
        """
        XREADGROUP up to `count` new (never-delivered) entries, blocking up to
        `block_ms` for the first one. Returns [] on timeout / no data / error.

        NOTE: the injected redis client MUST have socket_timeout > block_ms (or
        none) — a blocking read on a short-timeout socket errors out. The
        backend's shared client never calls this (publish-only); the consumer
        service supplies a client tuned for blocking.
        """
        try:
            resp = await self._redis.xreadgroup(
                group, consumer, {stream: ">"}, count=count, block=block_ms,
            )
        except (RedisError, asyncio.TimeoutError) as exc:
            log.warning("event_bus: consume_batch %s failed — %s", stream, exc)
            return []
        return _parse_xreadgroup(resp)

    async def ack(self, stream: str, group: str, ids: list[str]) -> int:
        """XACK processed entries. Returns the count acknowledged."""
        if not ids:
            return 0
        try:
            return int(await asyncio.wait_for(
                self._redis.xack(stream, group, *ids),
                timeout=_REDIS_OP_TIMEOUT_SECS,
            ))
        except (RedisError, asyncio.TimeoutError, ValueError) as exc:
            log.warning("event_bus: ack %s failed — %s", stream, exc)
            return 0

    async def claim_stale(
        self,
        stream: str,
        group: str,
        consumer: str,
        min_idle_ms: int = 60_000,
        count: int = 200,
    ) -> list[StreamEntry]:
        """
        XAUTOCLAIM entries that have been pending (delivered but unacked) longer
        than `min_idle_ms` — recovers work abandoned by a crashed consumer.
        Returns [] on no-pending / error.
        """
        try:
            resp = await asyncio.wait_for(
                self._redis.xautoclaim(
                    stream, group, consumer, min_idle_ms, start_id="0-0", count=count,
                ),
                timeout=_REDIS_OP_TIMEOUT_SECS,
            )
        except (RedisError, asyncio.TimeoutError) as exc:
            log.warning("event_bus: claim_stale %s failed — %s", stream, exc)
            return []
        # xautoclaim → (next_cursor, [(id, fields), ...]) or (..., ..., deleted_ids)
        claimed = resp[1] if isinstance(resp, (list, tuple)) and len(resp) > 1 else []
        return _parse_pairs(claimed)

    # ── Dead-letter (Faz 6C: basic) ───────────────────────────────────────────

    async def to_dead_letter(self, stream: str, entries: list[StreamEntry]) -> None:
        """Re-publish entries that failed processing to `<stream>:dead`.
        Basic for this sprint — a future step can add inspection/replay tooling."""
        dead = f"{stream}:dead"
        for e in entries:
            try:
                raw = json.dumps(e.data, cls=_EventEncoder, separators=(",", ":"))
                await asyncio.wait_for(
                    self._redis.xadd(
                        dead, {"data": raw}, maxlen=_DEAD_LETTER_MAXLEN, approximate=True,
                    ),
                    timeout=_REDIS_OP_TIMEOUT_SECS,
                )
            except (RedisError, asyncio.TimeoutError, TypeError, ValueError) as exc:
                log.warning("event_bus: dead-letter for %s failed — %s", stream, exc)

    # ── Observability ─────────────────────────────────────────────────────────

    async def depth(self, stream: str) -> int:
        """XLEN — current entry count. 0 on error / missing stream."""
        try:
            return int(await asyncio.wait_for(
                self._redis.xlen(stream), timeout=_REDIS_OP_TIMEOUT_SECS,
            ))
        except (RedisError, asyncio.TimeoutError, ValueError):
            return 0

    async def group_lag(self, stream: str, group: str) -> int:
        """Approx backlog for a group (XINFO GROUPS `lag`, else `pending`)."""
        try:
            groups = await asyncio.wait_for(
                self._redis.xinfo_groups(stream), timeout=_REDIS_OP_TIMEOUT_SECS,
            )
        except (RedisError, asyncio.TimeoutError):
            return 0
        for g in groups or []:
            if g.get("name") == group:
                lag = g.get("lag")
                return int(lag if lag is not None else g.get("pending", 0))
        return 0


# ── Sync publisher (Faz 6C G5 — for Celery / sync contexts) ───────────────────
#
# The EventBus class is async. SNMP polling and other Celery tasks run in a
# sync context, so they need a sync way to publish. publish_sync provides a
# generic hook: any sync producer can XADD to a stream. (Full SNMP migration —
# routing poll results through a consumer — is a deliberate follow-up step;
# this just makes the bus reachable from sync code.)

_sync_client = None


def _get_sync_client():
    """Lazily-built sync redis client. Sync redis clients are thread-safe and
    connection-pooled, so a module-level singleton is safe across Celery
    worker threads/forks (unlike the async client)."""
    global _sync_client
    if _sync_client is None:
        import redis as _redis_sync
        from app.core.config import settings
        _sync_client = _redis_sync.from_url(
            settings.REDIS_URL, decode_responses=True, socket_timeout=5,
        )
    return _sync_client


def publish_sync(
    stream: str,
    payload: dict,
    maxlen: int = _DEFAULT_MAXLEN,
) -> Optional[str]:
    """
    Sync XADD — for Celery / sync producers (e.g. SNMP poll tasks).

    Mirrors EventBus.publish: JSON payload into one `data` field, MAXLEN ~trim.
    Returns the entry id, or None on any failure. Never raises.
    """
    try:
        raw = json.dumps(payload, cls=_EventEncoder, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        log.warning("event_bus: publish_sync payload not serializable — %s", exc)
        return None
    try:
        return _get_sync_client().xadd(
            stream, {"data": raw}, maxlen=maxlen, approximate=True,
        )
    except (RedisError, OSError) as exc:
        log.warning("event_bus: publish_sync to %s failed — %s", stream, exc)
        return None


def reset_sync_client_for_tests() -> None:
    """Test helper — clears the sync client singleton."""
    global _sync_client
    _sync_client = None


# ── Backend-side singleton ────────────────────────────────────────────────────

_bus: Optional[EventBus] = None


def get_event_bus() -> EventBus:
    """
    Lazy singleton for the BACKEND (publish side only).

    Safe in the backend because uvicorn runs one persistent event loop, so the
    shared async redis client never crosses loops. The event_consumer service
    must NOT use this — it constructs its own EventBus with a client tuned for
    blocking reads.
    """
    global _bus
    if _bus is None:
        from app.core.redis_client import get_redis
        _bus = EventBus(get_redis())
    return _bus


def reset_event_bus_for_tests() -> None:
    """Test helper — clears the singleton so a mock client can be injected."""
    global _bus
    _bus = None
