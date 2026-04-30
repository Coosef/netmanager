from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.config_backup import ConfigBackup
from app.models.device import Device
from app.models.network_event import NetworkEvent
from app.models.topology import TopologyLink

router = APIRouter()


@router.get("/events", response_model=dict)
async def list_events(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    skip: int = 0,
    limit: int = 100,
    severity: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    device_id: Optional[int] = Query(None),
    hours: int = Query(24, description="Events from last N hours"),
    unacked_only: bool = Query(False),
    site: Optional[str] = Query(None),
):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(NetworkEvent).where(NetworkEvent.created_at >= since)

    if severity:
        q = q.where(NetworkEvent.severity == severity)
    if event_type:
        q = q.where(NetworkEvent.event_type == event_type)
    if device_id:
        q = q.where(NetworkEvent.device_id == device_id)
    if unacked_only:
        q = q.where(NetworkEvent.acknowledged == False)
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        q = q.where(NetworkEvent.device_id.in_(site_ids))

    total_q = select(func.count()).select_from(q.subquery())
    total = (await db.execute(total_q)).scalar()
    result = await db.execute(q.order_by(NetworkEvent.created_at.desc()).offset(skip).limit(limit))
    events = result.scalars().all()

    return {
        "total": total,
        "items": [
            {
                "id": e.id,
                "device_id": e.device_id,
                "device_hostname": e.device_hostname,
                "event_type": e.event_type,
                "severity": e.severity,
                "title": e.title,
                "message": e.message,
                "details": e.details,
                "acknowledged": e.acknowledged,
                "created_at": e.created_at,
            }
            for e in events
        ],
    }


@router.post("/events/{event_id}/acknowledge")
async def acknowledge_event(
    event_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    await db.execute(
        update(NetworkEvent).where(NetworkEvent.id == event_id).values(acknowledged=True)
    )
    await db.commit()
    return {"ok": True}


@router.post("/events/acknowledge-all")
async def acknowledge_all(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    await db.execute(
        update(NetworkEvent).where(NetworkEvent.acknowledged == False).values(acknowledged=True)
    )
    await db.commit()
    return {"ok": True}


@router.get("/stats", response_model=dict)
async def monitor_stats(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    site: Optional[str] = Query(None),
):
    """Dashboard-level stats: health score, event counts, offline devices."""
    since_24h = datetime.now(timezone.utc) - timedelta(hours=24)
    since_7d  = datetime.now(timezone.utc) - timedelta(days=7)

    # Device counts
    dev_q = select(Device).where(Device.is_active == True)
    if site:
        dev_q = dev_q.where(Device.site == site)
    all_devices = (await db.execute(dev_q)).scalars().all()
    total = len(all_devices)
    online  = sum(1 for d in all_devices if d.status == "online")
    offline = sum(1 for d in all_devices if d.status == "offline")
    unknown = total - online - offline

    # Event counts last 24h
    site_ids_sq = select(Device.id).where(Device.site == site, Device.is_active == True) if site else None

    ev_base_24h = select(NetworkEvent.severity, func.count()).where(NetworkEvent.created_at >= since_24h)
    if site_ids_sq is not None:
        ev_base_24h = ev_base_24h.where(NetworkEvent.device_id.in_(site_ids_sq))
    events_result = await db.execute(ev_base_24h.group_by(NetworkEvent.severity))
    by_severity = {row[0]: row[1] for row in events_result.fetchall()}

    et_base_24h = select(NetworkEvent.event_type, func.count()).where(NetworkEvent.created_at >= since_24h)
    if site_ids_sq is not None:
        et_base_24h = et_base_24h.where(NetworkEvent.device_id.in_(site_ids_sq))
    type_result = await db.execute(et_base_24h.group_by(NetworkEvent.event_type))
    by_type = {row[0]: row[1] for row in type_result.fetchall()}

    unacked_q = (select(func.count()).select_from(NetworkEvent)
        .where(NetworkEvent.acknowledged == False)
        .where(NetworkEvent.created_at >= since_24h))
    if site_ids_sq is not None:
        unacked_q = unacked_q.where(NetworkEvent.device_id.in_(site_ids_sq))
    unacked = (await db.execute(unacked_q)).scalar()

    # Backup health
    never_backed_up = sum(1 for d in all_devices if not d.last_backup)
    stale_backup = sum(
        1 for d in all_devices
        if d.last_backup and d.last_backup < datetime.now(timezone.utc) - timedelta(days=7)
    )

    # Topology
    topo_nodes = (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True))).scalar()
    topo_links = (await db.execute(select(func.count()).select_from(TopologyLink))).scalar()

    # Health score (0-100)
    score = 100
    if total > 0:
        offline_ratio = offline / total
        score -= int(offline_ratio * 40)          # max -40 for all offline
    score -= min(by_severity.get("critical", 0) * 8, 30)   # max -30 for critical events
    score -= min(by_severity.get("warning", 0) * 2, 15)    # max -15 for warnings
    score -= min(stale_backup * 2, 10)                       # max -10 for stale backups
    score -= min(never_backed_up, 5)                         # max -5 for no backups
    score = max(0, min(100, score))

    return {
        "health_score": score,
        "devices": {"total": total, "online": online, "offline": offline, "unknown": unknown},
        "events_24h": {
            "total": sum(by_severity.values()),
            "by_severity": by_severity,
            "by_type": by_type,
            "unacknowledged": unacked,
        },
        "backups": {"never": never_backed_up, "stale_7d": stale_backup},
        "topology": {"nodes": topo_nodes, "links": topo_links},
    }


@router.get("/events/timeline", response_model=dict)
async def events_timeline(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    hours: int = Query(24),
):
    """Hourly event counts for charting (last N hours)."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    result = await db.execute(
        select(NetworkEvent.created_at, NetworkEvent.severity)
        .where(NetworkEvent.created_at >= since)
        .order_by(NetworkEvent.created_at)
    )
    rows = result.fetchall()

    # Group by hour
    buckets: dict[str, dict] = {}
    for ts, severity in rows:
        hour_key = ts.strftime("%H:00")
        if hour_key not in buckets:
            buckets[hour_key] = {"time": hour_key, "critical": 0, "warning": 0, "info": 0}
        buckets[hour_key][severity] = buckets[hour_key].get(severity, 0) + 1

    return {"timeline": list(buckets.values())}


@router.post("/scan")
async def trigger_scan(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Trigger an immediate full anomaly scan on all active devices."""
    from app.workers.tasks.monitor_tasks import (
        check_stp_anomalies, check_loop_detection, poll_device_status,
        check_port_status, check_lldp_changes,
    )
    devices = (await db.execute(
        select(Device).where(Device.is_active == True)
    )).scalars().all()
    ids = [d.id for d in devices]

    poll_device_status.apply_async(queue="monitor")
    if ids:
        check_stp_anomalies.apply_async(args=[ids], queue="monitor")
        check_loop_detection.apply_async(args=[ids], queue="monitor")
        check_port_status.apply_async(args=[ids], queue="monitor")
        check_lldp_changes.apply_async(args=[ids], queue="monitor")

    return {"queued": True, "device_count": len(ids)}
