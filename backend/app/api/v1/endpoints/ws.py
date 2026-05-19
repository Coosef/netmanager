import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Optional

import redis.asyncio as aioredis
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.config import settings
from app.core.security import decode_access_token

router = APIRouter()
log = logging.getLogger("netmanager.ws")

# How often a live connection re-checks that its bound scope is still
# valid — Faz 8 Phase E (revoked / stale location handling).
_REVALIDATE_INTERVAL_S = 30


async def _authenticate_ws(websocket: WebSocket, token: Optional[str]) -> bool:
    """Return True if token is valid. Closes the socket with 4001 if not."""
    if not token or not decode_access_token(token):
        await websocket.close(code=4001)
        return False
    return True


@dataclass
class WsScope:
    """The validated tenancy scope of one realtime connection — Faz 8
    Phase E. Bound at connect time and re-checked periodically."""
    user_id: Optional[int] = None
    organization_id: Optional[int] = None
    is_super_admin: bool = False
    is_org_wide: bool = False
    allowed_location_ids: tuple[int, ...] = ()
    # The connection's active location filter. None = all (org-wide).
    active_location_id: Optional[int] = None
    ok: bool = False


async def _resolve_ws_scope(
    token: str, location_param: Optional[int] = None,
) -> WsScope:
    """Resolve a realtime connection's tenancy scope from the token.

    Faz 8 Phase E — the `location` query parameter is validated against
    user_locations exactly like the X-Location-Id header; a connection
    can never bind to a location the user may not access.

      * super-admin              → every org channel, no location filter
      * org-admin                → their org channel, optional location
      * location-scoped user     → their org channel, filtered to their
                                    user_locations set
      * unknown / org-less user  → ok=False (no stream)
    """
    from app.core.database import AsyncSessionLocal
    from app.core.request_context import resolve_location_context
    from app.models.user import User

    payload = decode_access_token(token)
    if not payload:
        return WsScope()
    user_id = payload.get("sub")
    if not user_id:
        return WsScope()

    async with AsyncSessionLocal() as db:
        user = (await db.execute(
            select(User).where(User.id == int(user_id), User.is_active == True)
        )).scalar_one_or_none()
        if not user:
            return WsScope()
        ctx = await resolve_location_context(
            db, user, x_location_id=location_param, channel="websocket",
        )

    if not ctx.has_location_access:
        return WsScope(user_id=user.id, ok=False)
    return WsScope(
        user_id=user.id,
        organization_id=ctx.organization_id,
        is_super_admin=ctx.is_super_admin,
        is_org_wide=ctx.is_org_wide,
        allowed_location_ids=ctx.allowed_location_ids,
        active_location_id=ctx.active_location_id,
        ok=True,
    )


def _event_channels(base: str, scope: WsScope):
    """Return (subscribe_args, is_pattern, recent_key|None) for a per-org
    pub/sub stream. Super-admins pattern-subscribe every org channel."""
    if scope.is_super_admin:
        return f"{base}:org:*", True, None
    if scope.organization_id is None:
        return None, False, None
    org = scope.organization_id
    return f"{base}:org:{org}", False, f"{base}:recent:org:{org}"


def _frame_visible(raw: str, scope: WsScope) -> bool:
    """Whether one event frame may be delivered to this connection.

    Faz 8 Phase E — a location-scoped connection only sees frames whose
    location is in the user's user_locations set; an org-wide connection
    sees the whole org, optionally narrowed to one active location."""
    try:
        loc = json.loads(raw).get("location_id")
    except Exception:
        # Unparseable frame — let org-wide connections see it; hide it
        # from a location-scoped connection (fail closed).
        return scope.is_org_wide or scope.is_super_admin

    if scope.is_super_admin:
        return True
    if scope.is_org_wide:
        # org-admin: whole org, narrowed to the active location if set.
        if scope.active_location_id is None:
            return True
        return loc is None or loc == scope.active_location_id
    # location-scoped: the frame's location must be one the user holds.
    if loc is None:
        return False
    if loc not in scope.allowed_location_ids:
        return False
    if scope.active_location_id is not None:
        return loc == scope.active_location_id
    return True


async def _revalidate_loop(websocket: WebSocket, token: str, bound: WsScope):
    """Periodically re-resolve the connection's scope. If the user lost
    access, the org/location set changed, or the bound active location is
    no longer allowed, close the socket so the client reconnects fresh —
    a live stream never continues under stale or revoked scope."""
    try:
        while True:
            await asyncio.sleep(_REVALIDATE_INTERVAL_S)
            fresh = await _resolve_ws_scope(token, bound.active_location_id)
            stale = (
                not fresh.ok
                or fresh.organization_id != bound.organization_id
                or fresh.is_super_admin != bound.is_super_admin
                or (
                    bound.active_location_id is not None
                    and not fresh.is_super_admin
                    and bound.active_location_id not in fresh.allowed_location_ids
                )
            )
            if stale:
                log.warning(
                    "ws scope revoked — closing connection",
                    extra={
                        "event": "ws_scope_revoked",
                        "user_id": bound.user_id,
                        "organization_id": bound.organization_id,
                        "active_location_id": bound.active_location_id,
                    },
                )
                await websocket.close(code=4003)
                return
    except (WebSocketDisconnect, asyncio.CancelledError):
        return
    except Exception:
        return


@router.websocket("/tasks/{task_id}")
async def task_progress_ws(
    websocket: WebSocket,
    task_id: int,
    token: Optional[str] = Query(default=None),
):
    if not await _authenticate_ws(websocket, token):
        return

    # Faz 8 — scope the task stream to the caller's organization.
    # `tasks` is RLS-scoped; a task invisible under the caller's org context
    # means it belongs to another org → reject (was a cross-org leak).
    scope = await _resolve_ws_scope(token or "")
    if not scope.ok:
        await websocket.close(code=4003)
        return
    from app.core.database import AsyncSessionLocal
    from app.core.org_context import set_org_context, clear_org_context, superadmin_context
    from app.core.rls import apply_rls_context
    from app.models.task import Task
    async with AsyncSessionLocal() as db:
        if scope.is_super_admin:
            with superadmin_context():
                await apply_rls_context(db)
                owned = (await db.execute(
                    select(Task.id).where(Task.id == task_id))).scalar_one_or_none()
        else:
            set_org_context(scope.organization_id, None, False)
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
    revalidator = asyncio.create_task(_revalidate_loop(websocket, token or "", scope))
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
        revalidator.cancel()
        await pubsub.unsubscribe(f"task:{task_id}:progress")
        await r.aclose()


@router.websocket("/anomalies")
async def anomalies_ws(
    websocket: WebSocket,
    token: Optional[str] = Query(default=None),
    location: Optional[int] = Query(default=None),
):
    scope = await _resolve_ws_scope(token or "", location)
    if not token or not decode_access_token(token):
        await websocket.close(code=4001)
        return
    if not scope.ok:
        await websocket.close(code=4003)  # org-less / no-location user
        return
    sub, is_pattern, _ = _event_channels("anomalies", scope)
    if sub is None:
        await websocket.close(code=4003)
        return

    await websocket.accept()
    revalidator = asyncio.create_task(_revalidate_loop(websocket, token or "", scope))
    r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()
    if is_pattern:
        await pubsub.psubscribe(sub)
    else:
        await pubsub.subscribe(sub)

    try:
        async for message in pubsub.listen():
            if message["type"] in ("message", "pmessage") \
                    and _frame_visible(message["data"], scope):
                await websocket.send_text(message["data"])
    except WebSocketDisconnect:
        pass
    finally:
        revalidator.cancel()
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
    organization channel (super-admins pattern-subscribe every org), and
    delivers only frames inside the caller's user_locations scope."""
    scope = await _resolve_ws_scope(token or "", location)
    if not token or not decode_access_token(token):
        await websocket.close(code=4001)
        return
    if not scope.ok:
        await websocket.close(code=4003)  # org-less / no-location user
        return
    sub, is_pattern, recent_key = _event_channels("network:events", scope)
    if sub is None:
        await websocket.close(code=4003)
        return

    await websocket.accept()
    revalidator = asyncio.create_task(_revalidate_loop(websocket, token or "", scope))
    r = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    pubsub = r.pubsub()
    if is_pattern:
        await pubsub.psubscribe(sub)
    else:
        await pubsub.subscribe(sub)

    # Replay the last 30 events on connect — same scope filter applied.
    if recent_key:
        recent = await r.lrange(recent_key, 0, 29)
        for item in reversed(recent):
            if _frame_visible(item, scope):
                await websocket.send_text(item)

    try:
        async for message in pubsub.listen():
            if message["type"] in ("message", "pmessage") \
                    and _frame_visible(message["data"], scope):
                await websocket.send_text(message["data"])
    except WebSocketDisconnect:
        pass
    finally:
        revalidator.cancel()
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
    location: Optional[int] = Query(default=None),
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

    # Resolve device + credentials — validate org AND location ownership.
    import paramiko
    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.core.org_context import set_org_context, clear_org_context, superadmin_context
    from app.core.rls import apply_rls_context
    from app.core.security import decrypt_credential
    from app.models.device import Device

    scope = await _resolve_ws_scope(token or "", location)
    if not scope.ok:
        await websocket.close(code=4003)  # org-less / no-location user
        return

    # Look the device up under the caller's RLS context — Faz 8 Phase E:
    # the active location is included, so a location-scoped user can only
    # open a terminal to a device inside their own location; a device in
    # another location/org is simply invisible.
    async with AsyncSessionLocal() as db:
        dev_q = select(Device).where(Device.id == device_id, Device.is_active == True)
        if scope.is_super_admin:
            with superadmin_context():
                await apply_rls_context(db)
                device = (await db.execute(dev_q)).scalar_one_or_none()
        else:
            set_org_context(
                scope.organization_id,
                None if scope.is_org_wide else scope.active_location_id,
                False,
            )
            await apply_rls_context(db)
            try:
                device = (await db.execute(dev_q)).scalar_one_or_none()
            finally:
                clear_org_context()

    if not device:
        await websocket.close(code=4004)  # absent or cross-scope → not found
        return

    username = device.ssh_username or ""
    password = decrypt_credential(device.ssh_password_enc) if device.ssh_password_enc else ""
    host = device.ip_address
    port = device.ssh_port or 22

    await websocket.accept()
    revalidator = asyncio.create_task(_revalidate_loop(websocket, token or "", scope))

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
        revalidator.cancel()
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
        revalidator.cancel()
        channel.close()
        ssh_client.close()
        try:
            await websocket.close()
        except Exception:
            pass
