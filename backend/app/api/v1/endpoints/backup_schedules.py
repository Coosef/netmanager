from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.backup_schedule import BackupSchedule
from app.schemas.backup_schedule import (
    BackupScheduleCreate,
    BackupScheduleResponse,
    BackupScheduleUpdate,
)
from app.workers.tasks.bulk_tasks import _compute_next_run

router = APIRouter()


def _schedule_to_dict(s: BackupSchedule) -> dict:
    dow = [int(x) for x in s.days_of_week.split(",") if x] if s.days_of_week else None
    return {
        "id": s.id,
        "name": s.name,
        "enabled": s.enabled,
        "schedule_type": s.schedule_type,
        "run_hour": s.run_hour,
        "run_minute": s.run_minute,
        "days_of_week": dow,
        "interval_hours": s.interval_hours,
        "device_filter": s.device_filter,
        "site": s.site,
        "last_run_at": s.last_run_at,
        "next_run_at": s.next_run_at,
        "last_task_id": s.last_task_id,
        "is_default": s.is_default,
        "created_by": s.created_by,
        "created_at": s.created_at,
        "updated_at": s.updated_at,
    }


@router.get("/", response_model=List[BackupScheduleResponse])
async def list_schedules(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    result = await db.execute(
        select(BackupSchedule).order_by(BackupSchedule.is_default.desc(), BackupSchedule.created_at)
    )
    schedules = result.scalars().all()
    return [BackupScheduleResponse(**_schedule_to_dict(s)) for s in schedules]


@router.post("/", response_model=BackupScheduleResponse)
async def create_schedule(
    payload: BackupScheduleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    days_str = ",".join(str(d) for d in payload.days_of_week) if payload.days_of_week else None
    now = datetime.now(timezone.utc)
    next_run = _compute_next_run(
        payload.schedule_type,
        payload.run_hour,
        payload.run_minute,
        payload.days_of_week,
        payload.interval_hours,
        from_dt=now,
    )
    schedule = BackupSchedule(
        name=payload.name,
        enabled=payload.enabled,
        schedule_type=payload.schedule_type,
        run_hour=payload.run_hour,
        run_minute=payload.run_minute,
        days_of_week=days_str,
        interval_hours=payload.interval_hours,
        device_filter=payload.device_filter,
        site=payload.site,
        next_run_at=next_run,
        is_default=False,
        created_by=current_user.id,
    )
    db.add(schedule)
    await db.commit()
    await db.refresh(schedule)
    return BackupScheduleResponse(**_schedule_to_dict(schedule))


@router.put("/{schedule_id}", response_model=BackupScheduleResponse)
async def update_schedule(
    schedule_id: int,
    payload: BackupScheduleUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    result = await db.execute(select(BackupSchedule).where(BackupSchedule.id == schedule_id))
    schedule = result.scalar_one_or_none()
    if not schedule:
        raise HTTPException(404, "Schedule not found")

    for field, value in payload.model_dump(exclude_none=True).items():
        if field == "days_of_week":
            setattr(schedule, field, ",".join(str(d) for d in value) if value else None)
        else:
            setattr(schedule, field, value)

    dow = [int(x) for x in schedule.days_of_week.split(",") if x] if schedule.days_of_week else None
    schedule.next_run_at = _compute_next_run(
        schedule.schedule_type,
        schedule.run_hour,
        schedule.run_minute,
        dow,
        schedule.interval_hours,
        from_dt=datetime.now(timezone.utc),
    )
    schedule.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(schedule)
    return BackupScheduleResponse(**_schedule_to_dict(schedule))


@router.delete("/{schedule_id}")
async def delete_schedule(
    schedule_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    result = await db.execute(select(BackupSchedule).where(BackupSchedule.id == schedule_id))
    schedule = result.scalar_one_or_none()
    if not schedule:
        raise HTTPException(404, "Schedule not found")
    if schedule.is_default:
        raise HTTPException(400, "Default schedule cannot be deleted; disable it instead")
    await db.delete(schedule)
    await db.commit()
    return {"status": "deleted"}


@router.post("/{schedule_id}/run-now")
async def run_schedule_now(
    schedule_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    result = await db.execute(select(BackupSchedule).where(BackupSchedule.id == schedule_id))
    schedule = result.scalar_one_or_none()
    if not schedule:
        raise HTTPException(404, "Schedule not found")

    from app.workers.tasks.bulk_tasks import _trigger_schedule_backup
    task_id = await _trigger_schedule_backup(
        schedule.device_filter,
        schedule.site,
        current_user.id,
    )
    if task_id:
        schedule.last_run_at = datetime.now(timezone.utc)
        schedule.last_task_id = task_id
        await db.commit()
        return {"status": "started", "task_id": task_id}
    return {"status": "no_devices"}
