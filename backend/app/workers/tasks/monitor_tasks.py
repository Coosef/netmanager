import asyncio
import hashlib
import json
import logging
import sys
from datetime import datetime, timezone, timedelta

import redis
from sqlalchemy import select, update

from app.core.config import settings
from app.models.device import Device, DeviceStatus
from app.models.network_event import NetworkEvent
from app.models.topology import TopologyLink
from app.services.ssh_manager import SSHManager
from app.workers.celery_app import celery_app

_redis = redis.from_url(settings.REDIS_URL, decode_responses=True)
logger = logging.getLogger(__name__)

FLAP_THRESHOLD = 10   # status changes/hour before device is considered "flapping"
OFFLINE_DEDUP_TTL = 1800   # 30 min — cap offline events at 2/hour per device
ONLINE_DEDUP_TTL  = 1800   # same for online events
FLAP_DEDUP_TTL    = 3600   # fire flapping alert at most once per hour
CORR_DEDUP_TTL    = 3600   # correlation incidents at most once per hour

STP_PATTERNS = [
    ("topology change", "STP Topoloji Değişikliği", "warning"),
    ("TCN", "STP TCN Algılandı", "warning"),
    ("inconsistency", "STP Tutarsızlık", "critical"),
    ("loop guard", "Loop Guard Tetiklendi", "critical"),
    ("bpdu guard", "BPDU Guard Tetiklendi", "critical"),
    ("root guard", "Root Guard Tetiklendi", "warning"),
]

LOOP_PATTERNS = [
    ("mac address flapping", "MAC Flapping Tespit Edildi", "critical"),
    ("mac flapping", "MAC Flapping Tespit Edildi", "critical"),
    ("duplicate mac", "Çift MAC Adresi", "critical"),
    ("loop detected", "Döngü Tespit Edildi", "critical"),
    ("storm control", "Storm Control Tetiklendi", "warning"),
]

PORT_DOWN_PATTERNS = ["changed state to down", "went down", "link down", "err-disabled"]
PORT_UP_PATTERNS   = ["changed state to up",   "came up",    "link up"]


def _run_async(coro):
    return asyncio.run(coro)


async def _icmp_ping(ip: str, timeout: int = 3) -> bool:
    """Single ICMP ping; returns True if host responds."""
    flag = "-n" if sys.platform == "win32" else "-c"
    w_flag = ["-w", str(timeout * 1000)] if sys.platform == "win32" else ["-W", str(timeout)]
    try:
        proc = await asyncio.create_subprocess_exec(
            "ping", flag, "1", *w_flag, ip,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.communicate(), timeout=timeout + 1)
        return proc.returncode == 0
    except Exception:
        return False


def _agent_is_online(agent_id: str) -> bool:
    """True if the agent is currently online (refreshed every 15s, TTL 60s)."""
    return bool(_redis.exists(f"agent:{agent_id}:online"))


async def _check_device_reachable(device) -> bool:
    """
    Reachability check used by the Celery poller.

    • Agent-proxied devices whose agent is online → skip (the agent's own
      device_status_report loop already keeps DB/Redis up to date).
      Return current DB status so the poller doesn't create a spurious change.
    • Everything else → ICMP ping directly from the backend host.
    """
    agent_id = getattr(device, "agent_id", None)
    if agent_id and _agent_is_online(agent_id):
        from app.models.device import DeviceStatus
        return device.status == DeviceStatus.ONLINE

    return await _icmp_ping(device.ip_address)


def _get_db():
    from app.core.database import SyncSessionLocal
    return SyncSessionLocal()


def _is_in_maintenance(db, device_id: int | None) -> bool:
    """Return True if device is currently covered by an active maintenance window.
    Active windows are cached in Redis for 60s to avoid repeated DB queries per poll."""
    cache_key = "maint:active_windows"
    cached = _redis.get(cache_key)
    if cached is not None:
        windows = json.loads(cached)
    else:
        from app.models.maintenance_window import MaintenanceWindow
        now = datetime.now(timezone.utc)
        rows = db.execute(
            select(MaintenanceWindow).where(
                MaintenanceWindow.start_time <= now,
                MaintenanceWindow.end_time >= now,
            )
        ).scalars().all()
        windows = [
            {"applies_to_all": w.applies_to_all, "device_ids": w.device_ids or []}
            for w in rows
        ]
        _redis.setex(cache_key, 60, json.dumps(windows))

    if not windows:
        return False
    for w in windows:
        if w["applies_to_all"]:
            return True
        if device_id is not None and device_id in w["device_ids"]:
            return True
    return False


def _is_duplicate_event(device_id: int | None, event_type: str, dedup_key: str, ttl: int = 300) -> bool:
    """Return True if an identical event was saved within `ttl` seconds."""
    key = f"event:dedup:{device_id}:{event_type}:{dedup_key[:64]}"
    if _redis.get(key):
        return True
    _redis.setex(key, ttl, "1")
    return False


def _save_event(db, device, event_type: str, severity: str, title: str,
                message: str = "", details: dict = None, dedup_key: str = "",
                dedup_ttl: int = 300):
    if _is_in_maintenance(db, device.id if device else None):
        return None
    if dedup_key and _is_duplicate_event(
        device.id if device else None, event_type, dedup_key or title, ttl=dedup_ttl
    ):
        return None
    event = NetworkEvent(
        device_id=device.id if device else None,
        device_hostname=device.hostname if device else None,
        event_type=event_type,
        severity=severity,
        title=title,
        message=message,
        details=details or {},
    )
    db.add(event)
    db.commit()
    db.refresh(event)

    payload = {
        "id": event.id,
        "device_id": event.device_id,
        "device_hostname": event.device_hostname,
        "event_type": event_type,
        "severity": severity,
        "title": title,
        "message": message,
        "ts": event.created_at.isoformat(),
    }
    _redis.publish("network:events", json.dumps(payload))
    _redis.lpush("network:events:recent", json.dumps(payload))
    _redis.ltrim("network:events:recent", 0, 499)

    # Invalidate cached risk score when status-affecting events fire
    if event_type in ("device_offline", "device_online", "device_flapping",
                      "config_drift", "stp_anomaly", "correlation_incident"):
        if device and device.id:
            _redis.delete(f"risk:device:{device.id}")

    # Fire event-based playbook triggers asynchronously
    try:
        from app.workers.tasks.playbook_tasks import trigger_event_playbooks
        trigger_event_playbooks.apply_async(
            args=[event_type, device.id if device else None],
            queue="monitor",
        )
    except Exception:
        pass

    return event


def _increment_flap_counter(device_id: int) -> int:
    """Track status changes per device; return current count in the last hour."""
    key = f"flap:{device_id}:count"
    count = _redis.incr(key)
    if count == 1:
        _redis.expire(key, 3600)  # reset every hour
    return count


def _is_flapping(device_id: int) -> bool:
    """Return True if device has >= FLAP_THRESHOLD status changes in the current hour."""
    count = _redis.get(f"flap:{device_id}:count")
    return int(count or 0) >= FLAP_THRESHOLD


def _correlate_offline_events(db, newly_offline: list) -> None:
    """
    Topoloji BFS ile root cause tespiti.
    Adımlar:
    1. Topology_links tablosundan upstream haritası oluştur.
    2. Her offline cihazdan BFS ile ortak upstream bul.
    3. Bulunan root cause cihazı için tek bir kritik event yaz.
       Downstream cihazların ayrı uyarıları "bastırıldı" işaretlenir.
    """
    if len(newly_offline) < 2:
        return

    # Exclude flapping devices — they are unstable and cause spurious cascades.
    stable_offline = [d for d in newly_offline if not _is_flapping(d.id)]
    if len(stable_offline) < 2:
        return
    newly_offline = stable_offline

    offline_ids = {d.id for d in newly_offline}
    id_to_device = {d.id: d for d in newly_offline}

    # Topology bağlantıları: device_id → upstream neighbor_device_id listesi
    links = db.execute(
        select(TopologyLink.device_id, TopologyLink.neighbor_device_id)
        .where(TopologyLink.neighbor_device_id.isnot(None))
    ).fetchall()

    # downstream → upstream haritası (bir cihazın upstream'leri kimler?)
    upstream_of: dict[int, set[int]] = {}
    downstream_of: dict[int, set[int]] = {}
    for dev_id, nbr_id in links:
        upstream_of.setdefault(dev_id, set()).add(nbr_id)
        downstream_of.setdefault(nbr_id, set()).add(dev_id)

    # Her offline cihaz için: direkt upstream'i de offline mi?
    cascade_children: set[int] = set()   # bu cihazlar cascade — ayrı uyarı yaratma
    root_causes: dict[int, list[int]] = {}  # root_id → etkilenen cihaz id'leri

    for dev in newly_offline:
        parents = upstream_of.get(dev.id, set())
        # Upstream'i de offline olduysa bu bir cascade vakasıdır
        if parents & offline_ids:
            cascade_children.add(dev.id)

    # Gerçek root'lar: offline olup cascade child olmayan cihazlar
    real_roots = [d for d in newly_offline if d.id not in cascade_children]

    for root in real_roots:
        # BFS ile bu root'tan erişilebilen tüm downstream offline cihazları bul
        visited: set[int] = set()
        queue = [root.id]
        while queue:
            current = queue.pop()
            if current in visited:
                continue
            visited.add(current)
            for child in downstream_of.get(current, set()):
                if child in offline_ids and child not in visited:
                    queue.append(child)

        affected_ids = [i for i in visited if i != root.id]
        if not affected_ids:
            continue  # tek başına offline, cascade değil

        root_causes[root.id] = affected_ids

    # Root cause event'leri yaz
    for root_id, affected_ids in root_causes.items():
        root_dev = id_to_device[root_id]
        affected_devs = [id_to_device[i] for i in affected_ids if i in id_to_device]
        affected_names = ", ".join(d.hostname for d in affected_devs[:5])
        total = len(affected_ids)

        _save_event(
            db, root_dev,
            "correlation_incident", "critical",
            f"KÖK NEDEN: {root_dev.hostname} → {total} cihaz etkilendi",
            f"Cascade etkilenen: {affected_names}{'...' if total > 5 else ''}",
            details={
                "root_device_id": root_id,
                "root_hostname": root_dev.hostname,
                "affected_count": total,
                "affected_devices": [
                    {"id": id_to_device[i].id, "hostname": id_to_device[i].hostname}
                    for i in affected_ids if i in id_to_device
                ],
                "suppressed_alerts": len(affected_ids),
            },
            dedup_key=f"rootcause:{root_id}",
            dedup_ttl=CORR_DEDUP_TTL,
        )

    # Cascade child'ların device_offline event'lerini bastır
    # (Redis'te dedup key'i set ederek aynı poll'da tekrar yaratılmasını engelle)
    for child_id in cascade_children:
        _redis.setex(f"event:dedup:{child_id}:device_offline:offline:{child_id}", 300, "suppressed")


@celery_app.task(name="app.workers.tasks.monitor_tasks.poll_device_status")
def poll_device_status():
    """
    Two-pass polling:
      Pass 1 — Test all devices via ICMP ping (agent-side ping fallback for private-LAN devices),
               update DB/Redis status.
      Pass 2 — Group status changes and fire deduplicated events:
        • N+ devices from the same agent going offline → single "agent_outage" event
        • Devices beyond FLAP_THRESHOLD → single "device_flapping" event (no per-poll events)
        • Everything else → individual device_offline / device_online events
    """
    from collections import defaultdict

    # How many devices from the same agent offline at once = agent issue, not individual
    AGENT_GROUP_MIN = 3

    db = _get_db()
    try:
        devices = db.execute(select(Device).where(Device.is_active == True)).scalars().all()
        total = len(devices)
        if total == 0:
            return

        # ── Pass 1: Ping devices, update DB/Redis ──────────────────────────
        # changes: (device, new_status, error_msg)
        changes: list[tuple] = []
        now_ts = datetime.now(timezone.utc)
        for device in devices:
            try:
                # Skip devices whose agent is recently offline — avoids false flap increments
                if device.agent_id and _redis.get(f"agent:{device.agent_id}:recently_offline"):
                    continue

                prev_status = device.status
                reachable = _run_async(_check_device_reachable(device))
                new_status = DeviceStatus.ONLINE if reachable else DeviceStatus.OFFLINE

                db.execute(update(Device).where(Device.id == device.id).values(
                    status=new_status,
                    last_seen=now_ts if reachable else device.last_seen,
                ))
                _redis.setex(
                    f"device:{device.id}:status", 600,
                    json.dumps({"status": new_status, "ts": now_ts.isoformat()}),
                )

                if prev_status != new_status:
                    error_msg = "" if reachable else "no ping response"
                    changes.append((device, new_status, error_msg))
            except Exception as exc:
                logger.warning("poll error for %s: %s", device.hostname, exc)

        # Single commit for all status updates — reduces N DB roundtrips to 1
        try:
            db.commit()
        except Exception as exc:
            logger.error("Failed to commit device status batch: %s", exc)
            db.rollback()

        if not changes:
            return

        # ── Pass 2: Pattern analysis & event generation ─────────────────────
        newly_offline_all = [(d, err) for d, ns, err in changes if ns == DeviceStatus.OFFLINE]
        newly_online_all  = [d for d, ns, _ in changes if ns == DeviceStatus.ONLINE]

        # Increment flap counters for all devices that changed state
        flap_counts: dict[int, int] = {}
        for device, _, _ in changes:
            flap_counts[device.id] = _increment_flap_counter(device.id)

        # Group offline devices by their agent_id
        agent_groups: dict[str, list] = defaultdict(list)   # agent_id → [(device, err)]
        no_agent_offline: list[tuple] = []
        for dev, err in newly_offline_all:
            aid = getattr(dev, "agent_id", None)
            if aid:
                agent_groups[aid].append((dev, err))
            else:
                no_agent_offline.append((dev, err))

        # Devices eligible for correlation (non-flapping, non-agent-grouped)
        stable_for_correlation: list = []

        # ── Agent-grouped offline (N+ devices from same agent) ───────────────
        for agent_id, group in agent_groups.items():
            # Flapping alerts fire once when threshold crossed (regardless of group size)
            for dev, _ in group:
                fc = flap_counts[dev.id]
                if fc == FLAP_THRESHOLD:
                    _save_event(
                        db, dev, "device_flapping", "critical",
                        f"FLAP ALGILANDI: {dev.hostname} ({fc}x/saat)",
                        f"Son 1 saatte {fc} durum değişikliği. Bireysel olaylar bastırıldı.",
                        dedup_key=f"flap_alert:{dev.id}",
                        dedup_ttl=FLAP_DEDUP_TTL,
                    )

            if len(group) >= AGENT_GROUP_MIN:
                # Single grouped event instead of N individual events
                not_flapping = [(d, e) for d, e in group if flap_counts[d.id] < FLAP_THRESHOLD]
                if not_flapping:
                    hostnames = ", ".join(d.hostname for d, _ in not_flapping[:6])
                    cnt = len(group)
                    _save_event(
                        db, group[0][0], "agent_outage", "critical",
                        f"AGENT KESİNTİSİ: {agent_id} — {cnt} cihaz etkilendi",
                        f"Aynı anda offline olan cihazlar: {hostnames}{'...' if cnt > 6 else ''}",
                        dedup_key=f"agent_outage:{agent_id}",
                        dedup_ttl=CORR_DEDUP_TTL,  # 1 saat — agent döngüleri çok event üretmemeli
                    )
            else:
                # Small group — individual events (with flap suppression)
                for dev, err in group:
                    if flap_counts[dev.id] < FLAP_THRESHOLD:
                        _save_event(
                            db, dev, "device_offline", "critical",
                            f"{dev.hostname} çevrimdışı",
                            f"SSH bağlantısı başarısız: {err}",
                            dedup_key=f"offline:{dev.id}",
                            dedup_ttl=OFFLINE_DEDUP_TTL,
                        )
                        stable_for_correlation.append(dev)

        # ── Non-agent offline ────────────────────────────────────────────────
        for dev, err in no_agent_offline:
            fc = flap_counts[dev.id]
            if fc == FLAP_THRESHOLD:
                _save_event(
                    db, dev, "device_flapping", "critical",
                    f"FLAP ALGILANDI: {dev.hostname} ({fc}x/saat)",
                    f"Son 1 saatte {fc} durum değişikliği. Bireysel olaylar bastırıldı.",
                    dedup_key=f"flap_alert:{dev.id}",
                    dedup_ttl=FLAP_DEDUP_TTL,
                )
            if fc < FLAP_THRESHOLD:
                _save_event(
                    db, dev, "device_offline", "critical",
                    f"{dev.hostname} çevrimdışı",
                    f"SSH bağlantısı başarısız: {err}",
                    dedup_key=f"offline:{dev.id}",
                    dedup_ttl=OFFLINE_DEDUP_TTL,
                )
                stable_for_correlation.append(dev)

        # ── Online events ────────────────────────────────────────────────────
        for dev in newly_online_all:
            if flap_counts.get(dev.id, 0) < FLAP_THRESHOLD:
                _save_event(
                    db, dev, "device_online", "info",
                    f"{dev.hostname} tekrar çevrimiçi",
                    dedup_key=f"online:{dev.id}",
                    dedup_ttl=ONLINE_DEDUP_TTL,
                )

        # ── Topology correlation (only stable, non-grouped devices) ──────────
        if stable_for_correlation:
            _correlate_offline_events(db, stable_for_correlation)

    finally:
        db.close()


@celery_app.task(name="app.workers.tasks.monitor_tasks.check_stp_anomalies")
def check_stp_anomalies(device_ids: list[int]):
    db = _get_db()
    ssh = SSHManager()
    found = []
    try:
        devices = db.execute(select(Device).where(Device.id.in_(device_ids))).scalars().all()
        for device in devices:
            try:
                result = _run_async(ssh.execute_command(device, "show spanning-tree"))
                if not result.success:
                    continue
                output_lower = result.output.lower()
                for pattern, label, severity in STP_PATTERNS:
                    if pattern.lower() in output_lower:
                        ev = _save_event(db, device, "stp_anomaly", severity, label,
                                         f"Pattern: '{pattern}'",
                                         {"pattern": pattern, "snippet": result.output[:300]},
                                         dedup_key=f"stp:{device.id}:{pattern}",
                                         dedup_ttl=1800)
                        if ev:
                            found.append(ev.id)
                            _redis.publish("anomalies", json.dumps({
                                "device_id": device.id, "hostname": device.hostname,
                                "type": "stp", "patterns": [pattern],
                                "ts": datetime.now(timezone.utc).isoformat()}))
                        break
            except Exception:
                pass
    finally:
        _run_async(ssh.close_all())
        db.close()
    return found


@celery_app.task(name="app.workers.tasks.monitor_tasks.check_loop_detection")
def check_loop_detection(device_ids: list[int]):
    db = _get_db()
    ssh = SSHManager()
    found = []
    try:
        devices = db.execute(select(Device).where(Device.id.in_(device_ids))).scalars().all()
        for device in devices:
            try:
                result = _run_async(ssh.execute_command(device, "show log | include flap"))
                if not result.success:
                    continue
                output_lower = result.output.lower()
                for pattern, label, severity in LOOP_PATTERNS:
                    if pattern.lower() in output_lower:
                        ev = _save_event(db, device, "loop_detected", severity, label,
                                         f"Pattern: '{pattern}'",
                                         {"pattern": pattern, "snippet": result.output[:300]},
                                         dedup_key=f"loop:{device.id}:{pattern}",
                                         dedup_ttl=1800)
                        if ev:
                            found.append(ev.id)
                            _redis.publish("anomalies", json.dumps({
                                "device_id": device.id, "hostname": device.hostname,
                                "type": "loop", "patterns": [pattern],
                                "ts": datetime.now(timezone.utc).isoformat()}))
                        break
            except Exception:
                pass
    finally:
        _run_async(ssh.close_all())
        db.close()
    return found


@celery_app.task(name="app.workers.tasks.monitor_tasks.check_port_status")
def check_port_status(device_ids: list[int]):
    """Detect port up/down via SNMP ifOperStatus state comparison.

    Compares current ifOperStatus against the last known state stored in Redis.
    Only fires an event when the state *actually changes*, so no log-buffer
    flooding and no duplicate events on restart.  Falls back to the old
    SSH-log approach for devices that have SNMP disabled.
    """
    from app.services import snmp_service
    db = _get_db()
    ssh = SSHManager()
    try:
        devices = db.execute(select(Device).where(Device.id.in_(device_ids))).scalars().all()
        for device in devices:
            try:
                if device.snmp_enabled and device.snmp_community:
                    # ── SNMP path: compare current ifOperStatus to last known state ──
                    try:
                        ifaces = _run_async(snmp_service.get_interfaces(
                            device.ip_address,
                            device.snmp_community,
                            getattr(device, "snmp_version", "v2c") or "v2c",
                            port=getattr(device, "snmp_port", 161) or 161,
                        ))
                    except Exception:
                        ifaces = []

                    for iface in ifaces:
                        name = iface.get("name", "")
                        if not name:
                            continue
                        # Skip loopbacks and management ports (usually Vlan, Lo, Mgmt)
                        nl = name.lower()
                        if any(nl.startswith(p) for p in ("vlan", "loopback", "lo", "mgmt", "null", "tunnel")):
                            continue
                        # Skip admin-down ports — only track operationally monitored ports
                        if not iface.get("admin_up", True):
                            continue

                        curr_state = "up" if iface.get("oper_up") else "down"
                        state_key = f"port:state:{device.id}:{name}"
                        prev_state = _redis.get(state_key)

                        # Always persist current state (TTL 2 hours so it survives poll gaps)
                        _redis.set(state_key, curr_state, ex=7200)

                        if prev_state is None:
                            # First observation — establish baseline, no event
                            continue
                        if prev_state == curr_state:
                            continue

                        # State changed — fire exactly one event with a 30-min cooldown
                        if curr_state == "down":
                            _save_event(
                                db, device, "port_change", "warning",
                                f"{device.hostname} — Port çevrimdışı: {name}",
                                f"Port {name} down oldu (SNMP ifOperStatus)",
                                {"port": name, "prev": prev_state, "curr": curr_state, "source": "snmp"},
                                dedup_key=f"port:{device.id}:{name}:down",
                                dedup_ttl=1800,
                            )
                        else:
                            _save_event(
                                db, device, "port_change", "info",
                                f"{device.hostname} — Port çevrimiçi: {name}",
                                f"Port {name} up oldu (SNMP ifOperStatus)",
                                {"port": name, "prev": prev_state, "curr": curr_state, "source": "snmp"},
                                dedup_key=f"port:{device.id}:{name}:up",
                                dedup_ttl=1800,
                            )
                else:
                    # ── SSH fallback: parse log, but only lines from last 10 minutes ──
                    result = _run_async(ssh.execute_command(device, "show log | include changed state"))
                    if not result.success:
                        continue
                    cutoff = datetime.now(timezone.utc) - timedelta(minutes=10)
                    for line in result.output.splitlines()[-30:]:
                        ll = line.lower()
                        # Try to extract timestamp and skip stale lines
                        # Cisco IOS format: "*May  2 11:07:16.xxx:" or "May  2 11:07:16:"
                        ts_ok = True
                        try:
                            import re as _re
                            m = _re.search(r'\b(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})', line)
                            if m:
                                month_str, day_str, time_str = m.group(1), m.group(2), m.group(3)
                                # Build a datetime for current year
                                import calendar as _cal
                                months = {v.lower(): k for k, v in enumerate(_cal.month_abbr) if v}
                                mon = months.get(month_str.lower(), 0)
                                if mon:
                                    now = datetime.now(timezone.utc)
                                    h, mi, s = map(int, time_str.split(":"))
                                    candidate = datetime(now.year, mon, int(day_str), h, mi, s, tzinfo=timezone.utc)
                                    # If candidate is in the future (year boundary), try previous year
                                    if candidate > now + timedelta(minutes=1):
                                        candidate = candidate.replace(year=now.year - 1)
                                    ts_ok = candidate >= cutoff
                        except Exception:
                            pass  # Can't parse timestamp — allow the line through
                        if not ts_ok:
                            continue
                        # Use a long-lived dedup key so the same log line won't re-fire for 24h
                        line_hash = hashlib.md5(line.strip().encode()).hexdigest()[:16]
                        if any(p in ll for p in PORT_DOWN_PATTERNS):
                            _save_event(db, device, "port_change", "warning",
                                        f"{device.hostname} — Port çevrimdışı",
                                        line.strip(), {"log_line": line.strip(), "source": "ssh_log"},
                                        dedup_key=line_hash, dedup_ttl=86400)
                        elif any(p in ll for p in PORT_UP_PATTERNS):
                            _save_event(db, device, "port_change", "info",
                                        f"{device.hostname} — Port çevrimiçi",
                                        line.strip(), {"log_line": line.strip(), "source": "ssh_log"},
                                        dedup_key=line_hash, dedup_ttl=86400)
            except Exception:
                pass
    finally:
        _run_async(ssh.close_all())
        db.close()


@celery_app.task(name="app.workers.tasks.monitor_tasks.check_lldp_changes")
def check_lldp_changes(device_ids: list[int]):
    """Detect new LLDP neighbors not yet in topology and generate port_new_device events."""
    from app.models.topology import TopologyLink
    from app.services.topology_service import TopologyService, detect_device_type

    db = _get_db()
    ssh = SSHManager()
    try:
        devices = db.execute(select(Device).where(Device.id.in_(device_ids))).scalars().all()
        for device in devices:
            try:
                svc = TopologyService(ssh)
                neighbors = _run_async(svc.discover_device(device))
                if not neighbors:
                    continue

                # Get existing topology links for this device
                existing_links = db.execute(
                    select(TopologyLink).where(TopologyLink.device_id == device.id)
                ).scalars().all()
                known_neighbors = {
                    lnk.neighbor_hostname.lower() for lnk in existing_links if lnk.neighbor_hostname
                }

                for n in neighbors:
                    nh = (n.neighbor_hostname or "").lower()
                    if not nh or nh in known_neighbors:
                        continue
                    # New neighbor found
                    ntype = detect_device_type(n.neighbor_platform, n.neighbor_hostname)
                    _save_event(
                        db, device,
                        "new_device_connected", "warning",
                        f"{device.hostname} — Yeni cihaz bağlandı: {n.neighbor_hostname}",
                        f"Port: {n.local_port} → {n.neighbor_hostname} ({n.neighbor_ip or '?'})",
                        {
                            "local_port": n.local_port,
                            "neighbor_hostname": n.neighbor_hostname,
                            "neighbor_ip": n.neighbor_ip,
                            "neighbor_port": n.neighbor_port,
                            "device_type": ntype,
                            "protocol": n.protocol,
                        },
                        dedup_key=f"new_neighbor:{device.id}:{nh}",
                    )
            except Exception:
                pass
    finally:
        _run_async(ssh.close_all())
        db.close()


@celery_app.task(name="app.workers.tasks.monitor_tasks.cleanup_stale_tasks")
def cleanup_stale_tasks():
    """Mark tasks stuck in PENDING/RUNNING for > 2 hours as FAILED."""
    from app.models.task import Task, TaskStatus
    from sqlalchemy import or_
    from sqlalchemy import update as _update

    cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
    db = _get_db()
    try:
        db.execute(
            _update(Task)
            .where(
                or_(Task.status == TaskStatus.PENDING, Task.status == TaskStatus.RUNNING),
                Task.created_at < cutoff,
            )
            .values(
                status=TaskStatus.FAILED,
                completed_at=datetime.now(timezone.utc),
            )
        )
        db.commit()
    finally:
        db.close()
