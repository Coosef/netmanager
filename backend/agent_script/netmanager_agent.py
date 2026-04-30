#!/usr/bin/env python3
"""
NetManager Proxy Agent v1.2
Yerel ağa kurulur, NetManager backend'e WebSocket ile bağlanır.
SSH komutlarını ağ cihazlarına iletir ve sonuçları döner.

Güvenlik özellikleri (v1.2):
  - Sunucu tarafından gönderilen komut whitelist/blacklist politikası
  - Agent tarafında komut doğrulama (çift katmanlı koruma)
  - Key rotasyon desteği (env dosyasını otomatik günceller)
  - Güvenlik ihlali bildirim mesajları
"""
import asyncio
import json
import logging
import os
import platform
import sys
import time
import uuid
from datetime import datetime, timezone

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

VERSION = "1.2.0"
BACKEND_URL = os.environ.get("NETMANAGER_URL", "http://localhost:8000").rstrip("/")
AGENT_ID    = os.environ.get("NETMANAGER_AGENT_ID", "")
AGENT_KEY   = os.environ.get("NETMANAGER_AGENT_KEY", "")
HEARTBEAT_INTERVAL = 15

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
    if result.get("success"):
        _stats["cmd_success"] += 1
    else:
        _stats["cmd_fail"] += 1
    _stats["cmd_total_ms"] += result.get("duration_ms", 0)


def _get_metrics():
    metrics = {
        "cmd_success": _stats["cmd_success"],
        "cmd_fail": _stats["cmd_fail"],
        "cmd_total_ms": _stats["cmd_total_ms"],
        "cmd_blocked": _stats["cmd_blocked"],
        "python_version": platform.python_version(),
    }
    if _HAS_PSUTIL:
        try:
            metrics["cpu_percent"] = psutil.cpu_percent(interval=None)
            mem = psutil.virtual_memory()
            metrics["memory_percent"] = mem.percent
            metrics["memory_used_mb"] = round(mem.used / 1024 / 1024)
            metrics["memory_total_mb"] = round(mem.total / 1024 / 1024)
        except Exception:
            pass
    return metrics


# ── SSH islemleri (thread executor'da calisir) ─────────────────────────────

def _build_params(msg):
    os_type = msg.get("os_type", "cisco_ios")
    params = {
        "device_type":        os_type,
        "host":               msg["device_ip"],
        "username":           msg["ssh_username"],
        "password":           msg["ssh_password"],
        "port":               int(msg.get("ssh_port", 22)),
        "timeout":            60,
        "auth_timeout":       30,
        "session_timeout":    120,
        "banner_timeout":     30,
        "blocking_timeout":   40,
        "fast_cli":           False,
        "global_delay_factor": 3,
    }
    if msg.get("enable_secret"):
        params["secret"] = msg["enable_secret"]
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
    enable_secret = msg.get("enable_secret", "")

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
    t0 = time.time()
    try:
        conn = _get_connection(msg)
        output = conn.send_command(msg["command"], read_timeout=120)
        conn.disconnect()
        return {"success": True, "output": str(output), "duration_ms": round((time.time() - t0) * 1000)}
    except Exception as e:
        return {"success": False, "error": str(e), "duration_ms": round((time.time() - t0) * 1000)}


def _ssh_config(msg):
    t0 = time.time()
    try:
        conn = _get_connection(msg)
        output = conn.send_config_set(msg["commands"], read_timeout=120)
        conn.save_config()
        conn.disconnect()
        return {"success": True, "output": str(output), "duration_ms": round((time.time() - t0) * 1000)}
    except Exception as e:
        return {"success": False, "error": str(e), "duration_ms": round((time.time() - t0) * 1000)}


# ── WebSocket dongusu ─────────────────────────────────────────────────────

async def handle_message(ws, msg, loop):
    global _restart_requested

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

    async def _send(payload):
        """Send a message; silently drop if the connection closed mid-operation."""
        try:
            await ws.send(json.dumps(payload))
        except Exception as exc:
            log.warning("Sonuc gonderilemedi (baglanti kapali): {}".format(exc))

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

    elif t == "ping":
        await _send({"type": "pong"})

    elif t == "restart":
        log.info("Yeniden baslatma istegi alindi - cikiliyor...")
        await _send({"type": "restart_ack", "agent_id": AGENT_ID})
        _restart_requested = True


async def run():
    ws_base = BACKEND_URL.replace("https://", "wss://").replace("http://", "ws://")
    delay   = 5
    loop    = asyncio.get_event_loop()

    log.info("NetManager Agent v{} baslatiliyor - ID: {}".format(VERSION, AGENT_ID))

    while True:
        # Always use the most recent key (may have been rotated)
        current_key = os.environ.get("NETMANAGER_AGENT_KEY", AGENT_KEY)
        ws_url = "{}/api/v1/agents/ws/{}?key={}".format(ws_base, AGENT_ID, current_key)

        try:
            log.info("Baglaniliyor: {}/api/v1/agents/ws/{}".format(ws_base, AGENT_ID))
            async with websockets.connect(
                ws_url,
                ping_interval=None,
                open_timeout=30,
                close_timeout=10,
                max_size=10 * 1024 * 1024,
            ) as ws:
                log.info("Backend'e baglandi")
                delay = 5

                await ws.send(json.dumps({
                    "type":     "hello",
                    "agent_id": AGENT_ID,
                    "version":  VERSION,
                    "platform": platform.system().lower(),
                    "hostname": platform.node(),
                    "python_version": platform.python_version(),
                    "has_psutil": _HAS_PSUTIL,
                }))

                async def _heartbeat():
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

                hb = asyncio.create_task(_heartbeat())
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

            if _restart_requested:
                log.info("Yeniden baslatiliyor...")
                sys.exit(0)

        except Exception as exc:
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
                await asyncio.sleep(delay)
                delay = min(delay * 2, 120)


if __name__ == "__main__":
    if not AGENT_ID or not AGENT_KEY:
        print("HATA: NETMANAGER_AGENT_ID ve NETMANAGER_AGENT_KEY gerekli.", file=sys.stderr)
        sys.exit(1)
    asyncio.run(run())
