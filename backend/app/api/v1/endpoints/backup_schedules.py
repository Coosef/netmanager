from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.backup_schedule import BackupSchedule
from app.models.config_backup import ConfigBackup
from app.models.device import Device
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


# ---------------------------------------------------------------------------
# Config Drift Report
# ---------------------------------------------------------------------------

@router.get("/drift-report")
async def config_drift_report(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_id: Optional[int] = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
):
    """
    Compare each device's latest backup hash against its golden config hash.
    Returns devices with drift (hash mismatch) and summary stats.
    """
    tf = tenant_id or (current_user.tenant_id if hasattr(current_user, "tenant_id") else None)

    # Golden baselines per device
    golden_q = select(ConfigBackup.device_id, ConfigBackup.config_hash.label("golden_hash")).where(ConfigBackup.is_golden == True)
    if tf:
        golden_q = golden_q.where(ConfigBackup.tenant_id == tf)
    golden_rows = (await db.execute(golden_q)).fetchall()
    golden_map = {r[0]: r[1] for r in golden_rows}

    if not golden_map:
        return {
            "total_with_golden": 0, "drift_count": 0, "clean_count": 0,
            "no_backup_count": 0, "items": [], "total": 0,
        }

    # Latest backup per device (only for devices with golden)
    latest_q = (
        select(ConfigBackup.device_id, ConfigBackup.config_hash, ConfigBackup.created_at, ConfigBackup.id)
        .where(ConfigBackup.device_id.in_(list(golden_map.keys())))
        .order_by(ConfigBackup.device_id, ConfigBackup.created_at.desc())
    )
    if tf:
        latest_q = latest_q.where(ConfigBackup.tenant_id == tf)
    latest_rows = (await db.execute(latest_q)).fetchall()

    # Pick only the most recent per device
    latest_map: dict[int, tuple] = {}
    for row in latest_rows:
        did = row[0]
        if did not in latest_map:
            latest_map[did] = row

    # Load device info
    device_rows = (await db.execute(
        select(Device.id, Device.hostname, Device.ip_address, Device.vendor, Device.site, Device.status)
        .where(Device.id.in_(list(golden_map.keys())), Device.is_active == True)
    )).fetchall()
    dev_map = {r[0]: r for r in device_rows}

    drift_items = []
    clean_count = 0
    no_backup_count = 0

    for device_id, golden_hash in golden_map.items():
        dev = dev_map.get(device_id)
        hostname = dev[1] if dev else str(device_id)
        ip = dev[2] if dev else None
        vendor = dev[3] if dev else None
        site = dev[4] if dev else None
        status = dev[5] if dev else None

        if device_id not in latest_map:
            no_backup_count += 1
            drift_items.append({
                "device_id": device_id, "hostname": hostname, "ip": ip,
                "vendor": vendor, "site": site, "device_status": status,
                "drift": True, "reason": "no_backup",
                "latest_backup_at": None, "backup_id": None,
            })
        else:
            _, latest_hash, latest_at, backup_id = latest_map[device_id]
            has_drift = latest_hash != golden_hash
            if has_drift:
                drift_items.append({
                    "device_id": device_id, "hostname": hostname, "ip": ip,
                    "vendor": vendor, "site": site, "device_status": status,
                    "drift": True, "reason": "hash_mismatch",
                    "latest_backup_at": latest_at.isoformat(), "backup_id": backup_id,
                })
            else:
                clean_count += 1

    total_with_golden = len(golden_map)
    drift_count = len(drift_items)

    # Pagination over drift items
    paginated = drift_items[skip: skip + limit]

    return {
        "total_with_golden": total_with_golden,
        "drift_count": drift_count,
        "clean_count": clean_count,
        "no_backup_count": no_backup_count,
        "items": paginated,
        "total": drift_count,
    }


# ---------------------------------------------------------------------------
# Golden vs Latest diff for a single device
# ---------------------------------------------------------------------------

@router.get("/drift-diff/{device_id}")
async def config_drift_diff(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Return golden config text and latest backup text for client-side diff rendering."""
    tf = getattr(current_user, "tenant_id", None)

    golden_q = (
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id, ConfigBackup.is_golden == True)
        .order_by(ConfigBackup.created_at.desc())
        .limit(1)
    )
    if tf:
        golden_q = golden_q.where(ConfigBackup.tenant_id == tf)
    golden = (await db.execute(golden_q)).scalar_one_or_none()
    if not golden:
        raise HTTPException(status_code=404, detail="Golden config bulunamadı")

    latest_q = (
        select(ConfigBackup)
        .where(
            ConfigBackup.device_id == device_id,
            ConfigBackup.is_golden == False,
        )
        .order_by(ConfigBackup.created_at.desc())
        .limit(1)
    )
    if tf:
        latest_q = latest_q.where(ConfigBackup.tenant_id == tf)
    latest = (await db.execute(latest_q)).scalar_one_or_none()
    if not latest:
        raise HTTPException(status_code=404, detail="Son backup bulunamadı")

    return {
        "golden_id": golden.id,
        "golden_at": golden.created_at.isoformat(),
        "golden_text": golden.config_text or "",
        "latest_id": latest.id,
        "latest_at": latest.created_at.isoformat(),
        "latest_text": latest.config_text or "",
    }
