"""SLA Policy management & Uptime analytics."""
import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.network_event import NetworkEvent
from app.models.sla_policy import SlaPolicy

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class SlaPolicyCreate(BaseModel):
    name: str
    target_uptime_pct: float = 99.0
    measurement_window_days: int = 30
    device_ids: list[int] = []
    group_ids: list[int] = []
    notify_on_breach: bool = True


def _serialize_policy(p: SlaPolicy) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "target_uptime_pct": p.target_uptime_pct,
        "measurement_window_days": p.measurement_window_days,
        "device_ids": json.loads(p.device_ids) if p.device_ids else [],
        "group_ids": json.loads(p.group_ids) if p.group_ids else [],
        "notify_on_breach": p.notify_on_breach,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }


async def _calc_uptime(
    db: AsyncSession,
    device_id: int,
    window_days: int,
    now: datetime,
) -> float:
    """Return uptime % for a device over the past window_days.

    Method: reconstruct online/offline intervals from NetworkEvents ordered
    by time.  Assume device starts online at window_start unless the first
    event is device_online (meaning it was offline before the window).
    """
    since = now - timedelta(days=window_days)
    total_secs = window_days * 86400

    rows = (await db.execute(
        select(NetworkEvent.event_type, NetworkEvent.created_at)
        .where(NetworkEvent.device_id == device_id)
        .where(NetworkEvent.event_type.in_(["device_offline", "device_online"]))
        .where(NetworkEvent.created_at >= since)
        .order_by(NetworkEvent.created_at.asc())
    )).fetchall()

    if not rows:
        # No events → assume always online
        return 100.0

    offline_secs = 0.0
    offline_start: Optional[datetime] = None

    # Determine initial state: if first event is device_online, started offline
    first_type = rows[0][0]
    if first_type == "device_online":
        offline_start = since

    for etype, ts in rows:
        if etype == "device_offline":
            if offline_start is None:
                offline_start = ts
        elif etype == "device_online":
            if offline_start is not None:
                offline_secs += (ts - offline_start).total_seconds()
                offline_start = None

    # Still offline at end of window
    if offline_start is not None:
        offline_secs += (now - offline_start).total_seconds()

    uptime = max(0.0, (total_secs - offline_secs) / total_secs * 100)
    return round(uptime, 3)


# ── SLA Policy CRUD ───────────────────────────────────────────────────────────

@router.get("/policies")
async def list_policies(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    rows = (await db.execute(select(SlaPolicy).order_by(SlaPolicy.id))).scalars().all()
    return [_serialize_policy(r) for r in rows]


@router.post("/policies", status_code=201)
async def create_policy(
    body: SlaPolicyCreate,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    p = SlaPolicy(
        name=body.name,
        target_uptime_pct=body.target_uptime_pct,
        measurement_window_days=body.measurement_window_days,
        device_ids=json.dumps(body.device_ids),
        group_ids=json.dumps(body.group_ids),
        notify_on_breach=body.notify_on_breach,
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return _serialize_policy(p)


@router.put("/policies/{policy_id}")
async def update_policy(
    policy_id: int,
    body: SlaPolicyCreate,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    p = (await db.execute(select(SlaPolicy).where(SlaPolicy.id == policy_id))).scalar_one_or_none()
    if not p:
        raise HTTPException(404, "SLA politikası bulunamadı")
    p.name = body.name
    p.target_uptime_pct = body.target_uptime_pct
    p.measurement_window_days = body.measurement_window_days
    p.device_ids = json.dumps(body.device_ids)
    p.group_ids = json.dumps(body.group_ids)
    p.notify_on_breach = body.notify_on_breach
    await db.commit()
    await db.refresh(p)
    return _serialize_policy(p)


@router.delete("/policies/{policy_id}")
async def delete_policy(
    policy_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    p = (await db.execute(select(SlaPolicy).where(SlaPolicy.id == policy_id))).scalar_one_or_none()
    if not p:
        raise HTTPException(404, "SLA politikası bulunamadı")
    await db.delete(p)
    await db.commit()
    return {"ok": True}


# ── Uptime Report ─────────────────────────────────────────────────────────────

@router.get("/report")
async def uptime_report(
    window_days: int = Query(30, ge=1, le=90),
    device_ids: Optional[str] = Query(None, description="Comma-separated device IDs"),
    site: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Return uptime % for every active device (or a subset) over the window."""
    now = datetime.now(timezone.utc)

    q = select(Device).where(Device.is_active == True)
    if device_ids:
        ids = [int(x) for x in device_ids.split(",") if x.strip().isdigit()]
        q = q.where(Device.id.in_(ids))
    if site:
        q = q.where(Device.site == site)

    devices = (await db.execute(q)).scalars().all()

    results = []
    for d in devices:
        pct = await _calc_uptime(db, d.id, window_days, now)
        results.append({
            "device_id": d.id,
            "hostname": d.hostname,
            "ip": d.ip_address,
            "vendor": d.vendor,
            "location": d.location,
            "uptime_pct": pct,
            "downtime_minutes": round((100 - pct) / 100 * window_days * 1440, 1),
        })

    results.sort(key=lambda x: x["uptime_pct"])
    return {
        "window_days": window_days,
        "generated_at": now.isoformat(),
        "devices": results,
    }


# ── SLA Compliance (devices below target) ────────────────────────────────────

@router.get("/compliance")
async def sla_compliance(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Check all SLA policies and return compliance status per policy."""
    now = datetime.now(timezone.utc)
    policies = (await db.execute(select(SlaPolicy))).scalars().all()

    if not policies:
        return []

    all_devices = (await db.execute(
        select(Device).where(Device.is_active == True)
    )).scalars().all()
    device_map = {d.id: d for d in all_devices}

    results = []
    for policy in policies:
        dev_ids_raw = json.loads(policy.device_ids) if policy.device_ids else []
        grp_ids_raw = json.loads(policy.group_ids) if policy.group_ids else []

        if dev_ids_raw:
            scope = [d for d in all_devices if d.id in dev_ids_raw]
        elif grp_ids_raw:
            scope = [d for d in all_devices if d.group_id in grp_ids_raw]
        else:
            scope = all_devices

        breaches = []
        compliant = []
        for d in scope:
            pct = await _calc_uptime(db, d.id, policy.measurement_window_days, now)
            entry = {
                "device_id": d.id,
                "hostname": d.hostname,
                "uptime_pct": pct,
                "target_pct": policy.target_uptime_pct,
                "breach": pct < policy.target_uptime_pct,
            }
            if pct < policy.target_uptime_pct:
                breaches.append(entry)
            else:
                compliant.append(entry)

        results.append({
            "policy_id": policy.id,
            "policy_name": policy.name,
            "target_uptime_pct": policy.target_uptime_pct,
            "window_days": policy.measurement_window_days,
            "total_devices": len(scope),
            "compliant_count": len(compliant),
            "breach_count": len(breaches),
            "compliance_pct": round(len(compliant) / max(len(scope), 1) * 100, 1),
            "breaches": sorted(breaches, key=lambda x: x["uptime_pct"]),
        })

    return results


# ── Device Uptime (single device) ────────────────────────────────────────────

@router.get("/device/{device_id}")
async def device_uptime(
    device_id: int,
    window_days: int = Query(30, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Return uptime % for a specific device plus daily breakdown."""
    now = datetime.now(timezone.utc)
    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Cihaz bulunamadı")

    overall = await _calc_uptime(db, device_id, window_days, now)

    # Daily breakdown (last window_days days)
    daily = []
    for i in range(window_days - 1, -1, -1):
        day_end = now - timedelta(days=i)
        day_start = day_end - timedelta(days=1)
        pct = await _calc_uptime_range(db, device_id, day_start, day_end)
        daily.append({
            "date": day_start.date().isoformat(),
            "uptime_pct": pct,
        })

    return {
        "device_id": device_id,
        "hostname": device.hostname,
        "window_days": window_days,
        "overall_uptime_pct": overall,
        "downtime_minutes": round((100 - overall) / 100 * window_days * 1440, 1),
        "daily": daily,
    }


async def _calc_uptime_range(
    db: AsyncSession,
    device_id: int,
    start: datetime,
    end: datetime,
) -> float:
    total_secs = (end - start).total_seconds()
    if total_secs <= 0:
        return 100.0

    rows = (await db.execute(
        select(NetworkEvent.event_type, NetworkEvent.created_at)
        .where(NetworkEvent.device_id == device_id)
        .where(NetworkEvent.event_type.in_(["device_offline", "device_online"]))
        .where(NetworkEvent.created_at >= start)
        .where(NetworkEvent.created_at <= end)
        .order_by(NetworkEvent.created_at.asc())
    )).fetchall()

    if not rows:
        return 100.0

    offline_secs = 0.0
    offline_start: Optional[datetime] = None

    first_type = rows[0][0]
    if first_type == "device_online":
        offline_start = start

    for etype, ts in rows:
        if etype == "device_offline":
            if offline_start is None:
                offline_start = ts
        elif etype == "device_online":
            if offline_start is not None:
                offline_secs += (ts - offline_start).total_seconds()
                offline_start = None

    if offline_start is not None:
        offline_secs += (end - offline_start).total_seconds()

    return round(max(0.0, (total_secs - offline_secs) / total_secs * 100), 3)


# ── Fleet Summary (for dashboard widget) ─────────────────────────────────────

@router.get("/fleet-summary")
async def fleet_summary(
    window_days: int = Query(30, ge=1, le=90),
    site: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Aggregated uptime stats for the whole fleet."""
    now = datetime.now(timezone.utc)
    fleet_q = select(Device).where(Device.is_active == True)
    if site:
        fleet_q = fleet_q.where(Device.site == site)
    devices = (await db.execute(fleet_q)).scalars().all()

    if not devices:
        return {"total": 0, "above_99": 0, "above_95": 0, "below_95": 0, "avg_uptime_pct": 0}

    uptimes = []
    for d in devices:
        pct = await _calc_uptime(db, d.id, window_days, now)
        uptimes.append(pct)

    above_99 = sum(1 for u in uptimes if u >= 99.0)
    above_95 = sum(1 for u in uptimes if 95.0 <= u < 99.0)
    below_95 = sum(1 for u in uptimes if u < 95.0)
    avg = round(sum(uptimes) / len(uptimes), 2) if uptimes else 0

    # Worst 5
    worst = sorted(
        [{"hostname": d.hostname, "device_id": d.id, "uptime_pct": pct}
         for d, pct in zip(devices, uptimes)],
        key=lambda x: x["uptime_pct"]
    )[:5]

    return {
        "window_days": window_days,
        "total": len(devices),
        "above_99": above_99,
        "above_95": above_95,
        "below_95": below_95,
        "avg_uptime_pct": avg,
        "worst_devices": worst,
    }
