"""Password Policy endpoint — org bazlı şifre kuralı yönetimi.

T9 Tur 2 #3.

  GET   /api/v1/password-policy           — mevcut effective policy
  PUT   /api/v1/password-policy           — org policy upsert (org_admin)
  DELETE /api/v1/password-policy          — org override sil, global'a dön

  POST  /api/v1/password-policy/validate  — yeni şifre kontrolü (UI canlı feedback)
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.password_policy import PasswordPolicy
from app.services import password_policy_service as svc

router = APIRouter()


class PolicyPayload(BaseModel):
    min_length: int = 8
    require_uppercase: bool = False
    require_lowercase: bool = True
    require_digit: bool = True
    require_special: bool = False
    history_count: int = 0
    expiry_days: int = 0
    force_change_on_first_login: bool = False


class PolicyResponse(BaseModel):
    organization_id: Optional[int]
    min_length: int
    require_uppercase: bool
    require_lowercase: bool
    require_digit: bool
    require_special: bool
    history_count: int
    expiry_days: int
    force_change_on_first_login: bool
    source: str  # "org-X" | "global" | "code-default"


class ValidatePayload(BaseModel):
    password: str


class ValidateResponse(BaseModel):
    ok: bool
    errors: list[str]
    policy_source: str


@router.get("", response_model=PolicyResponse)
async def get_policy(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Mevcut effective policy döner (org-specific → global → code default)."""
    pol = await svc.get_effective_policy(db, current_user.organization_id)
    return PolicyResponse(
        organization_id=current_user.organization_id,
        min_length=pol.min_length,
        require_uppercase=pol.require_uppercase,
        require_lowercase=pol.require_lowercase,
        require_digit=pol.require_digit,
        require_special=pol.require_special,
        history_count=pol.history_count,
        expiry_days=pol.expiry_days,
        force_change_on_first_login=pol.force_change_on_first_login,
        source=pol.source,
    )


@router.put("", response_model=PolicyResponse)
async def upsert_policy(
    payload: PolicyPayload,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Org bazlı policy upsert. Yetki: super_admin / org_admin."""
    if not (current_user.is_super_admin or current_user.is_org_admin):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Yetersiz yetki")
    if current_user.organization_id is None:
        raise HTTPException(status_code=400, detail="Kullanıcının organization_id'si yok")

    # Sanity checks
    if payload.min_length < 4 or payload.min_length > 128:
        raise HTTPException(status_code=400, detail="min_length 4-128 arasında olmalı")
    if payload.history_count < 0 or payload.history_count > 24:
        raise HTTPException(status_code=400, detail="history_count 0-24 arasında olmalı")
    if payload.expiry_days < 0 or payload.expiry_days > 3650:
        raise HTTPException(status_code=400, detail="expiry_days 0-3650 arasında olmalı")

    row = (await db.execute(
        select(PasswordPolicy).where(
            PasswordPolicy.organization_id == current_user.organization_id,
        )
    )).scalar_one_or_none()

    if row is None:
        row = PasswordPolicy(organization_id=current_user.organization_id)
        db.add(row)

    row.min_length = payload.min_length
    row.require_uppercase = payload.require_uppercase
    row.require_lowercase = payload.require_lowercase
    row.require_digit = payload.require_digit
    row.require_special = payload.require_special
    row.history_count = payload.history_count
    row.expiry_days = payload.expiry_days
    row.force_change_on_first_login = payload.force_change_on_first_login
    row.updated_at = datetime.now(timezone.utc)
    row.updated_by_user_id = current_user.id

    await db.commit()
    await db.refresh(row)

    return PolicyResponse(
        organization_id=row.organization_id,
        min_length=row.min_length,
        require_uppercase=row.require_uppercase,
        require_lowercase=row.require_lowercase,
        require_digit=row.require_digit,
        require_special=row.require_special,
        history_count=row.history_count,
        expiry_days=row.expiry_days,
        force_change_on_first_login=row.force_change_on_first_login,
        source=f"org-{row.organization_id}",
    )


@router.delete("")
async def delete_org_policy(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Org özel policy'i sil, global default'a dön."""
    if not (current_user.is_super_admin or current_user.is_org_admin):
        raise HTTPException(status_code=403, detail="Yetersiz yetki")
    if current_user.organization_id is None:
        raise HTTPException(status_code=400, detail="organization_id yok")

    row = (await db.execute(
        select(PasswordPolicy).where(
            PasswordPolicy.organization_id == current_user.organization_id,
        )
    )).scalar_one_or_none()
    if row is None:
        return {"removed": False, "note": "Org özel policy yoktu."}
    await db.delete(row)
    await db.commit()
    return {"removed": True}


@router.post("/validate", response_model=ValidateResponse)
async def validate_password(
    payload: ValidatePayload,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """UI'da canlı feedback için: bir şifrenin policy'i geçip geçmediği."""
    pol = await svc.get_effective_policy(db, current_user.organization_id)
    ok, errs = svc.validate_password(payload.password, pol)
    return ValidateResponse(ok=ok, errors=errs, policy_source=pol.source)
