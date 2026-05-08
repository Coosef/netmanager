"""
Sprint 13C — Service Impact Mapping
  CRUD for logical services (name, priority, linked devices/VLANs)
  GET /services/{id}/impact — which devices offline, what's affected
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.service import Service

router = APIRouter()


# ── helpers ──────────────────────────────────────────────────────────────────

def _svc_out(s: Service) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "priority": s.priority,
        "business_owner": s.business_owner,
        "device_ids": s.device_ids or [],
        "vlan_ids": s.vlan_ids or [],
        "is_active": s.is_active,
        "created_at": s.created_at.isoformat(),
        "updated_at": s.updated_at.isoformat(),
    }


# ── CRUD ─────────────────────────────────────────────────────────────────────

# ── Fleet summary (must come before /{service_id} routes) ────────────────────

@router.get("/fleet/impact-summary")
async def fleet_impact_summary(
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Tüm aktif servisler için etki özeti — Dashboard widget için."""
    services = (await db.execute(
        select(Service).where(Service.is_active == True)
    )).scalars().all()

    if not services:
        return {"affected_services": [], "total_services": 0, "critical_count": 0}

    all_device_ids = list({did for s in services for did in (s.device_ids or [])})
    devices_map: dict[int, str] = {}
    if all_device_ids:
        rows = (await db.execute(
            select(Device.id, Device.status).where(Device.id.in_(all_device_ids))
        )).fetchall()
        devices_map = {r[0]: str(r[1]) for r in rows}

    affected_services = []
    critical_count = 0

    for svc in services:
        device_ids = svc.device_ids or []
        if not device_ids:
            continue
        offline = [did for did in device_ids if devices_map.get(did, "online") in ("offline", "error")]
        if not offline:
            continue
        impact_pct = round(len(offline) / len(device_ids) * 100, 1)
        priority_weight = {"critical": 1.0, "high": 0.75, "medium": 0.5, "low": 0.25}.get(svc.priority, 0.5)
        if impact_pct >= 80 * priority_weight:
            impact_level = "critical"
            critical_count += 1
        elif impact_pct >= 50 * priority_weight:
            impact_level = "high"
        elif impact_pct >= 20 * priority_weight:
            impact_level = "medium"
        else:
            impact_level = "low"
        affected_services.append({
            "service_id": svc.id,
            "service_name": svc.name,
            "priority": svc.priority,
            "impact_level": impact_level,
            "impact_pct": impact_pct,
            "offline_device_count": len(offline),
            "total_device_count": len(device_ids),
        })

    affected_services.sort(key=lambda x: (
        {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(x["impact_level"], 4),
        {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(x["priority"], 4),
    ))

    return {
        "affected_services": affected_services,
        "total_services": len(services),
        "critical_count": critical_count,
    }


# ── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("")
async def list_services(
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    search: str = Query(None),
):
    query = select(Service).order_by(Service.name)
    if search:
        query = query.where(Service.name.ilike(f"%{search}%"))
    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar() or 0
    rows = (await db.execute(query.offset(skip).limit(limit))).scalars().all()
    return {"total": total, "items": [_svc_out(s) for s in rows]}


@router.post("")
async def create_service(
    body: dict,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    if not body.get("name"):
        raise HTTPException(400, "name is required")
    if body.get("priority", "medium") not in ("critical", "high", "medium", "low"):
        raise HTTPException(400, "priority must be critical | high | medium | low")
    existing = (await db.execute(
        select(Service).where(Service.name == body["name"])
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "Service with that name already exists")
    svc = Service(
        name=body["name"],
        description=body.get("description"),
        priority=body.get("priority", "medium"),
        business_owner=body.get("business_owner"),
        device_ids=body.get("device_ids", []),
        vlan_ids=body.get("vlan_ids", []),
    )
    db.add(svc)
    await db.commit()
    await db.refresh(svc)
    return _svc_out(svc)


@router.get("/{service_id}")
async def get_service(
    service_id: int,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    svc = (await db.execute(select(Service).where(Service.id == service_id))).scalar_one_or_none()
    if not svc:
        raise HTTPException(404, "Service not found")
    return _svc_out(svc)


@router.patch("/{service_id}")
async def update_service(
    service_id: int,
    body: dict,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    svc = (await db.execute(select(Service).where(Service.id == service_id))).scalar_one_or_none()
    if not svc:
        raise HTTPException(404, "Service not found")
    for field in ("name", "description", "priority", "business_owner", "device_ids", "vlan_ids", "is_active"):
        if field in body:
            setattr(svc, field, body[field])
    svc.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(svc)
    return _svc_out(svc)


@router.delete("/{service_id}")
async def delete_service(
    service_id: int,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    svc = (await db.execute(select(Service).where(Service.id == service_id))).scalar_one_or_none()
    if not svc:
        raise HTTPException(404, "Service not found")
    await db.delete(svc)
    await db.commit()
    return {"ok": True}


# ── Impact analysis ───────────────────────────────────────────────────────────

@router.get("/{service_id}/impact")
async def service_impact(
    service_id: int,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """
    Hangi cihazlar offline → bu servis etkileniyor mu?
    Sonuç: affected_devices (offline), healthy_devices (online), impact_level
    """
    svc = (await db.execute(select(Service).where(Service.id == service_id))).scalar_one_or_none()
    if not svc:
        raise HTTPException(404, "Service not found")

    device_ids = svc.device_ids or []
    if not device_ids:
        return {
            "service_id": service_id,
            "service_name": svc.name,
            "priority": svc.priority,
            "device_ids": [],
            "affected_devices": [],
            "healthy_devices": [],
            "affected_count": 0,
            "healthy_count": 0,
            "impact_level": "none",
            "impact_pct": 0.0,
        }

    devices = (await db.execute(
        select(Device).where(Device.id.in_(device_ids))
    )).scalars().all()

    affected = []
    healthy = []
    for d in devices:
        entry = {"id": d.id, "hostname": d.hostname, "ip_address": d.ip_address, "status": str(d.status)}
        if str(d.status) in ("offline", "error"):
            affected.append(entry)
        else:
            healthy.append(entry)

    total = len(devices)
    affected_count = len(affected)
    impact_pct = round(affected_count / total * 100, 1) if total else 0.0

    # Impact level: based on affected % and service priority weight
    priority_weight = {"critical": 1.0, "high": 0.75, "medium": 0.5, "low": 0.25}.get(svc.priority, 0.5)
    if affected_count == 0:
        impact_level = "none"
    elif impact_pct >= 80 * priority_weight:
        impact_level = "critical"
    elif impact_pct >= 50 * priority_weight:
        impact_level = "high"
    elif impact_pct >= 20 * priority_weight:
        impact_level = "medium"
    else:
        impact_level = "low"

    return {
        "service_id": service_id,
        "service_name": svc.name,
        "priority": svc.priority,
        "device_ids": device_ids,
        "affected_devices": affected,
        "healthy_devices": healthy,
        "affected_count": affected_count,
        "healthy_count": len(healthy),
        "impact_level": impact_level,
        "impact_pct": impact_pct,
        "vlan_ids": svc.vlan_ids or [],
    }
