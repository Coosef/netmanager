from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel


class AgentCreate(BaseModel):
    name: str


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

    model_config = {"from_attributes": True}


class AgentCreateResponse(AgentResponse):
    agent_key: str = ""  # only returned on creation, never again
