from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, field_validator


class BackupScheduleCreate(BaseModel):
    name: str
    enabled: bool = True
    schedule_type: str = "daily"   # daily | weekly | interval
    run_hour: int = 2
    run_minute: int = 0
    days_of_week: Optional[List[int]] = None   # [0..6], None = every day
    interval_hours: int = 24
    device_filter: str = "all"     # all | stale | never | site
    site: Optional[str] = None

    @field_validator("schedule_type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        if v not in ("daily", "weekly", "interval"):
            raise ValueError("schedule_type must be daily, weekly or interval")
        return v

    @field_validator("device_filter")
    @classmethod
    def validate_filter(cls, v: str) -> str:
        if v not in ("all", "stale", "never", "site"):
            raise ValueError("device_filter must be all, stale, never or site")
        return v

    @field_validator("run_hour")
    @classmethod
    def validate_hour(cls, v: int) -> int:
        if not 0 <= v <= 23:
            raise ValueError("run_hour must be 0-23")
        return v

    @field_validator("run_minute")
    @classmethod
    def validate_minute(cls, v: int) -> int:
        if not 0 <= v <= 59:
            raise ValueError("run_minute must be 0-59")
        return v


class BackupScheduleUpdate(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    schedule_type: Optional[str] = None
    run_hour: Optional[int] = None
    run_minute: Optional[int] = None
    days_of_week: Optional[List[int]] = None
    interval_hours: Optional[int] = None
    device_filter: Optional[str] = None
    site: Optional[str] = None


class BackupScheduleResponse(BaseModel):
    id: int
    name: str
    enabled: bool
    schedule_type: str
    run_hour: int
    run_minute: int
    days_of_week: Optional[List[int]]
    interval_hours: int
    device_filter: str
    site: Optional[str]
    last_run_at: Optional[datetime]
    next_run_at: Optional[datetime]
    last_task_id: Optional[int]
    is_default: bool
    created_by: Optional[int]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
