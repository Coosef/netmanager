"""CRUD API for maintenance windows — alert suppression during planned outages."""
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.maintenance_window import MaintenanceWindow

router = APIRouter()


def _serialize(w: MaintenanceWindow) -> dict[str, Any]:
    return {
        "id": w.id,
        "name": w.name,
        "description": w.description,
        "start_time": w.start_time.isoformat(),
        "end_time": w.end_time.isoformat(),
        "applies_to_all": w.applies_to_all,
        "device_ids": w.device_ids or [],
        "created_by": w.created_by,
        "created_at": w.created_at.isoformat(),
        "is_active": w.start_time <= datetime.now(timezone.utc) <= w.end_time,
    }


@router.get("")
async def list_windows(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(MaintenanceWindow).order_by(MaintenanceWindow.start_time.desc())
    )
    return [_serialize(w) for w in result.scalars().all()]


@router.get("/active")
async def list_active_windows(db: AsyncSession = Depends(get_db)):
    """Returns windows that are currently active (now is between start and end)."""
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(MaintenanceWindow).where(
            MaintenanceWindow.start_time <= now,
            MaintenanceWindow.end_time >= now,
        )
    )
    return [_serialize(w) for w in result.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_window(
    payload: dict,
    current_user: CurrentUser = None,
    db: AsyncSession = Depends(get_db),
):
    _validate(payload)
    w = MaintenanceWindow(
        name=payload["name"],
        description=payload.get("description"),
        start_time=datetime.fromisoformat(payload["start_time"]),
        end_time=datetime.fromisoformat(payload["end_time"]),
        applies_to_all=bool(payload.get("applies_to_all", False)),
        device_ids=payload.get("device_ids") or [],
        created_by=current_user.id,
    )
    db.add(w)
    await db.commit()
    await db.refresh(w)
    return _serialize(w)


@router.patch("/{window_id}")
async def update_window(
    window_id: int,
    payload: dict,
    current_user: CurrentUser = None,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(MaintenanceWindow).where(MaintenanceWindow.id == window_id))
    w = result.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="Not found")

    if "name" in payload:
        w.name = payload["name"]
    if "description" in payload:
        w.description = payload["description"]
    if "start_time" in payload:
        w.start_time = datetime.fromisoformat(payload["start_time"])
    if "end_time" in payload:
        w.end_time = datetime.fromisoformat(payload["end_time"])
    if "applies_to_all" in payload:
        w.applies_to_all = bool(payload["applies_to_all"])
    if "device_ids" in payload:
        w.device_ids = payload["device_ids"] or []

    await db.commit()
    await db.refresh(w)
    return _serialize(w)


@router.delete("/{window_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_window(
    window_id: int,
    current_user: CurrentUser = None,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(MaintenanceWindow).where(MaintenanceWindow.id == window_id))
    w = result.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="Not found")
    await db.delete(w)
    await db.commit()


def _validate(payload: dict):
    if not payload.get("name"):
        raise HTTPException(status_code=422, detail="name is required")
    if not payload.get("start_time") or not payload.get("end_time"):
        raise HTTPException(status_code=422, detail="start_time and end_time are required")
    try:
        st = datetime.fromisoformat(payload["start_time"])
        et = datetime.fromisoformat(payload["end_time"])
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail="Invalid datetime format (use ISO 8601)")
    if et <= st:
        raise HTTPException(status_code=422, detail="end_time must be after start_time")
