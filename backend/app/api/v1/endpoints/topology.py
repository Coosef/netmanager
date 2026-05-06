from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from sqlalchemy import select, func, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, LocationNameFilter
from app.core.redis_client import get_json, set_json
from app.core.security import encrypt_credential, decrypt_credential
from app.models.device import Device
from app.models.task import Task, TaskStatus, TaskType
from app.models.topology import TopologyLink
from app.services.audit_service import log_action
from app.services.topology_service import TopologyService, detect_device_type
from app.services.ssh_manager import ssh_manager, SSHManager
from app.workers.tasks.topology_tasks import discover_topology

router = APIRouter()


@router.post("/discover", response_model=dict, status_code=202)
async def trigger_discovery(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    device_ids: list[int] | None = Body(default=None),
):
    """Trigger LLDP/CDP topology discovery. If device_ids is empty, discovers all active devices."""
    if not current_user.has_permission("task:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    if not device_ids:
        result = await db.execute(select(Device.id).where(Device.is_active == True))
        device_ids = result.scalars().all()

    if not device_ids:
        raise HTTPException(status_code=400, detail="No active devices found")

    task = Task(
        name="Topology Discovery",
        type=TaskType.MONITOR_POLL,
        status=TaskStatus.PENDING,
        device_ids=list(device_ids),
        total_devices=len(device_ids),
        created_by=current_user.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    discover_topology.apply_async(
        args=[task.id, list(device_ids)],
        queue="monitor",
    )

    await log_action(
        db, current_user, "topology_discovery_started", "task", task.id,
        details={"device_count": len(device_ids)},
        request=request,
    )

    return {"task_id": task.id, "device_count": len(device_ids), "status": "accepted"}


@router.get("/graph", response_model=dict)
async def get_topology_graph(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    group_id: int = Query(None),
    site: str = Query(None),
    refresh: bool = Query(False),
    location_filter: LocationNameFilter = None,
):
    """Return React Flow compatible graph. Cached in Redis for 5 minutes."""
    effective_sites: list[str] | None = None
    if location_filter is not None:
        eff = [s for s in location_filter if not site or s == site] if site else location_filter
        if not eff:
            return {"nodes": [], "edges": []}
        effective_sites = eff
        site = None

    cache_key = f"topology:graph:{group_id or 'all'}:{site or 'all'}"

    if not refresh:
        cached = await get_json(cache_key)
        if cached and effective_sites is None:
            return cached

    svc = TopologyService(ssh_manager)
    graph = await svc.build_graph(db, group_id, site=site, sites=effective_sites)

    if effective_sites is None:
        await set_json(cache_key, graph, ttl=300)
    return graph


@router.get("/links", response_model=dict)
async def get_topology_links(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    device_id: int = Query(None),
    skip: int = 0,
    limit: int = 200,
):
    """Return raw topology links for a device or all devices."""
    query = select(TopologyLink)
    if device_id:
        query = query.where(TopologyLink.device_id == device_id)

    total = await db.execute(select(func.count()).select_from(query.subquery()))
    result = await db.execute(query.order_by(TopologyLink.last_seen.desc()).offset(skip).limit(limit))
    links = result.scalars().all()

    return {
        "total": total.scalar(),
        "items": [
            {
                "id": l.id,
                "device_id": l.device_id,
                "local_port": l.local_port,
                "neighbor_hostname": l.neighbor_hostname,
                "neighbor_ip": l.neighbor_ip,
                "neighbor_port": l.neighbor_port,
                "neighbor_platform": l.neighbor_platform,
                "neighbor_device_id": l.neighbor_device_id,
                "protocol": l.protocol,
                "last_seen": l.last_seen.isoformat(),
            }
            for l in links
        ],
    }


@router.post("/discover-single/{device_id}", response_model=dict)
async def discover_single(
    device_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Run LLDP/CDP on one device synchronously and return neighbors with type detection."""
    if not current_user.has_permission("task:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    device = (await db.execute(select(Device).where(Device.id == device_id))).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    all_devices = (await db.execute(select(Device).where(Device.is_active == True))).scalars().all()
    hostname_map = {d.hostname.lower(): d.id for d in all_devices}
    ip_map = {d.ip_address: d.id for d in all_devices}

    svc = TopologyService(ssh_manager)
    neighbors = await svc.discover_device(device)
    await svc.save_links(db, device, neighbors, hostname_map)

    # Invalidate graph cache
    import redis as _redis_mod
    from app.core.config import settings
    r = _redis_mod.from_url(settings.REDIS_URL, decode_responses=True)
    for key in r.keys("topology:graph:*"):
        r.delete(key)

    await log_action(db, current_user, "topology_single_discover", "device", device_id, device.hostname,
                     details={"neighbor_count": len(neighbors)}, request=request)

    result_neighbors = []
    for n in neighbors:
        known_id = hostname_map.get(n.neighbor_hostname.lower()) or ip_map.get(n.neighbor_ip or "")
        result_neighbors.append({
            "local_port": n.local_port,
            "hostname": n.neighbor_hostname,
            "ip": n.neighbor_ip,
            "port": n.neighbor_port,
            "platform": n.neighbor_platform,
            "device_type": detect_device_type(n.neighbor_platform, n.neighbor_hostname),
            "protocol": n.protocol,
            "in_inventory": bool(known_id),
            "device_id": known_id,
        })

    # Count how many new switches share the same IP to flag non-unique ones
    new_sw_ip_count: dict[str, int] = {}
    for n in result_neighbors:
        if n["device_type"] == "switch" and not n["in_inventory"] and n.get("ip"):
            new_sw_ip_count[n["ip"]] = new_sw_ip_count.get(n["ip"], 0) + 1

    switches_not_in_inventory = []
    for n in result_neighbors:
        if n["device_type"] == "switch" and not n["in_inventory"]:
            ip = n.get("ip")
            hop_ok = (
                bool(ip)
                and ip != device.ip_address
                and new_sw_ip_count.get(ip, 0) == 1
            )
            switches_not_in_inventory.append({**n, "hop_discoverable": hop_ok})

    return {
        "device_id": device_id,
        "hostname": device.hostname,
        "neighbor_count": len(neighbors),
        "neighbors": result_neighbors,
        "new_switches": switches_not_in_inventory,
    }


@router.post("/hop-discover", response_model=dict, status_code=202)
async def hop_discover(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """
    Cascade LLDP discovery: SSH into ghost-switch neighbors using inherited credentials,
    discover their neighbors, and repeat until no new switches are found (or depth limit).
    Returns a Celery task ID for progress tracking.
    """
    if not current_user.has_permission("task:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    body = await request.json()
    source_device_id = body.get("source_device_id")  # base device whose creds we inherit
    raw_ips = body.get("target_ips", [])              # IPs of ghost switches to probe
    max_depth = min(int(body.get("max_depth", 5)), 10)

    if not source_device_id or not raw_ips:
        raise HTTPException(status_code=400, detail="source_device_id and target_ips required")

    source_device = (await db.execute(select(Device).where(Device.id == source_device_id))).scalar_one_or_none()
    if not source_device:
        raise HTTPException(status_code=404, detail="Source device not found")

    # Deduplicate preserving order; skip source device's own IP (it's already in inventory)
    seen_ips: set[str] = set()
    target_ips: list[str] = []
    for ip in raw_ips:
        if ip and ip not in seen_ips and ip != source_device.ip_address:
            seen_ips.add(ip)
            target_ips.append(ip)

    if not target_ips:
        raise HTTPException(
            status_code=400,
            detail="No unique target IPs to discover (all ghost switches share the source IP or have no IP)"
        )

    from app.workers.tasks.topology_tasks import hop_discover_task

    task = Task(
        name=f"Hop Discovery from {source_device.hostname}",
        type=TaskType.MONITOR_POLL,
        status=TaskStatus.PENDING,
        device_ids=[source_device_id],
        total_devices=len(target_ips),
        created_by=current_user.id,
        parameters={"target_ips": target_ips, "max_depth": max_depth, "source_device_id": source_device_id},
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    hop_discover_task.apply_async(
        args=[task.id, source_device_id, target_ips, max_depth],
        queue="monitor",
    )

    await log_action(db, current_user, "hop_discovery_started", "task", task.id,
                     details={"target_count": len(target_ips), "max_depth": max_depth},
                     request=request)

    return {"task_id": task.id, "target_count": len(target_ips), "status": "accepted"}


@router.get("/ghost-switches", response_model=dict)
async def get_ghost_switches(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Return ghost nodes that look like switches — candidates for hop discovery."""
    result = await db.execute(
        select(TopologyLink)
        .where(TopologyLink.neighbor_device_id.is_(None))
        .where(TopologyLink.neighbor_type == "switch")
    )
    links = result.scalars().all()

    seen: set[str] = set()
    switches = []
    for link in links:
        key = link.neighbor_hostname
        if key not in seen:
            seen.add(key)
            switches.append({
                "hostname": link.neighbor_hostname,
                "ip": link.neighbor_ip,
                "platform": link.neighbor_platform,
                "source_device_id": link.device_id,
                "local_port": link.local_port,
                "neighbor_port": link.neighbor_port,
            })
    return {"count": len(switches), "switches": switches}


@router.get("/stats", response_model=dict)
async def get_topology_stats(db: AsyncSession = Depends(get_db), _: CurrentUser = None):
    total = (await db.execute(select(func.count()).select_from(TopologyLink))).scalar() or 0
    matched = (await db.execute(
        select(func.count()).select_from(TopologyLink)
        .where(TopologyLink.neighbor_device_id.is_not(None))
    )).scalar() or 0
    with_neighbors = (await db.execute(
        select(func.count(func.distinct(TopologyLink.device_id)))
    )).scalar() or 0
    return {
        "total_links": total,
        "matched_links": matched,
        "unmatched_links": total - matched,
        "devices_with_neighbors": with_neighbors,
    }


@router.post("/discover-ghost", response_model=dict)
async def discover_ghost(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """
    Attempt to SSH into a ghost switch node.
    1. If credentials provided: use those directly.
    2. Else: try all same-vendor devices' credentials from inventory.
    3. On success: add device to inventory, run LLDP, save links.
    4. On failure: return {needs_credentials: true}.
    """
    if not current_user.has_permission("task:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    body = await request.json()
    ghost_hostname: str = body.get("hostname") or ""
    ghost_ip: str = body.get("ip") or ""
    source_device_id: int | None = body.get("source_device_id")
    provided_username: str | None = body.get("username")
    provided_password: str | None = body.get("password")
    provided_os_type: str | None = body.get("os_type")

    if not ghost_ip:
        raise HTTPException(status_code=400, detail="IP address required")

    # Resolve source device for vendor/group hints
    source: Device | None = None
    if source_device_id:
        source = (await db.execute(select(Device).where(Device.id == source_device_id))).scalar_one_or_none()

    target_vendor = source.vendor if source else "other"

    # Build ordered list of credential dicts to try
    creds_to_try: list[dict] = []

    if provided_username and provided_password:
        os_type = provided_os_type or (source.os_type if source else "cisco_ios")
        creds_to_try.append({
            "username": provided_username,
            "password_enc": encrypt_credential(provided_password),
            "enable_secret_enc": source.enable_secret_enc if source else None,
            "os_type": os_type,
            "vendor": target_vendor,
        })
    else:
        # Collect unique (username, password_enc, os_type) from same-vendor inventory devices
        same_vendor = (await db.execute(
            select(Device).where(Device.vendor == target_vendor, Device.is_active == True)
        )).scalars().all()

        seen: set[tuple] = set()
        for d in same_vendor:
            key = (d.ssh_username, d.ssh_password_enc, d.os_type)
            if key not in seen:
                seen.add(key)
                creds_to_try.append({
                    "username": d.ssh_username,
                    "password_enc": d.ssh_password_enc,
                    "enable_secret_enc": d.enable_secret_enc,
                    "os_type": d.os_type,
                    "vendor": target_vendor,
                })

    if not creds_to_try:
        return {
            "success": False,
            "needs_credentials": True,
            "tried_count": 0,
            "message": f"No credentials found for vendor '{target_vendor}'",
        }

    # Try each credential set until one works
    from app.workers.tasks.topology_tasks import _parse_show_version

    svc = TopologyService(SSHManager())
    successful_creds: dict | None = None
    neighbors = []
    fetched_info: dict = {}
    successful_temp: object = None

    for creds in creds_to_try:
        from app.models.device import Device as DeviceModel
        temp = DeviceModel(
            id=0,
            hostname=ghost_hostname or ghost_ip,
            ip_address=ghost_ip,
            ssh_username=creds["username"],
            ssh_password_enc=creds["password_enc"],
            enable_secret_enc=creds.get("enable_secret_enc"),
            ssh_port=22,
            os_type=creds["os_type"],
            vendor=creds["vendor"],
            is_active=True,
        )
        try:
            neighbors = await svc.discover_device(temp)
            successful_creds = creds
            successful_temp = temp
            # Connection still open — grab show version for real hostname/model
            ver = await svc.ssh.execute_command(temp, "show version")
            if ver.success and ver.output:
                fetched_info = _parse_show_version(ver.output)
            break
        except Exception:
            continue

    await svc.ssh.close_all()

    if successful_creds is None:
        return {"success": False, "needs_credentials": True, "tried_count": len(creds_to_try)}

    # SSH succeeded — add to inventory if not already there
    existing = (await db.execute(
        select(Device).where(Device.ip_address == ghost_ip)
    )).scalar_one_or_none()

    real_hostname = fetched_info.get("hostname") or ghost_hostname or ghost_ip

    if existing:
        new_device = existing
        is_new = False
        # Update with better data if we got it
        if fetched_info.get("hostname") and existing.hostname == existing.ip_address:
            existing.hostname = fetched_info["hostname"]
        if fetched_info.get("model"):
            existing.model = fetched_info["model"]
        if fetched_info.get("firmware_version"):
            existing.firmware_version = fetched_info["firmware_version"]
        if fetched_info.get("serial_number"):
            existing.serial_number = fetched_info["serial_number"]
        existing.status = "online"
        await db.commit()
        await db.refresh(existing)
    else:
        new_device = Device(
            hostname=real_hostname,
            ip_address=ghost_ip,
            vendor=target_vendor,
            os_type=successful_creds["os_type"],
            model=fetched_info.get("model"),
            firmware_version=fetched_info.get("firmware_version"),
            serial_number=fetched_info.get("serial_number"),
            ssh_username=successful_creds["username"],
            ssh_password_enc=successful_creds["password_enc"],
            enable_secret_enc=successful_creds.get("enable_secret_enc"),
            ssh_port=22,
            status="online",
            is_active=True,
            location=source.location if source else None,
            group_id=source.group_id if source else None,
        )
        db.add(new_device)
        await db.commit()
        await db.refresh(new_device)
        is_new = True

    # Save LLDP links with the real device ID
    all_devices = (await db.execute(select(Device).where(Device.is_active == True))).scalars().all()
    hostname_map = {d.hostname.lower(): d.id for d in all_devices}
    ip_map = {d.ip_address: d.id for d in all_devices}

    if neighbors:
        await svc.save_links(db, new_device, neighbors, hostname_map)

    # Resolve existing ghost links for this hostname → point to the new device
    await db.execute(
        sql_update(TopologyLink)
        .where(TopologyLink.neighbor_hostname == (ghost_hostname or ghost_ip))
        .where(TopologyLink.neighbor_device_id.is_(None))
        .values(neighbor_device_id=new_device.id)
    )
    await db.commit()

    # Invalidate topology cache
    import redis as _redis_mod
    from app.core.config import settings as _cfg
    _r = _redis_mod.from_url(_cfg.REDIS_URL, decode_responses=True)
    for key in _r.keys("topology:graph:*"):
        _r.delete(key)

    await log_action(db, current_user, "ghost_device_discovered", "device", new_device.id,
                     new_device.hostname, details={"is_new": is_new, "neighbor_count": len(neighbors)},
                     request=request)

    result_neighbors = []
    for n in neighbors:
        known_id = hostname_map.get(n.neighbor_hostname.lower()) or ip_map.get(n.neighbor_ip or "")
        result_neighbors.append({
            "local_port": n.local_port,
            "hostname": n.neighbor_hostname,
            "ip": n.neighbor_ip,
            "port": n.neighbor_port,
            "platform": n.neighbor_platform,
            "device_type": detect_device_type(n.neighbor_platform, n.neighbor_hostname),
            "protocol": n.protocol,
            "in_inventory": bool(known_id),
            "device_id": known_id,
        })

    new_sw_ip_count2: dict[str, int] = {}
    for n in result_neighbors:
        if n["device_type"] == "switch" and not n["in_inventory"] and n.get("ip"):
            new_sw_ip_count2[n["ip"]] = new_sw_ip_count2.get(n["ip"], 0) + 1

    new_switches = []
    for n in result_neighbors:
        if n["device_type"] == "switch" and not n["in_inventory"]:
            ip = n.get("ip")
            hop_ok = (
                bool(ip)
                and ip != new_device.ip_address
                and new_sw_ip_count2.get(ip, 0) == 1
            )
            new_switches.append({**n, "hop_discoverable": hop_ok})

    return {
        "success": True,
        "device_id": new_device.id,
        "hostname": new_device.hostname,
        "is_new": is_new,
        "neighbor_count": len(neighbors),
        "neighbors": result_neighbors,
        "new_switches": new_switches,
    }


@router.get("/lldp-inventory", response_model=dict)
async def get_lldp_inventory(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    device_type: str = Query(None),
    site: str = Query(None),
):
    """Return all ghost nodes (non-inventory neighbors) grouped by hostname, optionally filtered by device_type."""
    query = select(TopologyLink).where(TopologyLink.neighbor_device_id.is_(None))
    if device_type:
        query = query.where(TopologyLink.neighbor_type == device_type)
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        query = query.where(TopologyLink.device_id.in_(site_ids))

    result = await db.execute(query.order_by(TopologyLink.last_seen.desc()))
    links = result.scalars().all()

    # Fetch device names for "connected via" column
    device_ids = {link.device_id for link in links}
    dev_rows = (await db.execute(select(Device).where(Device.id.in_(device_ids)))).scalars().all()
    dev_map = {d.id: d for d in dev_rows}

    # Deduplicate by hostname — keep the most recent entry
    seen: dict[str, dict] = {}
    for link in links:
        key = link.neighbor_hostname
        if key in seen:
            continue
        ntype = link.neighbor_type or detect_device_type(link.neighbor_platform, link.neighbor_hostname)
        src = dev_map.get(link.device_id)
        seen[key] = {
            "hostname": link.neighbor_hostname,
            "ip": link.neighbor_ip,
            "device_type": ntype,
            "platform": link.neighbor_platform,
            "local_port": link.local_port,
            "neighbor_port": link.neighbor_port,
            "protocol": link.protocol,
            "last_seen": link.last_seen.isoformat(),
            "connected_device_id": link.device_id,
            "connected_device_hostname": src.hostname if src else None,
            "connected_device_ip": src.ip_address if src else None,
        }

    items = list(seen.values())
    type_counts: dict[str, int] = {}
    for item in items:
        t = item["device_type"]
        type_counts[t] = type_counts.get(t, 0) + 1

    return {"total": len(items), "type_counts": type_counts, "items": items}


@router.get("/blast-radius/{device_id}", response_model=dict)
async def get_blast_radius(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """
    Graph traversal analysis: which devices would lose connectivity
    if the given device goes offline?
    """
    from collections import defaultdict, deque

    links_result = await db.execute(
        select(TopologyLink).where(TopologyLink.neighbor_device_id.isnot(None))
    )
    links = links_result.scalars().all()

    # Build undirected graph (inventory devices only)
    graph: dict[int, set[int]] = defaultdict(set)
    for link in links:
        if link.device_id != link.neighbor_device_id:
            graph[link.device_id].add(link.neighbor_device_id)
            graph[link.neighbor_device_id].add(link.device_id)

    all_nodes = set(graph.keys())
    direct_neighbors = len(graph.get(device_id, set()))

    if device_id not in all_nodes:
        return {
            "device_id": device_id,
            "direct_neighbors": 0,
            "affected_count": 0,
            "affected_devices": [],
            "is_critical": False,
            "total_nodes_in_topology": len(all_nodes),
        }

    # Build reduced graph without target device
    reduced: dict[int, set[int]] = {
        k: (v - {device_id}) for k, v in graph.items() if k != device_id
    }

    # Find connected components in reduced graph via BFS
    unvisited = set(reduced.keys())
    components: list[frozenset[int]] = []
    while unvisited:
        start = next(iter(unvisited))
        component: set[int] = set()
        queue: deque[int] = deque([start])
        while queue:
            node = queue.popleft()
            if node in component:
                continue
            component.add(node)
            unvisited.discard(node)
            for neighbor in reduced.get(node, set()):
                if neighbor not in component:
                    queue.append(neighbor)
        components.append(frozenset(component))

    backbone = max(components, key=len) if components else frozenset()
    target_nbrs = graph.get(device_id, set())

    affected_ids: set[int] = set()
    for comp in components:
        if comp == backbone:
            continue
        if comp & target_nbrs:
            affected_ids |= comp

    affected_devices = []
    if affected_ids:
        devs = (await db.execute(select(Device).where(Device.id.in_(affected_ids)))).scalars().all()
        affected_devices = [
            {
                "id": d.id,
                "hostname": d.hostname,
                "ip_address": d.ip_address,
                "vendor": d.vendor,
                "status": d.status,
                "layer": getattr(d, "layer", None),
            }
            for d in devs
        ]

    return {
        "device_id": device_id,
        "direct_neighbors": direct_neighbors,
        "affected_count": len(affected_ids),
        "affected_devices": affected_devices,
        "is_critical": len(affected_ids) > 0,
        "total_nodes_in_topology": len(all_nodes),
    }


@router.get("/anomalies", response_model=dict)
async def get_anomalies(db: AsyncSession = Depends(get_db), _: CurrentUser = None):
    """Detect L2 anomalies: duplicate hostnames, asymmetric links, stale links."""
    from collections import defaultdict
    from datetime import datetime, timezone, timedelta

    links_result = await db.execute(select(TopologyLink))
    links: list[TopologyLink] = links_result.scalars().all()

    devices_result = await db.execute(select(Device).where(Device.is_active == True))
    device_map: dict[int, Device] = {d.id: d for d in devices_result.scalars().all()}

    anomalies: list[dict] = []

    # ── 1. Duplicate hostname (same neighbor_hostname, different IPs) ──────────
    hostname_ips: dict[str, set[str]] = defaultdict(set)
    hostname_sources: dict[str, list[dict]] = defaultdict(list)
    for link in links:
        key = link.neighbor_hostname.lower()
        if link.neighbor_ip:
            hostname_ips[key].add(link.neighbor_ip)
        hostname_sources[key].append({
            "source": device_map.get(link.device_id, Device()).hostname if link.device_id in device_map else f"device#{link.device_id}",
            "port": link.local_port,
            "ip": link.neighbor_ip,
        })

    for hostname, ips in hostname_ips.items():
        if len(ips) > 1:
            sources = hostname_sources[hostname]
            anomalies.append({
                "type": "duplicate_hostname",
                "severity": "warning",
                "hostname": hostname,
                "message": f"'{hostname}' aynı hostname ile {len(ips)} farklı IP'den görünüyor",
                "details": {"ips": sorted(ips), "sources": sources[:6]},
            })

    # ── 2. Asymmetric link (A→B exists, B→A missing) ──────────────────────────
    inv_pairs: set[tuple[int, int]] = set()
    for link in links:
        if link.neighbor_device_id:
            inv_pairs.add((link.device_id, link.neighbor_device_id))

    seen_asym: set[tuple[int, int]] = set()
    for (a, b) in inv_pairs:
        if (b, a) not in inv_pairs:
            pair_key = (min(a, b), max(a, b))
            if pair_key not in seen_asym and a in device_map and b in device_map:
                seen_asym.add(pair_key)
                dev_a = device_map[a]
                dev_b = device_map[b]
                anomalies.append({
                    "type": "asymmetric_link",
                    "severity": "info",
                    "device_id": a,
                    "neighbor_device_id": b,
                    "message": f"{dev_a.hostname} → {dev_b.hostname} bağlantısı tek yönlü (LLDP asimetrik)",
                    "details": {
                        "source_hostname": dev_a.hostname,
                        "source_ip": dev_a.ip_address,
                        "target_hostname": dev_b.hostname,
                        "target_ip": dev_b.ip_address,
                    },
                })

    # ── 3. Stale links (last_seen > 7 days for inventory-to-inventory) ────────
    stale_threshold = datetime.now(timezone.utc) - timedelta(days=7)
    stale_by_device: dict[int, int] = defaultdict(int)
    for link in links:
        if link.neighbor_device_id and link.last_seen and link.last_seen < stale_threshold:
            stale_by_device[link.device_id] += 1

    for dev_id, count in stale_by_device.items():
        if dev_id in device_map:
            d = device_map[dev_id]
            anomalies.append({
                "type": "stale_links",
                "severity": "warning",
                "device_id": dev_id,
                "message": f"{d.hostname} cihazının {count} topoloji bağlantısı 7+ gündür güncellenmedi",
                "details": {"hostname": d.hostname, "ip": d.ip_address, "stale_count": count},
            })

    # ── 4. Ghost switch overload (device with many unresolved neighbors) ───────
    ghost_by_device: dict[int, int] = defaultdict(int)
    for link in links:
        if link.neighbor_device_id is None and (link.neighbor_type or "other") in ("switch", "router"):
            ghost_by_device[link.device_id] += 1

    for dev_id, count in ghost_by_device.items():
        if count >= 3 and dev_id in device_map:
            d = device_map[dev_id]
            anomalies.append({
                "type": "ghost_overload",
                "severity": "info",
                "device_id": dev_id,
                "message": f"{d.hostname} cihazının {count} switch/router komşusu envanterde yok",
                "details": {"hostname": d.hostname, "ip": d.ip_address, "ghost_count": count},
            })

    severity_order = {"warning": 0, "info": 1}
    anomalies.sort(key=lambda x: severity_order.get(x["severity"], 2))

    return {
        "count": len(anomalies),
        "warning_count": sum(1 for a in anomalies if a["severity"] == "warning"),
        "info_count": sum(1 for a in anomalies if a["severity"] == "info"),
        "anomalies": anomalies,
    }
