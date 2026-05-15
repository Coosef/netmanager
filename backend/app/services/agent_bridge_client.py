"""
Agent Bridge Client — Faz 6A

Synchronous Celery-side helper. Publishes a command request to the Redis bridge
channel and blocks until the FastAPI-side response arrives (or timeout).

Key invariant: subscribe BEFORE publish — prevents missing the response if
FastAPI processes the request faster than this function subscribes.

Usage:
    from app.services.agent_bridge_client import send_agent_command

    try:
        resp = send_agent_command(
            agent_id="agent_abc",
            command_type="synthetic_probe",
            payload={"probe_type": "icmp", "target": "10.0.0.1", "timeout": 5},
            timeout=15,
        )
        if resp["success"]:
            result = resp["result"]
        else:
            # agent offline or command error — fall back to direct probe
            ...
    except RuntimeError:
        # bridge timeout or Redis unavailable
        ...
"""
import json
import logging
import time
import uuid

import redis as _redis_sync

from app.core.config import settings

log = logging.getLogger(__name__)

_CMD_CHANNEL = "agent:bridge:cmd:{agent_id}"
_RES_CHANNEL = "agent:bridge:res:{request_id}"
_FB_KEY = "agent:bridge:res_fallback:{request_id}"

# Grace period added on top of command timeout to absorb bridge overhead
_GRACE_SECS = 5


def send_agent_command(
    agent_id: str,
    command_type: str,
    payload: dict,
    timeout: int = 30,
) -> dict:
    """
    Publish command to FastAPI bridge listener; block until response or timeout.

    Returns response dict:
        {"request_id": str, "success": bool, "result": dict|None,
         "error": str|None, "duration_ms": int}

    Raises:
        RuntimeError — bridge timeout or Redis unavailable

    Caller is responsible for fallback (e.g. _direct_probe) when this raises.
    """
    r = _redis_sync.from_url(
        settings.REDIS_URL,
        decode_responses=True,
        socket_timeout=5,
        socket_connect_timeout=5,
    )

    rid = uuid.uuid4().hex
    request = {
        "request_id": rid,
        "command_type": command_type,
        "agent_id": agent_id,
        "payload": payload,
        "timeout_secs": timeout,
    }

    res_ch = _RES_CHANNEL.format(request_id=rid)
    cmd_ch = _CMD_CHANNEL.format(agent_id=agent_id)
    fb_key = _FB_KEY.format(request_id=rid)

    # Subscribe FIRST so we cannot miss a fast response
    pubsub = r.pubsub(ignore_subscribe_messages=True)
    try:
        pubsub.subscribe(res_ch)
        r.publish(cmd_ch, json.dumps(request))

        deadline = time.monotonic() + timeout + _GRACE_SECS
        for msg in pubsub.listen():
            if msg and msg.get("type") == "message":
                return json.loads(msg["data"])
            if time.monotonic() >= deadline:
                break
    except Exception as exc:
        log.debug("bridge_client: pubsub error rid=%s — %s", rid[:8], exc)
    finally:
        try:
            pubsub.unsubscribe()
            pubsub.close()
        except Exception:
            pass

    # Fallback: check SETEX key written by FastAPI listener
    try:
        raw = r.get(fb_key)
        if raw:
            log.debug("bridge_client: retrieved from fallback key rid=%s", rid[:8])
            return json.loads(raw)
    except Exception:
        pass

    raise RuntimeError(
        f"bridge timeout after {timeout + _GRACE_SECS}s "
        f"(agent={agent_id}, cmd={command_type}, rid={rid[:8]})"
    )
