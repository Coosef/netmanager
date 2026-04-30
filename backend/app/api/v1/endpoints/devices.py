import re

import csv
import io

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, TenantFilter
from app.core.security import encrypt_credential
from app.models.user import UserRole
from app.models.config_backup import ConfigBackup
from app.models.credential_profile import CredentialProfile
from app.models.device import Device, DeviceGroup
from app.models.topology import TopologyLink
from app.schemas.device import (
    BulkUpdateAgent, BulkUpdateCredentials, DeviceCreate, DeviceGroupCreate, DeviceGroupResponse,
    DeviceResponse, DeviceTestResult, DeviceUpdate,
)
from app.schemas.task import ConfigBackupResponse
from app.services.audit_service import log_action
from app.services.ssh_manager import ssh_manager

router = APIRouter()

# ── CLI Safety Rules ────────────────────────────────────────────────────────
# Commands that are always blocked regardless of device mode.
_CLI_DENY = [
    re.compile(r"^reload(\s|$)", re.I),
    re.compile(r"^reboot(\s|$)", re.I),
    re.compile(r"^reset(\s|$)", re.I),                       # Ruijie
    re.compile(r"^erase(\s|$)", re.I),
    re.compile(r"^write\s+erase", re.I),
    re.compile(r"^format(\s|$)", re.I),
    re.compile(r"^delete(\s+/force)?\s", re.I),
    re.compile(r"^delete\s+flash", re.I),
    re.compile(r"^crypto\s+key\s+zeroize", re.I),
    re.compile(r"^no\s+service(\s|$)", re.I),
    re.compile(r"^startup-config\s+default", re.I),          # Ruijie factory reset
    re.compile(r"^restore\s+factory", re.I),
]

# Commands allowed unconditionally in read-only mode.
_READONLY_OK = ("show", "display", "ping", "traceroute", "tracert", "dir", "more")

# Commands that require `confirm: true` in the request body (medium risk).
_CLI_WARN = [
    re.compile(r"^write(\s+memory)?(\s|$)", re.I),
    re.compile(r"^wr(\s|$)", re.I),
    re.compile(r"^save(\s|$)", re.I),                        # Ruijie
    re.compile(r"^copy\s+run", re.I),
    re.compile(r"^conf(igure)?(\s+t(erminal)?)?(\s|$)", re.I),
    re.compile(r"^no\s+", re.I),
    re.compile(r"^undo\s+", re.I),                           # Ruijie
    re.compile(r"^shutdown(\s|$)", re.I),
    re.compile(r"^interface\s+", re.I),
    re.compile(r"^vlan\s+", re.I),
]

# High-risk commands that require admin approval when approval_required=True on device.
_CLI_HIGH_RISK = [
    re.compile(r"^conf(igure)?(\s+t(erminal)?)?(\s|$)", re.I),
    re.compile(r"^interface\s+", re.I),
    re.compile(r"^vlan\s+", re.I),
    re.compile(r"^no\s+", re.I),
    re.compile(r"^undo\s+", re.I),
    re.compile(r"^shutdown(\s|$)", re.I),
    re.compile(r"^ip\s+", re.I),
    re.compile(r"^router\s+", re.I),
    re.compile(r"^spanning-tree\s+", re.I),
    re.compile(r"^port-security\s+", re.I),
    re.compile(r"^storm-control\s+", re.I),
]

# Medium-risk: save/backup commands
_CLI_MEDIUM_RISK = [
    re.compile(r"^write(\s+memory)?(\s|$)", re.I),
    re.compile(r"^wr(\s|$)", re.I),
    re.compile(r"^save(\s|$)", re.I),
    re.compile(r"^copy\s+run", re.I),
]


def _command_risk(cmd: str) -> str:
    """Return 'high', 'medium', or 'low' for a command (denylist already checked)."""
    for p in _CLI_HIGH_RISK:
        if p.match(cmd):
            return "high"
    for p in _CLI_MEDIUM_RISK:
        if p.match(cmd):
            return "medium"
    return "low"


# ── Groups ──────────────────────────────────────────────────────────────────

@router.get("/groups", response_model=list[DeviceGroupResponse])
async def list_groups(db: AsyncSession = Depends(get_db), _: CurrentUser = None):
    result = await db.execute(select(DeviceGroup))
    return result.scalars().all()


@router.post("/groups", response_model=DeviceGroupResponse, status_code=201)
async def create_group(
    payload: DeviceGroupCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    group = DeviceGroup(**payload.model_dump())
    db.add(group)
    await db.commit()
    await db.refresh(group)
    await log_action(db, current_user, "group_created", "group", group.id, group.name, request=request)
    return group


@router.post("/groups/{group_id}/assign-credential-profile")
async def assign_group_credential_profile(
    group_id: int,
    payload: dict,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Assign (or clear) a credential profile for every device in a group."""
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    group = await db.get(DeviceGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    profile_id = payload.get("credential_profile_id")
    profile_name: str | None = None
    if profile_id is not None:
        profile = await db.get(CredentialProfile, int(profile_id))
        if not profile:
            raise HTTPException(status_code=404, detail="Credential profile not found")
        profile_name = profile.name

    result = await db.execute(
        update(Device)
        .where(Device.group_id == group_id)
        .values(credential_profile_id=profile_id if profile_id else None)
    )
    await db.commit()

    await log_action(
        db, current_user, "group_profile_assigned", "group", group_id, group.name,
        request=request,
        details={"profile_id": profile_id, "profile_name": profile_name, "updated_devices": result.rowcount},
    )
    return {"updated": result.rowcount, "group_name": group.name, "profile_name": profile_name}


# ── Auto-Grouping Suggestions ──────────────────────────────────────────────

_LAYER_LABELS = {
    "core": "Core Switches",
    "distribution": "Distribution Layer",
    "access": "Access Switches",
    "edge": "Edge Devices",
    "wireless": "Wireless APs",
}


@router.get("/group-suggestions", response_model=dict)
async def group_suggestions(db: AsyncSession = Depends(get_db), _: CurrentUser = None):
    devices = (await db.execute(select(Device).where(Device.is_active == True))).scalars().all()
    device_map = {d.id: d for d in devices}
    suggestions = []

    # 1. Site/Building/Floor based
    site_map: dict[tuple, list[int]] = {}
    for d in devices:
        if d.site:
            key = (d.site, d.building or "", d.floor or "")
            site_map.setdefault(key, []).append(d.id)
    for (site, building, floor), ids in site_map.items():
        if len(ids) >= 2:
            parts = [p for p in [site, building, floor] if p]
            suggestions.append({
                "suggestion_type": "site_based",
                "suggested_name": " › ".join(parts),
                "description": f"{site} lokasyonundaki {len(ids)} cihaz",
                "device_ids": ids,
                "device_count": len(ids),
                "device_names": [device_map[i].hostname for i in ids],
            })

    # 2. Layer based
    layer_map: dict[str, list[int]] = {}
    for d in devices:
        if d.layer:
            layer_map.setdefault(d.layer, []).append(d.id)
    for layer, ids in layer_map.items():
        if len(ids) >= 2:
            suggestions.append({
                "suggestion_type": "layer_based",
                "suggested_name": _LAYER_LABELS.get(layer, layer.title()),
                "description": f"{len(ids)} cihaz — katman: {layer}",
                "device_ids": ids,
                "device_count": len(ids),
                "device_names": [device_map[i].hostname for i in ids if i in device_map],
            })

    # 3. Topology cluster — devices that share the same upstream device
    topo_links = (await db.execute(
        select(TopologyLink).where(TopologyLink.neighbor_device_id.isnot(None))
    )).scalars().all()
    downstream_of: dict[int, set[int]] = {}
    for link in topo_links:
        if link.neighbor_device_id and link.neighbor_device_id in device_map:
            downstream_of.setdefault(link.neighbor_device_id, set()).add(link.device_id)
    for upstream_id, downstream_ids in downstream_of.items():
        if len(downstream_ids) >= 2:
            upstream_host = device_map[upstream_id].hostname
            ids = list(downstream_ids)
            suggestions.append({
                "suggestion_type": "topology_cluster",
                "suggested_name": f"Cluster: {upstream_host}",
                "description": f"{upstream_host} cihazına bağlı {len(ids)} cihaz",
                "device_ids": ids,
                "device_count": len(ids),
                "device_names": [device_map[i].hostname for i in ids if i in device_map],
            })

    return {"suggestions": suggestions, "total": len(suggestions)}


class _SuggestionItem(BaseModel):
    name: str
    description: str | None = None
    device_ids: list[int]


class _ApplySuggestionsPayload(BaseModel):
    suggestions: list[_SuggestionItem]


@router.post("/apply-group-suggestions", response_model=dict, status_code=201)
async def apply_group_suggestions(
    payload: _ApplySuggestionsPayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    created = []
    for s in payload.suggestions:
        existing = (await db.execute(
            select(DeviceGroup).where(DeviceGroup.name == s.name)
        )).scalar_one_or_none()
        if existing:
            group = existing
        else:
            group = DeviceGroup(name=s.name, description=s.description)
            db.add(group)
            await db.flush()
        await db.execute(
            update(Device).where(Device.id.in_(s.device_ids)).values(group_id=group.id)
        )
        created.append({"id": group.id, "name": group.name, "device_count": len(s.device_ids)})
        await log_action(db, current_user, "group_auto_created", "group", group.id, group.name, request=request)
    await db.commit()
    return {"created": created, "total": len(created)}


# ── Tenant-scoped device lookup ─────────────────────────────────────────────

async def _get_device_scoped(db: AsyncSession, device_id: int, current_user) -> Device:
    """Fetch a device, enforcing tenant isolation for non-SUPER_ADMIN users."""
    q = select(Device).where(Device.id == device_id)
    if current_user.role != UserRole.SUPER_ADMIN:
        q = q.where(Device.tenant_id == current_user.tenant_id)
    device = (await db.execute(q)).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


# ── Devices ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=dict)
async def list_devices(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
    skip: int = 0,
    limit: int = 50,
    search: str = Query(None),
    vendor: str = Query(None),
    status: str = Query(None),
    device_type: str = Query(None),
    group_id: int = Query(None),
    tag: str = Query(None),
    site: str = Query(None),
):
    query = select(Device).where(Device.is_active == True)
    if tenant_filter is not None:
        query = query.where(Device.tenant_id == tenant_filter)

    if search:
        query = query.where(
            or_(
                Device.hostname.ilike(f"%{search}%"),
                Device.ip_address.ilike(f"%{search}%"),
                Device.location.ilike(f"%{search}%"),
                Device.alias.ilike(f"%{search}%"),
                Device.tags.ilike(f"%{search}%"),
            )
        )
    if vendor:
        query = query.where(Device.vendor == vendor)
    if status:
        query = query.where(Device.status == status)
    if device_type:
        query = query.where(Device.device_type == device_type)
    if group_id:
        query = query.where(Device.group_id == group_id)
    if tag:
        query = query.where(Device.tags.ilike(f"%{tag}%"))
    if site:
        query = query.where(Device.site == site)

    total_result = await db.execute(select(func.count()).select_from(query.subquery()))
    total = total_result.scalar()

    result = await db.execute(query.order_by(Device.hostname).offset(skip).limit(limit))
    devices = result.scalars().all()

    return {
        "total": total,
        "items": [DeviceResponse.model_validate(d) for d in devices],
        "skip": skip,
        "limit": limit,
    }


@router.post("/", response_model=DeviceResponse, status_code=201)
async def create_device(
    payload: DeviceCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    existing = await db.execute(select(Device).where(Device.ip_address == payload.ip_address))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Device with this IP already exists")

    device = Device(
        hostname=payload.hostname or payload.ip_address,
        ip_address=payload.ip_address,
        device_type=payload.device_type,
        vendor=payload.vendor,
        os_type=payload.os_type,
        model=payload.model,
        location=payload.location,
        description=payload.description,
        tags=payload.tags,
        alias=payload.alias,
        layer=payload.layer,
        site=payload.site,
        building=payload.building,
        floor=payload.floor,
        ssh_username=payload.ssh_username,
        ssh_password_enc=encrypt_credential(payload.ssh_password),
        ssh_port=payload.ssh_port,
        enable_secret_enc=encrypt_credential(payload.enable_secret) if payload.enable_secret else None,
        group_id=payload.group_id,
        agent_id=payload.agent_id or None,
        is_readonly=payload.is_readonly,
        snmp_enabled=payload.snmp_enabled,
        snmp_community=payload.snmp_community,
        snmp_version=payload.snmp_version,
        snmp_port=payload.snmp_port,
        snmp_v3_username=payload.snmp_v3_username,
        snmp_v3_auth_protocol=payload.snmp_v3_auth_protocol,
        snmp_v3_auth_passphrase=encrypt_credential(payload.snmp_v3_auth_passphrase) if payload.snmp_v3_auth_passphrase else None,
        snmp_v3_priv_protocol=payload.snmp_v3_priv_protocol,
        snmp_v3_priv_passphrase=encrypt_credential(payload.snmp_v3_priv_passphrase) if payload.snmp_v3_priv_passphrase else None,
        credential_profile_id=payload.credential_profile_id,
        tenant_id=current_user.tenant_id,
    )
    db.add(device)
    await db.commit()
    await db.refresh(device)
    await log_action(db, current_user, "device_created", "device", device.id, device.hostname, request=request)
    return device


@router.post("/bulk-update-credentials", response_model=dict)
async def bulk_update_credentials(
    payload: BulkUpdateCredentials,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Copy SSH/enable credentials from a source device (or manual input) to multiple devices."""
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    if not payload.device_ids:
        raise HTTPException(status_code=400, detail="No device IDs provided")

    if payload.source_device_id:
        source_q = await db.execute(select(Device).where(Device.id == payload.source_device_id))
        source = source_q.scalar_one_or_none()
        if not source:
            raise HTTPException(status_code=404, detail="Source device not found")
        new_username = source.ssh_username
        new_password_enc = source.ssh_password_enc
        new_secret_enc = source.enable_secret_enc
    else:
        if not payload.ssh_username or not payload.ssh_password:
            raise HTTPException(status_code=400, detail="ssh_username and ssh_password required when no source_device_id")
        new_username = payload.ssh_username
        new_password_enc = encrypt_credential(payload.ssh_password)
        new_secret_enc = encrypt_credential(payload.enable_secret) if payload.enable_secret else None

    result = await db.execute(select(Device).where(Device.id.in_(payload.device_ids)))
    devices = result.scalars().all()
    if not devices:
        raise HTTPException(status_code=404, detail="No matching devices found")

    for device in devices:
        device.ssh_username = new_username
        device.ssh_password_enc = new_password_enc
        device.enable_secret_enc = new_secret_enc

    await db.commit()
    await log_action(
        db, current_user, "bulk_credentials_updated", "device", None, None,
        details={"device_ids": payload.device_ids, "count": len(devices)},
        request=request,
    )
    return {"updated": len(devices), "device_ids": [d.id for d in devices]}


@router.get("/location-options", response_model=dict)
async def get_location_options(db: AsyncSession = Depends(get_db), _: CurrentUser = None):
    """Return distinct site/building/floor values for cascading topology filters."""
    sites_r = await db.execute(
        select(Device.site).where(Device.site.isnot(None), Device.site != "", Device.is_active == True).distinct()
    )
    buildings_r = await db.execute(
        select(Device.site, Device.building).where(
            Device.building.isnot(None), Device.building != "", Device.is_active == True
        ).distinct()
    )
    floors_r = await db.execute(
        select(Device.site, Device.building, Device.floor).where(
            Device.floor.isnot(None), Device.floor != "", Device.is_active == True
        ).distinct()
    )
    sites = [r[0] for r in sites_r.all() if r[0]]
    buildings = [{"site": r[0], "name": r[1]} for r in buildings_r.all() if r[0] and r[1]]
    floors = [{"site": r[0], "building": r[1], "name": r[2]} for r in floors_r.all() if r[2]]
    return {"sites": sorted(set(sites)), "buildings": buildings, "floors": floors}


@router.get("/import-template")
async def download_import_template(_: CurrentUser = None):
    """Return a CSV template for bulk device import."""
    headers = [
        "hostname", "ip_address", "device_type", "vendor", "os_type",
        "model", "location", "ssh_username", "ssh_password", "ssh_port",
        "enable_secret", "layer", "site", "building", "floor",
        "tags", "alias", "is_readonly",
    ]
    example = [
        "CORE_SW_01", "192.168.1.1", "switch", "cisco", "cisco_ios",
        "Catalyst 9300", "Server Room", "admin", "YourPassword123", "22",
        "", "core", "HQ", "Main Building", "1",
        "core,vlan10", "", "true",
    ]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(headers)
    w.writerow(example)
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="device_import_template.csv"'},
    )


_VALID_DEVICE_TYPES = {"switch", "router", "firewall", "ap", "ups", "server", "other"}
_VALID_VENDORS = {"cisco", "aruba", "ruijie", "fortinet", "paloalto", "mikrotik", "juniper", "ubiquiti", "h3c", "apc", "other"}
_VALID_OS_TYPES = {
    "cisco_ios", "cisco_nxos", "cisco_sg300",
    "aruba_osswitch", "aruba_aoscx", "hp_procurve",
    "ruijie_os", "fortios", "panos", "mikrotik_routeros", "junos",
    "h3c_comware", "generic_snmp", "generic",
}
_VALID_LAYERS = {"core", "distribution", "access", "edge", "wireless"}


@router.post("/import-csv", response_model=dict, status_code=201)
async def import_devices_csv(
    file: UploadFile = File(...),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Bulk import devices from a CSV file. Upserts on ip_address."""
    if not current_user.has_permission("device:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    content = await file.read()
    try:
        text = content.decode("utf-8-sig")  # handle BOM
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))
    required = {"ip_address", "ssh_username", "ssh_password"}

    created, updated, errors = 0, 0, []

    # Load existing IP → device map
    existing_map: dict[str, Device] = {
        d.ip_address: d for d in (await db.execute(select(Device))).scalars().all()
    }

    for i, row in enumerate(reader, start=2):
        row = {k.strip(): (v.strip() if v else "") for k, v in row.items() if k}
        missing = required - set(row.keys())
        if missing:
            errors.append({"row": i, "error": f"Eksik sütun: {missing}"})
            continue

        ip = row.get("ip_address", "").strip()
        if not ip:
            errors.append({"row": i, "error": "ip_address boş olamaz"})
            continue

        ssh_user = row.get("ssh_username", "").strip()
        ssh_pass = row.get("ssh_password", "").strip()
        if not ssh_user or not ssh_pass:
            errors.append({"row": i, "error": f"{ip}: ssh_username/ssh_password gerekli"})
            continue

        device_type = row.get("device_type", "switch").strip() or "switch"
        if device_type not in _VALID_DEVICE_TYPES:
            device_type = "other"

        vendor = row.get("vendor", "other").strip() or "other"
        if vendor not in _VALID_VENDORS:
            vendor = "other"

        os_type = row.get("os_type", "cisco_ios").strip() or "cisco_ios"
        if os_type not in _VALID_OS_TYPES:
            os_type = "generic"

        layer = row.get("layer", "").strip() or None
        if layer and layer not in _VALID_LAYERS:
            layer = None

        ssh_port = 22
        try:
            ssh_port = int(row.get("ssh_port", "22") or "22")
        except ValueError:
            pass

        is_readonly = str(row.get("is_readonly", "true")).lower() not in ("false", "0", "no")

        enable_secret = row.get("enable_secret", "").strip() or None

        try:
            existing = existing_map.get(ip)
            if existing:
                # Update existing
                existing.hostname = row.get("hostname", "").strip() or existing.hostname
                existing.device_type = device_type
                existing.vendor = vendor
                existing.os_type = os_type
                existing.model = row.get("model", "").strip() or existing.model
                existing.location = row.get("location", "").strip() or existing.location
                existing.ssh_username = ssh_user
                existing.ssh_password_enc = encrypt_credential(ssh_pass)
                existing.ssh_port = ssh_port
                if enable_secret:
                    existing.enable_secret_enc = encrypt_credential(enable_secret)
                existing.layer = layer or existing.layer
                existing.site = row.get("site", "").strip() or existing.site
                existing.building = row.get("building", "").strip() or existing.building
                existing.floor = row.get("floor", "").strip() or existing.floor
                existing.tags = row.get("tags", "").strip() or existing.tags
                existing.alias = row.get("alias", "").strip() or existing.alias
                existing.is_readonly = is_readonly
                updated += 1
            else:
                hostname = row.get("hostname", "").strip() or ip
                device = Device(
                    hostname=hostname,
                    ip_address=ip,
                    device_type=device_type,
                    vendor=vendor,
                    os_type=os_type,
                    model=row.get("model", "").strip() or None,
                    location=row.get("location", "").strip() or None,
                    ssh_username=ssh_user,
                    ssh_password_enc=encrypt_credential(ssh_pass),
                    ssh_port=ssh_port,
                    enable_secret_enc=encrypt_credential(enable_secret) if enable_secret else None,
                    layer=layer,
                    site=row.get("site", "").strip() or None,
                    building=row.get("building", "").strip() or None,
                    floor=row.get("floor", "").strip() or None,
                    tags=row.get("tags", "").strip() or None,
                    alias=row.get("alias", "").strip() or None,
                    is_readonly=is_readonly,
                )
                db.add(device)
                created += 1
        except Exception as e:
            errors.append({"row": i, "ip": ip, "error": str(e)})

    try:
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Veritabanı hatası: {e}")

    await log_action(
        db, current_user, "devices_csv_imported", "device", None, None,
        details={"created": created, "updated": updated, "errors": len(errors)},
        request=request,
    )

    return {
        "created": created,
        "updated": updated,
        "errors": errors,
        "total_rows": created + updated + len(errors),
    }


@router.get("/{device_id}", response_model=DeviceResponse)
async def get_device(device_id: int, db: AsyncSession = Depends(get_db), current_user: CurrentUser = None):
    return await _get_device_scoped(db, device_id, current_user)


@router.patch("/{device_id}", response_model=DeviceResponse)
async def update_device(
    device_id: int,
    payload: DeviceUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    device = await _get_device_scoped(db, device_id, current_user)
    data = payload.model_dump(exclude_unset=True)

    # Capture before state for forensics (exclude sensitive credential fields)
    _skip = {"ssh_password", "enable_secret", "ssh_password_enc", "enable_secret_enc"}
    before_state = {
        f: getattr(device, f) for f in data
        if f not in _skip and hasattr(device, f)
    }

    if "ssh_password" in data:
        device.ssh_password_enc = encrypt_credential(data.pop("ssh_password"))
    if "enable_secret" in data:
        secret = data.pop("enable_secret")
        device.enable_secret_enc = encrypt_credential(secret) if secret else None

    for field, value in data.items():
        setattr(device, field, value)

    after_state = {f: v for f, v in data.items() if f not in _skip}

    await db.commit()
    await db.refresh(device)
    await log_action(
        db, current_user, "device_updated", "device", device_id, device.hostname,
        request=request, before_state=before_state, after_state=after_state,
    )
    return device


@router.post("/bulk-update-agent", response_model=dict)
async def bulk_update_agent(
    payload: BulkUpdateAgent,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    result = await db.execute(select(Device).where(Device.id.in_(payload.device_ids)))
    devices = result.scalars().all()
    if not devices:
        raise HTTPException(status_code=404, detail="No matching devices found")

    agent_id = payload.agent_id or None
    for device in devices:
        device.agent_id = agent_id

    await db.commit()
    await log_action(
        db, current_user, "bulk_agent_updated", "device", None, None,
        details={"device_ids": payload.device_ids, "agent_id": agent_id, "count": len(devices)},
        request=request,
    )
    return {"updated": len(devices), "agent_id": agent_id}


@router.post("/bulk-delete", response_model=dict)
async def bulk_delete_devices(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:delete"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    from app.models.config_backup import ConfigBackup
    from sqlalchemy import delete as _del

    body = await request.json()
    device_ids: list[int] = body.get("device_ids", [])
    if not device_ids:
        raise HTTPException(status_code=400, detail="No device IDs provided")

    from app.models.user import UserRole
    tenant_clause = (
        [Device.id.in_(device_ids)]
        if current_user.role == UserRole.SUPER_ADMIN
        else [Device.id.in_(device_ids), Device.tenant_id == current_user.tenant_id]
    )
    result = await db.execute(select(Device).where(*tenant_clause))
    devices = result.scalars().all()
    if not devices:
        raise HTTPException(status_code=404, detail="No matching devices found")

    for d in devices:
        await ssh_manager.close_device(d.id)

    from app.models.topology import TopologyLink
    await db.execute(_del(ConfigBackup).where(ConfigBackup.device_id.in_(device_ids)))
    await db.execute(_del(TopologyLink).where(TopologyLink.neighbor_device_id.in_(device_ids)))
    for d in devices:
        await db.delete(d)
    await db.commit()

    await log_action(
        db, current_user, "devices_bulk_deleted", "device", None, None,
        details={"device_ids": device_ids, "count": len(devices)},
        request=request,
    )
    return {"deleted": len(devices)}


@router.post("/bulk-fetch-info", response_model=dict)
async def bulk_fetch_info(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """SSH ile birden fazla cihazda paralel fetch-info çalıştırır."""
    import asyncio, re

    body = await request.json()
    device_ids: list[int] = body.get("device_ids", [])
    if not device_ids:
        raise HTTPException(status_code=400, detail="No device IDs provided")

    result_q = await db.execute(select(Device).where(Device.id.in_(device_ids)))
    devices = result_q.scalars().all()
    if not devices:
        raise HTTPException(status_code=404, detail="No matching devices found")

    async def _ssh_fetch(device: Device) -> dict:
        try:
            ver_result = await ssh_manager.execute_command(device, "show version")
            if not ver_result.success:
                return {"device_id": device.id, "hostname": device.hostname, "success": False, "error": ver_result.error}

            output = ver_result.output

            model = None
            for pat in [
                r"[Ss]ystem\s+description\s*:\s*Ruijie\s+[^(]+\(([^)]+)\)",
                r"[Mm]odel\s*[Nn]umber\s*[:\s]+(\S+)",
                r"[Mm]odel\s*[:\s]+(\S+)",
                r"Cisco\s+([\w-]+)\s+(?:Software|processor|Series)",
                r"Ruijie\s+([\w-]+)\s+Software",
                r"RG-([\w-]+)[\s,]",
                r"ARUBA\s+([\w-]+)",
                r"^(\S+)\s+Software.*Version",
            ]:
                m = re.search(pat, output, re.MULTILINE)
                if m:
                    model = m.group(1).strip()
                    break

            firmware = None
            for pat in [
                r"[Vv]ersion\s+\S*RGOS\s+([\d\.]+\S*)",
                r"[Ss]ystem\s+[Ss]oftware\s+[Vv]ersion\s*[:\s]+\S+\s+([\d\.]+\S*)",
                r"[Vv]ersion\s+([\d\.]+\([^)]+\)[a-zA-Z0-9]*)",
                r"[Ss]oftware\s+[Vv]ersion\s*[,:\s]+([\d\.]+\S*)",
                r"[Vv]ersion\s+([\d\.]+)",
            ]:
                m = re.search(pat, output)
                if m:
                    firmware = m.group(1).strip().rstrip(",")
                    break

            serial = None
            for pat in [
                r"[Ss]ystem\s+[Ss]erial\s+[Nn]umber\s*[:\s]+(\S+)",
                r"[Ss]erial\s*[Nn]umber\s*[:\s]+(\S+)",
                r"Processor board ID\s+(\S+)",
                r"SN:\s*(\S+)",
            ]:
                m = re.search(pat, output)
                if m:
                    serial = m.group(1).strip()
                    break

            # ProCurve: lldp for model, walkMIB for serial
            if device.os_type in ("aruba_osswitch", "hp_procurve") and (not model or not serial):
                if not model:
                    lldp_r = await ssh_manager.execute_command(device, "show lldp info local-device")
                    if lldp_r.success and lldp_r.output:
                        m_lldp = re.search(
                            r"System Description\s*:\s*HP\s+(J\w+)\s+([\w\-/+.]+(?:\s+[\w\-/+.]+)*?)\s+(?:[Ss]witch|[Rr]outer)",
                            lldp_r.output,
                        )
                        if m_lldp:
                            part2 = m_lldp.group(2).strip()
                            model = f"{m_lldp.group(1)} {part2}" if part2 else m_lldp.group(1)
                if not serial:
                    mib_r = await ssh_manager.execute_command(device, "walkMIB 1.3.6.1.2.1.47.1.1.1.1.11")
                    if mib_r.success and mib_r.output:
                        m_mib = re.search(r"entPhysicalSerialNum\.1\s*=\s*(\S+)", mib_r.output)
                        if m_mib:
                            serial = m_mib.group(1).strip()

            hostname_fetched = None
            hn_result = await ssh_manager.execute_command(device, "show running-config | include hostname")
            if hn_result.success and hn_result.output:
                m = re.search(r"^hostname\s+(\S+)", hn_result.output, re.MULTILINE)
                if m:
                    hostname_fetched = m.group(1).strip()
            if not hostname_fetched:
                m = re.search(r"[Ss]ystem\s+[Nn]ame\s*[:\s]+(\S+)", output)
                if m:
                    hostname_fetched = m.group(1).strip()

            updates: dict = {}
            if hostname_fetched:
                updates["hostname"] = hostname_fetched
            if model:
                updates["model"] = model
            if firmware:
                updates["firmware_version"] = firmware
            if serial:
                updates["serial_number"] = serial

            return {"device_id": device.id, "hostname": device.hostname, "success": True, "updates": updates, "_device": device}
        except Exception as exc:
            return {"device_id": device.id, "hostname": device.hostname, "success": False, "error": str(exc)}

    ssh_results = await asyncio.gather(*[_ssh_fetch(d) for d in devices])

    for r in ssh_results:
        if r["success"] and r.get("updates"):
            dev = r.pop("_device")
            for k, v in r["updates"].items():
                setattr(dev, k, v)
        elif "_device" in r:
            r.pop("_device")

    await db.commit()

    succeeded = sum(1 for r in ssh_results if r["success"])
    await log_action(
        db, current_user, "bulk_fetch_info", "device", None, None,
        details={"device_ids": device_ids, "succeeded": succeeded, "failed": len(ssh_results) - succeeded},
        request=request,
    )
    return {"succeeded": succeeded, "failed": len(ssh_results) - succeeded, "results": list(ssh_results)}


@router.delete("/{device_id}", status_code=204)
async def delete_device(
    device_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:delete"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    from app.models.config_backup import ConfigBackup
    from sqlalchemy import delete as _del

    device = await _get_device_scoped(db, device_id, current_user)

    from app.models.topology import TopologyLink
    await ssh_manager.close_device(device_id)
    await db.execute(_del(ConfigBackup).where(ConfigBackup.device_id == device_id))
    # Clean up topology links where this device is the neighbor target (SET NULL FK won't remove the row)
    await db.execute(_del(TopologyLink).where(TopologyLink.neighbor_device_id == device_id))
    await db.delete(device)
    await db.commit()
    await log_action(db, current_user, "device_deleted", "device", device_id, device.hostname, request=request)


@router.post("/{device_id}/test", response_model=DeviceTestResult)
async def test_device_connection(
    device_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    device = await _get_device_scoped(db, device_id, current_user)
    result = await ssh_manager.test_connection(device)
    await log_action(
        db, current_user, "device_tested", "device", device_id, device.hostname,
        details={"success": result.success, "error": result.error},
        request=request,
    )
    return DeviceTestResult(
        device_id=device.id,
        hostname=device.hostname,
        ip_address=device.ip_address,
        success=result.success,
        message=result.output if result.success else result.error,
        latency_ms=result.duration_ms,
    )


@router.post("/{device_id}/fetch-info", response_model=DeviceResponse)
async def fetch_device_info(
    device_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """SSH ile bağlanıp show version çıktısını parse ederek model/firmware/seri no günceller."""
    device = await _get_device_scoped(db, device_id, current_user)
    result = await ssh_manager.execute_command(device, "show version")
    if not result.success:
        raise HTTPException(status_code=502, detail=f"SSH error: {result.error}")

    import re
    output = result.output

    # --- Aruba OS auto-detection ---
    # Detect whether this is AOS-CX (modern) or ArubaOS-Switch/ProCurve (legacy)
    # and correct os_type so subsequent commands use the right driver/syntax.
    if device.vendor == "aruba":
        detected_os = None
        if re.search(r'ArubaOS-CX|AOS-CX', output, re.IGNORECASE):
            detected_os = "aruba_aoscx"
        elif re.search(r'ArubaOS-Switch|ProVision|HP\s+ProCurve|HP\s+J\d|Aruba\s+Instant\s+On', output, re.IGNORECASE):
            detected_os = "aruba_osswitch"
        if detected_os and detected_os != device.os_type:
            device.os_type = detected_os
            await db.commit()
            await db.refresh(device)
            # Force new SSH session with corrected driver
            await ssh_manager.close_device(device.id)

    # --- Model ---
    model = None
    for pattern in [
        # Ruijie: "System description : Ruijie 10G Ethernet Switch(CS83-12GT4XS-P)"
        r"[Ss]ystem\s+description\s*:\s*Ruijie\s+[^(]+\(([^)]+)\)",
        r"[Mm]odel\s*[Nn]umber\s*[:\s]+(\S+)",
        r"[Mm]odel\s*[:\s]+(\S+)",
        r"Cisco\s+([\w-]+)\s+(?:Software|processor|Series)",
        r"Ruijie\s+([\w-]+)\s+Software",
        r"RG-([\w-]+)[\s,]",
        # AOS-CX: "Platform      : X335-48TP"
        r"[Pp]latform\s*:\s*(\S+)",
        # ProCurve: "HP J9776A 2530-24G Switch"
        r"HP\s+(J\w+)\s",
        r"ARUBA\s+([\w-]+)",
        r"^(\S+)\s+Software.*Version",
    ]:
        m = re.search(pattern, output, re.MULTILINE)
        if m:
            model = m.group(1).strip()
            break

    # --- Firmware / SW Version ---
    firmware = None
    for pattern in [
        # Ruijie: "Version CS83_RGOS 12.6(3)B1404P1" or "version RGOS 12.6(3)B1404P1"
        r"[Vv]ersion\s+\S*RGOS\s+([\d\.]+\S*)",
        # Ruijie system software line: "System software version : CS83_RGOS 12.6(3)B1404P1"
        r"[Ss]ystem\s+[Ss]oftware\s+[Vv]ersion\s*[:\s]+\S+\s+([\d\.]+\S*)",
        # AOS-CX: "Version      : FL.10.10.1030"
        r"[Vv]ersion\s*:\s*([\w\.]+)",
        # Cisco IOS: "Cisco IOS Software ... Version 15.2(4)E8,"
        r"[Vv]ersion\s+([\d\.]+\([^)]+\)[a-zA-Z0-9]*)",
        # ProCurve: "Software revision  WB.16.10.0012"
        r"[Ss]oftware\s+[Rr]evision\s+([\w\.]+)",
        # Generic version X.Y.Z
        r"[Ss]oftware\s+[Vv]ersion\s*[,:\s]+([\d\.]+\S*)",
        r"[Vv]ersion\s+([\d\.]+)",
        r"RELEASE SOFTWARE.*\nVersion\s+(\S+)",
    ]:
        m = re.search(pattern, output)
        if m:
            firmware = m.group(1).strip().rstrip(",")
            break

    # --- Serial Number ---
    serial = None
    for pattern in [
        r"[Ss]ystem\s+[Ss]erial\s+[Nn]umber\s*[:\s]+(\S+)",   # Ruijie / generic
        r"[Ss]erial\s*[Nn]umber\s*[:\s]+(\S+)",
        r"Processor board ID\s+(\S+)",
        r"SN:\s*(\S+)",
        # ProCurve: "Serial Number: SG23BVZ0ZY"
        r"[Ss]erial\s+[Nn]umber:\s*(\S+)",
    ]:
        m = re.search(pattern, output)
        if m:
            serial = m.group(1).strip()
            break

    # --- ProCurve: lldp for model, walkMIB for serial ---
    if device.os_type in ("aruba_osswitch", "hp_procurve") and (not model or not serial):
        if not model:
            lldp_r = await ssh_manager.execute_command(device, "show lldp info local-device")
            if lldp_r.success and lldp_r.output:
                m_lldp = re.search(
                    r"System Description\s*:\s*HP\s+(J\w+)\s+([\w\-/+.]+(?:\s+[\w\-/+.]+)*?)\s+(?:[Ss]witch|[Rr]outer)",
                    lldp_r.output,
                )
                if m_lldp:
                    part2 = m_lldp.group(2).strip()
                    model = f"{m_lldp.group(1)} {part2}" if part2 else m_lldp.group(1)
        if not serial:
            mib_r = await ssh_manager.execute_command(device, "walkMIB 1.3.6.1.2.1.47.1.1.1.1.11")
            if mib_r.success and mib_r.output:
                m_mib = re.search(r"entPhysicalSerialNum\.1\s*=\s*(\S+)", mib_r.output)
                if m_mib:
                    serial = m_mib.group(1).strip()

    # --- Hostname from running-config ---
    hostname_fetched = None
    # ProCurve doesn't support '| include' pipe filtering — use full running-config
    if device.os_type in ("aruba_osswitch", "hp_procurve"):
        hostname_cmd = "show running-config"
    else:
        hostname_cmd = "show running-config | include hostname"
    hostname_result = await ssh_manager.execute_command(device, hostname_cmd)
    if hostname_result.success and hostname_result.output:
        import re as _re
        m = _re.search(r"^hostname\s+(\S+)", hostname_result.output, _re.MULTILINE)
        if m:
            hostname_fetched = m.group(1).strip()
        # ProCurve uses "system-name" in running-config
        if not hostname_fetched:
            m = _re.search(r"^system-name\s+(.+)", hostname_result.output, _re.MULTILINE)
            if m:
                hostname_fetched = m.group(1).strip().strip('"')
    # Fallback: parse from show version output (Ruijie uses "System name")
    if not hostname_fetched:
        import re as _re
        m = _re.search(r"[Ss]ystem\s+[Nn]ame\s*[:\s]+(\S+)", output)
        if m:
            hostname_fetched = m.group(1).strip()

    updates = {}
    if hostname_fetched:
        updates["hostname"] = hostname_fetched
    if model:
        updates["model"] = model
    if firmware:
        updates["firmware_version"] = firmware
    if serial:
        updates["serial_number"] = serial

    if updates:
        for k, v in updates.items():
            setattr(device, k, v)
        await db.commit()
        await db.refresh(device)

    await log_action(
        db, current_user, "device_info_fetched", "device", device_id, device.hostname,
        details=updates, request=request,
    )
    return device


@router.post("/{device_id}/run-command", response_model=dict)
async def run_show_command(
    device_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Run a CLI command on a device.
    - Blocked commands (reload, erase, format…) always return 403.
    - In read-only mode only show/ping/dir commands are allowed.
    - Config-altering commands require confirm=true in the request body.
    - Every execution (command + full output) is written to the audit log.
    """
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    body = await request.json()
    command: str = body.get("command", "").strip()
    confirmed: bool = bool(body.get("confirm", False))

    if not command:
        raise HTTPException(status_code=400, detail="command is required")

    device = await _get_device_scoped(db, device_id, current_user)
    cmd_lower = command.lower().strip()

    # 1. Absolute denylist — always blocked
    for pattern in _CLI_DENY:
        if pattern.match(cmd_lower):
            await log_action(db, current_user, "cli_blocked", "device", device_id, device.hostname,
                             details={"command": command, "reason": "denylist"}, request=request)
            raise HTTPException(status_code=403,
                                detail=f"Komut güvenlik politikası tarafından engellendi: '{command}'")

    # 2. Read-only mode check
    if device.is_readonly:
        allowed = any(cmd_lower.startswith(pfx) for pfx in _READONLY_OK)
        if not allowed:
            await log_action(db, current_user, "cli_blocked", "device", device_id, device.hostname,
                             details={"command": command, "reason": "readonly_mode"}, request=request)
            raise HTTPException(status_code=403,
                                detail="Cihaz salt-okunur modda. Sadece show/ping/dir komutlarına izin verilir.")

    # 3. Warn-level commands — need explicit confirmation
    needs_confirm = any(p.match(cmd_lower) for p in _CLI_WARN)
    if needs_confirm and not confirmed:
        return {
            "needs_confirm": True,
            "command": command,
            "warning": "Bu komut cihaz yapılandırmasını değiştirebilir. Devam etmek için onaylayın.",
        }

    # 4. Approval required — create ApprovalRequest if device has approval_required=True
    #    and command is medium or high risk (and current user is not admin/super_admin)
    if device.approval_required and not current_user.has_permission("approval:review"):
        risk = _command_risk(cmd_lower)
        if risk in ("high", "medium"):
            from app.models.approval import ApprovalRequest
            req = ApprovalRequest(
                device_id=device.id,
                device_hostname=device.hostname,
                command=command,
                risk_level=risk,
                requester_id=current_user.id,
                requester_username=current_user.username,
                tenant_id=current_user.tenant_id,
            )
            db.add(req)
            await db.commit()
            await db.refresh(req)
            await log_action(db, current_user, "approval_requested", "device", device_id, device.hostname,
                             details={"command": command, "risk_level": risk, "request_id": req.id},
                             request=request)
            return {
                "needs_approval": True,
                "request_id": req.id,
                "risk_level": risk,
                "command": command,
                "message": f"Bu komut admin onayı gerektiriyor. Talep #{req.id} oluşturuldu.",
            }

    # 5. Execute
    result = await ssh_manager.execute_command(device, command)

    await log_action(
        db, current_user, "cli_command", "device", device_id, device.hostname,
        details={
            "command": command,
            "success": result.success,
            "output": (result.output or "")[:4096],
            "error": result.error,
            "confirmed": confirmed,
        },
        duration_ms=result.duration_ms,
        request=request,
    )

    return {"success": result.success, "output": result.output, "error": result.error}


@router.get("/{device_id}/config", response_model=dict)
async def get_device_config(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    device = await _get_device_scoped(db, device_id, current_user)
    result = await ssh_manager.get_running_config(device)
    return {"success": result.success, "config": result.output, "error": result.error}


# ── SNMP Configure ─────────────────────────────────────────────────────────────

def _snmp_commands(os_type: str, version: str, community: str | None,
                   v3_user: str | None, v3_auth_proto: str, v3_auth_pass: str | None,
                   v3_priv_proto: str, v3_priv_pass: str | None) -> list[str]:
    """Return additive SNMP config commands for the given OS type. Never removes existing config."""
    cmds: list[str] = []
    if version == "v2c":
        if not community:
            raise ValueError("Community string required for SNMPv2c")
        if os_type in ("cisco_ios", "cisco_nxos", "cisco_sg300"):
            cmds.append(f"snmp-server community {community} ro")
        elif os_type == "ruijie_os":
            # Ruijie requires enabling snmp-agent service and explicit version enablement.
            # Community string must contain uppercase+lowercase+digit (3+ char types).
            cmds.append("enable service snmp-agent")
            cmds.append(f"snmp-server community {community}")
            cmds.append("snmp-server enable version v2c")
        elif os_type in ("aruba_osswitch", "hp_procurve"):
            cmds.append(f"snmpv2c community {community}")
        elif os_type == "aruba_aoscx":
            cmds.append(f"snmp-server community {community}")
        else:
            cmds.append(f"snmp-server community {community} ro")
    elif version == "v3":
        if not v3_user or not v3_auth_pass:
            raise ValueError("Username and auth password required for SNMPv3")
        priv_suffix = ""
        if v3_priv_pass:
            priv_algo = "aes 128" if v3_priv_proto == "aes128" else "des"
            priv_suffix = f" priv {priv_algo} {v3_priv_pass}"
        if os_type in ("cisco_ios", "cisco_nxos"):
            cmds.append("snmp-server group NETMANAGER v3 priv")
            cmds.append(f"snmp-server user {v3_user} NETMANAGER v3 auth {v3_auth_proto} {v3_auth_pass}{priv_suffix}")
        elif os_type == "ruijie_os":
            rj_priv = f" priv {'aes128' if v3_priv_proto == 'aes128' else 'des'} {v3_priv_pass}" if v3_priv_pass else ""
            cmds.append(f"snmp-server v3 user {v3_user} auth {v3_auth_proto} {v3_auth_pass}{rj_priv}")
        else:
            cmds.append(f"snmp-server group NETMANAGER v3 priv")
            cmds.append(f"snmp-server user {v3_user} NETMANAGER v3 auth {v3_auth_proto} {v3_auth_pass}{priv_suffix}")
    return cmds


@router.post("/{device_id}/configure-snmp")
async def configure_snmp(
    device_id: int,
    body: dict,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Apply SNMP configuration to device via SSH and save settings to database.
    Only additive commands — never removes existing configuration.
    """
    if not current_user.has_permission("config:push"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    device = await _get_device_scoped(db, device_id, current_user)
    skip_ssh = bool(body.get("skip_ssh", False))
    version = body.get("snmp_version", "v2c")
    community = body.get("snmp_community") or None
    snmp_port = int(body.get("snmp_port", 161))
    v3_user = body.get("snmp_v3_username") or None
    v3_auth_proto = body.get("snmp_v3_auth_protocol", "sha")
    v3_auth_pass = body.get("snmp_v3_auth_passphrase") or None
    v3_priv_proto = body.get("snmp_v3_priv_protocol", "aes128")
    v3_priv_pass = body.get("snmp_v3_priv_passphrase") or None

    cmds: list[str] = []
    if not skip_ssh:
        try:
            cmds = _snmp_commands(device.os_type, version, community,
                                  v3_user, v3_auth_proto, v3_auth_pass,
                                  v3_priv_proto, v3_priv_pass)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        # Apply via SSH
        apply_result = await ssh_manager.send_config(device, cmds)
        if not apply_result.success:
            cmds_str = " | ".join(cmds)
            raise HTTPException(
                status_code=502,
                detail=f"SSH komutları uygulanamadı: {apply_result.error or 'bilinmeyen hata'} "
                       f"(denenen komutlar: {cmds_str}). "
                       f"Cihaz SSH ile erişilebilir değilse 'Zaten Yapılandırıldı — Bilgileri Kaydet' seçeneğini kullanın."
            )

        # Save to NVRAM (best-effort — don't fail if this doesn't work)
        save_cmd = "copy running-config startup-config" if device.os_type in ("cisco_ios", "cisco_nxos") else "write memory"
        await ssh_manager.execute_command(device, save_cmd)

    # Update device SNMP fields in DB
    device.snmp_enabled = True
    device.snmp_version = version
    device.snmp_port = snmp_port
    if version == "v2c":
        device.snmp_community = community
    else:
        device.snmp_v3_username = v3_user
        device.snmp_v3_auth_protocol = v3_auth_proto
        device.snmp_v3_auth_passphrase = encrypt_credential(v3_auth_pass) if v3_auth_pass else None
        device.snmp_v3_priv_protocol = v3_priv_proto
        device.snmp_v3_priv_passphrase = encrypt_credential(v3_priv_pass) if v3_priv_pass else None

    await db.commit()

    action = "snmp_settings_saved" if skip_ssh else "snmp_configured"
    await log_action(
        db, current_user, action, "device", device_id, device.hostname,
        details={"version": version, "commands": cmds, "skip_ssh": skip_ssh},
        request=request,
    )

    return {"success": True, "commands_applied": cmds}


@router.post("/{device_id}/backups/take", response_model=ConfigBackupResponse, status_code=201)
async def take_backup(
    device_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Immediately SSH and take a config backup for this device."""
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    device = await _get_device_scoped(db, device_id, current_user)
    result = await ssh_manager.get_running_config(device)
    if not result.success:
        raise HTTPException(status_code=502, detail=f"SSH error: {result.error}")

    import hashlib
    from datetime import datetime, timezone
    config_text = result.output
    config_hash = hashlib.sha256(config_text.encode()).hexdigest()

    # Check if identical backup already exists (no change)
    existing = await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id, ConfigBackup.config_hash == config_hash)
        .limit(1)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Config hasn't changed since last backup")

    backup = ConfigBackup(
        device_id=device_id,
        config_text=config_text,
        config_hash=config_hash,
        size_bytes=len(config_text.encode()),
        created_by=current_user.id,
        tenant_id=current_user.tenant_id,
    )
    db.add(backup)

    from datetime import timezone as tz
    device.last_backup = datetime.now(tz.utc)
    await db.commit()
    await db.refresh(backup)

    await log_action(db, current_user, "config_backup_taken", "device", device_id, device.hostname, request=request)
    return backup


@router.get("/{device_id}/backups", response_model=list[ConfigBackupResponse])
async def list_device_backups(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    limit: int = 20,
):
    result = await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id)
        .order_by(ConfigBackup.created_at.desc())
        .limit(limit)
    )
    return result.scalars().all()


@router.get("/{device_id}/backups/{backup_id}/content")
async def get_backup_content(
    device_id: int,
    backup_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    result = await db.execute(
        select(ConfigBackup).where(
            ConfigBackup.id == backup_id,
            ConfigBackup.device_id == device_id,
        )
    )
    backup = result.scalar_one_or_none()
    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")
    return {"config": backup.config_text, "hash": backup.config_hash, "created_at": backup.created_at}


@router.get("/{device_id}/backups/{backup_id}/download")
async def download_backup(
    device_id: int,
    backup_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    dev_res = await db.execute(select(Device).where(Device.id == device_id))
    device = dev_res.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    result = await db.execute(
        select(ConfigBackup).where(
            ConfigBackup.id == backup_id,
            ConfigBackup.device_id == device_id,
        )
    )
    backup = result.scalar_one_or_none()
    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")

    ts = backup.created_at.strftime("%Y%m%d_%H%M%S")
    safe_hostname = device.hostname.replace("/", "_").replace(" ", "_")
    filename = f"{safe_hostname}_{ts}.txt"
    return Response(
        content=backup.config_text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{device_id}/backups/{backup_id}/set-golden")
async def set_golden_backup(
    device_id: int,
    backup_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Mark a backup as the golden (baseline) config for drift detection."""
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    from sqlalchemy import update as _upd
    # Clear existing golden for this device
    await db.execute(
        _upd(ConfigBackup)
        .where(ConfigBackup.device_id == device_id)
        .values(is_golden=False, golden_set_at=None)
    )
    result = await db.execute(
        select(ConfigBackup).where(ConfigBackup.id == backup_id, ConfigBackup.device_id == device_id)
    )
    backup = result.scalar_one_or_none()
    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")

    from datetime import datetime, timezone as _tz
    backup.is_golden = True
    backup.golden_set_at = datetime.now(_tz.utc)
    await db.commit()
    await log_action(db, current_user, "golden_config_set", "device", device_id, f"backup #{backup_id}", request=None)
    return {"success": True, "backup_id": backup_id, "message": "Golden baseline set"}


@router.get("/{device_id}/backups/drift")
async def get_config_drift(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Compare the latest backup to the golden baseline and return unified diff."""
    import difflib

    golden = (await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id, ConfigBackup.is_golden == True)
        .order_by(ConfigBackup.golden_set_at.desc())
    )).scalar_one_or_none()

    if not golden:
        return {"has_golden": False, "drift_detected": False}

    latest = (await db.execute(
        select(ConfigBackup)
        .where(ConfigBackup.device_id == device_id, ConfigBackup.id != golden.id)
        .order_by(ConfigBackup.created_at.desc())
    )).scalar_one_or_none()

    if not latest:
        return {
            "has_golden": True,
            "golden_id": golden.id,
            "golden_created_at": golden.created_at.isoformat(),
            "drift_detected": False,
            "message": "No backup after golden baseline",
        }

    if golden.config_hash == latest.config_hash:
        return {
            "has_golden": True,
            "golden_id": golden.id,
            "golden_created_at": golden.created_at.isoformat(),
            "latest_id": latest.id,
            "latest_created_at": latest.created_at.isoformat(),
            "drift_detected": False,
        }

    diff_lines = list(difflib.unified_diff(
        golden.config_text.splitlines(keepends=True),
        latest.config_text.splitlines(keepends=True),
        fromfile=f"golden ({golden.created_at.strftime('%Y-%m-%d %H:%M')})",
        tofile=f"latest ({latest.created_at.strftime('%Y-%m-%d %H:%M')})",
        n=3,
    ))
    added = sum(1 for ln in diff_lines if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in diff_lines if ln.startswith("-") and not ln.startswith("---"))

    return {
        "has_golden": True,
        "golden_id": golden.id,
        "golden_created_at": golden.created_at.isoformat(),
        "latest_id": latest.id,
        "latest_created_at": latest.created_at.isoformat(),
        "drift_detected": True,
        "lines_added": added,
        "lines_removed": removed,
        "diff": "".join(diff_lines[:500]),
    }


@router.get("/{device_id}/backups/diff")
async def config_diff(
    device_id: int,
    from_id: int,
    to_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Return unified diff between two config backups."""
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    def _get_backup(bid: int):
        from sqlalchemy import select as _sel
        return select(ConfigBackup).where(ConfigBackup.id == bid, ConfigBackup.device_id == device_id)

    b1 = (await db.execute(_get_backup(from_id))).scalar_one_or_none()
    b2 = (await db.execute(_get_backup(to_id))).scalar_one_or_none()
    if not b1 or not b2:
        raise HTTPException(status_code=404, detail="One or both backups not found")

    import difflib
    lines_a = b1.config_text.splitlines(keepends=True)
    lines_b = b2.config_text.splitlines(keepends=True)

    diff = list(difflib.unified_diff(
        lines_a, lines_b,
        fromfile=f"backup-{b1.id} ({b1.created_at.strftime('%Y-%m-%d %H:%M')})",
        tofile=f"backup-{b2.id} ({b2.created_at.strftime('%Y-%m-%d %H:%M')})",
        lineterm="",
    ))

    added = sum(1 for l in diff if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in diff if l.startswith("-") and not l.startswith("---"))

    return {
        "from_backup": {"id": b1.id, "created_at": b1.created_at, "hash": b1.config_hash},
        "to_backup":   {"id": b2.id, "created_at": b2.created_at, "hash": b2.config_hash},
        "has_changes": added + removed > 0,
        "added": added,
        "removed": removed,
        "diff": "".join(diff),
    }


# Security policy rules — (search_text, rule_id, severity, description)
_SECURITY_RULES = [
    ("telnet",                          "TELNET_ENABLED",    "critical", "Telnet aktif — şifresiz bağlantı riski"),
    ("no service ssh",                  "SSH_DISABLED",      "critical", "SSH servisi kapalı"),
    ("snmp-server community public",    "SNMP_WEAK_PUBLIC",  "critical", "SNMP community 'public' kullanılıyor"),
    ("snmp-server community private",   "SNMP_WEAK_PRIVATE", "critical", "SNMP community 'private' kullanılıyor"),
    ("enable password ",                "ENABLE_PLAIN_PW",   "warning",  "Enable şifre düz metin (secret kullanın)"),
    ("username.*password ",             "USER_PLAIN_PW",     "warning",  "Kullanıcı şifresi düz metin"),
    ("no spanning-tree",                "STP_DISABLED",      "critical", "Spanning-tree devre dışı — döngü riski"),
    ("ip http server\n",                "HTTP_ENABLED",      "warning",  "HTTP yönetim arayüzü aktif (HTTPS kullanın)"),
    ("no ip ssh",                       "SSH_VERSION_OLD",   "warning",  "SSH konfigürasyonu eksik"),
    ("service password-encryption",     "NO_PASS_ENC",       "info",     "Şifre şifreleme eksik (service password-encryption önerilir)"),
]
_REQUIRED_PATTERNS = [
    ("ntp server",    "NO_NTP",       "warning",  "NTP sunucusu tanımlanmamış"),
    ("logging ",      "NO_SYSLOG",    "warning",  "Syslog hedefi tanımlanmamış"),
    ("aaa ",          "NO_AAA",       "info",     "AAA kimlik doğrulama yapılandırılmamış"),
    ("storm-control", "NO_STORM_CTL", "info",     "Storm-control tanımlanmamış"),
    ("banner ",       "NO_BANNER",    "info",     "Login banner tanımlanmamış"),
]


@router.post("/{device_id}/config/check-policy")
async def check_config_policy(
    device_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """SSH to device, retrieve running config, check against security policy rules."""
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    device = await _get_device_scoped(db, device_id, current_user)
    result = await ssh_manager.execute_command(device, "show running-config")
    if not result.success:
        raise HTTPException(status_code=502, detail=f"SSH error: {result.error}")

    import re
    config = result.output
    config_lower = config.lower()
    violations = []

    for text, rule_id, severity, description in _SECURITY_RULES:
        # "service password-encryption" is a REQUIRED rule — flag if ABSENT
        if rule_id == "NO_PASS_ENC":
            if "service password-encryption" not in config_lower:
                violations.append({"rule_id": rule_id, "severity": severity, "description": description})
        elif re.search(text, config_lower, re.MULTILINE):
            violations.append({"rule_id": rule_id, "severity": severity, "description": description})

    for text, rule_id, severity, description in _REQUIRED_PATTERNS:
        if text not in config_lower:
            violations.append({"rule_id": rule_id, "severity": severity, "description": description})

    score = 100 - sum(
        {"critical": 20, "warning": 10, "info": 3}.get(v["severity"], 0)
        for v in violations
    )
    score = max(0, score)

    await log_action(
        db, current_user, "config_policy_check", "device", device_id, device.hostname,
        details={"violations": len(violations), "score": score},
        request=request,
    )

    return {
        "device_id": device_id,
        "hostname": device.hostname,
        "policy_score": score,
        "violations": violations,
        "violation_count": len(violations),
        "critical_count": sum(1 for v in violations if v["severity"] == "critical"),
    }


@router.post("/bulk-backup")
async def bulk_backup(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Queue a bulk config backup task for selected device IDs."""
    if not current_user.has_permission("config:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    body = await request.json()
    device_ids: list[int] = body.get("device_ids", [])
    if not device_ids:
        raise HTTPException(status_code=400, detail="device_ids required")

    from app.models.task import Task, TaskType, TaskStatus
    from app.workers.tasks.bulk_tasks import bulk_backup_configs

    task = Task(
        name=f"Toplu Yedek — {len(device_ids)} cihaz",
        type=TaskType.BACKUP_CONFIG,
        status=TaskStatus.PENDING,
        device_ids=device_ids,
        total_devices=len(device_ids),
        created_by=current_user.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    bulk_backup_configs.apply_async(
        args=[task.id, device_ids, current_user.id],
        queue="bulk",
    )

    await log_action(db, current_user, "bulk_backup_queued", "task", task.id, task.name, request=request)
    return {"task_id": task.id, "device_count": len(device_ids), "status": "queued"}


# ── Per-device read endpoints (neighbors / events / activity) ────────────────

@router.get("/{device_id}/neighbors", response_model=dict)
async def get_device_neighbors(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    from app.models.topology import TopologyLink
    result = await db.execute(
        select(TopologyLink)
        .where(TopologyLink.device_id == device_id)
        .order_by(TopologyLink.last_seen.desc())
    )
    links = result.scalars().all()
    return {
        "items": [
            {
                "id": lnk.id,
                "local_port": lnk.local_port,
                "neighbor_hostname": lnk.neighbor_hostname,
                "neighbor_ip": lnk.neighbor_ip,
                "neighbor_port": lnk.neighbor_port,
                "neighbor_platform": lnk.neighbor_platform,
                "neighbor_device_id": lnk.neighbor_device_id,
                "neighbor_type": lnk.neighbor_type,
                "protocol": lnk.protocol,
                "last_seen": lnk.last_seen.isoformat(),
            }
            for lnk in links
        ]
    }


@router.get("/{device_id}/events", response_model=dict)
async def get_device_events(
    device_id: int,
    skip: int = Query(0),
    limit: int = Query(100),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    from app.models.network_event import NetworkEvent
    result = await db.execute(
        select(NetworkEvent)
        .where(NetworkEvent.device_id == device_id)
        .order_by(NetworkEvent.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    events = result.scalars().all()
    return {
        "items": [
            {
                "id": ev.id,
                "event_type": ev.event_type,
                "severity": ev.severity,
                "title": ev.title,
                "message": ev.message,
                "acknowledged": ev.acknowledged,
                "created_at": ev.created_at.isoformat(),
            }
            for ev in events
        ]
    }


@router.get("/{device_id}/activity", response_model=dict)
async def get_device_activity(
    device_id: int,
    skip: int = Query(0),
    limit: int = Query(100),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    from app.models.audit_log import AuditLog
    result = await db.execute(
        select(AuditLog)
        .where(AuditLog.resource_type == "device", AuditLog.resource_id == str(device_id))
        .order_by(AuditLog.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    logs = result.scalars().all()
    return {
        "items": [
            {
                "id": lg.id,
                "username": lg.username,
                "action": lg.action,
                "status": lg.status,
                "details": lg.details,
                "client_ip": lg.client_ip,
                "created_at": lg.created_at.isoformat(),
            }
            for lg in logs
        ]
    }
