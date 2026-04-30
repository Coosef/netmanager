from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import case, desc

from app.core.database import get_db
from app.core.deps import CurrentUser, TenantFilter
from app.models.agent import Agent
from app.models.config_backup import ConfigBackup
from app.models.device import Device
from app.models.network_event import NetworkEvent
from app.models.task import Task, TaskStatus
from app.models.topology import TopologyLink

router = APIRouter()


@router.get("/summary")
async def report_summary(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    site: str = Query(None),
):
    """High-level network summary for reports page."""
    since_24h = datetime.now(timezone.utc) - timedelta(hours=24)
    since_7d = datetime.now(timezone.utc) - timedelta(days=7)

    dev_q = select(Device).where(Device.is_active == True)
    if site:
        dev_q = dev_q.where(Device.site == site)
    devices = (await db.execute(dev_q)).scalars().all()
    total = len(devices)
    online = sum(1 for d in devices if d.status == "online")
    offline = sum(1 for d in devices if d.status == "offline")

    # Vendor breakdown
    vendor_counts: dict[str, int] = {}
    for d in devices:
        vendor_counts[d.vendor or "other"] = vendor_counts.get(d.vendor or "other", 0) + 1

    # Backup stats
    backed_up = sum(1 for d in devices if d.last_backup)
    stale = sum(1 for d in devices if d.last_backup and d.last_backup < since_7d)
    never = total - backed_up

    # Events 24h
    ev_result = await db.execute(
        select(NetworkEvent.severity, func.count())
        .where(NetworkEvent.created_at >= since_24h)
        .group_by(NetworkEvent.severity)
    )
    events_by_sev = {row[0]: row[1] for row in ev_result.fetchall()}

    # Tasks 7d
    task_result = await db.execute(
        select(Task.status, func.count())
        .where(Task.created_at >= since_7d)
        .group_by(Task.status)
    )
    tasks_by_status = {row[0]: row[1] for row in task_result.fetchall()}

    # Topology
    links = (await db.execute(select(func.count()).select_from(TopologyLink))).scalar()

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "devices": {
            "total": total, "online": online, "offline": offline,
            "unknown": total - online - offline,
            "by_vendor": vendor_counts,
            "backup_ok": backed_up - stale,
            "backup_stale": stale,
            "backup_never": never,
        },
        "events_24h": {
            "total": sum(events_by_sev.values()),
            "critical": events_by_sev.get("critical", 0),
            "warning": events_by_sev.get("warning", 0),
            "info": events_by_sev.get("info", 0),
        },
        "tasks_7d": {
            "success": tasks_by_status.get("success", 0),
            "failed": tasks_by_status.get("failed", 0),
            "partial": tasks_by_status.get("partial", 0),
            "total": sum(tasks_by_status.values()),
        },
        "topology": {"links": links, "nodes": total},
    }


@router.get("/devices")
async def report_devices(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    format: str = Query("json", description="json or csv"),
    site: str = Query(None),
):
    """Device inventory report."""
    dev_q = select(Device).where(Device.is_active == True).order_by(Device.hostname)
    if site:
        dev_q = dev_q.where(Device.site == site)
    devices = (await db.execute(dev_q)).scalars().all()

    rows = [
        {
            "hostname": d.hostname,
            "ip_address": d.ip_address,
            "vendor": d.vendor or "",
            "os_type": d.os_type or "",
            "model": d.model or "",
            "firmware_version": d.firmware_version or "",
            "serial_number": d.serial_number or "",
            "status": d.status or "",
            "location": d.location or "",
            "last_seen": d.last_seen.isoformat() if d.last_seen else "",
            "last_backup": d.last_backup.isoformat() if d.last_backup else "",
        }
        for d in devices
    ]

    if format == "csv":
        import csv, io
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        return Response(
            content=buf.getvalue().encode("utf-8-sig"),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="device_report.csv"'},
        )
    return {"total": len(rows), "items": rows}


@router.get("/events")
async def report_events(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    hours: int = Query(24),
    format: str = Query("json"),
):
    """Event history report."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    result = await db.execute(
        select(NetworkEvent)
        .where(NetworkEvent.created_at >= since)
        .order_by(NetworkEvent.created_at.desc())
        .limit(2000)
    )
    events = result.scalars().all()

    rows = [
        {
            "created_at": e.created_at.isoformat(),
            "event_type": e.event_type,
            "severity": e.severity,
            "title": e.title,
            "message": e.message or "",
            "device_hostname": e.device_hostname or "",
            "acknowledged": str(e.acknowledged),
        }
        for e in events
    ]

    if format == "csv":
        import csv, io
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        return Response(
            content=buf.getvalue().encode("utf-8-sig"),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="event_report.csv"'},
        )
    return {"total": len(rows), "items": rows, "hours": hours}


@router.get("/backups")
async def report_backups(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    tenant_filter: TenantFilter = None,
    format: str = Query("json"),
    site: str = Query(None),
):
    """Backup status report — one row per device."""
    dev_q = select(Device).where(Device.is_active == True).order_by(Device.hostname)
    if tenant_filter is not None:
        dev_q = dev_q.where(Device.tenant_id == tenant_filter)
    if site:
        dev_q = dev_q.where(Device.site == site)
    devices = (await db.execute(dev_q)).scalars().all()

    # Latest backup per device
    bkp_q = select(
        ConfigBackup.device_id,
        func.max(ConfigBackup.created_at).label("latest"),
        func.count().label("count"),
    ).group_by(ConfigBackup.device_id)
    if tenant_filter is not None:
        bkp_q = bkp_q.where(ConfigBackup.tenant_id == tenant_filter)
    backup_result = await db.execute(bkp_q)
    backup_map = {row.device_id: {"latest": row.latest, "count": row.count} for row in backup_result.fetchall()}

    now = datetime.now(timezone.utc)
    rows = []
    for d in devices:
        b = backup_map.get(d.id)
        if b:
            latest = b["latest"]
            if latest and latest.tzinfo is None:
                latest = latest.replace(tzinfo=timezone.utc)
            age_days = (now - latest).days if latest else None
            status = "ok" if latest and age_days is not None and age_days < 7 else "stale"
        else:
            age_days = None
            status = "never"
        rows.append({
            "device_id": d.id,
            "hostname": d.hostname,
            "ip_address": d.ip_address,
            "vendor": d.vendor or "",
            "backup_count": b["count"] if b else 0,
            "last_backup": b["latest"].isoformat() if b and b["latest"] else "",
            "age_days": age_days if age_days is not None else "",
            "status": status,
        })

    if format == "csv":
        import csv, io
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        return Response(
            content=buf.getvalue().encode("utf-8-sig"),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="backup_report.csv"'},
        )
    return {"total": len(rows), "items": rows}


@router.get("/backups/download-zip")
async def download_backups_zip(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    """Download latest config backup for every device as a single ZIP archive."""
    import io, zipfile

    bkp_subq_q = select(ConfigBackup.device_id, func.max(ConfigBackup.id).label("max_id")).group_by(ConfigBackup.device_id)
    if tenant_filter is not None:
        bkp_subq_q = bkp_subq_q.where(ConfigBackup.tenant_id == tenant_filter)
    subq = bkp_subq_q.subquery()

    zip_q = (
        select(ConfigBackup, Device.hostname)
        .join(Device, ConfigBackup.device_id == Device.id)
        .join(subq, (ConfigBackup.device_id == subq.c.device_id) & (ConfigBackup.id == subq.c.max_id))
        .where(Device.is_active == True)
        .order_by(Device.hostname)
    )
    if tenant_filter is not None:
        zip_q = zip_q.where(Device.tenant_id == tenant_filter)
    result = await db.execute(zip_q)
    rows = result.fetchall()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for backup, hostname in rows:
            date_str = backup.created_at.strftime("%Y%m%d_%H%M") if backup.created_at else "unknown"
            zf.writestr(f"{hostname}_{date_str}.txt", backup.config_text or "")

    buf.seek(0)
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="backups_{today}.zip"'},
    )


@router.get("/firmware")
async def report_firmware(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    format: str = Query("json"),
    site: str = Query(None),
):
    """Firmware compliance report — groups devices by vendor + firmware version."""
    from collections import defaultdict
    fw_q = select(Device).where(Device.is_active == True).order_by(Device.vendor, Device.firmware_version)
    if site:
        fw_q = fw_q.where(Device.site == site)
    devices = (await db.execute(fw_q)).scalars().all()

    groups: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    unknown = []
    for d in devices:
        if d.firmware_version:
            groups[d.vendor or "other"][d.firmware_version].append(d)
        else:
            unknown.append(d)

    result_items = []
    for vendor, versions in groups.items():
        version_list = sorted(versions.keys(), reverse=True)
        latest = version_list[0] if version_list else None
        for version, devs in versions.items():
            result_items.append({
                "vendor": vendor,
                "firmware_version": version,
                "is_latest": version == latest,
                "device_count": len(devs),
                "devices": [{"id": d.id, "hostname": d.hostname, "ip": d.ip_address, "status": d.status} for d in devs],
            })

    if format == "csv":
        import csv, io
        buf = io.StringIO()
        flat_rows = [
            {
                "vendor": item["vendor"],
                "firmware_version": item["firmware_version"],
                "is_latest": str(item["is_latest"]),
                "device_count": item["device_count"],
                "hostnames": ", ".join(d["hostname"] for d in item["devices"]),
                "ips": ", ".join(d["ip"] for d in item["devices"]),
            }
            for item in result_items
        ]
        if flat_rows:
            w = csv.DictWriter(buf, fieldnames=list(flat_rows[0].keys()))
            w.writeheader()
            w.writerows(flat_rows)
        return Response(
            content=buf.getvalue().encode("utf-8-sig"),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="firmware_report.csv"'},
        )

    return {
        "total_devices": len(devices),
        "with_firmware_info": len(devices) - len(unknown),
        "without_firmware_info": len(unknown),
        "unknown_devices": [{"hostname": d.hostname, "ip": d.ip_address, "vendor": d.vendor or ""} for d in unknown],
        "groups": result_items,
    }


@router.get("/uptime")
async def report_uptime(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    days: int = Query(7),
    site: str = Query(None),
):
    """Uptime trend — online/offline counts per day for last N days."""
    up_q = select(Device).where(Device.is_active == True)
    if site:
        up_q = up_q.where(Device.site == site)
    devices = (await db.execute(up_q)).scalars().all()

    now = datetime.now(timezone.utc)
    daily = []
    for i in range(days - 1, -1, -1):
        day_start = (now - timedelta(days=i)).replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        label = day_start.strftime("%d.%m")
        if i == 0:
            online = sum(1 for d in devices if d.status == "online")
            offline = sum(1 for d in devices if d.status == "offline")
        else:
            seen_on_day = sum(1 for d in devices if d.last_seen and day_start <= d.last_seen < day_end)
            online = seen_on_day
            offline = len(devices) - seen_on_day
        daily.append({"date": label, "online": online, "offline": offline, "total": len(devices)})

    current_online = sum(1 for d in devices if d.status == "online")
    avg_uptime_pct = round(current_online / len(devices) * 100, 1) if devices else 0

    return {
        "total_devices": len(devices),
        "current_online": current_online,
        "current_offline": len(devices) - current_online,
        "avg_uptime_pct": avg_uptime_pct,
        "daily": daily,
        "days": days,
    }


@router.get("/problematic-devices")
async def report_problematic_devices(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    days: int = Query(7, ge=1, le=90),
    limit: int = Query(25, ge=5, le=100),
    site: str = Query(None),
):
    """Top N most problematic devices by event count in last N days."""
    since = datetime.now(timezone.utc) - timedelta(days=days)

    prob_q = (
        select(
            NetworkEvent.device_id,
            NetworkEvent.device_hostname,
            func.count().label("event_count"),
            func.sum(case((NetworkEvent.severity == "critical", 1), else_=0)).label("critical_count"),
            func.sum(case((NetworkEvent.severity == "warning", 1), else_=0)).label("warning_count"),
            func.max(NetworkEvent.created_at).label("last_event"),
        )
        .where(NetworkEvent.created_at >= since)
        .where(NetworkEvent.device_id.isnot(None))
    )
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        prob_q = prob_q.where(NetworkEvent.device_id.in_(site_ids))
    prob_q = prob_q.group_by(NetworkEvent.device_id, NetworkEvent.device_hostname).order_by(desc("event_count")).limit(limit)

    rows = (await db.execute(prob_q)).fetchall()

    device_ids = [r[0] for r in rows]
    device_map: dict[int, Device] = {}
    if device_ids:
        devs = (await db.execute(
            select(Device).where(Device.id.in_(device_ids))
        )).scalars().all()
        device_map = {d.id: d for d in devs}

    items = []
    for r in rows:
        dev = device_map.get(r[0])
        items.append({
            "device_id": r[0],
            "hostname": r[1],
            "event_count": r[2],
            "critical_count": r[3],
            "warning_count": r[4],
            "last_event": r[5].isoformat() if r[5] else None,
            "ip_address": dev.ip_address if dev else None,
            "vendor": dev.vendor if dev else None,
            "status": dev.status if dev else "unknown",
            "layer": dev.layer if dev else None,
        })

    return {"days": days, "total": len(items), "items": items}


@router.get("/agent-health")
async def report_agent_health(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Agent health overview — status, heartbeat age, assigned device count."""
    from app.services.agent_manager import agent_manager

    agents = (await db.execute(
        select(Agent).where(Agent.is_active == True).order_by(Agent.name)
    )).scalars().all()

    device_counts: dict[str, int] = {}
    if agents:
        agent_ids = [a.id for a in agents]
        rows = (await db.execute(
            select(Device.agent_id, func.count().label("cnt"))
            .where(Device.agent_id.in_(agent_ids), Device.is_active == True)
            .group_by(Device.agent_id)
        )).fetchall()
        device_counts = {r[0]: r[1] for r in rows}

    now = datetime.now(timezone.utc)
    online_ids = set(agent_manager.online_agent_ids())
    items = []
    for a in agents:
        heartbeat_age_s = None
        if a.last_heartbeat:
            heartbeat_age_s = int((now - a.last_heartbeat).total_seconds())
        live = agent_manager.get_live_metrics(a.id) or {}
        items.append({
            "id": a.id,
            "name": a.name,
            "status": "online" if a.id in online_ids else "offline",
            "last_heartbeat": a.last_heartbeat.isoformat() if a.last_heartbeat else None,
            "heartbeat_age_s": heartbeat_age_s,
            "last_ip": a.last_ip,
            "platform": a.platform,
            "machine_hostname": a.machine_hostname,
            "version": a.version,
            "assigned_devices": device_counts.get(a.id, 0),
            "cpu_pct": live.get("cpu_pct"),
            "mem_pct": live.get("mem_pct"),
            "cmd_success": live.get("cmd_success", 0),
            "cmd_fail": live.get("cmd_fail", 0),
            "avg_latency_ms": live.get("avg_latency_ms"),
        })

    online_count = sum(1 for i in items if i["status"] == "online")
    return {
        "total": len(items),
        "online": online_count,
        "offline": len(items) - online_count,
        "items": items,
    }
