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
    # RBAC F7 — carried so action-level WS endpoints (SSH terminal, agent
    # WS) can gate without re-fetching the user. Same enum as
    # backend.app.models.user.SystemRole.
    system_role: Optional[str] = None
    ok: bool = False

    def has_permission(self, perm: str) -> bool:
        """Mirror of User.has_permission() — checks the role-default grant
        map. Used by WS endpoints to gate mutating actions (e.g. SSH
        terminal requires `device:connect`)."""
        from app.models.user import SYSTEM_ROLE_PERMISSIONS
        perms = SYSTEM_ROLE_PERMISSIONS.get(self.system_role or "", [])
        return "*" in perms or perm in perms


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
        return WsScope(user_id=user.id, system_role=user.system_role, ok=False)
    return WsScope(
        user_id=user.id,
        organization_id=ctx.organization_id,
        is_super_admin=ctx.is_super_admin,
        is_org_wide=ctx.is_org_wide,
        allowed_location_ids=ctx.allowed_location_ids,
        active_location_id=ctx.active_location_id,
        system_role=user.system_role,
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

    # RBAC F7 — opening an SSH terminal IS a mutating action against the
    # device (live shell + audit footprint + keystroke history). Plain
    # 'logged in + scope ok' is not enough; require `device:connect`.
    if not scope.has_permission("device:connect"):
        await websocket.close(code=4003)  # forbidden
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

    # Faz T8.5 — Agent-relay path. VPS doğrudan 10.x.x.x cihaza ulaşamaz;
    # cihaza atanmış bir agent varsa onun üzerinden tunnel aç. Browser
    # protokolü değişmiyor: text+binary+resize JSON aynen.
    # Fallback: agent yok ya da offline → mevcut direct paramiko (aşağıda).
    from app.services.agent_manager import agent_manager as _ag
    use_agent = bool(device.agent_id) and _ag.is_online(device.agent_id)

    # T9 Tur 3A — Session audit logger. Hem agent-relay hem direct paramiko
    # path'lerinde aynı logger örneği; close() finally bloğunda.
    from app.services.terminal_session_logger import TerminalSessionLogger
    from app.core.database import AsyncSessionLocal as _AsyncSessionLocal
    _term_client_ip = websocket.client.host if websocket.client else None
    _term_user_agent = websocket.headers.get("user-agent") if hasattr(websocket, "headers") else None
    if _term_user_agent and len(_term_user_agent) > 512:
        _term_user_agent = _term_user_agent[:512]

    async with _AsyncSessionLocal() as _audit_db_init:
        from sqlalchemy import text as _sql_text_init
        await _audit_db_init.execute(_sql_text_init(
            "SELECT set_config('app.is_super_admin', :sa, true),"
            "       set_config('app.current_org_id', :o, true),"
            "       set_config('app.current_location_id', :l, true)"
        ), {
            "sa": "on" if scope.is_super_admin else "off",
            "o": str(scope.organization_id) if scope.organization_id is not None else "",
            "l": str(scope.active_location_id) if scope.active_location_id is not None else "",
        })
        _term_logger = await TerminalSessionLogger.create(
            _audit_db_init,
            user_id=scope.user_id,
            device_id=device.id,
            agent_id=device.agent_id,
            organization_id=device.organization_id,
            location_id=device.location_id,
            client_ip=_term_client_ip,
            user_agent=_term_user_agent,
            connection_path="agent_relay" if use_agent else "direct_paramiko",
        )

    if use_agent:
        await websocket.send_text(
            f"\r\nConnecting to {username}@{host}:{port} via agent…\r\n"
        )
        closed_evt = asyncio.Event()

        async def _on_output(data: bytes):
            if closed_evt.is_set():
                return
            # T9 Tur 3A — audit (sync, buffer)
            _term_logger.log_output(data)
            try:
                await websocket.send_bytes(data)
            except Exception:
                closed_evt.set()

        async def _on_close():
            closed_evt.set()

        session_id: Optional[str] = None
        try:
            session_id = await _ag.open_shell_session(
                device.agent_id, device, cols=cols, rows=rows,
                on_output=_on_output, on_close=_on_close, timeout=20.0,
            )
        except Exception as exc:
            await websocket.send_text(f"\r\nAgent shell open hata: {exc}\r\n")
            try: await websocket.close()
            except Exception: pass
            revalidator.cancel()
            return

        await websocket.send_text("\r\nConnected (via agent).\r\n")

        try:
            while not closed_evt.is_set():
                try:
                    raw = await asyncio.wait_for(websocket.receive(), timeout=30)
                except (asyncio.TimeoutError, WebSocketDisconnect):
                    break
                if raw.get("type") == "websocket.disconnect":
                    break
                text = raw.get("text") or (raw.get("bytes") or b"").decode(
                    "utf-8", errors="replace"
                )
                if not text:
                    continue
                # Resize control
                if text.startswith("{") and '"type"' in text:
                    try:
                        msg = json.loads(text)
                        if msg.get("type") == "resize":
                            await _ag.send_shell_resize(
                                session_id,
                                int(msg.get("cols", cols)),
                                int(msg.get("rows", rows)),
                            )
                        continue
                    except Exception:
                        pass
                # Keystrokes → agent → device
                _input_bytes = text.encode("utf-8", errors="replace")
                _term_logger.log_input(_input_bytes)  # T9 Tur 3A audit
                await _ag.send_shell_input(session_id, _input_bytes)
        finally:
            revalidator.cancel()
            if session_id:
                await _ag.close_shell_session(session_id)
            try: await websocket.close()
            except Exception: pass
            # T9 Tur 3A — session log final flush
            try:
                await _term_logger.close(_AsyncSessionLocal, exit_reason="user_closed")
            except Exception:
                pass
        return

    # ── Fallback: direct paramiko (agent yok / offline / eski sürüm) ──────
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
    # Aggressive non-blocking — 0 timeout + recv_ready loop. Eski 0.05s
    # timeout her keystroke için 50ms latency ekliyordu; bu özellikle
    # 'show running-config' gibi büyük çıktılarda 'takılma' hissi yarattı.
    channel.setblocking(False)
    await websocket.send_text("\r\nConnected.\r\n")

    stop_event = asyncio.Event()

    def _drain_channel(ch, max_total: int = 65536) -> bytes:
        """Non-blocking: ch.recv_ready ise sırayla read; max_total'a kadar
        biriktir. Tek round-trip'te birden çok küçük chunk gelirse hepsini
        birleştirir — frontend tek bir term.write() çağırır, akıcılık artar."""
        out = bytearray()
        try:
            while ch.recv_ready() and len(out) < max_total:
                chunk = ch.recv(min(16384, max_total - len(out)))
                if not chunk:
                    break
                out.extend(chunk)
        except Exception:
            pass
        return bytes(out)

    async def read_from_ssh():
        """Forward SSH output to WebSocket — aggressively drained."""
        while not stop_event.is_set():
            try:
                data = await loop.run_in_executor(None, _drain_channel, channel)
                if data:
                    _term_logger.log_output(data)
                    await websocket.send_bytes(data)
                elif channel.exit_status_ready() and not channel.recv_ready():
                    break
                else:
                    # Hiç veri yoksa 10ms uyu — 0.05s'den 5× daha hızlı.
                    await asyncio.sleep(0.01)
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
                _input_bytes = text.encode("utf-8", errors="replace")
                _term_logger.log_input(_input_bytes)  # T9 Tur 3A audit
                await loop.run_in_executor(None, channel.sendall, _input_bytes)
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
        # T9 Tur 3A — session log final flush
        try:
            await _term_logger.close(_AsyncSessionLocal, exit_reason="user_closed")
        except Exception:
            pass
