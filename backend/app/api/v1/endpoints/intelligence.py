"""
Sprint 12 — Intelligence Fundamentals
  12A: Cihaz Risk Skoru / 12B: MTTR/MTBF / 12C: Zaman Çizelgesi

Sprint 13A — Root Cause Engine v2
  GET /intelligence/root-cause-incidents

Sprint 14A — Behavior Analytics
  GET /intelligence/anomalies — mac_anomaly / traffic_spike / vlan_anomaly / mac_loop_suspicion

Faz 6B — Caching layer + bulk-query fleet risk
  · /fleet/risk: 3 bulk SQL queries (was N+1), versioned cache key, SWR.
  · Per-device risk cache migrated from sync redis.from_url() to the
    async AggregationCache layer (no more event-loop blocking).
"""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import CurrentUser, LocationNameFilter, TenantFilter
from app.models.audit_log import AuditLog
from app.models.config_backup import ConfigBackup
from app.models.device import Device
from app.models.network_event import NetworkEvent
from app.models.security_audit import SecurityAudit
from app.services.cache import get_aggregation_cache

router = APIRouter()


# ── Cache config (Faz 6B) ─────────────────────────────────────────────────────
_RISK_DEVICE_TTL_SECS = 300                      # per-device, same as legacy
_RISK_DEVICE_STALE_SECS = 300                    # SWR window for per-device
_RISK_FLEET_VERSION_KEY = "agg:_version:risk_fleet"


def _loc_key_part(loc: Optional[list[str]]) -> str:
    """Stable, low-cardinality key segment for location_filter."""
    if loc is None:
        return "_"
    if not loc:
        return "empty"
    raw = "|".join(sorted(loc)).encode("utf-8")
    return hashlib.sha1(raw).hexdigest()[:8]


# ── helpers ──────────────────────────────────────────────────────────────────

def _risk_level(score: float) -> str:
    if score < 26:
        return "low"
    if score < 51:
        return "medium"
    if score < 76:
        return "high"
    return "critical"


async def _calc_risk_uncached(db: AsyncSession, device: Device, now: datetime) -> dict:
    since_7d = now - timedelta(days=7)

    # 1. Compliance — 25 puan ağırlık
    audit = (await db.execute(
        select(SecurityAudit)
        .where(SecurityAudit.device_id == device.id)
        .where(SecurityAudit.status == "done")
        .order_by(SecurityAudit.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    comp_score: Optional[int] = audit.score if audit else None
    comp_risk = (100 - comp_score) * 0.25 if comp_score is not None else 25.0

    # 2. Uptime son 7 gün — 30 puan ağırlık
    evt_rows = (await db.execute(
        select(NetworkEvent.event_type, NetworkEvent.created_at)
        .where(NetworkEvent.device_id == device.id)
        .where(NetworkEvent.event_type.in_(["device_offline", "device_online"]))
        .where(NetworkEvent.created_at >= since_7d)
        .order_by(NetworkEvent.created_at.asc())
    )).fetchall()

    offline_secs = 0.0
    offline_start: Optional[datetime] = None
    if evt_rows:
        if evt_rows[0][0] == "device_online":
            offline_start = since_7d
        for etype, ts in evt_rows:
            if etype == "device_offline":
                if offline_start is None:
                    offline_start = ts
            else:
                if offline_start is not None:
                    offline_secs += (ts - offline_start).total_seconds()
                    offline_start = None
        if offline_start is not None:
            offline_secs += (now - offline_start).total_seconds()

    uptime_pct = max(0.0, (7 * 86400 - offline_secs) / (7 * 86400) * 100)
    uptime_risk = (100 - uptime_pct) * 0.30

    # 3. Flapping son 7 gün — 20 puan ağırlık
    flap_count: int = (await db.execute(
        select(func.count()).select_from(NetworkEvent)
        .where(NetworkEvent.device_id == device.id)
        .where(NetworkEvent.event_type == "device_flapping")
        .where(NetworkEvent.created_at >= since_7d)
    )).scalar_one() or 0
    flap_risk = min(flap_count / 4.0, 1.0) * 20

    # 4. Yedek tazeliği — 25 puan ağırlık
    if device.last_backup:
        # ensure both are tz-aware for subtraction
        lb = device.last_backup
        if lb.tzinfo is None:
            lb = lb.replace(tzinfo=timezone.utc)
        days_ago = (now - lb).total_seconds() / 86400
        backup_risk = min(days_ago / 30.0, 1.0) * 25
    else:
        backup_risk = 25.0

    total = round(min(100.0, max(0.0, comp_risk + uptime_risk + flap_risk + backup_risk)), 1)

    return {
        "device_id": device.id,
        "hostname": device.hostname,
        "risk_score": total,
        "level": _risk_level(total),
        "breakdown": {
            "compliance": {
                "score": comp_score,
                "risk_contribution": round(comp_risk, 1),
                "weight": "25%",
            },
            "uptime_7d": {
                "uptime_pct": round(uptime_pct, 1),
                "risk_contribution": round(uptime_risk, 1),
                "weight": "30%",
            },
            "flapping_7d": {
                "flap_count": flap_count,
                "risk_contribution": round(flap_risk, 1),
                "weight": "20%",
            },
            "backup": {
                "last_backup": device.last_backup.isoformat() if device.last_backup else None,
                "risk_contribution": round(backup_risk, 1),
                "weight": "25%",
            },
        },
    }


async def _calc_risk(db: AsyncSession, device: Device, now: datetime) -> dict:
    """
    Per-device risk with async cache (Faz 6B).

    Replaces the legacy `redis.from_url(...).get/setex` pattern (sync I/O
    inside an async endpoint) with the AggregationCache layer. Cache key
    and TTL preserved (`agg:risk:device:{id}`, 5 min); SWR adds a 5 min
    stale window on top so concurrent reads don't stampede.
    """
    cache = get_aggregation_cache()
    cache_key = f"agg:risk:device:{device.id}"

    async def _compute() -> dict:
        return await _calc_risk_uncached(db, device, now)

    payload, _status = await cache.get_or_compute(
        key=cache_key,
        compute=_compute,
        fresh_secs=_RISK_DEVICE_TTL_SECS,
        stale_secs=_RISK_DEVICE_STALE_SECS,
        key_pattern="risk_device",
    )
    return payload


# ── Bulk risk (Faz 6B: N+1 → 3 queries) ──────────────────────────────────────

def _compute_risk_from_data(
    devices: list[Device],
    audit_scores: dict[int, int],
    events_by_device: dict[int, list[tuple[str, datetime]]],
    flap_counts: dict[int, int],
    now: datetime,
) -> list[dict]:
    """
    Pure helper — applies the original per-device risk formula against
    pre-fetched bulk data.  Result for each device is byte-identical to
    `_calc_risk_uncached(db, device, now)`.

    Weights (locked from Sprint 12A):
      Compliance 25% / Uptime-7d 30% / Flapping-7d 20% / Backup-freshness 25%
    """
    since_7d = now - timedelta(days=7)
    week_secs = 7 * 86400
    results: list[dict] = []
    for d in devices:
        # 1. Compliance — score absent → max risk contribution (25.0)
        score = audit_scores.get(d.id)
        comp_risk = (100 - score) * 0.25 if score is not None else 25.0

        # 2. Uptime 7d — same interval-reconstruction algorithm as the single-device path
        rows = events_by_device.get(d.id, [])
        offline_secs = 0.0
        offline_start: Optional[datetime] = None
        if rows:
            if rows[0][0] == "device_online":
                offline_start = since_7d
            for etype, ts in rows:
                if etype == "device_offline":
                    if offline_start is None:
                        offline_start = ts
                elif etype == "device_online":
                    if offline_start is not None:
                        offline_secs += (ts - offline_start).total_seconds()
                        offline_start = None
            if offline_start is not None:
                offline_secs += (now - offline_start).total_seconds()
        uptime_pct = max(0.0, (week_secs - offline_secs) / week_secs * 100)
        uptime_risk = (100 - uptime_pct) * 0.30

        # 3. Flapping — caps at 4 flaps/week = full weight
        fc = flap_counts.get(d.id, 0)
        flap_risk = min(fc / 4.0, 1.0) * 20

        # 4. Backup freshness — caps at 30 days = full weight; missing → max
        if d.last_backup:
            lb = d.last_backup
            if lb.tzinfo is None:
                lb = lb.replace(tzinfo=timezone.utc)
            days_ago = (now - lb).total_seconds() / 86400
            backup_risk = min(days_ago / 30.0, 1.0) * 25
        else:
            backup_risk = 25.0

        total = round(min(100.0, max(0.0, comp_risk + uptime_risk + flap_risk + backup_risk)), 1)
        results.append({
            "device_id": d.id,
            "hostname": d.hostname,
            "risk_score": total,
            "level": _risk_level(total),
            "breakdown": {
                "compliance": {
                    "score": score,
                    "risk_contribution": round(comp_risk, 1),
                    "weight": "25%",
                },
                "uptime_7d": {
                    "uptime_pct": round(uptime_pct, 1),
                    "risk_contribution": round(uptime_risk, 1),
                    "weight": "30%",
                },
                "flapping_7d": {
                    "flap_count": fc,
                    "risk_contribution": round(flap_risk, 1),
                    "weight": "20%",
                },
                "backup": {
                    "last_backup": d.last_backup.isoformat() if d.last_backup else None,
                    "risk_contribution": round(backup_risk, 1),
                    "weight": "25%",
                },
            },
        })
    return results


async def _calc_risk_bulk(
    db: AsyncSession,
    devices: list[Device],
    now: datetime,
) -> list[dict]:
    """
    Bulk risk calculation — 3 SQL queries for N devices.

    1. Latest `security_audits.score` per device via DISTINCT ON.
    2. `device_offline`/`device_online` events (last 7 days), ordered for grouping.
    3. `device_flapping` counts (last 7 days), grouped per device.

    Order is identical to `_calc_risk_uncached`; per-device results are
    byte-identical (asserted by parity tests).
    """
    if not devices:
        return []

    since_7d = now - timedelta(days=7)
    device_ids = [d.id for d in devices]

    # ── 1. Latest audit score per device (DISTINCT ON) ────────────────────────
    audit_rows = (await db.execute(
        select(SecurityAudit.device_id, SecurityAudit.score)
        .where(SecurityAudit.device_id.in_(device_ids))
        .where(SecurityAudit.status == "done")
        .distinct(SecurityAudit.device_id)
        .order_by(SecurityAudit.device_id.asc(), SecurityAudit.created_at.desc())
    )).fetchall()
    audit_scores: dict[int, int] = {did: score for did, score in audit_rows}

    # ── 2. Events bulk-fetch + group ──────────────────────────────────────────
    event_rows = (await db.execute(
        select(NetworkEvent.device_id, NetworkEvent.event_type, NetworkEvent.created_at)
        .where(NetworkEvent.device_id.in_(device_ids))
        .where(NetworkEvent.event_type.in_(["device_offline", "device_online"]))
        .where(NetworkEvent.created_at >= since_7d)
        .order_by(NetworkEvent.device_id.asc(), NetworkEvent.created_at.asc())
    )).fetchall()
    events_by_device: dict[int, list[tuple[str, datetime]]] = {}
    for did, etype, ts in event_rows:
        events_by_device.setdefault(did, []).append((etype, ts))

    # ── 3. Flap counts ────────────────────────────────────────────────────────
    flap_rows = (await db.execute(
        select(NetworkEvent.device_id, func.count())
        .where(NetworkEvent.device_id.in_(device_ids))
        .where(NetworkEvent.event_type == "device_flapping")
        .where(NetworkEvent.created_at >= since_7d)
        .group_by(NetworkEvent.device_id)
    )).fetchall()
    flap_counts: dict[int, int] = {did: int(cnt) for did, cnt in flap_rows}

    return _compute_risk_from_data(devices, audit_scores, events_by_device, flap_counts, now)


# ── 12A: Risk Score ───────────────────────────────────────────────────────────

@router.get("/devices/{device_id}/risk-score")
async def device_risk_score(
    device_id: int,
    _: CurrentUser,
    db: AsyncSession = Depends(get_db),
    tenant_filter: TenantFilter = None,
):
    """0-100 risk puanı ve breakdown — tek cihaz."""
    q = select(Device).where(Device.id == device_id)
    if tenant_filter is not None:
        q = q.where(Device.tenant_id == tenant_filter)
    device = (await db.execute(q)).scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")
    return await _calc_risk(db, device, datetime.now(timezone.utc))


_EMPTY_FLEET_RISK = {
    "summary": {
        "total_devices": 0, "avg_risk_score": 0,
        "critical": 0, "high": 0, "medium": 0, "low": 0,
    },
    "top_risky": [],
}


async def _compute_fleet_risk(
    db: AsyncSession,
    limit: int,
    location_filter: Optional[list[str]],
    tenant_filter,
) -> dict:
    """Cache-miss callback — fetches devices, runs bulk risk, aggregates."""
    dev_q = select(Device).where(Device.is_active == True)
    if tenant_filter is not None:
        dev_q = dev_q.where(Device.tenant_id == tenant_filter)
    if location_filter is not None:
        if not location_filter:
            return dict(_EMPTY_FLEET_RISK)
        dev_q = dev_q.where(Device.site.in_(location_filter))
    devices = (await db.execute(dev_q)).scalars().all()

    if not devices:
        return dict(_EMPTY_FLEET_RISK)

    now = datetime.now(timezone.utc)
    # Faz 6B: 3 bulk SQL queries instead of N+1 per-device cache lookups
    results = await _calc_risk_bulk(db, devices, now)
    results.sort(key=lambda x: x["risk_score"], reverse=True)

    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for r in results:
        counts[r["level"]] += 1

    return {
        "summary": {
            "total_devices": len(results),
            "avg_risk_score": round(sum(r["risk_score"] for r in results) / len(results), 1) if results else 0,
            **counts,
        },
        "top_risky": results[:limit],
    }


@router.get("/fleet/risk")
async def fleet_risk(
    request: Request,
    response: Response,
    _: CurrentUser,
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    location_filter: LocationNameFilter = None,
    tenant_filter: TenantFilter = None,
):
    """Tüm aktif cihazların risk skorları — cached (Faz 6B)."""
    bypass = request.headers.get("X-Cache-Bypass") == "1"

    cache = get_aggregation_cache()
    version = await cache.read_version(_RISK_FLEET_VERSION_KEY)
    cache_key = (
        f"agg:risk:fleet"
        f":v={version}"
        f":t={tenant_filter if tenant_filter is not None else '_'}"
        f":loc={_loc_key_part(location_filter)}"
        f":limit={limit}"
    )

    async def _compute() -> dict:
        return await _compute_fleet_risk(db, limit, location_filter, tenant_filter)

    payload, status = await cache.get_or_compute(
        key=cache_key,
        compute=_compute,
        fresh_secs=settings.AGG_CACHE_FRESH_SECS,
        stale_secs=settings.AGG_CACHE_STALE_SECS,
        key_pattern="risk_fleet",
        bypass=bypass,
    )
    response.headers["X-Cache-Status"] = status.value
    return payload


# ── 12B: MTTR / MTBF ─────────────────────────────────────────────────────────

@router.get("/devices/{device_id}/mttr-mtbf")
async def device_mttr_mtbf(
    device_id: int,
    _: CurrentUser,
    window_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    tenant_filter: TenantFilter = None,
):
    """
    MTTR (Ort. Kurtarma Süresi): her offline→online çiftinin süresi ortalaması.
    MTBF (Ort. Arıza Arası Süre): ardışık offline başlangıçları arasındaki süre ortalaması.
    """
    q = select(Device).where(Device.id == device_id)
    if tenant_filter is not None:
        q = q.where(Device.tenant_id == tenant_filter)
    device = (await db.execute(q)).scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")

    now = datetime.now(timezone.utc)
    since = now - timedelta(days=window_days)

    rows = (await db.execute(
        select(NetworkEvent.event_type, NetworkEvent.created_at)
        .where(NetworkEvent.device_id == device_id)
        .where(NetworkEvent.event_type.in_(["device_offline", "device_online"]))
        .where(NetworkEvent.created_at >= since)
        .order_by(NetworkEvent.created_at.asc())
    )).fetchall()

    # Build failure pairs
    outage_durations: list[float] = []   # seconds offline
    healthy_durations: list[float] = []  # seconds online between failures
    offline_ts: Optional[datetime] = None
    online_ts: Optional[datetime] = None

    for etype, ts in rows:
        if etype == "device_offline":
            if online_ts is not None:
                healthy_durations.append((ts - online_ts).total_seconds())
            offline_ts = ts
            online_ts = None
        else:  # device_online
            if offline_ts is not None:
                outage_durations.append((ts - offline_ts).total_seconds())
            online_ts = ts
            offline_ts = None

    failure_count = len(outage_durations)
    mttr_secs = (sum(outage_durations) / failure_count) if failure_count else None
    mtbf_secs = (sum(healthy_durations) / len(healthy_durations)) if healthy_durations else None

    def _fmt(secs: Optional[float]) -> Optional[str]:
        if secs is None:
            return None
        if secs < 60:
            return f"{int(secs)}s"
        if secs < 3600:
            return f"{int(secs / 60)}dk"
        if secs < 86400:
            return f"{secs / 3600:.1f}sa"
        return f"{secs / 86400:.1f}gün"

    return {
        "device_id": device_id,
        "hostname": device.hostname,
        "window_days": window_days,
        "failure_count": failure_count,
        "mttr_seconds": round(mttr_secs, 1) if mttr_secs is not None else None,
        "mttr_human": _fmt(mttr_secs),
        "mtbf_seconds": round(mtbf_secs, 1) if mtbf_secs is not None else None,
        "mtbf_human": _fmt(mtbf_secs),
        "currently_offline": offline_ts is not None and online_ts is None,
    }


# ── 12C: Birleşik Zaman Çizelgesi ────────────────────────────────────────────

@router.get("/devices/{device_id}/timeline")
async def device_timeline(
    device_id: int,
    _: CurrentUser,
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    tenant_filter: TenantFilter = None,
):
    """
    Network event + config backup + audit log kayıtlarını tek zaman çizelgesinde birleştirir.
    Config değişikliği → ardından gelen olay ilişkisi burada görülür.
    """
    q = select(Device).where(Device.id == device_id)
    if tenant_filter is not None:
        q = q.where(Device.tenant_id == tenant_filter)
    device = (await db.execute(q)).scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")

    now = datetime.now(timezone.utc)
    since = now - timedelta(days=days)

    # Network events
    events = (await db.execute(
        select(NetworkEvent)
        .where(NetworkEvent.device_id == device_id)
        .where(NetworkEvent.created_at >= since)
        .order_by(NetworkEvent.created_at.desc())
    )).scalars().all()

    # Config backups
    backups = (await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id)
        .where(ConfigBackup.created_at >= since)
        .order_by(ConfigBackup.created_at.desc())
    )).scalars().all()

    # Audit log
    audits = (await db.execute(
        select(AuditLog)
        .where(AuditLog.resource_type == "device")
        .where(AuditLog.resource_id == str(device_id))
        .where(AuditLog.created_at >= since)
        .order_by(AuditLog.created_at.desc())
    )).scalars().all()

    items: list[dict] = []

    for e in events:
        items.append({
            "id": f"event-{e.id}",
            "type": "event",
            "ts": e.created_at.isoformat(),
            "severity": e.severity,
            "event_type": e.event_type,
            "title": e.title,
            "message": e.message,
        })

    for b in backups:
        items.append({
            "id": f"backup-{b.id}",
            "type": "backup",
            "ts": b.created_at.isoformat(),
            "severity": "success" if b.is_golden else "info",
            "event_type": "config_backup",
            "title": f"Config Yedeği {'⭐ Altın Baseline' if b.is_golden else ''}".strip(),
            "message": f"{b.size_bytes} byte" if b.size_bytes else None,
        })

    for a in audits:
        items.append({
            "id": f"audit-{a.id}",
            "type": "audit",
            "ts": a.created_at.isoformat(),
            "severity": "info",
            "event_type": "audit",
            "title": f"{a.action}",
            "message": f"Kullanıcı: {a.username}",
        })

    # Zaman sırası (yeniden eskiye)
    items.sort(key=lambda x: x["ts"], reverse=True)

    # Korelasyon ipucu: config backup sonrasında <10dk içinde olay var mı?
    backup_times = [b.created_at for b in backups]
    for item in items:
        if item["type"] == "event":
            ts = datetime.fromisoformat(item["ts"])
            for bt in backup_times:
                if bt.tzinfo is None:
                    bt = bt.replace(tzinfo=timezone.utc)
                diff = (ts - bt).total_seconds()
                if 0 < diff < 600:
                    item["correlated_backup"] = True
                    item["correlation_hint"] = f"Config değişikliğinden {int(diff/60)}dk sonra"
                    break

    return {"device_id": device_id, "hostname": device.hostname, "items": items, "total": len(items)}


# ── 13A: Root Cause Incidents ─────────────────────────────────────────────────

@router.get("/root-cause-incidents")
async def root_cause_incidents(
    _: CurrentUser,
    hours: int = Query(24, ge=1, le=168),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    tenant_filter: TenantFilter = None,
):
    """
    Son N saatteki correlation_incident olaylarını döndürür.
    Her olay bir root cause cihazını ve etkilenen cihaz listesini içerir.
    """
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    q = (
        select(NetworkEvent)
        .where(NetworkEvent.event_type == "correlation_incident")
        .where(NetworkEvent.created_at >= since)
        .order_by(NetworkEvent.created_at.desc())
        .limit(limit)
    )
    if tenant_filter is not None:
        tenant_dev_ids = select(Device.id).where(Device.tenant_id == tenant_filter, Device.is_active == True)
        q = q.where(NetworkEvent.device_id.in_(tenant_dev_ids))
    rows = (await db.execute(q)).scalars().all()

    incidents = []
    for evt in rows:
        details = evt.details or {}
        incidents.append({
            "id": evt.id,
            "ts": evt.created_at.isoformat(),
            "root_device_id": details.get("root_device_id") or evt.device_id,
            "root_hostname": details.get("root_hostname") or evt.device_hostname or "?",
            "affected_count": details.get("affected_count", 0),
            "affected_devices": details.get("affected_devices", []),
            "suppressed_alerts": details.get("suppressed_alerts", 0),
            "title": evt.title,
            "message": evt.message,
            "acknowledged": evt.acknowledged,
        })

    return {
        "window_hours": hours,
        "total": len(incidents),
        "incidents": incidents,
    }


# ── 14A: Behavior Analytics — Anomaly Feed ───────────────────────────────────

_ANOMALY_TYPES = (
    "mac_anomaly", "traffic_spike", "vlan_anomaly", "mac_loop_suspicion",
    "topology_drift", "stp_anomaly", "loop_detected", "device_flapping",
)

_ANOMALY_LABEL = {
    "mac_anomaly":         "MAC Anomalisi",
    "traffic_spike":       "Trafik Spike",
    "vlan_anomaly":        "VLAN Anomalisi",
    "mac_loop_suspicion":  "Döngü Şüphesi",
    "topology_drift":      "Topoloji Drift",
    "stp_anomaly":         "STP Anomalisi",
    "loop_detected":       "Döngü Tespiti",
    "device_flapping":     "Cihaz Flapping",
}


@router.get("/anomalies")
async def get_anomalies(
    _: CurrentUser,
    hours: int = Query(24, ge=1, le=168),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    tenant_filter: TenantFilter = None,
):
    """
    Son N saatteki davranış anomalisi olaylarını döndürür.
    Tip başına sayaç + olay listesi içerir.
    """
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    q = (
        select(NetworkEvent)
        .where(NetworkEvent.event_type.in_(_ANOMALY_TYPES))
        .where(NetworkEvent.created_at >= since)
        .order_by(NetworkEvent.created_at.desc())
        .limit(limit)
    )
    if tenant_filter is not None:
        tenant_dev_ids = select(Device.id).where(Device.tenant_id == tenant_filter, Device.is_active == True)
        q = q.where(NetworkEvent.device_id.in_(tenant_dev_ids))
    rows = (await db.execute(q)).scalars().all()

    counts: dict[str, int] = {t: 0 for t in _ANOMALY_TYPES}
    events = []
    for evt in rows:
        counts[evt.event_type] = counts.get(evt.event_type, 0) + 1
        events.append({
            "id": evt.id,
            "ts": evt.created_at.isoformat(),
            "event_type": evt.event_type,
            "label": _ANOMALY_LABEL.get(evt.event_type, evt.event_type),
            "device_id": evt.device_id,
            "device_hostname": evt.device_hostname,
            "title": evt.title,
            "message": evt.message,
            "details": evt.details or {},
            "acknowledged": evt.acknowledged,
        })

    return {
        "window_hours": hours,
        "total": len(events),
        "counts": counts,
        "events": events,
    }
