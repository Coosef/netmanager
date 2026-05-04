from datetime import datetime
from typing import Optional
from pydantic import BaseModel


PLAN_TIERS = ["free", "starter", "pro", "enterprise"]


class TenantCreate(BaseModel):
    name: str
    slug: str
    description: Optional[str] = None
    is_active: bool = True
    plan_tier: str = "free"
    max_devices: int = 50
    max_users: int = 5
    contact_email: Optional[str] = None


class TenantUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None
    plan_tier: Optional[str] = None
    max_devices: Optional[int] = None
    max_users: Optional[int] = None
    contact_email: Optional[str] = None


class TenantResponse(BaseModel):
    id: int
    name: str
    slug: str
    description: Optional[str]
    is_active: bool
    plan_tier: str
    max_devices: int
    max_users: int
    contact_email: Optional[str]
    created_at: datetime
    device_count: int = 0
    user_count: int = 0
    location_count: int = 0

    model_config = {"from_attributes": True}
