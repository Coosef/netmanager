import json
import logging
import socket
from typing import Any, Optional

import redis.asyncio as aioredis
from redis.backoff import ExponentialBackoff
from redis.retry import Retry

from app.core.config import settings

log = logging.getLogger("netmanager.redis")
_redis: Optional[aioredis.Redis] = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            retry_on_timeout=True,
            retry=Retry(ExponentialBackoff(cap=10, base=0.5), retries=6),
            socket_keepalive=True,
            socket_keepalive_options={
                socket.TCP_KEEPIDLE: 60,
                socket.TCP_KEEPINTVL: 10,
                socket.TCP_KEEPCNT: 3,
            },
            socket_connect_timeout=5,
            socket_timeout=5,           # read/write timeout — frozen socket'ların event loop'u bloke etmesini önler
            health_check_interval=30,
        )
    return _redis


async def set_json(key: str, value: Any, ttl: int = 3600) -> None:
    r = get_redis()
    await r.setex(key, ttl, json.dumps(value))


async def get_json(key: str) -> Optional[Any]:
    r = get_redis()
    raw = await r.get(key)
    return json.loads(raw) if raw else None


async def delete_key(key: str) -> None:
    r = get_redis()
    await r.delete(key)


async def publish(channel: str, message: Any) -> None:
    """Redis pub/sub publish. HOTFIX HF#4 — INFO log subscriber count;
    WARNING log on failure (re-raise — caller karar verir)."""
    r = get_redis()
    try:
        sub_count = await r.publish(channel, json.dumps(message))
        log.info(
            "redis: publish ok",
            extra={
                "event": "redis_publish",
                "channel": channel,
                "subscriber_count": sub_count,
            },
        )
    except Exception as exc:
        log.warning(
            "redis: publish failed: %r", exc,
            extra={"event": "redis_publish_failed", "channel": channel},
        )
        raise
