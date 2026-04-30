"""Location (site) management endpoints."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.location import Location

router = APIRouter()


class LocationCreate(BaseModel):
    name: str
    description: Optional[str] = None
    address: Optional[str] = None
    color: Optional[str] = None


class LocationUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    address: Optional[str] = None
    color: Optional[str] = None


def _serialize(loc: Location, device_count: int = 0) -> dict:
    return {
        "id": loc.id,
        "name": loc.name,
        "description": loc.description,
        "address": loc.address,
        "color": loc.color,
        "device_count": device_count,
        "created_at": loc.created_at.isoformat(),
    }


@router.get("/", response_model=dict)
async def list_locations(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    search: str = Query(None),
):
    query = select(Location)
    if search:
        query = query.where(Location.name.ilike(f"%{search}%"))
    locs = (await db.execute(query.order_by(Location.name))).scalars().all()

    # Batch device counts per location name
    count_rows = (await db.execute(
        select(Device.site, func.count().label("cnt"))
        .where(Device.is_active == True, Device.site.isnot(None))
        .group_by(Device.site)
    )).all()
    count_map = {row[0]: row[1] for row in count_rows}

    return {
        "items": [_serialize(loc, count_map.get(loc.name, 0)) for loc in locs],
        "total": len(locs),
    }


@router.post("/", response_model=dict, status_code=201)
async def create_location(
    payload: LocationCreate,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    existing = (await db.execute(
        select(Location).where(Location.name == payload.name)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Bu isimde bir lokasyon zaten var")

    loc = Location(
        name=payload.name,
        description=payload.description,
        address=payload.address,
        color=payload.color,
    )
    db.add(loc)
    await db.commit()
    await db.refresh(loc)
    return _serialize(loc)


@router.patch("/{location_id}", response_model=dict)
async def update_location(
    location_id: int,
    payload: LocationUpdate,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    loc = (await db.execute(
        select(Location).where(Location.id == location_id)
    )).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Lokasyon bulunamadı")

    old_name = loc.name
    if payload.name is not None and payload.name != old_name:
        conflict = (await db.execute(
            select(Location).where(Location.name == payload.name)
        )).scalar_one_or_none()
        if conflict:
            raise HTTPException(status_code=409, detail="Bu isimde bir lokasyon zaten var")
        # Cascade rename to all devices with the old site name
        await db.execute(
            update(Device).where(Device.site == old_name).values(site=payload.name)
        )
        loc.name = payload.name

    if payload.description is not None:
        loc.description = payload.description
    if payload.address is not None:
        loc.address = payload.address
    if payload.color is not None:
        loc.color = payload.color

    await db.commit()
    await db.refresh(loc)

    count = (await db.execute(
        select(func.count()).select_from(Device)
        .where(Device.is_active == True, Device.site == loc.name)
    )).scalar() or 0
    return _serialize(loc, count)


@router.delete("/{location_id}", status_code=204)
async def delete_location(
    location_id: int,
    unassign: bool = Query(default=True, description="Cihazların site alanını temizle"),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    loc = (await db.execute(
        select(Location).where(Location.id == location_id)
    )).scalar_one_or_none()
    if not loc:
        raise HTTPException(status_code=404, detail="Lokasyon bulunamadı")

    if unassign:
        await db.execute(
            update(Device).where(Device.site == loc.name).values(site=None)
        )

    await db.delete(loc)
    await db.commit()
