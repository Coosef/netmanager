import json
import re
import time
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.services.audit_service import log_action
from app.services.ssh_manager import ssh_manager

router = APIRouter()

_IFACE_CACHE_TTL = 300   # 5 minutes
_VLAN_CACHE_TTL  = 300


def _get_redis():
    import redis as _r
    return _r.from_url(settings.REDIS_URL, decode_responses=True, socket_timeout=2)


def _cache_get(key: str):
    try:
        raw = _get_redis().get(key)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _cache_set(key: str, value: dict, ttl: int):
    try:
        _get_redis().setex(key, ttl, json.dumps(value))
    except Exception:
        pass


def _scoped_cache_key(device_id: int, suffix: str) -> str:
    """Faz 8 phase A — namespace the per-device cache by organization so a
    key can never be shared across tenants."""
    from app.core.org_context import get_current_org_id
    return f"cache:device:o={get_current_org_id()}:{device_id}:{suffix}"


def _iface_cmd(os_type: str) -> str:
    if os_type in ("aruba_osswitch", "hp_procurve"):
        return "show interfaces brief"
    if os_type == "aruba_aoscx":
        return "show interface brief"
    return "show interfaces status"


def _vlan_cmd(os_type: str) -> str:
    if os_type in ("aruba_osswitch", "hp_procurve"):
        # Parse VLANs from running-config — more reliable than 'show vlans'
        # and includes port membership (tagged/untagged) directly
        return "show running-config"
    if os_type == "aruba_aoscx":
        return "show vlan"
    if os_type == "ruijie_os":
        return "show vlan"
    return "show vlan brief"


def _parse_interfaces(output: str, os_type: str) -> list[dict]:
    ifaces = []
    lines = output.splitlines()

    if os_type in ("cisco_ios", "cisco_xe", "cisco_nxos", "cisco_sg300", "generic"):
        # Standard Cisco format: Port  Desc  Status  Vlan  Duplex  Speed  Type
        header_idx = next(
            (i for i, l in enumerate(lines) if re.search(r'Port\s+.*Status', l, re.IGNORECASE)), -1
        )
        if header_idx >= 0:
            for line in lines[header_idx + 1:]:
                if not line.strip() or line.strip().startswith('-'):
                    continue
                m = re.match(
                    r'^(\S+)\s+(.*?)\s{2,}(connected|notconnect|err-disabled|disabled|inactive)\s+(\S+)\s+(\S+)\s+(\S+)',
                    line
                )
                if m:
                    ifaces.append({
                        "name": m.group(1), "description": m.group(2).strip(),
                        "status": m.group(3), "vlan": m.group(4),
                        "duplex": m.group(5), "speed": m.group(6),
                    })
                    continue
                parts = line.split()
                if len(parts) >= 3 and re.match(r'^(Gi|Fa|Te|Hu|Et|Po|Vl|Tun|Lo)', parts[0], re.IGNORECASE):
                    ifaces.append({
                        "name": parts[0], "description": "",
                        "status": parts[1] if len(parts) > 1 else "unknown",
                        "vlan": parts[2] if len(parts) > 2 else "",
                        "duplex": parts[3] if len(parts) > 3 else "",
                        "speed": parts[4] if len(parts) > 4 else "",
                    })

        if not ifaces:
            # Fallback: show ip interface brief
            for line in lines:
                m = re.match(
                    r'^(\S+)\s+(\S+)\s+\S+\s+\S+\s+(up|down|administratively down)\s+(up|down)', line
                )
                if m:
                    raw = m.group(3)
                    status = ("connected" if (raw == "up" and m.group(4) == "up")
                              else "disabled" if "administratively" in raw
                              else "notconnect")
                    ifaces.append({
                        "name": m.group(1), "description": "",
                        "status": status, "vlan": "", "duplex": "", "speed": "",
                    })

    elif os_type == "ruijie_os":
        # Ruijie format (fixed-width columns, interface names may contain spaces):
        # Interface                                Status    Vlan   Duplex   Speed     Type
        # ---------------------------------------- --------  ----   -------  --------- ------
        # GigabitEthernet 0/1                      up        2460   Full     1000M     copper
        header_idx = next(
            (i for i, l in enumerate(lines) if 'Interface' in l and 'Status' in l), -1
        )
        if header_idx >= 0:
            header = lines[header_idx]
            status_col = header.index('Status')
            for line in lines[header_idx + 1:]:
                if not line.strip() or line.strip().startswith('-'):
                    continue
                if len(line) < status_col:
                    continue
                name = line[:status_col].strip()
                rest = line[status_col:].split()
                if not name or not rest:
                    continue
                status_raw = rest[0].lower()
                # Normalize status
                status = ("connected" if status_raw == "up"
                          else "disabled" if status_raw == "disabled"
                          else "notconnect")
                ifaces.append({
                    "name": name,
                    "description": "",
                    "status": status,
                    "vlan": rest[1] if len(rest) > 1 else "",
                    "duplex": rest[2] if len(rest) > 2 else "",
                    "speed": rest[3] if len(rest) > 3 else "",
                })

    elif os_type in ("aruba_osswitch", "hp_procurve"):
        for line in lines:
            # Port names: 1, A1, B24, 1A, Trk1 (trunk), Trk10
            # One pipe separates port-info columns from flag/status columns
            m = re.match(r'^\s*([A-Za-z]{0,3}\d+[A-Za-z]?\d*)\s+(\S+)\s+\|.*\b(Up|Down|Disabled)\b', line, re.IGNORECASE)
            if m:
                ifaces.append({
                    "name": m.group(1), "description": "",
                    "status": m.group(3).lower(), "vlan": "",
                    "duplex": "", "speed": m.group(2),
                })

    elif os_type == "aruba_aoscx":
        for line in lines:
            m = re.match(r'^\s*(\S+)\s+(up|down)\s+(up|down|initialized)', line, re.IGNORECASE)
            if m:
                ifaces.append({
                    "name": m.group(1), "description": "",
                    "status": "connected" if m.group(2) == "up" else "notconnect",
                    "vlan": "", "duplex": "", "speed": "",
                })

    return ifaces


def _parse_vlans(output: str, os_type: str) -> list[dict]:
    vlans = []
    lines = output.splitlines()

    if os_type in ("cisco_ios", "cisco_xe", "cisco_nxos", "cisco_sg300", "generic"):
        # Cisco 'show vlan brief': left-aligned VLAN ID, status = active/suspend
        # 1    default  active  Gi0/1, Gi0/2
        current_vlan = None
        for line in lines:
            m = re.match(r'^(\d+)\s+(\S+)\s+(active|suspend|act/unsup|act/lshut)\s*(.*)', line)
            if m:
                ports_str = m.group(4).strip()
                ports = [p.strip() for p in ports_str.split(',')] if ports_str else []
                current_vlan = {
                    "id": int(m.group(1)), "name": m.group(2),
                    "status": m.group(3), "ports": ports,
                }
                vlans.append(current_vlan)
            elif current_vlan is not None:
                cont = re.match(r'^\s{10,}((?:\S+,?\s*)+)$', line)
                if cont:
                    extra = [p.strip() for p in cont.group(1).split(',') if p.strip()]
                    current_vlan["ports"].extend(extra)
                elif re.match(r'^VLAN\s+Type', line):
                    current_vlan = None

    elif os_type == "ruijie_os":
        # Ruijie 'show vlan': right-aligned VLAN ID, status = STATIC/DYNAMIC
        #          1 Default                          STATIC    Gi0/1, Gi0/2
        #                                                        Gi0/3, Gi0/4   (continuation, 50+ leading spaces)
        current_vlan = None
        for line in lines:
            # Primary VLAN entry line (may have leading spaces before the ID)
            m = re.match(r'^\s*(\d+)\s+(\S+)\s+(STATIC|DYNAMIC)\s*(.*)', line)
            if m:
                ports_str = m.group(4).strip().rstrip()
                ports = [p.strip() for p in ports_str.split(',') if p.strip()]
                current_vlan = {
                    "id": int(m.group(1)), "name": m.group(2),
                    "status": "active", "ports": ports,
                }
                vlans.append(current_vlan)
            elif current_vlan is not None and line.strip():
                # Continuation: 50+ leading spaces, then port list
                if len(line) - len(line.lstrip()) >= 50:
                    extra = [p.strip() for p in line.split(',') if p.strip() and not p.strip().startswith('-')]
                    current_vlan["ports"].extend(extra)
                elif re.match(r'^-+', line.strip()):
                    pass  # separator, skip
                else:
                    current_vlan = None

    elif os_type in ("aruba_osswitch", "hp_procurve"):
        # Parse from 'show running-config' VLAN blocks:
        #   vlan 70
        #      name "Yonetim"
        #      tagged 49-52
        #      untagged 1-30
        #      exit
        def _expand_port_ranges(port_str: str) -> list[str]:
            ports_out = []
            for seg in port_str.split(','):
                seg = seg.strip()
                if not seg:
                    continue
                rng = re.match(r'^(\d+)-(\d+)$', seg)
                if rng:
                    ports_out.extend(str(p) for p in range(int(rng.group(1)), int(rng.group(2)) + 1))
                elif re.match(r'^\d+$', seg):
                    ports_out.append(seg)
            return ports_out

        current_vlan: dict | None = None
        for line in lines:
            stripped = line.strip()
            # "vlan 70" — start of a VLAN block
            vm = re.match(r'^vlan\s+(\d+)\s*$', stripped)
            if vm:
                current_vlan = {
                    "id": int(vm.group(1)),
                    "name": f"VLAN{vm.group(1)}",
                    "status": "active",
                    "ports": [],
                }
                vlans.append(current_vlan)
                continue
            if current_vlan is None:
                continue
            # name "Yonetim"
            nm = re.match(r'name\s+"?(.+?)"?\s*$', stripped)
            if nm:
                current_vlan["name"] = nm.group(1)
                continue
            # tagged / untagged — but NOT "no tagged" / "no untagged"
            pm = re.match(r'^(tagged|untagged)\s+(.+)', stripped)
            if pm:
                current_vlan["ports"].extend(_expand_port_ranges(pm.group(2)))
                continue
            # "exit" or blank line ends the block
            if stripped in ('exit', '!', '') and stripped != '':
                current_vlan = None

    elif os_type == "aruba_aoscx":
        # show vlan: VLAN  Name  Status  Reason  Type  Interfaces
        current_vlan = None
        for line in lines:
            parts = line.split()
            if not parts:
                continue
            if parts[0].isdigit():
                # Interfaces column is after Type (index ≥5); rest may be comma-separated
                ifaces_str = " ".join(parts[5:]) if len(parts) > 5 else ""
                ports = [p.strip().rstrip(',') for p in ifaces_str.split(',') if p.strip()]
                current_vlan = {
                    "id": int(parts[0]),
                    "name": parts[1] if len(parts) > 1 else f"VLAN{parts[0]}",
                    "status": "active",
                    "ports": ports,
                }
                vlans.append(current_vlan)
            elif current_vlan is not None and not parts[0][0].isdigit():
                # Continuation line — more interfaces wrapped to next line
                extra = [p.strip().rstrip(',') for p in " ".join(parts).split(',') if p.strip()]
                if extra:
                    current_vlan["ports"].extend(extra)

    return vlans


# ─── Interfaces ──────────────────────────────────────────────────────────────

@router.get("/{device_id}/interfaces")
async def get_interfaces(
    device_id: int,
    force: bool = Query(False, description="Bypass cache and fetch live from device"),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    cache_key = _scoped_cache_key(device_id, "interfaces")
    if not force:
        cached = _cache_get(cache_key)
        if cached:
            return cached

    result = await ssh_manager.execute_command(device, _iface_cmd(device.os_type))
    if not result.success:
        return {"success": False, "interfaces": [], "error": result.error}

    response = {
        "success": True,
        "interfaces": _parse_interfaces(result.output, device.os_type),
        "raw": result.output,
        "fetched_at": time.time(),
        "cached": False,
    }
    _cache_set(cache_key, {**response, "cached": True}, _IFACE_CACHE_TTL)
    return response


@router.post("/{device_id}/interfaces/{interface_name:path}/toggle")
async def toggle_interface(
    device_id: int,
    interface_name: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    body = await request.json()
    action = body.get("action", "shutdown")
    if action not in ("shutdown", "no-shutdown"):
        raise HTTPException(status_code=400, detail="action must be 'shutdown' or 'no-shutdown'")

    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    cmd = "shutdown" if action == "shutdown" else "no shutdown"
    commands = [f"interface {interface_name}", cmd, "exit"]
    result = await ssh_manager.send_config(device, commands)

    await log_action(
        db, current_user, f"interface_{action.replace('-', '_')}", "device",
        device_id, device.hostname,
        details={"interface": interface_name, "action": action},
        request=request,
    )

    if not result.success:
        return {"success": False, "error": result.error}
    return {"success": True, "output": result.output}


# ─── VLANs ───────────────────────────────────────────────────────────────────

@router.get("/{device_id}/vlans")
async def get_vlans(
    device_id: int,
    force: bool = Query(False, description="Bypass cache and fetch live from device"),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    cache_key = _scoped_cache_key(device_id, "vlans")
    if not force:
        cached = _cache_get(cache_key)
        if cached:
            return cached

    result = await ssh_manager.execute_command(device, _vlan_cmd(device.os_type))
    if not result.success:
        return {"success": False, "vlans": [], "error": result.error}

    response = {
        "success": True,
        "vlans": _parse_vlans(result.output, device.os_type),
        "raw": result.output,
        "fetched_at": time.time(),
        "cached": False,
    }
    _cache_set(cache_key, {**response, "cached": True}, _VLAN_CACHE_TTL)
    return response


# ─── VLAN batch — DB SNAPSHOT (T8.4 v2) ────────────────────────────────────
# v1: her çağrı SSH (60+ cihazda 10-60 saniye, switch'lere her sayfa açılışında
# yük). v2: DB'den device_vlan_snapshots tablosunu okur. SSH yalnız kullanıcı
# "Tümünü Yenile" dediğinde tetiklenir (vlans-refresh endpoint'i). Snapshot
# yoksa frontend empty state gösterir + "İlk tarama" davet eder.

@router.post("/vlans-batch")
async def get_vlans_batch(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    body = await request.json()
    raw_ids = body.get("device_ids", [])
    try:
        device_ids = [int(x) for x in raw_ids]
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="device_ids must be a list of integers")
    if not device_ids:
        return {"items": {}, "from_snapshot": 0, "missing": 0,
                "newest_fetched_at": None, "oldest_fetched_at": None}
    if len(device_ids) > 500:
        raise HTTPException(status_code=400, detail="device_ids capped at 500 per batch")

    # 1) RLS-scoped device fetch — un-authorized IDs silently drop.
    devices = (await db.execute(
        select(Device).where(Device.id.in_(device_ids))
    )).scalars().all()
    dev_by_id = {d.id: d for d in devices}

    # 2) Read snapshots from DB (RLS already scoped).
    from app.models.device_vlan_snapshot import DeviceVlanSnapshot
    snapshots = (await db.execute(
        select(DeviceVlanSnapshot).where(
            DeviceVlanSnapshot.device_id.in_(device_ids)
        )
    )).scalars().all()
    snap_by_id = {s.device_id: s for s in snapshots}

    items: dict[str, dict] = {}
    from_snapshot = 0
    missing = 0
    fetched_ats: list[datetime] = []
    for did in device_ids:
        dev = dev_by_id.get(did)
        if not dev:
            items[str(did)] = {"success": False, "vlans": [], "error": "Cihaz bulunamadı"}
            continue
        snap = snap_by_id.get(did)
        if snap is None:
            # Snapshot yok — UI "henüz taranmadı" göstersin.
            items[str(did)] = {
                "success": False, "vlans": [],
                "error": "Henüz taranmadı — 'Tümünü Yenile' ile başlat",
                "no_snapshot": True,
            }
            missing += 1
            continue
        items[str(did)] = {
            "success": snap.error is None,
            "vlans": snap.vlans or [],
            "error": snap.error,
            "fetched_at": snap.fetched_at.isoformat(),
            "fetched_by": snap.fetched_by,
            "from_snapshot": True,
        }
        from_snapshot += 1
        fetched_ats.append(snap.fetched_at)

    return {
        "items": items,
        "from_snapshot": from_snapshot,
        "missing": missing,
        "newest_fetched_at": max(fetched_ats).isoformat() if fetched_ats else None,
        "oldest_fetched_at": min(fetched_ats).isoformat() if fetched_ats else None,
    }


# ─── VLAN refresh — STREAMING (NDJSON) + DB snapshot upsert + diff ────────
# Kullanıcı "Tümünü Yenile" dediğinde tetiklenir. asyncio.as_completed ile
# her cihaz tamamlandıkça frontend'e bir NDJSON satırı (newline-delimited
# JSON) yazılır → UI canlı progress bar + son tamamlanan cihaz adı +
# eklenen/silinen VLAN'ları anlık görür.
#
# Stream protokolü:
#   {"type":"start","total":N,"fetched_at":"...","fetched_by":"..."}
#   {"type":"device","device_id":X,"hostname":"...","status":"ok"|"error",
#       "added":[...], "removed":[...], "error":"...", "completed":i}
#   ... (N kere)
#   {"type":"complete","diff_summary":{...},"items":{...}}
#
# T8.4 bug fix — pg_insert SQLAlchemy Core; ORM before_insert hook'u
# bypass eder, organization_id otomatik dolmaz → NotNullViolation. Fix:
# her insert'te dev.organization_id + dev.location_id explicit set.

@router.post("/vlans-refresh")
async def refresh_vlans_batch(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    import asyncio
    from app.models.device_vlan_snapshot import DeviceVlanSnapshot
    from app.models.network_baseline import NetworkBaseline
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from fastapi.responses import StreamingResponse

    body = await request.json()
    raw_ids = body.get("device_ids", [])
    try:
        device_ids = [int(x) for x in raw_ids]
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="device_ids must be a list of integers")
    if not device_ids:
        raise HTTPException(status_code=400, detail="device_ids required")
    if len(device_ids) > 200:
        raise HTTPException(status_code=400, detail="device_ids capped at 200 per refresh")

    # Pre-stream sync DB work (devices + old snapshots)
    devices = (await db.execute(
        select(Device).where(Device.id.in_(device_ids))
    )).scalars().all()
    dev_by_id = {d.id: d for d in devices}

    old_snaps = (await db.execute(
        select(DeviceVlanSnapshot).where(
            DeviceVlanSnapshot.device_id.in_(device_ids)
        )
    )).scalars().all()
    old_vlan_ids: dict[int, set[int]] = {}
    for s in old_snaps:
        vids = set()
        for v in (s.vlans or []):
            try: vids.add(int(v.get("id")))
            except (TypeError, ValueError): pass
        old_vlan_ids[s.device_id] = vids

    user_label = getattr(current_user, "username", None) or str(getattr(current_user, "id", "?"))
    now = datetime.now(timezone.utc)

    async def fetch_one(dev: Device) -> tuple[Device, dict, list[int]]:
        try:
            result = await asyncio.wait_for(
                ssh_manager.execute_command(dev, _vlan_cmd(dev.os_type)),
                timeout=12.0,
            )
        except asyncio.TimeoutError:
            return dev, {"success": False, "error": "SSH zaman aşımı (12s)"}, []
        except Exception as exc:
            return dev, {"success": False, "error": str(exc)[:200]}, []
        if not result.success:
            return dev, {"success": False, "error": result.error}, []
        parsed = _parse_vlans(result.output, dev.os_type)
        vids = sorted({int(v["id"]) for v in parsed if v.get("id") is not None})
        return dev, {"success": True, "vlans": parsed}, vids

    sem = asyncio.Semaphore(10)
    async def bounded(d):
        async with sem:
            return await fetch_one(d)

    async def stream():
        # Start event
        yield json.dumps({
            "type": "start", "total": len(devices),
            "fetched_at": now.isoformat(), "fetched_by": user_label,
        }) + "\n"

        items: dict[str, dict] = {}
        diff_summary = {
            "added": 0, "removed": 0,
            "added_devices": 0, "removed_devices": 0,
            "errors": 0,
        }

        tasks = [asyncio.create_task(bounded(d)) for d in devices]
        completed = 0

        for coro in asyncio.as_completed(tasks):
            try:
                dev, payload, new_vids = await coro
            except Exception as exc:
                # asyncio.gather pattern altında bir task çökerse — sayım kayıt
                completed += 1
                yield json.dumps({
                    "type": "device", "device_id": None, "hostname": "?",
                    "status": "error", "error": str(exc)[:200],
                    "added": [], "removed": [],
                    "completed": completed, "total": len(devices),
                }) + "\n"
                diff_summary["errors"] += 1
                continue

            old_set = old_vlan_ids.get(dev.id, set())
            new_set = set(new_vids)
            added = sorted(new_set - old_set)
            removed = sorted(old_set - new_set)

            # T8.4 bug fix — Core insert ORM hook'u bypass eder; org/loc
            # explicit set. dev.organization_id Faz 7'de NOT NULL.
            org_id = dev.organization_id
            loc_id = dev.location_id

            if not payload.get("success"):
                err_msg = (payload.get("error") or "unknown")[:255]
                stmt = (
                    pg_insert(DeviceVlanSnapshot)
                    .values(
                        device_id=dev.id, vlans=[], error=err_msg,
                        fetched_at=now, fetched_by=user_label,
                        organization_id=org_id, location_id=loc_id,
                    )
                    .on_conflict_do_update(
                        constraint="uq_device_vlan_snapshot_device",
                        set_={"error": err_msg, "fetched_at": now, "fetched_by": user_label},
                    )
                )
                await db.execute(stmt)
                completed += 1
                items[str(dev.id)] = {
                    "success": False, "error": payload.get("error"),
                    "hostname": dev.hostname, "added": [], "removed": [],
                    "fetched_at": now.isoformat(),
                }
                diff_summary["errors"] += 1
                yield json.dumps({
                    "type": "device", "device_id": dev.id, "hostname": dev.hostname,
                    "status": "error", "error": payload.get("error"),
                    "added": [], "removed": [],
                    "completed": completed, "total": len(devices),
                }) + "\n"
            else:
                vlans_payload = payload.get("vlans", [])
                stmt = (
                    pg_insert(DeviceVlanSnapshot)
                    .values(
                        device_id=dev.id, vlans=vlans_payload, error=None,
                        fetched_at=now, fetched_by=user_label,
                        organization_id=org_id, location_id=loc_id,
                    )
                    .on_conflict_do_update(
                        constraint="uq_device_vlan_snapshot_device",
                        set_={"vlans": vlans_payload, "error": None,
                              "fetched_at": now, "fetched_by": user_label},
                    )
                )
                await db.execute(stmt)

                # T8.4 anomaly-source-of-truth fix — kullanıcı "Tümünü Yenile"
                # tetiklediğinde aldığımız canlı VLAN listesi yalnızca snapshot
                # tablosuna gidiyordu; behavior_analytics_tasks.detect_anomalies
                # ise NetworkBaseline.known_vlans'a bakıyor → günlük baseline
                # task'ı geç kaldığı sürece "Switch konfigürasyonunda OLMAYAN
                # VLAN" false-positive bağırıp duruyordu (prod'da VLAN 2416 →
                # 24h içinde 286 fire/45 cihaz). Refresh artık baseline'ı da
                # ground-truth olarak resetliyor: bir sonraki anomaly run'ı
                # gerçekten DEĞİŞMİŞ olanı bağıracak, geçmiş eko değil.
                baseline_stmt = (
                    pg_insert(NetworkBaseline)
                    .values(
                        device_id=dev.id, metric_type="vlan_count",
                        baseline_value=float(len(new_vids)), sample_count=1,
                        known_vlans=new_vids, last_updated=now,
                        organization_id=org_id, location_id=loc_id,
                    )
                    .on_conflict_do_update(
                        constraint="uq_baseline_device_metric",
                        set_={
                            "baseline_value": float(len(new_vids)),
                            "sample_count": NetworkBaseline.sample_count + 1,
                            "known_vlans": new_vids,
                            "last_updated": now,
                        },
                    )
                )
                await db.execute(baseline_stmt)

                completed += 1
                items[str(dev.id)] = {
                    "success": True, "hostname": dev.hostname,
                    "added": added, "removed": removed,
                    "fetched_at": now.isoformat(),
                }
                diff_summary["added"] += len(added)
                diff_summary["removed"] += len(removed)
                if added: diff_summary["added_devices"] += 1
                if removed: diff_summary["removed_devices"] += 1
                yield json.dumps({
                    "type": "device", "device_id": dev.id, "hostname": dev.hostname,
                    "status": "ok", "added": added, "removed": removed,
                    "completed": completed, "total": len(devices),
                }) + "\n"

        # Tek commit, tüm işlem sonunda
        await db.commit()

        yield json.dumps({
            "type": "complete",
            "diff_summary": diff_summary,
            "items": items,
            "fetched_at": now.isoformat(),
            "fetched_by": user_label,
        }) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@router.post("/{device_id}/vlans")
async def create_vlan(
    device_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    body = await request.json()
    vlan_id = int(body.get("vlan_id", 0))
    vlan_name = body.get("name", f"VLAN{vlan_id}")

    if not (2 <= vlan_id <= 4094):
        raise HTTPException(status_code=400, detail="vlan_id must be between 2 and 4094")

    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    result = await ssh_manager.send_config(device, [f"vlan {vlan_id}", f"name {vlan_name}", "exit"])

    await log_action(
        db, current_user, "vlan_created", "device", device_id, device.hostname,
        details={"vlan_id": vlan_id, "name": vlan_name},
        request=request,
    )

    if not result.success:
        return {"success": False, "error": result.error}
    return {"success": True, "vlan_id": vlan_id, "name": vlan_name}


@router.delete("/{device_id}/vlans/{vlan_id}")
async def delete_vlan(
    device_id: int,
    vlan_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    if vlan_id == 1:
        raise HTTPException(status_code=400, detail="Cannot delete VLAN 1")

    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    result = await ssh_manager.send_config(device, [f"no vlan {vlan_id}"])

    await log_action(
        db, current_user, "vlan_deleted", "device", device_id, device.hostname,
        details={"vlan_id": vlan_id},
        request=request,
    )

    if not result.success:
        return {"success": False, "error": result.error}
    return {"success": True}


@router.post("/{device_id}/interfaces/{interface_name:path}/vlan")
async def assign_vlan(
    device_id: int,
    interface_name: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    body = await request.json()
    vlan_id_raw = body.get("vlan_id")
    native_vlan_id = body.get("native_vlan_id")
    mode = body.get("mode", "access")

    if vlan_id_raw is None:
        raise HTTPException(status_code=400, detail="vlan_id is required")
    if mode not in ("access", "trunk"):
        raise HTTPException(status_code=400, detail="mode must be 'access' or 'trunk'")

    # Normalize to list; access only uses first element
    if isinstance(vlan_id_raw, list):
        vlan_ids = [int(v) for v in vlan_id_raw if v]
    else:
        vlan_ids = [int(vlan_id_raw)]

    if not vlan_ids:
        raise HTTPException(status_code=400, detail="vlan_id is required")

    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    os = device.os_type
    if os in ("aruba_osswitch", "hp_procurve"):
        if mode == "access":
            commands = [f"interface {interface_name}", f"untagged vlan {vlan_ids[0]}", "exit"]
        else:
            cmds = [f"interface {interface_name}"]
            for v in vlan_ids:
                cmds.append(f"tagged vlan {v}")
            cmds.append("exit")
            commands = cmds
    elif os == "aruba_aoscx":
        if mode == "access":
            commands = [f"interface {interface_name}", "no routing", f"vlan access {vlan_ids[0]}", "exit"]
        else:
            native = native_vlan_id or 1
            cmds = [f"interface {interface_name}", "no routing", f"vlan trunk native {native}"]
            for v in vlan_ids:
                cmds.append(f"vlan trunk allowed {v}")
            cmds.append("exit")
            commands = cmds
    else:
        # Cisco IOS / Ruijie / generic
        if mode == "access":
            commands = [
                f"interface {interface_name}",
                "switchport mode access",
                f"switchport access vlan {vlan_ids[0]}",
                "exit",
            ]
        else:
            vlan_str = ",".join(str(v) for v in vlan_ids)
            cmds = [
                f"interface {interface_name}",
                "switchport mode trunk",
                f"switchport trunk allowed vlan {vlan_str}",
            ]
            if native_vlan_id:
                cmds.append(f"switchport trunk native vlan {native_vlan_id}")
            cmds.append("exit")
            commands = cmds

    result = await ssh_manager.send_config(device, commands)

    await log_action(
        db, current_user, "interface_vlan_assigned", "device", device_id, device.hostname,
        details={"interface": interface_name, "vlan_ids": vlan_ids, "native_vlan_id": native_vlan_id, "mode": mode},
        request=request,
    )

    if not result.success:
        return {"success": False, "error": result.error}
    return {"success": True}
