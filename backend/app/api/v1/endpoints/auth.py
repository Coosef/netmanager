import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.core.security import create_access_token, hash_password, verify_password
from app.models.invite_token import InviteToken
from app.models.user import User, SystemRole
from app.schemas.auth import (
    InviteAcceptRequest,
    LoginRequest,
    TokenResponse,
)
from app.schemas.user import UserResponse
from app.services.audit_service import log_action

router = APIRouter()


async def _build_token_response(db: AsyncSession, user: User) -> TokenResponse:
    """Build a TokenResponse enriched with the user's full permission set."""
    from app.services.rbac.engine import permission_engine
    permissions = await permission_engine.get_permissions(db, user)
    return TokenResponse(
        access_token=create_access_token({"sub": str(user.id)}),
        user_id=user.id,
        username=user.username,
        role=user.role,
        system_role=user.system_role,
        tenant_id=user.tenant_id,
        org_id=user.org_id,
        permissions=permissions,
    )


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
    await db.refresh(user)

    token_resp = await _build_token_response(db, user)
    await log_action(db, user, "login", request=request)
    return token_resp


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: CurrentUser):
    return current_user


@router.get("/me/permissions")
async def get_my_permissions(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Return the current user's full permissions dict (used by frontend sidebar)."""
    from app.services.rbac.engine import permission_engine
    permissions = await permission_engine.get_permissions(db, current_user)
    return {"permissions": permissions, "system_role": current_user.system_role}


@router.post("/invite/accept", response_model=TokenResponse)
async def accept_invite(
    payload: InviteAcceptRequest,
    db: AsyncSession = Depends(get_db),
):
    """Accept an invite token and create a new user account."""
    result = await db.execute(
        select(InviteToken).where(
            InviteToken.token == payload.token,
            InviteToken.used_at.is_(None),
            InviteToken.expires_at > datetime.now(timezone.utc),
        )
    )
    invite = result.scalar_one_or_none()
    if invite is None:
        raise HTTPException(status_code=400, detail="Geçersiz veya süresi dolmuş davet linki")

    # Check username uniqueness
    existing = await db.execute(
        select(User).where(User.username == payload.username)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Bu kullanıcı adı zaten kullanılıyor")

    # Check email uniqueness
    existing_email = await db.execute(
        select(User).where(User.email == invite.email)
    )
    if existing_email.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Bu e-posta adresi zaten kayıtlı")

    user = User(
        username=payload.username,
        email=invite.email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name or invite.full_name,
        is_active=True,
        # Legacy compat
        role="viewer",
        tenant_id=invite.tenant_id,
        # New RBAC
        system_role=invite.system_role,
        org_id=invite.org_id,
    )
    db.add(user)
    await db.flush()  # get user.id

    # Assign permission set if specified in invite
    if invite.permission_set_id and invite.org_id:
        from app.models.shared.user_location_perm import UserLocationPerm
        ulp = UserLocationPerm(
            user_id=user.id,
            location_id=None,  # org-wide default
            permission_set_id=invite.permission_set_id,
            assigned_by=invite.created_by,
        )
        db.add(ulp)

    # Mark invite as used
    invite.used_at = datetime.now(timezone.utc)
    invite.used_by_user_id = user.id
    db.add(invite)

    await db.commit()
    await db.refresh(user)

    return await _build_token_response(db, user)
