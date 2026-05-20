"""
Event Consumer service — Faz 6C G3

Standalone process that drains the `ingest:syslog` Redis Stream and persists
batches to the DB. Run as:

    python -m app.services.event_consumer

This is the "data plane" counterpart to the backend's "control plane":
  backend         = API + WS + bridge  (publishes to streams)
  event_consumer  = ingestion processing (drains streams → DB)

KI-4 fix: ingestion (XADD) is unbounded-fast, but persistence here is
strictly bounded — ONE DB session, sequential batches of
EVENT_CONSUMER_BATCH_COUNT. No matter how large a syslog burst is, the DB
sees a steady, capped write rate and can never be connection-exhausted.

Reliability:
  * XREADGROUP + XACK — at-least-once delivery.
  * claim_stale (XAUTOCLAIM) every CLAIM_INTERVAL — a restarted/replacement
    consumer reclaims a crashed consumer's unacked entries → zero loss.
  * Two-strike dead-letter: a fresh batch that fails to persist is left
    pending (retried via claim_stale); if the *retry* also fails the batch
    is moved to `<stream>:dead` and acked so it stops cycling.
  * Heartbeat key (event_consumer:alive) for the container healthcheck.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket
import time

log = logging.getLogger("netmanager.event_consumer")

_HEARTBEAT_KEY = "event_consumer:alive"
_HEARTBEAT_TTL_SECS = 30


# ── Stream → persist-handler registry ─────────────────────────────────────────
#
# Faz 6C.1: the consumer drains BOTH ingest streams. Each stream has its own
# persist handler; syslog also runs correlation, SNMP is a pure bulk insert.

async def _persist_syslog(db, payloads, sync_redis) -> int:
    from app.services.syslog_ingest import persist_and_correlate
    return await persist_and_correlate(db, payloads, sync_redis)


async def _persist_snmp(db, payloads, sync_redis) -> int:
    from app.services.snmp_ingest import persist_snmp_batch
    return await persist_snmp_batch(db, payloads)   # SNMP has no correlation


def _stream_handlers() -> dict:
    """{stream: persist_handler}. Order = drain order within a cycle."""
    from app.services.event_bus import STREAM_SNMP, STREAM_SYSLOG
    return {STREAM_SYSLOG: _persist_syslog, STREAM_SNMP: _persist_snmp}


# ── Batch processing (testable units) ─────────────────────────────────────────

async def process_batch(bus, stream: str, entries, sync_redis, is_retry: bool) -> int:
    """
    Persist one batch of `stream` entries and ACK them. Returns rows persisted.

    On failure:
      - fresh batch (is_retry=False) → left pending; claim_stale retries it.
      - retry batch (is_retry=True)  → dead-lettered + acked (two-strike), so
        a poison batch cannot cycle forever.
    """
    from app.core.database import make_worker_session
    from app.core.org_context import superadmin_context
    from app.services.event_bus import GROUP_PERSIST

    if not entries:
        return 0

    handler = _stream_handlers()[stream]
    payloads = [e.data for e in entries]
    ids = [e.id for e in entries]
    t0 = time.monotonic()
    try:
        # Faz 7 — the event consumer is a fleet-wide data-plane processor:
        # it drains a global stream and correlates across every org, so it
        # runs RLS-bypassed. Row WRITES are still org-stamped per row by
        # the before_insert hook (device/agent-derived; unknown agent →
        # the hook's default-org safety net).
        with superadmin_context():
            async with make_worker_session()() as db:
                persisted = await handler(db, payloads, sync_redis)
        await bus.ack(stream, GROUP_PERSIST, ids)
        # Metric failure must not undo a successful persist — own try/except.
        try:
            from app.core.metrics import EVENT_CONSUMER_BATCH_DURATION
            EVENT_CONSUMER_BATCH_DURATION.labels(stream=stream).observe(
                time.monotonic() - t0,
            )
        except Exception:
            pass
        log.info(
            "event_consumer: persisted batch stream=%s size=%d retry=%s",
            stream, persisted, is_retry,
        )
        return persisted
    except Exception:
        log.exception(
            "event_consumer: batch persist failed stream=%s size=%d retry=%s",
            stream, len(entries), is_retry,
        )
        if is_retry:
            # Second failure — give up on this batch so it stops cycling.
            await bus.to_dead_letter(stream, entries)
            await bus.ack(stream, GROUP_PERSIST, ids)
            log.warning(
                "event_consumer: dead-lettered batch stream=%s size=%d",
                stream, len(entries),
            )
        # fresh failure → leave un-acked, claim_stale will retry
        return 0


async def consume_cycle(bus, sync_redis, consumer_name: str, claim_due: bool) -> int:
    """
    One consumer iteration across ALL ingest streams. Returns rows persisted.

    For each stream: when `claim_due`, reclaim stale pending entries from a
    crashed consumer (XAUTOCLAIM) and reprocess them as a retry batch; then
    read a fresh batch.
    """
    from app.core.config import settings
    from app.services.event_bus import GROUP_PERSIST

    persisted = 0

    for stream in _stream_handlers():
        if claim_due:
            claimed = await bus.claim_stale(
                stream, GROUP_PERSIST, consumer_name,
                min_idle_ms=settings.EVENT_CONSUMER_CLAIM_MIN_IDLE_SECS * 1000,
                count=settings.EVENT_CONSUMER_BATCH_COUNT,
            )
            if claimed:
                log.info(
                    "event_consumer: reclaimed %d stale entries stream=%s",
                    len(claimed), stream,
                )
                try:
                    from app.core.metrics import EVENT_CONSUMER_CLAIMED_TOTAL
                    EVENT_CONSUMER_CLAIMED_TOTAL.labels(stream=stream).inc(len(claimed))
                except Exception:
                    pass
                persisted += await process_batch(
                    bus, stream, claimed, sync_redis, is_retry=True,
                )

        batch = await bus.consume_batch(
            stream, GROUP_PERSIST, consumer_name,
            count=settings.EVENT_CONSUMER_BATCH_COUNT,
            block_ms=settings.EVENT_CONSUMER_BLOCK_MS,
        )
        if batch:
            persisted += await process_batch(
                bus, stream, batch, sync_redis, is_retry=False,
            )

    return persisted


# ── Service entrypoint ────────────────────────────────────────────────────────

async def _heartbeat(redis) -> None:
    try:
        await redis.set(_HEARTBEAT_KEY, str(int(time.time())), ex=_HEARTBEAT_TTL_SECS)
    except Exception:
        pass  # heartbeat is best-effort


async def run() -> None:
    """Main service loop. Runs until SIGTERM/SIGINT."""
    import redis.asyncio as aioredis
    import redis as redis_sync

    from app.core.config import settings
    from app.core.logging_config import configure_logging
    from app.services.event_bus import EventBus, GROUP_PERSIST

    configure_logging()

    # Blocking-read client: NO socket_timeout (XREADGROUP BLOCK must be able to
    # wait past any short timeout — same lesson as the Faz 6A bridge pubsub).
    redis = aioredis.from_url(
        settings.REDIS_URL, decode_responses=True, health_check_interval=30,
    )
    # Sync client for correlation_engine's flap guard.
    sync_redis = redis_sync.from_url(
        settings.REDIS_URL, decode_responses=True, socket_timeout=5,
    )
    bus = EventBus(redis)

    consumer_name = f"{socket.gethostname()}-{os.getpid()}"
    log.info("event_consumer: starting as %s", consumer_name)

    for stream in _stream_handlers():
        await bus.ensure_group(stream, GROUP_PERSIST)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass  # signal handlers unavailable (e.g. non-main thread)

    last_claim = 0.0
    claim_interval = settings.EVENT_CONSUMER_CLAIM_INTERVAL_SECS

    while not stop.is_set():
        await _heartbeat(redis)
        now = time.monotonic()
        claim_due = (now - last_claim) >= claim_interval
        if claim_due:
            last_claim = now
        try:
            await consume_cycle(bus, sync_redis, consumer_name, claim_due)
        except Exception:
            log.exception("event_consumer: cycle failed — continuing")
            await asyncio.sleep(1)  # avoid a tight crash loop

    log.info("event_consumer: shutting down")
    try:
        await redis.aclose()
    except Exception:
        pass


if __name__ == "__main__":
    asyncio.run(run())
