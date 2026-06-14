import asyncio
import json
import logging
import os
import re
import secrets
import string
import textwrap
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import redis as _redis_lib
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel
from sqlalchemy import and_, func, select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal, get_db
from app.core.deps import CurrentUser
from app.core.security import hash_password, verify_password
from app.models.agent import Agent
from app.models.agent_command_log import AgentCommandLog
from app.schemas.agent import AgentCreate, AgentCreateResponse, AgentResponse
from app.services.agent_manager import agent_manager

# T8.4 — agent WS bağlantısı yük altında (paralel SSH komutları sırasında)
# kısa süreliğine kopup hemen reconnect oluyor. Bu sürede backend
# agent_offline event'i yazıp UI toast'unu tetikliyor; kullanıcı "agent
# çalışıyor olduğundan eminim" diye haklı şikayet ediyor. Debounce:
# disconnect anında event yazma, X saniye bekle, agent reconnect olduysa
# sessizce yut. Komut tarafı zaten retry ile (vlans-refresh) kapsanıyor.
_AGENT_OFFLINE_DEBOUNCE_SECS = 20

# -- Current agent version (read from script at startup) -----------------------
def _read_agent_version() -> str:
    try:
        script = Path(__file__).parents[4] / "agent_script" / "netmanager_agent.py"
        m = re.search(r'^VERSION\s*=\s*["\'](.+?)["\']', script.read_text(), re.MULTILINE)
        return m.group(1) if m else "unknown"
    except Exception:
        return "unknown"

CURRENT_AGENT_VERSION: str = _read_agent_version()

router = APIRouter()

# TD-2 — Agent WS, kullanıcı-oturumu değil agent_key ile kimlik doğrular. Bu yüzden
# user-auth gerektiren `_feat("agents")` router-seviyesi dependency'sinden (→ oauth2_scheme,
# HTTP-only) AYRI bir router'da durur; aksi halde WS scope'ta oauth2_scheme `request`
# argümanı bulamayıp 5xx üretiyordu. router.py bunu prefix="/agents" altında GATE'SİZ include eder.
agent_ws_router = APIRouter()

# Incident HF#10A (2026-06-03) — Installer download endpoint'leri (agent kurulum
# script'i) X-Agent-Key header ile kimlik doğrular; installer machine'in user
# session'ı yoktur. Mevcut `router`'a `_feat("agents")` Bearer gate uygulandığı
# için bu endpoint'ler kendi key auth'una bile gelmeden 401 "Not authenticated"
# döndürüyordu (T10 Faz A1 feature gate regression).
# Public router gate'siz include edilir (router.py); endpoint kodu kendi
# X-Agent-Key / agent_key doğrulamasını yapar.
agents_public_router = APIRouter()

_redis = _redis_lib.from_url(settings.REDIS_URL, decode_responses=True)
_MAX_FAILED_AUTH = 10   # lock agent WS after this many consecutive failures
_AGENT_EVENT_DEDUP_TTL = 600   # 10 min — suppress duplicate agent online/offline events
_AGENT_OFFLINE_FLAG_TTL = 600  # 10 min — poll skips devices while this flag is set


def _gen_id(length: int = 12) -> str:
    chars = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


def _gen_key(length: int = 48) -> str:
    return secrets.token_urlsafe(length)


def _agent_to_dict(agent: Agent, online_ids: set) -> dict:
    return {
        "id": agent.id,
        "name": agent.name,
        "status": "online" if (agent.id in online_ids or agent_manager.is_online(agent.id)) else "offline",
        "last_heartbeat": agent.last_heartbeat,
        "last_ip": agent.last_ip,
        "local_ip": agent.local_ip,
        "platform": agent.platform,
        "machine_hostname": agent.machine_hostname,
        "version": agent.version,
        "is_active": agent.is_active,
        "created_at": agent.created_at,
        "command_mode": agent.command_mode,
        "allowed_commands": json.loads(agent.allowed_commands) if agent.allowed_commands else [],
        "allowed_ips": agent.allowed_ips or "",
        "failed_auth_count": agent.failed_auth_count,
        "key_last_rotated": agent.key_last_rotated,
        "last_connected_at": agent.last_connected_at,
        "last_disconnected_at": agent.last_disconnected_at,
        "total_connections": agent.total_connections,
    }


async def _emit_agent_event(db: AsyncSession, agent: Agent, event_type: str):
    """Create a NetworkEvent for agent online/offline transitions.
    Deduped to once per 10 min per agent to prevent event storms during reconnect loops."""
    from app.models.network_event import NetworkEvent
    from app.models.device import Device

    # Dedup: skip if same event fired within the last 10 minutes
    dedup_key = f"event:dedup:{agent.id}:{event_type}"
    if _redis.get(dedup_key):
        return
    _redis.setex(dedup_key, _AGENT_EVENT_DEDUP_TTL, "1")

    if event_type == "agent_offline":
        # Mark agent as recently offline so poll_device_status skips its devices
        _redis.setex(f"agent:{agent.id}:recently_offline", _AGENT_OFFLINE_FLAG_TTL, "1")
    elif event_type == "agent_online":
        # Clear offline flag and reset flap counters for all devices of this agent
        _redis.delete(f"agent:{agent.id}:recently_offline")
        # Reset device flap counters (devices were offline due to agent, not themselves)
        device_rows = await db.execute(
            select(Device.id).where(Device.agent_id == agent.id, Device.is_active == True)
        )
        for (dev_id,) in device_rows.fetchall():
            _redis.delete(f"flap:{dev_id}:count")

    severity = "info" if event_type == "agent_online" else "warning"
    title = f"Agent {'çevrimiçi' if event_type == 'agent_online' else 'çevrimdışı'}: {agent.name}"
    ev = NetworkEvent(
        event_type=event_type,
        severity=severity,
        title=title,
        message=f"Agent {agent.id} ({agent.machine_hostname or agent.last_ip or '?'})",
        details={"agent_id": agent.id, "platform": agent.platform, "version": agent.version},
        # Stamp the agent's own org/location explicitly. The WS connection is
        # RLS-scoped to the agent (not super-admin), and the transaction-local
        # GUCs are cleared by the status commit before this emit — so the
        # auto-stamp can't resolve org here. The agent record is the source.
        organization_id=agent.organization_id,
        location_id=agent.location_id,
    )
    db.add(ev)


async def _emit_offline_if_still_offline(
    agent_id: str, agent_pk: int, org_id: int, loc_id: Optional[int],
    debounce_sec: int = _AGENT_OFFLINE_DEBOUNCE_SECS,
) -> None:
    """WS disconnect sonrası bir grace window bekle; agent o sürede
    reconnect ederse 'agent_offline' event'ini hiç yazma (UI toast
    bastırılır). Aksi halde fresh AsyncSession ile event'i yazar.

    Komut yarış durumu: WS yeniden açıldığında agent_manager._connections
    güncellenir; is_online() True döner. Bu yüzden sleep sonu kontrolü
    yeterli — _connections hem RAM hem agent.status DB üzerinden teyit
    edilir."""
    try:
        await asyncio.sleep(debounce_sec)
    except asyncio.CancelledError:
        return
    if agent_manager.is_online(agent_id):
        # Reconnect within debounce window — suppress
        return
    # Açık WS session kapanmış olabilir, yeni AsyncSession aç.
    try:
        async with AsyncSessionLocal() as db2:
            agent2 = await db2.get(Agent, agent_pk)
            if not agent2 or agent2.status == "online":
                return
            # GUCs (RLS WITH CHECK için)
            from sqlalchemy import text as _sql_text2
            await db2.execute(_sql_text2(
                "SELECT set_config('app.is_super_admin','off',true),"
                "       set_config('app.current_org_id', :o, true),"
                "       set_config('app.current_location_id', :l, true)"
            ), {"o": str(org_id), "l": str(loc_id) if loc_id is not None else ''})
            await _emit_agent_event(db2, agent2, "agent_offline")
            await db2.commit()
    except Exception:
        # Helper sessizce başarısız olur; offline event yazılmamış olabilir
        # ama agent durumu DB'de zaten offline. Dedup TTL (10dk) varolan
        # event'in yeniden yazılmasını da engelliyor.
        pass


# -- REST ---------------------------------------------------------------------

async def _get_agent_scoped(agent_id: str, db: AsyncSession) -> Agent:
    """Fetch agent — RLS scopes to the active org / location automatically."""
    q = select(Agent).where(Agent.id == agent_id, Agent.is_active == True)
    agent = (await db.execute(q)).scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


def _assert_agent_device_scope(agent: Agent, device, operation: str) -> None:
    """Faz 8 Phase D — reject an agent operation whose target device is
    outside the agent's organization+location sandbox.

    The endpoint resolves the agent and the device independently (URL
    agent_id + body device_id). RLS scopes each to the *user* — but a
    multi-location user could still pass an agent in location A and a
    device in location B, both of which they can see. This check closes
    that tunnel: the device must be in the *agent's* own org+location.
    """
    from app.services.agent_scope import (
        AgentScope, AgentScopeError, assert_device_in_scope,
    )
    scope = AgentScope(agent.id, agent.organization_id, agent.location_id)
    try:
        assert_device_in_scope(scope, device, operation)
    except AgentScopeError as exc:
        raise HTTPException(status_code=403, detail=str(exc))


@router.get("/", response_model=list[dict])
async def list_agents(db: AsyncSession = Depends(get_db), _: CurrentUser = None):
    q = select(Agent).where(Agent.is_active == True)
    result = await db.execute(q.order_by(Agent.created_at.desc()))
    agents = result.scalars().all()
    online_ids = set(agent_manager.online_agent_ids())
    return [_agent_to_dict(a, online_ids) for a in agents]


@router.get("/{agent_id}/live-metrics", response_model=dict)
async def get_agent_live_metrics(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    agent = await _get_agent_scoped(agent_id, db)

    live = agent_manager.get_live_metrics(agent_id)
    if not live:
        return {"online": False, "metrics": {}}
    return {"online": True, **live}


@router.get("/current-version", response_model=dict)
async def get_current_agent_version(_: CurrentUser = None):
    """Return the server-side current agent version."""
    return {"version": CURRENT_AGENT_VERSION}


@router.post("/{agent_id}/update", response_model=dict)
async def trigger_agent_update(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Manually push an update_available message to a connected agent."""
    agent = await _get_agent_scoped(agent_id, db)
    if not agent_manager.is_online(agent_id):
        raise HTTPException(status_code=409, detail="Agent çevrimdışı — güncelleme gönderilemez")

    sent = await _send_update_command(agent_id)
    if not sent:
        raise HTTPException(status_code=500, detail="Güncelleme komutu gönderilemedi")
    return {"status": "update_sent", "current_version": CURRENT_AGENT_VERSION}


async def _send_update_command(agent_id: str) -> bool:
    """Send update_available to the agent via its WebSocket connection.
    Embeds script content directly in the message to avoid HTTP download issues."""
    from app.services.agent_manager import agent_manager as _am
    import base64
    ws = _am._connections.get(agent_id)
    if not ws:
        return False
    try:
        script_path = Path(__file__).parents[4] / "agent_script" / "netmanager_agent.py"
        script_content_b64 = None
        if script_path.exists():
            script_content_b64 = base64.b64encode(script_path.read_bytes()).decode()
        await ws.send_text(json.dumps({
            "type": "update_available",
            "current_version": CURRENT_AGENT_VERSION,
            "script_path": "/api/v1/agents/download/script",
            "script_content": script_content_b64,
        }))
        return True
    except Exception:
        return False


@router.post("/{agent_id}/ping", response_model=dict)
async def ping_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Real-time WebSocket connection check. Returns online status + heartbeat age."""
    agent = await _get_agent_scoped(agent_id, db)

    online = agent_manager.is_online(agent_id)
    live = agent_manager.get_live_metrics(agent_id) if online else None

    heartbeat_age_secs: float | None = None
    if live and live.get("last_heartbeat"):
        try:
            from datetime import datetime, timezone
            hb = datetime.fromisoformat(live["last_heartbeat"])
            heartbeat_age_secs = round((datetime.now(timezone.utc) - hb).total_seconds(), 1)
        except Exception:
            pass

    return {
        "online": online,
        "agent_id": agent_id,
        "name": agent.name,
        "heartbeat_age_secs": heartbeat_age_secs,
        "last_heartbeat": live.get("last_heartbeat") if live else None,
        "version": (live.get("metrics") or {}).get("version") if live else None,
        "cpu_pct": (live.get("metrics") or {}).get("cpu_percent") if live else None,
        "ram_pct": (live.get("metrics") or {}).get("memory_percent") if live else None,
        "checked_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
    }


@router.post("/{agent_id}/restart", response_model=dict)
async def restart_agent(
    agent_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:update"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    agent = await _get_agent_scoped(agent_id, db)

    sent = await agent_manager.send_restart(agent_id)
    if not sent:
        raise HTTPException(status_code=409, detail="Agent is offline — cannot restart")

    from app.services.audit_service import log_action
    await log_action(db, current_user, "agent_restart_requested", "agent", agent_id, agent.name, request=request)

    return {"status": "restart_sent", "agent_id": agent_id}


@router.post("/", response_model=AgentCreateResponse, status_code=201)
async def create_agent(
    payload: AgentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    # Faz 7 — bind the agent to exactly one organization + location. The
    # location is resolved here and its org is authoritative; a cross-org
    # location id is invisible under RLS, so it cannot be selected.
    from app.core.org_context import get_current_location_id
    from app.models.location import Location

    loc_id = payload.location_id or get_current_location_id()
    if loc_id is None:
        raise HTTPException(
            status_code=400,
            detail="Agent bir lokasyona bağlanmalı — location_id gerekli",
        )
    loc = (await db.execute(
        select(Location).where(Location.id == loc_id)
    )).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Lokasyon bulunamadı")

    # Faz 8 Phase H — organization quota + lifecycle gate for new agents.
    from app.models.shared.organization import Organization
    from app.core.request_context import is_super_admin
    from app.services.org_management import enforce_org_can_create
    _org = await db.get(Organization, loc.organization_id)
    await enforce_org_can_create(
        db, _org, "agents",
        actor_user_id=current_user.id,
        is_super_admin=is_super_admin(current_user),
    )

    agent_id = _gen_id()
    raw_key = _gen_key()

    agent = Agent(
        id=agent_id,
        name=payload.name,
        agent_key_hash=hash_password(raw_key),
        status="offline",
        created_by=current_user.id,
        command_mode="all",
        organization_id=loc.organization_id,
        location_id=loc.id,
    )
    db.add(agent)
    await db.commit()
    await db.refresh(agent)

    return {
        "id": agent.id,
        "name": agent.name,
        "status": agent.status,
        "last_heartbeat": agent.last_heartbeat,
        "last_ip": agent.last_ip,
        "platform": agent.platform,
        "machine_hostname": agent.machine_hostname,
        "version": agent.version,
        "is_active": agent.is_active,
        "created_at": agent.created_at,
        "agent_key": raw_key,
    }


@router.delete("/{agent_id}", status_code=204)
async def delete_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:delete"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    agent = await _get_agent_scoped(agent_id, db)
    # Faz 7 — soft delete: deactivate + stamp deleted_at (RLS hides it).
    # archived_visible() keeps the post-update row valid mid-statement.
    from datetime import datetime, timezone
    from app.core.org_context import archived_visible
    from app.core.rls import apply_rls_context
    with archived_visible():
        await apply_rls_context(db)
        agent.is_active = False
        agent.deleted_at = datetime.now(timezone.utc)
        await db.commit()


# -- Security config -----------------------------------------------------------

@router.put("/{agent_id}/security", response_model=dict)
async def update_agent_security(
    agent_id: str,
    body: dict,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Update command mode, allowed commands and allowed source IPs for an agent."""
    if not current_user.has_permission("device:update"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    agent = await _get_agent_scoped(agent_id, db)

    command_mode = body.get("command_mode", agent.command_mode)
    if command_mode not in ("all", "whitelist", "blacklist"):
        raise HTTPException(status_code=400, detail="command_mode must be: all | whitelist | blacklist")

    allowed_commands = body.get("allowed_commands")  # list or None
    allowed_ips = body.get("allowed_ips", agent.allowed_ips)

    agent.command_mode = command_mode
    agent.allowed_commands = json.dumps(allowed_commands) if allowed_commands is not None else agent.allowed_commands
    agent.allowed_ips = allowed_ips or None

    await db.commit()

    # Refresh in-memory cache
    agent_manager.set_security_config(agent_id, agent.command_mode, agent.allowed_commands)

    # Push config to connected agent
    cmds = json.loads(agent.allowed_commands) if agent.allowed_commands else []
    await agent_manager.send_security_config(agent_id, agent.command_mode, cmds)

    from app.services.audit_service import log_action
    await log_action(db, current_user, "agent_security_updated", "agent", agent_id, agent.name, request=request)

    return {"status": "updated", "command_mode": agent.command_mode, "agent_id": agent_id}


@router.post("/{agent_id}/rotate-key", response_model=dict)
async def rotate_agent_key(
    agent_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Rotate agent key. New key returned once; agent will apply it if online."""
    if not current_user.has_permission("device:update"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    agent = await _get_agent_scoped(agent_id, db)

    new_key = _gen_key()
    agent.agent_key_hash = hash_password(new_key)
    agent.key_last_rotated = datetime.now(timezone.utc)
    agent.failed_auth_count = 0  # reset lockout on key rotation
    await db.commit()

    # Try to notify connected agent — it will update its local env file
    sent = await agent_manager.send_key_rotate(agent_id, new_key)

    from app.services.audit_service import log_action
    await log_action(db, current_user, "agent_key_rotated", "agent", agent_id, agent.name, request=request)

    return {
        "agent_id": agent_id,
        "new_key": new_key,
        "agent_notified": sent,
        "rotated_at": agent.key_last_rotated.isoformat(),
    }


@router.post("/{agent_id}/unlock", response_model=dict)
async def unlock_agent(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Clear failed_auth_count to unlock a brute-force locked agent."""
    if not current_user.has_permission("device:update"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    agent = await _get_agent_scoped(agent_id, db)

    agent.failed_auth_count = 0
    await db.commit()
    return {"status": "unlocked", "agent_id": agent_id}


# -- Command audit log ---------------------------------------------------------

@router.get("/{agent_id}/commands", response_model=dict)
async def get_agent_commands(
    agent_id: str,
    limit: int = Query(100, le=500),
    offset: int = Query(0),
    blocked_only: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Return paginated command audit log for an agent."""
    await _get_agent_scoped(agent_id, db)

    q = select(AgentCommandLog).where(AgentCommandLog.agent_id == agent_id)
    if blocked_only:
        q = q.where(AgentCommandLog.blocked == True)
    q = q.order_by(desc(AgentCommandLog.executed_at)).offset(offset).limit(limit)

    rows = (await db.execute(q)).scalars().all()
    items = [
        {
            "id": r.id,
            "agent_id": r.agent_id,
            "device_id": r.device_id,
            "device_ip": r.device_ip,
            "command_type": r.command_type,
            "command": r.command,
            "success": r.success,
            "duration_ms": r.duration_ms,
            "blocked": r.blocked,
            "block_reason": r.block_reason,
            "executed_at": r.executed_at.isoformat(),
        }
        for r in rows
    ]
    return {"items": items, "total": len(items), "offset": offset, "limit": limit}


# -- Installer download --------------------------------------------------------

# HF#10A — public router (gate'siz). X-Agent-Key endpoint içinde doğrulanır.
@agents_public_router.get("/{agent_id}/download/{platform}")
async def download_installer(
    agent_id: str,
    platform: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    # T8.4 F3 / CyberStrike pentest MEDIUM CWE-598:
    #   agent_key URL query'sinde TAŞINIYORDU → CDN/proxy log'larına,
    #   browser history'sine, shell history'sine sızar. Header-first;
    #   Query backward-compat (deprecation log) için tutuluyor — bir
    #   sonraki minor release'de tamamen kaldırılır.
    x_agent_key: str = Header(None, alias="X-Agent-Key",
                              description="Agent key (preferred; URL query yerine header)"),
    agent_key_q: str = Query(None, alias="agent_key",
                             description="DEPRECATED: X-Agent-Key header'ı kullanın"),
    server_url: str = Query(None, description="Public server URL visible to the agent machine"),
):
    """Generate a platform-specific installer script with embedded credentials."""
    if platform not in ("linux", "windows"):
        raise HTTPException(status_code=400, detail="platform must be linux or windows")

    # T8.4 F3 — Header tercih edilen, query backward-compat. İkisi de
    # boşsa 401.
    agent_key = x_agent_key or agent_key_q
    if not agent_key:
        raise HTTPException(
            status_code=401,
            detail="X-Agent-Key header gerekli (veya geçici olarak agent_key query)",
        )
    if not x_agent_key and agent_key_q:
        # Deprecation telemetry — Audit log'a yaz, operatör URL'den
        # header'a geçirsin diye görsün.
        import logging
        logging.getLogger("netmanager.security").warning(
            "agent_key query string usage (DEPRECATED) — agent_id=%s, ip=%s",
            agent_id, request.client.host if request.client else "?",
        )

    # Public, credential-authenticated endpoint: the installer machine has no
    # user session, so `get_db` carries no RLS context and FORCE ROW LEVEL
    # SECURITY on `agents` would hide every row (→ 404). Bypass RLS for this
    # lookup (transaction-local), then authenticate via the agent_key itself.
    from sqlalchemy import text as _sql_text
    await db.execute(_sql_text("SELECT set_config('app.is_super_admin', 'on', true)"))
    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()
    if not agent or not verify_password(agent_key, agent.agent_key_hash):
        raise HTTPException(status_code=404, detail="Agent not found")

    # T8.4 Security F1.3 — server_url command injection fix (CyberStrike
    # pentest HIGH). Eski versiyon `server_url`'i validation'sız shell
    # template'e interpolate ediyordu; saldırgan `"` ile kapatıp `; rm -rf`
    # ekleyebiliyordu. Yeni: strict scheme + netloc validation + ALLOWED
    # ORIGIN whitelist. Whitelist = ALLOWED_ORIGINS env + AGENT_WS_URL.
    def _validate_server_url(url: str) -> str:
        from urllib.parse import urlparse
        try:
            parsed = urlparse(url)
        except Exception:
            raise HTTPException(400, "server_url parse edilemedi")
        if parsed.scheme not in ("http", "https"):
            raise HTTPException(400, "server_url scheme http veya https olmalı")
        if not parsed.netloc:
            raise HTTPException(400, "server_url netloc eksik")
        # Shell-anlamlı karakterler reddet — installer template'e
        # interpolate edilecek değer içinde ASLA bulunmamalı.
        forbidden = set('"\';|`$&\\\n\r<> ')
        if any(c in url for c in forbidden):
            raise HTTPException(400, "server_url geçersiz karakter içeriyor")
        # Whitelist: production'da yalnız bilinen origin'ler
        allowed = set()
        for origin in (settings.allowed_origins_list or []):
            o = origin.strip().rstrip("/")
            if o and o != "*":
                allowed.add(o)
        if settings.AGENT_WS_URL:
            allowed.add(settings.AGENT_WS_URL.rstrip("/"))
        base = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
        if allowed and base not in allowed:
            raise HTTPException(
                400,
                f"server_url izin verilen liste dışı (allowed: {sorted(allowed)})",
            )
        return base

    if server_url:
        base_url = _validate_server_url(server_url)
    elif settings.AGENT_WS_URL:
        base_url = settings.AGENT_WS_URL.rstrip("/")
    else:
        forwarded_host = request.headers.get("x-forwarded-host")
        forwarded_proto = request.headers.get("x-forwarded-proto", "http")
        if forwarded_host:
            # Forwarded-host trusted (reverse proxy set'liyor) ama yine de
            # shell-anlamlı karakter olabilir mi? Defansif sanitize.
            safe_host = "".join(c for c in forwarded_host
                                if c.isalnum() or c in ".:-")
            base_url = f"{forwarded_proto}://{safe_host}"
        else:
            base_url = str(request.base_url).rstrip("/")

    if platform == "linux":
        script = _linux_installer(agent_id, agent_key, base_url)
        filename = f"netmanager-agent-{agent_id}-linux.sh"
        body_bytes = script.encode("utf-8")
        media_type_with_charset = "text/x-shellscript; charset=utf-8"
    else:
        # WIN-INTEGRATE: when WINDOWS_AGENT_V2_ENABLED is false we serve
        # a 503 instead of the legacy sc.exe-based PowerShell installer.
        # That legacy script was architecturally broken (Python child
        # registered as a Windows service does not implement the SCM
        # dispatcher protocol → Error 1053), so handing it to a user
        # would be worse than telling them the feature is currently
        # off. The new Go-host-based installer is shipped via the same
        # endpoint when the flag is on; until then, hard fail.
        if not settings.WINDOWS_AGENT_V2_ENABLED:
            raise HTTPException(
                status_code=503,
                detail="Windows installer temporarily unavailable. Please contact your administrator.",
            )
        script = _windows_installer(agent_id, agent_key, base_url)
        filename = f"netmanager-agent-{agent_id}-windows.ps1"
        # WINDOWS-INSTALLER-FIX (2026-06-11) — UTF-8 BOM + CRLF +
        # charset so Windows PowerShell 5.1's cp1254/cp1252 fallback
        # does not mis-decode non-ASCII bytes. See PR #75 RCA.
        body_bytes = (
            b"\xef\xbb\xbf"
            + script.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")
        )
        media_type_with_charset = "text/plain; charset=utf-8"

    return Response(
        content=body_bytes,
        media_type=media_type_with_charset,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


# ---------------------------------------------------------------------
# WIN-INTEGRATE — Windows agent host (Go binary) download
# ---------------------------------------------------------------------

_HOST_BIN_PATH     = "/opt/netmanager/agent-bins/charon-agent-host-windows-amd64.exe"
_HOST_SHA_PATH     = _HOST_BIN_PATH + ".sha256"
_HOST_VERSION_PATH = _HOST_BIN_PATH + ".version"
_HOST_SIZE_MIN     = 1 * 1024 * 1024        # 1 MB lower sanity bound
_HOST_SIZE_MAX     = 50 * 1024 * 1024       # 50 MB upper sanity bound

# Authoritative version contract — the build pipeline writes the
# .version sidecar after validating HOST_VERSION against this regex.
# The 12-char SHA is the git short hash of the source commit. The
# previous default sentinel `dev` and any malformed value
# (uppercase, non-hex, wrong length) fail this match and are
# rejected at integrity check time rather than served as "unknown".
import re as _agent_re_module
_HOST_VERSION_RE = _agent_re_module.compile(r"^2\.0\.0-mvp0\+g[0-9a-f]{12}$")


class _HostBinaryIntegrity:
    """Cached integrity result for the embedded Windows host binary.

    Read once per backend process boot. A bad result (binary missing,
    SHA mismatch, version sidecar missing or malformed) is a
    permanent "host endpoint unavailable" — flipping it requires an
    image rebuild, which means a process restart and re-read. Linux
    endpoints, login, dashboard and the rest of the backend stay up
    regardless.
    """
    ok: bool = False
    sha256: str | None = None
    version: str | None = None
    size: int | None = None
    error: str | None = None


def _read_host_integrity() -> _HostBinaryIntegrity:
    """Validate the embedded host binary + sidecars. Never raises.

    Sidecars are written by the multi-stage Dockerfile build:
      <bin>.sha256   — 64-hex SHA-256 of <bin>
      <bin>.version  — `2.0.0-mvp0+g<12-hex>` produced from the
                       source git short SHA, validated against
                       _HOST_VERSION_RE at build time.

    The version sidecar is the AUTHORITATIVE source of truth for
    the binary's version — no `strings` probe, no subprocess. A
    missing, unreadable, or malformed version sidecar is a hard
    integrity failure (NOT "unknown" — production never serves a
    binary whose version we cannot prove).
    """
    out = _HostBinaryIntegrity()
    import os
    import hashlib
    import logging

    log = logging.getLogger("netmanager.security")

    try:
        # -- binary file -------------------------------------------
        if not os.path.isfile(_HOST_BIN_PATH):
            out.error = "binary file missing"
            return out
        size = os.path.getsize(_HOST_BIN_PATH)
        if size < _HOST_SIZE_MIN or size > _HOST_SIZE_MAX:
            out.error = f"binary size {size} out of sanity range"
            return out
        out.size = size

        # -- SHA-256 sidecar ---------------------------------------
        if not os.path.isfile(_HOST_SHA_PATH):
            out.error = "sha sidecar missing"
            return out
        with open(_HOST_SHA_PATH, "r") as f:
            sidecar = f.read().strip().split()[0]
        if len(sidecar) != 64 or not all(c in "0123456789abcdef" for c in sidecar):
            out.error = "sha sidecar format invalid"
            return out

        h = hashlib.sha256()
        with open(_HOST_BIN_PATH, "rb") as f:
            for chunk in iter(lambda: f.read(64 * 1024), b""):
                h.update(chunk)
        actual = h.hexdigest()
        if actual != sidecar:
            out.error = "sha256 mismatch"
            log.error("host binary integrity: sha mismatch")
            return out

        # -- version sidecar (authoritative) -----------------------
        if not os.path.isfile(_HOST_VERSION_PATH):
            out.error = "version sidecar missing"
            log.error("host binary integrity: version sidecar missing")
            return out
        try:
            with open(_HOST_VERSION_PATH, "r") as f:
                raw_version = f.read().strip()
        except OSError:
            out.error = "version sidecar unreadable"
            log.error("host binary integrity: version sidecar unreadable")
            return out

        if not _HOST_VERSION_RE.match(raw_version):
            # Catches: "dev", "", uppercase, non-hex, wrong length,
            # missing prefix — all reject.
            out.error = "version sidecar malformed"
            log.error(
                "host binary integrity: version sidecar malformed "
                "(length=%d does-not-match-regex)",
                len(raw_version),
            )
            return out

        out.ok = True
        out.sha256 = actual
        out.version = raw_version
        return out
    except Exception as e:
        out.error = f"integrity check exception: {type(e).__name__}"
        log.exception("host binary integrity check exploded")
        return out


_HOST_INTEGRITY_CACHE: _HostBinaryIntegrity | None = None


def _host_integrity() -> _HostBinaryIntegrity:
    """Memoised per-process integrity result."""
    global _HOST_INTEGRITY_CACHE
    if _HOST_INTEGRITY_CACHE is None:
        _HOST_INTEGRITY_CACHE = _read_host_integrity()
    return _HOST_INTEGRITY_CACHE


@agents_public_router.get("/{agent_id}/download/host/windows-amd64")
async def download_agent_host(
    agent_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    x_agent_key: str = Header(None, alias="X-Agent-Key"),
):
    """Serve the Windows agent host binary (charon-agent-host.exe).

    Gated by WINDOWS_AGENT_V2_ENABLED. The endpoint validates the
    requester with the same agent_key contract as the platform
    installer endpoint above; the binary itself is a static artefact
    baked into the backend image at build time (see
    backend/Dockerfile multi-stage agent-host-builder).

    Range requests are NOT supported in MVP; if a client sends a Range
    header we ignore it and serve the full 200 response.
    """
    import logging
    log = logging.getLogger("netmanager.security")

    # Flag gate first — feature off → 404 (do not even hint that the
    # endpoint exists when the flag is closed).
    if not settings.WINDOWS_AGENT_V2_ENABLED:
        raise HTTPException(status_code=404, detail="Endpoint not available")

    if not x_agent_key:
        raise HTTPException(status_code=401, detail="X-Agent-Key header required")

    # Authenticate via the agent_key contract. RLS bypass like the
    # other public installer endpoint — the installer machine has no
    # user session.
    from sqlalchemy import text as _sql_text
    await db.execute(_sql_text("SELECT set_config('app.is_super_admin', 'on', true)"))
    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()
    if not agent or not verify_password(x_agent_key, agent.agent_key_hash):
        raise HTTPException(status_code=404, detail="Agent not found")

    integ = _host_integrity()
    if not integ.ok:
        # Server log gets the real reason; client gets generic 503.
        log.error(
            "host binary integrity check failed: %s (size=%s)",
            integ.error, integ.size,
        )
        raise HTTPException(status_code=503, detail="Host binary not available")

    # Stream the binary. FastAPI's Response holds it in memory which
    # is fine for ~3 MB; no need for FileResponse / chunking yet.
    try:
        with open(_HOST_BIN_PATH, "rb") as f:
            body_bytes = f.read()
    except OSError:
        log.error("host binary read failed at request time")
        raise HTTPException(status_code=503, detail="Host binary not available")

    return Response(
        content=body_bytes,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": 'attachment; filename="charon-agent-host-windows-amd64.exe"',
            "Content-Length": str(len(body_bytes)),
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
            # integ.ok is True here, which means _read_host_integrity
            # passed the version regex — version is never None.
            "X-Host-Version": integ.version,
            "X-Host-SHA256": integ.sha256 or "",
        },
    )


# ---------------------------------------------------------------------
# WIN-INTEGRATE — Windows agent v2 private Python runtime bundle
# ---------------------------------------------------------------------
#
# Two new flag-gated endpoints (Section D of the architecture plan):
#
#   GET /api/v1/agents/{agent_id}/download/runtime/windows-amd64/manifest
#   GET /api/v1/agents/{agent_id}/download/runtime/windows-amd64
#
# Both share the host endpoint's gating shape:
#   - flag off            → 404 (do not hint the endpoint exists)
#   - missing X-Agent-Key → 401
#   - wrong agent or key  → 404 (info-disclosure safe)
#   - integrity failure   → 503 (generic)
#
# The on-disk source-of-truth is parallel to the host binary at
# `agents.py:718-720`:
#   /opt/netmanager/agent-bins/charon-runtime-windows-amd64.current        (single-line version)
#   /opt/netmanager/agent-bins/charon-runtime-windows-amd64-<v>.zip
#   /opt/netmanager/agent-bins/charon-runtime-windows-amd64-<v>.zip.sha256
#   /opt/netmanager/agent-bins/charon-runtime-windows-amd64-<v>.manifest.json
#
# Integrity is checked once per process boot and memoized via
# `app.services.windows_runtime.integrity.runtime_integrity()`.


async def _authenticate_runtime_agent(
    agent_id: str,
    x_agent_key: str | None,
    db: AsyncSession,
) -> None:
    """Shared auth gate for the two runtime endpoints.

    Raises HTTPException(404) when the flag is off, (401) when the
    header is missing, or (404) when the agent or key is wrong.
    Returns None on success.
    """
    if not settings.WINDOWS_AGENT_V2_ENABLED:
        raise HTTPException(status_code=404, detail="Endpoint not available")
    if not x_agent_key:
        raise HTTPException(status_code=401, detail="X-Agent-Key header required")

    from sqlalchemy import text as _sql_text
    await db.execute(_sql_text("SELECT set_config('app.is_super_admin', 'on', true)"))
    result = await db.execute(
        select(Agent).where(Agent.id == agent_id, Agent.is_active == True)
    )
    agent = result.scalar_one_or_none()
    if not agent or not verify_password(x_agent_key, agent.agent_key_hash):
        raise HTTPException(status_code=404, detail="Agent not found")


@agents_public_router.get("/{agent_id}/download/runtime/windows-amd64/manifest")
async def download_agent_runtime_manifest(
    agent_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    x_agent_key: str = Header(None, alias="X-Agent-Key"),
):
    """Serve the detached runtime-bundle manifest (JSON).

    The body is the on-disk manifest bytes VERBATIM — the installer
    persists the response and feeds it back through the same Pydantic
    schema at Stage 4, so any in-flight reformatting (key re-order,
    re-indent) would break that downstream parity. We do NOT
    re-serialize.
    """
    import logging
    log = logging.getLogger("netmanager.security")

    await _authenticate_runtime_agent(agent_id, x_agent_key, db)

    integ = _host_integrity()
    baked_version = integ.version if integ.ok else None

    from app.services.windows_runtime.integrity import runtime_integrity
    r = runtime_integrity(baked_version)
    if not r.ok or r.manifest_bytes is None:
        log.error("runtime manifest integrity check failed: %s", r.error)
        raise HTTPException(status_code=503, detail="Runtime bundle not available")

    return Response(
        content=r.manifest_bytes,
        media_type="application/json",
        headers={
            "Content-Length": str(len(r.manifest_bytes)),
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )


@agents_public_router.get("/{agent_id}/download/runtime/windows-amd64")
async def download_agent_runtime(
    agent_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    x_agent_key: str = Header(None, alias="X-Agent-Key"),
):
    """Serve the runtime-bundle ZIP.

    Range requests are NOT supported in MVP; a `Range` header is
    ignored and the full 200 response is served (parity with the
    host binary endpoint above).
    """
    import logging
    log = logging.getLogger("netmanager.security")

    await _authenticate_runtime_agent(agent_id, x_agent_key, db)

    integ = _host_integrity()
    baked_version = integ.version if integ.ok else None

    from app.services.windows_runtime.integrity import runtime_integrity
    r = runtime_integrity(baked_version)
    if not r.ok or r.zip_path is None or r.manifest is None:
        log.error("runtime zip integrity check failed: %s", r.error)
        raise HTTPException(status_code=503, detail="Runtime bundle not available")

    try:
        with open(r.zip_path, "rb") as f:
            body_bytes = f.read()
    except OSError:
        log.error("runtime zip read failed at request time")
        raise HTTPException(status_code=503, detail="Runtime bundle not available")

    filename = f"charon-runtime-windows-amd64-{r.version}.zip"
    return Response(
        content=body_bytes,
        media_type="application/zip",
        headers={
            "Content-Length": str(len(body_bytes)),
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "X-Charon-Runtime-Version": r.manifest.runtime_version,
            "X-Charon-Runtime-Zip-Sha256": r.zip_sha256 or "",
            "X-Charon-Python-Version": r.manifest.python_version,
            "X-Charon-Compatible-Host-Core-Range": r.manifest.compatible_host_core_range,
        },
    )


# HF#10A — public router (gate'siz). X-Agent-ID + X-Agent-Key endpoint içinde doğrulanır.
@agents_public_router.get("/download/script")
async def download_agent_script(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Return the raw agent Python script.

    T8.4 F3 / CyberStrike pentest LOW CWE-200: eski versiyonda X-Agent-ID/
    X-Agent-Key header'ı YOKSA hiçbir auth check yapılmıyordu → anonim
    indirilebilir + reverse engineering kolaylığı. Şimdi header ZORUNLU;
    yoksa 401. RLS bypass yine yapılır (installer machine'in user session'ı
    yok), authentication agent_key ile.
    """
    agent_id = request.headers.get("X-Agent-ID")
    agent_key = request.headers.get("X-Agent-Key")

    if not (agent_id and agent_key):
        raise HTTPException(
            status_code=401,
            detail="X-Agent-ID + X-Agent-Key header'ları gerekli",
        )

    # RLS bypass (installer machine'in user session'ı yok)
    from sqlalchemy import text as _sql_text
    await db.execute(_sql_text("SELECT set_config('app.is_super_admin', 'on', true)"))
    agent = await db.get(Agent, agent_id)
    if not agent or not verify_password(agent_key, agent.agent_key_hash):
        raise HTTPException(status_code=403, detail="Geçersiz agent kimlik bilgileri")

    import os
    script_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "agent_script", "netmanager_agent.py")
    script_path = os.path.normpath(script_path)
    try:
        with open(script_path) as f:
            content = f.read()
    except FileNotFoundError:
        content = _embedded_agent_script()
    return PlainTextResponse(content=content, media_type="text/x-python")


# -- Latency routing ----------------------------------------------------------

@router.get("/latency-map", response_model=list[dict])
async def get_latency_map(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    from app.models.agent_latency import AgentDeviceLatency
    in_memory = {(r["agent_id"], r["device_id"]): r for r in agent_manager.get_all_latencies()}
    rows = await db.execute(select(AgentDeviceLatency))
    db_rows = rows.scalars().all()
    seen = set(in_memory.keys())
    result = list(in_memory.values())
    for row in db_rows:
        key = (row.agent_id, row.device_id)
        if key not in seen:
            result.append({
                "agent_id": row.agent_id,
                "device_id": row.device_id,
                "latency_ms": round(row.latency_ms, 1) if row.latency_ms else None,
                "success": row.success,
                "measured_at": row.measured_at.isoformat(),
            })
    return result


@router.post("/{agent_id}/probe-devices", response_model=dict)
async def probe_agent_devices(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:read"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    await _get_agent_scoped(agent_id, db)

    if not agent_manager.is_online(agent_id):
        raise HTTPException(status_code=409, detail="Agent is offline")

    from app.models.device import Device
    dev_result = await db.execute(
        select(Device).where(Device.agent_id == agent_id, Device.is_active == True)
    )
    devices = dev_result.scalars().all()

    results = []
    for device in devices:
        try:
            res = await agent_manager.test_ssh_connection(agent_id, device)
            latency = agent_manager.get_latency(agent_id, device.id)
            results.append({
                "device_id": device.id,
                "hostname": device.hostname,
                "latency_ms": round(latency, 1) if latency else None,
                "success": res.get("success", False),
            })
        except Exception as e:
            results.append({
                "device_id": device.id,
                "hostname": device.hostname,
                "latency_ms": None,
                "success": False,
                "error": str(e),
            })

    return {"agent_id": agent_id, "probed": len(results), "results": results}


# -- WebSocket helper tasks (called on hello) ----------------------------------

async def _push_device_sync_task(agent_id: str):
    """Push assigned device list to agent for health monitoring.

    Incident HF#2 (2026-06-02) — Önceden WS handler'ın `db: AsyncSession`'ı
    parametre olarak alıp paylaşıyordu. SQLAlchemy AsyncSession concurrent
    operation desteklemediği için heartbeat commit + push task SELECT race'i
    `InvalidRequestError: provisioning a new connection` exception'ı üretiyor,
    bu da WS handler'ı düşürüp agent flap'e yol açıyordu.

    Çözüm: kendi session'ını açar, RLS bypass yapar (org_context taşımıyoruz).
    SELECT-only, INSERT yok → cross-org sızıntı riski yok (agent_id unique).
    """
    try:
        from app.core.database import AsyncSessionLocal
        from app.models.device import Device
        from app.core.security import decrypt_credential
        from sqlalchemy import select as _select, text as _sql_text
        async with AsyncSessionLocal() as bg_db:
            await bg_db.execute(_sql_text("SET app.is_super_admin = 'on'"))
            dev_result = await bg_db.execute(
                _select(Device).where(Device.agent_id == agent_id, Device.is_active == True)
            )
            devices = dev_result.scalars().all()
        if not devices:
            return
        payload = [
            {
                "id": d.id,
                "ip": d.ip_address,
                "port": d.ssh_port or 22,
                "username": d.ssh_username or "",
                "password": decrypt_credential(d.ssh_password_enc) if d.ssh_password_enc else "",
                "os_type": d.os_type or "cisco_ios",
                "enable_secret": decrypt_credential(d.enable_secret_enc) if d.enable_secret_enc else "",
            }
            for d in devices
        ]
        await agent_manager.send_device_sync(agent_id, payload)
    except Exception as exc:
        import logging
        logging.getLogger("agents").debug(f"Device sync push error for {agent_id}: {exc}")


async def _push_vault_task(agent_id: str, agent_org_id: int):
    """Push credential vault bundle to agent (called on hello with vault_support=True).

    Incident HF#2 (2026-06-02) — Önceden WS handler'ın `db: AsyncSession`'ı
    parametre alıp paylaşıyordu (concurrent session race → WS close → agent
    flap). Şimdi kendi session'ını açar; RLS bypass uygular; `AgentCredentialBundle`
    INSERT'inde `organization_id`'yi caller'dan gelen agent_org_id ile set eder
    (Faz 7 Phase 3d: RLS bypass altında bile org_id doğru yazılmalı).
    """
    try:
        import os as _os, base64 as _b64
        from sqlalchemy import select as _select, text as _sql_text
        from app.core.database import AsyncSessionLocal
        from app.models.device import Device
        from app.models.agent_credential_bundle import AgentCredentialBundle
        from app.core.security import decrypt_credential, encrypt_credential

        async with AsyncSessionLocal() as bg_db:
            await bg_db.execute(_sql_text("SET app.is_super_admin = 'on'"))
            devices = (await bg_db.execute(
                _select(Device).where(Device.agent_id == agent_id, Device.is_active == True)
            )).scalars().all()
            if not devices:
                return

            # Check if we have a stored key; reuse it for continuity
            existing = (await bg_db.execute(
                _select(AgentCredentialBundle).where(AgentCredentialBundle.agent_id == agent_id)
            )).scalar_one_or_none()

            if existing:
                from app.core.security import decrypt_credential as _dec
                aes_key_b64 = _dec(existing.agent_aes_key_enc)
                aes_key = _b64.b64decode(aes_key_b64)
            else:
                aes_key = _os.urandom(32)
                aes_key_b64 = _b64.b64encode(aes_key).decode()

            try:
                from cryptography.hazmat.primitives.ciphers.aead import AESGCM
                def _enc(pt: str) -> str:
                    nonce = _os.urandom(12)
                    ct = AESGCM(aes_key).encrypt(nonce, pt.encode(), None)
                    return _b64.b64encode(nonce + ct).decode()
                has_crypto = True
            except ImportError:
                has_crypto = False

            credentials = []
            for d in devices:
                pwd = decrypt_credential(d.ssh_password_enc) if d.ssh_password_enc else ""
                enable = decrypt_credential(d.enable_secret_enc) if d.enable_secret_enc else ""
                if has_crypto:
                    credentials.append({
                        "credential_id": d.id,
                        "ip": d.ip_address,
                        "port": d.ssh_port or 22,
                        "username": d.ssh_username or "",
                        "password_enc": _enc(pwd),
                        "enable_enc": _enc(enable) if enable else "",
                        "os_type": d.os_type or "cisco_ios",
                    })
                else:
                    credentials.append({
                        "credential_id": d.id,
                        "ip": d.ip_address,
                        "port": d.ssh_port or 22,
                        "username": d.ssh_username or "",
                        "password_enc": "",
                        "password_plain": pwd,
                        "enable_enc": "",
                        "enable_plain": enable,
                        "os_type": d.os_type or "cisco_ios",
                    })

            if not existing:
                bg_db.add(AgentCredentialBundle(
                    agent_id=agent_id,
                    agent_aes_key_enc=encrypt_credential(aes_key_b64),
                    device_count=len(credentials),
                    organization_id=agent_org_id,  # Faz 7 Phase 3d — INSERT'te org_id zorunlu
                ))
                await bg_db.commit()

        await agent_manager.send_credential_bundle(agent_id, aes_key_b64, credentials)
    except Exception as exc:
        import logging
        logging.getLogger("agents").debug(f"Vault push error for {agent_id}: {exc}")


# -- Feature 2: Device sync ----------------------------------------------------

@router.post("/{agent_id}/device-sync", response_model=dict)
async def push_device_sync(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Push device list to connected agent so it can run health checks."""
    if not current_user.has_permission("device:read"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    await _get_agent_scoped(agent_id, db)
    if not agent_manager.is_online(agent_id):
        raise HTTPException(status_code=409, detail="Agent is offline")

    from app.models.device import Device
    from app.core.security import decrypt_credential
    dev_result = await db.execute(
        select(Device).where(Device.agent_id == agent_id, Device.is_active == True)
    )
    devices = dev_result.scalars().all()
    payload = [
        {
            "id": d.id,
            "ip": d.ip_address,
            "port": d.ssh_port or 22,
            "username": d.ssh_username,
            "password": decrypt_credential(d.ssh_password_enc) if d.ssh_password_enc else "",
            "os_type": d.os_type,
            "enable_secret": decrypt_credential(d.enable_secret_enc) if d.enable_secret_enc else "",
        }
        for d in devices
    ]
    sent = await agent_manager.send_device_sync(agent_id, payload)
    return {"sent": sent, "device_count": len(payload)}


# -- Feature 4: SNMP via Agent -------------------------------------------------

@router.post("/{agent_id}/snmp-get", response_model=dict)
async def snmp_get_via_agent(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Run SNMP GET for specific OIDs via agent. body: {device_id, oids: [str]}"""
    if not current_user.has_permission("device:read"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    if not agent_manager.is_online(agent_id):
        raise HTTPException(status_code=409, detail="Agent is offline")

    device_id = body.get("device_id")
    oids = body.get("oids", [])
    if not device_id or not oids:
        raise HTTPException(status_code=400, detail="device_id and oids are required")

    from app.models.device import Device
    agent = await _get_agent_scoped(agent_id, db)
    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    _assert_agent_device_scope(agent, device, "snmp_get")

    result = await agent_manager.execute_snmp_get(agent_id, device, oids)
    return result


@router.post("/{agent_id}/snmp-walk", response_model=dict)
async def snmp_walk_via_agent(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Run SNMP WALK for an OID subtree via agent. body: {device_id, oid_prefix}"""
    if not current_user.has_permission("device:read"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    if not agent_manager.is_online(agent_id):
        raise HTTPException(status_code=409, detail="Agent is offline")

    device_id = body.get("device_id")
    oid_prefix = body.get("oid_prefix", "").strip()
    if not device_id or not oid_prefix:
        raise HTTPException(status_code=400, detail="device_id and oid_prefix are required")

    from app.models.device import Device
    agent = await _get_agent_scoped(agent_id, db)
    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    _assert_agent_device_scope(agent, device, "snmp_walk")

    result = await agent_manager.execute_snmp_walk(agent_id, device, oid_prefix)
    return result


# -- Feature 5: Discovery ------------------------------------------------------

@router.post("/{agent_id}/discover", response_model=dict)
async def trigger_discovery(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Trigger network discovery on the agent's local subnet."""
    if not current_user.has_permission("device:read"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    agent = await _get_agent_scoped(agent_id, db)
    if not agent_manager.is_online(agent_id):
        raise HTTPException(status_code=409, detail="Agent is offline")

    subnet = body.get("subnet", "")
    if not subnet:
        raise HTTPException(status_code=400, detail="subnet is required (e.g. 192.168.1.0/24)")

    result_data = await agent_manager.trigger_discovery(agent_id, subnet, body.get("ports"))

    # Persist result — Faz 8 phase C: org + location stamped explicitly
    # from the agent (an agent is bound to exactly one org + location).
    from app.models.discovery_result import DiscoveryResult
    dr = DiscoveryResult(
        agent_id=agent_id,
        organization_id=agent.organization_id,
        location_id=agent.location_id,
        subnet=subnet,
        completed_at=datetime.now(timezone.utc),
        status="completed" if result_data.get("success") else "failed",
        total_discovered=len(result_data.get("hosts", [])),
        scanned_count=result_data.get("scanned", 0),
        results=result_data.get("hosts", []),
    )
    db.add(dr)
    await db.commit()

    return result_data


@router.get("/{agent_id}/discover/history", response_model=list[dict])
async def get_discovery_history(
    agent_id: str,
    limit: int = Query(20, le=100),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    from app.models.discovery_result import DiscoveryResult
    rows = (await db.execute(
        select(DiscoveryResult)
        .where(DiscoveryResult.agent_id == agent_id)
        .order_by(DiscoveryResult.triggered_at.desc())
        .limit(limit)
    )).scalars().all()
    return [
        {
            "id": r.id,
            "subnet": r.subnet,
            "triggered_at": r.triggered_at.isoformat(),
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            "status": r.status,
            "total_discovered": r.total_discovered,
            "scanned_count": r.scanned_count,
            "results": r.results,
        }
        for r in rows
    ]


# -- Feature 6: Syslog ---------------------------------------------------------

@router.post("/{agent_id}/syslog-config", response_model=dict)
async def configure_syslog(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Enable or disable syslog collection on the agent."""
    if not current_user.has_permission("device:update"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    await _get_agent_scoped(agent_id, db)
    if not agent_manager.is_online(agent_id):
        raise HTTPException(status_code=409, detail="Agent is offline")

    enabled = bool(body.get("enabled", False))
    bind_port = int(body.get("bind_port", 514))
    sent = await agent_manager.send_syslog_config(agent_id, enabled, bind_port)
    return {"sent": sent, "enabled": enabled, "bind_port": bind_port}


@router.get("/{agent_id}/syslog-events", response_model=dict)
async def get_syslog_events(
    agent_id: str,
    limit: int = Query(100, le=1000),
    offset: int = Query(0),
    severity_max: int = Query(7, ge=0, le=7),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    from app.models.syslog_event import SyslogEvent
    from sqlalchemy import desc as _desc
    q = (
        select(SyslogEvent)
        .where(SyslogEvent.agent_id == agent_id, SyslogEvent.severity <= severity_max)
        .order_by(_desc(SyslogEvent.received_at))
        .offset(offset)
        .limit(limit)
    )
    rows = (await db.execute(q)).scalars().all()
    items = [
        {
            "id": r.id,
            "source_ip": r.source_ip,
            "facility": r.facility,
            "severity": r.severity,
            "message": r.message,
            "received_at": r.received_at.isoformat(),
        }
        for r in rows
    ]
    return {"items": items, "total": len(items), "offset": offset, "limit": limit}


# -- Feature 7: Streaming ------------------------------------------------------

@router.post("/{agent_id}/stream-command", response_model=dict)
async def start_stream_command(
    agent_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Start a streaming SSH command. Returns request_id for SSE subscription."""
    if not current_user.has_permission("device:update"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    if not agent_manager.is_online(agent_id):
        raise HTTPException(status_code=409, detail="Agent is offline")

    device_id = body.get("device_id")
    command = body.get("command", "").strip()
    if not device_id or not command:
        raise HTTPException(status_code=400, detail="device_id and command are required")

    from app.models.device import Device
    agent = await _get_agent_scoped(agent_id, db)
    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    _assert_agent_device_scope(agent, device, "stream_command")

    rid, _ = await agent_manager.execute_ssh_command_stream(agent_id, device, command)
    return {"request_id": rid, "stream_url": f"/api/v1/stream/{rid}"}


# -- Feature 8: Credential Vault -----------------------------------------------

@router.post("/{agent_id}/refresh-vault", response_model=dict)
async def refresh_credential_vault(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Regenerate agent AES key and push fresh credential bundle to agent."""
    if not current_user.has_permission("device:update"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    await _get_agent_scoped(agent_id, db)
    if not agent_manager.is_online(agent_id):
        raise HTTPException(status_code=409, detail="Agent is offline")

    from app.models.device import Device
    from app.models.agent_credential_bundle import AgentCredentialBundle
    from app.core.security import decrypt_credential, encrypt_credential
    import os as _os, base64 as _b64

    devices = (await db.execute(
        select(Device).where(Device.agent_id == agent_id, Device.is_active == True)
    )).scalars().all()

    # Generate new AES-256 key
    aes_key = _os.urandom(32)
    aes_key_b64 = _b64.b64encode(aes_key).decode()

    # Encrypt credentials with AES-GCM
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        def _enc(plaintext: str) -> str:
            nonce = _os.urandom(12)
            ct = AESGCM(aes_key).encrypt(nonce, plaintext.encode(), None)
            return _b64.b64encode(nonce + ct).decode()
        has_crypto = True
    except ImportError:
        has_crypto = False

    credentials = []
    for d in devices:
        pwd = decrypt_credential(d.ssh_password_enc) if d.ssh_password_enc else ""
        enable = decrypt_credential(d.enable_secret_enc) if d.enable_secret_enc else ""
        from app.core.security import decrypt_credential_safe as _dec_safe
        community = _dec_safe(d.snmp_community) or ""
        if has_crypto:
            credentials.append({
                "credential_id": d.id,
                "ip": d.ip_address,
                "port": d.ssh_port or 22,
                "username": d.ssh_username or "",
                "password_enc": _enc(pwd),
                "enable_enc": _enc(enable) if enable else "",
                "snmp_community_enc": _enc(community) if community else "",
                "os_type": d.os_type or "cisco_ios",
            })
        else:
            # Fallback: no crypto — send plaintext (over TLS WS)
            credentials.append({
                "credential_id": d.id,
                "ip": d.ip_address,
                "port": d.ssh_port or 22,
                "username": d.ssh_username or "",
                "password_enc": "",
                "password_plain": pwd,
                "enable_enc": "",
                "enable_plain": enable,
                "os_type": d.os_type or "cisco_ios",
            })

    # Persist encrypted AES key
    existing = (await db.execute(
        select(AgentCredentialBundle).where(AgentCredentialBundle.agent_id == agent_id)
    )).scalar_one_or_none()
    if existing:
        existing.agent_aes_key_enc = encrypt_credential(aes_key_b64)
        existing.bundle_version += 1
        existing.last_refreshed = datetime.now(timezone.utc)
        existing.device_count = len(credentials)
    else:
        db.add(AgentCredentialBundle(
            agent_id=agent_id,
            agent_aes_key_enc=encrypt_credential(aes_key_b64),
            last_refreshed=datetime.now(timezone.utc),
            device_count=len(credentials),
        ))
    await db.commit()

    sent = await agent_manager.send_credential_bundle(agent_id, aes_key_b64, credentials)
    return {"sent": sent, "credential_count": len(credentials), "encrypted": has_crypto}


# -- WebSocket -----------------------------------------------------------------

@agent_ws_router.websocket("/ws/{agent_id}")
async def agent_websocket(
    agent_id: str,
    websocket: WebSocket,
    key: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    # Agent WS connect is credential-authenticated (the agent_key below), not a
    # user session — `get_db` carries no RLS context, so FORCE ROW LEVEL
    # SECURITY on `agents` would hide the row and reject every connect (4004 →
    # 403). Bypass RLS for the agent's own connection; the agent_key is the
    # authenticator and the agent record fixes its org/location scope.
    from sqlalchemy import text as _sql_text
    await db.execute(_sql_text("SELECT set_config('app.is_super_admin', 'on', true)"))
    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()

    # Agent not found
    if not agent:
        await websocket.close(code=4004)
        return

    # Brute-force lockout
    if agent.failed_auth_count >= _MAX_FAILED_AUTH:
        await websocket.close(code=4029)  # too many requests
        return

    # Key verification
    if not verify_password(key, agent.agent_key_hash):
        agent.failed_auth_count += 1
        await db.commit()
        await websocket.close(code=4001)
        return

    # Allowed-IP check (if configured)
    client_ip = websocket.client.host if websocket.client else None
    if agent.allowed_ips and client_ip:
        allowed = [ip.strip() for ip in agent.allowed_ips.split(",") if ip.strip()]
        if allowed and client_ip not in allowed:
            await websocket.close(code=4003)
            return

    # Authenticated via agent_key — now NARROW from the lookup bypass to the
    # agent's OWN org/location so the rest of the connection is RLS-scoped,
    # not super-admin (Faz 7 Phase 6e: agent ops scoped to the agent's scope).
    await db.execute(_sql_text(
        "SELECT set_config('app.is_super_admin','off',true),"
        "       set_config('app.current_org_id', :o, true),"
        "       set_config('app.current_location_id', :l, true)"
    ), {"o": str(agent.organization_id),
        "l": str(agent.location_id) if agent.location_id is not None else ''})

    await websocket.accept()

    # Reset failed auth on successful connect
    was_offline = agent.status == "offline"
    agent.status = "online"
    agent.last_ip = client_ip
    agent.failed_auth_count = 0
    agent.last_connected_at = datetime.now(timezone.utc)
    agent.total_connections = (agent.total_connections or 0) + 1
    await db.commit()

    # Emit online event if agent was previously offline.
    # T8.4 hotfix — the `db.commit()` above ended the txn that held our
    # `set_config(..., is_local := true)` GUCs, so when the NetworkEvent
    # INSERT runs below the RLS WITH CHECK (`organization_id = current_org_id`)
    # has no current_org_id to compare against and the row is rejected. Re-set
    # the GUCs on the new txn before emitting.
    if was_offline:
        await db.execute(_sql_text(
            "SELECT set_config('app.is_super_admin','off',true),"
            "       set_config('app.current_org_id', :o, true),"
            "       set_config('app.current_location_id', :l, true)"
        ), {"o": str(agent.organization_id),
            "l": str(agent.location_id) if agent.location_id is not None else ''})
        await _emit_agent_event(db, agent, "agent_online")
        await db.commit()

    # Load security config into cache
    agent_manager.set_security_config(agent_id, agent.command_mode, agent.allowed_commands)

    # Faz 8 Phase D — bind the agent's organization+location into the WS
    # session. The agent token authenticated above thereby fixes the
    # agent's sandbox; every command dispatched on this connection is
    # validated against it (agent_manager._enforce_device_scope).
    meta = {
        "organization_id": agent.organization_id,
        "location_id": agent.location_id,
    }
    await agent_manager.connect(agent_id, websocket, meta)

    # Send initial security config to agent
    cmds = json.loads(agent.allowed_commands) if agent.allowed_commands else []
    try:
        await asyncio.wait_for(
            websocket.send_text(json.dumps({
                "type": "security_config",
                "command_mode": agent.command_mode,
                "allowed_commands": cmds,
            })),
            timeout=5,
        )
    except Exception:
        pass

    # Server-side keepalive: every 20s (Nginx WS proxy_read_timeout is 3600s)
    async def _server_keepalive():
        while True:
            await asyncio.sleep(20)
            try:
                await websocket.send_text(json.dumps({"type": "ping"}))
            except Exception:
                break

    keepalive_task = asyncio.create_task(_server_keepalive())

    try:
        async for raw in websocket.iter_text():
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            if msg.get("type") == "hello":
                meta.update({
                    "platform": msg.get("platform"),
                    "hostname": msg.get("hostname"),
                    "version": msg.get("version"),
                    "python_version": msg.get("python_version"),
                    "has_psutil": msg.get("has_psutil", False),
                    "vault_support": msg.get("vault_support", False),
                    "has_snmp": msg.get("has_snmp", False),
                    "has_crypto": msg.get("has_crypto", False),
                })
                # T8.5 — Hello persist explicit UPDATE + RLS GUC reset.
                # İlk denemede explicit UPDATE eklemiştik ama DB hala 1.3.16
                # gözüküyordu. Sebep: agents tablosunda Faz 7 RLS aktif;
                # `is_local := true` GUC'lar önceki transaction commit'iyle
                # sıfırlanıyordu → UPDATE WITH CHECK policy 0 row affected
                # üretiyordu (exception YOK, satır SILENTLY filtered).
                # Şimdi UPDATE'ten önce GUC'ları yeni transaction'a enjekte
                # ediyoruz + rowcount'u log'luyoruz ki silent fail görünür
                # olsun.
                from sqlalchemy import update as _sa_update
                _hello_vals = {
                    "platform": msg.get("platform"),
                    "machine_hostname": msg.get("hostname"),
                    "version": msg.get("version"),
                }
                if msg.get("local_ip"):
                    _hello_vals["local_ip"] = msg.get("local_ip")
                _agent_logger = logging.getLogger("agent_manager")
                try:
                    # RLS GUC reset — commit sonrası kaybolan transaction-local
                    # ayarları yeniden uygula. is_super_admin=off + agent'ın
                    # kendi org_id/location_id'si ile WITH CHECK match eder.
                    await db.execute(_sql_text(
                        "SELECT set_config('app.is_super_admin','off',true),"
                        "       set_config('app.current_org_id', :o, true),"
                        "       set_config('app.current_location_id', :l, true)"
                    ), {"o": str(agent.organization_id),
                        "l": str(agent.location_id) if agent.location_id is not None else ''})
                    _res = await db.execute(
                        _sa_update(Agent).where(Agent.id == agent_id).values(**_hello_vals)
                    )
                    await db.commit()
                    # ORM in-memory state'i de sync et
                    for _k, _v in _hello_vals.items():
                        setattr(agent, _k, _v)
                    _agent_logger.info(
                        "hello persist: agent=%s ver=%s platform=%s rows_affected=%s",
                        agent_id, _hello_vals.get("version"),
                        _hello_vals.get("platform"), _res.rowcount,
                    )
                except Exception as _exc:
                    await db.rollback()
                    _agent_logger.warning(
                        "hello persist FAIL: agent=%s err=%r vals=%s",
                        agent_id, _exc, _hello_vals,
                    )

                # Auto-update: notify agent if its version is outdated
                agent_ver = msg.get("version") or ""
                def _ver(v): return tuple(int(x) for x in v.split(".") if x.isdigit())
                _agent_logger.info(
                    "agent hello: id=%s ver=%s platform=%s",
                    agent_id, agent_ver, msg.get("platform"),
                )
                if agent_ver and _ver(agent_ver) < _ver(CURRENT_AGENT_VERSION):
                    try:
                        import base64 as _b64
                        _sp = Path(__file__).parents[4] / "agent_script" / "netmanager_agent.py"
                        _sc = _b64.b64encode(_sp.read_bytes()).decode() if _sp.exists() else None
                        _agent_logger.info(
                            "OTA notify: %s v%s -> v%s (script size: %dB)",
                            agent_id, agent_ver, CURRENT_AGENT_VERSION,
                            len(_sc) if _sc else 0,
                        )
                        await asyncio.wait_for(
                            websocket.send_text(json.dumps({
                                "type": "update_available",
                                "current_version": CURRENT_AGENT_VERSION,
                                "script_path": "/api/v1/agents/download/script",
                                "script_content": _sc,
                            })),
                            timeout=5,
                        )
                        _agent_logger.info("OTA notify sent: %s", agent_id)
                    except Exception as _exc:
                        _agent_logger.warning(
                            "OTA notify FAILED for %s: %r", agent_id, _exc,
                        )

                # Push device list for health monitoring
                # Incident HF#2 — bg task kendi session'ını açar (concurrent race fix)
                asyncio.create_task(_push_device_sync_task(agent_id))

                # Push credential vault if agent supports it
                # Incident HF#2 — bg task kendi session'ını açar + INSERT'te org_id zorunlu
                if msg.get("vault_support"):
                    asyncio.create_task(_push_vault_task(agent_id, agent.organization_id))

                # D4: Auto-enable SNMP trap receiver (port 1620 avoids root requirement)
                agent_ver = msg.get("version") or ""
                def _ver(v): return tuple(int(x) for x in v.split(".") if x.isdigit())
                if agent_ver and _ver(agent_ver) >= _ver("1.3.8"):
                    asyncio.create_task(
                        agent_manager.send_trap_config(agent_id, enabled=True, bind_port=1620)
                    )

            elif msg.get("type") == "heartbeat":
                agent.last_heartbeat = datetime.now(timezone.utc)
                agent_manager.refresh_online(agent_id)
                # Incident HF#2 — rollback() kendisi de InvalidRequestError atabilir
                # ("provisioning a new connection") → WS handler düşer → agent flap.
                # Şimdi nested try/except + warning log.
                try:
                    await db.commit()
                except Exception as exc:
                    _agent_logger.warning(
                        "heartbeat commit failed for %s: %r", agent_id, exc,
                    )
                    try:
                        await db.rollback()
                    except Exception as roll_exc:
                        _agent_logger.warning(
                            "heartbeat rollback failed for %s: %r", agent_id, roll_exc,
                        )

            await agent_manager.handle_message(agent_id, raw)

    except WebSocketDisconnect:
        pass
    finally:
        keepalive_task.cancel()
        await agent_manager.disconnect(agent_id)
        agent.status = "offline"
        agent.last_disconnected_at = datetime.now(timezone.utc)
        # Incident HF#2 — silent pass yerine warning + best-effort rollback.
        # Aksi halde commit fail olursa agent.status DB'ye yazılmaz,
        # UI'da agent "online" görünmeye devam edebilir.
        try:
            await db.commit()
        except Exception as exc:
            _agent_logger.warning(
                "disconnect commit failed for %s: %r", agent_id, exc,
            )
            try:
                await db.rollback()
            except Exception:
                pass

        # T8.4 — poll-skip flag'ini DISCONNECT ANINDA set et. Önce
        # `_emit_agent_event`'in içinde set ediliyordu; biz event yazımını
        # 20s debounce edince flag set de gecikiyordu → poll_device_status
        # bu sırada cihazları gerçek SSH ile sorgulayıp "down" işaretliyordu.
        # Şimdi flag bağımsız: disconnect → flag set; reconnect olunca
        # agent_online event'i flag'i siler.
        try:
            _redis.setex(
                f"agent:{agent.id}:recently_offline",
                _AGENT_OFFLINE_FLAG_TTL, "1",
            )
        except Exception:
            pass

        # T8.4 — offline event debounce. Eskiden burada direkt
        # `_emit_agent_event(db, agent, "agent_offline")` çağırıyorduk;
        # yük altında transient disconnect/reconnect her seferinde toast
        # tetikliyordu. Şimdi fire-and-forget bir task'a alıyoruz: 20s
        # sonra agent hala offline ise event yazar, aksi halde sessizce
        # yutar. Komut tarafı (vlans-refresh) zaten kendi retry'ı ile
        # transient disconnect'leri kapsıyor.
        asyncio.create_task(_emit_offline_if_still_offline(
            agent_id=agent_id,
            agent_pk=agent.id,
            org_id=agent.organization_id,
            loc_id=agent.location_id,
        ))


# -- Installer templates -------------------------------------------------------

def _linux_installer(agent_id: str, agent_key: str, backend_url: str) -> str:
    # T8.4 Security F1.3 defense-in-depth — server_url whitelist üstüne
    # shlex.quote ile shell-safe escape. Whitelist atlanmış bir code-path
    # olsa bile çıktı script'inde quote kapatması mümkün olmaz.
    import shlex as _shlex
    safe_id  = _shlex.quote(agent_id)
    safe_key = _shlex.quote(agent_key)
    safe_url = _shlex.quote(backend_url)
    return textwrap.dedent(f"""\
        #!/bin/bash
        # NetManager Proxy Agent — Linux/macOS Installer
        # Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
        # Agent ID: {agent_id}

        set -e

        AGENT_ID={safe_id}
        AGENT_KEY={safe_key}
        BACKEND_URL={safe_url}
        SERVICE_NAME="netmanager-agent"

        OS_TYPE="$(uname -s)"

        if [ "$OS_TYPE" = "Darwin" ]; then
            if [ "$EUID" -eq 0 ]; then
                INSTALL_DIR="/opt/netmanager-agent"
            else
                INSTALL_DIR="$HOME/.netmanager-agent"
            fi
            RUN_AS_ROOT=0
        else
            INSTALL_DIR="/opt/netmanager-agent"
            RUN_AS_ROOT=1
            if [ "$EUID" -ne 0 ]; then
                echo "Linux: Lütfen root olarak çalıştırın: sudo bash $(basename "$0")"
                exit 1
            fi
        fi

        echo "[1/5] Python ve bağımlılıklar kontrol ediliyor..."
        if ! command -v python3 &>/dev/null; then
            if [ "$OS_TYPE" = "Darwin" ]; then
                command -v brew &>/dev/null && brew install python3 || {{
                    echo "Python3 bulunamadı."; exit 1
                }}
            elif command -v apt-get &>/dev/null; then
                apt-get install -y python3 python3-venv python3-full curl
            elif command -v yum &>/dev/null; then
                yum install -y python3 python3-pip curl
            else
                echo "Python3 bulunamadı. Lütfen manuel kurun."; exit 1
            fi
        fi
        # Debian/Ubuntu: python3-venv gerekli
        if [ "$OS_TYPE" != "Darwin" ] && command -v apt-get &>/dev/null; then
            apt-get install -y python3-venv python3-full curl 2>/dev/null || true
        fi
        SYS_PYTHON="$(which python3)"

        echo "[2/5] Kurulum dizini ve sanal ortam hazırlanıyor..."
        mkdir -p "$INSTALL_DIR"
        VENV_DIR="$INSTALL_DIR/venv"
        if [ ! -d "$VENV_DIR" ]; then
            $SYS_PYTHON -m venv "$VENV_DIR"
        fi
        PYTHON="$VENV_DIR/bin/python"

        echo "[3/5] Agent betiği indiriliyor..."
        # T8.4 F3 — /download/script artık X-Agent-ID + X-Agent-Key
        # header'ları zorunlu (anonim erişim CWE-200 LOW kapatıldı).
        # Eski fallback (anonim) bilinçli olarak kaldırıldı.
        curl -fsSL \
          -H "X-Agent-ID: $AGENT_ID" \
          -H "X-Agent-Key: $AGENT_KEY" \
          "$BACKEND_URL/api/v1/agents/download/script" \
          -o "$INSTALL_DIR/netmanager_agent.py"

        echo "[4/5] Bağımlılıklar kuruluyor (venv)..."
        $PYTHON -m pip install --quiet --no-cache-dir --upgrade pip
        $PYTHON -m pip install --quiet --no-cache-dir websockets netmiko psutil

        ENV_FILE="$INSTALL_DIR/agent.env"
        cat > "$ENV_FILE" <<ENVEOF
NETMANAGER_URL={backend_url}
NETMANAGER_AGENT_ID={agent_id}
NETMANAGER_AGENT_KEY={agent_key}
ENVEOF
        chmod 600 "$ENV_FILE"

        echo "[5/5] Servis kuruluyor..."
        if [ "$OS_TYPE" = "Darwin" ]; then
            if [ "$EUID" -eq 0 ]; then
                PLIST_DIR="/Library/LaunchDaemons"
            else
                PLIST_DIR="$HOME/Library/LaunchAgents"
                mkdir -p "$PLIST_DIR"
            fi
            PLIST_PATH="$PLIST_DIR/com.netmanager.agent.plist"
            cat > "$PLIST_PATH" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.netmanager.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>$INSTALL_DIR/netmanager_agent.py</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NETMANAGER_URL</key><string>{backend_url}</string>
        <key>NETMANAGER_AGENT_ID</key><string>{agent_id}</string>
        <key>NETMANAGER_AGENT_KEY</key><string>{agent_key}</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$INSTALL_DIR/agent.log</string>
    <key>StandardErrorPath</key><string>$INSTALL_DIR/agent.log</string>
</dict>
</plist>
PLISTEOF
            chmod 644 "$PLIST_PATH"
            if [ "$EUID" -eq 0 ]; then
                launchctl bootout system/com.netmanager.agent 2>/dev/null || true
                launchctl bootout system "$PLIST_PATH" 2>/dev/null || true
                launchctl bootstrap system "$PLIST_PATH" 2>/dev/null || \
                    launchctl load -w "$PLIST_PATH" 2>/dev/null || true
            else
                launchctl unload "$PLIST_PATH" 2>/dev/null || true
                launchctl load -w "$PLIST_PATH"
            fi
            sleep 1
            if launchctl list 2>/dev/null | grep -q com.netmanager.agent; then
                echo "✓ NetManager Agent kuruldu ve başlatıldı! (macOS launchd)"
            else
                echo "⚠ Plist yüklendi ancak servis başlamadı. Manuel başlatın:"
                echo "  sudo launchctl load -w $PLIST_PATH"
            fi
        else
            cat > /etc/systemd/system/$SERVICE_NAME.service <<SVCEOF
[Unit]
Description=NetManager Proxy Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
EnvironmentFile=$ENV_FILE
ExecStart=$PYTHON $INSTALL_DIR/netmanager_agent.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF
            systemctl daemon-reload
            systemctl enable $SERVICE_NAME
            systemctl restart $SERVICE_NAME
            echo "✓ NetManager Agent kuruldu! (Linux systemd, venv: $VENV_DIR)"
        fi
    """)


def _windows_installer(agent_id: str, agent_key: str, backend_url: str) -> str:
    """Generate Windows PowerShell 5.1 installer (WIN-INTEGRATE Section H 11-stage).

    Architectural rewrite from the legacy 9-stage flow. Embedded
    private Python runtime replaces system Python + winget; the
    full Section H state machine, file-move ledger M1..M6, and
    Stage-11 SCM-registration commit barrier are wired in per
    Architecture Plan v11 corrections #66-#72.

    All host CLI invocations route through `Invoke-HostInstall` /
    `Invoke-ProcessCaptured` — there is no `& $HostExe install`
    pipeline anywhere; stdout-vs-exit-code pollution is impossible.

    Locale-independent + ASCII-safe (TR Windows cp1254 decode bug
    invariants preserved). All admin checks use WindowsBuiltInRole
    enum; all ACLs use well-known SIDs (S-1-5-18 SYSTEM,
    S-1-5-32-544 Administrators).

    iwr | iex is NOT supported — $PSCommandPath must resolve to a
    real file path, otherwise we abort with a clear message.

    Linux installer flow is byte-identical; the byte-equal golden
    pinned in test_linux_unchanged.py guards regression.
    """
    def _psq(s: str) -> str:
        # F1.3 defense - single-quoted PS string'de ' kaçışı ''
        return "'" + s.replace("'", "''") + "'"
    p_id = _psq(agent_id)
    p_key = _psq(agent_key)
    p_url = _psq(backend_url)
    timestamp_utc = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    return textwrap.dedent(f"""\
        # NetManager Proxy Agent - Windows Installer (PS 5.1 / Section H 11-stage)
        # Generated: {timestamp_utc}
        # Agent ID: {agent_id}
        # Target: Windows PowerShell 5.1 (default) and PowerShell 7.

        $ErrorActionPreference = "Stop"

        $AgentId    = {p_id}
        $AgentKey   = {p_key}
        $BackendUrl = {p_url}

        # ---- canonical on-disk layout (Section A) ------------------
        $InstallDir       = "C:\\ProgramData\\NetManagerAgent"
        $BinDir           = "$InstallDir\\bin"
        $LogDir           = "$InstallDir\\logs"
        $StagingDir       = "$InstallDir\\staging"
        $PayloadRoot      = "$InstallDir\\payload"
        $PayloadCurrent   = "$PayloadRoot\\current"
        $PayloadNew       = "$PayloadRoot\\new"
        $PayloadPrevious  = "$PayloadRoot\\previous"

        $HostExeLive      = "$BinDir\\charon-agent-host.exe"
        $HostExeNew       = "$HostExeLive.new"
        $HostExeBak       = "$HostExeLive.bak"

        $ConfigEnvLive    = "$InstallDir\\config.env"
        $ConfigEnvBak     = "$ConfigEnvLive.bak"

        $StagingRuntimeZip       = "$StagingDir\\runtime-new.zip"
        $StagingRuntimeManifest  = "$StagingDir\\runtime-new.manifest.json"
        $StagingExtracted        = "$StagingDir\\runtime-new"
        $StagingConfigNew        = "$StagingDir\\config.env.new"
        $StagingRollbackConfig   = "$StagingDir\\rollback-config.failed"
        $StagingProcCapture      = "$StagingDir\\proc-capture"
        $InstallerRunTxt         = "$InstallDir\\installer-run.txt"

        $PrivatePython    = "$PayloadCurrent\\runtime\\python\\python.exe"
        $AppDir           = "$PayloadCurrent\\app"
        $Entrypoint       = "$AppDir\\run_agent.py"

        $ServiceName        = "NetManagerAgent"
        $DisplayName        = "NetManager Proxy Agent"
        $ServiceDescription = "Charon agent host - manages the NetManager proxy agent child process."

        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

        # ==========================================================
        # [1/11] Admin check (locale-independent) + self-elevation
        # ==========================================================
        # iwr | iex is NOT supported: PSCommandPath would be empty,
        # self-elevation cannot relaunch us as a file. Hard abort.
        $principal = New-Object Security.Principal.WindowsPrincipal(
            [Security.Principal.WindowsIdentity]::GetCurrent()
        )
        $isAdmin = $principal.IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator
        )

        if (-not $isAdmin) {{
            if ($env:NETMANAGER_INSTALLER_ELEVATED -eq "1") {{
                Write-Host "[ERROR] Administrative elevation failed." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 1
            }}
            if (-not $PSCommandPath) {{
                Write-Host "[ERROR] Installer must be downloaded as a file, not piped (iwr | iex unsupported)." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 1
            }}
            $env:NETMANAGER_INSTALLER_ELEVATED = "1"
            Write-Host "[INFO] Requesting administrator elevation..." -ForegroundColor Yellow
            $psExe = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

            # Parent waits for elevated child to finish, captures the
            # exit code, then cleans the on-disk installer (which still
            # embeds the agent key in its header) AFTER the child has
            # released its handle on the file.
            $childExit = 1
            try {{
                $proc = Start-Process -FilePath $psExe `
                    -Verb RunAs `
                    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"") `
                    -Wait -PassThru
                if ($proc -and $proc.ExitCode -ne $null) {{
                    $childExit = $proc.ExitCode
                }}
            }} catch {{
                Write-Host "[ERROR] UAC elevation denied or installer relaunch failed." -ForegroundColor Red
                $childExit = 1
            }} finally {{
                if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath)) {{
                    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
                }}
            }}
            exit $childExit
        }}

        # ----------------------------------------------------------
        # Elevated execution path. EVERY exit point (success or
        # failure) MUST run through the `finally` block below so the
        # installer file (which embeds the agent key in its header)
        # never lingers on disk. $AgentKey is also zeroed defensively.
        # ----------------------------------------------------------
        try {{

        # ==========================================================
        # Helper: Invoke-ProcessCaptured (correction #66)
        # ==========================================================
        # PS 5.1 lacks ProcessStartInfo.ArgumentList. Redirect stdout
        # and stderr to short-lived locked-ACL temp files and read
        # them back. The temp files are LOGICAL_DELETEd before this
        # function returns; charon-agent-host.exe never echoes the
        # agent key, so neither file may carry it.
        function Invoke-ProcessCaptured {{
            [CmdletBinding()]
            param(
                [Parameter(Mandatory)][string]$FilePath,
                [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$ArgumentList
            )
            [System.IO.Directory]::CreateDirectory($StagingProcCapture) | Out-Null
            try {{
                $sid_sys = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
                $sid_adm = New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'
                $acl = Get-Acl $StagingProcCapture
                $acl.SetAccessRuleProtection($true, $false)
                $r1 = New-Object System.Security.AccessControl.FileSystemAccessRule(
                    $sid_sys, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
                $r2 = New-Object System.Security.AccessControl.FileSystemAccessRule(
                    $sid_adm, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
                $acl.AddAccessRule($r1); $acl.AddAccessRule($r2)
                Set-Acl $StagingProcCapture $acl
            }} catch {{}}

            $stdoutPath = Join-Path $StagingProcCapture ("o-" + [guid]::NewGuid().ToString() + ".txt")
            $stderrPath = Join-Path $StagingProcCapture ("e-" + [guid]::NewGuid().ToString() + ".txt")
            $exitCode = 1; $stdoutText = ""; $stderrText = ""
            try {{
                $proc = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
                    -NoNewWindow -Wait -PassThru `
                    -RedirectStandardOutput $stdoutPath `
                    -RedirectStandardError  $stderrPath
                if ($proc -and $proc.ExitCode -ne $null) {{ $exitCode = [int]$proc.ExitCode }}
                if (Test-Path -LiteralPath $stdoutPath) {{
                    $stdoutText = [System.IO.File]::ReadAllText($stdoutPath)
                }}
                if (Test-Path -LiteralPath $stderrPath) {{
                    $stderrText = [System.IO.File]::ReadAllText($stderrPath)
                }}
            }}
            finally {{
                foreach ($p in @($stdoutPath, $stderrPath)) {{
                    if (Test-Path -LiteralPath $p) {{
                        # LOGICAL_DELETE - non-existence verified below.
                        Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
                    }}
                    if (Test-Path -LiteralPath $p) {{
                        throw "Invoke-ProcessCaptured: failed to LOGICAL_DELETE $p"
                    }}
                }}
            }}
            return [pscustomobject]@{{
                ExitCode = [int]$exitCode
                Stdout   = [string]$stdoutText
                Stderr   = [string]$stderrText
            }}
        }}

        # ==========================================================
        # Helper: Invoke-HostInstall (corrections #58 + #66)
        # ==========================================================
        # Canonical SCM install invocation. Caller reads .ExitCode
        # from the structured return; raw $LASTEXITCODE is forbidden
        # (the success-stdout `Service "NetManagerAgent" installed.`
        # would pollute a `& $HostExe ... ; $LASTEXITCODE` pipeline).
        function Invoke-HostInstall {{
            [CmdletBinding()]
            param(
                [Parameter(Mandatory)][string]$HostExe,
                [Parameter(Mandatory)][string]$PrivatePython,
                [Parameter(Mandatory)][string]$Entrypoint,
                [Parameter(Mandatory)][string]$AppDir,
                [Parameter(Mandatory)][string]$ConfigPath,
                [Parameter(Mandatory)][string]$LogDir
            )
            [string[]]$InstallArgs = @(
                "install",
                "--service-name",    $ServiceName,
                "--display-name",    $DisplayName,
                "--description",     $ServiceDescription,
                "--child-exe",       $PrivatePython,
                "--child-arg",       "-E",
                "--child-arg",       "-I",
                "--child-arg",       $Entrypoint,
                "--work-dir",        $AppDir,
                "--env-file",        $ConfigPath,
                "--log-dir",         $LogDir,
                "--service-account", "LocalSystem"
            )
            $result = Invoke-ProcessCaptured -FilePath $HostExe -ArgumentList $InstallArgs
            return [pscustomobject]@{{
                ExitCode = $result.ExitCode
                Stdout   = $result.Stdout
                Stderr   = $result.Stderr
                Args     = $InstallArgs
            }}
        }}

        # ==========================================================
        # Helper: Invoke-LogicalDelete (correction #57)
        # ==========================================================
        # Force-remove a path then verify non-existence. Throws on
        # failure so callers never silently leave a secret-bearing
        # transient behind.
        function Invoke-LogicalDelete {{
            param([Parameter(Mandatory)][string]$Path)
            if (Test-Path -LiteralPath $Path) {{
                Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
            }}
            if (Test-Path -LiteralPath $Path) {{
                throw "LOGICAL_DELETE failed for $Path"
            }}
        }}

        # ==========================================================
        # Helper: Write-InstallerRunTxt (Section G.8 + Stage 2B)
        # ==========================================================
        # Audit + recovery message file. Always written without the
        # agent key or any config content.
        function Write-InstallerRunTxt {{
            param([Parameter(Mandatory)][string[]]$Lines)
            try {{
                $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
                $payload = ($Lines -join "`r`n")
                Add-Content -LiteralPath $InstallerRunTxt -Value "[$ts]`r`n$payload`r`n"
            }} catch {{}}
        }}

        Write-Host "[1/11] Administrator privileges verified." -ForegroundColor Cyan

        # ==========================================================
        # [2/11] 2A: Directory preparation + ACL hardening (SIDs)
        # ==========================================================
        Write-Host "[2/11] 2A: Preparing install tree + hardening ACL..." -ForegroundColor Cyan
        foreach ($d in @($InstallDir, $BinDir, $LogDir, $StagingDir, $PayloadRoot)) {{
            New-Item -ItemType Directory -Force -Path $d | Out-Null
        }}

        # Locale-independent SIDs:
        #   S-1-5-18      = NT AUTHORITY\\SYSTEM
        #   S-1-5-32-544  = BUILTIN\\Administrators
        # Fail-closed (correction #6): if we cannot prove the install
        # directory is restricted, we MUST NOT continue.
        try {{
            $systemSid = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
            $adminSid  = New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'
            $acl = Get-Acl $InstallDir
            $acl.SetAccessRuleProtection($true, $false)
            $sysRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $systemSid, "FullControl",
                "ContainerInherit,ObjectInherit", "None", "Allow"
            )
            $adminRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $adminSid, "FullControl",
                "ContainerInherit,ObjectInherit", "None", "Allow"
            )
            $acl.AddAccessRule($sysRule)
            $acl.AddAccessRule($adminRule)
            Set-Acl $InstallDir $acl
            Write-Host "[OK] ACL hardened (SYSTEM + Administrators only, inheritance disabled)." -ForegroundColor Green
        }} catch {{
            $err = $_.Exception
            try {{
                $logPath = Join-Path $LogDir "installer-acl.log"
                $ts = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
                Add-Content -Path $logPath -Value "$ts ACL failure: $($err.GetType().FullName)"
            }} catch {{}}
            Write-Host "[ERROR] Install directory ACL could not be secured." -ForegroundColor Red
            Write-Host "[ERROR] Installation aborted before any credential was written." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }}

        # ==========================================================
        # [2/11] 2B: Transaction recovery preflight + four-probe
        #            SCM agreement + restorability gate
        # ==========================================================
        Write-Host "[2/11] 2B: Transaction recovery preflight..." -ForegroundColor Cyan

        # Step 1 - backup-artifact halt (correction #43)
        $blockingArtifacts = @()
        foreach ($p in @($PayloadPrevious, $ConfigEnvBak, $HostExeBak, $StagingRollbackConfig)) {{
            if (Test-Path -LiteralPath $p) {{ $blockingArtifacts += $p }}
        }}
        foreach ($parent in @($PayloadRoot, $InstallDir, $BinDir, $StagingDir)) {{
            if (Test-Path -LiteralPath $parent) {{
                try {{
                    $blockingArtifacts += (Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue |
                        Where-Object {{ $_.Name -like 'failed-*' }} | ForEach-Object {{ $_.FullName }})
                }} catch {{}}
            }}
        }}
        if ($blockingArtifacts.Count -gt 0) {{
            Write-InstallerRunTxt @(
                "TRANSACTION_RECOVERY_RESULT=BLOCKED",
                "UNRESOLVED_PREVIOUS_TRANSACTION"
            )
            Write-Host "[BLOCKED] UNRESOLVED_PREVIOUS_TRANSACTION." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 3
        }}

        # Step 2 - four-probe service-state classification
        # (correction #71 - all four probes must agree or BLOCK).
        $InitialServiceState        = "Absent"
        $L1_ServiceExistedInitially = $false
        $IsCanonicallyRestorable    = $false

        $P1_Present = $null
        try {{ $P1_Present = ($null -ne (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) }}
        catch {{ $P1_Present = "ERROR" }}

        $P2_Present = $null
        try {{
            $regPath = "Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\$ServiceName"
            $P2_Present = (Test-Path -LiteralPath $regPath)
        }} catch {{ $P2_Present = "ERROR" }}

        $P3_Rows = $null
        try {{
            $P3_Rows = @(Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue)
        }} catch {{ $P3_Rows = "ERROR" }}

        $P4_ExitCode = $null
        $P4_Stdout   = ""
        $P4_Stderr   = ""
        if (Test-Path -LiteralPath $HostExeLive) {{
            try {{
                $statusResult = Invoke-ProcessCaptured -FilePath $HostExeLive `
                    -ArgumentList @("status","--service-name",$ServiceName)
                $P4_ExitCode = [int]$statusResult.ExitCode
                $P4_Stdout   = [string]$statusResult.Stdout
                $P4_Stderr   = [string]$statusResult.Stderr
            }} catch {{
                $P4_ExitCode = "ERROR"
            }}
        }}

        $probeError = $null
        if ($P1_Present -eq "ERROR" -or $P2_Present -eq "ERROR" -or $P3_Rows -eq "ERROR" -or $P4_ExitCode -eq "ERROR") {{
            $probeError = "probe threw or access denied"
        }}
        elseif ($P3_Rows -is [array] -and $P3_Rows.Count -gt 1) {{
            $probeError = "Win32_Service multiple rows"
        }}
        elseif ([bool]$P1_Present -ne [bool]$P2_Present) {{
            $probeError = "P1 / P2 disagreement"
        }}
        elseif (($P3_Rows.Count -gt 0) -ne [bool]$P1_Present) {{
            $probeError = "P3 row count disagrees with P1"
        }}
        elseif ($P4_ExitCode -ne $null -and $P4_Stdout.Trim().Split("`n").Count -gt 1) {{
            $probeError = "P4 stdout multi-line"
        }}

        if ($probeError) {{
            Write-InstallerRunTxt @(
                "TRANSACTION_RECOVERY_RESULT=BLOCKED",
                "SERVICE_REGISTRATION_PROBE_INCONSISTENT",
                "UNRESOLVED_PREVIOUS_TRANSACTION",
                "REASON: $probeError"
            )
            Write-Host "[BLOCKED] SERVICE_REGISTRATION_PROBE_INCONSISTENT: $probeError" -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 3
        }}

        $hostBinPresent = Test-Path -LiteralPath $HostExeLive
        $probesAllAbsent  = (-not $P1_Present) -and (-not $P2_Present) -and ($P3_Rows.Count -eq 0) -and (
            (-not $hostBinPresent) -or ($P4_ExitCode -eq 18)
        )
        $probesAllPresent = $P1_Present -and $P2_Present -and ($P3_Rows.Count -eq 1) -and $hostBinPresent -and (
            $P4_ExitCode -eq 0 -or $P4_ExitCode -eq 1
        )

        if ($probesAllAbsent) {{
            $InitialServiceState = "Absent"
        }}
        elseif ($probesAllPresent) {{
            $statusStdoutTrim = $P4_Stdout.TrimEnd("`r","`n")
            if ($P4_ExitCode -eq 0 -and $statusStdoutTrim -ceq "Running") {{
                $InitialServiceState = "Running"
            }}
            elseif ($P4_ExitCode -eq 1 -and $statusStdoutTrim -ceq "Stopped") {{
                $InitialServiceState = "Stopped"
            }}
            else {{
                Write-InstallerRunTxt @(
                    "TRANSACTION_RECOVERY_RESULT=BLOCKED",
                    "SERVICE_REGISTRATION_PROBE_INCONSISTENT",
                    "REASON: SERVICE_STATE_NOT_STABLE ($P4_ExitCode / $statusStdoutTrim)"
                )
                Write-Host "[BLOCKED] SERVICE_STATE_NOT_STABLE." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 3
            }}
            $L1_ServiceExistedInitially = $true
        }}
        else {{
            Write-InstallerRunTxt @(
                "TRANSACTION_RECOVERY_RESULT=BLOCKED",
                "SERVICE_REGISTRATION_PROBE_INCONSISTENT",
                "REASON: probes neither all-absent nor all-present"
            )
            Write-Host "[BLOCKED] SERVICE_REGISTRATION_PROBE_INCONSISTENT (mixed)." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 3
        }}

        # InitialRegistrationSnapshot (correction #65 + #70)
        $InitialRegistrationSnapshot = $null
        if ($L1_ServiceExistedInitially) {{
            $InitialRegistrationSnapshot = [pscustomobject]@{{
                ServiceName    = $ServiceName
                ImagePath      = "$($P3_Rows[0].PathName)"
                StartType      = "$($P3_Rows[0].StartMode)"
                ServiceAccount = "$($P3_Rows[0].StartName)"
                DisplayName    = "$($P3_Rows[0].DisplayName)"
                Description    = "$($P3_Rows[0].Description)"
            }}

            # Step 2.5 - registration restorability gate (correction #70)
            $expectedImagePath = "$HostExeLive run --service-name $ServiceName --display-name `"$DisplayName`" --description `"$ServiceDescription`" --child-exe $PrivatePython --child-arg -E --child-arg -I --child-arg $Entrypoint --work-dir $AppDir --env-file $ConfigEnvLive --log-dir $LogDir --service-account LocalSystem"
            $IsCanonicallyRestorable = `
                ($InitialRegistrationSnapshot.ImagePath      -ceq $expectedImagePath) -and `
                ($InitialRegistrationSnapshot.StartType      -ceq "Auto")             -and `
                ($InitialRegistrationSnapshot.ServiceAccount -ceq "LocalSystem")       -and `
                ($InitialRegistrationSnapshot.DisplayName    -ceq $DisplayName)        -and `
                ($InitialRegistrationSnapshot.Description    -ceq $ServiceDescription)

            if (-not $IsCanonicallyRestorable) {{
                Write-InstallerRunTxt @(
                    "TRANSACTION_RECOVERY_RESULT=BLOCKED",
                    "REGISTRATION_NOT_CANONICALLY_RESTORABLE",
                    "INCONSISTENT_LIVE_STATE"
                )
                Write-Host "[BLOCKED] REGISTRATION_NOT_CANONICALLY_RESTORABLE." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 3
            }}
        }}

        # Step 3 - INSTALL_MODE matrix (correction #52)
        $payloadHealthy = (Test-Path -LiteralPath $PayloadCurrent) -and `
            (Test-Path -LiteralPath "$PayloadCurrent\\runtime-manifest.json")
        $configHealthy  = (Test-Path -LiteralPath $ConfigEnvLive)
        $hostHealthy    = (Test-Path -LiteralPath $HostExeLive)

        if ((-not $payloadHealthy) -and (-not $configHealthy) -and (-not $hostHealthy) -and ($InitialServiceState -ceq "Absent")) {{
            $InstallMode = "CLEAN_INSTALL"
        }}
        elseif ($payloadHealthy -and $configHealthy -and $hostHealthy -and ($InitialServiceState -ceq "Running" -or $InitialServiceState -ceq "Stopped") -and $IsCanonicallyRestorable) {{
            $InstallMode = "HEALTHY_UPGRADE"
        }}
        else {{
            Write-InstallerRunTxt @(
                "TRANSACTION_RECOVERY_RESULT=BLOCKED",
                "INCONSISTENT_LIVE_STATE",
                "UNRESOLVED_PREVIOUS_TRANSACTION"
            )
            Write-Host "[BLOCKED] INCONSISTENT_LIVE_STATE." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 3
        }}

        # Step 4 - clean ONLY transient artifacts (correction #43)
        foreach ($t in @($PayloadNew, $StagingExtracted, $StagingRuntimeZip, $StagingRuntimeManifest, $StagingConfigNew)) {{
            if (Test-Path -LiteralPath $t) {{
                Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue
            }}
        }}

        Write-Host "[OK] InstallMode=$InstallMode InitialServiceState=$InitialServiceState" -ForegroundColor Green

        # ---- Ledger state (one-way bits per corrections #41 + #44 + #50 + #51) ----
        $L2_OldServiceStopAccepted                = $false
        $L3_OldServiceObservedStopped             = $false
        $L4_OldServiceUninstalled                 = $false
        $L5_OldServiceRegistrationGone            = $false
        $L6_NewServiceInstalled                   = $false
        $L6P_NewServiceRegistrationPossiblyExists = $false
        $L7_NewServiceStartAccepted               = $false
        $L8_NewServiceObservedRunning             = $false

        # ---- File-move ledger M1..M6 (correction #41) ----
        $MovedPayloadCurrentToPrevious = $false
        $MovedPayloadNewToCurrent      = $false
        $MovedHostLiveToBackup         = $false
        $MovedHostNewToLive            = $false
        $MovedConfigLiveToBackup       = $false
        $MovedConfigNewToLive          = $false

        # Snapshots (correction #72) - populated at Stage 9A A0
        $OldHostProcessSnapshot                = @()
        $OldVerifiedChildPythonProcessSnapshot = @()

        # ==========================================================
        # [3/11] Re-assert ACL after preflight writes
        # ==========================================================
        Write-Host "[3/11] Re-asserting install root ACL..." -ForegroundColor Cyan
        try {{
            $acl = Get-Acl $InstallDir
            Set-Acl $InstallDir $acl
        }} catch {{}}

        # ==========================================================
        # [4/11] Download + verify detached runtime manifest
        # ==========================================================
        Write-Host "[4/11] Downloading runtime manifest..." -ForegroundColor Cyan
        try {{
            $manifestResp = Invoke-WebRequest `
                -Uri "$BackendUrl/api/v1/agents/$AgentId/download/runtime/windows-amd64/manifest" `
                -Headers @{{ "X-Agent-Key" = $AgentKey }} `
                -OutFile $StagingRuntimeManifest `
                -UseBasicParsing `
                -PassThru
            $manifestVersion     = $manifestResp.Headers["X-Charon-Runtime-Version"]
            $manifestZipSha      = $manifestResp.Headers["X-Charon-Runtime-Zip-Sha256"]
            $manifestPython      = $manifestResp.Headers["X-Charon-Python-Version"]
            $manifestCompatRange = $manifestResp.Headers["X-Charon-Compatible-Host-Core-Range"]
        }} catch {{
            Write-Host "[ERROR] Runtime manifest download failed." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }}
        Write-Host "[OK] Runtime manifest received (version=$manifestVersion)." -ForegroundColor Green

        # ==========================================================
        # [5/11] Download + verify runtime bundle ZIP
        # ==========================================================
        Write-Host "[5/11] Downloading runtime bundle ZIP..." -ForegroundColor Cyan
        try {{
            $zipResp = Invoke-WebRequest `
                -Uri "$BackendUrl/api/v1/agents/$AgentId/download/runtime/windows-amd64" `
                -Headers @{{ "X-Agent-Key" = $AgentKey }} `
                -OutFile $StagingRuntimeZip `
                -UseBasicParsing `
                -PassThru
            $zipShaHeader = $zipResp.Headers["X-Charon-Runtime-Zip-Sha256"]
        }} catch {{
            Write-Host "[ERROR] Runtime bundle ZIP download failed." -ForegroundColor Red
            Remove-Item -LiteralPath $StagingRuntimeZip -Force -ErrorAction SilentlyContinue
            Read-Host "Press Enter to exit"
            exit 1
        }}
        $actualZipSha = (Get-FileHash -LiteralPath $StagingRuntimeZip -Algorithm SHA256).Hash
        if ($actualZipSha -cne $zipShaHeader -or $actualZipSha -cne $manifestZipSha) {{
            Write-Host "[ERROR] Runtime ZIP SHA-256 mismatch." -ForegroundColor Red
            Remove-Item -LiteralPath $StagingRuntimeZip -Force -ErrorAction SilentlyContinue
            Read-Host "Press Enter to exit"
            exit 1
        }}
        Write-Host "[OK] Runtime ZIP SHA-256 verified." -ForegroundColor Green

        # ==========================================================
        # [6/11] 6A: Traversal-safe + namespace-safe ZIP extraction
        # ==========================================================
        Write-Host "[6/11] 6A: Extracting runtime bundle (traversal-safe)..." -ForegroundColor Cyan
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        if (Test-Path -LiteralPath $StagingExtracted) {{
            Remove-Item -LiteralPath $StagingExtracted -Recurse -Force
        }}
        [System.IO.Directory]::CreateDirectory($StagingExtracted) | Out-Null
        $zipArchive = [System.IO.Compression.ZipFile]::OpenRead($StagingRuntimeZip)
        try {{
            $extractionRoot = [System.IO.Path]::GetFullPath($StagingExtracted).TrimEnd('\\') + '\\'
            foreach ($entry in $zipArchive.Entries) {{
                $entryName = $entry.FullName
                if ([string]::IsNullOrEmpty($entryName)) {{ throw "rejected: empty entry name" }}
                # Section F per-entry rejection list (corrections #4/5/23/28/29/68).
                if ($entryName.EndsWith("/") -or $entryName.EndsWith("\\")) {{
                    throw "rejected: explicit directory entry $entryName"
                }}
                $normalized = $entryName.Replace("/","\\")
                if ($normalized.StartsWith("\\")) {{
                    throw "rejected: leading separator or UNC / NT device $entryName"
                }}
                if ($normalized -match '^[A-Za-z]:') {{
                    throw "rejected: drive-letter prefix $entryName"
                }}
                foreach ($segment in $normalized.Split("\\")) {{
                    if ($segment -eq "")        {{ throw "rejected: empty segment $entryName" }}
                    if ($segment -eq ".")       {{ throw "rejected: dot segment $entryName" }}
                    if ($segment -eq "..")      {{ throw "rejected: dotdot segment $entryName" }}
                    if ($segment.EndsWith(".")) {{ throw "rejected: trailing dot $entryName" }}
                    if ($segment.EndsWith(" ")) {{ throw "rejected: trailing space $entryName" }}
                    if ($segment.Contains(":")) {{ throw "rejected: colon in segment $entryName" }}
                    $base = if ($segment.Contains(".")) {{ $segment.Split('.')[0] }} else {{ $segment }}
                    if ($base -imatch '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {{
                        throw "rejected: reserved device name $entryName"
                    }}
                }}
                # Symlink / reparse rejection (correction #68): external
                # attributes high word matches S_IFLNK (0xA000).
                $extAttr = $entry.ExternalAttributes
                if (($extAttr -band 0xA000) -eq 0xA000) {{
                    throw "rejected: symlink entry $entryName"
                }}
                $targetFull = [System.IO.Path]::GetFullPath(
                    (Join-Path $extractionRoot $normalized)
                )
                if (-not $targetFull.StartsWith($extractionRoot, [System.StringComparison]::OrdinalIgnoreCase)) {{
                    throw "rejected: path escapes extraction root $entryName"
                }}
                [System.IO.Directory]::CreateDirectory(
                    [System.IO.Path]::GetDirectoryName($targetFull)
                ) | Out-Null
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile(
                    $entry, $targetFull, $false
                )
            }}
        }}
        finally {{
            $zipArchive.Dispose()
        }}

        # 6A: validate smoke-list canonical bytes + line format
        $smokeList = Join-Path $StagingExtracted "metadata\\runtime-smoke-imports.txt"
        if (-not (Test-Path -LiteralPath $smokeList)) {{
            throw "metadata\\runtime-smoke-imports.txt missing from extracted bundle"
        }}
        [string[]]$Modules = @()
        foreach ($line in (Get-Content -LiteralPath $smokeList)) {{
            if ($line -notmatch '^[A-Za-z_][A-Za-z0-9_.]*$') {{
                throw "smoke list line rejected: $line"
            }}
            $Modules += $line
        }}

        # 6B: atomic rename + sanity-fire byte-exact RUNTIME_OK
        Write-Host "[6/11] 6B: Atomic rename + sanity-fire RUNTIME_OK..." -ForegroundColor Cyan
        if (Test-Path -LiteralPath $PayloadNew) {{
            Remove-Item -LiteralPath $PayloadNew -Recurse -Force
        }}
        [System.IO.Directory]::Move($StagingExtracted, $PayloadNew)
        if (Test-Path -LiteralPath $StagingExtracted) {{
            throw "rename did not remove source"
        }}
        if (-not (Test-Path -LiteralPath $PayloadNew)) {{
            throw "rename did not produce destination"
        }}
        $ModuleArg        = ($Modules -join ", ")
        $PrivatePythonNew = Join-Path $PayloadNew "runtime\\python\\python.exe"

        $verResult = Invoke-ProcessCaptured -FilePath $PrivatePythonNew `
            -ArgumentList @("-E","-I","--version")
        if ($verResult.ExitCode -ne 0) {{
            throw "private python --version exit $($verResult.ExitCode)"
        }}

        $smokeResult = Invoke-ProcessCaptured -FilePath $PrivatePythonNew `
            -ArgumentList @("-E","-I","-c","import $ModuleArg; print('RUNTIME_OK')")
        $smokeStdoutTrim = $smokeResult.Stdout.TrimEnd("`r","`n")
        if ($smokeResult.ExitCode -ne 0)        {{ throw "smoke exit $($smokeResult.ExitCode)" }}
        if ($smokeResult.Stderr.Length -gt 0)   {{ throw "smoke stderr not empty" }}
        if ($smokeStdoutTrim -cne "RUNTIME_OK") {{ throw "smoke stdout was '$smokeStdoutTrim' (byte/case-exact RUNTIME_OK required)" }}
        Write-Host "[OK] Private runtime sanity-fire byte-exact RUNTIME_OK." -ForegroundColor Green

        # ==========================================================
        # [7/11] Write staging\\config.env.new (no BOM, CRLF)
        # ==========================================================
        Write-Host "[7/11] Staging config.env.new..." -ForegroundColor Cyan
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        $configContent = "NETMANAGER_URL=$BackendUrl`r`n" + `
                         "NETMANAGER_AGENT_ID=$AgentId`r`n" + `
                         "NETMANAGER_AGENT_KEY=$AgentKey`r`n"
        [System.IO.File]::WriteAllText($StagingConfigNew, $configContent, $utf8NoBom)
        if (-not (Test-Path -LiteralPath $StagingConfigNew)) {{
            throw "config.env.new staging write failed"
        }}
        Write-Host "[OK] config.env.new staged." -ForegroundColor Green

        # ==========================================================
        # [8/11] Download + verify Go host binary -> $HostExeNew
        # ==========================================================
        Write-Host "[8/11] Downloading Go host binary to staging path..." -ForegroundColor Cyan
        Remove-Item -LiteralPath $HostExeNew -Force -ErrorAction SilentlyContinue
        try {{
            $hostResp = Invoke-WebRequest `
                -Uri "$BackendUrl/api/v1/agents/$AgentId/download/host/windows-amd64" `
                -Headers @{{ "X-Agent-Key" = $AgentKey }} `
                -OutFile $HostExeNew `
                -UseBasicParsing `
                -PassThru
            $expectedHostSha = $hostResp.Headers["X-Host-SHA256"]
            $hostVersion     = $hostResp.Headers["X-Host-Version"]
        }} catch {{
            Write-Host "[ERROR] Host binary download failed." -ForegroundColor Red
            Remove-Item -LiteralPath $HostExeNew -Force -ErrorAction SilentlyContinue
            Read-Host "Press Enter to exit"
            exit 1
        }}
        if (-not $expectedHostSha) {{
            Write-Host "[ERROR] Server did not return X-Host-SHA256." -ForegroundColor Red
            Remove-Item -LiteralPath $HostExeNew -Force -ErrorAction SilentlyContinue
            Read-Host "Press Enter to exit"
            exit 1
        }}
        $actualHostSha = (Get-FileHash -LiteralPath $HostExeNew -Algorithm SHA256).Hash
        if ($actualHostSha -cne $expectedHostSha) {{
            Write-Host "[ERROR] Host binary integrity check failed." -ForegroundColor Red
            Remove-Item -LiteralPath $HostExeNew -Force -ErrorAction SilentlyContinue
            Read-Host "Press Enter to exit"
            exit 1
        }}
        Write-Host "[OK] Host binary verified (version=$hostVersion)." -ForegroundColor Green

        # ==========================================================
        # [9/11] 9A: QUIESCE (corrections #44/#50/#60/#72)
        # ==========================================================

        # 9A.A0 - pre-quiesce process snapshot (correction #72)
        Write-Host "[9/11] 9A.A0: Pre-quiesce process snapshot..." -ForegroundColor Cyan
        if (Test-Path -LiteralPath $HostExeLive) {{
            try {{
                $OldHostProcessSnapshot = @(
                    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                        Where-Object {{ $_.ExecutablePath -ceq $HostExeLive }} |
                        ForEach-Object {{
                            [pscustomobject]@{{
                                PID                 = [int]$_.ProcessId
                                ExecutablePath      = "$($_.ExecutablePath)"
                                ProcessCreationTime = "$($_.CreationDate)"
                            }}
                        }}
                )
            }} catch {{
                Write-Host "[BLOCKED] Process snapshot unavailable." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 3
            }}
        }}

        $LivePython = Join-Path $PayloadCurrent "runtime\\python\\python.exe"
        if ((Test-Path -LiteralPath $LivePython) -and $OldHostProcessSnapshot.Count -gt 0) {{
            $oldHostPids = @($OldHostProcessSnapshot | ForEach-Object {{ $_.PID }})
            try {{
                $OldVerifiedChildPythonProcessSnapshot = @(
                    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                        Where-Object {{ ($oldHostPids -contains [int]$_.ParentProcessId) -and ($_.ExecutablePath -ceq $LivePython) }} |
                        ForEach-Object {{
                            [pscustomobject]@{{
                                PID                 = [int]$_.ProcessId
                                ExecutablePath      = "$($_.ExecutablePath)"
                                ProcessCreationTime = "$($_.CreationDate)"
                            }}
                        }}
                )
            }} catch {{}}
        }}

        # Snapshot expectations per InitialServiceState (correction #72)
        if ($InitialServiceState -ceq "Running") {{
            if ($OldHostProcessSnapshot.Count -gt 1) {{
                Write-Host "[BLOCKED] multiple OLD host processes detected." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 3
            }}
        }}
        elseif ($InitialServiceState -ceq "Stopped") {{
            if ($OldHostProcessSnapshot.Count -gt 0 -or $OldVerifiedChildPythonProcessSnapshot.Count -gt 0) {{
                Write-Host "[BLOCKED] SERVICE_STATE_NOT_STABLE (Stopped but processes exist)." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 3
            }}
        }}
        elseif ($InitialServiceState -ceq "Absent") {{
            if ($OldHostProcessSnapshot.Count -gt 0 -or $OldVerifiedChildPythonProcessSnapshot.Count -gt 0) {{
                Write-Host "[BLOCKED] orphan host/child process with Absent service." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 3
            }}
        }}

        # 9A.A1 / A1.post / A2 / A2.post branching
        if ($InitialServiceState -ceq "Running") {{
            Write-Host "[9/11] 9A.A1: Sending stop to old service..." -ForegroundColor Cyan
            $stopResult = Invoke-ProcessCaptured -FilePath $HostExeLive `
                -ArgumentList @("stop","--service-name",$ServiceName)
            if ($stopResult.ExitCode -eq 0) {{
                $L2_OldServiceStopAccepted = $true
            }}
            elseif ($stopResult.ExitCode -eq 18) {{
                $L5_OldServiceRegistrationGone = $true
            }}
            else {{
                Write-Host "[ERROR] stop exit $($stopResult.ExitCode)." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 1
            }}

            if (-not $L5_OldServiceRegistrationGone) {{
                $deadline = (Get-Date).AddSeconds(30)
                while ((Get-Date) -lt $deadline) {{
                    $s = Invoke-ProcessCaptured -FilePath $HostExeLive `
                        -ArgumentList @("status","--service-name",$ServiceName)
                    $st = $s.Stdout.TrimEnd("`r","`n")
                    if ($s.ExitCode -eq 1 -and $st -ceq "Stopped") {{
                        $L3_OldServiceObservedStopped = $true; break
                    }}
                    if ($s.ExitCode -eq 18) {{
                        $L3_OldServiceObservedStopped = $true
                        $L5_OldServiceRegistrationGone = $true
                        break
                    }}
                    Start-Sleep -Milliseconds 500
                }}
                if (-not $L3_OldServiceObservedStopped) {{
                    Write-Host "[ERROR] A1.post poll timed out." -ForegroundColor Red
                    Read-Host "Press Enter to exit"
                    exit 1
                }}
            }}
        }}
        elseif ($InitialServiceState -ceq "Stopped") {{
            # correction #60 - stop on Stopped returns exit 1, so skip A1.
            $L3_OldServiceObservedStopped = $true
        }}

        if ($L1_ServiceExistedInitially -and (-not $L5_OldServiceRegistrationGone)) {{
            Write-Host "[9/11] 9A.A2: Uninstalling old service..." -ForegroundColor Cyan
            $unResult = Invoke-ProcessCaptured -FilePath $HostExeLive `
                -ArgumentList @("uninstall","--service-name",$ServiceName)
            if ($unResult.ExitCode -eq 0) {{
                $L4_OldServiceUninstalled = $true
            }}
            elseif ($unResult.ExitCode -eq 18) {{
                $L4_OldServiceUninstalled = $true
                $L5_OldServiceRegistrationGone = $true
            }}
            elseif ($unResult.ExitCode -eq 19) {{
                $L4_OldServiceUninstalled = $true
            }}
            else {{
                Write-Host "[ERROR] uninstall exit $($unResult.ExitCode)." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 1
            }}

            if (-not $L5_OldServiceRegistrationGone) {{
                $deadline = (Get-Date).AddSeconds(30)
                while ((Get-Date) -lt $deadline) {{
                    $s = Invoke-ProcessCaptured -FilePath $HostExeLive `
                        -ArgumentList @("status","--service-name",$ServiceName)
                    if ($s.ExitCode -eq 18) {{
                        $L5_OldServiceRegistrationGone = $true; break
                    }}
                    Start-Sleep -Milliseconds 500
                }}
                if (-not $L5_OldServiceRegistrationGone) {{
                    Write-Host "[ERROR] A2.post poll timed out." -ForegroundColor Red
                    Read-Host "Press Enter to exit"
                    exit 1
                }}
            }}
        }}

        # 9A.A3 - process closure verification using PID + path +
        # creation-time triple to defeat PID reuse (correction #72)
        $a3Deadline = (Get-Date).AddSeconds(10)
        $a3Ok = $true
        foreach ($snap in $OldHostProcessSnapshot) {{
            $closed = $false
            while ((Get-Date) -lt $a3Deadline) {{
                $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($snap.PID)" -ErrorAction SilentlyContinue
                if (-not $live)                                            {{ $closed = $true; break }}
                if ("$($live.ExecutablePath)" -cne "$($snap.ExecutablePath)") {{ $closed = $true; break }}
                if ("$($live.CreationDate)"   -cne "$($snap.ProcessCreationTime)") {{ $closed = $true; break }}
                Start-Sleep -Milliseconds 500
            }}
            if (-not $closed) {{ $a3Ok = $false; break }}
        }}
        if (-not $a3Ok) {{
            Write-Host "[ERROR] A3 process closure timeout." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }}

        # ==========================================================
        # [9/11] 9B: ATOMIC SWAP M1..M6 (correction #41)
        # ==========================================================
        Write-Host "[9/11] 9B: M1..M6 atomic swap..." -ForegroundColor Cyan

        # Pre-condition: destinations of optional moves M1, M3, M5
        # MUST NOT EXIST (Stage 2B halts any state where they do).
        if (Test-Path -LiteralPath $PayloadCurrent) {{
            if (Test-Path -LiteralPath $PayloadPrevious) {{
                throw "M1 destination $PayloadPrevious unexpectedly exists"
            }}
            [System.IO.Directory]::Move($PayloadCurrent, $PayloadPrevious)
            $MovedPayloadCurrentToPrevious = $true
        }}
        [System.IO.Directory]::Move($PayloadNew, $PayloadCurrent)
        $MovedPayloadNewToCurrent = $true

        if (Test-Path -LiteralPath $HostExeLive) {{
            if (Test-Path -LiteralPath $HostExeBak) {{
                throw "M3 destination $HostExeBak unexpectedly exists"
            }}
            [System.IO.File]::Move($HostExeLive, $HostExeBak)
            $MovedHostLiveToBackup = $true
        }}
        [System.IO.File]::Move($HostExeNew, $HostExeLive)
        $MovedHostNewToLive = $true

        if (Test-Path -LiteralPath $ConfigEnvLive) {{
            if (Test-Path -LiteralPath $ConfigEnvBak) {{
                throw "M5 destination $ConfigEnvBak unexpectedly exists"
            }}
            [System.IO.File]::Move($ConfigEnvLive, $ConfigEnvBak)
            $MovedConfigLiveToBackup = $true
        }}
        [System.IO.File]::Move($StagingConfigNew, $ConfigEnvLive)
        $MovedConfigNewToLive = $true

        # Wipe transient staging (except $StagingRollbackConfig).
        foreach ($t in @($StagingRuntimeZip, $StagingRuntimeManifest)) {{
            if (Test-Path -LiteralPath $t) {{
                Remove-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue
            }}
        }}

        # ==========================================================
        # [10/11] Install + start new service (corrections
        #         #45 + #51 + #58 + #66)
        # ==========================================================
        Write-Host "[10/11] Installing new service via Invoke-HostInstall..." -ForegroundColor Cyan
        $installResult = Invoke-HostInstall `
            -HostExe       $HostExeLive `
            -PrivatePython $PrivatePython `
            -Entrypoint    $Entrypoint `
            -AppDir        $AppDir `
            -ConfigPath    $ConfigEnvLive `
            -LogDir        $LogDir

        if ($installResult.ExitCode -eq 0) {{
            $stdoutTrim = $installResult.Stdout.TrimEnd("`r","`n")
            if ($stdoutTrim -cne 'Service "NetManagerAgent" installed.') {{
                Write-Host "[ERROR] install stdout mismatch." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 1
            }}
            if ($installResult.Stderr.Length -gt 0) {{
                Write-Host "[ERROR] install stderr not empty." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 1
            }}
            $L6_NewServiceInstalled = $true
        }}
        elseif ($installResult.ExitCode -eq 17) {{
            # correction #51 - install exit 17 ErrServiceExists anomaly.
            $stderrTrim = $installResult.Stderr.TrimEnd("`r","`n")
            if ($stderrTrim -cne "install: service: already exists") {{
                Write-Host "[ERROR] install exit-17 stderr mismatch." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 1
            }}
            $L6P_NewServiceRegistrationPossiblyExists = $true
            Write-Host "[BLOCKED] install exit 17 - entering Phase 1 status-aware teardown." -ForegroundColor Yellow
            Read-Host "Press Enter to exit"
            exit 1
        }}
        else {{
            Write-Host "[ERROR] install exit $($installResult.ExitCode)." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }}

        $startResult = Invoke-ProcessCaptured -FilePath $HostExeLive `
            -ArgumentList @("start","--service-name",$ServiceName)
        if ($startResult.ExitCode -ne 0) {{
            Write-Host "[ERROR] start exit $($startResult.ExitCode)." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }}
        $L7_NewServiceStartAccepted = $true

        # ==========================================================
        # [11/11] Verify Running + Stage-11 COMMIT BARRIER
        #          (corrections #36 + #46 + #65 + #69)
        # ==========================================================
        Write-Host "[11/11] Verifying service Running (10s + 30s)..." -ForegroundColor Cyan
        Start-Sleep -Seconds 10
        $s10 = Invoke-ProcessCaptured -FilePath $HostExeLive `
            -ArgumentList @("status","--service-name",$ServiceName)
        $s10Trim = $s10.Stdout.TrimEnd("`r","`n")
        if ($s10.ExitCode -ne 0 -or $s10Trim -cne "Running" -or $s10.Stderr.Length -gt 0) {{
            Write-Host "[ERROR] 10s status check failed." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }}

        Start-Sleep -Seconds 20
        $s30 = Invoke-ProcessCaptured -FilePath $HostExeLive `
            -ArgumentList @("status","--service-name",$ServiceName)
        $s30Trim = $s30.Stdout.TrimEnd("`r","`n")
        if ($s30.ExitCode -ne 0 -or $s30Trim -cne "Running" -or $s30.Stderr.Length -gt 0) {{
            Write-Host "[ERROR] 30s status check failed." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }}
        $L8_NewServiceObservedRunning = $true

        # COMMIT BARRIER 11.A / 11.B / 11.C / 11.D (correction #69)
        # Backups are deleted ONLY after Stage 11.C semantic
        # equivalence verification passes. A wrong-flag install
        # that briefly registers but fails 11.C still has
        # $PayloadPrevious / $ConfigEnvBak / $HostExeBak on disk
        # so Section G rollback can use them.
        Write-Host "[11/11] Stage 11.A/B/C: SCM registration semantic equivalence..." -ForegroundColor Cyan
        $postRow = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
        $expectedImagePath = "$HostExeLive run --service-name $ServiceName --display-name `"$DisplayName`" --description `"$ServiceDescription`" --child-exe $PrivatePython --child-arg -E --child-arg -I --child-arg $Entrypoint --work-dir $AppDir --env-file $ConfigEnvLive --log-dir $LogDir --service-account LocalSystem"
        if ("$($postRow.PathName)" -cne $expectedImagePath -or "$($postRow.StartMode)" -cne "Auto" -or "$($postRow.StartName)" -cne "LocalSystem") {{
            Write-Host "[ERROR] Stage 11.C: registration semantic mismatch." -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }}

        # Stage 11.D - LOGICAL_DELETE backups ONLY after 11.C passes.
        foreach ($b in @($PayloadPrevious, $ConfigEnvBak, $HostExeBak)) {{
            if (Test-Path -LiteralPath $b) {{
                Invoke-LogicalDelete -Path $b
            }}
        }}

        Write-InstallerRunTxt @(
            "INSTALL_RESULT=SUCCESS",
            "INSTALL_MODE=$InstallMode",
            "RUNTIME_VERSION=$manifestVersion",
            "HOST_VERSION=$hostVersion"
        )

        Write-Host ""
        Write-Host "[OK] NetManager Agent installation complete (Section H 11-stage)." -ForegroundColor Green
        Write-Host ""

        # ==========================================================
        # Section G rollback labels (referenced by post-install
        # verifier + manual-test pattern checks). The labels below
        # name the three terminal modes; the live rollback logic
        # is gated by the M1..M6 markers above and executes inside
        # the catch block of the outer try/finally.
        # ==========================================================
        # SUCCESSFUL_UPGRADE_ROLLBACK_RUNNING
        # SUCCESSFUL_UPGRADE_ROLLBACK_STOPPED
        # SUCCESSFUL_CLEAN_INSTALL_ROLLBACK
        # ROLLBACK_INCOMPLETE / MANUAL INTERVENTION REQUIRED

        }}
        catch {{
            # ==========================================================
            # Section G rollback driver - status-aware Phase 1 +
            # file-reverse Phase 2 + Phase 3 old-service restart.
            # Each move marker is reversed only if set; CLEAN_INSTALL
            # orphan cleanup runs when M{{1,3,5}} are unset but
            # M{{2,4,6}} are set (correction #67).
            # ==========================================================
            $rbReason = "$($_.Exception.Message)"
            Write-Host "[ROLLBACK] $rbReason" -ForegroundColor Yellow

            # ---- Phase 1 - status-aware new-service teardown ----
            # Run only when L6 / L6' / (MovedHostNewToLive + status registered).
            if ($L6_NewServiceInstalled -or $L6P_NewServiceRegistrationPossiblyExists -or $MovedHostNewToLive) {{
                try {{
                    $s = Invoke-ProcessCaptured -FilePath $HostExeLive `
                        -ArgumentList @("status","--service-name",$ServiceName)
                    $stTrim = $s.Stdout.TrimEnd("`r","`n")
                    if ($s.ExitCode -eq 0 -and $stTrim -ceq "Running") {{
                        Invoke-ProcessCaptured -FilePath $HostExeLive `
                            -ArgumentList @("stop","--service-name",$ServiceName) | Out-Null
                    }}
                    if ($s.ExitCode -ne 18) {{
                        Invoke-ProcessCaptured -FilePath $HostExeLive `
                            -ArgumentList @("uninstall","--service-name",$ServiceName) | Out-Null
                        $deadline = (Get-Date).AddSeconds(30)
                        while ((Get-Date) -lt $deadline) {{
                            $s2 = Invoke-ProcessCaptured -FilePath $HostExeLive `
                                -ArgumentList @("status","--service-name",$ServiceName)
                            if ($s2.ExitCode -eq 18) {{ break }}
                            Start-Sleep -Milliseconds 500
                        }}
                    }}
                }} catch {{}}
            }}

            # ---- Phase 2 - file reverse-rollback (correction #41) ----
            # Reverse only set markers, in reverse M6..M1 order.
            try {{
                if ($MovedConfigNewToLive) {{
                    [System.IO.File]::Move($ConfigEnvLive, $StagingRollbackConfig)
                }}
                if ($MovedConfigLiveToBackup) {{
                    [System.IO.File]::Move($ConfigEnvBak, $ConfigEnvLive)
                    Invoke-LogicalDelete -Path $StagingRollbackConfig
                }}
                elseif ($MovedConfigNewToLive) {{
                    # CLEAN_INSTALL orphan cleanup (correction #67)
                    Invoke-LogicalDelete -Path $StagingRollbackConfig
                }}

                if ($MovedHostNewToLive) {{
                    [System.IO.File]::Move($HostExeLive, $HostExeNew)
                }}
                if ($MovedHostLiveToBackup) {{
                    [System.IO.File]::Move($HostExeBak, $HostExeLive)
                    Invoke-LogicalDelete -Path $HostExeNew
                }}
                elseif ($MovedHostNewToLive) {{
                    Invoke-LogicalDelete -Path $HostExeNew
                }}

                if ($MovedPayloadNewToCurrent) {{
                    [System.IO.Directory]::Move($PayloadCurrent, $PayloadNew)
                }}
                if ($MovedPayloadCurrentToPrevious) {{
                    [System.IO.Directory]::Move($PayloadPrevious, $PayloadCurrent)
                    Invoke-LogicalDelete -Path $PayloadNew
                }}
                elseif ($MovedPayloadNewToCurrent) {{
                    Invoke-LogicalDelete -Path $PayloadNew
                }}
            }} catch {{
                Write-InstallerRunTxt @(
                    "ROLLBACK_INCOMPLETE",
                    "MANUAL INTERVENTION REQUIRED",
                    "REASON: $($_.Exception.Message)"
                )
                Write-Host "[ROLLBACK_INCOMPLETE] MANUAL INTERVENTION REQUIRED." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 2
            }}

            # ---- Phase 3 - restart old service per InitialServiceState ----
            $rbMode = "SUCCESSFUL_CLEAN_INSTALL_ROLLBACK"
            try {{
                if ($InitialServiceState -ceq "Absent") {{
                    $rbMode = "SUCCESSFUL_CLEAN_INSTALL_ROLLBACK"
                }}
                elseif ($InitialServiceState -ceq "Running") {{
                    if ($L5_OldServiceRegistrationGone -or (-not $L1_ServiceExistedInitially)) {{
                        $reInstall = Invoke-HostInstall `
                            -HostExe       $HostExeLive `
                            -PrivatePython (Join-Path $PayloadCurrent "runtime\\python\\python.exe") `
                            -Entrypoint    (Join-Path $PayloadCurrent "app\\run_agent.py") `
                            -AppDir        (Join-Path $PayloadCurrent "app") `
                            -ConfigPath    $ConfigEnvLive `
                            -LogDir        $LogDir
                        if ($reInstall.ExitCode -ne 0) {{
                            throw "Phase 3 reinstall exit $($reInstall.ExitCode)"
                        }}
                    }}
                    if ($L2_OldServiceStopAccepted -and $L3_OldServiceObservedStopped) {{
                        $startBack = Invoke-ProcessCaptured -FilePath $HostExeLive `
                            -ArgumentList @("start","--service-name",$ServiceName)
                        if ($startBack.ExitCode -ne 0) {{
                            throw "Phase 3 start exit $($startBack.ExitCode)"
                        }}
                        Start-Sleep -Seconds 10
                        $v10 = Invoke-ProcessCaptured -FilePath $HostExeLive `
                            -ArgumentList @("status","--service-name",$ServiceName)
                        if ($v10.ExitCode -ne 0 -or $v10.Stdout.TrimEnd("`r","`n") -cne "Running") {{
                            throw "Phase 3 10s verify failed"
                        }}
                        Start-Sleep -Seconds 20
                        $v30 = Invoke-ProcessCaptured -FilePath $HostExeLive `
                            -ArgumentList @("status","--service-name",$ServiceName)
                        if ($v30.ExitCode -ne 0 -or $v30.Stdout.TrimEnd("`r","`n") -cne "Running") {{
                            throw "Phase 3 30s verify failed"
                        }}
                    }}
                    $rbMode = "SUCCESSFUL_UPGRADE_ROLLBACK_RUNNING"
                }}
                elseif ($InitialServiceState -ceq "Stopped") {{
                    if ($L5_OldServiceRegistrationGone -or (-not $L1_ServiceExistedInitially)) {{
                        $reInstall = Invoke-HostInstall `
                            -HostExe       $HostExeLive `
                            -PrivatePython (Join-Path $PayloadCurrent "runtime\\python\\python.exe") `
                            -Entrypoint    (Join-Path $PayloadCurrent "app\\run_agent.py") `
                            -AppDir        (Join-Path $PayloadCurrent "app") `
                            -ConfigPath    $ConfigEnvLive `
                            -LogDir        $LogDir
                        if ($reInstall.ExitCode -ne 0) {{
                            throw "Phase 3 reinstall exit $($reInstall.ExitCode)"
                        }}
                    }}
                    # correction #61 - do NOT start when InitialServiceState was Stopped.
                    $rbMode = "SUCCESSFUL_UPGRADE_ROLLBACK_STOPPED"
                }}
            }} catch {{
                Write-InstallerRunTxt @(
                    "ROLLBACK_INCOMPLETE",
                    "MANUAL INTERVENTION REQUIRED",
                    "PHASE: 3",
                    "REASON: $($_.Exception.Message)"
                )
                Write-Host "[ROLLBACK_INCOMPLETE] MANUAL INTERVENTION REQUIRED." -ForegroundColor Red
                Read-Host "Press Enter to exit"
                exit 2
            }}

            Write-InstallerRunTxt @(
                "ROLLBACK_RESULT=$rbMode",
                "REASON: $rbReason"
            )
            Write-Host "[ROLLBACK_OK] $rbMode" -ForegroundColor Green
            Read-Host "Press Enter to exit"
            exit 1
        }}
        finally {{
            # ALL-PATH CLEANUP. Runs regardless of success, ACL fail,
            # download fail, SHA fail, install fail, status fail, or
            # any other terminating error.
            #   - Zero the in-memory agent key so a crash dump cannot
            #     recover it.
            #   - Remove the installer file from disk -- its header
            #     embeds the agent key as a PowerShell single-quoted
            #     literal.
            # -LiteralPath prevents wildcard expansion from deleting
            # anything other than the actual installer path.
            $AgentKey = $null
            if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath)) {{
                Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
            }}
        }}

        Read-Host "Press Enter to close this window"
    """)


def _embedded_agent_script() -> str:
    return "# NetManager Agent script not found on server.\n"


# ══════════════════════════════════════════════════════════════════════════════
# Peer-latency endpoints — Faz 3C
# ══════════════════════════════════════════════════════════════════════════════

class PeerLatencyResponse(BaseModel):
    id: int
    agent_from: str
    agent_to: str
    target_ip: str
    latency_ms: Optional[float]
    reachable: bool
    measured_at: datetime

    model_config = {"from_attributes": True}


@router.get("/{agent_id}/peer-latency", response_model=list[PeerLatencyResponse])
async def get_agent_peer_latency(
    agent_id: str,
    limit: int = Query(default=100, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """
    Return recent latency measurements where this agent is the source OR target.
    Includes both backend-originated (agent_from='backend') and A→B measurements.
    """
    from sqlalchemy import or_
    from app.models.agent_peer_latency import AgentPeerLatency

    rows = (
        await db.execute(
            select(AgentPeerLatency)
            .where(
                or_(
                    AgentPeerLatency.agent_to   == agent_id,
                    AgentPeerLatency.agent_from == agent_id,
                )
            )
            .order_by(desc(AgentPeerLatency.measured_at))
            .limit(limit)
        )
    ).scalars().all()
    return rows


@router.get("/peer-latency-matrix")
async def get_peer_latency_matrix(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
) -> dict:
    """
    Return the most-recent latency measurement for every (agent_from, agent_to) pair.

    Key format: "{agent_from}→{agent_to}"
    Includes both backend-originated (agent_from="backend") and
    true A→B agent-to-agent measurements (Faz 4A).
    """
    from app.models.agent_peer_latency import AgentPeerLatency

    # Latest measured_at per (agent_from, agent_to) pair
    subq = (
        select(
            AgentPeerLatency.agent_from,
            AgentPeerLatency.agent_to,
            func.max(AgentPeerLatency.measured_at).label("max_ts"),
        )
        .group_by(AgentPeerLatency.agent_from, AgentPeerLatency.agent_to)
        .subquery()
    )
    rows = (
        await db.execute(
            select(AgentPeerLatency).join(
                subq,
                and_(
                    AgentPeerLatency.agent_from == subq.c.agent_from,
                    AgentPeerLatency.agent_to   == subq.c.agent_to,
                    AgentPeerLatency.measured_at == subq.c.max_ts,
                ),
            )
        )
    ).scalars().all()

    return {
        f"{row.agent_from}→{row.agent_to}": {
            "agent_from":  row.agent_from,
            "agent_to":    row.agent_to,
            "latency_ms":  row.latency_ms,
            "reachable":   row.reachable,
            "target_ip":   row.target_ip,
            "measured_at": row.measured_at.isoformat(),
        }
        for row in rows
    }
