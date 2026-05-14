import json
import socket
from typing import Any, Optional

import redis.asyncio as aioredis
from redis.backoff import ExponentialBackoff
from redis.retry import Retry

from app.core.config import settings

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
    r = get_redis()
    await r.publish(channel, json.dumps(message))
