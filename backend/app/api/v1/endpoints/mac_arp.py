"""MAC Address Table & ARP Table collection and query endpoints."""
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select, delete as _del, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.mac_arp import ArpEntry, MacAddressEntry
from app.services.audit_service import log_action
from app.services.ssh_manager import ssh_manager
from app.services import oui_service

router = APIRouter()


# ── MAC normalization ────────────────────────────────────────────────────────

def _normalize_mac(raw: str) -> str:
    """Convert any MAC format to aa:bb:cc:dd:ee:ff lowercase."""
    digits = re.sub(r"[^0-9a-fA-F]", "", raw)
    if len(digits) != 12:
        return raw.lower()
    return ":".join(digits[i:i+2] for i in range(0, 12, 2)).lower()


# ── SSH parsers ──────────────────────────────────────────────────────────────

def _parse_mac_table(output: str, vendor: str) -> list[dict]:
    """Return list of {mac, vlan, port, entry_type} dicts."""
    entries = []
    seen = set()

    # Ruijie RGOS 5-column format: "  1  105f.02b0.3baa  DYNAMIC  AggregatePort 4  0d 14:49:46"
    # Live Time column (\d+d) is mandatory anchor — prevents false matches on 4-column Cisco output.
    # Interface names like "AggregatePort 4" or "TFGigabitEthernet 0/37" contain a space before the number.
    ruijie_rgos_pat = re.compile(
        r"^\s*(\d+)\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(\S+)\s+"
        r"((?:AggregatePort|TFGigabitEthernet|TenGigabitEthernet|GigabitEthernet|FastEthernet|Ethernet)"
        r"(?:\s+[\d/]+)?)"
        r"\s+\d+d",
        re.MULTILINE | re.IGNORECASE,
    )
    # Cisco IOS / IOS-XE: "   1  0010.1111.2222    DYNAMIC     Gi1/0/1"
    cisco_pat = re.compile(
        r"^\s*(\d+)\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(\S+)\s+(\S+)",
        re.MULTILINE,
    )
    # Ruijie dot-format without Live Time (fallback)
    ruijie_dot_pat = re.compile(
        r"^(\d+)\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(\S+)\s+(.+?)\s*$",
        re.MULTILINE,
    )
    # Ruijie RGOS colon-format: "2460  98:4a:6b:c6:ec:89  Dynamic  AggregatePort 1"
    ruijie_colon_pat = re.compile(
        r"^(\d+)\s+([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})\s+(\S+)\s+(.+?)\s*$",
        re.MULTILINE,
    )
    # Aruba ProCurve / AOS-CX: full port name capture
    aruba_pat = re.compile(
        r"^\s*(\d+)\s+([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})\s+(\S+)\s+(.+?)\s*$",
        re.MULTILINE,
    )
    # Generic dot-format fallback
    generic_pat = re.compile(
        r"(\d+)\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(\S+)\s+(\S+)",
        re.MULTILINE,
    )

    for pat in [ruijie_rgos_pat, cisco_pat, ruijie_dot_pat, ruijie_colon_pat, aruba_pat, generic_pat]:
        for m in pat.finditer(output):
            vlan_str, raw_mac, etype, port = m.group(1), m.group(2), m.group(3), m.group(4).strip()
            mac = _normalize_mac(raw_mac)
            key = (mac, port)
            if key in seen:
                continue
            seen.add(key)
            try:
                vlan = int(vlan_str)
            except ValueError:
                vlan = None
            entries.append({
                "mac_address": mac,
                "vlan_id": vlan,
                "port": port,
                "entry_type": etype.lower() if etype.lower() in ("dynamic", "static", "self") else "dynamic",
            })
        if entries:
            break

    return entries


def _parse_arp_table(output: str) -> list[dict]:
    """Return list of {ip, mac, interface} dicts."""
    entries = []
    seen = set()

    # Cisco: "Internet  10.0.0.1   5   0000.1234.5678  ARPA  Gi0/0"
    cisco_pat = re.compile(
        r"Internet\s+([\d.]+)\s+\S+\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+\S+\s*(\S*)",
        re.MULTILINE,
    )
    # Aruba ProCurve: "10.0.0.1  aabbcc-ddeeff  dynamic  1"  (6+6 hex with one hyphen)
    aruba_arp_pat = re.compile(
        r"((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-fA-F]{6}-[0-9a-fA-F]{6})\s*(\S*)",
        re.MULTILINE,
    )
    # Colon-format MACs: "10.0.0.1  aa:bb:cc:dd:ee:ff  eth0"
    colon_pat = re.compile(
        r"((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})\s*(\S*)",
        re.MULTILINE,
    )
    # Ruijie / Generic: "10.0.0.1  00d0.1111.2222  Gi0/1 ..."
    generic_pat = re.compile(
        r"((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}|\S{17})\s*(\S*)",
        re.MULTILINE,
    )

    for pat in [cisco_pat, aruba_arp_pat, colon_pat, generic_pat]:
        for m in pat.finditer(output):
            ip, raw_mac, iface = m.group(1), m.group(2), m.group(3).strip() if len(m.groups()) >= 3 else ""
            mac = _normalize_mac(raw_mac)
            if mac == "ff:ff:ff:ff:ff:ff" or mac.startswith("01:"):
                continue
            key = (ip, mac)
            if key in seen:
                continue
            seen.add(key)
            entries.append({"ip_address": ip, "mac_address": mac, "interface": iface or None})
        if entries:
            break

    return entries


# ── Collection helper ────────────────────────────────────────────────────────

async def _collect_device(device: Device, db: AsyncSession) -> dict:
    """SSH to device, collect MAC + ARP, upsert DB. Returns stats dict."""
    now = datetime.now(timezone.utc)
    mac_count = arp_count = mac_errors = arp_errors = 0

    # --- MAC table ---
    mac_cmd = "show mac address-table" if device.vendor in ("cisco", "other", "fortinet", "paloalto") else "display mac-address"
    if device.vendor == "ruijie":
        mac_cmd = "show mac-address-table"
    elif device.vendor == "aruba":
        # ProCurve uses 'show mac-address', AOS-CX uses 'show mac-address-table'
        if device.os_type == "aruba_aoscx":
            mac_cmd = "show mac-address-table"
        else:
            mac_cmd = "show mac-address"

    mac_result = await ssh_manager.execute_command(device, mac_cmd)
    if mac_result.success:
        parsed_macs = _parse_mac_table(mac_result.output, device.vendor)

        # Mark existing entries for this device as inactive before upsert
        await db.execute(
            _del(MacAddressEntry).where(MacAddressEntry.device_id == device.id)
        )

        for entry in parsed_macs:
            vendor = oui_service.lookup(entry["mac_address"])
            dtype = oui_service._classify_vendor(vendor) if vendor else "other"
            db.add(MacAddressEntry(
                device_id=device.id,
                device_hostname=device.hostname,
                mac_address=entry["mac_address"],
                vlan_id=entry.get("vlan_id"),
                port=entry.get("port"),
                entry_type=entry.get("entry_type", "dynamic"),
                oui_vendor=vendor,
                device_type=dtype,
                first_seen=now,
                last_seen=now,
            ))
        mac_count = len(parsed_macs)
    else:
        mac_errors = 1

    # --- ARP table ---
    arp_cmd = "show arp"
    if device.vendor == "h3c":
        arp_cmd = "display arp"
    # Ruijie RGOS uses Cisco-like 'show arp' syntax, not Comware 'display arp'

    arp_result = await ssh_manager.execute_command(device, arp_cmd)
    if arp_result.success:
        parsed_arps = _parse_arp_table(arp_result.output)

        await db.execute(
            _del(ArpEntry).where(ArpEntry.device_id == device.id)
        )

        for entry in parsed_arps:
            db.add(ArpEntry(
                device_id=device.id,
                device_hostname=device.hostname,
                ip_address=entry["ip_address"],
                mac_address=entry["mac_address"],
                interface=entry.get("interface"),
                first_seen=now,
                last_seen=now,
            ))
        arp_count = len(parsed_arps)
    else:
        arp_errors = 1

    return {
        "device_id": device.id,
        "hostname": device.hostname,
        "mac_collected": mac_count,
        "arp_collected": arp_count,
        "mac_error": mac_errors > 0,
        "arp_error": arp_errors > 0,
    }


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/collect", response_model=dict)
async def collect_mac_arp(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Trigger MAC + ARP collection for given device_ids (or all online devices)."""
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    body = await request.json()
    device_ids: list[int] = body.get("device_ids", [])

    query = select(Device).where(Device.is_active == True, Device.status == "online")
    if device_ids:
        query = query.where(Device.id.in_(device_ids))

    result = await db.execute(query)
    devices = result.scalars().all()

    if not devices:
        return {"collected": 0, "results": []}

    import asyncio
    results = await asyncio.gather(*[_collect_device(d, db) for d in devices])
    await db.commit()

    total_mac = sum(r["mac_collected"] for r in results)
    total_arp = sum(r["arp_collected"] for r in results)

    await log_action(
        db, current_user, "mac_arp_collected", "device", None, None,
        details={"devices": len(devices), "mac_total": total_mac, "arp_total": total_arp},
        request=request,
    )
    return {
        "collected": len(devices),
        "total_mac": total_mac,
        "total_arp": total_arp,
        "results": list(results),
    }


@router.get("/mac-table", response_model=dict)
async def list_mac_table(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    skip: int = 0,
    limit: int = Query(100, le=500),
    device_id: Optional[int] = Query(None),
    mac_address: Optional[str] = Query(None),
    vlan_id: Optional[int] = Query(None),
    port: Optional[str] = Query(None),
    entry_type: Optional[str] = Query(None),
    site: Optional[str] = Query(None),
):
    query = select(MacAddressEntry)
    if device_id:
        query = query.where(MacAddressEntry.device_id == device_id)
    if mac_address:
        query = query.where(MacAddressEntry.mac_address.ilike(f"%{mac_address}%"))
    if vlan_id is not None:
        query = query.where(MacAddressEntry.vlan_id == vlan_id)
    if port:
        query = query.where(MacAddressEntry.port.ilike(f"%{port}%"))
    if entry_type:
        query = query.where(MacAddressEntry.entry_type == entry_type)
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        query = query.where(MacAddressEntry.device_id.in_(site_ids))

    total_r = await db.execute(select(func.count()).select_from(query.subquery()))
    total = total_r.scalar()

    result = await db.execute(
        query.order_by(MacAddressEntry.device_hostname, MacAddressEntry.vlan_id, MacAddressEntry.port)
        .offset(skip).limit(limit)
    )
    items = result.scalars().all()

    return {
        "total": total,
        "items": [
            {
                "id": e.id,
                "device_id": e.device_id,
                "device_hostname": e.device_hostname,
                "mac_address": e.mac_address,
                "vlan_id": e.vlan_id,
                "port": e.port,
                "entry_type": e.entry_type,
                "last_seen": e.last_seen.isoformat(),
            }
            for e in items
        ],
    }


@router.get("/arp-table", response_model=dict)
async def list_arp_table(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    skip: int = 0,
    limit: int = Query(100, le=500),
    device_id: Optional[int] = Query(None),
    ip_address: Optional[str] = Query(None),
    mac_address: Optional[str] = Query(None),
    site: Optional[str] = Query(None),
):
    query = select(ArpEntry)
    if device_id:
        query = query.where(ArpEntry.device_id == device_id)
    if ip_address:
        query = query.where(ArpEntry.ip_address.ilike(f"%{ip_address}%"))
    if mac_address:
        query = query.where(ArpEntry.mac_address.ilike(f"%{mac_address}%"))
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        query = query.where(ArpEntry.device_id.in_(site_ids))

    total_r = await db.execute(select(func.count()).select_from(query.subquery()))
    total = total_r.scalar()

    result = await db.execute(
        query.order_by(ArpEntry.device_hostname, ArpEntry.ip_address)
        .offset(skip).limit(limit)
    )
    items = result.scalars().all()

    return {
        "total": total,
        "items": [
            {
                "id": e.id,
                "device_id": e.device_id,
                "device_hostname": e.device_hostname,
                "ip_address": e.ip_address,
                "mac_address": e.mac_address,
                "interface": e.interface,
                "last_seen": e.last_seen.isoformat(),
            }
            for e in items
        ],
    }


@router.get("/search", response_model=dict)
async def search_mac_arp(
    q: str = Query(..., min_length=3),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Search by MAC address or IP across both tables."""
    q_lower = q.lower().strip()

    # MAC table hits
    mac_result = await db.execute(
        select(MacAddressEntry).where(
            or_(
                MacAddressEntry.mac_address.ilike(f"%{q_lower}%"),
                MacAddressEntry.device_hostname.ilike(f"%{q_lower}%"),
                MacAddressEntry.port.ilike(f"%{q_lower}%"),
            )
        ).limit(50)
    )
    mac_hits = mac_result.scalars().all()

    # ARP table hits
    arp_result = await db.execute(
        select(ArpEntry).where(
            or_(
                ArpEntry.ip_address.ilike(f"%{q_lower}%"),
                ArpEntry.mac_address.ilike(f"%{q_lower}%"),
                ArpEntry.device_hostname.ilike(f"%{q_lower}%"),
            )
        ).limit(50)
    )
    arp_hits = arp_result.scalars().all()

    return {
        "query": q,
        "mac_hits": [
            {
                "device_hostname": e.device_hostname,
                "mac_address": e.mac_address,
                "vlan_id": e.vlan_id,
                "port": e.port,
                "entry_type": e.entry_type,
                "last_seen": e.last_seen.isoformat(),
            }
            for e in mac_hits
        ],
        "arp_hits": [
            {
                "device_hostname": e.device_hostname,
                "ip_address": e.ip_address,
                "mac_address": e.mac_address,
                "interface": e.interface,
                "last_seen": e.last_seen.isoformat(),
            }
            for e in arp_hits
        ],
    }


@router.get("/port-summary", response_model=dict)
async def port_summary(
    device_id: Optional[int] = Query(None),
    site: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Return per-device, per-port MAC count summary."""
    query = (
        select(
            MacAddressEntry.device_id,
            MacAddressEntry.device_hostname,
            MacAddressEntry.port,
            MacAddressEntry.vlan_id,
            func.count().label("mac_count"),
        )
        .group_by(
            MacAddressEntry.device_id,
            MacAddressEntry.device_hostname,
            MacAddressEntry.port,
            MacAddressEntry.vlan_id,
        )
        .order_by(MacAddressEntry.device_hostname, MacAddressEntry.port)
    )
    if device_id:
        query = query.where(MacAddressEntry.device_id == device_id)
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        query = query.where(MacAddressEntry.device_id.in_(site_ids))

    result = await db.execute(query)
    rows = result.all()

    return {
        "total": len(rows),
        "items": [
            {
                "device_id": r.device_id,
                "device_hostname": r.device_hostname,
                "port": r.port,
                "vlan_id": r.vlan_id,
                "mac_count": r.mac_count,
            }
            for r in rows
        ],
    }


@router.get("/stats", response_model=dict)
async def mac_arp_stats(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Summary statistics for the MAC/ARP tables."""
    mac_total = (await db.execute(select(func.count()).select_from(MacAddressEntry))).scalar()
    arp_total = (await db.execute(select(func.count()).select_from(ArpEntry))).scalar()
    device_count_mac = (
        await db.execute(
            select(func.count(MacAddressEntry.device_id.distinct()))
        )
    ).scalar()

    return {
        "mac_entries": mac_total,
        "arp_entries": arp_total,
        "devices_with_mac_data": device_count_mac,
    }


@router.get("/device-inventory", response_model=dict)
async def device_inventory(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    skip: int = 0,
    limit: int = Query(200, le=1000),
    device_id: Optional[int] = Query(None),
    search: Optional[str] = Query(None),
    device_type: Optional[str] = Query(None),
    vlan_id: Optional[int] = Query(None),
    site: Optional[str] = Query(None),
):
    """
    Unified end-device inventory: SQL-level filtering + pagination.
    oui_vendor / device_type stored in mac_address_entries — no Python-side scan.
    """
    # Build WHERE conditions dynamically (asyncpg can't infer type of NULL params)
    conditions: list[str] = []
    params: dict = {}

    if device_id is not None:
        conditions.append("m.device_id = :device_id")
        params["device_id"] = device_id
    if vlan_id is not None:
        conditions.append("m.vlan_id = :vlan_id")
        params["vlan_id"] = vlan_id
    if device_type:
        conditions.append("COALESCE(m.device_type, 'other') = :device_type")
        params["device_type"] = device_type
    if search:
        conditions.append(
            "(m.mac_address ILIKE :search"
            " OR COALESCE(a.ip_address,'') ILIKE :search"
            " OR COALESCE(m.oui_vendor,'') ILIKE :search"
            " OR m.device_hostname ILIKE :search)"
        )
        params["search"] = f"%{search}%"

    site_join = ""
    if site:
        site_join = "JOIN devices dm ON dm.id = m.device_id"
        conditions.append("dm.site = :site")
        params["site"] = site

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    # Total count
    count_sql = text(f"""
        SELECT COUNT(DISTINCT m.id)
        FROM mac_address_entries m
        LEFT JOIN arp_entries a ON m.mac_address = a.mac_address
        {site_join}
        {where}
    """)
    total: int = (await db.execute(count_sql, params)).scalar() or 0

    # Per-type breakdown for pill counts
    breakdown_sql = text(f"""
        SELECT COALESCE(m.device_type, 'other') AS dt, COUNT(DISTINCT m.id) AS cnt
        FROM mac_address_entries m
        LEFT JOIN arp_entries a ON m.mac_address = a.mac_address
        {site_join}
        {where}
        GROUP BY dt
        ORDER BY cnt DESC
    """)
    type_counts: dict = {
        r.dt: r.cnt
        for r in (await db.execute(breakdown_sql, params)).fetchall()
    }

    # Paginated data
    data_sql = text(f"""
        SELECT DISTINCT ON (m.id)
            m.id,
            m.device_id,
            m.device_hostname,
            m.port,
            m.vlan_id,
            m.mac_address,
            m.entry_type,
            m.last_seen,
            m.oui_vendor,
            COALESCE(m.device_type, 'other') AS device_type,
            a.ip_address
        FROM mac_address_entries m
        LEFT JOIN arp_entries a ON m.mac_address = a.mac_address
        {site_join}
        {where}
        ORDER BY m.id, m.last_seen DESC
        LIMIT :limit OFFSET :skip
    """)
    params["limit"] = limit
    params["skip"] = skip
    rows = (await db.execute(data_sql, params)).fetchall()

    items = [
        {
            "id": r.id,
            "device_id": r.device_id,
            "device_hostname": r.device_hostname,
            "port": r.port,
            "vlan_id": r.vlan_id,
            "mac_address": r.mac_address,
            "ip_address": r.ip_address,
            "entry_type": r.entry_type,
            "oui_vendor": r.oui_vendor or None,
            "device_type": r.device_type,
            "last_seen": r.last_seen.isoformat() if r.last_seen else None,
        }
        for r in rows
    ]

    return {"total": total, "items": items, "type_counts": type_counts}
