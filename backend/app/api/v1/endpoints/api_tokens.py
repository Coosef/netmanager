import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.api_token import ApiToken
from app.services.audit_service import log_action

router = APIRouter()

_PREFIX = "nm_"


class TokenCreateRequest(BaseModel):
    name: str
    expires_in_days: Optional[int] = None


class TokenResponse(BaseModel):
    id: int
    name: str
    prefix: str
    expires_at: Optional[datetime]
    last_used_at: Optional[datetime]
    created_at: datetime
    is_active: bool

    model_config = {"from_attributes": True}


class TokenCreateResponse(TokenResponse):
    token: str


@router.get("", response_model=list[TokenResponse])
async def list_tokens(user: CurrentUser, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ApiToken)
        .where(ApiToken.user_id == user.id, ApiToken.is_active == True)
        .order_by(ApiToken.created_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=TokenCreateResponse, status_code=201)
async def create_token(
    payload: TokenCreateRequest,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    raw = _PREFIX + secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    prefix = raw[:12]

    expires_at = None
    if payload.expires_in_days:
        expires_at = datetime.now(timezone.utc) + timedelta(days=payload.expires_in_days)

    token = ApiToken(
        user_id=user.id,
        name=payload.name,
        token_hash=token_hash,
        prefix=prefix,
        expires_at=expires_at,
    )
    db.add(token)
    await db.commit()
    await db.refresh(token)
    await log_action(
        db, user, "api_token_create",
        resource_type="api_token", resource_id=token.id, resource_name=payload.name,
    )
    return TokenCreateResponse(
        id=token.id,
        name=token.name,
        prefix=token.prefix,
        expires_at=token.expires_at,
        last_used_at=token.last_used_at,
        created_at=token.created_at,
        is_active=token.is_active,
        token=raw,
    )


@router.delete("/{token_id}", status_code=204)
async def revoke_token(
    token_id: int,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ApiToken).where(ApiToken.id == token_id, ApiToken.user_id == user.id)
    )
    token = result.scalar_one_or_none()
    if not token:
        raise HTTPException(status_code=404, detail="Token not found")
    token.is_active = False
    await db.commit()
    await log_action(
        db, user, "api_token_revoke",
        resource_type="api_token", resource_id=token_id, resource_name=token.name,
    )
