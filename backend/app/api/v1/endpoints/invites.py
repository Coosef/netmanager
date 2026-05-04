import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, require_roles
from app.core.security import hash_password
from app.models.invite_token import InviteToken
from app.models.user import User, UserRole
from app.services.audit_service import log_action

router = APIRouter()

AdminRequired = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN))


class InviteCreate(BaseModel):
    email: str
    role: str = "viewer"
    expires_hours: int = 72


class InviteAccept(BaseModel):
    token: str
    username: str
    password: str
    full_name: str = ""


@router.post("/", status_code=201)
async def create_invite(
    payload: InviteCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
):
    """Generate an invite token. Returns the token (admin copies the link)."""
    # Admins can only invite into their own tenant; super_admin can invite without a tenant
    tenant_id = current_user.tenant_id if current_user.role != UserRole.SUPER_ADMIN else None

    token = secrets.token_urlsafe(48)
    invite = InviteToken(
        token=token,
        email=payload.email,
        role=payload.role,
        tenant_id=tenant_id,
        created_by=current_user.id,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=payload.expires_hours),
    )
    db.add(invite)
    await db.commit()
    await db.refresh(invite)
    await log_action(db, current_user, "invite_created", "invite_token", invite.id, payload.email, request=request)
    return {
        "id": invite.id,
        "token": token,
        "email": invite.email,
        "role": invite.role,
        "expires_at": invite.expires_at.isoformat(),
    }


@router.get("/")
async def list_invites(
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
):
    q = select(InviteToken).order_by(InviteToken.created_at.desc())
    if current_user.role != UserRole.SUPER_ADMIN:
        q = q.where(InviteToken.tenant_id == current_user.tenant_id)
    rows = (await db.execute(q)).scalars().all()
    return [
        {
            "id": r.id,
            "email": r.email,
            "role": r.role,
            "expires_at": r.expires_at.isoformat(),
            "used_at": r.used_at.isoformat() if r.used_at else None,
            "is_expired": r.expires_at < datetime.now(timezone.utc),
            "is_used": r.used_at is not None,
        }
        for r in rows
    ]


@router.delete("/{invite_id}", status_code=204)
async def revoke_invite(
    invite_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
):
    invite = (await db.execute(select(InviteToken).where(InviteToken.id == invite_id))).scalar_one_or_none()
    if not invite:
        raise HTTPException(status_code=404, detail="Invite not found")
    if current_user.role != UserRole.SUPER_ADMIN and invite.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Access denied")
    await db.delete(invite)
    await db.commit()


@router.get("/check/{token}")
async def check_invite(
    token: str,
    db: AsyncSession = Depends(get_db),
):
    """Public endpoint — validate a token before showing the registration form."""
    invite = (await db.execute(select(InviteToken).where(InviteToken.token == token))).scalar_one_or_none()
    if not invite:
        raise HTTPException(status_code=404, detail="Geçersiz davet linki")
    if invite.used_at:
        raise HTTPException(status_code=410, detail="Bu davet daha önce kullanılmış")
    if invite.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Davet linki süresi dolmuş")
    return {"email": invite.email, "role": invite.role}


@router.post("/accept")
async def accept_invite(
    payload: InviteAccept,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Public endpoint — consume the token and create a new user account."""
    invite = (await db.execute(select(InviteToken).where(InviteToken.token == payload.token))).scalar_one_or_none()
    if not invite:
        raise HTTPException(status_code=404, detail="Geçersiz davet linki")
    if invite.used_at:
        raise HTTPException(status_code=410, detail="Bu davet daha önce kullanılmış")
    if invite.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Davet linki süresi dolmuş")

    existing = (await db.execute(select(User).where(User.username == payload.username))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="Bu kullanıcı adı zaten kullanılıyor")

    user = User(
        username=payload.username,
        email=invite.email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name or payload.username,
        role=invite.role,
        tenant_id=invite.tenant_id,
    )
    db.add(user)
    await db.flush()

    invite.used_at = datetime.now(timezone.utc)
    invite.used_by_user_id = user.id
    await db.commit()
    await db.refresh(user)
    await log_action(db, user, "invite_accepted", "user", user.id, user.username, request=request)
    return {"id": user.id, "username": user.username, "email": user.email, "role": user.role}
