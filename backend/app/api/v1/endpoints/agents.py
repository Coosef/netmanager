import asyncio
import json
import os
import re
import secrets
import string
import textwrap
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import redis as _redis_lib
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import CurrentUser
from app.core.security import hash_password, verify_password
from app.models.agent import Agent
from app.models.agent_command_log import AgentCommandLog
from app.schemas.agent import AgentCreate, AgentCreateResponse, AgentResponse
from app.services.agent_manager import agent_manager

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
    )
    db.add(ev)


# ── REST ─────────────────────────────────────────────────────────────────────

@router.get("/", response_model=list[dict])
async def list_agents(db: AsyncSession = Depends(get_db), _: CurrentUser = None):
    result = await db.execute(select(Agent).where(Agent.is_active == True).order_by(Agent.created_at.desc()))
    agents = result.scalars().all()
    online_ids = set(agent_manager.online_agent_ids())
    return [_agent_to_dict(a, online_ids) for a in agents]


@router.get("/{agent_id}/live-metrics", response_model=dict)
async def get_agent_live_metrics(
    agent_id: str,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

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
    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
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
    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

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

    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

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

    agent_id = _gen_id()
    raw_key = _gen_key()

    agent = Agent(
        id=agent_id,
        name=payload.name,
        agent_key_hash=hash_password(raw_key),
        status="offline",
        created_by=current_user.id,
        command_mode="all",
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
    result = await db.execute(select(Agent).where(Agent.id == agent_id))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    agent.is_active = False
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

    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

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

    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

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

    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

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
    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")

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

@router.get("/{agent_id}/download/{platform}")
async def download_installer(
    agent_id: str,
    platform: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    agent_key: str = Query(..., description="Agent key (shown once at creation)"),
    server_url: str = Query(None, description="Public server URL visible to the agent machine"),
):
    """Generate a platform-specific installer script with embedded credentials."""
    if platform not in ("linux", "windows"):
        raise HTTPException(status_code=400, detail="platform must be linux or windows")

    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    if server_url:
        base_url = server_url.rstrip("/")
    elif settings.AGENT_WS_URL:
        base_url = settings.AGENT_WS_URL.rstrip("/")
    else:
        forwarded_host = request.headers.get("x-forwarded-host")
        forwarded_proto = request.headers.get("x-forwarded-proto", "http")
        if forwarded_host:
            base_url = f"{forwarded_proto}://{forwarded_host}"
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


@router.get("/download/script")
async def download_agent_script(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Return the raw agent Python script. Validates X-Agent-Key header if provided."""
    agent_id = request.headers.get("X-Agent-ID")
    agent_key = request.headers.get("X-Agent-Key")

    if agent_id and agent_key:
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

    result_agent = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    if not result_agent.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")

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

async def _push_device_sync_task(agent_id: str, db: AsyncSession):
    """Push assigned device list to agent for health monitoring."""
    try:
        from app.models.device import Device
        from app.core.security import decrypt_credential
        from sqlalchemy import select as _select
        dev_result = await db.execute(
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


async def _push_vault_task(agent_id: str, db: AsyncSession):
    """Push credential vault bundle to agent (called on hello with vault_support=True)."""
    try:
        import os as _os, base64 as _b64
        from sqlalchemy import select as _select
        from app.models.device import Device
        from app.models.agent_credential_bundle import AgentCredentialBundle
        from app.core.security import decrypt_credential, encrypt_credential

        devices = (await db.execute(
            _select(Device).where(Device.agent_id == agent_id, Device.is_active == True)
        )).scalars().all()
        if not devices:
            return

        # Check if we have a stored key; reuse it for continuity
        existing = (await db.execute(
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
            db.add(AgentCredentialBundle(
                agent_id=agent_id,
                agent_aes_key_enc=encrypt_credential(aes_key_b64),
                device_count=len(credentials),
            ))
            await db.commit()

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

    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")
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
    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

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
    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

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

    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")
    if not agent_manager.is_online(agent_id):
        raise HTTPException(status_code=409, detail="Agent is offline")

    subnet = body.get("subnet", "")
    if not subnet:
        raise HTTPException(status_code=400, detail="subnet is required (e.g. 192.168.1.0/24)")

    result_data = await agent_manager.trigger_discovery(agent_id, subnet, body.get("ports"))

    # Persist result
    from app.models.discovery_result import DiscoveryResult
    dr = DiscoveryResult(
        agent_id=agent_id,
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

    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")
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
    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

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

    result = await db.execute(select(Agent).where(Agent.id == agent_id, Agent.is_active == True))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Agent not found")
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
        community = d.snmp_community or ""
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

@router.websocket("/ws/{agent_id}")
async def agent_websocket(
    agent_id: str,
    websocket: WebSocket,
    key: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
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

    await websocket.accept()

    # Reset failed auth on successful connect
    was_offline = agent.status == "offline"
    agent.status = "online"
    agent.last_ip = client_ip
    agent.failed_auth_count = 0
    agent.last_connected_at = datetime.now(timezone.utc)
    agent.total_connections = (agent.total_connections or 0) + 1
    await db.commit()

    # Emit online event if agent was previously offline
    if was_offline:
        await _emit_agent_event(db, agent, "agent_online")
        await db.commit()

    # Load security config into cache
    agent_manager.set_security_config(agent_id, agent.command_mode, agent.allowed_commands)

    meta = {}
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

    # Server-side keepalive: every 8s to stay well under Nginx proxy_read_timeout (60s default)
    async def _server_keepalive():
        while True:
            await asyncio.sleep(8)
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
                agent.platform = msg.get("platform")
                agent.machine_hostname = msg.get("hostname")
                agent.version = msg.get("version")
                if msg.get("local_ip"):
                    agent.local_ip = msg.get("local_ip")
                try:
                    await db.commit()
                except Exception:
                    await db.rollback()

                # Auto-update: notify agent if its version is outdated
                agent_ver = msg.get("version") or ""
                def _ver(v): return tuple(int(x) for x in v.split(".") if x.isdigit())
                if agent_ver and _ver(agent_ver) < _ver(CURRENT_AGENT_VERSION):
                    try:
                        import base64 as _b64
                        _sp = Path(__file__).parents[4] / "agent_script" / "netmanager_agent.py"
                        _sc = _b64.b64encode(_sp.read_bytes()).decode() if _sp.exists() else None
                        await asyncio.wait_for(
                            websocket.send_text(json.dumps({
                                "type": "update_available",
                                "current_version": CURRENT_AGENT_VERSION,
                                "script_path": "/api/v1/agents/download/script",
                                "script_content": _sc,
                            })),
                            timeout=5,
                        )
                    except Exception:
                        pass

                # Push device list for health monitoring
                asyncio.create_task(_push_device_sync_task(agent_id, db))

                # Push credential vault if agent supports it
                if msg.get("vault_support"):
                    asyncio.create_task(_push_vault_task(agent_id, db))

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
                try:
                    await db.commit()
                except Exception:
                    await db.rollback()

            await agent_manager.handle_message(agent_id, raw)

    except WebSocketDisconnect:
        pass
    finally:
        keepalive_task.cancel()
        await agent_manager.disconnect(agent_id)
        agent.status = "offline"
        agent.last_disconnected_at = datetime.now(timezone.utc)
        try:
            await db.commit()
        except Exception:
            pass

        # Emit offline event
        try:
            await _emit_agent_event(db, agent, "agent_offline")
            await db.commit()
        except Exception:
            pass


# ── Installer templates ───────────────────────────────────────────────────────

def _linux_installer(agent_id: str, agent_key: str, backend_url: str) -> str:
    return textwrap.dedent(f"""\
        #!/bin/bash
        # NetManager Proxy Agent — Linux/macOS Installer
        # Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
        # Agent ID: {agent_id}

        set -e

        AGENT_ID="{agent_id}"
        AGENT_KEY="{agent_key}"
        BACKEND_URL="{backend_url}"
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
        TOKEN=$(cat "$INSTALL_DIR/.last_token" 2>/dev/null || true)
        curl -fsSL -H "Authorization: Bearer $TOKEN" "$BACKEND_URL/api/v1/agents/download/script" -o "$INSTALL_DIR/netmanager_agent.py" || \
          curl -fsSL "$BACKEND_URL/api/v1/agents/download/script" -o "$INSTALL_DIR/netmanager_agent.py"

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
                launchctl bootstrap system "$PLIST_PATH"
            else
                launchctl unload "$PLIST_PATH" 2>/dev/null || true
                launchctl load -w "$PLIST_PATH"
            fi
            echo "✓ NetManager Agent kuruldu! (macOS launchd)"
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
    return textwrap.dedent(f"""\
        # NetManager Proxy Agent — Windows Kurulum Betiği
        # Oluşturulma: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}
        # Agent ID: {agent_id}

        $AgentId   = "{agent_id}"
        $AgentKey  = "{agent_key}"
        $BackendUrl = "{backend_url}"
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
        Invoke-WebRequest "$BackendUrl/api/v1/agents/download/script" -OutFile "$InstallDir\\netmanager_agent.py" -UseBasicParsing

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
