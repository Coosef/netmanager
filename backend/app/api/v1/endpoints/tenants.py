from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, require_roles
from app.models.device import Device
from app.models.tenant import Tenant
from app.models.user import User, UserRole
from app.schemas.tenant import TenantCreate, TenantResponse, TenantUpdate
from app.services.audit_service import log_action

router = APIRouter()

SuperAdminRequired = Depends(require_roles(UserRole.SUPER_ADMIN))


async def _enrich(db: AsyncSession, tenant: Tenant) -> dict:
    from app.models.location import Location
    dev_cnt = (await db.execute(
        select(func.count()).where(Device.tenant_id == tenant.id)
    )).scalar() or 0
    usr_cnt = (await db.execute(
        select(func.count()).where(User.tenant_id == tenant.id)
    )).scalar() or 0
    loc_cnt = (await db.execute(
        select(func.count()).where(Location.tenant_id == tenant.id)
    )).scalar() or 0
    return {
        **{c.name: getattr(tenant, c.name) for c in tenant.__table__.columns},
        "device_count": dev_cnt,
        "user_count": usr_cnt,
        "location_count": loc_cnt,
    }


@router.get("/", response_model=list[TenantResponse])
async def list_tenants(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)),
):
    if current_user.role == UserRole.SUPER_ADMIN:
        tenants = (await db.execute(select(Tenant).order_by(Tenant.name))).scalars().all()
    else:
        tenants = (await db.execute(
            select(Tenant).where(Tenant.id == current_user.tenant_id)
        )).scalars().all()

    return [await _enrich(db, t) for t in tenants]


@router.post("/", response_model=TenantResponse, status_code=201)
async def create_tenant(
    payload: TenantCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User = SuperAdminRequired,
    current_user: CurrentUser = None,
):
    existing = (await db.execute(
        select(Tenant).where(Tenant.slug == payload.slug)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=400, detail="Slug already in use")

    tenant = Tenant(**payload.model_dump())
    db.add(tenant)
    await db.commit()
    await db.refresh(tenant)
    await log_action(db, current_user, "tenant_created", "tenant", tenant.id, tenant.name, request=request)
    return await _enrich(db, tenant)


@router.get("/{tenant_id}", response_model=TenantResponse)
async def get_tenant(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)),
):
    if current_user.role != UserRole.SUPER_ADMIN and current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Access denied")

    tenant = (await db.execute(select(Tenant).where(Tenant.id == tenant_id))).scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    return await _enrich(db, tenant)


@router.patch("/{tenant_id}", response_model=TenantResponse)
async def update_tenant(
    tenant_id: int,
    payload: TenantUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User = SuperAdminRequired,
    current_user: CurrentUser = None,
):
    tenant = (await db.execute(select(Tenant).where(Tenant.id == tenant_id))).scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(tenant, field, value)

    await db.commit()
    await db.refresh(tenant)
    await log_action(db, current_user, "tenant_updated", "tenant", tenant_id, tenant.name, request=request)
    return await _enrich(db, tenant)


@router.delete("/{tenant_id}", status_code=204)
async def delete_tenant(
    tenant_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User = SuperAdminRequired,
    current_user: CurrentUser = None,
):
    tenant = (await db.execute(select(Tenant).where(Tenant.id == tenant_id))).scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    dev_cnt = (await db.execute(
        select(func.count()).where(Device.tenant_id == tenant_id)
    )).scalar() or 0
    if dev_cnt > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Tenant has {dev_cnt} device(s). Reassign or delete them first.",
        )

    usr_cnt = (await db.execute(
        select(func.count()).where(User.tenant_id == tenant_id)
    )).scalar() or 0
    if usr_cnt > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Tenant has {usr_cnt} user(s). Reassign or delete them first.",
        )

    await db.delete(tenant)
    await db.commit()
    await log_action(db, current_user, "tenant_deleted", "tenant", tenant_id, tenant.name, request=request)


@router.get("/{tenant_id}/users", response_model=list[dict])
async def list_tenant_users(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)),
):
    if current_user.role != UserRole.SUPER_ADMIN and current_user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Access denied")

    users = (await db.execute(
        select(User).where(User.tenant_id == tenant_id).order_by(User.username)
    )).scalars().all()

    return [
        {
            "id": u.id, "username": u.username, "email": u.email,
            "full_name": u.full_name, "role": u.role, "is_active": u.is_active,
        }
        for u in users
    ]


@router.post("/{tenant_id}/assign-user/{user_id}", response_model=dict)
async def assign_user_to_tenant(
    tenant_id: int,
    user_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    _: User = SuperAdminRequired,
    current_user: CurrentUser = None,
):
    tenant = (await db.execute(select(Tenant).where(Tenant.id == tenant_id))).scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.tenant_id = tenant_id
    await db.commit()
    await log_action(
        db, current_user, "user_assigned_to_tenant", "tenant", tenant_id, tenant.name,
        details={"user_id": user_id, "username": user.username},
        request=request,
    )
    return {"success": True, "user_id": user_id, "tenant_id": tenant_id}
