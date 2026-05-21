"""
Agent Command Bridge — Faz 6A

FastAPI-side listener. Subscribes to Redis Pub/Sub pattern agent:bridge:cmd:*
and dispatches incoming command requests to agent_manager, publishing responses
back to per-request channels.

Lifecycle: started/stopped in main.py lifespan (see agent_bridge_listener singleton).
"""
import asyncio
import json
import logging
import time

import redis.asyncio as aioredis

log = logging.getLogger(__name__)

# Channel naming convention (mirrors agent_bridge_client.py)
_CMD_PATTERN = "agent:bridge:cmd:*"
_RES_CHANNEL = "agent:bridge:res:{request_id}"
_RES_FALLBACK = "agent:bridge:res_fallback:{request_id}"
_RES_FALLBACK_TTL = 60  # seconds — covers subscribe-after-publish race

# Commands this listener knows how to execute
_SUPPORTED_COMMANDS = frozenset({"synthetic_probe", "ping_check"})


class AgentBridgeListener:
    """
    Background asyncio task that forwards Celery-originated agent commands to
    agent_manager (which holds the live WebSocket connections).

    The process isolation problem:
        Celery workers import agent_manager but their _connections dict is always
        empty (different OS process from uvicorn).  This listener runs inside
        uvicorn where _connections is populated, and acts as the relay.
    """

    def __init__(self):
        self._task: asyncio.Task | None = None
        self._startup_task: asyncio.Task | None = None  # Faz 9 #6 — retry-on-failure connector
        self._pubsub = None
        self._pubsub_conn: aioredis.Redis | None = None  # dedicated — no socket_timeout
        self._redis: aioredis.Redis | None = None        # for publish/setex (shared)
        self._manager = None

    async def start(self, redis_client: aioredis.Redis, manager) -> None:
        """Start bridge listener — non-blocking.

        Faz 9 #6 — schedules a background retry-on-failure task so a transient
        Redis unavailability at lifespan startup does not permanently disable
        the bridge for the rest of the process lifetime. The retry task
        terminates as soon as the pubsub psubscribe succeeds; from that
        moment the bridge serves Celery→agent commands normally.

        Idempotent: a second call while a previous start is still retrying
        is a no-op. Cancel via `stop()`.
        """
        self._redis = redis_client
        self._manager = manager
        if self._startup_task and not self._startup_task.done():
            return  # already connecting
        if self._task and not self._task.done():
            return  # already running
        self._startup_task = asyncio.create_task(
            self._connect_with_retry(), name="bg:agent_bridge_startup",
        )

    async def _connect_with_retry(self) -> None:
        """Connect to Redis and start the listen loop, retrying indefinitely
        with exponential backoff (2 → 4 → 8 → 16 → 30 s cap). Designed to
        recover from a Redis-not-yet-ready race at backend boot."""
        from app.core.config import settings

        backoff = 2.0
        attempt = 0
        try:
            while True:
                attempt += 1
                try:
                    # Pub/Sub listener needs its own connection without
                    # socket_timeout so listen() can block indefinitely
                    # between messages. The shared redis_client has
                    # socket_timeout=5 (used by publish/setex only).
                    pubsub_conn = aioredis.from_url(
                        settings.REDIS_URL,
                        decode_responses=True,
                    )
                    pubsub = pubsub_conn.pubsub()
                    await pubsub.psubscribe(_CMD_PATTERN)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if attempt == 1:
                        # First miss is noise — Redis is usually slightly
                        # behind the backend container in docker-compose.
                        log.info(
                            "bridge: redis not ready yet, retrying — %s",
                            exc,
                        )
                    elif attempt == 5:
                        # Five consecutive failures (~30 s of backoff) is
                        # worth a louder note so ops can spot it.
                        log.warning(
                            "bridge: still unable to start after %d attempts — %s; will keep retrying",
                            attempt, exc,
                        )
                    await asyncio.sleep(min(backoff, 30.0))
                    backoff = min(backoff * 2, 30.0)
                    continue

                # Subscribe succeeded — install + launch listen loop.
                self._pubsub_conn = pubsub_conn
                self._pubsub = pubsub
                self._task = asyncio.create_task(
                    self._listen_loop(), name="bg:agent_bridge",
                )
                if attempt == 1:
                    log.info("bridge: listener started, pattern=%s", _CMD_PATTERN)
                else:
                    log.info(
                        "bridge: listener started after %d attempts, pattern=%s",
                        attempt, _CMD_PATTERN,
                    )
                return
        except asyncio.CancelledError:
            # Shutdown raced ahead of our first successful subscribe.
            # Drop any half-built pubsub objects so stop() has nothing to
            # close out of order.
            try:
                if pubsub is not None:
                    await pubsub.aclose()
            except Exception:
                pass
            try:
                if pubsub_conn is not None:
                    await pubsub_conn.aclose()
            except Exception:
                pass
            raise

    async def stop(self) -> None:
        """Gracefully cancel the listener. Call in lifespan shutdown."""
        # Faz 9 #6 — cancel the retry-on-failure connector if we are still
        # waiting for Redis at shutdown time. Cancelling stops the loop
        # without leaking a half-built pubsub.
        if self._startup_task and not self._startup_task.done():
            self._startup_task.cancel()
            try:
                await self._startup_task
            except asyncio.CancelledError:
                pass
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._pubsub:
            try:
                await self._pubsub.punsubscribe(_CMD_PATTERN)
                await self._pubsub.aclose()
            except Exception:
                pass
        if self._pubsub_conn:
            try:
                await self._pubsub_conn.aclose()
            except Exception:
                pass
        log.info("bridge: listener stopped")

    async def _listen_loop(self) -> None:
        try:
            async for msg in self._pubsub.listen():
                if msg["type"] != "pmessage":
                    continue
                try:
                    channel: str = msg["channel"]
                    agent_id = channel.rsplit(":", 1)[-1]
                    data = json.loads(msg["data"])
                except Exception as exc:
                    log.warning("bridge: malformed message — %s", exc)
                    continue
                # Fire-and-forget so the listen loop is never blocked by one slow command
                asyncio.create_task(
                    self._dispatch(agent_id, data),
                    name=f"bridge:cmd:{data.get('request_id', '?')[:8]}",
                )
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("bridge: listen_loop crashed unexpectedly")

    async def _dispatch(self, agent_id: str, req: dict) -> None:
        rid = req.get("request_id", "")
        if not rid:
            log.warning("bridge: request missing request_id, dropping")
            return

        cmd = req.get("command_type", "")
        payload = req.get("payload", {})
        timeout = req.get("timeout_secs", 30)
        t0 = time.monotonic()

        try:
            if cmd not in _SUPPORTED_COMMANDS:
                raise ValueError(f"unsupported command type: {cmd!r}")

            if not self._manager.is_online(agent_id):
                raise RuntimeError("agent offline")

            result = await asyncio.wait_for(
                self._execute(agent_id, cmd, payload),
                timeout=float(timeout),
            )
            resp: dict = {
                "request_id": rid,
                "success": True,
                "result": result,
                "error": None,
                "duration_ms": int((time.monotonic() - t0) * 1000),
            }
        except Exception as exc:
            resp = {
                "request_id": rid,
                "success": False,
                "result": None,
                "error": str(exc),
                "duration_ms": int((time.monotonic() - t0) * 1000),
            }

        raw = json.dumps(resp)
        res_ch = _RES_CHANNEL.format(request_id=rid)
        fb_key = _RES_FALLBACK.format(request_id=rid)
        try:
            await self._redis.publish(res_ch, raw)
            # SETEX fallback — if Celery subscribed after we published, it can poll this key
            await self._redis.setex(fb_key, _RES_FALLBACK_TTL, raw)
        except Exception:
            log.exception("bridge: failed to publish response for rid=%s", rid[:8])
            return

        log.debug(
            "bridge: dispatched cmd=%s agent=%s rid=%s success=%s dur=%dms",
            cmd, agent_id, rid[:8], resp["success"], resp["duration_ms"],
        )

        # Update Prometheus metrics if available (best-effort — no import at module level)
        try:
            from app.core.metrics import (
                AGENT_BRIDGE_COMMAND_DURATION,
                AGENT_BRIDGE_COMMAND_TOTAL,
            )
            AGENT_BRIDGE_COMMAND_DURATION.labels(command_type=cmd).observe(
                resp["duration_ms"] / 1000
            )
            result_label = "success" if resp["success"] else (
                "agent_offline" if "agent offline" in (resp.get("error") or "")
                else "error"
            )
            AGENT_BRIDGE_COMMAND_TOTAL.labels(command_type=cmd, result=result_label).inc()
        except Exception:
            pass

    async def _execute(self, agent_id: str, cmd: str, payload: dict) -> dict:
        if cmd == "synthetic_probe":
            extra = {k: v for k, v in payload.items()
                     if k not in ("probe_type", "target", "timeout")}
            return await self._manager.execute_synthetic_probe(
                agent_id=agent_id,
                probe_type=payload["probe_type"],
                target=payload["target"],
                timeout=payload.get("timeout", 5),
                **extra,
            )
        if cmd == "ping_check":
            ok = await self._manager.ping_check(
                agent_id=agent_id,
                ip=payload["ip"],
                timeout=payload.get("timeout", 3),
            )
            return {"success": ok}
        raise ValueError(f"unhandled command: {cmd!r}")


# Module-level singleton — imported by main.py lifespan
agent_bridge_listener = AgentBridgeListener()
