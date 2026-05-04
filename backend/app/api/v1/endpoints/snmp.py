"""SNMP polling endpoints — interface stats and system health."""
import asyncio
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, LocationNameFilter
from app.core.security import decrypt_credential_safe
from app.models.device import Device
from app.models.snmp_metric import SnmpPollResult
from app.services import snmp_service
from app.services.ssh_manager import ssh_manager

router = APIRouter()


class BulkSnmpConfig(BaseModel):
    community: str
    version: str = "v2c"
    port: int = 161
    device_ids: Optional[List[int]] = None  # None = all active devices


@router.post("/trigger-poll", response_model=dict)
async def trigger_snmp_poll(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Manually trigger the SNMP poll Celery task. Returns immediately."""
    from app.workers.tasks.snmp_tasks import poll_snmp_all
    task = poll_snmp_all.delay()
    return {"task_id": task.id, "status": "queued"}


@router.post("/bulk-configure", response_model=dict)
async def bulk_configure_snmp(
    payload: BulkSnmpConfig,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Enable SNMP and set credentials for all (or selected) active devices (DB only, no SSH)."""
    if payload.device_ids:
        q = update(Device).where(
            Device.is_active == True,
            Device.id.in_(payload.device_ids),
        )
    else:
        q = update(Device).where(Device.is_active == True)

    result = await db.execute(
        q.values(
            snmp_enabled=True,
            snmp_community=payload.community,
            snmp_version=payload.version,
            snmp_port=payload.port,
        )
    )
    await db.commit()
    return {"updated": result.rowcount}


@router.post("/bulk-ssh-configure", response_model=dict)
async def bulk_ssh_configure(
    payload: BulkSnmpConfig,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """SSH into all (or selected) active devices and push SNMP configuration commands.
    Runs up to 10 connections in parallel. Updates DB only for devices that succeed."""
    from app.api.v1.endpoints.devices import _snmp_commands

    if payload.device_ids:
        q = select(Device).where(Device.is_active == True, Device.id.in_(payload.device_ids))
    else:
        q = select(Device).where(Device.is_active == True)
    devices = (await db.execute(q)).scalars().all()

    semaphore = asyncio.Semaphore(10)

    async def configure_one(device: Device) -> dict:
        async with semaphore:
            try:
                cmds = _snmp_commands(
                    device.os_type, payload.version, payload.community,
                    None, "sha", None, "aes128", None,
                )
            except ValueError as e:
                return {"device_id": device.id, "hostname": device.hostname,
                        "ip": device.ip_address, "success": False, "error": str(e)}
            try:
                result = await ssh_manager.send_config(device, cmds)
                if not result.success:
                    return {"device_id": device.id, "hostname": device.hostname,
                            "ip": device.ip_address, "success": False,
                            "error": result.error or "SSH komutları uygulanamadı"}
                # Save to NVRAM (best-effort)
                save_cmd = (
                    "copy running-config startup-config"
                    if device.os_type in ("cisco_ios", "cisco_nxos")
                    else "write memory"
                )
                await ssh_manager.execute_command(device, save_cmd)
                return {"device_id": device.id, "hostname": device.hostname,
                        "ip": device.ip_address, "success": True}
            except Exception as e:
                return {"device_id": device.id, "hostname": device.hostname,
                        "ip": device.ip_address, "success": False, "error": str(e)}

    results = list(await asyncio.gather(*[configure_one(d) for d in devices]))

    # Update DB for successful devices
    succeeded_ids = [r["device_id"] for r in results if r["success"]]
    if succeeded_ids:
        await db.execute(
            update(Device).where(Device.id.in_(succeeded_ids)).values(
                snmp_enabled=True,
                snmp_community=payload.community,
                snmp_version=payload.version,
                snmp_port=payload.port,
            )
        )
        await db.commit()

    succeeded = sum(1 for r in results if r["success"])
    return {
        "attempted": len(results),
        "succeeded": succeeded,
        "failed": len(results) - succeeded,
        "results": results,
    }


@router.get("/status", response_model=dict)
async def snmp_status(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Summary of SNMP-enabled devices and last poll time."""
    total = (await db.execute(select(func.count()).select_from(Device).where(Device.is_active == True))).scalar()
    enabled = (await db.execute(
        select(func.count()).select_from(Device).where(Device.is_active == True, Device.snmp_enabled == True)
    )).scalar()
    poll_count = (await db.execute(select(func.count()).select_from(SnmpPollResult))).scalar()
    last_poll = (await db.execute(
        select(func.max(SnmpPollResult.polled_at))
    )).scalar()
    return {
        "total_devices": total,
        "snmp_enabled": enabled,
        "poll_results": poll_count,
        "last_poll_at": last_poll.isoformat() if last_poll else None,
    }


async def _get_device_with_snmp(device_id: int, db: AsyncSession) -> Device:
    result = await db.execute(select(Device).where(Device.id == device_id, Device.is_active == True))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if not device.snmp_enabled:
        raise HTTPException(status_code=422, detail="SNMP not configured for this device")
    if device.snmp_version != "v3" and not device.snmp_community:
        raise HTTPException(status_code=422, detail="SNMP community string not set")
    if device.snmp_version == "v3" and not device.snmp_v3_username:
        raise HTTPException(status_code=422, detail="SNMPv3 username not configured")
    return device


def _v3_kwargs(device: Device) -> dict:
    return {
        "v3_username": device.snmp_v3_username,
        "v3_auth_protocol": device.snmp_v3_auth_protocol,
        "v3_auth_passphrase": decrypt_credential_safe(device.snmp_v3_auth_passphrase),
        "v3_priv_protocol": device.snmp_v3_priv_protocol,
        "v3_priv_passphrase": decrypt_credential_safe(device.snmp_v3_priv_passphrase),
    }


@router.get("/traffic-rates", response_model=dict)
async def traffic_rates(
    limit: int = Query(default=100, le=500),
    min_mbps: float = Query(default=0.0),
    site: str = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    location_filter: LocationNameFilter = None,
):
    """Return current throughput in Mbps per interface, calculated from the last two poll snapshots.
    Independent of stored utilization_pct — always accurate as long as counters advance."""
    if location_filter is not None:
        eff = [s for s in location_filter if not site or s == site] if site else location_filter
        if not eff:
            return {"items": [], "total": 0}
        site_clause = f"AND d.site = ANY(:sites)"
    elif site:
        site_clause = "AND d.site = :site"
    else:
        site_clause = ""
    sql = text(f"""
        WITH ranked AS (
            SELECT
                s.device_id, s.if_index, s.if_name, s.polled_at,
                s.in_octets, s.out_octets, s.speed_mbps,
                s.in_utilization_pct, s.out_utilization_pct,
                ROW_NUMBER() OVER (
                    PARTITION BY s.device_id, s.if_index ORDER BY s.polled_at DESC
                ) AS rn
            FROM snmp_poll_results s
            WHERE s.in_octets IS NOT NULL
        ),
        calc AS (
            SELECT
                l.device_id,
                d.hostname,
                d.ip_address,
                l.if_index,
                l.if_name,
                l.speed_mbps,
                l.in_utilization_pct,
                l.out_utilization_pct,
                l.polled_at,
                EXTRACT(EPOCH FROM (l.polled_at - p.polled_at)) AS elapsed_secs,
                CASE
                    WHEN p.in_octets IS NOT NULL
                         AND EXTRACT(EPOCH FROM (l.polled_at - p.polled_at)) > 0
                    THEN ROUND(
                        (GREATEST(l.in_octets - p.in_octets, 0) * 8.0
                         / EXTRACT(EPOCH FROM (l.polled_at - p.polled_at)) / 1000000.0)::numeric, 3)
                    ELSE 0.0
                END AS in_mbps,
                CASE
                    WHEN p.out_octets IS NOT NULL
                         AND EXTRACT(EPOCH FROM (l.polled_at - p.polled_at)) > 0
                    THEN ROUND(
                        (GREATEST(l.out_octets - p.out_octets, 0) * 8.0
                         / EXTRACT(EPOCH FROM (l.polled_at - p.polled_at)) / 1000000.0)::numeric, 3)
                    ELSE 0.0
                END AS out_mbps
            FROM (SELECT * FROM ranked WHERE rn = 1) l
            LEFT JOIN (SELECT * FROM ranked WHERE rn = 2) p
                ON l.device_id = p.device_id AND l.if_index = p.if_index
            JOIN devices d ON d.id = l.device_id AND d.is_active = true {site_clause}
        )
        SELECT * FROM calc
        WHERE (in_mbps + out_mbps) >= :min_mbps
        ORDER BY (in_mbps + out_mbps) DESC
        LIMIT :limit
    """)

    params: dict = {"min_mbps": min_mbps, "limit": limit}
    if location_filter is not None:
        params["sites"] = eff
    elif site:
        params["site"] = site
    rows = (await db.execute(sql, params)).mappings().all()

    items = []
    for row in rows:
        in_mbps = float(row["in_mbps"] or 0)
        out_mbps = float(row["out_mbps"] or 0)
        peak_mbps = max(in_mbps, out_mbps)
        speed = row["speed_mbps"]
        # Only show util% when speed is plausible (≥10 Mbps) to avoid misleading 100% from wrong OID data
        util_pct = None
        if speed and speed >= 10 and peak_mbps > 0:
            util_pct = round(min(peak_mbps / speed * 100, 100.0), 1)
        items.append({
            "device_id": row["device_id"],
            "hostname": row["hostname"],
            "ip_address": row["ip_address"],
            "if_index": row["if_index"],
            "if_name": row["if_name"],
            "speed_mbps": speed,
            "in_mbps": round(in_mbps, 2),
            "out_mbps": round(out_mbps, 2),
            "peak_mbps": round(peak_mbps, 2),
            "util_pct": util_pct,
            "elapsed_secs": round(float(row["elapsed_secs"] or 0)),
            "polled_at": row["polled_at"].isoformat(),
        })

    return {"items": items, "total": len(items)}


@router.get("/{device_id}/health", response_model=dict)
async def snmp_health(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Fetch sysDescr, sysName, sysUpTime via SNMP."""
    device = await _get_device_with_snmp(device_id, db)
    try:
        info = await snmp_service.get_system_info(
            host=device.ip_address,
            community=device.snmp_community or "",
            version=device.snmp_version,
            port=device.snmp_port,
            **_v3_kwargs(device),
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SNMP error: {e}")
    return info


@router.get("/{device_id}/interfaces", response_model=dict)
async def snmp_interfaces(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Fetch per-interface stats (oper status, speed, in/out octets, errors) via SNMP.
    Enriches each interface with the latest utilization % from stored poll snapshots."""
    device = await _get_device_with_snmp(device_id, db)
    try:
        ifaces = await snmp_service.get_interfaces(
            host=device.ip_address,
            community=device.snmp_community or "",
            version=device.snmp_version,
            port=device.snmp_port,
            **_v3_kwargs(device),
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SNMP error: {e}")

    # Enrich with the latest stored utilization from Celery poll snapshots
    util_map: dict[int, dict] = {}
    if ifaces:
        if_indexes = [ifc["if_index"] for ifc in ifaces if isinstance(ifc["if_index"], int)]
        if if_indexes:
            rows = (await db.execute(
                select(SnmpPollResult)
                .where(
                    SnmpPollResult.device_id == device_id,
                    SnmpPollResult.if_index.in_(if_indexes),
                    SnmpPollResult.in_utilization_pct.isnot(None),
                )
                .order_by(SnmpPollResult.polled_at.desc())
            )).scalars().all()

            seen: set[int] = set()
            for row in rows:
                if row.if_index not in seen:
                    seen.add(row.if_index)
                    util_map[row.if_index] = {
                        "in_utilization_pct": row.in_utilization_pct,
                        "out_utilization_pct": row.out_utilization_pct,
                        "last_polled_at": row.polled_at.isoformat(),
                    }

    for ifc in ifaces:
        idx = ifc["if_index"]
        if isinstance(idx, int) and idx in util_map:
            ifc.update(util_map[idx])
        else:
            ifc["in_utilization_pct"] = None
            ifc["out_utilization_pct"] = None
            ifc["last_polled_at"] = None

    return {"device_id": device_id, "hostname": device.hostname, "total": len(ifaces), "interfaces": ifaces}


@router.get("/{device_id}/cpu-ram", response_model=dict)
async def snmp_cpu_ram(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Fetch CPU utilization % and RAM used/total via SNMP.
    Tries vendor-specific OIDs (Cisco) first, falls back to HOST-RESOURCES-MIB."""
    device = await _get_device_with_snmp(device_id, db)
    try:
        data = await snmp_service.get_cpu_ram(
            host=device.ip_address,
            community=device.snmp_community or "",
            version=device.snmp_version,
            port=device.snmp_port,
            vendor=device.vendor,
            **_v3_kwargs(device),
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SNMP error: {e}")
    return {"device_id": device_id, **data}


@router.get("/top-interfaces", response_model=dict)
async def top_interfaces(
    limit: int = Query(default=20, le=100),
    threshold: float = Query(default=0.0),
    site: str = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Return the latest poll snapshot for the top-N interfaces by max(in_util, out_util).
    Also includes total bytes transferred (oldest→latest snapshot delta) and monitoring duration."""

    site_clause = "AND d.site = :site" if site else ""
    sql = text(f"""
        WITH latest AS (
            SELECT DISTINCT ON (device_id, if_index)
                device_id, if_index, polled_at,
                in_octets, out_octets,
                in_utilization_pct, out_utilization_pct,
                if_name, speed_mbps
            FROM snmp_poll_results
            WHERE in_utilization_pct IS NOT NULL OR out_utilization_pct IS NOT NULL
            ORDER BY device_id, if_index, polled_at DESC
        ),
        oldest AS (
            SELECT DISTINCT ON (device_id, if_index)
                device_id, if_index,
                polled_at AS oldest_at,
                in_octets  AS oldest_in,
                out_octets AS oldest_out
            FROM snmp_poll_results
            ORDER BY device_id, if_index, polled_at ASC
        )
        SELECT
            l.device_id,
            l.if_index,
            l.if_name,
            l.speed_mbps,
            l.polled_at,
            COALESCE(l.in_utilization_pct,  0.0) AS in_pct,
            COALESCE(l.out_utilization_pct, 0.0) AS out_pct,
            GREATEST(
                COALESCE(l.in_utilization_pct,  0.0),
                COALESCE(l.out_utilization_pct, 0.0)
            ) AS max_pct,
            CASE
                WHEN l.in_octets IS NOT NULL AND o.oldest_in IS NOT NULL
                THEN GREATEST(l.in_octets - o.oldest_in, 0)
                ELSE 0
            END AS in_bytes_total,
            CASE
                WHEN l.out_octets IS NOT NULL AND o.oldest_out IS NOT NULL
                THEN GREATEST(l.out_octets - o.oldest_out, 0)
                ELSE 0
            END AS out_bytes_total,
            COALESCE(
                EXTRACT(EPOCH FROM (l.polled_at - o.oldest_at)) / 3600.0,
                0.0
            ) AS monitoring_hours,
            d.hostname,
            d.ip_address
        FROM latest l
        JOIN oldest o ON l.device_id = o.device_id AND l.if_index = o.if_index
        JOIN devices d ON d.id = l.device_id AND d.is_active = true {site_clause}
        ORDER BY max_pct DESC
        LIMIT 2000
    """)

    params: dict = {}
    if site:
        params["site"] = site
    rows = (await db.execute(sql, params)).mappings().all()

    results = []
    for row in rows:
        max_pct = float(row["max_pct"])
        if max_pct < threshold:
            continue
        results.append({
            "device_id": row["device_id"],
            "hostname": row["hostname"],
            "ip_address": row["ip_address"],
            "if_index": row["if_index"],
            "if_name": row["if_name"],
            "speed_mbps": row["speed_mbps"],
            "in_pct": round(float(row["in_pct"]), 1),
            "out_pct": round(float(row["out_pct"]), 1),
            "max_pct": round(max_pct, 1),
            "in_bytes_total": int(row["in_bytes_total"] or 0),
            "out_bytes_total": int(row["out_bytes_total"] or 0),
            "monitoring_hours": round(float(row["monitoring_hours"] or 0), 1),
            "polled_at": row["polled_at"].isoformat(),
        })

    return {"items": results[:limit], "total": len(results)}


@router.get("/error-interfaces", response_model=dict)
async def error_interfaces(
    limit: int = Query(default=20, le=100),
    min_errors: int = Query(default=0, ge=0),
    site: str = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Return interfaces with the highest error delta between the last two SNMP polls."""
    site_clause = "AND d.site = :site" if site else ""
    sql = text(f"""
        WITH ranked AS (
            SELECT
                s.device_id, s.if_index, s.if_name, s.polled_at,
                s.in_errors, s.out_errors,
                ROW_NUMBER() OVER (
                    PARTITION BY s.device_id, s.if_index ORDER BY s.polled_at DESC
                ) AS rn
            FROM snmp_poll_results s
            WHERE s.in_errors IS NOT NULL
        ),
        latest AS (SELECT * FROM ranked WHERE rn = 1),
        prev   AS (SELECT * FROM ranked WHERE rn = 2)
        SELECT
            l.device_id,
            d.hostname,
            d.ip_address,
            l.if_index,
            l.if_name,
            GREATEST(l.in_errors  - p.in_errors,  0) AS in_err_delta,
            GREATEST(l.out_errors - p.out_errors, 0) AS out_err_delta,
            GREATEST(l.in_errors  - p.in_errors,  0)
                + GREATEST(l.out_errors - p.out_errors, 0) AS total_err_delta,
            EXTRACT(EPOCH FROM (l.polled_at - p.polled_at)) AS elapsed_secs,
            l.polled_at,
            l.in_errors  AS in_errors_total,
            l.out_errors AS out_errors_total
        FROM latest l
        JOIN prev p ON l.device_id = p.device_id AND l.if_index = p.if_index
        JOIN devices d ON d.id = l.device_id AND d.is_active = true {site_clause}
        WHERE (
            GREATEST(l.in_errors - p.in_errors, 0)
            + GREATEST(l.out_errors - p.out_errors, 0)
        ) >= :min_errors
        ORDER BY total_err_delta DESC
        LIMIT :limit
    """)

    params: dict = {"limit": limit, "min_errors": min_errors}
    if site:
        params["site"] = site
    rows = (await db.execute(sql, params)).mappings().all()

    items = []
    for row in rows:
        elapsed = float(row["elapsed_secs"] or 300)
        total_delta = int(row["total_err_delta"])
        errors_per_min = round(total_delta / elapsed * 60, 2) if elapsed > 0 else 0.0
        items.append({
            "device_id": row["device_id"],
            "hostname": row["hostname"],
            "ip_address": row["ip_address"],
            "if_index": row["if_index"],
            "if_name": row["if_name"],
            "in_err_delta": int(row["in_err_delta"]),
            "out_err_delta": int(row["out_err_delta"]),
            "total_err_delta": total_delta,
            "errors_per_min": errors_per_min,
            "in_errors_total": int(row["in_errors_total"] or 0),
            "out_errors_total": int(row["out_errors_total"] or 0),
            "polled_at": row["polled_at"].isoformat(),
        })

    return {"items": items, "total": len(items)}


@router.get("/{device_id}/error-history", response_model=dict)
async def snmp_error_history(
    device_id: int,
    if_index: int,
    limit: int = Query(default=24, le=96),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Return last N error-counter snapshots with deltas for a specific interface."""
    rows = (await db.execute(
        select(SnmpPollResult)
        .where(
            SnmpPollResult.device_id == device_id,
            SnmpPollResult.if_index == if_index,
            SnmpPollResult.in_errors.isnot(None),
        )
        .order_by(SnmpPollResult.polled_at.desc())
        .limit(limit)
    )).scalars().all()

    rows_asc = list(reversed(rows))
    history = []
    for i, row in enumerate(rows_asc):
        in_d = out_d = None
        if i > 0:
            prev = rows_asc[i - 1]
            if row.in_errors is not None and prev.in_errors is not None:
                in_d = max(0, row.in_errors - prev.in_errors)
                out_d = max(0, (row.out_errors or 0) - (prev.out_errors or 0))
        history.append({
            "ts": row.polled_at.isoformat(),
            "in_errors": row.in_errors,
            "out_errors": row.out_errors,
            "in_err_delta": in_d,
            "out_err_delta": out_d,
        })

    return {"device_id": device_id, "if_index": if_index, "history": history}


@router.get("/{device_id}/utilization-history", response_model=dict)
async def snmp_utilization_history(
    device_id: int,
    if_index: int,
    limit: int = 24,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Return the last N utilization snapshots for a specific interface (for sparkline/chart)."""
    device = await _get_device_with_snmp(device_id, db)
    rows = (await db.execute(
        select(SnmpPollResult)
        .where(
            SnmpPollResult.device_id == device.id,
            SnmpPollResult.if_index == if_index,
            SnmpPollResult.in_utilization_pct.isnot(None),
        )
        .order_by(SnmpPollResult.polled_at.desc())
        .limit(limit)
    )).scalars().all()

    return {
        "device_id": device_id,
        "if_index": if_index,
        "history": [
            {
                "ts": r.polled_at.isoformat(),
                "in_pct": r.in_utilization_pct,
                "out_pct": r.out_utilization_pct,
            }
            for r in reversed(rows)
        ],
    }
