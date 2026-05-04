"""IPAM — IP Address Management endpoints."""
import asyncio
import ipaddress
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select, delete as _del
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, TenantFilter, LocationNameFilter
from app.models.ipam import IpamAddress, IpamSubnet
from app.models.mac_arp import ArpEntry, MacAddressEntry
from app.services.audit_service import log_action

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────

class SubnetCreate(BaseModel):
    network: str
    name: Optional[str] = None
    description: Optional[str] = None
    vlan_id: Optional[int] = None
    site: Optional[str] = None
    gateway: Optional[str] = None
    dns_servers: Optional[str] = None


class SubnetUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    vlan_id: Optional[int] = None
    site: Optional[str] = None
    gateway: Optional[str] = None
    dns_servers: Optional[str] = None
    is_active: Optional[bool] = None


class AddressCreate(BaseModel):
    ip_address: str
    mac_address: Optional[str] = None
    hostname: Optional[str] = None
    description: Optional[str] = None
    status: str = "static"  # static | reserved


class AddressUpdate(BaseModel):
    mac_address: Optional[str] = None
    hostname: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _subnet_stats(network: str, used: int, reserved: int, total_hosts: int) -> dict:
    free = max(0, total_hosts - used - reserved)
    pct = round((used + reserved) / total_hosts * 100, 1) if total_hosts else 0
    return {"total_hosts": total_hosts, "used": used, "reserved": reserved, "free": free, "utilization_pct": pct}


def _net_total_hosts(network: str) -> int:
    try:
        net = ipaddress.ip_network(network, strict=False)
        hosts = net.num_addresses - 2  # exclude network + broadcast for /prefix < 31
        return max(1, hosts)
    except Exception:
        return 0


# ── Subnet CRUD ───────────────────────────────────────────────────────────────

@router.get("/subnets", response_model=dict)
async def list_subnets(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    tenant_filter: TenantFilter = None,
    location_filter: LocationNameFilter = None,
    search: Optional[str] = Query(None),
    site: Optional[str] = Query(None),
    vlan_id: Optional[int] = Query(None),
):
    query = select(IpamSubnet).where(IpamSubnet.is_active == True)
    if tenant_filter is not None:
        query = query.where(IpamSubnet.tenant_id == tenant_filter)
    # Location RBAC
    if location_filter is not None:
        effective = [s for s in location_filter if not site or s == site] if site else location_filter
        if not effective:
            return {"total": 0, "items": []}
        query = query.where(IpamSubnet.site.in_(effective))
        site = None
    if search:
        query = query.where(
            IpamSubnet.network.ilike(f"%{search}%") |
            IpamSubnet.name.ilike(f"%{search}%") |
            IpamSubnet.description.ilike(f"%{search}%")
        )
    if site:
        query = query.where(IpamSubnet.site == site)
    if vlan_id is not None:
        query = query.where(IpamSubnet.vlan_id == vlan_id)

    result = await db.execute(query.order_by(IpamSubnet.network))
    subnets = result.scalars().all()

    items = []
    for s in subnets:
        used_r = await db.execute(
            select(func.count()).select_from(IpamAddress).where(
                IpamAddress.subnet_id == s.id,
                IpamAddress.status.in_(["dynamic", "static"]),
            )
        )
        reserved_r = await db.execute(
            select(func.count()).select_from(IpamAddress).where(
                IpamAddress.subnet_id == s.id,
                IpamAddress.status == "reserved",
            )
        )
        total_hosts = _net_total_hosts(s.network)
        used = used_r.scalar() or 0
        reserved = reserved_r.scalar() or 0
        items.append({
            "id": s.id,
            "network": s.network,
            "name": s.name,
            "description": s.description,
            "vlan_id": s.vlan_id,
            "site": s.site,
            "gateway": s.gateway,
            "dns_servers": s.dns_servers,
            "is_active": s.is_active,
            "created_at": s.created_at.isoformat(),
            **_subnet_stats(s.network, used, reserved, total_hosts),
        })

    return {"total": len(items), "items": items}


@router.post("/subnets", response_model=dict, status_code=201)
async def create_subnet(
    payload: SubnetCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    # Validate network
    try:
        ipaddress.ip_network(payload.network, strict=False)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid network: {payload.network}")

    existing = await db.execute(select(IpamSubnet).where(IpamSubnet.network == payload.network))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Subnet already exists")

    subnet = IpamSubnet(**payload.model_dump(), tenant_id=current_user.tenant_id)
    db.add(subnet)
    await db.commit()
    await db.refresh(subnet)
    await log_action(db, current_user, "ipam_subnet_created", "ipam", subnet.id, subnet.network, request=request)
    return {"id": subnet.id, "network": subnet.network, "name": subnet.name}


@router.patch("/subnets/{subnet_id}", response_model=dict)
async def update_subnet(
    subnet_id: int,
    payload: SubnetUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    q = select(IpamSubnet).where(IpamSubnet.id == subnet_id)
    if tenant_filter is not None:
        q = q.where(IpamSubnet.tenant_id == tenant_filter)
    subnet = (await db.execute(q)).scalar_one_or_none()
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")

    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(subnet, k, v)

    await db.commit()
    await db.refresh(subnet)
    await log_action(db, current_user, "ipam_subnet_updated", "ipam", subnet_id, subnet.network, request=request)
    return {"id": subnet.id, "network": subnet.network}


@router.delete("/subnets/{subnet_id}", status_code=204)
async def delete_subnet(
    subnet_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    if not current_user.has_permission("device:delete"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    q = select(IpamSubnet).where(IpamSubnet.id == subnet_id)
    if tenant_filter is not None:
        q = q.where(IpamSubnet.tenant_id == tenant_filter)
    subnet = (await db.execute(q)).scalar_one_or_none()
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")

    await db.execute(_del(IpamAddress).where(IpamAddress.subnet_id == subnet_id))
    await db.delete(subnet)
    await db.commit()
    await log_action(db, current_user, "ipam_subnet_deleted", "ipam", subnet_id, subnet.network, request=request)


# ── Address CRUD ──────────────────────────────────────────────────────────────

@router.get("/subnets/{subnet_id}/addresses", response_model=dict)
async def list_addresses(
    subnet_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    skip: int = 0,
    limit: int = Query(200, le=500),
):
    result = await db.execute(select(IpamSubnet).where(IpamSubnet.id == subnet_id))
    subnet = result.scalar_one_or_none()
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")

    query = select(IpamAddress).where(IpamAddress.subnet_id == subnet_id)
    if status:
        query = query.where(IpamAddress.status == status)
    if search:
        query = query.where(
            IpamAddress.ip_address.ilike(f"%{search}%") |
            IpamAddress.hostname.ilike(f"%{search}%") |
            IpamAddress.mac_address.ilike(f"%{search}%") |
            IpamAddress.description.ilike(f"%{search}%")
        )

    total_r = await db.execute(select(func.count()).select_from(query.subquery()))
    total = total_r.scalar()

    addr_result = await db.execute(
        query.order_by(IpamAddress.ip_address).offset(skip).limit(limit)
    )
    addresses = addr_result.scalars().all()

    return {
        "subnet": {"id": subnet.id, "network": subnet.network, "name": subnet.name},
        "total": total,
        "items": [
            {
                "id": a.id,
                "ip_address": a.ip_address,
                "mac_address": a.mac_address,
                "hostname": a.hostname,
                "description": a.description,
                "status": a.status,
                "device_id": a.device_id,
                "last_seen": a.last_seen.isoformat() if a.last_seen else None,
                "updated_at": a.updated_at.isoformat(),
            }
            for a in addresses
        ],
    }


@router.post("/subnets/{subnet_id}/addresses", response_model=dict, status_code=201)
async def create_address(
    subnet_id: int,
    payload: AddressCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    result = await db.execute(select(IpamSubnet).where(IpamSubnet.id == subnet_id))
    subnet = result.scalar_one_or_none()
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")

    # Validate IP is within subnet
    try:
        net = ipaddress.ip_network(subnet.network, strict=False)
        ip = ipaddress.ip_address(payload.ip_address)
        if ip not in net:
            raise HTTPException(status_code=400, detail=f"{payload.ip_address} is not in {subnet.network}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    existing = await db.execute(
        select(IpamAddress).where(
            IpamAddress.subnet_id == subnet_id,
            IpamAddress.ip_address == payload.ip_address,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="IP address already exists in this subnet")

    addr = IpamAddress(subnet_id=subnet_id, **payload.model_dump())
    db.add(addr)
    await db.commit()
    await db.refresh(addr)
    return {"id": addr.id, "ip_address": addr.ip_address, "status": addr.status}


@router.patch("/addresses/{address_id}", response_model=dict)
async def update_address(
    address_id: int,
    payload: AddressUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    result = await db.execute(select(IpamAddress).where(IpamAddress.id == address_id))
    addr = result.scalar_one_or_none()
    if not addr:
        raise HTTPException(status_code=404, detail="Address not found")

    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(addr, k, v)

    await db.commit()
    await db.refresh(addr)
    return {"id": addr.id, "ip_address": addr.ip_address, "status": addr.status}


@router.delete("/addresses/{address_id}", status_code=204)
async def delete_address(
    address_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:delete"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    result = await db.execute(select(IpamAddress).where(IpamAddress.id == address_id))
    addr = result.scalar_one_or_none()
    if not addr:
        raise HTTPException(status_code=404, detail="Address not found")

    await db.delete(addr)
    await db.commit()


# ── ARP Scan → import into subnet ────────────────────────────────────────────

async def _ping_sweep(net: ipaddress.IPv4Network, concurrency: int = 50) -> set[str]:
    """ICMP ping sweep; returns set of responding IP strings."""
    live: set[str] = set()
    sem = asyncio.Semaphore(concurrency)

    async def _ping(ip: str) -> None:
        async with sem:
            try:
                proc = await asyncio.create_subprocess_exec(
                    "ping", "-c", "1", "-W", "1", ip,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await proc.wait()
                if proc.returncode == 0:
                    live.add(ip)
            except Exception:
                pass

    hosts = list(net.hosts())
    await asyncio.gather(*[_ping(str(h)) for h in hosts])
    return live


@router.post("/subnets/{subnet_id}/scan", response_model=dict)
async def scan_subnet_from_arp(
    subnet_id: int,
    request: Request,
    ping_sweep: bool = Query(False, description="Fall back to ICMP ping sweep if ARP yields nothing"),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Import ARP-discovered IPs that fall within this subnet into IPAM addresses."""
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    result = await db.execute(select(IpamSubnet).where(IpamSubnet.id == subnet_id))
    subnet = result.scalar_one_or_none()
    if not subnet:
        raise HTTPException(status_code=404, detail="Subnet not found")

    try:
        net = ipaddress.ip_network(subnet.network, strict=False)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid subnet network")

    # Fetch all ARP entries
    arp_result = await db.execute(select(ArpEntry))
    arp_entries = arp_result.scalars().all()

    now = datetime.now(timezone.utc)
    imported = updated = 0

    for arp in arp_entries:
        try:
            ip = ipaddress.ip_address(arp.ip_address)
        except ValueError:
            continue
        if ip not in net:
            continue

        existing = await db.execute(
            select(IpamAddress).where(
                IpamAddress.subnet_id == subnet_id,
                IpamAddress.ip_address == arp.ip_address,
            )
        )
        addr = existing.scalar_one_or_none()

        if addr:
            # Update dynamic info if status is dynamic
            if addr.status == "dynamic":
                addr.mac_address = arp.mac_address
                addr.hostname = addr.hostname or arp.device_hostname
                addr.last_seen = now
            updated += 1
        else:
            db.add(IpamAddress(
                subnet_id=subnet_id,
                ip_address=arp.ip_address,
                mac_address=arp.mac_address,
                hostname=None,
                status="dynamic",
                last_seen=now,
            ))
            imported += 1

    # Second pass: if subnet has a vlan_id, cross-reference MacAddressEntry → ArpEntry
    # This catches hosts whose IPs appear in ARP tables of *other* devices (e.g. firewalls
    # not yet in the system) but whose MACs were learned via Port Intelligence MAC table.
    if subnet.vlan_id is not None:
        mac_rows = (await db.execute(
            select(MacAddressEntry.mac_address).where(
                MacAddressEntry.vlan_id == subnet.vlan_id
            ).distinct()
        )).scalars().all()

        for mac in mac_rows:
            arp_for_mac = (await db.execute(
                select(ArpEntry).where(ArpEntry.mac_address == mac)
            )).scalars().first()
            if not arp_for_mac:
                continue
            try:
                ip = ipaddress.ip_address(arp_for_mac.ip_address)
            except ValueError:
                continue
            if ip not in net:
                continue

            existing = await db.execute(
                select(IpamAddress).where(
                    IpamAddress.subnet_id == subnet_id,
                    IpamAddress.ip_address == arp_for_mac.ip_address,
                )
            )
            addr = existing.scalar_one_or_none()
            if addr:
                if addr.status == "dynamic":
                    addr.mac_address = mac
                    addr.last_seen = now
                updated += 1
            else:
                db.add(IpamAddress(
                    subnet_id=subnet_id,
                    ip_address=arp_for_mac.ip_address,
                    mac_address=mac,
                    hostname=None,
                    status="dynamic",
                    last_seen=now,
                ))
                imported += 1

    # Third pass: ICMP ping sweep when explicitly requested and ARP/MAC passes found nothing
    ping_discovered = 0
    if ping_sweep and (imported + updated) == 0:
        live_ips = await _ping_sweep(net)
        for ip_str in live_ips:
            existing = await db.execute(
                select(IpamAddress).where(
                    IpamAddress.subnet_id == subnet_id,
                    IpamAddress.ip_address == ip_str,
                )
            )
            addr = existing.scalar_one_or_none()
            if addr:
                if addr.status == "dynamic":
                    addr.last_seen = now
                updated += 1
            else:
                db.add(IpamAddress(
                    subnet_id=subnet_id,
                    ip_address=ip_str,
                    mac_address=None,
                    hostname=None,
                    status="dynamic",
                    last_seen=now,
                ))
                imported += 1
                ping_discovered += 1

    await db.commit()
    await log_action(
        db, current_user, "ipam_scan_completed", "ipam", subnet_id, subnet.network,
        details={"imported": imported, "updated": updated, "ping_discovered": ping_discovered},
        request=request,
    )
    return {"subnet": subnet.network, "imported": imported, "updated": updated, "ping_discovered": ping_discovered}


# ── Stats overview ────────────────────────────────────────────────────────────

@router.get("/stats", response_model=dict)
async def ipam_stats(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    subnet_count = (await db.execute(
        select(func.count()).select_from(IpamSubnet).where(IpamSubnet.is_active == True)
    )).scalar()

    addr_counts = (await db.execute(
        select(IpamAddress.status, func.count()).group_by(IpamAddress.status)
    )).all()
    counts = {row[0]: row[1] for row in addr_counts}

    return {
        "subnets": subnet_count,
        "addresses_dynamic": counts.get("dynamic", 0),
        "addresses_static": counts.get("static", 0),
        "addresses_reserved": counts.get("reserved", 0),
        "addresses_total": sum(counts.values()),
    }
