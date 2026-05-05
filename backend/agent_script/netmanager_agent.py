#!/usr/bin/env python3
"""
NetManager Proxy Agent v1.3
Yerel ağa kurulur, NetManager backend'e WebSocket ile bağlanır.
SSH komutlarını ağ cihazlarına iletir ve sonuçları döner.

Güvenlik ve yeni özellikler (v1.3.0):
  - Sunucu tarafından gönderilen komut whitelist/blacklist politikası
  - Agent tarafında komut doğrulama (çift katmanlı koruma)
  - Key rotasyon desteği (env dosyasını otomatik günceller)
  - Güvenlik ihlali bildirim mesajları
  - SSH Connection Pool (F1)
  - Offline Command Queue (F3)
  - Proactive Device Health Monitoring (F2)
  - SNMP via Agent (F4)
  - Auto Device Discovery (F5)
  - Syslog Collector (F6)
  - Command Result Streaming (F7)
  - Secure Credential Vault (F8)
"""
import asyncio
import json
import logging
import os
import platform
import socket
import sys
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
import ipaddress
import concurrent.futures
import base64

try:
    import websockets
except ImportError:
    print("Eksik paket: pip install websockets", file=sys.stderr)
    sys.exit(1)

try:
    from netmiko import ConnectHandler
    from netmiko.exceptions import NetmikoAuthenticationException, NetmikoTimeoutException
except ImportError:
    print("Eksik paket: pip install netmiko", file=sys.stderr)
    sys.exit(1)

try:
    import psutil
    _HAS_PSUTIL = True
except ImportError:
    _HAS_PSUTIL = False

try:
    import puresnmp
    from puresnmp import Client as SnmpClient
    from puresnmp.credentials import V2C
    _HAS_SNMP = True
except ImportError:
    _HAS_SNMP = False

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    _HAS_CRYPTO = True
except ImportError:
    _HAS_CRYPTO = False

VERSION = "1.3.1"
BACKEND_URL = os.environ.get("NETMANAGER_URL", "http://localhost:8000").rstrip("/")
AGENT_ID    = os.environ.get("NETMANAGER_AGENT_ID", "")
AGENT_KEY   = os.environ.get("NETMANAGER_AGENT_KEY", "")
HEARTBEAT_INTERVAL = 10

# Try to find the env file path for key rotation
_ENV_FILE_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent.env"),
    "/opt/netmanager-agent/agent.env",
    os.path.expanduser("~/.netmanager-agent/agent.env"),
    r"C:\ProgramData\NetManagerAgent\config.env",
]
_ENV_FILE = next((p for p in _ENV_FILE_CANDIDATES if os.path.exists(p)), None)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("netmanager-agent")

# ── Security policy (updated by server via security_config message) ────────
_security = {
    "command_mode": "all",        # 'all' | 'whitelist' | 'blacklist'
    "allowed_commands": [],       # list of prefixes
}

_SAFE_PREFIXES = (
    "show ", "display ", "ping ", "traceroute ", "trace-route ",
    "get ", "sh ",
)

# ── Command stats ──────────────────────────────────────────────────────────
_stats = {
    "cmd_success": 0,
    "cmd_fail": 0,
    "cmd_total_ms": 0,
    "cmd_blocked": 0,
}

_restart_requested = False

# ── Sprint 14C: Edge Intelligence ─────────────────────────────────────────
# SSH sliding window error rate (last 20 commands)
_ssh_window: deque = deque(maxlen=20)
# SNMP latency tracking (rolling 10-sample EMA, milliseconds)
_snmp_ema_ms: float = 0.0
_snmp_ema_count: int = 0
_SNMP_LATENCY_THRESHOLD_MS: float = 5000.0  # fire anomaly if avg > 5 s
_SSH_ERROR_RATE_THRESHOLD: float = 0.5       # fire anomaly if >50% fail

# ── Feature 1: SSH Connection Pool ────────────────────────────────────────
_ssh_pool: dict = {}          # key: (device_ip, port, username) -> {"conn": ..., "last_used": float}
_pool_lock = threading.Lock()
_POOL_TTL = 300               # 5 minutes

# ── Feature 3: Offline Command Queue ─────────────────────────────────────
_result_queue: deque = deque(maxlen=100)

# ── Feature 2: Proactive Device Health Monitoring ────────────────────────
_device_list: list = []
_health_check_interval = 60

# ── Feature 6: Syslog Collector ──────────────────────────────────────────
_syslog_enabled = False
_syslog_port = 514

# ── Feature 8: Secure Credential Vault ───────────────────────────────────
_vault: dict = {}             # keyed by credential_id / device_id
_vault_key: bytes = None


# ─────────────────────────────────────────────────────────────────────────────
# Security helpers
# ─────────────────────────────────────────────────────────────────────────────

def _is_command_allowed(command: str) -> tuple:
    """Returns (allowed, reason) based on current security policy."""
    mode = _security["command_mode"]
    if mode == "all":
        return True, ""

    cmd_lower = command.strip().lower()
    allowed_commands = _security["allowed_commands"]

    if mode == "whitelist":
        if not allowed_commands:
            for prefix in _SAFE_PREFIXES:
                if cmd_lower.startswith(prefix):
                    return True, ""
            return False, "whitelist bos; sadece salt-okunur komutlar izinli"
        for prefix in allowed_commands:
            if cmd_lower.startswith(prefix.lower()):
                return True, ""
        return False, "komut whitelist'te yok: {}".format(command[:60])

    if mode == "blacklist":
        for prefix in allowed_commands:
            if cmd_lower.startswith(prefix.lower()):
                return False, "komut blacklist'te engellendi: {}".format(command[:60])
        return True, ""

    return True, ""


def _update_env_file(new_key):
    """Update NETMANAGER_AGENT_KEY in the env file after key rotation."""
    global _ENV_FILE
    if not _ENV_FILE:
        log.warning("Env dosyasi bulunamadi - key env degiskeni olarak guncelleniyor")
        os.environ["NETMANAGER_AGENT_KEY"] = new_key
        return

    try:
        with open(_ENV_FILE) as f:
            lines = f.readlines()

        new_lines = []
        updated = False
        for line in lines:
            if line.startswith("NETMANAGER_AGENT_KEY="):
                new_lines.append("NETMANAGER_AGENT_KEY={}\n".format(new_key))
                updated = True
            else:
                new_lines.append(line)

        if not updated:
            new_lines.append("NETMANAGER_AGENT_KEY={}\n".format(new_key))

        with open(_ENV_FILE, "w") as f:
            f.writelines(new_lines)

        os.environ["NETMANAGER_AGENT_KEY"] = new_key
        log.info("Agent key guncellendi: {}".format(_ENV_FILE))
    except Exception as e:
        log.error("Env dosyasi guncellenemedi: {}".format(e))
        os.environ["NETMANAGER_AGENT_KEY"] = new_key


def _record_result(result):
    ok = bool(result.get("success"))
    if ok:
        _stats["cmd_success"] += 1
    else:
        _stats["cmd_fail"] += 1
    _stats["cmd_total_ms"] += result.get("duration_ms", 0)
    _ssh_window.append(ok)


def _record_snmp_latency_ms(ms: float):
    global _snmp_ema_ms, _snmp_ema_count
    _snmp_ema_count += 1
    if _snmp_ema_count == 1:
        _snmp_ema_ms = ms
    else:
        _snmp_ema_ms = 0.8 * _snmp_ema_ms + 0.2 * ms


async def _maybe_send_anomaly(ws, anomaly_type: str, title: str,
                               message: str, details: dict = None):
    """Fire a local_anomaly event to the backend — deduplicated per type per 30 min."""
    key = "anomaly_ts_{}".format(anomaly_type)
    last = _stats.get(key, 0.0)
    now = time.monotonic()
    if now - last < 1800:  # 30 minute cooldown per type
        return
    _stats[key] = now
    try:
        await ws.send(json.dumps({
            "type":         "local_anomaly",
            "agent_id":     AGENT_ID,
            "anomaly_type": anomaly_type,
            "severity":     "warning",
            "title":        title,
            "message":      message,
            "details":      details or {},
            "timestamp":    datetime.now(timezone.utc).isoformat(),
        }))
        log.warning("[edge] Local anomaly: {} — {}".format(anomaly_type, message))
    except Exception as e:
        log.debug("[edge] Anomaly send failed: {}".format(e))


def _get_local_ip() -> str:
    """Return the primary local IP used for outbound connections."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return ""


def _get_metrics():
    with _pool_lock:
        pool_size = len(_ssh_pool)
        pool_active_hosts = sum(
            1 for v in _ssh_pool.values()
            if v["conn"].is_alive()
        ) if _ssh_pool else 0

    metrics = {
        "cmd_success": _stats["cmd_success"],
        "cmd_fail": _stats["cmd_fail"],
        "cmd_total_ms": _stats["cmd_total_ms"],
        "cmd_blocked": _stats["cmd_blocked"],
        "python_version": platform.python_version(),
        "pool_size": pool_size,
        "pool_active_hosts": pool_active_hosts,
        "queue_size": len(_result_queue),
    }
    if _HAS_PSUTIL:
        try:
            metrics["cpu_percent"] = psutil.cpu_percent(interval=0.1)
            mem = psutil.virtual_memory()
            metrics["memory_percent"] = mem.percent
            metrics["memory_used_mb"] = round(mem.used / 1024 / 1024)
            metrics["memory_total_mb"] = round(mem.total / 1024 / 1024)
        except Exception:
            pass
    return metrics


# ─────────────────────────────────────────────────────────────────────────────
# Feature 1: SSH Connection Pool helpers
# ─────────────────────────────────────────────────────────────────────────────

def _pool_get(msg):
    """Return a pooled SSH connection, reconnecting if stale."""
    params = _build_params(msg)
    key = (params["host"], params["port"], params["username"])

    with _pool_lock:
        entry = _ssh_pool.get(key)
        if entry is not None:
            conn = entry["conn"]
            try:
                alive = conn.is_alive()
            except Exception:
                alive = False

            if alive:
                entry["last_used"] = time.time()
                return conn
            else:
                # Stale connection — close and reconnect
                try:
                    conn.disconnect()
                except Exception:
                    pass
                del _ssh_pool[key]

        # Open a fresh connection and store it
        conn = _get_connection(msg)
        _ssh_pool[key] = {"conn": conn, "last_used": time.time()}
        return conn


def _pool_evict_idle():
    """Evict connections idle longer than _POOL_TTL. Runs synchronously."""
    now = time.time()
    with _pool_lock:
        stale_keys = [
            k for k, v in _ssh_pool.items()
            if (now - v["last_used"]) > _POOL_TTL
        ]
        for k in stale_keys:
            try:
                _ssh_pool[k]["conn"].disconnect()
            except Exception:
                pass
            del _ssh_pool[k]
            log.debug("Pool: evicted idle connection to {}".format(k[0]))


async def _pool_evict_loop():
    """Coroutine: periodically evict idle pool connections."""
    loop = asyncio.get_event_loop()
    while True:
        await asyncio.sleep(60)
        try:
            await loop.run_in_executor(None, _pool_evict_idle)
        except Exception as e:
            log.debug("Pool evict hatasi: {}".format(e))


# ─────────────────────────────────────────────────────────────────────────────
# SSH helpers
# ─────────────────────────────────────────────────────────────────────────────

def _build_params(msg):
    """Build netmiko ConnectHandler params, using vault credentials if available."""
    os_type = msg.get("os_type", "cisco_ios")

    # Feature 8: vault credential lookup
    credential_id = msg.get("credential_id")
    if credential_id and credential_id in _vault:
        creds = _vault[credential_id]
        ssh_username = creds.get("username", msg.get("ssh_username", ""))
        ssh_password = creds.get("password", msg.get("ssh_password", ""))
        enable_secret = creds.get("enable_secret", msg.get("enable_secret", ""))
    else:
        ssh_username = msg.get("ssh_username", "")
        ssh_password = msg.get("ssh_password", "")
        enable_secret = msg.get("enable_secret", "")

    params = {
        "device_type":        os_type,
        "host":               msg["device_ip"],
        "username":           ssh_username,
        "password":           ssh_password,
        "port":               int(msg.get("ssh_port", 22)),
        "timeout":            60,
        "auth_timeout":       30,
        "session_timeout":    120,
        "banner_timeout":     30,
        "blocking_timeout":   40,
        "fast_cli":           False,
        "global_delay_factor": 3,
    }
    if enable_secret:
        params["secret"] = enable_secret
    return params


def _get_connection(msg):
    """Open SSH connection with device-type-specific handling.

    ruijie_os driver calls enable() automatically in session_preparation.
    When no enable_secret is provided we bypass that to avoid 'Failed to
    enter enable mode' errors (user may have privilege 15 already, or the
    device may accept enable without a password in a non-standard way).
    """
    params = _build_params(msg)
    os_type = params["device_type"]
    enable_secret = params.get("secret", "")

    if os_type == "ruijie_os" and not enable_secret:
        # Use auto_connect=False so we can skip the automatic enable() call
        conn = ConnectHandler(**{**params, "auto_connect": False})
        conn.establish_connection()
        conn.set_base_prompt()
        try:
            conn.disable_paging(command="terminal length 0")
        except Exception:
            pass
        conn.clear_buffer()
    else:
        conn = ConnectHandler(**params)
        # For non-Ruijie devices the driver doesn't auto-enable; call explicitly
        if enable_secret and os_type != "ruijie_os":
            conn.enable()

    return conn


def _ssh_test(msg):
    """Always uses a fresh connection — never pooled."""
    t0 = time.time()
    try:
        conn = _get_connection(msg)
        conn.disconnect()
        return {"success": True, "output": "Baglanti basarili", "duration_ms": round((time.time() - t0) * 1000)}
    except NetmikoAuthenticationException as e:
        return {"success": False, "error": "Kimlik dogrulama hatasi: {}".format(e), "duration_ms": round((time.time() - t0) * 1000)}
    except NetmikoTimeoutException as e:
        return {"success": False, "error": "Baglanti zaman asimi: {}".format(e), "duration_ms": round((time.time() - t0) * 1000)}
    except Exception as e:
        return {"success": False, "error": str(e), "duration_ms": round((time.time() - t0) * 1000)}


def _ssh_command(msg):
    """Uses pooled connection."""
    t0 = time.time()
    try:
        conn = _pool_get(msg)
        output = conn.send_command(msg["command"], read_timeout=120)
        return {"success": True, "output": str(output), "duration_ms": round((time.time() - t0) * 1000)}
    except Exception as e:
        # On error, remove from pool so next call gets a fresh connection
        params = _build_params(msg)
        key = (params["host"], params["port"], params["username"])
        with _pool_lock:
            _ssh_pool.pop(key, None)
        return {"success": False, "error": str(e), "duration_ms": round((time.time() - t0) * 1000)}


def _ssh_config(msg):
    """Uses pooled connection."""
    t0 = time.time()
    try:
        conn = _pool_get(msg)
        output = conn.send_config_set(msg["commands"], read_timeout=120)
        conn.save_config()
        return {"success": True, "output": str(output), "duration_ms": round((time.time() - t0) * 1000)}
    except Exception as e:
        params = _build_params(msg)
        key = (params["host"], params["port"], params["username"])
        with _pool_lock:
            _ssh_pool.pop(key, None)
        return {"success": False, "error": str(e), "duration_ms": round((time.time() - t0) * 1000)}


# ─────────────────────────────────────────────────────────────────────────────
# Feature 7: Command Result Streaming
# ─────────────────────────────────────────────────────────────────────────────

def _ssh_command_stream_sync(msg, chunk_queue, main_loop):
    """Run SSH command and push ~512B chunks into chunk_queue via main_loop."""
    CHUNK_SIZE = 512
    try:
        conn = _pool_get(msg)
        output = conn.send_command_timing(msg["command"], read_timeout=120)
        # Split output into chunks
        for i in range(0, max(len(output), 1), CHUNK_SIZE):
            chunk = output[i:i + CHUNK_SIZE]
            main_loop.call_soon_threadsafe(chunk_queue.put_nowait, chunk)
    except Exception as e:
        main_loop.call_soon_threadsafe(chunk_queue.put_nowait, {"__error__": str(e)})
    finally:
        # Sentinel to signal end of stream
        main_loop.call_soon_threadsafe(chunk_queue.put_nowait, None)


# ─────────────────────────────────────────────────────────────────────────────
# Feature 4: SNMP via Agent
# ─────────────────────────────────────────────────────────────────────────────

def _snmp_get_sync(msg):
    """Synchronously run async SNMP get using a dedicated event loop."""
    if not _HAS_SNMP:
        return {"success": False, "error": "puresnmp not installed"}

    host = msg.get("device_ip", "")
    community = msg.get("community", "public")
    oid = msg.get("oid", "")
    port = int(msg.get("snmp_port", 161))

    async def _do_get():
        try:
            async with SnmpClient(host, V2C(community), port=port) as client:
                result = await client.get(oid)
            return {"success": True, "data": {oid: str(result)}}
        except Exception as e:
            return {"success": False, "error": str(e)}

    t0 = time.monotonic()
    loop = asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(_do_get())
        _record_snmp_latency_ms((time.monotonic() - t0) * 1000)
        return result
    finally:
        loop.close()


def _snmp_walk_sync(msg):
    """Synchronously run async SNMP walk using a dedicated event loop."""
    if not _HAS_SNMP:
        return {"success": False, "error": "puresnmp not installed"}

    host = msg.get("device_ip", "")
    community = msg.get("community", "public")
    oid = msg.get("oid", "")
    port = int(msg.get("snmp_port", 161))

    async def _do_walk():
        try:
            result_data = {}
            async with SnmpClient(host, V2C(community), port=port) as client:
                async for varbind in client.walk(oid):
                    result_data[str(varbind.oid)] = str(varbind.value)
            return {"success": True, "data": result_data}
        except Exception as e:
            return {"success": False, "error": str(e)}

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_do_walk())
    finally:
        loop.close()


# ─────────────────────────────────────────────────────────────────────────────
# Feature 5: Auto Device Discovery
# ─────────────────────────────────────────────────────────────────────────────

def _ssh_banner_grab(ip: str, port: int, timeout: float = 2.0) -> str:
    """TCP connect to ip:port, send \\r\\n, read up to 256 bytes, return banner string."""
    try:
        with socket.create_connection((ip, port), timeout=timeout) as s:
            s.sendall(b"\r\n")
            banner = s.recv(256)
            return banner.decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def _probe_host(ip: str, ports: list) -> dict | None:
    """Try each port; collect open_ports and banners. Return dict or None if all closed."""
    open_ports = []
    banners = {}
    for port in ports:
        banner = _ssh_banner_grab(ip, port)
        if banner is not None and banner != "":
            open_ports.append(port)
            banners[port] = banner
        else:
            # Still check if port is open even without banner
            try:
                with socket.create_connection((ip, port), timeout=2.0):
                    open_ports.append(port)
                    banners[port] = ""
            except Exception:
                pass

    if open_ports:
        return {"ip": ip, "open_ports": open_ports, "banners": banners}
    return None


def _discover_subnet(msg: dict) -> dict:
    """Parse CIDR range, probe up to 1024 hosts in parallel."""
    cidr = msg.get("subnet", "")
    ports = msg.get("ports", [22, 23, 80, 443])
    try:
        network = ipaddress.ip_network(cidr, strict=False)
    except ValueError as e:
        return {"success": False, "error": "Gecersiz CIDR: {}".format(e)}

    hosts = list(network.hosts())
    if len(hosts) > 1024:
        hosts = hosts[:1024]

    scanned = len(hosts)
    discovered = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=50) as executor:
        futures = {executor.submit(_probe_host, str(ip), ports): str(ip) for ip in hosts}
        for future in concurrent.futures.as_completed(futures):
            try:
                result = future.result()
                if result is not None:
                    discovered.append(result)
            except Exception:
                pass

    return {"success": True, "hosts": discovered, "scanned": scanned}


# ─────────────────────────────────────────────────────────────────────────────
# Feature 6: Syslog Collector
# ─────────────────────────────────────────────────────────────────────────────

def _parse_syslog(data: bytes, addr: tuple) -> dict:
    """Minimal RFC 3164 syslog parser."""
    source_ip = addr[0] if addr else ""
    try:
        raw = data.decode("utf-8", errors="replace").strip()
    except Exception:
        raw = str(data)

    facility = 0
    severity = 0
    message = raw

    # Try to parse PRI field: <PRI>...
    if raw.startswith("<"):
        try:
            end = raw.index(">")
            pri = int(raw[1:end])
            facility = pri >> 3
            severity = pri & 0x07
            message = raw[end + 1:].strip()
        except (ValueError, IndexError):
            pass

    return {
        "facility": facility,
        "severity": severity,
        "message": message,
        "source_ip": source_ip,
    }


class SyslogProtocol(asyncio.DatagramProtocol):
    def __init__(self, ws, loop):
        self._ws = ws
        self._loop = loop

    def datagram_received(self, data: bytes, addr: tuple):
        parsed = _parse_syslog(data, addr)
        payload = json.dumps({
            "type": "syslog_event",
            "agent_id": AGENT_ID,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **parsed,
        })

        async def _do_send():
            try:
                await self._ws.send(payload)
            except Exception as e:
                log.debug("Syslog gonderilemedi: {}".format(e))

        asyncio.ensure_future(_do_send(), loop=self._loop)


# ─────────────────────────────────────────────────────────────────────────────
# Feature 8: Secure Credential Vault helpers
# ─────────────────────────────────────────────────────────────────────────────

def _vault_decrypt(ciphertext_b64: str, key: bytes) -> dict:
    """Decrypt AES-GCM encrypted credential. Returns plaintext dict."""
    raw = base64.b64decode(ciphertext_b64)
    nonce = raw[:12]
    ciphertext = raw[12:]
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(nonce, ciphertext, None)
    return json.loads(plaintext.decode("utf-8"))


# ─────────────────────────────────────────────────────────────────────────────
# Feature 2: Proactive Device Health Monitoring
# ─────────────────────────────────────────────────────────────────────────────

async def _health_check(ws, loop):
    """Coroutine: periodically TCP-probe each device in _device_list."""
    while True:
        await asyncio.sleep(_health_check_interval)
        if not _device_list:
            continue

        results = []
        for device in _device_list:
            ip = device.get("device_ip") or device.get("ip", "")
            port = int(device.get("ssh_port", 22))
            device_id = device.get("id") or device.get("device_id") or ip

            reachable = False
            try:
                # TCP connect — not a full SSH handshake
                with socket.create_connection((ip, port), timeout=3.0):
                    reachable = True
            except Exception:
                reachable = False

            results.append({
                "device_id": device_id,
                "ip": ip,
                "port": port,
                "reachable": reachable,
                "checked_at": datetime.now(timezone.utc).isoformat(),
            })

        try:
            await ws.send(json.dumps({
                "type": "device_status_report",
                "agent_id": AGENT_ID,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "results": results,
            }))
        except Exception as e:
            log.debug("Health check raporu gonderilemedi: {}".format(e))
            break


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket message handler
# ─────────────────────────────────────────────────────────────────────────────

async def handle_message(ws, msg, loop):
    global _restart_requested, _device_list, _syslog_enabled, _syslog_port
    global _vault, _vault_key

    t = msg.get("type")
    rid = msg.get("request_id", "")

    # Security policy update from server
    if t == "security_config":
        _security["command_mode"] = msg.get("command_mode", "all")
        _security["allowed_commands"] = msg.get("allowed_commands", [])
        log.info("Guvenlik politikasi guncellendi: mod={}, kural sayisi={}".format(
            _security["command_mode"], len(_security["allowed_commands"])
        ))
        return

    # Key rotation
    if t == "key_rotate":
        new_key = msg.get("new_key", "")
        if new_key:
            log.info("Key rotasyon istegi alindi - env dosyasi guncelleniyor...")
            _update_env_file(new_key)
            await ws.send(json.dumps({"type": "key_rotate_ack", "agent_id": AGENT_ID}))
        return

    # Feature 3: _send helper — enqueues on failure if request_id present
    async def _send(payload):
        """Send a message; enqueue if connection closed and payload has request_id."""
        try:
            await ws.send(json.dumps(payload))
        except Exception as exc:
            log.warning("Sonuc gonderilemedi (baglanti kapali): {}".format(exc))
            if payload.get("request_id"):
                _result_queue.append(payload)

    # Feature 2: device sync
    if t == "device_sync":
        _device_list.clear()
        _device_list.extend(msg.get("devices", []))
        log.info("Cihaz listesi guncellendi: {} cihaz".format(len(_device_list)))
        return

    # Feature 6: syslog config
    if t == "syslog_config":
        _syslog_enabled = msg.get("enabled", False)
        _syslog_port = int(msg.get("port", 514))
        log.info("Syslog konfig guncellendi: enabled={}, port={}".format(_syslog_enabled, _syslog_port))
        return

    # Feature 8: credential bundle
    if t == "credential_bundle":
        new_key_b64 = msg.get("vault_key", "")
        credentials = msg.get("credentials", [])
        if new_key_b64:
            try:
                _vault_key = base64.b64decode(new_key_b64)
            except Exception as e:
                log.error("Vault key decode hatasi: {}".format(e))
                await _send({"type": "vault_ack", "agent_id": AGENT_ID, "success": False, "error": str(e)})
                return

        stored = 0
        errors = []
        for cred in credentials:
            cred_id = cred.get("id")
            ciphertext = cred.get("data")
            if not cred_id or not ciphertext:
                continue
            if _vault_key and _HAS_CRYPTO:
                try:
                    decrypted = _vault_decrypt(ciphertext, _vault_key)
                    _vault[cred_id] = decrypted
                    stored += 1
                except Exception as e:
                    errors.append({"id": cred_id, "error": str(e)})
            else:
                # No crypto — store as-is (plaintext fallback, server decides)
                _vault[cred_id] = cred.get("plaintext", {})
                stored += 1

        log.info("Vault guncellendi: {} credential saklanadi".format(stored))
        await _send({
            "type": "vault_ack",
            "agent_id": AGENT_ID,
            "success": True,
            "stored": stored,
            "errors": errors,
        })
        return

    if t == "ssh_test":
        log.info("SSH test -> {}".format(msg.get("device_ip")))
        result = await loop.run_in_executor(None, _ssh_test, msg)
        _record_result(result)
        await _send({"type": "ssh_result", "request_id": rid, **result})

    elif t == "ssh_command":
        command = msg.get("command", "")

        # Apply server-sent policy (overrides local cache for this call)
        if "command_mode" in msg:
            _security["command_mode"] = msg["command_mode"]
            _security["allowed_commands"] = msg.get("allowed_commands", [])

        allowed, reason = _is_command_allowed(command)
        if not allowed:
            log.warning("Komut engellendi (agent politikasi): {} - {}".format(command[:60], reason))
            _stats["cmd_blocked"] += 1
            await _send({
                "type": "security_blocked",
                "request_id": rid,
                "command": command,
                "reason": reason,
            })
            return

        log.info("SSH komut -> {} : {}".format(msg.get("device_ip"), command[:60]))
        result = await loop.run_in_executor(None, _ssh_command, msg)
        _record_result(result)
        await _send({"type": "ssh_result", "request_id": rid, **result})

    elif t == "ssh_config":
        commands = msg.get("commands", [])

        if "command_mode" in msg:
            _security["command_mode"] = msg["command_mode"]
            _security["allowed_commands"] = msg.get("allowed_commands", [])

        # Validate each config command
        if _security["command_mode"] != "all":
            for cmd in commands:
                allowed, reason = _is_command_allowed(cmd)
                if not allowed:
                    log.warning("Config komutu engellendi: {} - {}".format(cmd[:60], reason))
                    _stats["cmd_blocked"] += 1
                    await _send({
                        "type": "security_blocked",
                        "request_id": rid,
                        "command": cmd,
                        "reason": reason,
                    })
                    return

        log.info("SSH config -> {} ({} komut)".format(msg.get("device_ip"), len(commands)))
        result = await loop.run_in_executor(None, _ssh_config, msg)
        _record_result(result)
        await _send({"type": "ssh_result", "request_id": rid, **result})

    # Feature 7: Command Result Streaming
    elif t == "ssh_command_stream":
        command = msg.get("command", "")

        if "command_mode" in msg:
            _security["command_mode"] = msg["command_mode"]
            _security["allowed_commands"] = msg.get("allowed_commands", [])

        allowed, reason = _is_command_allowed(command)
        if not allowed:
            log.warning("Stream komutu engellendi: {} - {}".format(command[:60], reason))
            _stats["cmd_blocked"] += 1
            await _send({
                "type": "security_blocked",
                "request_id": rid,
                "command": command,
                "reason": reason,
            })
            return

        log.info("SSH stream -> {} : {}".format(msg.get("device_ip"), command[:60]))

        chunk_queue: asyncio.Queue = asyncio.Queue()
        main_loop = loop

        async def _stream_task():
            # Run the blocking SSH part in executor
            await loop.run_in_executor(
                None, _ssh_command_stream_sync, msg, chunk_queue, main_loop
            )
            # Read chunks from queue and send
            seq = 0
            while True:
                chunk = await chunk_queue.get()
                if chunk is None:
                    # End of stream sentinel
                    break
                if isinstance(chunk, dict) and "__error__" in chunk:
                    await _send({
                        "type": "ssh_stream_end",
                        "request_id": rid,
                        "success": False,
                        "error": chunk["__error__"],
                    })
                    return
                await _send({
                    "type": "ssh_stream_chunk",
                    "request_id": rid,
                    "seq": seq,
                    "data": chunk,
                })
                seq += 1

            await _send({
                "type": "ssh_stream_end",
                "request_id": rid,
                "success": True,
                "total_chunks": seq,
            })

        asyncio.create_task(_stream_task())

    # Feature 4: SNMP
    elif t == "snmp_get":
        log.info("SNMP get -> {} OID: {}".format(msg.get("device_ip"), msg.get("oid")))
        result = await loop.run_in_executor(None, _snmp_get_sync, msg)
        await _send({"type": "snmp_result", "request_id": rid, "operation": "get", **result})

    elif t == "snmp_walk":
        log.info("SNMP walk -> {} OID: {}".format(msg.get("device_ip"), msg.get("oid")))
        result = await loop.run_in_executor(None, _snmp_walk_sync, msg)
        await _send({"type": "snmp_result", "request_id": rid, "operation": "walk", **result})

    # Feature 5: Auto Device Discovery
    elif t == "discover_request":
        subnet = msg.get("subnet", "")
        log.info("Subnet discovery basladi: {}".format(subnet))
        result = await loop.run_in_executor(None, _discover_subnet, msg)
        await _send({"type": "discover_result", "request_id": rid, **result})

    elif t == "ping":
        await _send({"type": "pong"})

    elif t == "update_available":
        server_version = msg.get("current_version", "?")
        script_path_remote = msg.get("script_path", "/api/v1/agents/script")
        log.info("Guncelleme mevcut: {} -> {}. Indiriliyor...".format(VERSION, server_version))
        try:
            import ast as _ast
            import shutil
            import urllib.request

            dl_url = BACKEND_URL.rstrip("/") + script_path_remote
            script_file = os.path.abspath(__file__)
            tmp_file = script_file + ".new"

            # Download new script
            urllib.request.urlretrieve(dl_url, tmp_file)

            # Validate syntax before replacing
            with open(tmp_file, encoding="utf-8") as _f:
                _ast.parse(_f.read())

            # Backup and replace
            shutil.copy2(script_file, script_file + ".bak")
            shutil.move(tmp_file, script_file)

            log.info("Script guncellendi. Yeniden baslatiliyor...")
            await _send({"type": "update_ack", "agent_id": AGENT_ID, "new_version": server_version})
            await asyncio.sleep(0.5)

            # Restart: spawn new process then exit
            import subprocess
            subprocess.Popen([sys.executable, script_file] + sys.argv[1:])
            sys.exit(0)
        except Exception as _e:
            log.error("Guncelleme basarisiz: {}".format(_e))
            await _send({"type": "update_failed", "agent_id": AGENT_ID, "error": str(_e)})

    elif t == "restart":
        log.info("Yeniden baslatma istegi alindi - cikiliyor...")
        await _send({"type": "restart_ack", "agent_id": AGENT_ID})
        _restart_requested = True


# ─────────────────────────────────────────────────────────────────────────────
# Main run loop
# ─────────────────────────────────────────────────────────────────────────────

async def run():
    import random
    ws_base = BACKEND_URL.replace("https://", "wss://").replace("http://", "ws://")
    delay   = 5
    loop    = asyncio.get_event_loop()
    _disconnect_count = 0
    _last_anomaly_disconnect = 0.0

    log.info("NetManager Agent v{} baslatiliyor - ID: {}".format(VERSION, AGENT_ID))

    while True:
        # Always use the most recent key (may have been rotated)
        current_key = os.environ.get("NETMANAGER_AGENT_KEY", AGENT_KEY)
        ws_url = "{}/api/v1/agents/ws/{}?key={}".format(ws_base, AGENT_ID, current_key)

        syslog_transport = None

        try:
            log.info("Baglaniliyor: {}/api/v1/agents/ws/{}".format(ws_base, AGENT_ID))
            async with websockets.connect(
                ws_url,
                ping_interval=None,
                open_timeout=30,
                close_timeout=10,
                max_size=10 * 1024 * 1024,
                extra_headers={"X-Agent-ID": AGENT_ID},
            ) as ws:
                log.info("Backend'e baglandi")
                delay = 5

                await ws.send(json.dumps({
                    "type":          "hello",
                    "agent_id":      AGENT_ID,
                    "version":       VERSION,
                    "platform":      platform.system().lower(),
                    "hostname":      platform.node(),
                    "local_ip":      _get_local_ip(),
                    "python_version": platform.python_version(),
                    "has_psutil":    _HAS_PSUTIL,
                    "has_snmp":      _HAS_SNMP,
                    "has_crypto":    _HAS_CRYPTO,
                    "vault_support": True,
                }))

                # Feature 3: flush offline queue after reconnect
                if _result_queue:
                    queued = list(_result_queue)
                    _result_queue.clear()
                    try:
                        await ws.send(json.dumps({
                            "type":     "queued_results",
                            "agent_id": AGENT_ID,
                            "count":    len(queued),
                            "results":  queued,
                        }))
                        log.info("Kuyruklanmis {} sonuc gonderildi".format(len(queued)))
                    except Exception as e:
                        log.warning("Kuyruk gonderilemedi: {}".format(e))
                        # Put them back if send fails
                        for item in queued:
                            _result_queue.append(item)

                async def _heartbeat():
                    # Send immediately on connect so backend refreshes Redis TTL right away
                    try:
                        await ws.send(json.dumps({
                            "type":      "heartbeat",
                            "agent_id":  AGENT_ID,
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "metrics":   _get_metrics(),
                        }))
                    except Exception:
                        return
                    while True:
                        await asyncio.sleep(HEARTBEAT_INTERVAL)
                        try:
                            payload = {
                                "type":      "heartbeat",
                                "agent_id":  AGENT_ID,
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                                "metrics":   _get_metrics(),
                            }
                            await ws.send(json.dumps(payload))
                        except Exception:
                            break

                # Sprint 14C: Edge anomaly detector — runs every 5 min
                async def _edge_anomaly_check():
                    while True:
                        await asyncio.sleep(300)
                        try:
                            # SSH error rate
                            if len(_ssh_window) >= 5:
                                fail_rate = _ssh_window.count(False) / len(_ssh_window)
                                if fail_rate >= _SSH_ERROR_RATE_THRESHOLD:
                                    await _maybe_send_anomaly(
                                        ws,
                                        "ssh_error_rate",
                                        "Yüksek SSH Hata Oranı",
                                        "Son {} komutun {:.0%} başarısız oldu".format(
                                            len(_ssh_window), fail_rate),
                                        {"fail_rate": round(fail_rate, 2),
                                         "window_size": len(_ssh_window)},
                                    )
                            # SNMP latency
                            if _snmp_ema_count >= 3 and _snmp_ema_ms > _SNMP_LATENCY_THRESHOLD_MS:
                                await _maybe_send_anomaly(
                                    ws,
                                    "snmp_latency",
                                    "Yüksek SNMP Yanıt Süresi",
                                    "Ortalama SNMP yanıt {:.0f} ms (eşik: {:.0f} ms)".format(
                                        _snmp_ema_ms, _SNMP_LATENCY_THRESHOLD_MS),
                                    {"ema_ms": round(_snmp_ema_ms, 1),
                                     "threshold_ms": _SNMP_LATENCY_THRESHOLD_MS},
                                )
                        except Exception:
                            pass

                # Start background tasks
                hb   = asyncio.create_task(_heartbeat())
                evict = asyncio.create_task(_pool_evict_loop())
                hc   = asyncio.create_task(_health_check(ws, loop))
                edge = asyncio.create_task(_edge_anomaly_check())

                # Feature 6: Start syslog UDP server if enabled
                if _syslog_enabled:
                    try:
                        transport, _protocol = await loop.create_datagram_endpoint(
                            lambda: SyslogProtocol(ws, loop),
                            local_addr=("0.0.0.0", _syslog_port),
                        )
                        syslog_transport = transport
                        log.info("Syslog UDP sunucusu basladi: port={}".format(_syslog_port))
                    except Exception as e:
                        log.warning("Syslog sunucusu baslatılamadi: {}".format(e))

                try:
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                            asyncio.create_task(handle_message(ws, msg, loop))
                        except json.JSONDecodeError:
                            pass
                        if _restart_requested:
                            break
                finally:
                    hb.cancel()
                    evict.cancel()
                    hc.cancel()
                    edge.cancel()
                    if syslog_transport is not None:
                        syslog_transport.close()
                        syslog_transport = None

            if _restart_requested:
                log.info("Yeniden baslatiliyor...")
                sys.exit(0)

        except Exception as exc:
            if syslog_transport is not None:
                try:
                    syslog_transport.close()
                except Exception:
                    pass
                syslog_transport = None

            # Handle specific WS close codes
            err_str = str(exc)
            if "4001" in err_str:
                log.error("Kimlik dogrulama hatasi (gecersiz key). Key'i kontrol edin.")
                await asyncio.sleep(60)
                delay = 60
            elif "4029" in err_str:
                log.error("Cok fazla basarisiz girisim - agent kilitlendi. Yoneticiyle iletisime gecin.")
                await asyncio.sleep(300)
                delay = 300
            elif "4003" in err_str:
                log.error("Baglanti reddedildi - bu sunucu IP'si agent'a guvenilmez olarak isaretlen.")
                await asyncio.sleep(120)
                delay = 120
            else:
                log.warning("Baglanti kesildi: {}. {}s sonra tekrar denenecek...".format(exc, delay))
                _disconnect_count += 1
                # Sprint 14C: fire local_anomaly on repeated disconnects (>= 3 in a row)
                if _disconnect_count >= 3:
                    now_m = time.monotonic()
                    if now_m - _last_anomaly_disconnect > 1800:
                        _last_anomaly_disconnect = now_m
                        log.warning("[edge] Disconnect anomaly: {} kesinti".format(_disconnect_count))
                        # We can't send via ws here (disconnected) — log only
                        # The backend will detect offline agent via heartbeat timeout
                jitter = random.uniform(0, min(delay, 5))
                await asyncio.sleep(delay + jitter)
                delay = min(delay * 2, 30)


if __name__ == "__main__":
    if not AGENT_ID or not AGENT_KEY:
        print("HATA: NETMANAGER_AGENT_ID ve NETMANAGER_AGENT_KEY gerekli.", file=sys.stderr)
        sys.exit(1)
    asyncio.run(run())
