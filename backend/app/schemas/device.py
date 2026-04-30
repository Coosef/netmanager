from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class DeviceGroupCreate(BaseModel):
    name: str
    description: Optional[str] = None
    parent_id: Optional[int] = None


class DeviceGroupResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    parent_id: Optional[int]
    created_at: datetime

    model_config = {"from_attributes": True}


class DeviceCreate(BaseModel):
    hostname: str = ""
    ip_address: str
    device_type: str = "switch"
    vendor: str = "other"
    os_type: str = "cisco_ios"
    model: Optional[str] = None
    location: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[str] = None
    alias: Optional[str] = None
    layer: Optional[str] = None
    site: Optional[str] = None
    building: Optional[str] = None
    floor: Optional[str] = None
    ssh_username: str
    ssh_password: str
    ssh_port: int = 22
    enable_secret: Optional[str] = None
    group_id: Optional[int] = None
    agent_id: Optional[str] = None
    fallback_agent_ids: Optional[list] = None
    is_readonly: bool = True
    approval_required: bool = False
    snmp_enabled: bool = False
    snmp_community: Optional[str] = None
    snmp_version: str = "v2c"
    snmp_port: int = 161
    snmp_v3_username: Optional[str] = None
    snmp_v3_auth_protocol: Optional[str] = None
    snmp_v3_auth_passphrase: Optional[str] = None
    snmp_v3_priv_protocol: Optional[str] = None
    snmp_v3_priv_passphrase: Optional[str] = None
    credential_profile_id: Optional[int] = None


class DeviceUpdate(BaseModel):
    hostname: Optional[str] = None
    device_type: Optional[str] = None
    vendor: Optional[str] = None
    os_type: Optional[str] = None
    model: Optional[str] = None
    location: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[str] = None
    alias: Optional[str] = None
    layer: Optional[str] = None
    site: Optional[str] = None
    building: Optional[str] = None
    floor: Optional[str] = None
    ssh_username: Optional[str] = None
    ssh_password: Optional[str] = None
    ssh_port: Optional[int] = None
    enable_secret: Optional[str] = None
    agent_id: Optional[str] = None
    fallback_agent_ids: Optional[list] = None
    group_id: Optional[int] = None
    is_active: Optional[bool] = None
    is_readonly: Optional[bool] = None
    approval_required: Optional[bool] = None
    snmp_enabled: Optional[bool] = None
    snmp_community: Optional[str] = None
    snmp_version: Optional[str] = None
    snmp_port: Optional[int] = None
    snmp_v3_username: Optional[str] = None
    snmp_v3_auth_protocol: Optional[str] = None
    snmp_v3_auth_passphrase: Optional[str] = None
    snmp_v3_priv_protocol: Optional[str] = None
    snmp_v3_priv_passphrase: Optional[str] = None
    credential_profile_id: Optional[int] = None


class BulkUpdateAgent(BaseModel):
    device_ids: list[int]
    agent_id: Optional[str] = None


class DeviceResponse(BaseModel):
    id: int
    hostname: str
    ip_address: str
    device_type: str
    vendor: str
    os_type: str
    model: Optional[str]
    serial_number: Optional[str]
    firmware_version: Optional[str]
    location: Optional[str]
    description: Optional[str]
    tags: Optional[str]
    alias: Optional[str]
    layer: Optional[str]
    site: Optional[str]
    building: Optional[str]
    floor: Optional[str]
    ssh_username: str
    ssh_port: int
    agent_id: Optional[str]
    fallback_agent_ids: Optional[list]
    status: str
    last_seen: Optional[datetime]
    last_backup: Optional[datetime]
    is_active: bool
    is_readonly: bool
    approval_required: bool
    snmp_enabled: bool
    snmp_community: Optional[str]
    snmp_version: str
    snmp_port: int
    snmp_v3_username: Optional[str]
    snmp_v3_auth_protocol: Optional[str]
    snmp_v3_priv_protocol: Optional[str]
    group_id: Optional[int]
    credential_profile_id: Optional[int]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DeviceTestResult(BaseModel):
    device_id: int
    hostname: str
    ip_address: str
    success: bool
    message: str
    latency_ms: Optional[float] = None


class BulkUpdateCredentials(BaseModel):
    device_ids: list[int]
    source_device_id: Optional[int] = None
    ssh_username: Optional[str] = None
    ssh_password: Optional[str] = None
    enable_secret: Optional[str] = None
