import asyncio
import json
import threading
from typing import Optional

import redis.asyncio as aioredis
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.config import settings
from app.core.security import decode_access_token

router = APIRouter()


async def _authenticate_ws(websocket: WebSocket, token: Optional[str]) -> bool:
    """Return True if token is valid. Closes the socket with 4001 if not."""
    if not token or not decode_access_token(token):
        await websocket.close(code=4001)
        return False
    return True


async def _resolve_ws_scope(token: str) -> tuple[Optional[int], bool]:
    """Faz 7 phase6d — resolve a realtime connection's tenancy scope:
    (organization_id, is_super_admin).

      * super-admin            → (None, True)   — every org channel
      * org-bound user         → (org_id, False)
      * unknown / org-less user→ (None, False)  — no channel

    The org id picks the per-org Redis channel the socket subscribes to,
    so cross-org frames are never delivered to it."""
    from app.core.database import AsyncSessionLocal
    from app.models.user import User, UserRole, SystemRole

    payload = decode_access_token(token)
    if not payload:
        return None, False
    user_id = payload.get("sub")
    if not user_id:
        return None, False

    async with AsyncSessionLocal() as db:
        user = (await db.execute(
            select(User).where(User.id == int(user_id), User.is_active == True)
        )).scalar_one_or_none()
        if not user:
            return None, False
        if user.system_role == SystemRole.SUPER_ADMIN or user.role == UserRole.SUPER_ADMIN:
            return None, True
        return user.organization_id, False


def _event_channels(base: str, org_id: Optional[int], is_super: bool):
    """Return (subscribe_args, is_pattern, recent_key|None) for a per-org
    pub/sub stream. Super-admins pattern-subscribe every org channel."""
    if is_super:
        return f"{base}:org:*", True, None
    if org_id is None:
        return None, False, None
    return f"{base}:org:{org_id}", False, f"{base}:recent:org:{org_id}"


def _location_ok(raw: str, active_location: Optional[int]) -> bool:
    """A frame passes when no location filter is active, or the event has
    no location, or its location matches the connection's active one."""
    if active_location is None:
        return True
    try:
        loc = json.loads(raw).get("location_id")
    except Exception:
        return True
    return loc is None or loc == active_location


@router.websocket("/tasks/{task_id}")
async def task_progress_ws(
    websocket: WebSocket,
    task_id: int,
    token: Optional[str] = Query(default=None),
):
    if not await _authenticate_ws(websocket, token):
        return

    # Faz 8 phase A — scope the task stream to the caller's organization.
    # `tasks` is RLS-scoped; a task invisible under the caller's org context
    # means it belongs to another org → reject (was a cross-org leak).
    org_id, is_super = await _resolve_ws_scope(token or "")
    if org_id is None and not is_super:
        await websocket.close(code=4003)
        return
    from app.core.database import AsyncSessionLocal
    from app.core.org_context import set_org_context, clear_org_context, superadmin_context
    from app.core.rls import apply_rls_context
    from app.models.task import Task
    async with AsyncSessionLocal() as db:
        if is_super:
            with superadmin_context():
                await apply_rls_context(db)
                owned = (await db.execute(
                    select(Task.id).where(Task.id == task_id))).scalar_one_or_none()
        else:
            set_org_context(org_id, None, False)
            await apply_rls_context(db)
            try:
                owned = (await db.execute(
                    select(Task.id).where(Task.id == task_id))).scalar_one_or_none()
            finally:
                clear_org_context()
    if not owned:
        await websocket.close(code=4003)  # absent or cross-org → not yours
        return

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
async def anomalies_ws(
    websocket: WebSocket,
    token: Optional[str] = Query(default=None),
    location: Optional[int] = Query(default=None),
):
    org_id, is_super = await _resolve_ws_scope(token or "")
    if not token or not decode_access_token(token):
        await websocket.close(code=4001)
        return
    sub, is_pattern, _ = _event_channels("anomalies", org_id, is_super)
    if sub is None:
        await websocket.close(code=4003)  # org-less user — no stream
        return

    await websocket.accept()
    r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()
    if is_pattern:
        await pubsub.psubscribe(sub)
    else:
        await pubsub.subscribe(sub)

    try:
        async for message in pubsub.listen():
            if message["type"] in ("message", "pmessage") \
                    and _location_ok(message["data"], location):
                await websocket.send_text(message["data"])
    except WebSocketDisconnect:
        pass
    finally:
        if is_pattern:
            await pubsub.punsubscribe(sub)
        else:
            await pubsub.unsubscribe(sub)
        await r.aclose()


@router.websocket("/events")
async def events_ws(
    websocket: WebSocket,
    token: Optional[str] = Query(default=None),
    location: Optional[int] = Query(default=None),
):
    """Live network events stream — subscribes only to the caller's
    organization channel (super-admins pattern-subscribe every org)."""
    org_id, is_super = await _resolve_ws_scope(token or "")
    if not token or not decode_access_token(token):
        await websocket.close(code=4001)
        return
    sub, is_pattern, recent_key = _event_channels("network:events", org_id, is_super)
    if sub is None:
        await websocket.close(code=4003)  # org-less user — no stream
        return

    await websocket.accept()
    r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()
    if is_pattern:
        await pubsub.psubscribe(sub)
    else:
        await pubsub.subscribe(sub)

    # Replay the last 30 events on connect (org-scoped list).
    if recent_key:
        recent = await r.lrange(recent_key, 0, 29)
        for item in reversed(recent):
            if _location_ok(item, location):
                await websocket.send_text(item)

    try:
        async for message in pubsub.listen():
            if message["type"] in ("message", "pmessage") \
                    and _location_ok(message["data"], location):
                await websocket.send_text(message["data"])
    except WebSocketDisconnect:
        pass
    finally:
        if is_pattern:
            await pubsub.punsubscribe(sub)
        else:
            await pubsub.unsubscribe(sub)
        await r.aclose()


@router.websocket("/ssh/{device_id}")
async def ssh_terminal_ws(
    websocket: WebSocket,
    device_id: int,
    token: Optional[str] = Query(default=None),
    cols: int = Query(default=220),
    rows: int = Query(default=50),
):
    """Interactive SSH terminal over WebSocket.

    Protocol:
    - Client → server: plain text (keystrokes) OR JSON {"type":"resize","cols":N,"rows":N}
    - Server → client: plain text (terminal output)
    """
    if not await _authenticate_ws(websocket, token):
        return

    # Resolve device + credentials — validate org ownership first.
    import paramiko
    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.core.org_context import set_org_context, clear_org_context, superadmin_context
    from app.core.rls import apply_rls_context
    from app.core.security import decrypt_credential_safe, decrypt_credential
    from app.models.device import Device

    org_id, is_super = await _resolve_ws_scope(token or "")
    if org_id is None and not is_super:
        await websocket.close(code=4003)  # org-less user
        return

    # Look the device up under the caller's RLS context — a device in
    # another organization is simply invisible, so cross-org SSH is
    # rejected by the same DB policy that scopes every other query.
    async with AsyncSessionLocal() as db:
        dev_q = select(Device).where(Device.id == device_id, Device.is_active == True)
        if is_super:
            with superadmin_context():
                await apply_rls_context(db)
                device = (await db.execute(dev_q)).scalar_one_or_none()
        else:
            set_org_context(org_id, None, False)
            await apply_rls_context(db)
            try:
                device = (await db.execute(dev_q)).scalar_one_or_none()
            finally:
                clear_org_context()

    if not device:
        await websocket.close(code=4004)  # absent or cross-org → not found
        return

    username = device.ssh_username or ""
    password = decrypt_credential(device.ssh_password_enc) if device.ssh_password_enc else ""
    host = device.ip_address
    port = device.ssh_port or 22

    await websocket.accept()

    # Send a status line before connecting
    await websocket.send_text(f"\r\nConnecting to {username}@{host}:{port} …\r\n")

    # Open SSH connection in a thread (paramiko is synchronous)
    loop = asyncio.get_event_loop()
    ssh_client = paramiko.SSHClient()
    ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        await loop.run_in_executor(
            None,
            lambda: ssh_client.connect(host, port=port, username=username, password=password, timeout=15, look_for_keys=False, allow_agent=False),
        )
    except Exception as exc:
        await websocket.send_text(f"\r\nSSH connection failed: {exc}\r\n")
        await websocket.close()
        ssh_client.close()
        return

    channel = await loop.run_in_executor(None, lambda: ssh_client.invoke_shell(term="xterm-256color", width=cols, height=rows))
    channel.settimeout(0.05)
    await websocket.send_text("\r\nConnected.\r\n")

    stop_event = asyncio.Event()

    async def read_from_ssh():
        """Forward SSH output to WebSocket."""
        while not stop_event.is_set():
            try:
                data = await loop.run_in_executor(None, channel.recv, 4096)
                if not data:
                    break
                await websocket.send_bytes(data)
            except Exception:
                await asyncio.sleep(0.05)
        stop_event.set()

    async def read_from_ws():
        """Forward WebSocket input to SSH."""
        while not stop_event.is_set():
            try:
                raw = await asyncio.wait_for(websocket.receive(), timeout=30)
                if raw["type"] == "websocket.disconnect":
                    break
                text = raw.get("text") or (raw.get("bytes") or b"").decode("utf-8", errors="replace")
                if not text:
                    continue
                # Check for resize control message
                if text.startswith("{") and '"type"' in text:
                    try:
                        msg = json.loads(text)
                        if msg.get("type") == "resize":
                            c, r = int(msg.get("cols", cols)), int(msg.get("rows", rows))
                            await loop.run_in_executor(None, lambda: channel.resize_pty(width=c, height=r))
                        continue
                    except Exception:
                        pass
                await loop.run_in_executor(None, channel.sendall, text.encode("utf-8", errors="replace"))
            except (asyncio.TimeoutError, WebSocketDisconnect):
                break
            except Exception:
                break
        stop_event.set()

    try:
        await asyncio.gather(read_from_ssh(), read_from_ws())
    except Exception:
        pass
    finally:
        channel.close()
        ssh_client.close()
        try:
            await websocket.close()
        except Exception:
            pass
