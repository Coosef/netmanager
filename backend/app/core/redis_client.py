import json
from typing import Any, Optional

import redis.asyncio as aioredis

from app.core.config import settings

_redis: Optional[aioredis.Redis] = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
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
