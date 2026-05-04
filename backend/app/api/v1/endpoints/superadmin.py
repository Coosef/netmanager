from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import require_roles
from app.models.device import Device
from app.models.location import Location
from app.models.network_event import NetworkEvent
from app.models.task import Task
from app.models.tenant import Tenant
from app.models.user import User, UserRole

router = APIRouter()

SuperAdminRequired = Depends(require_roles(UserRole.SUPER_ADMIN))


@router.get("/system-stats")
async def system_stats(
    db: AsyncSession = Depends(get_db),
    _=SuperAdminRequired,
):
    """Platform-wide aggregated stats for the super_admin dashboard."""
    since_24h = datetime.now(timezone.utc) - timedelta(hours=24)

    total_tenants  = (await db.execute(select(func.count()).select_from(Tenant))).scalar() or 0
    active_tenants = (await db.execute(select(func.count()).select_from(Tenant).where(Tenant.is_active == True))).scalar() or 0
    total_users    = (await db.execute(select(func.count()).select_from(User))).scalar() or 0
    total_devices  = (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True))).scalar() or 0
    total_locations= (await db.execute(select(func.count()).select_from(Location))).scalar() or 0

    online_devices  = (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True, Device.status == "online"))).scalar() or 0
    offline_devices = (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True, Device.status == "offline"))).scalar() or 0

    events_24h = (await db.execute(
        select(func.count()).select_from(NetworkEvent).where(NetworkEvent.created_at >= since_24h)
    )).scalar() or 0
    critical_24h = (await db.execute(
        select(func.count()).select_from(NetworkEvent)
        .where(NetworkEvent.created_at >= since_24h, NetworkEvent.severity == "critical")
    )).scalar() or 0

    tasks_running = (await db.execute(
        select(func.count()).select_from(Task).where(Task.status == "running")
    )).scalar() or 0

    # Per-plan breakdown
    plan_rows = (await db.execute(
        select(Tenant.plan_tier, func.count()).group_by(Tenant.plan_tier)
    )).fetchall()
    plan_counts = {row[0]: row[1] for row in plan_rows}

    # Top tenants by device count
    tenant_device_rows = (await db.execute(
        select(Tenant.id, Tenant.name, Tenant.plan_tier, func.count(Device.id).label("cnt"))
        .outerjoin(Device, Device.tenant_id == Tenant.id)
        .where(Device.is_active == True)
        .group_by(Tenant.id, Tenant.name, Tenant.plan_tier)
        .order_by(func.count(Device.id).desc())
        .limit(10)
    )).fetchall()
    top_tenants = [
        {"id": r[0], "name": r[1], "plan_tier": r[2], "device_count": r[3]}
        for r in tenant_device_rows
    ]

    return {
        "tenants": {"total": total_tenants, "active": active_tenants, "by_plan": plan_counts},
        "users": {"total": total_users},
        "devices": {"total": total_devices, "online": online_devices, "offline": offline_devices},
        "locations": {"total": total_locations},
        "events_24h": {"total": events_24h, "critical": critical_24h},
        "tasks": {"running": tasks_running},
        "top_tenants_by_devices": top_tenants,
    }


@router.patch("/tenants/{tenant_id}/plan")
async def update_tenant_plan(
    tenant_id: int,
    plan_tier: str,
    max_devices: int,
    max_users: int,
    db: AsyncSession = Depends(get_db),
    _=SuperAdminRequired,
):
    """Quick plan adjustment without going through the full tenant edit drawer."""
    tenant = (await db.execute(select(Tenant).where(Tenant.id == tenant_id))).scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    tenant.plan_tier = plan_tier
    tenant.max_devices = max_devices
    tenant.max_users = max_users
    await db.commit()
    return {"ok": True}


@router.patch("/tenants/{tenant_id}/toggle-active")
async def toggle_tenant_active(
    tenant_id: int,
    db: AsyncSession = Depends(get_db),
    _=SuperAdminRequired,
):
    tenant = (await db.execute(select(Tenant).where(Tenant.id == tenant_id))).scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")
    tenant.is_active = not tenant.is_active
    await db.commit()
    return {"is_active": tenant.is_active}
