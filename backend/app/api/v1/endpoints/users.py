from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, require_roles
from app.core.security import hash_password, verify_password
from app.models.location import Location
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.models.user_location import UserLocation
from app.schemas.user import AdminPasswordReset, UserCreate, UserPasswordChange, UserResponse, UserUpdate
from app.services.audit_service import log_action

router = APIRouter()

AdminRequired = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN))


def _is_platform_admin(user: User) -> bool:
    """True for SUPER_ADMIN or ADMIN with no tenant — both have unrestricted access."""
    return user.role == UserRole.SUPER_ADMIN or (user.role == UserRole.ADMIN and not user.tenant_id)


async def _with_tenant_name(db, user: User) -> dict:
    tenant_name = None
    if user.tenant_id:
        t = (await db.execute(select(Tenant).where(Tenant.id == user.tenant_id))).scalar_one_or_none()
        if t:
            tenant_name = t.name

    # Load location assignments
    loc_rows = (await db.execute(
        select(UserLocation, Location)
        .join(Location, Location.id == UserLocation.location_id)
        .where(UserLocation.user_id == user.id)
        .order_by(Location.name)
    )).all()
    locations = [
        {"location_id": ul.location_id, "location_name": loc.name, "loc_role": ul.loc_role}
        for ul, loc in loc_rows
    ]

    return {
        **UserResponse.model_validate(user).model_dump(),
        "tenant_name": tenant_name,
        "locations": locations,
    }


@router.get("/", response_model=list[UserResponse])
async def list_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
    skip: int = 0,
    limit: int = 100,
):
    q = select(User)
    # SUPER_ADMIN and tenant-less ADMIN are platform admins — see all users
    if not (current_user.role == UserRole.SUPER_ADMIN or
            (current_user.role == UserRole.ADMIN and not current_user.tenant_id)):
        q = q.where(User.tenant_id == current_user.tenant_id)
    result = await db.execute(q.offset(skip).limit(limit))
    users = result.scalars().all()
    return [await _with_tenant_name(db, u) for u in users]


@router.post("/", response_model=UserResponse, status_code=201)
async def create_user(
    payload: UserCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)),
):
    if _is_platform_admin(current_user):
        # SA or tenant-less ADMIN: can create anyone, pick tenant from payload
        tenant_id = payload.tenant_id
    else:
        # Tenant-scoped ADMIN: cannot create ADMIN/SA and always creates in own tenant
        if payload.role in (UserRole.SUPER_ADMIN, UserRole.ADMIN):
            raise HTTPException(status_code=403, detail="ADMIN cannot create ADMIN or SUPER_ADMIN users")
        tenant_id = current_user.tenant_id

    # SaaS quota: check tenant user limit
    if tenant_id:
        tenant = (await db.execute(select(Tenant).where(Tenant.id == tenant_id))).scalar_one_or_none()
        if tenant:
            current_count = (await db.execute(
                select(func.count()).select_from(User)
                .where(User.tenant_id == tenant_id, User.is_active == True)
            )).scalar() or 0
            if current_count >= tenant.max_users:
                raise HTTPException(
                    status_code=403,
                    detail=f"Kullanıcı limiti doldu ({current_count}/{tenant.max_users}). Plan yükseltmeniz gerekiyor.",
                )

    existing = await db.execute(select(User).where(User.username == payload.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username already exists")

    user = User(
        username=payload.username,
        email=payload.email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
        role=payload.role,
        notes=payload.notes,
        tenant_id=tenant_id,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    await log_action(db, current_user, "user_created", "user", user.id, user.username, request=request)
    return await _with_tenant_name(db, user)


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
):
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.tenant_id == current_user.tenant_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return await _with_tenant_name(db, user)


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    payload: UserUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)),
):
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.tenant_id == current_user.tenant_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    data = payload.model_dump(exclude_unset=True)

    if current_user.role == UserRole.ADMIN and current_user.tenant_id:
        # Tenant-scoped admin: cannot change tenant or escalate to SA
        data.pop("tenant_id", None)
        if data.get("role") == UserRole.SUPER_ADMIN:
            raise HTTPException(status_code=403, detail="Cannot elevate to SUPER_ADMIN")

    for field, value in data.items():
        setattr(user, field, value)

    await db.commit()
    await db.refresh(user)
    await log_action(db, current_user, "user_updated", "user", user_id, user.username, request=request)
    return await _with_tenant_name(db, user)


@router.delete("/{user_id}", status_code=204)
async def delete_user(
    user_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)),
):
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.tenant_id == current_user.tenant_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")
    # Tenant-scoped ADMIN cannot delete ADMIN or SA users
    if current_user.role == UserRole.ADMIN and current_user.tenant_id and user.role in (UserRole.SUPER_ADMIN, UserRole.ADMIN):
        raise HTTPException(status_code=403, detail="ADMIN cannot delete ADMIN or SUPER_ADMIN users")

    await db.execute(delete(UserLocation).where(UserLocation.user_id == user.id))
    await db.delete(user)
    await db.commit()
    await log_action(db, current_user, "user_deleted", "user", user_id, user.username, request=request)


@router.post("/{user_id}/reset-password", status_code=204)
async def admin_reset_password(
    user_id: int,
    payload: AdminPasswordReset,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)),
):
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.tenant_id == current_user.tenant_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if current_user.role == UserRole.ADMIN and current_user.tenant_id and user.role == UserRole.SUPER_ADMIN:
        raise HTTPException(status_code=403, detail="Cannot reset SUPER_ADMIN password")

    user.hashed_password = hash_password(payload.new_password)
    await db.commit()
    await log_action(db, current_user, "password_reset", "user", user_id, user.username, request=request)


@router.post("/me/change-password", status_code=204)
async def change_my_password(
    payload: UserPasswordChange,
    request: Request,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    user = (await db.execute(select(User).where(User.id == current_user.id))).scalar_one()

    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Mevcut şifre hatalı")

    user.hashed_password = hash_password(payload.new_password)
    await db.commit()
    await log_action(db, user, "password_changed", "user", user.id, request=request)


# ── User location assignments (viewed from user side) ────────────────────────

@router.get("/{user_id}/locations", response_model=list[dict])
async def get_user_locations(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
):
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.tenant_id == current_user.tenant_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    rows = (await db.execute(
        select(UserLocation, Location)
        .join(Location, Location.id == UserLocation.location_id)
        .where(UserLocation.user_id == user_id)
        .order_by(Location.name)
    )).all()

    return [
        {
            "location_id": ul.location_id,
            "location_name": loc.name,
            "loc_role": ul.loc_role,
            "assigned_at": ul.assigned_at.isoformat(),
        }
        for ul, loc in rows
    ]


@router.put("/{user_id}/locations", response_model=dict)
async def set_user_locations(
    user_id: int,
    payload: list[dict],  # [{"location_id": 1, "loc_role": "location_manager"}, ...]
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminRequired,
):
    """Replace all location assignments for a user at once."""
    q = select(User).where(User.id == user_id)
    if not _is_platform_admin(current_user):
        q = q.where(User.tenant_id == current_user.tenant_id)
    user = (await db.execute(q)).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Delete all existing assignments
    await db.execute(delete(UserLocation).where(UserLocation.user_id == user_id))

    # Collect valid location IDs scoped to the caller's tenant (platform admins unrestricted)
    if not _is_platform_admin(current_user) and current_user.tenant_id:
        allowed_locs = set(
            (await db.execute(
                select(Location.id).where(Location.tenant_id == current_user.tenant_id)
            )).scalars().all()
        )
    else:
        allowed_locs = None  # platform admin / SA: no restriction

    valid_loc_roles = {"location_manager", "location_operator", "location_viewer"}
    for item in payload:
        loc_id = item.get("location_id")
        loc_role = item.get("loc_role", "location_viewer")
        if not loc_id:
            continue
        if loc_role not in valid_loc_roles:
            continue
        if allowed_locs is not None and loc_id not in allowed_locs:
            continue  # silently skip locations from other tenants
        ul = UserLocation(
            user_id=user_id,
            location_id=loc_id,
            loc_role=loc_role,
            assigned_by=current_user.id,
        )
        db.add(ul)

    await db.commit()
    await log_action(db, current_user, "user_locations_updated", "user", user_id, user.username, request=request)
    return {"success": True, "count": len(payload)}
