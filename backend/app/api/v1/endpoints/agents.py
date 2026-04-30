import json
import secrets
import string
import textwrap
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.core.security import hash_password, verify_password
from app.models.agent import Agent
from app.models.agent_command_log import AgentCommandLog
from app.schemas.agent import AgentCreate, AgentCreateResponse, AgentResponse
from app.services.agent_manager import agent_manager

router = APIRouter()

_MAX_FAILED_AUTH = 10   # lock agent WS after this many consecutive failures


def _gen_id(length: int = 12) -> str:
    chars = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


def _gen_key(length: int = 48) -> str:
    return secrets.token_urlsafe(length)


def _agent_to_dict(agent: Agent, online_ids: set) -> dict:
    return {
        "id": agent.id,
        "name": agent.name,
        "status": "online" if agent.id in online_ids else "offline",
        "last_heartbeat": agent.last_heartbeat,
        "last_ip": agent.last_ip,
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
    """Create a NetworkEvent for agent online/offline transitions."""
    from app.models.network_event import NetworkEvent
    severity = "info" if event_type == "agent_online" else "warning"
    title = f"Agent {'çevrimiçi' if event_type == 'agent_online' else 'çevrimdışı'}: {agent.name}"
    ev = NetworkEvent(
        event_type=event_type,
        severity=severity,
        title=title,
        message=f"Agent {agent.id} ({agent.machine_hostname or agent.last_ip or '?'}) {title.lower()}",
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
    current_user: CurrentUser = None,  # now requires auth
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
async def download_agent_script(_: CurrentUser = None):
    """Return the raw agent Python script (requires authentication)."""
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
        import asyncio
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
                })
                agent.platform = msg.get("platform")
                agent.machine_hostname = msg.get("hostname")
                agent.version = msg.get("version")
                await db.commit()

            elif msg.get("type") == "heartbeat":
                agent.last_heartbeat = datetime.now(timezone.utc)
                await db.commit()

            await agent_manager.handle_message(agent_id, raw)

    except WebSocketDisconnect:
        pass
    finally:
        await agent_manager.disconnect(agent_id)
        agent.status = "offline"
        agent.last_disconnected_at = datetime.now(timezone.utc)
        await db.commit()

        # Emit offline event
        await _emit_agent_event(db, agent, "agent_offline")
        await db.commit()


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
            INSTALL_DIR="$HOME/.netmanager-agent"
            RUN_AS_ROOT=0
        else
            INSTALL_DIR="/opt/netmanager-agent"
            RUN_AS_ROOT=1
            if [ "$EUID" -ne 0 ]; then
                echo "Linux: Lütfen root olarak çalıştırın: sudo bash $(basename "$0")"
                exit 1
            fi
        fi

        echo "[1/5] Python kontrol ediliyor..."
        if ! command -v python3 &>/dev/null; then
            if [ "$OS_TYPE" = "Darwin" ]; then
                command -v brew &>/dev/null && brew install python3 || {{
                    echo "Python3 bulunamadı."; exit 1
                }}
            elif command -v apt-get &>/dev/null; then
                apt-get install -y python3 python3-pip curl
            elif command -v yum &>/dev/null; then
                yum install -y python3 python3-pip curl
            else
                echo "Python3 bulunamadı. Lütfen manuel kurun."; exit 1
            fi
        fi
        PYTHON="$(which python3)"

        echo "[2/5] Kurulum dizini hazırlanıyor..."
        mkdir -p "$INSTALL_DIR"

        echo "[3/5] Agent betiği indiriliyor..."
        TOKEN=$(cat "$INSTALL_DIR/.last_token" 2>/dev/null || true)
        curl -fsSL -H "Authorization: Bearer $TOKEN" "$BACKEND_URL/api/v1/agents/download/script" -o "$INSTALL_DIR/netmanager_agent.py" || \
          curl -fsSL "$BACKEND_URL/api/v1/agents/download/script" -o "$INSTALL_DIR/netmanager_agent.py"

        echo "[4/5] Bağımlılıklar kuruluyor..."
        $PYTHON -m pip install --quiet --upgrade websockets netmiko 2>/dev/null || \
            $PYTHON -m pip install --quiet --upgrade --break-system-packages websockets netmiko 2>/dev/null || \
            $PYTHON -m pip install --quiet --upgrade --user websockets netmiko

        ENV_FILE="$INSTALL_DIR/agent.env"
        cat > "$ENV_FILE" <<ENVEOF
NETMANAGER_URL={backend_url}
NETMANAGER_AGENT_ID={agent_id}
NETMANAGER_AGENT_KEY={agent_key}
ENVEOF
        chmod 600 "$ENV_FILE"

        echo "[5/5] Servis kuruluyor..."
        if [ "$OS_TYPE" = "Darwin" ]; then
            PLIST_PATH="$HOME/Library/LaunchAgents/com.netmanager.agent.plist"
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
            launchctl unload "$PLIST_PATH" 2>/dev/null || true
            launchctl load -w "$PLIST_PATH"
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
RestartSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF
            systemctl daemon-reload
            systemctl enable $SERVICE_NAME
            systemctl restart $SERVICE_NAME
            echo "✓ NetManager Agent kuruldu! (Linux systemd)"
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
