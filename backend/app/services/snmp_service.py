"""SNMP polling service using puresnmp (asyncio-native, no C deps)."""
from typing import Any, Optional

from puresnmp import Client
from puresnmp.credentials import V1, V2C, V3, Auth, Priv
from x690.types import ObjectIdentifier

# ── OID constants ─────────────────────────────────────────────────────────────

OID_SYS_DESCR     = "1.3.6.1.2.1.1.1.0"
OID_SYS_NAME      = "1.3.6.1.2.1.1.5.0"
OID_SYS_UPTIME    = "1.3.6.1.2.1.1.3.0"
OID_SYS_LOCATION  = "1.3.6.1.2.1.1.6.0"

OID_IF_DESCR      = "1.3.6.1.2.1.2.2.1.2"
OID_IF_SPEED      = "1.3.6.1.2.1.2.2.1.5"
OID_IF_ADMIN_ST   = "1.3.6.1.2.1.2.2.1.7"
OID_IF_OPER_ST    = "1.3.6.1.2.1.2.2.1.8"
OID_IF_IN_ERR     = "1.3.6.1.2.1.2.2.1.14"
OID_IF_OUT_ERR    = "1.3.6.1.2.1.2.2.1.20"

# ifXTable (64-bit HC counters)
OID_IF_HC_IN      = "1.3.6.1.2.1.31.1.1.1.6"
OID_IF_HC_OUT     = "1.3.6.1.2.1.31.1.1.1.10"
OID_IF_HIGH_SPEED = "1.3.6.1.2.1.31.1.1.1.15"
OID_IF_ALIAS      = "1.3.6.1.2.1.31.1.1.1.18"

# HOST-RESOURCES-MIB (RFC 2790) — vendor-agnostic CPU/RAM
OID_HR_PROC_LOAD      = "1.3.6.1.2.1.25.3.3.1.2"   # hrProcessorLoad (% per CPU)
OID_HR_STORAGE_TYPE   = "1.3.6.1.2.1.25.2.3.1.2"   # hrStorageType OID
OID_HR_STORAGE_UNITS  = "1.3.6.1.2.1.25.2.3.1.4"   # allocation units (bytes)
OID_HR_STORAGE_SIZE   = "1.3.6.1.2.1.25.2.3.1.5"   # size in units
OID_HR_STORAGE_USED   = "1.3.6.1.2.1.25.2.3.1.6"   # used in units
_HR_RAM_TYPE_OID = "1.3.6.1.2.1.25.2.1.2"           # hrStorageRam type identifier

# Cisco-specific CPU/RAM OIDs
OID_CISCO_CPU_5MIN    = "1.3.6.1.4.1.9.2.1.57.0"          # avgBusy5 (legacy)
OID_CISCO_CPU_NEW     = "1.3.6.1.4.1.9.9.109.1.1.1.1.8.1" # cpmCPUTotal5minRev idx=1
OID_CISCO_MEM_USED    = "1.3.6.1.4.1.9.9.48.1.1.1.6"       # ciscoMemoryPoolUsed
OID_CISCO_MEM_FREE    = "1.3.6.1.4.1.9.9.48.1.1.1.7"       # ciscoMemoryPoolFree
OID_CISCO_MEM_NAME    = "1.3.6.1.4.1.9.9.48.1.1.1.2"       # ciscoMemoryPoolName


def _make_client(
    host: str,
    community: str,
    version: str,
    port: int,
    timeout: int = 5,
    v3_username: Optional[str] = None,
    v3_auth_protocol: Optional[str] = None,
    v3_auth_passphrase: Optional[str] = None,
    v3_priv_protocol: Optional[str] = None,
    v3_priv_passphrase: Optional[str] = None,
) -> Client:
    if version == "v3":
        auth = None
        priv = None
        if v3_auth_protocol and v3_auth_passphrase:
            auth = Auth(v3_auth_passphrase.encode(), v3_auth_protocol)
            if v3_priv_protocol and v3_priv_passphrase:
                priv = Priv(v3_priv_passphrase.encode(), v3_priv_protocol)
        creds = V3(v3_username or "", auth=auth, priv=priv)
    elif version == "v1":
        creds = V1(community)
    else:
        creds = V2C(community)
    client = Client(host, creds, port=port)
    client.configure(timeout=timeout, retries=1)
    return client


def _client_kwargs(device_kwargs: dict) -> dict:
    """Extract _make_client kwargs from a device field dict."""
    return {k: device_kwargs.get(k) for k in (
        "v3_username", "v3_auth_protocol", "v3_auth_passphrase",
        "v3_priv_protocol", "v3_priv_passphrase",
    )}


async def get_system_info(
    host: str, community: str, version: str = "v2c", port: int = 161,
    **v3: Any,
) -> dict:
    """Return sysDescr, sysName, sysUpTime, sysLocation."""
    client = _make_client(host, community, version, port, timeout=3, **_client_kwargs(v3))
    results = await client.multiget([
        ObjectIdentifier(OID_SYS_DESCR), ObjectIdentifier(OID_SYS_NAME),
        ObjectIdentifier(OID_SYS_UPTIME), ObjectIdentifier(OID_SYS_LOCATION),
    ])

    sys_descr    = _str(results[0]) if len(results) > 0 else None
    sys_name     = _str(results[1]) if len(results) > 1 else None
    uptime_raw   = results[2] if len(results) > 2 else None
    sys_location = _str(results[3]) if len(results) > 3 else None

    uptime_cs  = _int(uptime_raw)
    uptime_sec = (uptime_cs // 100) if uptime_cs is not None else None

    return {
        "sys_descr":    sys_descr,
        "sys_name":     sys_name,
        "sys_location": sys_location,
        "uptime_sec":   uptime_sec,
        "uptime_human": _fmt_uptime(uptime_sec),
    }


async def _walk_table(client: Client, base_oid: str) -> dict[str, Any]:
    """Walk a subtree; returns {last_index_component: raw_value}."""
    result: dict[str, Any] = {}
    async for varbind in client.walk(ObjectIdentifier(base_oid)):
        oid_str = str(varbind.oid)
        suffix  = oid_str.rsplit(".", 1)[-1]
        result[suffix] = varbind.value
    return result


async def get_interfaces(
    host: str, community: str, version: str = "v2c", port: int = 161,
    **v3: Any,
) -> list[dict]:
    """Return per-interface stats from ifTable + ifXTable."""
    client = _make_client(host, community, version, port, timeout=4, **_client_kwargs(v3))

    # Walk each table sequentially (puresnmp walk is an async generator, gather-friendly)
    tables: dict[str, dict[str, Any]] = {}
    for base_oid in [
        OID_IF_DESCR, OID_IF_SPEED, OID_IF_ADMIN_ST, OID_IF_OPER_ST,
        OID_IF_HC_IN, OID_IF_HC_OUT, OID_IF_HIGH_SPEED, OID_IF_ALIAS,
        OID_IF_IN_ERR, OID_IF_OUT_ERR,
    ]:
        tables[base_oid] = await _walk_table(client, base_oid)

    descr_t   = tables[OID_IF_DESCR]
    speed_t   = tables[OID_IF_SPEED]
    admin_t   = tables[OID_IF_ADMIN_ST]
    oper_t    = tables[OID_IF_OPER_ST]
    hc_in_t   = tables[OID_IF_HC_IN]
    hc_out_t  = tables[OID_IF_HC_OUT]
    hspeed_t  = tables[OID_IF_HIGH_SPEED]
    alias_t   = tables[OID_IF_ALIAS]
    in_err_t  = tables[OID_IF_IN_ERR]
    out_err_t = tables[OID_IF_OUT_ERR]

    interfaces = []
    for idx in sorted(descr_t.keys(), key=lambda x: int(x) if x.isdigit() else 0):
        speed_mbps = _int(hspeed_t.get(idx))
        if speed_mbps is None:
            raw_bps = _int(speed_t.get(idx))
            speed_mbps = raw_bps // 1_000_000 if raw_bps else None

        interfaces.append({
            "if_index":   int(idx) if idx.isdigit() else idx,
            "name":       _str(descr_t.get(idx)) or "",
            "alias":      _str(alias_t.get(idx)) or "",
            "admin_up":   _int(admin_t.get(idx)) == 1,
            "oper_up":    _int(oper_t.get(idx)) == 1,
            "speed_mbps": speed_mbps,
            "in_octets":  _int(hc_in_t.get(idx)),
            "out_octets": _int(hc_out_t.get(idx)),
            "in_errors":  _int(in_err_t.get(idx)),
            "out_errors": _int(out_err_t.get(idx)),
        })

    return interfaces


async def get_cpu_ram(
    host: str, community: str, version: str = "v2c", port: int = 161,
    vendor: str = "other", **v3: Any,
) -> dict:
    """Return CPU % and RAM usage. Tries vendor-specific OIDs, falls back to HOST-RESOURCES-MIB."""
    vendor = (vendor or "other").lower()
    result: dict = {"cpu_pct": None, "ram_used_mb": None, "ram_total_mb": None, "ram_pct": None, "source": None}

    client = _make_client(host, community, version, port, timeout=5, **_client_kwargs(v3))

    # ── 1. Cisco-specific ─────────────────────────────────────────────────────
    if vendor == "cisco":
        try:
            cpu = await _cisco_cpu(client)
            mem = await _cisco_mem(client)
            if cpu is not None or mem["ram_total_mb"] is not None:
                result.update(cpu_pct=cpu, **mem, source="cisco")
                return result
        except Exception:
            pass

    # ── 2. HOST-RESOURCES-MIB (works on most switches regardless of vendor) ──
    try:
        cpu = await _hr_cpu(client)
        mem = await _hr_mem(client)
        if cpu is not None or mem["ram_total_mb"] is not None:
            result.update(cpu_pct=cpu, **mem, source="host-resources")
            return result
    except Exception:
        pass

    return result


async def _cisco_cpu(client: Client) -> float | None:
    """Try new cpmCPUTotal5minRev first, fall back to legacy avgBusy5."""
    for oid in [OID_CISCO_CPU_NEW, OID_CISCO_CPU_5MIN]:
        try:
            vals = await client.multiget([ObjectIdentifier(oid)])
            v = _int(vals[0]) if vals else None
            if v is not None and 0 <= v <= 100:
                return float(v)
        except Exception:
            continue
    return None


async def _cisco_mem(client: Client) -> dict:
    """Return {ram_used_mb, ram_total_mb, ram_pct} from ciscoMemoryPool MIB."""
    empty = {"ram_used_mb": None, "ram_total_mb": None, "ram_pct": None}
    try:
        names = await _walk_table(client, OID_CISCO_MEM_NAME)
        used_t = await _walk_table(client, OID_CISCO_MEM_USED)
        free_t = await _walk_table(client, OID_CISCO_MEM_FREE)

        for idx, name_raw in names.items():
            name = (_str(name_raw) or "").lower()
            if "processor" in name or "dram" in name or "main" in name or idx == "1":
                used = _int(used_t.get(idx))
                free = _int(free_t.get(idx))
                if used is not None and free is not None:
                    total = used + free
                    return {
                        "ram_used_mb": round(used / 1_048_576, 1),
                        "ram_total_mb": round(total / 1_048_576, 1),
                        "ram_pct": round(used / total * 100, 1) if total > 0 else None,
                    }
    except Exception:
        pass
    return empty


async def _hr_cpu(client: Client) -> float | None:
    """Average all hrProcessorLoad entries."""
    try:
        load_t = await _walk_table(client, OID_HR_PROC_LOAD)
        vals = [_int(v) for v in load_t.values() if _int(v) is not None]
        if vals:
            return round(sum(vals) / len(vals), 1)
    except Exception:
        pass
    return None


async def _hr_mem(client: Client) -> dict:
    """Find the hrStorageRam entry and return used/total in MB."""
    empty = {"ram_used_mb": None, "ram_total_mb": None, "ram_pct": None}
    try:
        type_t  = await _walk_table(client, OID_HR_STORAGE_TYPE)
        units_t = await _walk_table(client, OID_HR_STORAGE_UNITS)
        size_t  = await _walk_table(client, OID_HR_STORAGE_SIZE)
        used_t  = await _walk_table(client, OID_HR_STORAGE_USED)

        for idx, stype in type_t.items():
            if _HR_RAM_TYPE_OID in str(stype):
                unit  = _int(units_t.get(idx)) or 1
                total = _int(size_t.get(idx))
                used  = _int(used_t.get(idx))
                if total and used is not None:
                    total_b = total * unit
                    used_b  = used * unit
                    return {
                        "ram_used_mb": round(used_b / 1_048_576, 1),
                        "ram_total_mb": round(total_b / 1_048_576, 1),
                        "ram_pct": round(used_b / total_b * 100, 1) if total_b > 0 else None,
                    }
    except Exception:
        pass
    return empty


# ── helpers ───────────────────────────────────────────────────────────────────

def _str(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="replace").strip()
    # x690 OctetString: has a .pythonize() method or a .value attribute
    if hasattr(v, "pythonize"):
        raw = v.pythonize()
        if isinstance(raw, bytes):
            return raw.decode("utf-8", errors="replace").strip()
        return str(raw).strip() or None
    if hasattr(v, "value") and isinstance(v.value, bytes):
        return v.value.decode("utf-8", errors="replace").strip()
    return str(v).strip() or None


def _int(v: Any) -> int | None:
    if v is None:
        return None
    # x690 Integer types: delegate to pythonize()
    if hasattr(v, "pythonize"):
        try:
            return int(v.pythonize())
        except (ValueError, TypeError):
            return None
    try:
        return int(v)
    except (ValueError, TypeError):
        return None


def _fmt_uptime(seconds: int | None) -> str | None:
    if seconds is None:
        return None
    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m, s   = divmod(rem, 60)
    parts = []
    if d:
        parts.append(f"{d}g")
    if h:
        parts.append(f"{h}s")
    parts.append(f"{m}d {s}sn")
    return " ".join(parts)
