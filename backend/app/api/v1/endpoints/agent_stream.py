"""
SSE endpoint for streaming SSH command output from agents.
Frontend subscribes after calling POST /agents/{id}/stream-command.
"""
import asyncio
import json
import logging

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app.core.redis_client import get_redis

log = logging.getLogger("agent_stream")
router = APIRouter()


@router.get("/{request_id}")
async def stream_command_output(
    request_id: str,
    timeout: int = Query(120, ge=10, le=300, description="Max seconds to wait for stream end"),
):
    """
    Server-Sent Events stream for a running SSH command.
    Yields `data: {chunk, done, success}` events until done=true or timeout.
    """
    async def generate():
        r = get_redis()
        pubsub = r.pubsub()
        await pubsub.subscribe(f"cmd_stream:{request_id}")
        deadline = asyncio.get_event_loop().time() + timeout
        try:
            async for message in pubsub.listen():
                if asyncio.get_event_loop().time() > deadline:
                    yield f"data: {json.dumps({'chunk': '', 'done': True, 'success': False, 'error': 'timeout'})}\n\n"
                    break
                if message["type"] != "message":
                    continue
                try:
                    data = json.loads(message["data"])
                except Exception:
                    continue
                yield f"data: {json.dumps(data)}\n\n"
                if data.get("done"):
                    break
        except asyncio.CancelledError:
            pass
        finally:
            try:
                await pubsub.unsubscribe(f"cmd_stream:{request_id}")
                await pubsub.aclose()
            except Exception:
                pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
