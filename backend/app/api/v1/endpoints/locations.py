"""Location (site) management endpoints."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, require_roles
from app.models.device import Device
from app.models.location import Location
from app.models.user import User, UserRole
from app.models.user_location import UserLocation

router = APIRouter()

AdminOrAbove = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN))


class LocationCreate(BaseModel):
    name: str
    description: Optional[str] = None
    address: Optional[str] = None
    color: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    timezone: Optional[str] = None
    tenant_id: Optional[int] = None


class LocationUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    address: Optional[str] = None
    color: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    timezone: Optional[str] = None


class UserLocationAssign(BaseModel):
    user_id: int
    loc_role: str = "location_viewer"  # location_manager | location_operator | location_viewer


def _serialize(loc: Location, device_count: int = 0, user_count: int = 0) -> dict:
    return {
        "id": loc.id,
        "name": loc.name,
        "description": loc.description,
        "address": loc.address,
        "color": loc.color,
        "city": loc.city,
        "country": loc.country,
        "timezone": loc.timezone,
        "tenant_id": loc.tenant_id,
        "device_count": device_count,
        "user_count": user_count,
        "created_at": loc.created_at.isoformat(),
    }


@router.get("/", response_model=dict)
async def list_locations(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    search: str = Query(None),
    tenant_id: Optional[int] = Query(None),
):
    query = select(Location)

    if current_user.role == UserRole.SUPER_ADMIN:
        if tenant_id:
            query = query.where(Location.tenant_id == tenant_id)
    elif current_user.role in (UserRole.ADMIN, UserRole.ORG_VIEWER):
        query = query.where(Location.tenant_id == current_user.tenant_id)
    else:
        # location-scoped roles: only show assigned locations
        assigned = (await db.execute(
            select(UserLocation.location_id).where(UserLocation.user_id == current_user.id)
        )).scalars().all()
        query = query.where(Location.id.in_(assigned))

    if search:
        query = query.where(Location.name.ilike(f"%{search}%"))

    locs = (await db.execute(query.order_by(Location.name))).scalars().all()

    count_rows = (await db.execute(
        select(Device.site, func.count().label("cnt"))
        .where(Device.is_active == True, Device.site.isnot(None))
        .group_by(Device.site)
    )).all()
    count_map = {row[0]: row[1] for row in count_rows}

    user_count_rows = (await db.execute(
        select(UserLocation.location_id, func.count().label("cnt"))
        .group_by(UserLocation.location_id)
    )).all()
    user_count_map = {row[0]: row[1] for row in user_count_rows}

    return {
        "items": [_serialize(loc, count_map.get(loc.name, 0), user_count_map.get(loc.id, 0)) for loc in locs],
        "total": len(locs),
    }


@router.post("/", response_model=dict, status_code=201)
async def create_location(
    payload: LocationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminOrAbove,
):
    existing = (await db.execute(
        select(Location).where(Location.name == payload.name)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Bu isimde bir lokasyon zaten var")

    tenant_id = payload.tenant_id
    if current_user.role == UserRole.ADMIN:
        tenant_id = current_user.tenant_id

    loc = Location(
        name=payload.name,
        description=payload.description,
        address=payload.address,
        color=payload.color,
        city=payload.city,
        country=payload.country,
        timezone=payload.timezone,
        tenant_id=tenant_id,
    )
    db.add(loc)
    await db.commit()
    await db.refresh(loc)
    return _serialize(loc)


@router.get("/{location_id}", response_model=dict)
async def get_location(
    location_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    loc = (await db.execute(
        select(Location).where(Location.id == location_id)
    )).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Lokasyon bulunamadı")

    if current_user.role not in (UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.ORG_VIEWER):
        assigned = (await db.execute(
            select(UserLocation).where(
                UserLocation.user_id == current_user.id,
                UserLocation.location_id == location_id,
            )
        )).scalar_one_or_none()
        if not assigned:
            raise HTTPException(status_code=403, detail="Bu lokasyona erişim yetkiniz yok")

    count = (await db.execute(
        select(func.count()).select_from(Device)
        .where(Device.is_active == True, Device.site == loc.name)
    )).scalar() or 0
    user_cnt = (await db.execute(
        select(func.count()).where(UserLocation.location_id == location_id)
    )).scalar() or 0
    return _serialize(loc, count, user_cnt)


@router.patch("/{location_id}", response_model=dict)
async def update_location(
    location_id: int,
    payload: LocationUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminOrAbove,
):
    loc = (await db.execute(
        select(Location).where(Location.id == location_id)
    )).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Lokasyon bulunamadı")

    if current_user.role == UserRole.ADMIN and loc.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Bu lokasyona erişim yetkiniz yok")

    old_name = loc.name
    if payload.name is not None and payload.name != old_name:
        conflict = (await db.execute(
            select(Location).where(Location.name == payload.name)
        )).scalar_one_or_none()
        if conflict:
            raise HTTPException(status_code=409, detail="Bu isimde bir lokasyon zaten var")
        await db.execute(
            update(Device).where(Device.site == old_name).values(site=payload.name)
        )
        loc.name = payload.name

    for field in ("description", "address", "color", "city", "country", "timezone"):
        val = getattr(payload, field, None)
        if val is not None:
            setattr(loc, field, val)

    await db.commit()
    await db.refresh(loc)

    count = (await db.execute(
        select(func.count()).select_from(Device)
        .where(Device.is_active == True, Device.site == loc.name)
    )).scalar() or 0
    user_cnt = (await db.execute(
        select(func.count()).where(UserLocation.location_id == location_id)
    )).scalar() or 0
    return _serialize(loc, count, user_cnt)


@router.delete("/{location_id}", status_code=204)
async def delete_location(
    location_id: int,
    unassign: bool = Query(default=True, description="Cihazların site alanını temizle"),
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminOrAbove,
):
    loc = (await db.execute(
        select(Location).where(Location.id == location_id)
    )).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Lokasyon bulunamadı")

    if current_user.role == UserRole.ADMIN and loc.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Bu lokasyona erişim yetkiniz yok")

    if unassign:
        await db.execute(
            update(Device).where(Device.site == loc.name).values(site=None)
        )

    await db.delete(loc)
    await db.commit()


# ── User-Location assignment endpoints ──────────────────────────────────────

@router.get("/{location_id}/users", response_model=list[dict])
async def list_location_users(
    location_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminOrAbove,
):
    loc = (await db.execute(
        select(Location).where(Location.id == location_id)
    )).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Lokasyon bulunamadı")

    if current_user.role == UserRole.ADMIN and loc.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Erişim reddedildi")

    rows = (await db.execute(
        select(UserLocation, User)
        .join(User, User.id == UserLocation.user_id)
        .where(UserLocation.location_id == location_id)
        .order_by(User.username)
    )).all()

    return [
        {
            "user_id": ul.user_id,
            "username": u.username,
            "full_name": u.full_name,
            "email": u.email,
            "user_role": u.role,
            "loc_role": ul.loc_role,
            "assigned_at": ul.assigned_at.isoformat(),
        }
        for ul, u in rows
    ]


@router.post("/{location_id}/users", response_model=dict, status_code=201)
async def assign_user_to_location(
    location_id: int,
    payload: UserLocationAssign,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminOrAbove,
):
    loc = (await db.execute(
        select(Location).where(Location.id == location_id)
    )).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Lokasyon bulunamadı")

    if current_user.role == UserRole.ADMIN and loc.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Erişim reddedildi")

    target_user = (await db.execute(
        select(User).where(User.id == payload.user_id)
    )).scalar_one_or_none()
    if not target_user:
        raise HTTPException(status_code=404, detail="Kullanıcı bulunamadı")

    valid_loc_roles = {"location_manager", "location_operator", "location_viewer"}
    if payload.loc_role not in valid_loc_roles:
        raise HTTPException(status_code=400, detail=f"Geçersiz lokasyon rolü: {payload.loc_role}")

    existing = (await db.execute(
        select(UserLocation).where(
            UserLocation.user_id == payload.user_id,
            UserLocation.location_id == location_id,
        )
    )).scalar_one_or_none()

    if existing:
        existing.loc_role = payload.loc_role
    else:
        ul = UserLocation(
            user_id=payload.user_id,
            location_id=location_id,
            loc_role=payload.loc_role,
            assigned_by=current_user.id,
        )
        db.add(ul)

    await db.commit()
    return {"success": True, "user_id": payload.user_id, "location_id": location_id, "loc_role": payload.loc_role}


@router.delete("/{location_id}/users/{user_id}", status_code=204)
async def remove_user_from_location(
    location_id: int,
    user_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = AdminOrAbove,
):
    loc = (await db.execute(
        select(Location).where(Location.id == location_id)
    )).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Lokasyon bulunamadı")

    if current_user.role == UserRole.ADMIN and loc.tenant_id != current_user.tenant_id:
        raise HTTPException(status_code=403, detail="Erişim reddedildi")

    await db.execute(
        delete(UserLocation).where(
            UserLocation.user_id == user_id,
            UserLocation.location_id == location_id,
        )
    )
    await db.commit()
