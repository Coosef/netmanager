"""
Internal relay endpoints — only callable from within the Docker network.
Celery workers have no WebSocket connections; they relay SSH commands here
so the FastAPI process (which holds agent WebSockets) can forward them.
"""
from dataclasses import dataclass, field
from typing import Optional

from fastapi import APIRouter, Header, HTTPException

from app.core.config import settings

router = APIRouter()


@dataclass
class _DeviceProxy:
    """Minimal device-like object built from relay payload."""
    id: int
    ip_address: str
    hostname: str = ""
    ssh_username: Optional[str] = None
    ssh_password_enc: Optional[str] = None
    ssh_port: int = 22
    os_type: str = "cisco_ios"
    enable_secret_enc: Optional[str] = None
    credential_profile_id: Optional[int] = None
    agent_id: Optional[str] = None
    fallback_agent_ids: list = field(default_factory=list)


def _check_key(key: str):
    if key != settings.SECRET_KEY:
        raise HTTPException(status_code=403, detail="Forbidden")


@router.post("/agent-relay")
async def agent_relay(body: dict, x_internal_key: str = Header(default="")):
    """Relay a single SSH command through the agent WebSocket."""
    _check_key(x_internal_key)

    agent_id = body.get("agent_id", "")
    command = body.get("command", "")

    from app.services.agent_manager import agent_manager

    if agent_id not in agent_manager._connections:
        return {"success": False, "error": f"Agent {agent_id} not connected to this process"}

    device = _DeviceProxy(
        id=body.get("device_id", 0),
        ip_address=body.get("ip_address", ""),
        hostname=body.get("hostname", ""),
        ssh_username=body.get("ssh_username"),
        ssh_password_enc=body.get("ssh_password_enc"),
        ssh_port=body.get("ssh_port") or 22,
        os_type=body.get("os_type") or "cisco_ios",
        enable_secret_enc=body.get("enable_secret_enc"),
        credential_profile_id=body.get("credential_profile_id"),
        agent_id=agent_id,
    )

    try:
        result = await agent_manager.execute_ssh_command(agent_id, device, command)
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/agent-relay-config")
async def agent_relay_config(body: dict, x_internal_key: str = Header(default="")):
    """Relay config commands through the agent WebSocket."""
    _check_key(x_internal_key)

    agent_id = body.get("agent_id", "")
    commands = body.get("commands", [])

    from app.services.agent_manager import agent_manager

    if agent_id not in agent_manager._connections:
        return {"success": False, "error": f"Agent {agent_id} not connected to this process"}

    device = _DeviceProxy(
        id=body.get("device_id", 0),
        ip_address=body.get("ip_address", ""),
        hostname=body.get("hostname", ""),
        ssh_username=body.get("ssh_username"),
        ssh_password_enc=body.get("ssh_password_enc"),
        ssh_port=body.get("ssh_port") or 22,
        os_type=body.get("os_type") or "cisco_ios",
        enable_secret_enc=body.get("enable_secret_enc"),
        credential_profile_id=body.get("credential_profile_id"),
        agent_id=agent_id,
    )

    try:
        result = await agent_manager.execute_ssh_config(agent_id, device, commands)
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}
