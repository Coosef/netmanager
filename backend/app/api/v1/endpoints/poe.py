"""T9 Tur 6B — PoE / Energy reporting.

Reads from `poe_port_snapshots` (populated by the snapshot beat task).

  GET  /poe/summary                — org-wide aggregation per device
  GET  /devices/{device_id}/poe    — per-port detail for one device
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.poe_port_snapshot import PoEPortSnapshot

router = APIRouter()

# A snapshot row is "stale" when it hasn't been refreshed in this long.
# The beat task runs every 15 min — give it 3× headroom before we warn.
STALE_AFTER = timedelta(minutes=45)


@router.post("/snapshot-now", status_code=202)
async def trigger_snapshot_now(_: CurrentUser = None):
    """T9 Tur 6B follow-up — operatörden tetiklenen anlık PoE snapshot.

    Beat task 15 dakikada bir çalışır; ilk kurulumda veya credential
    değişiminde 'şimdi çek' butonu için bu endpoint kullanılır. Celery
    task hemen kuyruğa girer; sonuç /poe/summary'de görünür.
    """
    from app.workers.tasks.poe_tasks import snapshot_poe_status
    snapshot_poe_status.delay()
    return {"queued": True, "message": "PoE snapshot kuyruğa alındı (SNMP-first, SSH fallback)."}


@router.get("/summary")
async def get_poe_summary(
    location_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Per-device PoE summary across the current org scope.

    Returns the device row plus:
      - total_ports: snapshotted PoE ports for the device
      - active_ports: ports with oper_status='on'
      - power_mw: sum of power_mw across active ports
    Also returns an org-wide aggregate and a 'stale_devices' count (devices
    whose latest PoE row is older than STALE_AFTER — beat task likely
    couldn't reach them).
    """
    snap_q = (
        select(
            PoEPortSnapshot.device_id.label("device_id"),
            func.count(PoEPortSnapshot.id).label("total_ports"),
            func.sum(
                case((PoEPortSnapshot.oper_status == "on", 1), else_=0)
            ).label("active_ports"),
            func.coalesce(
                func.sum(
                    case(
                        (PoEPortSnapshot.oper_status == "on", PoEPortSnapshot.power_mw),
                        else_=0,
                    )
                ),
                0,
            ).label("power_mw"),
            func.max(PoEPortSnapshot.updated_at).label("last_updated_at"),
        )
        .group_by(PoEPortSnapshot.device_id)
    )
    if location_id is not None:
        snap_q = snap_q.where(PoEPortSnapshot.location_id == location_id)

    rows = (await db.execute(snap_q)).all()
    device_ids = [r.device_id for r in rows]

    devices_map: dict[int, Device] = {}
    if device_ids:
        device_rows = (await db.execute(
            select(Device).where(Device.id.in_(device_ids))
        )).scalars().all()
        devices_map = {d.id: d for d in device_rows}

    now = datetime.now(timezone.utc)
    items = []
    total_power_mw = 0
    total_active = 0
    total_ports = 0
    stale_devices = 0
    for r in rows:
        d = devices_map.get(r.device_id)
        if d is None:
            # Dangling snapshot — device deleted, snapshot will be cascaded.
            continue
        # Tz-aware compare
        last = r.last_updated_at
        if last is not None and last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        is_stale = last is None or (now - last) > STALE_AFTER
        if is_stale:
            stale_devices += 1
        items.append({
            "device_id": d.id,
            "hostname": d.hostname,
            "ip_address": d.ip_address,
            "vendor": d.vendor,
            "os_type": d.os_type,
            "site": d.site,
            "location_id": d.location_id,
            "total_ports": int(r.total_ports or 0),
            "active_ports": int(r.active_ports or 0),
            "power_mw": int(r.power_mw or 0),
            "power_watts": round(int(r.power_mw or 0) / 1000.0, 1),
            "last_updated_at": last.isoformat() if last else None,
            "is_stale": is_stale,
        })
        total_power_mw += int(r.power_mw or 0)
        total_active += int(r.active_ports or 0)
        total_ports += int(r.total_ports or 0)

    items.sort(key=lambda x: x["power_mw"], reverse=True)

    return {
        "devices": items,
        "summary": {
            "device_count": len(items),
            "total_ports": total_ports,
            "active_ports": total_active,
            "total_power_mw": total_power_mw,
            "total_power_watts": round(total_power_mw / 1000.0, 1),
            "stale_devices": stale_devices,
        },
        "stale_threshold_minutes": int(STALE_AFTER.total_seconds() // 60),
    }


@router.get("/devices/{device_id}/realtime")
async def get_device_poe_realtime(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """T9 follow-up — anlık SSH `show power inline` ile GERÇEK mW.

    Cihaz vendor'ı standart MIB'in ötesinde mW raporlamıyorsa (Ruijie, Aruba)
    SNMP snapshot 0 W gösterir. Bu endpoint operatör bir cihaza drilldown
    yaptığında tetiklenir: SSH'le canlı çıktı çekilir, vendor parser ile
    gerçek port-level mW + port adı döndürülür. Snapshot tablosu da update
    edilir (kalıcı kayıt).
    """
    device = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    from app.services.ssh_manager import ssh_manager
    from app.services.topology_service import EXTENDED_COMMANDS, _parse_power_inline
    from app.models.poe_port_snapshot import PoEPortSnapshot
    from sqlalchemy import delete as _del

    os_cmds = EXTENDED_COMMANDS.get(device.os_type) or {}
    cmd = os_cmds.get("power")
    if not cmd:
        raise HTTPException(
            status_code=400,
            detail=f"{device.os_type} için 'show power inline' parser tanımlı değil.",
        )

    try:
        result = await ssh_manager.execute_command(device, cmd, read_timeout=20)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SSH hatası: {exc}")
    if not result.success or not result.output:
        raise HTTPException(
            status_code=502,
            detail=f"SSH komutu başarısız: {result.error or 'çıktı yok'}",
        )

    poe_rows = _parse_power_inline(result.output)
    if not poe_rows:
        raise HTTPException(
            status_code=502,
            detail="Komut çalıştı ama PoE satırı parse edilemedi (cihaz PoE-destekli değil olabilir).",
        )

    # Snapshot tablosunu da güncelle — kalıcı kayıt; bir sonraki SNMP
    # sweepi gerçek mW kullanmadığı için kullanıcı bu butonla manuel
    # senkronize tutar.
    now = datetime.now(timezone.utc)
    seen_ports: set[str] = set()
    items = []
    for port, info in poe_rows.items():
        seen_ports.add(port)
        existing = (await db.execute(
            select(PoEPortSnapshot).where(
                PoEPortSnapshot.device_id == device_id,
                PoEPortSnapshot.port == port,
            )
        )).scalar_one_or_none()
        oper = "on" if info["enabled"] else "off"
        power_mw = int(info.get("mw") or 0)
        if existing is None:
            db.add(PoEPortSnapshot(
                device_id=device_id, port=port,
                oper_status=oper, power_mw=power_mw,
                source="ssh",
            ))
        else:
            existing.oper_status = oper
            existing.power_mw = power_mw
            existing.source = "ssh"
            existing.updated_at = now
        items.append({
            "port": port, "oper_status": oper,
            "power_mw": power_mw,
            "power_watts": round(power_mw / 1000.0, 1),
        })
    await db.commit()

    active = [it for it in items if it["oper_status"] == "on"]
    return {
        "device": {
            "id": device.id, "hostname": device.hostname,
            "ip_address": device.ip_address, "vendor": device.vendor,
            "os_type": device.os_type,
        },
        "ports": items,
        "summary": {
            "total_ports": len(items),
            "active_ports": len(active),
            "total_power_mw": sum(it["power_mw"] for it in active),
            "total_power_watts": round(sum(it["power_mw"] for it in active) / 1000.0, 1),
        },
        "source": "ssh",
    }


@router.get("/devices/{device_id}")
async def get_device_poe(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Per-port PoE state for one device — latest snapshot."""
    device = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    rows = (await db.execute(
        select(PoEPortSnapshot)
        .where(PoEPortSnapshot.device_id == device_id)
        .order_by(PoEPortSnapshot.port.asc())
    )).scalars().all()

    items = [
        {
            "id": r.id,
            "port": r.port,
            "oper_status": r.oper_status,
            "admin_status": r.admin_status,
            "power_mw": r.power_mw,
            "power_watts": round((r.power_mw or 0) / 1000.0, 1),
            "max_mw": r.max_mw,
            "device_class": r.device_class,
            "source": r.source,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }
        for r in rows
    ]
    active = [it for it in items if it["oper_status"] == "on"]
    return {
        "device": {
            "id": device.id,
            "hostname": device.hostname,
            "ip_address": device.ip_address,
            "vendor": device.vendor,
            "os_type": device.os_type,
            "site": device.site,
        },
        "ports": items,
        "summary": {
            "total_ports": len(items),
            "active_ports": len(active),
            "total_power_mw": sum(it["power_mw"] or 0 for it in active),
            "total_power_watts": round(sum(it["power_mw"] or 0 for it in active) / 1000.0, 1),
        },
    }
