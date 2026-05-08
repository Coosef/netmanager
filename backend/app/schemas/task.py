from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel


class TaskCreate(BaseModel):
    name: str
    type: str
    device_ids: list[int]
    parameters: Optional[dict[str, Any]] = None


class TaskResponse(BaseModel):
    id: int
    celery_task_id: Optional[str]
    name: str
    type: str
    status: str
    device_ids: Optional[list]
    parameters: Optional[dict]
    result: Optional[dict]
    error: Optional[str]
    total_devices: int
    completed_devices: int
    failed_devices: int
    created_by: int
    created_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]

    model_config = {"from_attributes": True}


class TaskProgress(BaseModel):
    task_id: int
    status: str
    total: int
    completed: int
    failed: int
    percent: float


class BulkPasswordChangeParams(BaseModel):
    new_username: Optional[str] = None
    new_password: str
    privilege_level: Optional[int] = 15


class BulkCommandParams(BaseModel):
    commands: list[str]
    is_config: bool = False


class ConfigBackupResponse(BaseModel):
    id: int
    device_id: int
    config_hash: str
    size_bytes: int
    notes: Optional[str]
    created_by: Optional[int]
    created_at: datetime
    is_golden: bool = False
    golden_set_at: Optional[datetime] = None

    model_config = {"from_attributes": True}
