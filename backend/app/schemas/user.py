from datetime import datetime
from typing import Optional
from pydantic import BaseModel, EmailStr


class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str
    full_name: Optional[str] = None
    role: str = "viewer"
    notes: Optional[str] = None
    tenant_id: Optional[int] = None


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    full_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    notes: Optional[str] = None
    tenant_id: Optional[int] = None


class UserPasswordChange(BaseModel):
    current_password: str
    new_password: str


class UserResponse(BaseModel):
    id: int
    username: str
    email: str
    full_name: Optional[str]
    role: str
    is_active: bool
    notes: Optional[str]
    tenant_id: Optional[int]
    tenant_name: Optional[str] = None
    last_login: Optional[datetime]
    created_at: datetime

    model_config = {"from_attributes": True}
