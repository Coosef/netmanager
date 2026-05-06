import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.device import Device
from app.models.snmp_metric import SnmpPollResult
from app.models.topology import TopologyLink
from app.services.ssh_manager import SSHManager


# ── Device type detection ─────────────────────────────────────────────────────

_TYPE_RULES: list[tuple[str, list[str]]] = [
    ("switch",  ["switch", "sw-", "-sw", "catalyst", "nexus", "cs83", "ruijie s", "rg-s", "rg-s",
                 "procurve", "aruba s", "cx ", "6300", "6200", "2930", "2540", "ex-", " ex ", "qfx",
                 "srx", "s1700", "s5700", "s3700", "s3800"]),
    ("router",  ["router", " isr", " asr", " csr", " ncs", "juniper mx", "vrp", "ar", "er-"]),
    ("ap",      ["access point", " ap-", "-ap", "aironet", "aruba ap", "aruba instant",
                 "unifi ap", "ruckus ap", "cap", "wlan ap", "wifi", "802.11"]),
    ("phone",   ["ip phone", "voip", "cisco phone", "polycom", "yealink", "snom", "avaya phone"]),
    ("printer", ["printer", "laserjet", "hp lj", "xerox", "brother hl", "canon lbp"]),
    ("camera",  ["camera", "dahua", "hikvision", "axis p", "axis q", "ip cam", "nvr"]),
    ("firewall",["firewall", "asa", "palo alto", "fortinet", "fortigate", "check point", "srx"]),
    ("server",  ["server", "esxi", "vmware", "proxmox", "linux", "windows server", "ubuntu"]),
    ("laptop",  ["laptop", "notebook", "thinkpad", "latitude", "macbook"]),
]


def detect_device_type(platform: str | None, hostname: str | None = None) -> str:
    check = f"{platform or ''} {hostname or ''}".lower()
    for dtype, keywords in _TYPE_RULES:
        for kw in keywords:
            if kw in check:
                return dtype
    return "other"


@dataclass
class NeighborInfo:
    local_port: str
    neighbor_hostname: str
    neighbor_port: str
    protocol: str
    neighbor_ip: Optional[str] = None
    neighbor_platform: Optional[str] = None
    # Extended port attributes (best-effort, populated after LLDP parse)
    local_duplex: Optional[str] = None       # full | half | auto
    local_port_mode: Optional[str] = None    # access | trunk | routed
    local_vlan: Optional[int] = None         # access VLAN or trunk native VLAN
    local_poe_enabled: Optional[bool] = None
    local_poe_mw: Optional[int] = None       # milliwatts


# ── Parsers ──────────────────────────────────────────────────────────────────

def _normalize_port(port: str) -> str:
    """Shorten and normalise port names: GigabitEthernet 0/1 → Gi0/1"""
    replacements = [
        ("GigabitEthernet", "Gi"), ("FastEthernet", "Fa"),
        ("TenGigabitEthernet", "Te"), ("TwentyFiveGigE", "Twe"),
        ("FortyGigabitEthernet", "Fo"), ("HundredGigE", "Hu"),
        ("gigabitethernet", "Gi"), ("fastethernet", "Fa"),
    ]
    for long, short in replacements:
        port = port.replace(long, short)
    # Strip ALL internal whitespace so "Gi 0/1" → "Gi0/1"
    return re.sub(r"\s+", "", port.strip())


# ── Extended port-info parsers ────────────────────────────────────────────────

def _parse_interfaces_duplex(output: str) -> dict[str, str]:
    """Return {norm_port: duplex} from 'show interfaces' output (Cisco + Ruijie)."""
    result: dict[str, str] = {}
    current_port: str | None = None
    for line in output.splitlines():
        # Interface header starts at column-0 and contains "is up/down"
        if re.match(r"^[A-Za-z]", line):
            hm = re.match(r"^(.+?)\s+is\s+(?:up|down|administratively)", line)
            if hm:
                current_port = _normalize_port(hm.group(1).strip())
            else:
                current_port = None
        elif current_port:
            dm = re.search(r"\b(Full|Half|Auto)-[Dd]uplex\b", line)
            if dm:
                result[current_port] = dm.group(1).lower()
    return result


def _parse_switchport_cisco(output: str) -> dict[str, dict]:
    """Return {norm_port: {mode, vlan}} from 'show interfaces switchport' (Cisco IOS/NX-OS)."""
    result: dict[str, dict] = {}
    current_port: str | None = None
    current: dict = {}
    for line in output.splitlines():
        nm = re.match(r"^Name:\s+(\S+)", line, re.IGNORECASE)
        if nm:
            current_port = _normalize_port(nm.group(1))
            current = {}
            result[current_port] = current
            continue
        if current_port is None:
            continue
        adm = re.search(r"Administrative Mode:\s+(.+)", line, re.IGNORECASE)
        if adm:
            raw = adm.group(1).strip().lower()
            current["mode"] = "trunk" if "trunk" in raw else ("access" if "access" in raw else raw)
            continue
        acc = re.search(r"Access Mode VLAN:\s+(\d+)", line, re.IGNORECASE)
        if acc:
            current["vlan"] = int(acc.group(1))
            continue
        nat = re.search(r"Trunking Native Mode VLAN:\s+(\d+)", line, re.IGNORECASE)
        if nat and current.get("mode") == "trunk":
            current.setdefault("vlan", int(nat.group(1)))
    return result


def _parse_switchport_ruijie(output: str) -> dict[str, dict]:
    """Return {norm_port: {mode, vlan}} from Ruijie 'show interfaces switchport'."""
    result: dict[str, dict] = {}
    for line in output.splitlines():
        # Table row: "GigabitEthernet 0/1   Enabled  ACCESS  10   1"
        m = re.match(
            r"^((?:GigabitEthernet|FastEthernet|TenGigabitEthernet)\s*[\d/]+)"
            r"\s+\S+\s+(ACCESS|TRUNK)\s+(\d+)",
            line, re.IGNORECASE,
        )
        if m:
            port = _normalize_port(m.group(1))
            result[port] = {"mode": m.group(2).lower(), "vlan": int(m.group(3))}
    return result


def _parse_power_inline(output: str) -> dict[str, dict]:
    """Return {norm_port: {enabled, mw}} from 'show power inline' (Cisco + Ruijie)."""
    result: dict[str, dict] = {}
    for line in output.splitlines():
        # Format: "Gi0/1  auto  on  4.0  ..." or "GigabitEthernet0/1  auto  on  3840  ..."
        m = re.match(
            r"^\s*(\S+)\s+(?:auto|static|never|off)\s+(on|off|faulty|denied|searching)\s+([\d.]+)",
            line, re.IGNORECASE,
        )
        if m:
            port = _normalize_port(m.group(1))
            oper = m.group(2).lower()
            raw = float(m.group(3))
            # Values >100 are already mW (Ruijie), otherwise watts (Cisco)
            mw = int(raw) if raw > 100 else int(raw * 1000)
            result[port] = {"enabled": oper == "on", "mw": mw}
    return result


# Extended commands per OS type: {os_type: {key: command}}
EXTENDED_COMMANDS: dict[str, dict[str, str]] = {
    "cisco_ios": {
        "interfaces": "show interfaces",
        "switchport": "show interfaces switchport",
        "power":      "show power inline",
    },
    "cisco_nxos": {
        "interfaces": "show interfaces",
        "switchport": "show interfaces switchport",
    },
    "cisco_sg300": {
        "interfaces": "show interfaces",
        "switchport": "show interfaces switchport",
    },
    "ruijie_os": {
        "interfaces": "show interfaces",
        "switchport": "show interfaces switchport",
        "power":      "show power inline",
    },
}


def parse_lldp_cisco(output: str) -> list[NeighborInfo]:
    neighbors = []
    blocks = re.split(r"-{10,}", output)
    for block in blocks:
        if not block.strip():
            continue
        local_m = re.search(r"Local Intf(?:ace)?:\s*(\S+)", block, re.IGNORECASE)
        name_m = re.search(r"System Name:\s*(.+)", block)
        port_m = re.search(r"Port id:\s*(\S+)", block, re.IGNORECASE)
        ip_m = re.search(r"IP(?:v4)? address:\s*(\d+\.\d+\.\d+\.\d+)", block)
        if not ip_m:
            ip_m = re.search(r"Management Addresses.*?(\d+\.\d+\.\d+\.\d+)", block, re.DOTALL)
        plat_m = re.search(r"System Description:\s*\n?\s*(.+)", block)

        if local_m and name_m:
            neighbors.append(NeighborInfo(
                local_port=_normalize_port(local_m.group(1)),
                neighbor_hostname=name_m.group(1).strip(),
                neighbor_port=_normalize_port(port_m.group(1)) if port_m else "",
                neighbor_ip=ip_m.group(1).strip() if ip_m else None,
                neighbor_platform=plat_m.group(1).strip()[:255] if plat_m else None,
                protocol="lldp",
            ))
    return neighbors


def parse_cdp_cisco(output: str) -> list[NeighborInfo]:
    neighbors = []
    blocks = re.split(r"-{10,}", output)
    for block in blocks:
        if not block.strip():
            continue
        dev_m = re.search(r"Device ID:\s*(\S+)", block)
        ip_m = re.search(r"IP (?:address|addr):\s*(\d+\.\d+\.\d+\.\d+)", block)
        intf_m = re.search(r"Interface:\s*(\S+?),\s*Port ID.*?:\s*(\S+)", block)
        plat_m = re.search(r"Platform:\s*(.+?),", block)

        if dev_m and intf_m:
            neighbors.append(NeighborInfo(
                local_port=_normalize_port(intf_m.group(1).rstrip(",")),
                neighbor_hostname=dev_m.group(1).strip(),
                neighbor_port=_normalize_port(intf_m.group(2)),
                neighbor_ip=ip_m.group(1).strip() if ip_m else None,
                neighbor_platform=plat_m.group(1).strip()[:255] if plat_m else None,
                protocol="cdp",
            ))
    return neighbors


def parse_lldp_ruijie(output: str) -> list[NeighborInfo]:
    """Parse Ruijie 'show lldp neighbors detail' output.

    The format interleaves separator lines between the port header and its body:
        --- separator ---
        LLDP neighbor-information of port [GigabitEthernet 0/1]
        --- separator ---
          System name   : VILLA_3823.170f
          ...
        --- separator ---  (next port or end)

    Strategy: split on the PORT HEADER pattern using lookahead so each resulting
    block starts with the header and contains all subsequent fields.
    """
    neighbors = []
    # Split so that each block STARTS with the port header line
    blocks = re.split(r"(?=LLDP neighbor-information of port)", output, flags=re.IGNORECASE)
    for block in blocks:
        local_m = re.search(r"LLDP neighbor-information of port\s*\[([^\]]+)\]", block, re.IGNORECASE)
        if not local_m:
            continue

        name_m = re.search(r"System name\s*:\s*(.+)", block, re.IGNORECASE)
        if not name_m:
            continue

        port_m = re.search(r"Port ID\s*:\s*(\S+)", block, re.IGNORECASE)
        ip_m = re.search(r"Management address\s*:\s*(\d+\.\d+\.\d+\.\d+)", block, re.IGNORECASE)
        plat_m = re.search(r"System description\s*:\s*(.+)", block, re.IGNORECASE)

        neighbors.append(NeighborInfo(
            local_port=_normalize_port(local_m.group(1).strip()),
            neighbor_hostname=name_m.group(1).strip(),
            neighbor_port=_normalize_port(port_m.group(1)) if port_m else "",
            neighbor_ip=ip_m.group(1).strip() if ip_m else None,
            neighbor_platform=plat_m.group(1).strip()[:255] if plat_m else None,
            protocol="lldp",
        ))
    return neighbors


def parse_lldp_aruba_osswitch(output: str) -> list[NeighborInfo]:
    """Parse Aruba/HP ProCurve: show lldp info remote-device detail"""
    neighbors = []
    blocks = re.split(r"(?=\s*Local Port\s*:)", output)
    for block in blocks:
        if not block.strip():
            continue
        local_m = re.search(r"Local Port\s*:\s*(\S+)", block)
        name_m = re.search(r"SysName\s*:\s*(.+)", block)
        port_m = re.search(r"PortId\s*:\s*(\S+)", block)
        ip_m = re.search(r"Address\s*:\s*(\d+\.\d+\.\d+\.\d+)", block)
        plat_m = re.search(r"System Descr\s*:\s*(.+)", block)

        if local_m and name_m:
            neighbors.append(NeighborInfo(
                local_port=_normalize_port(local_m.group(1)),
                neighbor_hostname=name_m.group(1).strip(),
                neighbor_port=_normalize_port(port_m.group(1)) if port_m else "",
                neighbor_ip=ip_m.group(1).strip() if ip_m else None,
                neighbor_platform=plat_m.group(1).strip()[:255] if plat_m else None,
                protocol="lldp",
            ))
    return neighbors


def parse_lldp_aruba_aoscx(output: str) -> list[NeighborInfo]:
    """Parse Aruba AOS-CX: show lldp neighbor-info detail"""
    neighbors = []
    blocks = re.split(r"(?=Local Port\s*:)", output)
    for block in blocks:
        if not block.strip():
            continue
        local_m = re.search(r"Local Port\s*:\s*(\S+)", block)
        name_m = re.search(r"System Name\s*:\s*(.+)", block)
        port_m = re.search(r"Port ID\s*:\s*(\S+)", block)
        ip_m = re.search(r"Management Address.*?(\d+\.\d+\.\d+\.\d+)", block, re.DOTALL)

        if local_m and name_m:
            neighbors.append(NeighborInfo(
                local_port=_normalize_port(local_m.group(1)),
                neighbor_hostname=name_m.group(1).strip(),
                neighbor_port=_normalize_port(port_m.group(1)) if port_m else "",
                neighbor_ip=ip_m.group(1).strip() if ip_m else None,
                protocol="lldp",
            ))
    return neighbors


# ── Discovery commands per OS type ───────────────────────────────────────────

LLDP_COMMANDS: dict[str, str] = {
    "cisco_ios": "show lldp neighbors detail",
    "cisco_nxos": "show lldp neighbors detail",
    "cisco_sg300": "show lldp neighbors detail",
    "aruba_osswitch": "show lldp info remote-device detail",
    "hp_procurve": "show lldp info remote-device detail",
    "aruba_aoscx": "show lldp neighbor-info detail",
    "ruijie_os": "show lldp neighbors detail",
    "generic": "show lldp neighbors detail",
}

CDP_COMMANDS: dict[str, str] = {
    "cisco_ios": "show cdp neighbors detail",
    "cisco_nxos": "show cdp neighbors detail",
}


def _parse_output(os_type: str, protocol: str, output: str) -> list[NeighborInfo]:
    if not output or "% " in output[:50]:  # error prefix
        return []

    if protocol == "lldp":
        if os_type in ("aruba_osswitch", "hp_procurve"):
            return parse_lldp_aruba_osswitch(output)
        elif os_type == "aruba_aoscx":
            return parse_lldp_aruba_aoscx(output)
        elif os_type == "ruijie_os":
            return parse_lldp_ruijie(output)
        else:
            return parse_lldp_cisco(output)
    elif protocol == "cdp":
        return parse_cdp_cisco(output)
    return []


# ── Main service ─────────────────────────────────────────────────────────────

class TopologyService:
    def __init__(self, ssh: SSHManager):
        self.ssh = ssh

    async def _fetch_port_info(self, device: Device) -> dict[str, dict]:
        """Run extended show commands and return {norm_port: {duplex, mode, vlan, poe_enabled, poe_mw}}.
        Best-effort — any failure per command is silently skipped."""
        port_info: dict[str, dict] = {}
        os_cmds = EXTENDED_COMMANDS.get(device.os_type)
        if not os_cmds:
            return port_info

        for cmd_key, cmd in os_cmds.items():
            try:
                r = await self.ssh.execute_command(device, cmd)
                if not r.success or not r.output:
                    continue
                if cmd_key == "interfaces":
                    for port, duplex in _parse_interfaces_duplex(r.output).items():
                        port_info.setdefault(port, {})["duplex"] = duplex
                elif cmd_key == "switchport":
                    parser = _parse_switchport_ruijie if device.os_type == "ruijie_os" else _parse_switchport_cisco
                    for port, sp in parser(r.output).items():
                        d = port_info.setdefault(port, {})
                        if sp.get("mode"):
                            d["mode"] = sp["mode"]
                        if sp.get("vlan") is not None:
                            d["vlan"] = sp["vlan"]
                elif cmd_key == "power":
                    for port, poe in _parse_power_inline(r.output).items():
                        d = port_info.setdefault(port, {})
                        d["poe_enabled"] = poe["enabled"]
                        d["poe_mw"] = poe["mw"]
            except Exception:
                continue

        return port_info

    async def discover_device(self, device: Device) -> list[NeighborInfo]:
        results: list[NeighborInfo] = []
        seen_links: set[tuple] = set()

        # LLDP
        lldp_cmd = LLDP_COMMANDS.get(device.os_type, "show lldp neighbors detail")
        lldp_result = await self.ssh.execute_command(device, lldp_cmd)
        if lldp_result.success:
            for n in _parse_output(device.os_type, "lldp", lldp_result.output):
                key = (n.local_port, n.neighbor_hostname)
                if key not in seen_links:
                    seen_links.add(key)
                    results.append(n)

        # CDP (Cisco only, supplement LLDP)
        if device.os_type in CDP_COMMANDS:
            cdp_cmd = CDP_COMMANDS[device.os_type]
            cdp_result = await self.ssh.execute_command(device, cdp_cmd)
            if cdp_result.success:
                for n in _parse_output(device.os_type, "cdp", cdp_result.output):
                    key = (n.local_port, n.neighbor_hostname)
                    if key not in seen_links:
                        seen_links.add(key)
                        results.append(n)

        # Extended port info (duplex / mode / VLAN / PoE) — best-effort, never blocks
        if results and device.os_type in EXTENDED_COMMANDS:
            try:
                port_info = await self._fetch_port_info(device)
                for n in results:
                    info = port_info.get(n.local_port, {})
                    n.local_duplex = info.get("duplex")
                    n.local_port_mode = info.get("mode")
                    n.local_vlan = info.get("vlan")
                    n.local_poe_enabled = info.get("poe_enabled")
                    n.local_poe_mw = info.get("poe_mw")
            except Exception:
                pass

        return results

    async def save_links(
        self,
        db: AsyncSession,
        device: Device,
        neighbors: list[NeighborInfo],
        hostname_to_id: dict[str, int],
    ) -> None:
        now = datetime.now(timezone.utc)

        for n in neighbors:
            # 1) Exact hostname match (case-insensitive)
            neighbor_device_id = hostname_to_id.get(n.neighbor_hostname.lower())
            # 2) FQDN: try just the first label ("BACKBONE_2.local" → "backbone_2")
            if not neighbor_device_id and "." in n.neighbor_hostname:
                neighbor_device_id = hostname_to_id.get(n.neighbor_hostname.split(".")[0].lower())
            # 3) IP match (last resort — LLDP management IP may differ from SSH IP)
            if not neighbor_device_id and n.neighbor_ip:
                result = await db.execute(
                    select(Device.id).where(Device.ip_address == n.neighbor_ip)
                )
                row = result.scalar_one_or_none()
                if row:
                    neighbor_device_id = row

            neighbor_type = detect_device_type(n.neighbor_platform, n.neighbor_hostname)

            stmt = pg_insert(TopologyLink).values(
                device_id=device.id,
                local_port=n.local_port,
                neighbor_hostname=n.neighbor_hostname,
                neighbor_ip=n.neighbor_ip,
                neighbor_port=n.neighbor_port,
                neighbor_platform=n.neighbor_platform,
                neighbor_device_id=neighbor_device_id,
                neighbor_type=neighbor_type,
                protocol=n.protocol,
                last_seen=now,
                local_duplex=n.local_duplex,
                local_port_mode=n.local_port_mode,
                local_vlan=n.local_vlan,
                local_poe_enabled=n.local_poe_enabled,
                local_poe_mw=n.local_poe_mw,
            ).on_conflict_do_update(
                constraint="uq_topology_link",
                set_={
                    "neighbor_ip": n.neighbor_ip,
                    "neighbor_port": n.neighbor_port,
                    "neighbor_platform": n.neighbor_platform,
                    "neighbor_device_id": neighbor_device_id,
                    "neighbor_type": neighbor_type,
                    "protocol": n.protocol,
                    "last_seen": now,
                    # Only update extended fields if we actually got data (don't overwrite with None)
                    **({"local_duplex": n.local_duplex} if n.local_duplex is not None else {}),
                    **({"local_port_mode": n.local_port_mode} if n.local_port_mode is not None else {}),
                    **({"local_vlan": n.local_vlan} if n.local_vlan is not None else {}),
                    **({"local_poe_enabled": n.local_poe_enabled} if n.local_poe_enabled is not None else {}),
                    **({"local_poe_mw": n.local_poe_mw} if n.local_poe_mw is not None else {}),
                },
            )
            await db.execute(stmt)

        await db.commit()

    async def _rematch_ghost_links(self, db: AsyncSession) -> None:
        """Re-resolve ghost links (neighbor_device_id IS NULL) against current inventory.
        Runs fast: only touches unmatched rows. Called at graph-build time so manually-added
        devices get linked without needing a full LLDP re-run."""
        from sqlalchemy import update as _upd

        # Fetch all inventory devices
        all_devs = (await db.execute(select(Device).where(Device.is_active == True))).scalars().all()
        hostname_map = {d.hostname.lower(): d.id for d in all_devs}
        ip_map = {d.ip_address: d.id for d in all_devs}

        # Load unmatched links
        unmatched = (await db.execute(
            select(TopologyLink).where(TopologyLink.neighbor_device_id.is_(None))
        )).scalars().all()

        updated = 0
        for link in unmatched:
            dev_id = hostname_map.get(link.neighbor_hostname.lower())
            if not dev_id and "." in link.neighbor_hostname:
                dev_id = hostname_map.get(link.neighbor_hostname.split(".")[0].lower())
            if not dev_id and link.neighbor_ip:
                dev_id = ip_map.get(link.neighbor_ip)
            if dev_id:
                await db.execute(
                    _upd(TopologyLink)
                    .where(TopologyLink.id == link.id)
                    .values(neighbor_device_id=dev_id)
                )
                updated += 1

        if updated:
            await db.commit()

    async def build_graph(
        self,
        db: AsyncSession,
        group_id: int | None = None,
        site: str | None = None,
        sites: list[str] | None = None,
    ) -> dict:
        """Build React Flow compatible graph from topology_links."""
        # Opportunistically re-link any ghost nodes that are now in inventory
        await self._rematch_ghost_links(db)

        # Fetch all devices
        device_query = select(Device).where(Device.is_active == True)
        if group_id:
            device_query = device_query.where(Device.group_id == group_id)
        if sites is not None:
            device_query = device_query.where(Device.site.in_(sites))
        elif site:
            device_query = device_query.where(Device.site == site)
        devices_result = await db.execute(device_query)
        devices: list[Device] = devices_result.scalars().all()
        device_map: dict[int, Device] = {d.id: d for d in devices}

        # Fetch latest interface utilization + speed per (device_id, normalized_if_name)
        util_map: dict[tuple[int, str], dict] = {}
        if device_map:
            poll_rows = (await db.execute(
                select(SnmpPollResult)
                .where(
                    SnmpPollResult.device_id.in_(list(device_map.keys())),
                )
                .order_by(SnmpPollResult.polled_at.desc())
                .limit(15000)
            )).scalars().all()

            seen_util: set[tuple[int, int]] = set()
            for row in poll_rows:
                k = (row.device_id, row.if_index)
                if k not in seen_util:
                    seen_util.add(k)
                    norm = _normalize_port(row.if_name or "")
                    if norm:
                        util_map[(row.device_id, norm)] = {
                            "in_pct": row.in_utilization_pct,
                            "out_pct": row.out_utilization_pct,
                            "speed_mbps": row.speed_mbps,
                        }

        # Fetch all links
        links_result = await db.execute(select(TopologyLink))
        links: list[TopologyLink] = links_result.scalars().all()

        # Build node set — include devices that have at least one link
        node_ids: set[int] = set()
        ghost_nodes: dict[str, dict] = {}  # hostname → ghost node data

        edge_set: set[tuple] = set()  # dedup bidirectional
        edges: list[dict] = []
        device_last_discovery: dict[int, datetime] = {}  # max last_seen per reporting device

        for link in links:
            node_ids.add(link.device_id)

            # Track max last_seen per device (for stale detection)
            prev = device_last_discovery.get(link.device_id)
            if prev is None or link.last_seen > prev:
                device_last_discovery[link.device_id] = link.last_seen

            if link.neighbor_device_id:
                node_ids.add(link.neighbor_device_id)
                # Deduplicate: normalize edge key
                a, b = sorted([link.device_id, link.neighbor_device_id])
                pa = link.local_port if link.device_id == a else link.neighbor_port
                pb = link.neighbor_port if link.device_id == a else link.local_port
                key = (a, b, pa, pb)
                if key not in edge_set:
                    edge_set.add(key)
                    util_a = util_map.get((a, pa))
                    util_b = util_map.get((b, pb))
                    in_vals = [v for v in [
                        util_a["in_pct"] if util_a else None,
                        util_b["in_pct"] if util_b else None,
                    ] if v is not None]
                    out_vals = [v for v in [
                        util_a["out_pct"] if util_a else None,
                        util_b["out_pct"] if util_b else None,
                    ] if v is not None]
                    speed_vals = [v for v in [
                        util_a["speed_mbps"] if util_a else None,
                        util_b["speed_mbps"] if util_b else None,
                    ] if v is not None]
                    edges.append({
                        "id": f"e-{a}-{b}-{pa}",
                        "source": f"d-{a}",
                        "target": f"d-{b}",
                        "label": f"{pa} ↔ {pb}",
                        "data": {
                            "source_port": pa,
                            "target_port": pb,
                            "protocol": link.protocol,
                            "last_seen": link.last_seen.isoformat() if link.last_seen else None,
                            "in_utilization_pct": max(in_vals) if in_vals else None,
                            "out_utilization_pct": max(out_vals) if out_vals else None,
                            "speed_mbps": max(speed_vals) if speed_vals else None,
                            # Extended port attributes (from the source device's local port)
                            "local_duplex": link.local_duplex,
                            "local_port_mode": link.local_port_mode,
                            "local_vlan": link.local_vlan,
                            "local_poe_enabled": link.local_poe_enabled,
                            "local_poe_mw": link.local_poe_mw,
                        },
                    })
            else:
                # Ghost node for unknown neighbor
                gid = f"ghost-{link.neighbor_hostname}"
                ntype = link.neighbor_type or detect_device_type(link.neighbor_platform, link.neighbor_hostname)
                ghost_nodes[gid] = {
                    "id": gid,
                    "type": "ghostNode",
                    "position": {"x": 0, "y": 0},
                    "data": {
                        "label": link.neighbor_hostname,
                        "ip": link.neighbor_ip,
                        "platform": link.neighbor_platform,
                        "device_type": ntype,
                        "source_device_id": link.device_id,  # which device reported this neighbor
                        "ghost": True,
                    },
                }
                key = (link.device_id, link.neighbor_hostname, link.local_port)
                if key not in edge_set:
                    edge_set.add(key)
                    util_g = util_map.get((link.device_id, link.local_port))
                    edges.append({
                        "id": f"eg-{link.device_id}-{link.neighbor_hostname}-{link.local_port}",
                        "source": f"d-{link.device_id}",
                        "target": gid,
                        "label": f"{link.local_port} ↔ {link.neighbor_port}",
                        "data": {
                            "source_port": link.local_port,
                            "target_port": link.neighbor_port,
                            "protocol": link.protocol,
                            "last_seen": link.last_seen.isoformat() if link.last_seen else None,
                            "in_utilization_pct": util_g["in_pct"] if util_g else None,
                            "out_utilization_pct": util_g["out_pct"] if util_g else None,
                            "speed_mbps": util_g["speed_mbps"] if util_g else None,
                            "local_duplex": link.local_duplex,
                            "local_port_mode": link.local_port_mode,
                            "local_vlan": link.local_vlan,
                            "local_poe_enabled": link.local_poe_enabled,
                            "local_poe_mw": link.local_poe_mw,
                        },
                        "style": {"strokeDasharray": "5,5"},
                    })

        # Also include all inventory devices if requested without group filter
        if not group_id:
            node_ids.update(device_map.keys())

        nodes: list[dict] = []
        for did in node_ids:
            d = device_map.get(did)
            if d:
                ld = device_last_discovery.get(did)
                nodes.append({
                    "id": f"d-{did}",
                    "type": "deviceNode",
                    "position": {"x": 0, "y": 0},
                    "data": {
                        "label": d.hostname,
                        "ip": d.ip_address,
                        "vendor": d.vendor,
                        "os_type": d.os_type,
                        "status": d.status,
                        "model": d.model,
                        "group_id": d.group_id,
                        "device_id": d.id,
                        "layer": d.layer,
                        "site": d.site,
                        "building": d.building,
                        "floor": d.floor,
                        "last_discovery": ld.isoformat() if ld else None,
                    },
                })

        nodes.extend(ghost_nodes.values())

        return {
            "nodes": nodes,
            "edges": edges,
            "stats": {
                "total_nodes": len(nodes),
                "known_nodes": len(node_ids),
                "ghost_nodes": len(ghost_nodes),
                "total_edges": len(edges),
            },
        }
