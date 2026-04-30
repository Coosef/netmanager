from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class DriverTemplateCreate(BaseModel):
    os_type: str
    os_version_pattern: Optional[str] = None
    command_type: str
    command_string: str
    parser_type: str = "regex"
    parser_template: Optional[str] = None
    sample_output: Optional[str] = None
    is_verified: bool = True
    is_active: bool = True
    priority: int = 100
    notes: Optional[str] = None


class DriverTemplateUpdate(BaseModel):
    os_type: Optional[str] = None
    os_version_pattern: Optional[str] = None
    command_type: Optional[str] = None
    command_string: Optional[str] = None
    parser_type: Optional[str] = None
    parser_template: Optional[str] = None
    sample_output: Optional[str] = None
    is_verified: Optional[bool] = None
    is_active: Optional[bool] = None
    priority: Optional[int] = None
    notes: Optional[str] = None


class DriverTemplateResponse(BaseModel):
    id: int
    os_type: str
    os_version_pattern: Optional[str]
    command_type: str
    command_string: str
    parser_type: str
    parser_template: Optional[str]
    sample_output: Optional[str]
    is_verified: bool
    is_active: bool
    priority: int = 100
    success_count: int = 0
    failure_count: int = 0
    last_success_at: Optional[datetime] = None
    last_failure_at: Optional[datetime] = None
    success_rate: Optional[float] = None
    health_status: str = "unknown"
    notes: Optional[str]
    created_by: Optional[int]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TemplateHealthSummary(BaseModel):
    template_id: int
    os_type: str
    command_type: str
    health_status: str
    success_rate: Optional[float]
    success_count: int
    failure_count: int
    last_failure_at: Optional[datetime]
    notes: Optional[str]


class ResolveRequest(BaseModel):
    os_type: str
    command_type: str
    firmware_version: Optional[str] = None


class ResolveResponse(BaseModel):
    found: bool
    template: Optional[DriverTemplateResponse] = None
    source: str = "db"  # "db" | "ntc_templates" | "none"


class AISuggestRequest(BaseModel):
    os_type: str
    command_type: str
    raw_output: str
    firmware_version: Optional[str] = None


class AISuggestResponse(BaseModel):
    command_string: str
    parser_type: str
    parser_template: Optional[str]
    parsed_result: Any
    explanation: str


class TestParseRequest(BaseModel):
    parser_type: str
    parser_template: Optional[str]
    raw_output: str


class TestParseResponse(BaseModel):
    success: bool
    parsed_result: Any
    error: Optional[str] = None


class ProbeDeviceResponse(BaseModel):
    device_id: int
    detected_vendor: Optional[str]
    detected_model: Optional[str]
    detected_firmware: Optional[str]
    detected_os_type: Optional[str]
    templates_created: int
    templates_skipped: int
    firmware_changed: bool = False
    details: list
