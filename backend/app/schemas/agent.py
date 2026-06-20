from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel


class AgentCreate(BaseModel):
    name: str
    # Faz 7 — the location this agent is bound to. Must belong to the
    # creator's organization. Omitted ⇒ the creator's active location.
    location_id: Optional[int] = None


class AgentResponse(BaseModel):
    id: str
    name: str
    status: str
    last_heartbeat: Optional[datetime]
    last_ip: Optional[str]
    platform: Optional[str]
    machine_hostname: Optional[str]
    version: Optional[str]
    is_active: bool
    created_at: datetime

    # Security fields
    command_mode: str = "all"
    allowed_commands: List[str] = []
    allowed_ips: str = ""
    failed_auth_count: int = 0
    key_last_rotated: Optional[datetime] = None

    # Connection stats
    last_connected_at: Optional[datetime] = None
    last_disconnected_at: Optional[datetime] = None
    total_connections: int = 0

    # DEVICE-CREATE-LOCATION-SCOPE-FIX (2026-06-19) — additive expose of the
    # agent's tenant scope so the /devices Cihaz Ekle form can filter the
    # primary-agent + fallback-agent dropdowns down to agents that match
    # the operator-selected location's organization_id + location_id BEFORE
    # the request leaves the browser. Backend cross-tenant guards in
    # devices.py (PR #102) remain the authoritative gate; this field is
    # for client-side preview only. No secret/auth/key fields are exposed.
    organization_id: Optional[int] = None
    location_id: Optional[int] = None

    model_config = {"from_attributes": True}


class AgentCreateResponse(AgentResponse):
    agent_key: str = ""  # only returned on creation, never again
