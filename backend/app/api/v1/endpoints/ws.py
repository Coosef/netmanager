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


async def _get_tenant_device_ids(token: str) -> Optional[set]:
    """Return set of device_ids the token owner can see, or None for super_admin (sees all)."""
    from app.core.database import AsyncSessionLocal
    from app.models.device import Device
    from app.models.user import User, UserRole, SystemRole

    payload = decode_access_token(token)
    if not payload:
        return set()
    user_id = payload.get("sub")
    if not user_id:
        return set()

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(User).where(User.id == int(user_id), User.is_active == True)
        )
        user = result.scalar_one_or_none()
        if not user:
            return set()

        if user.system_role == SystemRole.SUPER_ADMIN or user.role == UserRole.SUPER_ADMIN:
            return None  # sees everything

        if not user.tenant_id:
            return set()

        rows = (await db.execute(
            select(Device.id).where(
                Device.tenant_id == user.tenant_id,
                Device.is_active == True,
            )
        )).scalars().all()
        return set(rows)


@router.websocket("/tasks/{task_id}")
async def task_progress_ws(
    websocket: WebSocket,
    task_id: int,
    token: Optional[str] = Query(default=None),
):
    if not await _authenticate_ws(websocket, token):
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
):
    if not await _authenticate_ws(websocket, token):
        return

    accessible_ids = await _get_tenant_device_ids(token or "")

    def _anomaly_allowed(raw: str) -> bool:
        if accessible_ids is None:
            return True
        try:
            data = json.loads(raw)
            dev_id = data.get("device_id")
            return dev_id is not None and dev_id in accessible_ids
        except Exception:
            return False

    await websocket.accept()
    r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()
    await pubsub.subscribe("anomalies")

    recent_stp = await r.lrange("anomalies:stp", 0, 19)
    recent_loop = await r.lrange("anomalies:loop", 0, 19)
    for item in recent_stp + recent_loop:
        if _anomaly_allowed(item):
            await websocket.send_text(item)

    try:
        async for message in pubsub.listen():
            if message["type"] == "message" and _anomaly_allowed(message["data"]):
                await websocket.send_text(message["data"])
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe("anomalies")
        await r.aclose()


@router.websocket("/events")
async def events_ws(
    websocket: WebSocket,
    token: Optional[str] = Query(default=None),
):
    """Live network events stream (persisted events: device_offline, stp, loop, port, etc.)"""
    if not await _authenticate_ws(websocket, token):
        return

    accessible_ids = await _get_tenant_device_ids(token or "")

    def _allowed(raw: str) -> bool:
        if accessible_ids is None:
            return True
        try:
            data = json.loads(raw)
            dev_id = data.get("device_id")
            return dev_id is not None and dev_id in accessible_ids
        except Exception:
            return False

    await websocket.accept()
    r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()
    await pubsub.subscribe("network:events")

    # Replay last 30 events on connect
    recent = await r.lrange("network:events:recent", 0, 29)
    for item in reversed(recent):
        if _allowed(item):
            await websocket.send_text(item)

    try:
        async for message in pubsub.listen():
            if message["type"] == "message" and _allowed(message["data"]):
                await websocket.send_text(message["data"])
    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe("network:events")
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

    # Resolve device + credentials — validate tenant ownership first
    import paramiko
    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.core.security import decrypt_credential_safe, decrypt_credential
    from app.models.device import Device
    from app.models.user import User, UserRole, SystemRole

    accessible_ids = await _get_tenant_device_ids(token or "")

    async with AsyncSessionLocal() as db:
        dev_q = select(Device).where(Device.id == device_id, Device.is_active == True)
        device = (await db.execute(dev_q)).scalar_one_or_none()

    if not device:
        await websocket.close(code=4004)
        return

    # Check tenant ownership (accessible_ids is None only for super_admin)
    if accessible_ids is not None and device_id not in accessible_ids:
        await websocket.close(code=4003)
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
