from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, LocationNameFilter
from app.models.device import Device
from app.models.rack import Rack, RackItem

router = APIRouter()

ITEM_TYPES = ["pdu", "ups", "patch_panel", "cable_tray", "blank", "fan", "shelf", "kvm", "other"]


# ── Schemas ────────────────────────────────────────────────────────────────


class RackDeviceSummary(BaseModel):
    id: int
    hostname: str
    ip_address: str
    vendor: str
    status: str
    device_type: str
    model: Optional[str]
    rack_unit: int
    rack_height: int
    model_config = {"from_attributes": True}


class RackItemResponse(BaseModel):
    id: int
    rack_name: str
    label: str
    item_type: str
    unit_start: int
    unit_height: int
    notes: Optional[str]
    model_config = {"from_attributes": True}


class RackSummary(BaseModel):
    rack_name: str
    total_u: int
    used_u: int
    device_count: int
    item_count: int


class RackDetail(BaseModel):
    rack_name: str
    total_u: int
    devices: list[RackDeviceSummary]
    items: list[RackItemResponse]


class RackPlacementRequest(BaseModel):
    rack_name: str
    rack_unit: int
    rack_height: int = 1


class RackItemCreate(BaseModel):
    label: str
    item_type: str = "other"
    unit_start: int
    unit_height: int = 1
    notes: Optional[str] = None


class RackItemUpdate(BaseModel):
    label: Optional[str] = None
    item_type: Optional[str] = None
    unit_start: Optional[int] = None
    unit_height: Optional[int] = None
    notes: Optional[str] = None


class RackCreateRequest(BaseModel):
    rack_name: str
    total_u: int = 42
    description: Optional[str] = None


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.post("", response_model=RackSummary, status_code=201)
async def create_rack(
    payload: RackCreateRequest,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    existing = (await db.execute(
        select(Rack).where(Rack.rack_name == payload.rack_name)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Bu isimde kabin zaten mevcut")

    rack = Rack(
        rack_name=payload.rack_name,
        total_u=payload.total_u,
        description=payload.description,
    )
    db.add(rack)
    await db.commit()

    return RackSummary(
        rack_name=rack.rack_name,
        total_u=rack.total_u,
        used_u=0,
        device_count=0,
        item_count=0,
    )


@router.get("", response_model=list[RackSummary])
async def list_racks(
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    site: Optional[str] = Query(None),
    location_filter: LocationNameFilter = None,
):
    racks = (await db.execute(select(Rack).order_by(Rack.rack_name))).scalars().all()

    rack_dev_q = select(Device).where(Device.rack_name.isnot(None), Device.is_active == True)
    if location_filter is not None:
        eff = [s for s in location_filter if not site or s == site] if site else location_filter
        if not eff:
            return []
        rack_dev_q = rack_dev_q.where(Device.site.in_(eff))
    elif site:
        rack_dev_q = rack_dev_q.where(Device.site == site)
    devices = (await db.execute(rack_dev_q)).scalars().all()

    items = (await db.execute(select(RackItem))).scalars().all()

    rack_data: dict[str, dict] = {
        r.rack_name: {"total_u": r.total_u, "devices": [], "items": []}
        for r in racks
    }

    for d in devices:
        if d.rack_name:
            if d.rack_name not in rack_data:
                rack_data[d.rack_name] = {"total_u": 42, "devices": [], "items": []}
            rack_data[d.rack_name]["devices"].append(d)

    for item in items:
        if item.rack_name not in rack_data:
            rack_data[item.rack_name] = {"total_u": 42, "devices": [], "items": []}
        rack_data[item.rack_name]["items"].append(item)

    result = []
    for rack_name, data in sorted(rack_data.items()):
        total_u = data["total_u"]
        used_u = sum(d.rack_height or 1 for d in data["devices"])
        used_u += sum(i.unit_height for i in data["items"])
        result.append(RackSummary(
            rack_name=rack_name,
            total_u=total_u,
            used_u=min(used_u, total_u),
            device_count=len(data["devices"]),
            item_count=len(data["items"]),
        ))

    return result


@router.get("/unassigned/devices", response_model=list[RackDeviceSummary])
async def list_unassigned_devices(
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    site: Optional[str] = Query(None),
    location_filter: LocationNameFilter = None,
):
    unassigned_q = select(Device).where(Device.rack_name.is_(None), Device.is_active == True)
    if location_filter is not None:
        eff = [s for s in location_filter if not site or s == site] if site else location_filter
        if not eff:
            return []
        unassigned_q = unassigned_q.where(Device.site.in_(eff))
    elif site:
        unassigned_q = unassigned_q.where(Device.site == site)
    devices = (await db.execute(unassigned_q.order_by(Device.hostname))).scalars().all()

    return [
        RackDeviceSummary(
            id=d.id,
            hostname=d.hostname,
            ip_address=d.ip_address,
            vendor=d.vendor,
            status=d.status,
            device_type=d.device_type,
            model=d.model,
            rack_unit=0,
            rack_height=d.rack_height or 1,
        )
        for d in devices
    ]


@router.get("/{rack_name}", response_model=RackDetail)
async def get_rack(rack_name: str, user: CurrentUser, db: AsyncSession = Depends(get_db)):
    rack = (await db.execute(
        select(Rack).where(Rack.rack_name == rack_name)
    )).scalar_one_or_none()
    if not rack:
        raise HTTPException(status_code=404, detail="Kabin bulunamadı")

    devices = (await db.execute(
        select(Device).where(Device.rack_name == rack_name, Device.is_active == True)
    )).scalars().all()

    items = (await db.execute(
        select(RackItem).where(RackItem.rack_name == rack_name).order_by(RackItem.unit_start)
    )).scalars().all()

    return RackDetail(
        rack_name=rack_name,
        total_u=rack.total_u,
        devices=[
            RackDeviceSummary(
                id=d.id,
                hostname=d.hostname,
                ip_address=d.ip_address,
                vendor=d.vendor,
                status=d.status,
                device_type=d.device_type,
                model=d.model,
                rack_unit=d.rack_unit,
                rack_height=d.rack_height or 1,
            )
            for d in devices if d.rack_unit is not None
        ],
        items=[RackItemResponse.model_validate(i) for i in items],
    )


@router.delete("/{rack_name}", status_code=204)
async def delete_rack(rack_name: str, user: CurrentUser, db: AsyncSession = Depends(get_db)):
    rack = (await db.execute(
        select(Rack).where(Rack.rack_name == rack_name)
    )).scalar_one_or_none()
    if not rack:
        raise HTTPException(status_code=404, detail="Kabin bulunamadı")

    devices = (await db.execute(
        select(Device).where(Device.rack_name == rack_name)
    )).scalars().all()
    for d in devices:
        d.rack_name = None
        d.rack_unit = None
        d.rack_height = 1

    await db.execute(sa_delete(RackItem).where(RackItem.rack_name == rack_name))
    await db.delete(rack)
    await db.commit()


@router.put("/devices/{device_id}/placement", status_code=200)
async def set_device_placement(
    device_id: int,
    payload: RackPlacementRequest,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    device = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Cihaz bulunamadı")

    device.rack_name = payload.rack_name
    device.rack_unit = payload.rack_unit
    device.rack_height = payload.rack_height
    device.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"ok": True}


@router.delete("/devices/{device_id}/placement", status_code=204)
async def remove_device_placement(
    device_id: int,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    device = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Cihaz bulunamadı")

    device.rack_name = None
    device.rack_unit = None
    device.rack_height = 1
    device.updated_at = datetime.now(timezone.utc)
    await db.commit()


@router.post("/{rack_name}/items", response_model=RackItemResponse, status_code=201)
async def create_rack_item(
    rack_name: str,
    payload: RackItemCreate,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    item = RackItem(
        rack_name=rack_name,
        label=payload.label,
        item_type=payload.item_type,
        unit_start=payload.unit_start,
        unit_height=payload.unit_height,
        notes=payload.notes,
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return RackItemResponse.model_validate(item)


@router.put("/{rack_name}/items/{item_id}", response_model=RackItemResponse)
async def update_rack_item(
    rack_name: str,
    item_id: int,
    payload: RackItemUpdate,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    item = (await db.execute(
        select(RackItem).where(RackItem.id == item_id, RackItem.rack_name == rack_name)
    )).scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Öğe bulunamadı")

    if payload.label is not None:
        item.label = payload.label
    if payload.item_type is not None:
        item.item_type = payload.item_type
    if payload.unit_start is not None:
        item.unit_start = payload.unit_start
    if payload.unit_height is not None:
        item.unit_height = payload.unit_height
    if payload.notes is not None:
        item.notes = payload.notes
    item.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(item)
    return RackItemResponse.model_validate(item)


@router.delete("/{rack_name}/items/{item_id}", status_code=204)
async def delete_rack_item(
    rack_name: str,
    item_id: int,
    user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        sa_delete(RackItem).where(RackItem.id == item_id, RackItem.rack_name == rack_name)
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Öğe bulunamadı")
    await db.commit()
