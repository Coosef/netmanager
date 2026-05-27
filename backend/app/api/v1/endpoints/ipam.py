"""T9 Tur 7 — IPAM endpoints (enterprise rebuild).

Surfaces:
  /ipam/zones                         list + CRUD
  /ipam/subnets                       list + CRUD (utilization, overlap check)
  /ipam/subnets/{id}                  detail (with utilization stats)
  /ipam/subnets/{id}/assignments      list + create-assignment
  /ipam/subnets/{id}/free-ips         suggest N free IPs
  /ipam/subnets/{id}/overlap          conflict check before save
  /ipam/assignments/{id}              update/delete
  /ipam/lookup?ip=                    find subnet + assignment for an IP
  /ipam/summary                       org-wide utilization breakdown
"""
from __future__ import annotations

import asyncio
import ipaddress
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import cast, func, select
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.core.org_context import get_current_org_id
from app.models.ipam import IpamAssignment, IpamSubnet, IpamZone
from app.services import ipam_service
from app.services.audit_service import log_action

router = APIRouter()


# ─── Pydantic ───────────────────────────────────────────────────────────────

class ZoneIn(BaseModel):
    name: str
    description: Optional[str] = None
    zone_type: str = "site"
    parent_zone_id: Optional[int] = None
    location_id: Optional[int] = None


class ZoneUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    zone_type: Optional[str] = None
    parent_zone_id: Optional[int] = None
    location_id: Optional[int] = None


class SubnetIn(BaseModel):
    zone_id: int
    cidr: str
    name: Optional[str] = None
    description: Optional[str] = None
    vlan_id: Optional[int] = Field(default=None, ge=1, le=4094)
    gateway: Optional[str] = None
    dhcp_enabled: bool = False
    dhcp_server: Optional[str] = None
    dhcp_range_start: Optional[str] = None
    dhcp_range_end: Optional[str] = None
    dns_servers: Optional[list[str]] = None
    parent_subnet_id: Optional[int] = None
    utilization_warn_pct: int = 80
    location_id: Optional[int] = None


class SubnetUpdate(BaseModel):
    zone_id: Optional[int] = None
    name: Optional[str] = None
    description: Optional[str] = None
    vlan_id: Optional[int] = Field(default=None, ge=1, le=4094)
    gateway: Optional[str] = None
    dhcp_enabled: Optional[bool] = None
    dhcp_server: Optional[str] = None
    dhcp_range_start: Optional[str] = None
    dhcp_range_end: Optional[str] = None
    dns_servers: Optional[list[str]] = None
    parent_subnet_id: Optional[int] = None
    utilization_warn_pct: Optional[int] = Field(default=None, ge=1, le=100)
    location_id: Optional[int] = None


class AssignmentIn(BaseModel):
    ip_address: str
    hostname: Optional[str] = None
    mac_address: Optional[str] = None
    description: Optional[str] = None
    type: str = "static"
    device_id: Optional[int] = None
    interface: Optional[str] = None
    expires_at: Optional[datetime] = None


class AssignmentUpdate(BaseModel):
    hostname: Optional[str] = None
    mac_address: Optional[str] = None
    description: Optional[str] = None
    type: Optional[str] = None
    device_id: Optional[int] = None
    interface: Optional[str] = None
    expires_at: Optional[datetime] = None


# ─── Serializers ────────────────────────────────────────────────────────────

def _zone(z: IpamZone) -> dict:
    return {
        "id": z.id, "name": z.name, "description": z.description,
        "zone_type": z.zone_type, "parent_zone_id": z.parent_zone_id,
        "location_id": z.location_id,
        "created_at": z.created_at.isoformat() if z.created_at else None,
        "updated_at": z.updated_at.isoformat() if z.updated_at else None,
        "deleted_at": z.deleted_at.isoformat() if z.deleted_at else None,
    }


def _subnet(s: IpamSubnet, *, util: dict | None = None) -> dict:
    return {
        "id": s.id, "zone_id": s.zone_id, "cidr": str(s.cidr),
        "name": s.name, "description": s.description, "vlan_id": s.vlan_id,
        "gateway": str(s.gateway) if s.gateway else None,
        "dhcp_enabled": s.dhcp_enabled,
        "dhcp_server": str(s.dhcp_server) if s.dhcp_server else None,
        "dhcp_range_start": str(s.dhcp_range_start) if s.dhcp_range_start else None,
        "dhcp_range_end": str(s.dhcp_range_end) if s.dhcp_range_end else None,
        "dns_servers": s.dns_servers or [],
        "parent_subnet_id": s.parent_subnet_id,
        "utilization_warn_pct": s.utilization_warn_pct,
        "site_hint": s.site_hint,
        "location_id": s.location_id,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
        "deleted_at": s.deleted_at.isoformat() if s.deleted_at else None,
        "utilization": util,
    }


def _assignment(a: IpamAssignment) -> dict:
    return {
        "id": a.id, "subnet_id": a.subnet_id, "ip_address": str(a.ip_address),
        "hostname": a.hostname, "mac_address": a.mac_address,
        "description": a.description, "type": a.type, "source": a.source,
        "device_id": a.device_id, "interface": a.interface,
        "expires_at": a.expires_at.isoformat() if a.expires_at else None,
        "last_seen_at": a.last_seen_at.isoformat() if a.last_seen_at else None,
        "location_id": a.location_id,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
    }


# ─── Helpers ────────────────────────────────────────────────────────────────

async def _get_subnet_or_404(db: AsyncSession, subnet_id: int) -> IpamSubnet:
    s = (await db.execute(
        select(IpamSubnet).where(
            IpamSubnet.id == subnet_id, IpamSubnet.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if s is None:
        raise HTTPException(status_code=404, detail="Subnet bulunamadı")
    return s


def _require_org() -> int:
    org = get_current_org_id()
    if not org:
        raise HTTPException(status_code=403, detail="Organizasyon bağlamı yok")
    return org


# ─── Zones ──────────────────────────────────────────────────────────────────

@router.get("/zones")
async def list_zones(db: AsyncSession = Depends(get_db), _: CurrentUser = None):
    rows = (await db.execute(
        select(IpamZone).where(IpamZone.deleted_at.is_(None))
        .order_by(IpamZone.name)
    )).scalars().all()
    return [_zone(z) for z in rows]


@router.post("/zones", status_code=201)
async def create_zone(
    body: ZoneIn, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    z = IpamZone(
        name=body.name, description=body.description, zone_type=body.zone_type,
        parent_zone_id=body.parent_zone_id, location_id=body.location_id,
        created_by=current_user.id,
    )
    db.add(z)
    await db.commit()
    await db.refresh(z)
    await log_action(db, current_user, "ipam_zone_created", "ipam_zone", z.id, z.name, request=request)
    return _zone(z)


@router.patch("/zones/{zone_id}")
async def update_zone(
    zone_id: int, body: ZoneUpdate, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    z = (await db.execute(select(IpamZone).where(IpamZone.id == zone_id))).scalar_one_or_none()
    if z is None:
        raise HTTPException(status_code=404, detail="Zone bulunamadı")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(z, field, value)
    await db.commit()
    await db.refresh(z)
    await log_action(db, current_user, "ipam_zone_updated", "ipam_zone", z.id, z.name, request=request)
    return _zone(z)


@router.delete("/zones/{zone_id}", status_code=204)
async def delete_zone(
    zone_id: int, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    z = (await db.execute(select(IpamZone).where(IpamZone.id == zone_id))).scalar_one_or_none()
    if z is None:
        raise HTTPException(status_code=404, detail="Zone bulunamadı")
    has_sub = (await db.execute(
        select(func.count(IpamSubnet.id)).where(
            IpamSubnet.zone_id == zone_id, IpamSubnet.deleted_at.is_(None),
        )
    )).scalar_one()
    if has_sub:
        raise HTTPException(status_code=409, detail=f"Zone içinde {has_sub} subnet var — önce taşıyın/silin.")
    z.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    await log_action(db, current_user, "ipam_zone_deleted", "ipam_zone", zone_id, z.name, request=request)


# ─── Subnets ────────────────────────────────────────────────────────────────

@router.get("/subnets")
async def list_subnets(
    zone_id: Optional[int] = None, vlan_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db), _: CurrentUser = None,
):
    q = select(IpamSubnet).where(IpamSubnet.deleted_at.is_(None))
    if zone_id is not None:
        q = q.where(IpamSubnet.zone_id == zone_id)
    if vlan_id is not None:
        q = q.where(IpamSubnet.vlan_id == vlan_id)
    rows = (await db.execute(q.order_by(IpamSubnet.cidr))).scalars().all()
    out = []
    for s in rows:
        util = await ipam_service.compute_utilization(db, s)
        out.append(_subnet(s, util=util))
    return out


@router.post("/subnets", status_code=201)
async def create_subnet(
    body: SubnetIn, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    try:
        ipam_service.parse_cidr(body.cidr)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    org_id = _require_org()
    overlap = await ipam_service.find_overlapping_subnets(db, body.cidr, org_id)
    if overlap:
        raise HTTPException(
            status_code=409,
            detail=f"Bu CIDR mevcut subnet(ler) ile çakışıyor: {', '.join(str(s.cidr) for s in overlap)}",
        )

    s = IpamSubnet(
        zone_id=body.zone_id, cidr=body.cidr, name=body.name,
        description=body.description, vlan_id=body.vlan_id,
        gateway=body.gateway, dhcp_enabled=body.dhcp_enabled,
        dhcp_server=body.dhcp_server, dhcp_range_start=body.dhcp_range_start,
        dhcp_range_end=body.dhcp_range_end, dns_servers=body.dns_servers,
        parent_subnet_id=body.parent_subnet_id,
        utilization_warn_pct=body.utilization_warn_pct,
        location_id=body.location_id, created_by=current_user.id,
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)
    await log_action(db, current_user, "ipam_subnet_created", "ipam_subnet", s.id, body.cidr, request=request)
    util = await ipam_service.compute_utilization(db, s)
    return _subnet(s, util=util)


@router.get("/subnets/{subnet_id}")
async def get_subnet(
    subnet_id: int, db: AsyncSession = Depends(get_db), _: CurrentUser = None,
):
    s = await _get_subnet_or_404(db, subnet_id)
    util = await ipam_service.compute_utilization(db, s)
    return _subnet(s, util=util)


@router.patch("/subnets/{subnet_id}")
async def update_subnet(
    subnet_id: int, body: SubnetUpdate, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    s = await _get_subnet_or_404(db, subnet_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(s, field, value)
    await db.commit()
    await db.refresh(s)
    await log_action(db, current_user, "ipam_subnet_updated", "ipam_subnet", s.id, str(s.cidr), request=request)
    util = await ipam_service.compute_utilization(db, s)
    return _subnet(s, util=util)


@router.delete("/subnets/{subnet_id}", status_code=204)
async def delete_subnet(
    subnet_id: int, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    s = await _get_subnet_or_404(db, subnet_id)
    s.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    await log_action(db, current_user, "ipam_subnet_deleted", "ipam_subnet", subnet_id, str(s.cidr), request=request)


@router.get("/subnets/{subnet_id}/overlap")
async def check_subnet_overlap(
    subnet_id: int, cidr: str,
    db: AsyncSession = Depends(get_db), _: CurrentUser = None,
):
    org_id = _require_org()
    overlaps = await ipam_service.find_overlapping_subnets(db, cidr, org_id, exclude_id=subnet_id)
    return {
        "cidr": cidr,
        "overlaps": [{"id": s.id, "cidr": str(s.cidr), "name": s.name} for s in overlaps],
    }


@router.get("/subnets/{subnet_id}/free-ips")
async def get_free_ips(
    subnet_id: int, count: int = Query(1, ge=1, le=50),
    db: AsyncSession = Depends(get_db), _: CurrentUser = None,
):
    s = await _get_subnet_or_404(db, subnet_id)
    ips = await ipam_service.suggest_free_ips(db, s, count=count)
    return {"subnet_id": subnet_id, "cidr": str(s.cidr), "free_ips": ips}


# ─── Assignments ────────────────────────────────────────────────────────────

@router.get("/subnets/{subnet_id}/assignments")
async def list_assignments(
    subnet_id: int, db: AsyncSession = Depends(get_db), _: CurrentUser = None,
):
    await _get_subnet_or_404(db, subnet_id)
    rows = (await db.execute(
        select(IpamAssignment).where(IpamAssignment.subnet_id == subnet_id)
        .order_by(IpamAssignment.ip_address)
    )).scalars().all()
    return [_assignment(a) for a in rows]


@router.post("/subnets/{subnet_id}/assignments", status_code=201)
async def create_assignment(
    subnet_id: int, body: AssignmentIn, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    s = await _get_subnet_or_404(db, subnet_id)
    if not ipam_service.is_ip_in_subnet(body.ip_address, str(s.cidr)):
        raise HTTPException(
            status_code=400,
            detail=f"{body.ip_address} bu subnet'in ({s.cidr}) içinde değil.",
        )
    existing = (await db.execute(
        select(IpamAssignment).where(
            IpamAssignment.subnet_id == subnet_id,
            IpamAssignment.ip_address == cast(body.ip_address, INET),
        )
    )).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"{body.ip_address} zaten atanmış.")

    a = IpamAssignment(
        subnet_id=subnet_id, ip_address=body.ip_address,
        hostname=body.hostname, mac_address=body.mac_address,
        description=body.description, type=body.type, source="manual",
        device_id=body.device_id, interface=body.interface,
        expires_at=body.expires_at, location_id=s.location_id,
        created_by=current_user.id,
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    await log_action(
        db, current_user, "ipam_assignment_created", "ipam_assignment",
        a.id, body.ip_address, request=request,
        details={"subnet_id": subnet_id, "type": body.type},
    )
    return _assignment(a)


@router.patch("/assignments/{assignment_id}")
async def update_assignment(
    assignment_id: int, body: AssignmentUpdate, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    a = (await db.execute(
        select(IpamAssignment).where(IpamAssignment.id == assignment_id)
    )).scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=404, detail="Atama bulunamadı")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(a, field, value)
    await db.commit()
    await db.refresh(a)
    await log_action(
        db, current_user, "ipam_assignment_updated", "ipam_assignment",
        a.id, str(a.ip_address), request=request,
    )
    return _assignment(a)


@router.delete("/assignments/{assignment_id}", status_code=204)
async def delete_assignment(
    assignment_id: int, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    a = (await db.execute(
        select(IpamAssignment).where(IpamAssignment.id == assignment_id)
    )).scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=404, detail="Atama bulunamadı")
    ip = str(a.ip_address)
    await db.delete(a)
    await db.commit()
    await log_action(
        db, current_user, "ipam_assignment_deleted", "ipam_assignment",
        assignment_id, ip, request=request,
    )


# ─── Lookups ────────────────────────────────────────────────────────────────

@router.get("/lookup")
async def ip_lookup(
    ip: str, db: AsyncSession = Depends(get_db), _: CurrentUser = None,
):
    org_id = _require_org()
    try:
        ipam_service.parse_ip(ip)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    subnet = await ipam_service.find_containing_subnet(db, ip, org_id)
    assignment = None
    if subnet is not None:
        a = (await db.execute(
            select(IpamAssignment).where(
                IpamAssignment.subnet_id == subnet.id,
                IpamAssignment.ip_address == cast(ip, INET),
            )
        )).scalar_one_or_none()
        if a is not None:
            assignment = _assignment(a)
    return {
        "ip": ip,
        "subnet": _subnet(subnet) if subnet else None,
        "assignment": assignment,
    }


# ─── ARP-discovery sync (manual trigger) ────────────────────────────────────

@router.post("/sync-arp", status_code=202)
async def trigger_arp_sync(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """T9 Tur 7 follow-up — operatörden tetiklenen ARP→IPAM sync.

    sync_arp_to_ipam zaten saatlik beat task; bu endpoint kullanıcıya
    'Şimdi cihazlardan ARP'ı çek' butonu sağlar.
    """
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    from app.workers.tasks.ipam_tasks import sync_arp_to_ipam
    sync_arp_to_ipam.delay()
    await log_action(
        db, current_user, "ipam_arp_sync_triggered",
        "ipam", None, None, request=request,
    )
    return {"queued": True, "message": "ARP→IPAM sync kuyruğa alındı."}


# ─── IP Scanner (per-subnet ping sweep) ─────────────────────────────────────

class ScanResult(BaseModel):
    ip_address: str
    responded: bool
    rtt_ms: Optional[float] = None


@router.post("/subnets/{subnet_id}/scan", status_code=200)
async def scan_subnet(
    subnet_id: int, request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """T9 follow-up — subnet'teki tüm host IP'leri ICMP ping ile tara.

    - Yanıt veren IP'ler: source='discovery' assignment olarak upsert edilir
    - Yanıt vermeyen 'discovery' kayıtları subnet'ten silinir (sadece
      discovery kaynaklı — manual/arp/dhcp asla dokunulmaz)
    - /24 max ölçek için optimize (256 IP paralel ping, ~1sn)
    """
    if not current_user.has_permission("ipam:edit"):
        raise HTTPException(status_code=403, detail="ipam:edit yetkisi gerekli")
    s = await _get_subnet_or_404(db, subnet_id)

    try:
        net = ipaddress.ip_network(str(s.cidr), strict=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Subnet CIDR geçersiz: {exc}")
    # Pratik üst sınır — /23'ten büyük tek seferde taranmaz (operatöre
    # 'subnet'i böl ya da bekle' rehberi). /24 max 254 host.
    if net.num_addresses > 1024:
        raise HTTPException(
            status_code=400,
            detail=f"Subnet çok geniş ({net.num_addresses} IP). /22 ve altı önerilir.",
        )

    hosts = list(net.hosts()) if net.num_addresses > 2 else list(net)
    ip_strs = [str(h) for h in hosts]

    # Paralel ping
    sem = asyncio.Semaphore(128)  # max 128 eş zamanlı ping
    async def _ping(ip: str) -> ScanResult:
        async with sem:
            try:
                proc = await asyncio.create_subprocess_exec(
                    "ping", "-c", "1", "-W", "1", ip,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
                out, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
                if proc.returncode == 0:
                    rtt = None
                    import re
                    m = re.search(rb"time=([\d.]+)", out)
                    if m:
                        try: rtt = float(m.group(1))
                        except ValueError: pass
                    return ScanResult(ip_address=ip, responded=True, rtt_ms=rtt)
            except (asyncio.TimeoutError, Exception):
                pass
            return ScanResult(ip_address=ip, responded=False)

    results = await asyncio.gather(*[_ping(ip) for ip in ip_strs])
    responsive = {r.ip_address: r for r in results if r.responded}

    # Yanıt verenleri assignment olarak upsert (sadece 'discovery' source).
    existing_rows = (await db.execute(
        select(IpamAssignment).where(IpamAssignment.subnet_id == subnet_id)
    )).scalars().all()
    existing_by_ip = {str(a.ip_address).split("/")[0]: a for a in existing_rows}

    created = 0
    refreshed = 0
    deleted = 0
    now = datetime.now(timezone.utc)

    for ip, res in responsive.items():
        a = existing_by_ip.get(ip)
        if a is None:
            db.add(IpamAssignment(
                subnet_id=subnet_id, ip_address=ip,
                description=f"IP scanner discovery (rtt={res.rtt_ms}ms)" if res.rtt_ms else "IP scanner discovery",
                type="dynamic", source="discovery",
                location_id=s.location_id, created_by=current_user.id,
                last_seen_at=now,
            ))
            created += 1
        elif a.source == "discovery":
            a.last_seen_at = now
            a.description = f"IP scanner discovery (rtt={res.rtt_ms}ms)" if res.rtt_ms else "IP scanner discovery"
            refreshed += 1
        # source != discovery — dokunma (manuel / ARP / DHCP korunur)

    # Yanıt vermeyen 'discovery' kayıtlarını sil
    for ip, a in existing_by_ip.items():
        if a.source != "discovery":
            continue
        if ip not in responsive:
            await db.delete(a)
            deleted += 1

    await db.commit()
    await log_action(
        db, current_user, "ipam_subnet_scanned",
        "ipam_subnet", subnet_id, str(s.cidr), request=request,
        details={
            "scanned": len(ip_strs),
            "responded": len(responsive),
            "created": created,
            "refreshed": refreshed,
            "deleted": deleted,
        },
    )

    return {
        "subnet_id": subnet_id, "cidr": str(s.cidr),
        "scanned": len(ip_strs),
        "responded": len(responsive),
        "created": created,
        "refreshed": refreshed,
        "deleted": deleted,
    }


# ─── Org-wide summary ──────────────────────────────────────────────────────

@router.get("/summary")
async def get_summary(db: AsyncSession = Depends(get_db), _: CurrentUser = None):
    """Aggregate stats — used by the IPAM dashboard tile."""
    zone_count = (await db.execute(
        select(func.count(IpamZone.id)).where(IpamZone.deleted_at.is_(None))
    )).scalar_one()
    subnet_count = (await db.execute(
        select(func.count(IpamSubnet.id)).where(IpamSubnet.deleted_at.is_(None))
    )).scalar_one()
    assignment_count = (await db.execute(
        select(func.count(IpamAssignment.id))
    )).scalar_one()

    subnets = (await db.execute(
        select(IpamSubnet).where(IpamSubnet.deleted_at.is_(None))
    )).scalars().all()
    high = []
    for s in subnets:
        u = await ipam_service.compute_utilization(db, s)
        if u["is_high"]:
            high.append({"id": s.id, "cidr": str(s.cidr), "name": s.name,
                         "used": u["used"], "total": u["total"], "pct": u["pct"]})
    high.sort(key=lambda x: x["pct"], reverse=True)

    return {
        "zone_count": int(zone_count or 0),
        "subnet_count": int(subnet_count or 0),
        "assignment_count": int(assignment_count or 0),
        "high_utilization": high,
    }
