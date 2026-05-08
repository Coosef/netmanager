import csv
import io
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

_ISTANBUL = ZoneInfo("Europe/Istanbul")
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, LocationNameFilter, TenantFilter
from app.models.config_backup import ConfigBackup
from app.models.device import Device
from app.models.network_event import NetworkEvent
from app.models.topology import TopologyLink
from app.models.user import UserRole

router = APIRouter()


@router.get("/events", response_model=dict)
async def list_events(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    location_filter: LocationNameFilter = None,
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

    # Location RBAC enforcement
    effective_sites: Optional[list[str]] = location_filter  # None = unrestricted
    if effective_sites is not None:
        if site:
            effective_sites = [s for s in effective_sites if s == site]
            site = None
        if not effective_sites:
            return {"total": 0, "items": []}
        site_ids_sq = select(Device.id).where(Device.site.in_(effective_sites), Device.is_active == True)
        q = q.where(NetworkEvent.device_id.in_(site_ids_sq))
    elif site:
        site_ids_sq = select(Device.id).where(Device.site == site, Device.is_active == True)
        q = q.where(NetworkEvent.device_id.in_(site_ids_sq))
        site = None

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


@router.get("/events/export.csv")
async def export_events_csv(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    location_filter: LocationNameFilter = None,
    severity: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    device_id: Optional[int] = Query(None),
    hours: int = Query(24, description="Events from last N hours"),
    unacked_only: bool = Query(False),
    site: Optional[str] = Query(None),
):
    """Export filtered network events as CSV download."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(NetworkEvent).where(NetworkEvent.created_at >= since)

    effective_sites: Optional[list[str]] = location_filter
    if effective_sites is not None:
        if site:
            effective_sites = [s for s in effective_sites if s == site]
            site = None
        if not effective_sites:
            q = q.where(NetworkEvent.id == -1)
        else:
            site_ids_sq = select(Device.id).where(Device.site.in_(effective_sites), Device.is_active == True)
            q = q.where(NetworkEvent.device_id.in_(site_ids_sq))
    elif site:
        site_ids_sq = select(Device.id).where(Device.site == site, Device.is_active == True)
        q = q.where(NetworkEvent.device_id.in_(site_ids_sq))

    if severity:
        q = q.where(NetworkEvent.severity == severity)
    if event_type:
        q = q.where(NetworkEvent.event_type == event_type)
    if device_id:
        q = q.where(NetworkEvent.device_id == device_id)
    if unacked_only:
        q = q.where(NetworkEvent.acknowledged == False)

    result = await db.execute(q.order_by(NetworkEvent.created_at.desc()).limit(10000))
    events = result.scalars().all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["id", "created_at", "severity", "event_type", "device_hostname", "device_id", "title", "message", "acknowledged"])
    tz = ZoneInfo("Europe/Istanbul")
    for e in events:
        ts = e.created_at.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S") if e.created_at else ""
        writer.writerow([
            e.id, ts, e.severity, e.event_type,
            e.device_hostname or "", e.device_id or "",
            e.title or "", (e.message or "").replace("\n", " "),
            "evet" if e.acknowledged else "hayır",
        ])

    filename = f"events_{datetime.now(tz).strftime('%Y%m%d_%H%M')}.csv"
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


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
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
    location_filter: LocationNameFilter = None,
):
    q = update(NetworkEvent).where(NetworkEvent.acknowledged == False)
    if tenant_filter is not None or location_filter is not None:
        # Restrict to devices visible to this user
        dev_q = select(Device.id).where(Device.is_active == True)
        if tenant_filter is not None:
            dev_q = dev_q.where(Device.tenant_id == tenant_filter)
        if location_filter is not None:
            if not location_filter:
                return {"ok": True}
            dev_q = dev_q.where(Device.site.in_(location_filter))
        q = q.where(NetworkEvent.device_id.in_(dev_q))
    await db.execute(q)
    await db.commit()
    return {"ok": True}


@router.post("/events/purge-noise")
async def purge_noise_events(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
    older_than_hours: int = Query(1, description="Purge noisy events older than N hours"),
):
    """
    Delete accumulated flapping/correlation noise events.
    Scoped to tenant; SUPER_ADMIN purges globally.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=older_than_hours)
    noisy_types = ("device_flapping", "correlation_incident", "agent_outage")

    q = delete(NetworkEvent).where(
        NetworkEvent.event_type.in_(noisy_types),
        NetworkEvent.created_at < cutoff,
    )
    if tenant_filter is not None:
        dev_q = select(Device.id).where(Device.tenant_id == tenant_filter, Device.is_active == True)
        q = q.where(NetworkEvent.device_id.in_(dev_q))
    result = await db.execute(q)
    await db.commit()
    return {"deleted": result.rowcount, "event_types": list(noisy_types), "cutoff": cutoff.isoformat()}


@router.get("/stats", response_model=dict)
async def monitor_stats(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    location_filter: LocationNameFilter = None,
    site: Optional[str] = Query(None),
):
    """Dashboard-level stats: health score, event counts, offline devices."""
    since_24h = datetime.now(timezone.utc) - timedelta(hours=24)
    since_7d  = datetime.now(timezone.utc) - timedelta(days=7)

    # Resolve effective sites for location RBAC
    effective_sites: Optional[list[str]] = location_filter  # None = unrestricted
    if effective_sites is not None and site:
        effective_sites = [s for s in effective_sites if s == site]
        site = None
    elif effective_sites is None and site:
        effective_sites = [site]
        site = None

    # Device counts
    dev_q = select(Device).where(Device.is_active == True)
    if effective_sites is not None:
        if not effective_sites:
            return {
                "health_score": 100, "devices": {"total": 0, "online": 0, "offline": 0, "unknown": 0},
                "events_24h": {"total": 0, "by_severity": {}, "by_type": {}, "unacknowledged": 0},
                "backups": {"never": 0, "stale_7d": 0}, "topology": {"nodes": 0, "links": 0},
            }
        dev_q = dev_q.where(Device.site.in_(effective_sites))
    all_devices = (await db.execute(dev_q)).scalars().all()
    total = len(all_devices)
    online  = sum(1 for d in all_devices if d.status == "online")
    offline = sum(1 for d in all_devices if d.status == "offline")
    unknown = total - online - offline

    # Event counts last 24h
    site_ids_sq: Any = None
    if effective_sites is not None:
        site_ids_sq = select(Device.id).where(Device.site.in_(effective_sites), Device.is_active == True)

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
    tenant_filter: TenantFilter = None,
    location_filter: LocationNameFilter = None,
    hours: int = Query(24),
):
    """Hourly event counts for charting (last N hours)."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(NetworkEvent.created_at, NetworkEvent.severity).where(NetworkEvent.created_at >= since)
    if tenant_filter is not None or location_filter is not None:
        dev_q = select(Device.id).where(Device.is_active == True)
        if tenant_filter is not None:
            dev_q = dev_q.where(Device.tenant_id == tenant_filter)
        if location_filter is not None:
            if not location_filter:
                return {"timeline": []}
            dev_q = dev_q.where(Device.site.in_(location_filter))
        q = q.where(NetworkEvent.device_id.in_(dev_q))
    result = await db.execute(q.order_by(NetworkEvent.created_at))
    rows = result.fetchall()

    # Group by hour (Istanbul time — UTC+3)
    buckets: dict[str, dict] = {}
    for ts, severity in rows:
        ts_local = ts.astimezone(_ISTANBUL) if ts.tzinfo else ts
        hour_key = ts_local.strftime("%H:00")
        if hour_key not in buckets:
            buckets[hour_key] = {"time": hour_key, "critical": 0, "warning": 0, "info": 0}
        buckets[hour_key][severity] = buckets[hour_key].get(severity, 0) + 1

    return {"timeline": list(buckets.values())}


@router.post("/scan")
async def trigger_scan(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
    location_filter: LocationNameFilter = None,
):
    """Trigger an immediate full anomaly scan on accessible devices."""
    from app.workers.tasks.monitor_tasks import (
        check_stp_anomalies, check_loop_detection, poll_device_status,
        check_port_status, check_lldp_changes,
    )
    dev_q = select(Device).where(Device.is_active == True)
    if tenant_filter is not None:
        dev_q = dev_q.where(Device.tenant_id == tenant_filter)
    if location_filter is not None:
        if not location_filter:
            return {"queued": False, "device_count": 0}
        dev_q = dev_q.where(Device.site.in_(location_filter))
    devices = (await db.execute(dev_q)).scalars().all()
    ids = [d.id for d in devices]

    poll_device_status.apply_async(queue="monitor")
    if ids:
        check_stp_anomalies.apply_async(args=[ids], queue="monitor")
        check_loop_detection.apply_async(args=[ids], queue="monitor")
        check_port_status.apply_async(args=[ids], queue="monitor")
        check_lldp_changes.apply_async(args=[ids], queue="monitor")

    return {"queued": True, "device_count": len(ids)}
