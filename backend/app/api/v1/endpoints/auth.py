from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.core.security import create_access_token, hash_password, verify_password
from app.models.user import User
from app.schemas.auth import LoginRequest, TokenResponse
from app.schemas.user import UserResponse
from app.services.audit_service import log_action

router = APIRouter()


@router.post("/login", response_model=TokenResponse)
async def login(
    payload: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(User).where(User.username == payload.username, User.is_active == True)
    )
    user = result.scalar_one_or_none()

    if not user or not verify_password(payload.password, user.hashed_password):
        await log_action(
            db, None, "login_failed",
            details={"username": payload.username},
            status="failure",
            request=request,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    await db.execute(
        update(User).where(User.id == user.id).values(last_login=datetime.now(timezone.utc))
    )
    await db.commit()

    token = create_access_token({"sub": str(user.id)})
    await log_action(db, user, "login", request=request)

    return TokenResponse(
        access_token=token,
        user_id=user.id,
        username=user.username,
        role=user.role,
        tenant_id=user.tenant_id,
    )


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: CurrentUser):
    return current_user
