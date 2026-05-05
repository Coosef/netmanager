from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, desc, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, TenantFilter, LocationNameFilter
from app.models.agent import Agent
from app.models.audit_log import AuditLog
from app.models.config_backup import ConfigBackup
from app.models.device import Device
from app.models.network_event import NetworkEvent

router = APIRouter()


@router.get("/analytics")
async def dashboard_analytics(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    tenant_filter: TenantFilter = None,
    location_filter: LocationNameFilter = None,
    site: Optional[str] = Query(None),
):
    """Operational intelligence for the smart dashboard."""
    now = datetime.now(timezone.utc)
    since_24h = now - timedelta(hours=24)
    since_7d = now - timedelta(days=7)

    # ── All active devices ───────────────────────────────────────────────────
    dev_q = select(Device).where(Device.is_active == True)
    if tenant_filter is not None:
        dev_q = dev_q.where(Device.tenant_id == tenant_filter)
    if location_filter is not None:
        eff = [s for s in location_filter if not site or s == site] if site else location_filter
        dev_q = dev_q.where(Device.site.in_(eff)) if eff else dev_q.where(text("false"))
        site = None
    if site:
        dev_q = dev_q.where(Device.site == site)
    devices = (await db.execute(dev_q)).scalars().all()
    total = len(devices)
    device_ids = [d.id for d in devices]
    site_filter = NetworkEvent.device_id.in_(device_ids) if site and device_ids else None
    site_filter_empty = site and not device_ids

    # ── Top N Problematic Devices (most events last 7d) ──────────────────────
    top_q = (
        select(
            NetworkEvent.device_id,
            NetworkEvent.device_hostname,
            func.count().label("event_count"),
            func.sum(case((NetworkEvent.severity == "critical", 1), else_=0)).label("critical_count"),
        )
        .where(NetworkEvent.created_at >= since_7d)
        .where(NetworkEvent.device_id.isnot(None))
        .group_by(NetworkEvent.device_id, NetworkEvent.device_hostname)
        .order_by(desc("event_count"))
        .limit(8)
    )
    if site_filter_empty:
        top_rows = []
    else:
        if site_filter is not None:
            top_q = top_q.where(site_filter)
        top_rows = (await db.execute(top_q)).fetchall()

    top_problematic = [
        {
            "device_id": r[0],
            "hostname": r[1],
            "event_count": r[2],
            "critical_count": r[3],
        }
        for r in top_rows
    ]

    # ── Flapping Devices (≥4 status changes in last 24h) ────────────────────
    flap_q = (
        select(
            NetworkEvent.device_id,
            NetworkEvent.device_hostname,
            func.count().label("flap_count"),
        )
        .where(NetworkEvent.created_at >= since_24h)
        .where(NetworkEvent.event_type.in_(["device_offline", "device_online"]))
        .where(NetworkEvent.device_id.isnot(None))
        .group_by(NetworkEvent.device_id, NetworkEvent.device_hostname)
        .having(func.count() >= 4)
        .order_by(desc("flap_count"))
    )
    if site_filter_empty:
        flap_rows = []
    else:
        if site_filter is not None:
            flap_q = flap_q.where(site_filter)
        flap_rows = (await db.execute(flap_q)).fetchall()

    flapping = [
        {"device_id": r[0], "hostname": r[1], "flap_count": r[2]}
        for r in flap_rows
    ]

    # ── Backup Compliance ────────────────────────────────────────────────────
    backup_ok = sum(1 for d in devices if d.last_backup and d.last_backup >= since_7d)
    backup_stale = sum(1 for d in devices if d.last_backup and d.last_backup < since_7d)
    backup_never = sum(1 for d in devices if not d.last_backup)

    never_backup_list = [
        {"id": d.id, "hostname": d.hostname, "ip": d.ip_address}
        for d in devices if not d.last_backup
    ][:8]

    # ── Never / Long-unseen Devices (>7d without contact) ───────────────────
    never_seen = [
        {
            "id": d.id,
            "hostname": d.hostname,
            "ip": d.ip_address,
            "last_seen": d.last_seen.isoformat() if d.last_seen else None,
        }
        for d in devices
        if not d.last_seen or d.last_seen < since_7d
    ][:10]

    # ── Firmware Posture ─────────────────────────────────────────────────────
    fw_map: dict[str, dict] = {}
    for d in devices:
        fw = d.firmware_version or "Bilinmiyor"
        vendor = d.vendor or "other"
        key = f"{vendor}|{fw}"
        if key not in fw_map:
            fw_map[key] = {"firmware": fw, "vendor": vendor, "count": 0, "hostnames": []}
        fw_map[key]["count"] += 1
        if len(fw_map[key]["hostnames"]) < 3:
            fw_map[key]["hostnames"].append(d.hostname)

    firmware_posture = sorted(fw_map.values(), key=lambda x: -x["count"])

    # ── Agent Health ─────────────────────────────────────────────────────────
    agents = (await db.execute(
        select(Agent).where(Agent.is_active == True)
    )).scalars().all()

    agent_health = []
    for a in agents:
        heartbeat_age_s = None
        if a.last_heartbeat:
            heartbeat_age_s = int((now - a.last_heartbeat).total_seconds())
        # Count devices assigned to this agent
        assigned = sum(1 for d in devices if d.agent_id == a.id)
        agent_health.append({
            "id": a.id,
            "name": a.name,
            "status": a.status,
            "last_heartbeat": a.last_heartbeat.isoformat() if a.last_heartbeat else None,
            "heartbeat_age_s": heartbeat_age_s,
            "platform": a.platform,
            "machine_hostname": a.machine_hostname,
            "assigned_devices": assigned,
            "warning": heartbeat_age_s is not None and heartbeat_age_s > 120,
        })

    # ── Change Summary (last 24h audit log) ──────────────────────────────────
    change_rows = (await db.execute(
        select(AuditLog.action, AuditLog.username, AuditLog.resource_name, AuditLog.created_at)
        .where(AuditLog.created_at >= since_24h)
        .order_by(AuditLog.created_at.desc())
        .limit(15)
    )).fetchall()

    recent_changes = [
        {
            "action": r[0],
            "username": r[1],
            "resource_name": r[2],
            "created_at": r[3].isoformat(),
        }
        for r in change_rows
    ]

    action_counts_rows = (await db.execute(
        select(AuditLog.action, func.count().label("cnt"))
        .where(AuditLog.created_at >= since_24h)
        .group_by(AuditLog.action)
        .order_by(desc("cnt"))
    )).fetchall()
    action_counts = {r[0]: r[1] for r in action_counts_rows}

    # ── Location / Vendor Risk ───────────────────────────────────────────────
    vendor_map: dict[str, dict] = {}
    for d in devices:
        v = d.vendor or "other"
        if v not in vendor_map:
            vendor_map[v] = {"vendor": v, "total": 0, "offline": 0, "no_backup": 0}
        vendor_map[v]["total"] += 1
        if d.status == "offline":
            vendor_map[v]["offline"] += 1
        if not d.last_backup:
            vendor_map[v]["no_backup"] += 1

    location_map: dict[str, dict] = {}
    for d in devices:
        loc = d.location or "Bilinmeyen"
        if loc not in location_map:
            location_map[loc] = {"location": loc, "total": 0, "offline": 0, "no_backup": 0}
        location_map[loc]["total"] += 1
        if d.status == "offline":
            location_map[loc]["offline"] += 1
        if not d.last_backup:
            location_map[loc]["no_backup"] += 1

    def risk_score(entry: dict) -> int:
        if entry["total"] == 0:
            return 0
        offline_r = entry["offline"] / entry["total"]
        backup_r = entry["no_backup"] / entry["total"]
        return int(offline_r * 60 + backup_r * 40)

    vendor_risk = sorted(
        [{"score": risk_score(v), **v} for v in vendor_map.values()],
        key=lambda x: -x["score"]
    )
    location_risk = sorted(
        [{"score": risk_score(v), **v} for v in location_map.values()],
        key=lambda x: -x["score"]
    )

    # ── Config Drift Summary ─────────────────────────────────────────────────
    # For each device that has a golden baseline, check if the latest backup differs
    golden_q = select(ConfigBackup.device_id, ConfigBackup.config_hash.label("golden_hash")).where(ConfigBackup.is_golden == True)
    if tenant_filter is not None:
        golden_q = golden_q.where(ConfigBackup.tenant_id == tenant_filter)
    golden_sub = (await db.execute(golden_q)).fetchall()
    golden_map = {r[0]: r[1] for r in golden_sub}

    drift_devices = []
    if golden_map:
        latest_q = (
            select(ConfigBackup.device_id, ConfigBackup.config_hash, ConfigBackup.created_at)
            .where(ConfigBackup.device_id.in_(list(golden_map.keys())))
            .order_by(ConfigBackup.device_id, ConfigBackup.created_at.desc())
        )
        if tenant_filter is not None:
            latest_q = latest_q.where(ConfigBackup.tenant_id == tenant_filter)
        latest_rows = (await db.execute(latest_q)).fetchall()
        seen: set[int] = set()
        for row in latest_rows:
            did, chash, cat = row
            if did in seen:
                continue
            seen.add(did)
            g_hash = golden_map[did]
            if chash != g_hash:
                dev = next((d for d in devices if d.id == did), None)
                drift_devices.append({
                    "device_id": did,
                    "hostname": dev.hostname if dev else str(did),
                    "latest_backup_at": cat.isoformat(),
                })

    config_drift = {
        "total_with_golden": len(golden_map),
        "drift_count": len(drift_devices),
        "clean_count": len(golden_map) - len(drift_devices),
        "drift_devices": drift_devices[:10],
    }

    return {
        "generated_at": now.isoformat(),
        "total_devices": total,
        "top_problematic": top_problematic,
        "flapping_devices": flapping,
        "backup_compliance": {
            "ok": backup_ok,
            "stale": backup_stale,
            "never": backup_never,
            "total": total,
            "never_list": never_backup_list,
        },
        "never_seen": never_seen,
        "firmware_posture": firmware_posture[:12],
        "agent_health": agent_health,
        "change_summary": {
            "action_counts": action_counts,
            "recent": recent_changes,
        },
        "risk": {
            "by_vendor": vendor_risk,
            "by_location": location_risk,
        },
        "config_drift": config_drift,
    }


@router.get("/snmp-summary")
async def snmp_summary(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """SNMP fleet overview: enabled count, last poll, top interfaces, critical/warning counts."""
    snmp_row = (await db.execute(
        select(
            func.count(Device.id).label("total"),
            func.sum(case((Device.snmp_enabled == True, 1), else_=0)).label("enabled"),
        ).where(Device.is_active == True)
    )).one()

    last_poll_row = (await db.execute(
        text("SELECT MAX(polled_at) AS last_poll FROM snmp_poll_results")
    )).one()

    counts_row = (await db.execute(text("""
        SELECT
            COUNT(*) FILTER (WHERE max_pct >= 80) AS critical_count,
            COUNT(*) FILTER (WHERE max_pct >= 50 AND max_pct < 80) AS warning_count,
            COUNT(*) AS total_interfaces
        FROM (
            SELECT DISTINCT ON (device_id, if_index)
                GREATEST(COALESCE(in_utilization_pct,0), COALESCE(out_utilization_pct,0)) AS max_pct
            FROM snmp_poll_results
            WHERE polled_at >= NOW() - INTERVAL '10 minutes'
            ORDER BY device_id, if_index, polled_at DESC
        ) sub
    """))).one()

    top_rows = (await db.execute(text("""
        SELECT s.device_id, d.hostname, s.if_index, s.if_name,
               s.in_utilization_pct, s.out_utilization_pct,
               GREATEST(COALESCE(s.in_utilization_pct,0), COALESCE(s.out_utilization_pct,0)) AS max_pct
        FROM (
            SELECT DISTINCT ON (device_id, if_index)
                device_id, if_index, if_name, in_utilization_pct, out_utilization_pct, polled_at
            FROM snmp_poll_results
            WHERE polled_at >= NOW() - INTERVAL '10 minutes'
              AND (in_utilization_pct IS NOT NULL OR out_utilization_pct IS NOT NULL)
            ORDER BY device_id, if_index, polled_at DESC
        ) s
        JOIN devices d ON d.id = s.device_id
        ORDER BY max_pct DESC
        LIMIT 8
    """))).mappings().all()

    total_traffic = (await db.execute(text("""
        WITH latest AS (
            SELECT DISTINCT ON (device_id, if_index)
                device_id, if_index, in_octets, out_octets
            FROM snmp_poll_results
            ORDER BY device_id, if_index, polled_at DESC
        ),
        oldest AS (
            SELECT DISTINCT ON (device_id, if_index)
                device_id, if_index, in_octets, out_octets
            FROM snmp_poll_results
            WHERE polled_at >= NOW() - INTERVAL '24 hours'
            ORDER BY device_id, if_index, polled_at ASC
        )
        SELECT
            COALESCE(SUM(GREATEST(l.in_octets - o.in_octets, 0)), 0) AS total_in_bytes,
            COALESCE(SUM(GREATEST(l.out_octets - o.out_octets, 0)), 0) AS total_out_bytes
        FROM latest l
        JOIN oldest o USING (device_id, if_index)
        WHERE l.in_octets IS NOT NULL AND o.in_octets IS NOT NULL
    """))).one()

    return {
        "snmp_enabled": int(snmp_row.enabled or 0),
        "total_devices": int(snmp_row.total or 0),
        "last_poll_at": last_poll_row.last_poll.isoformat() if last_poll_row.last_poll else None,
        "critical_interfaces": int(counts_row.critical_count or 0),
        "warning_interfaces": int(counts_row.warning_count or 0),
        "total_interfaces": int(counts_row.total_interfaces or 0),
        "total_in_bytes_24h": float(total_traffic.total_in_bytes or 0),
        "total_out_bytes_24h": float(total_traffic.total_out_bytes or 0),
        "top_interfaces": [
            {
                "device_id": r["device_id"],
                "hostname": r["hostname"],
                "if_index": r["if_index"],
                "if_name": r["if_name"],
                "in_pct": round(float(r["in_utilization_pct"] or 0), 1),
                "out_pct": round(float(r["out_utilization_pct"] or 0), 1),
                "max_pct": round(float(r["max_pct"] or 0), 1),
            }
            for r in top_rows
        ],
    }


@router.get("/sparklines")
async def dashboard_sparklines(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """24-hour hourly event counts for sparkline charts."""
    rows = (await db.execute(
        select(
            func.date_trunc("hour", NetworkEvent.created_at).label("hour"),
            func.count().label("cnt"),
        )
        .where(NetworkEvent.created_at >= datetime.now(timezone.utc) - timedelta(hours=24))
        .group_by(text("1"))
        .order_by(text("1"))
    )).mappings().all()

    now = datetime.now(timezone.utc)
    hourly: dict = {
        r["hour"].replace(minute=0, second=0, microsecond=0, tzinfo=timezone.utc): int(r["cnt"])
        for r in rows
    }
    points = []
    for i in range(24):
        h = (now - timedelta(hours=23 - i)).replace(minute=0, second=0, microsecond=0)
        points.append({"hour": h.isoformat(), "count": hourly.get(h, 0)})

    return {"events_24h": points}


@router.get("/snmp-chart")
async def snmp_chart(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Hourly average in/out utilization across all interfaces for the last 24 hours."""
    rows = (await db.execute(text("""
        SELECT
            date_trunc('hour', polled_at AT TIME ZONE 'UTC') AS hour,
            ROUND(AVG(in_utilization_pct)::numeric, 2)  AS avg_in,
            ROUND(AVG(out_utilization_pct)::numeric, 2) AS avg_out,
            COUNT(DISTINCT device_id) AS device_count
        FROM snmp_poll_results
        WHERE polled_at >= NOW() - INTERVAL '24 hours'
          AND (in_utilization_pct IS NOT NULL OR out_utilization_pct IS NOT NULL)
        GROUP BY hour
        ORDER BY hour
    """))).mappings().all()

    return {
        "points": [
            {
                "hour": r["hour"].isoformat(),
                "avg_in": float(r["avg_in"] or 0),
                "avg_out": float(r["avg_out"] or 0),
                "device_count": int(r["device_count"] or 0),
            }
            for r in rows
        ]
    }
