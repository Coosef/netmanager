from datetime import datetime
from typing import Optional
from pydantic import BaseModel, model_validator


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
    snmp_community_set: bool = False
    snmp_version: str
    snmp_port: int
    snmp_v3_username: Optional[str]
    snmp_v3_auth_protocol: Optional[str]
    snmp_v3_priv_protocol: Optional[str]
    group_id: Optional[int]
    credential_profile_id: Optional[int]
    created_at: datetime
    updated_at: datetime
    availability_24h:  Optional[float] = None
    availability_7d:   Optional[float] = None
    mtbf_hours:        Optional[float] = None
    experience_score:  Optional[float] = None

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def _mask_snmp_community(cls, data):
        if isinstance(data, dict):
            community = data.pop("snmp_community", None)
            data.setdefault("snmp_community_set", bool(community))
            return data
        # ORM object — extract fields manually
        fields = [
            "id", "hostname", "ip_address", "device_type", "vendor", "os_type",
            "model", "serial_number", "firmware_version", "location", "description",
            "tags", "alias", "layer", "site", "building", "floor",
            "ssh_username", "ssh_port", "agent_id", "fallback_agent_ids",
            "status", "last_seen", "last_backup", "is_active", "is_readonly",
            "approval_required", "snmp_enabled", "snmp_version", "snmp_port",
            "snmp_v3_username", "snmp_v3_auth_protocol", "snmp_v3_priv_protocol",
            "group_id", "credential_profile_id", "created_at", "updated_at",
            "availability_24h", "availability_7d", "mtbf_hours", "experience_score",
        ]
        result = {f: getattr(data, f, None) for f in fields}
        result["snmp_community_set"] = bool(getattr(data, "snmp_community", None))
        return result


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
