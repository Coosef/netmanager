from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class TenantCreate(BaseModel):
    name: str
    slug: str
    description: Optional[str] = None
    is_active: bool = True


class TenantUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


class TenantResponse(BaseModel):
    id: int
    name: str
    slug: str
    description: Optional[str]
    is_active: bool
    created_at: datetime
    device_count: int = 0
    user_count: int = 0

    model_config = {"from_attributes": True}
