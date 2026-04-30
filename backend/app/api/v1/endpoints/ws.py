import asyncio
import json

import redis.asyncio as aioredis
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.config import settings

router = APIRouter()


@router.websocket("/tasks/{task_id}")
async def task_progress_ws(websocket: WebSocket, task_id: int):
    await websocket.accept()
    r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()
    await pubsub.subscribe(f"task:{task_id}:progress")

    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                await websocket.send_text(message["data"])
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe(f"task:{task_id}:progress")
        await r.aclose()


@router.websocket("/anomalies")
async def anomalies_ws(websocket: WebSocket):
    await websocket.accept()
    r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()
    await pubsub.subscribe("anomalies")

    recent_stp = await r.lrange("anomalies:stp", 0, 19)
    recent_loop = await r.lrange("anomalies:loop", 0, 19)
    for item in recent_stp + recent_loop:
        await websocket.send_text(item)

    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                await websocket.send_text(message["data"])
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe("anomalies")
        await r.aclose()


@router.websocket("/events")
async def events_ws(websocket: WebSocket):
    """Live network events stream (persisted events: device_offline, stp, loop, port, etc.)"""
    await websocket.accept()
    r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()
    await pubsub.subscribe("network:events")

    # Replay last 30 events on connect
    recent = await r.lrange("network:events:recent", 0, 29)
    for item in reversed(recent):
        await websocket.send_text(item)

    try:
        async for message in pubsub.listen():
            if message["type"] == "message":
                await websocket.send_text(message["data"])
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe("network:events")
        await r.aclose()
