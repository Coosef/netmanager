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
from fastapi.responses import PlainTextResponse
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

# ── Current agent version (read from script at startup) ───────────────────────
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


# ── REST ─────────────────────────────────────────────────────────────────────

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


# ── Security config ───────────────────────────────────────────────────────────

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


# ── Command audit log ─────────────────────────────────────────────────────────

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


# ── Installer download ────────────────────────────────────────────────────────

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
        media_type = "text/x-shellscript"
    else:
        script = _windows_installer(agent_id, agent_key, base_url)
        filename = f"netmanager-agent-{agent_id}-windows.ps1"
        media_type = "text/plain"

    return PlainTextResponse(
        content=script,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
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


# ── Latency routing ──────────────────────────────────────────────────────────

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


# ── WebSocket helper tasks (called on hello) ──────────────────────────────────

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


# ── Feature 2: Device sync ────────────────────────────────────────────────────

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


# ── Feature 4: SNMP via Agent ─────────────────────────────────────────────────

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


# ── Feature 5: Discovery ──────────────────────────────────────────────────────

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


# ── Feature 6: Syslog ─────────────────────────────────────────────────────────

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


# ── Feature 7: Streaming ──────────────────────────────────────────────────────

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


# ── Feature 8: Credential Vault ───────────────────────────────────────────────

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


# ── WebSocket ─────────────────────────────────────────────────────────────────

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


# ── Installer templates ───────────────────────────────────────────────────────

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
    # T8.4 Security F1.3 defense-in-depth — PowerShell single-quoted
    # string'lerde tek tırnak escape `''` ile. Whitelist atlanmış bir
    # senaryoda bile değer kaçıp komut enjekte edilemez.
    def _psq(s: str) -> str:
        return "'" + s.replace("'", "''") + "'"
    p_id  = _psq(agent_id)
    p_key = _psq(agent_key)
    p_url = _psq(backend_url)
    return textwrap.dedent(f"""\
        # NetManager Proxy Agent — Windows Kurulum Betiği
        # Oluşturulma: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
        # Agent ID: {agent_id}

        $AgentId   = {p_id}
        $AgentKey  = {p_key}
        $BackendUrl = {p_url}
        $InstallDir = "C:\\ProgramData\\NetManagerAgent"
        $ServiceName = "NetManagerAgent"
        $PythonExe = ""

        if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole("Administrator")) {{
            Write-Host "Lütfen Yönetici olarak çalıştırın" -ForegroundColor Red
            pause; exit 1
        }}

        Write-Host "[1/5] Python kontrol ediliyor..."
        $PythonExe = (Get-Command python -ErrorAction SilentlyContinue)?.Source
        if (-not $PythonExe) {{
            winget install Python.Python.3.12 --silent --accept-package-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            $PythonExe = (Get-Command python -ErrorAction SilentlyContinue)?.Source
            if (-not $PythonExe) {{ Write-Host "Python kurulumu başarısız." -ForegroundColor Red; pause; exit 1 }}
        }}

        Write-Host "[2/5] Kurulum dizini oluşturuluyor..."
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

        Write-Host "[3/5] Agent betiği indiriliyor..."
        # T8.4 F3 — /download/script X-Agent-ID + X-Agent-Key header zorunlu
        Invoke-WebRequest `
            -Uri "$BackendUrl/api/v1/agents/download/script" `
            -Headers @{{ "X-Agent-ID" = $AgentId; "X-Agent-Key" = $AgentKey }} `
            -OutFile "$InstallDir\\netmanager_agent.py" `
            -UseBasicParsing

        Write-Host "[4/5] Bağımlılıklar kuruluyor..."
        & $PythonExe -m pip install --quiet --upgrade websockets netmiko

        @"
NETMANAGER_URL={backend_url}
NETMANAGER_AGENT_ID={agent_id}
NETMANAGER_AGENT_KEY={agent_key}
"@ | Out-File -FilePath "$InstallDir\\config.env" -Encoding UTF8

        @"
import os, sys
cfg = open(r'$InstallDir\\config.env').read()
for line in cfg.splitlines():
    line = line.strip()
    if '=' in line and not line.startswith('#'):
        k, v = line.split('=', 1)
        os.environ[k.strip()] = v.strip()
exec(open(r'$InstallDir\\netmanager_agent.py').read())
"@ | Out-File -FilePath "$InstallDir\\run_agent.py" -Encoding UTF8

        Write-Host "[5/5] Windows servisi kuruluyor..."
        $existingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($existingSvc) {{
            Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
            sc.exe delete $ServiceName | Out-Null
            Start-Sleep 2
        }}

        $binPath = "`"$PythonExe`" `"$InstallDir\\run_agent.py`""
        sc.exe create $ServiceName binPath= $binPath DisplayName= "NetManager Proxy Agent" start= auto obj= LocalSystem
        sc.exe failure $ServiceName reset= 60 actions= restart/10000/restart/30000/restart/60000
        sc.exe start $ServiceName

        Write-Host "✓ NetManager Agent kuruldu!" -ForegroundColor Green
        pause
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
