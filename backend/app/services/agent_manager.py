"""
AgentManager — manages live WebSocket connections from proxy agents.
Backend sends SSH/SNMP/discovery command requests; agents execute them and return results.
"""
import asyncio
import json
import time
import uuid
import logging
import base64
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import WebSocket

log = logging.getLogger("agent_manager")

_COMMAND_TIMEOUT = 60  # seconds to wait for SSH result from agent
_EMA_ALPHA = 0.3       # exponential moving average weight for latency

# Commands that are always safe regardless of mode (read-only show commands)
_SAFE_PREFIXES = (
    "show ", "display ", "ping ", "traceroute ", "trace-route ",
    "get ", "debug ip packet", "sh ",
)


def _is_command_allowed(command: str, mode: str, allowed_commands: list[str]) -> tuple[bool, str]:
    """
    Returns (allowed, reason).
    mode: 'all' | 'whitelist' | 'blacklist'
    allowed_commands: list of allowed (whitelist) or blocked (blacklist) prefixes
    """
    if mode == "all":
        return True, ""

    cmd_lower = command.strip().lower()

    if mode == "whitelist":
        if not allowed_commands:
            for prefix in _SAFE_PREFIXES:
                if cmd_lower.startswith(prefix):
                    return True, ""
            return False, "whitelist boş — sadece salt-okunur komutlara izin verildi"
        for prefix in allowed_commands:
            if cmd_lower.startswith(prefix.lower()):
                return True, ""
        return False, f"komut whitelist'te yok: {command[:60]}"

    if mode == "blacklist":
        for prefix in allowed_commands:
            if cmd_lower.startswith(prefix.lower()):
                return False, f"komut blacklist'te engellendi: {command[:60]}"
        return True, ""

    return True, ""


class AgentManager:
    def __init__(self):
        self._connections: dict[str, WebSocket] = {}
        self._pending: dict[str, asyncio.Future] = {}
        self._meta: dict[str, dict] = {}
        # (agent_id, device_id) -> EMA latency_ms (in-memory, updated on each command)
        self._latency: dict[tuple[str, int], float] = {}
        # agent_id -> security config cache {command_mode, allowed_commands}
        self._security: dict[str, dict] = {}
        # Streaming: request_id -> list[str] accumulator
        self._stream_buffers: dict[str, list[str]] = {}

    # ── Connection lifecycle ──────────────────────────────────────────────────

    async def connect(self, agent_id: str, websocket: WebSocket, meta: dict):
        old = self._connections.get(agent_id)
        if old is not None and old is not websocket:
            try:
                await old.close(1001)
            except Exception:
                pass
        self._connections[agent_id] = websocket
        self._meta[agent_id] = {**meta, "connected_at": datetime.now(timezone.utc).isoformat()}
        log.info(f"Agent connected: {agent_id} ({meta.get('hostname', '?')} / {meta.get('platform', '?')})")

    async def disconnect(self, agent_id: str):
        self._connections.pop(agent_id, None)
        self._meta.pop(agent_id, None)
        self._security.pop(agent_id, None)
        to_cancel = [rid for rid, fut in self._pending.items() if not fut.done()]
        for rid in to_cancel:
            self._pending[rid].set_exception(RuntimeError(f"Agent {agent_id} disconnected"))
        log.info(f"Agent disconnected: {agent_id}")

    def is_online(self, agent_id: str) -> bool:
        return agent_id in self._connections

    def online_agent_ids(self) -> list[str]:
        return list(self._connections.keys())

    # ── Security config cache ─────────────────────────────────────────────────

    def set_security_config(self, agent_id: str, command_mode: str, allowed_commands_raw: Optional[str]):
        import json as _json
        commands: list[str] = []
        if allowed_commands_raw:
            try:
                commands = _json.loads(allowed_commands_raw)
            except Exception:
                commands = [c.strip() for c in allowed_commands_raw.split(",") if c.strip()]
        self._security[agent_id] = {
            "command_mode": command_mode or "all",
            "allowed_commands": commands,
        }

    def get_security_config(self, agent_id: str) -> dict:
        return self._security.get(agent_id, {"command_mode": "all", "allowed_commands": []})

    # ── Message routing ───────────────────────────────────────────────────────

    async def handle_message(self, agent_id: str, raw: str):
        try:
            msg = json.loads(raw)
        except Exception:
            return

        msg_type = msg.get("type")

        # Standard request/response results
        if msg_type in ("ssh_result", "snmp_result", "discover_result"):
            rid = msg.get("request_id")
            if rid and rid in self._pending:
                fut = self._pending.pop(rid)
                if not fut.done():
                    fut.set_result(msg)

        elif msg_type == "heartbeat":
            if agent_id in self._meta:
                self._meta[agent_id]["last_heartbeat"] = datetime.now(timezone.utc).isoformat()
                metrics = msg.get("metrics")
                if metrics:
                    self._meta[agent_id]["metrics"] = metrics

        elif msg_type == "pong":
            pass

        elif msg_type == "restart_ack":
            log.info(f"Agent {agent_id} restart acknowledged")

        elif msg_type == "key_rotate_ack":
            log.info(f"Agent {agent_id} key rotation acknowledged")

        elif msg_type == "vault_ack":
            count = msg.get("credential_count", 0)
            log.info(f"Agent {agent_id} vault loaded: {count} credentials")
            if agent_id in self._meta:
                self._meta[agent_id]["vault_active"] = True
                self._meta[agent_id]["vault_credential_count"] = count

        elif msg_type == "security_blocked":
            log.warning(
                f"Agent {agent_id} blocked command locally: "
                f"{msg.get('command', '')[:80]} — reason: {msg.get('reason', '?')}"
            )
            rid = msg.get("request_id")
            if rid and rid in self._pending:
                fut = self._pending.pop(rid)
                if not fut.done():
                    fut.set_result({
                        "success": False,
                        "blocked": True,
                        "error": f"Agent tarafında engellendi: {msg.get('reason', '?')}",
                    })

        elif msg_type == "queued_results":
            results = msg.get("results", [])
            log.info(f"Agent {agent_id} delivered {len(results)} queued results from previous session")
            for result in results:
                rid = result.get("request_id")
                if rid and rid in self._pending:
                    fut = self._pending.pop(rid)
                    if not fut.done():
                        fut.set_result(result)

        elif msg_type == "device_status_report":
            asyncio.get_running_loop().create_task(
                self._handle_device_status_report(agent_id, msg)
            )

        elif msg_type == "syslog_event":
            asyncio.get_running_loop().create_task(
                self._handle_syslog_event(agent_id, msg)
            )

        # Sprint 14C: Agent edge intelligence anomaly report
        elif msg_type == "local_anomaly":
            asyncio.get_running_loop().create_task(
                self._handle_local_anomaly(agent_id, msg)
            )

        elif msg_type == "ssh_stream_chunk":
            rid = msg.get("request_id")
            chunk = msg.get("chunk", "")
            if rid:
                if rid not in self._stream_buffers:
                    self._stream_buffers[rid] = []
                self._stream_buffers[rid].append(chunk)
            asyncio.get_running_loop().create_task(
                self._publish_stream_chunk(rid, chunk, done=False)
            )

        elif msg_type == "ssh_stream_end":
            rid = msg.get("request_id")
            output = msg.get("output", "")
            success = msg.get("success", True)
            self._stream_buffers.pop(rid, None)
            asyncio.get_running_loop().create_task(
                self._publish_stream_chunk(rid, output, done=True, success=success)
            )
            if rid and rid in self._pending:
                fut = self._pending.pop(rid)
                if not fut.done():
                    fut.set_result({"success": success, "output": output, "type": "ssh_result"})

    # ── Device status reporting ───────────────────────────────────────────────

    async def _handle_device_status_report(self, agent_id: str, msg: dict):
        try:
            from sqlalchemy import update
            from app.core.database import make_worker_session
            from app.models.device import Device, DeviceStatus

            results = msg.get("results", [])
            async with make_worker_session()() as db:
                for r in results:
                    device_id = r.get("device_id")
                    reachable = r.get("reachable", False)
                    new_status = DeviceStatus.ONLINE if reachable else DeviceStatus.OFFLINE
                    values: dict = {"status": new_status}
                    if reachable:
                        values["last_seen"] = datetime.now(timezone.utc)
                    await db.execute(
                        update(Device).where(Device.id == device_id).values(**values)
                    )
                await db.commit()
            log.debug(f"Agent {agent_id} status report: {len(results)} devices updated")
        except Exception as e:
            log.debug(f"Device status report handler error: {e}")

    # ── Syslog event handling ─────────────────────────────────────────────────

    async def _handle_syslog_event(self, agent_id: str, msg: dict):
        try:
            from app.core.database import make_worker_session
            from app.models.syslog_event import SyslogEvent

            async with make_worker_session()() as db:
                ev = SyslogEvent(
                    agent_id=agent_id,
                    source_ip=msg.get("source_ip", ""),
                    facility=msg.get("facility", 0),
                    severity=msg.get("severity", 7),
                    message=msg.get("message", ""),
                    received_at=datetime.now(timezone.utc),
                )
                db.add(ev)
                await db.commit()
        except Exception as e:
            log.debug(f"Syslog persist error: {e}")

    # ── Sprint 14C: Local anomaly handling ───────────────────────────────────

    async def _handle_local_anomaly(self, agent_id: str, msg: dict):
        """Persist agent-side anomaly as NetworkEvent and publish to Redis."""
        try:
            import json as _json
            import redis as _redis_sync
            from app.core.config import settings as _settings
            from app.core.database import make_worker_session
            from app.models.network_event import NetworkEvent

            anomaly_type = msg.get("anomaly_type", "local_anomaly")
            title = msg.get("title", f"Agent anomalisi: {agent_id}")
            message = msg.get("message", "")
            details = msg.get("details", {})
            details["agent_id"] = agent_id

            async with make_worker_session()() as db:
                evt = NetworkEvent(
                    device_id=None,
                    device_hostname=None,
                    event_type="local_anomaly",
                    severity=msg.get("severity", "warning"),
                    title=title,
                    message=message,
                    details=details,
                )
                db.add(evt)
                await db.commit()

            # Publish to Redis event stream
            r = _redis_sync.from_url(_settings.REDIS_URL, decode_responses=True)
            r.publish("network:events", _json.dumps({
                "event_type": "local_anomaly",
                "severity": "warning",
                "title": title,
                "message": message,
                "agent_id": agent_id,
                "anomaly_type": anomaly_type,
            }))
            log.info(f"Agent {agent_id} local_anomaly: {anomaly_type} — {message}")
        except Exception as e:
            log.debug(f"Local anomaly handler error: {e}")

    # ── Command streaming ─────────────────────────────────────────────────────

    async def _publish_stream_chunk(self, request_id: str, chunk: str, done: bool, success: bool = True):
        try:
            from app.core.redis_client import get_redis
            r = get_redis()
            payload = json.dumps({"chunk": chunk, "done": done, "success": success})
            await r.publish(f"cmd_stream:{request_id}", payload)
            if done:
                await r.setex(f"cmd_stream_done:{request_id}", 60, "1")
        except Exception as e:
            log.debug(f"Stream publish error: {e}")

    # ── SSH command dispatch ──────────────────────────────────────────────────

    async def _send_request(
        self,
        agent_id: str,
        payload: dict,
        timeout: int = _COMMAND_TIMEOUT,
        device_id: int | None = None,
    ) -> dict:
        ws = self._connections.get(agent_id)
        if not ws:
            raise RuntimeError(f"Agent {agent_id} is not connected")

        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        rid = payload["request_id"]
        self._pending[rid] = fut

        t0 = time.perf_counter()
        try:
            await ws.send_text(json.dumps(payload))
            result = await asyncio.wait_for(fut, timeout=timeout)
            latency_ms = (time.perf_counter() - t0) * 1000
            if device_id is not None:
                self._update_latency(agent_id, device_id, latency_ms, success=result.get("success", True))
            return result
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            if device_id is not None:
                self._update_latency(agent_id, device_id, float(timeout * 1000), success=False)
            raise RuntimeError(f"Agent {agent_id} did not respond within {timeout}s")
        except Exception:
            self._pending.pop(rid, None)
            raise

    async def execute_ssh_command(self, agent_id: str, device, command: str) -> dict:
        from app.core.security import decrypt_credential

        sec = self.get_security_config(agent_id)
        allowed, reason = _is_command_allowed(command, sec["command_mode"], sec["allowed_commands"])
        if not allowed:
            self._log_command_async(
                agent_id=agent_id, device_id=device.id, device_ip=device.ip_address,
                command_type="ssh_command", command=command,
                success=False, duration_ms=0, blocked=True, block_reason=reason,
                request_id=None,
            )
            raise RuntimeError(f"Komut güvenlik politikası tarafından engellendi: {reason}")

        rid = uuid.uuid4().hex
        # Use vault if active (avoids sending plaintext password in WS message)
        meta = self._meta.get(agent_id, {})
        if meta.get("vault_active"):
            payload = {
                "type": "ssh_command",
                "request_id": rid,
                "credential_id": device.id,
                "command": command,
                "command_mode": sec["command_mode"],
                "allowed_commands": sec["allowed_commands"],
            }
        else:
            payload = {
                "type": "ssh_command",
                "request_id": rid,
                "device_ip": device.ip_address,
                "ssh_username": device.ssh_username,
                "ssh_password": decrypt_credential(device.ssh_password_enc),
                "ssh_port": device.ssh_port or 22,
                "os_type": device.os_type,
                "enable_secret": decrypt_credential(device.enable_secret_enc) if device.enable_secret_enc else "",
                "command": command,
                "command_mode": sec["command_mode"],
                "allowed_commands": sec["allowed_commands"],
            }
        t0 = time.perf_counter()
        result = await self._send_request(agent_id, payload, device_id=device.id)
        duration_ms = int((time.perf_counter() - t0) * 1000)

        self._log_command_async(
            agent_id=agent_id, device_id=device.id, device_ip=device.ip_address,
            command_type="ssh_command", command=command,
            success=result.get("success", False), duration_ms=duration_ms,
            blocked=result.get("blocked", False),
            block_reason=result.get("error") if result.get("blocked") else None,
            request_id=rid,
        )
        return result

    async def execute_ssh_config(self, agent_id: str, device, commands: list[str]) -> dict:
        from app.core.security import decrypt_credential

        sec = self.get_security_config(agent_id)
        if sec["command_mode"] != "all":
            for cmd in commands:
                allowed, reason = _is_command_allowed(cmd, sec["command_mode"], sec["allowed_commands"])
                if not allowed:
                    self._log_command_async(
                        agent_id=agent_id, device_id=device.id, device_ip=device.ip_address,
                        command_type="ssh_config", command=f"config:{len(commands)} komut",
                        success=False, duration_ms=0, blocked=True, block_reason=reason,
                        request_id=None,
                    )
                    raise RuntimeError(f"Komut güvenlik politikası tarafından engellendi: {reason}")

        rid = uuid.uuid4().hex
        meta = self._meta.get(agent_id, {})
        if meta.get("vault_active"):
            payload = {
                "type": "ssh_config",
                "request_id": rid,
                "credential_id": device.id,
                "commands": commands,
                "command_mode": sec["command_mode"],
                "allowed_commands": sec["allowed_commands"],
            }
        else:
            payload = {
                "type": "ssh_config",
                "request_id": rid,
                "device_ip": device.ip_address,
                "ssh_username": device.ssh_username,
                "ssh_password": decrypt_credential(device.ssh_password_enc),
                "ssh_port": device.ssh_port or 22,
                "os_type": device.os_type,
                "enable_secret": decrypt_credential(device.enable_secret_enc) if device.enable_secret_enc else "",
                "commands": commands,
                "command_mode": sec["command_mode"],
                "allowed_commands": sec["allowed_commands"],
            }
        t0 = time.perf_counter()
        result = await self._send_request(agent_id, payload, device_id=device.id)
        duration_ms = int((time.perf_counter() - t0) * 1000)

        self._log_command_async(
            agent_id=agent_id, device_id=device.id, device_ip=device.ip_address,
            command_type="ssh_config", command=f"config:{len(commands)} komut",
            success=result.get("success", False), duration_ms=duration_ms,
            blocked=False, block_reason=None, request_id=rid,
        )
        return result

    def get_live_metrics(self, agent_id: str) -> dict | None:
        meta = self._meta.get(agent_id)
        if not meta:
            return None
        return {
            "connected_at": meta.get("connected_at"),
            "last_heartbeat": meta.get("last_heartbeat"),
            "metrics": meta.get("metrics", {}),
            "vault_active": meta.get("vault_active", False),
            "vault_credential_count": meta.get("vault_credential_count", 0),
        }

    async def send_restart(self, agent_id: str) -> bool:
        ws = self._connections.get(agent_id)
        if not ws:
            return False
        try:
            await ws.send_text(json.dumps({"type": "restart", "agent_id": agent_id}))
            return True
        except Exception:
            return False

    async def send_key_rotate(self, agent_id: str, new_key: str) -> bool:
        ws = self._connections.get(agent_id)
        if not ws:
            return False
        try:
            await ws.send_text(json.dumps({"type": "key_rotate", "new_key": new_key}))
            return True
        except Exception:
            return False

    async def send_security_config(self, agent_id: str, command_mode: str, allowed_commands: list[str]) -> bool:
        ws = self._connections.get(agent_id)
        if not ws:
            return False
        try:
            await ws.send_text(json.dumps({
                "type": "security_config",
                "command_mode": command_mode,
                "allowed_commands": allowed_commands,
            }))
            return True
        except Exception:
            return False

    async def test_ssh_connection(self, agent_id: str, device) -> dict:
        from app.core.security import decrypt_credential
        rid = uuid.uuid4().hex
        payload = {
            "type": "ssh_test",
            "request_id": rid,
            "device_ip": device.ip_address,
            "ssh_username": device.ssh_username,
            "ssh_password": decrypt_credential(device.ssh_password_enc),
            "ssh_port": device.ssh_port or 22,
            "os_type": device.os_type,
            "enable_secret": decrypt_credential(device.enable_secret_enc) if device.enable_secret_enc else "",
        }
        t0 = time.perf_counter()
        result = await self._send_request(agent_id, payload, timeout=30, device_id=device.id)
        duration_ms = int((time.perf_counter() - t0) * 1000)
        self._log_command_async(
            agent_id=agent_id, device_id=device.id, device_ip=device.ip_address,
            command_type="ssh_test", command="ssh_test",
            success=result.get("success", False), duration_ms=duration_ms,
            blocked=False, block_reason=None, request_id=rid,
        )
        return result

    # ── Feature 2: Device sync ────────────────────────────────────────────────

    async def send_device_sync(self, agent_id: str, devices: list[dict]) -> bool:
        ws = self._connections.get(agent_id)
        if not ws:
            return False
        try:
            await ws.send_text(json.dumps({
                "type": "device_sync",
                "devices": devices,
            }))
            return True
        except Exception:
            return False

    # ── Feature 4: SNMP routing ───────────────────────────────────────────────

    async def execute_snmp_get(self, agent_id: str, device, oids: list[str]) -> dict:
        rid = uuid.uuid4().hex
        payload = {
            "type": "snmp_get",
            "request_id": rid,
            "device_ip": device.ip_address,
            "snmp_port": getattr(device, "snmp_port", 161) or 161,
            "snmp_version": getattr(device, "snmp_version", "v2c") or "v2c",
            "snmp_community": getattr(device, "snmp_community", "public") or "public",
            "oids": oids,
        }
        return await self._send_request(agent_id, payload, timeout=15)

    async def execute_snmp_walk(self, agent_id: str, device, oid_prefix: str) -> dict:
        rid = uuid.uuid4().hex
        payload = {
            "type": "snmp_walk",
            "request_id": rid,
            "device_ip": device.ip_address,
            "snmp_port": getattr(device, "snmp_port", 161) or 161,
            "snmp_version": getattr(device, "snmp_version", "v2c") or "v2c",
            "snmp_community": getattr(device, "snmp_community", "public") or "public",
            "oid_prefix": oid_prefix,
        }
        return await self._send_request(agent_id, payload, timeout=30)

    # ── Feature 5: Discovery ──────────────────────────────────────────────────

    async def trigger_discovery(self, agent_id: str, subnet: str, ports: list[int] | None = None) -> dict:
        rid = uuid.uuid4().hex
        payload = {
            "type": "discover_request",
            "request_id": rid,
            "subnet": subnet,
            "ports": ports or [22, 23, 80, 443, 161],
        }
        return await self._send_request(agent_id, payload, timeout=120)

    # ── Feature 6: Syslog ────────────────────────────────────────────────────

    async def send_syslog_config(self, agent_id: str, enabled: bool, bind_port: int = 514) -> bool:
        ws = self._connections.get(agent_id)
        if not ws:
            return False
        try:
            await ws.send_text(json.dumps({
                "type": "syslog_config",
                "enabled": enabled,
                "bind_port": bind_port,
            }))
            return True
        except Exception:
            return False

    # ── Feature 7: Streaming ──────────────────────────────────────────────────

    async def execute_ssh_command_stream(self, agent_id: str, device, command: str) -> tuple[str, asyncio.Future]:
        """Start a streaming SSH command. Returns (request_id, future_for_full_result)."""
        from app.core.security import decrypt_credential

        rid = uuid.uuid4().hex
        meta = self._meta.get(agent_id, {})
        if meta.get("vault_active"):
            payload = {
                "type": "ssh_command_stream",
                "request_id": rid,
                "credential_id": device.id,
                "command": command,
            }
        else:
            payload = {
                "type": "ssh_command_stream",
                "request_id": rid,
                "device_ip": device.ip_address,
                "ssh_username": device.ssh_username,
                "ssh_password": decrypt_credential(device.ssh_password_enc),
                "ssh_port": device.ssh_port or 22,
                "os_type": device.os_type,
                "enable_secret": decrypt_credential(device.enable_secret_enc) if device.enable_secret_enc else "",
                "command": command,
            }

        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[rid] = fut

        ws = self._connections.get(agent_id)
        if not ws:
            raise RuntimeError(f"Agent {agent_id} is not connected")

        await ws.send_text(json.dumps(payload))
        return rid, fut

    # ── Feature 8: Credential vault ───────────────────────────────────────────

    async def send_credential_bundle(self, agent_id: str, agent_key_b64: str, credentials: list[dict]) -> bool:
        ws = self._connections.get(agent_id)
        if not ws:
            return False
        try:
            await ws.send_text(json.dumps({
                "type": "credential_bundle",
                "agent_key": agent_key_b64,
                "credentials": credentials,
            }))
            return True
        except Exception:
            return False

    # ── Command logging ───────────────────────────────────────────────────────

    def _log_command_async(self, **kwargs):
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._persist_command_log(**kwargs))
        except RuntimeError:
            pass

    async def _persist_command_log(
        self,
        agent_id: str,
        device_id: Optional[int],
        device_ip: Optional[str],
        command_type: str,
        command: Optional[str],
        success: Optional[bool],
        duration_ms: Optional[int],
        blocked: bool,
        block_reason: Optional[str],
        request_id: Optional[str],
    ):
        try:
            from app.core.database import make_worker_session
            from app.models.agent_command_log import AgentCommandLog
            async with make_worker_session()() as db:
                entry = AgentCommandLog(
                    agent_id=agent_id,
                    device_id=device_id,
                    device_ip=device_ip,
                    command_type=command_type,
                    command=command,
                    success=success,
                    duration_ms=duration_ms,
                    blocked=blocked,
                    block_reason=block_reason,
                    request_id=request_id,
                )
                db.add(entry)
                await db.commit()
        except Exception as e:
            log.debug(f"Command log persist error: {e}")

    # ── Latency tracking ──────────────────────────────────────────────────────

    def _update_latency(self, agent_id: str, device_id: int, latency_ms: float, success: bool = True):
        key = (agent_id, device_id)
        existing = self._latency.get(key)
        if existing is None:
            self._latency[key] = latency_ms
        else:
            self._latency[key] = _EMA_ALPHA * latency_ms + (1 - _EMA_ALPHA) * existing

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._persist_latency(agent_id, device_id, latency_ms, success))
        except RuntimeError:
            pass

    async def _persist_latency(self, agent_id: str, device_id: int, latency_ms: float, success: bool):
        try:
            from sqlalchemy.dialects.postgresql import insert
            from app.core.database import make_worker_session
            from app.models.agent_latency import AgentDeviceLatency
            async with make_worker_session()() as db:
                stmt = (
                    insert(AgentDeviceLatency)
                    .values(
                        agent_id=agent_id,
                        device_id=device_id,
                        latency_ms=latency_ms,
                        success=success,
                        measured_at=datetime.now(timezone.utc),
                    )
                    .on_conflict_do_update(
                        constraint="uq_agent_device",
                        set_={
                            "latency_ms": latency_ms,
                            "success": success,
                            "measured_at": datetime.now(timezone.utc),
                        },
                    )
                )
                await db.execute(stmt)
                await db.commit()
        except Exception as e:
            log.debug(f"Latency persist error: {e}")

    def get_latency(self, agent_id: str, device_id: int) -> float | None:
        return self._latency.get((agent_id, device_id))

    def get_all_latencies(self) -> list[dict]:
        return [
            {"agent_id": aid, "device_id": did, "latency_ms": round(lat, 1)}
            for (aid, did), lat in self._latency.items()
        ]

    async def load_latencies_from_db(self):
        try:
            from sqlalchemy import select
            from app.core.database import make_worker_session
            from app.models.agent_latency import AgentDeviceLatency
            async with make_worker_session()() as db:
                rows = await db.execute(select(AgentDeviceLatency))
                for row in rows.scalars().all():
                    if row.latency_ms is not None:
                        self._latency[(row.agent_id, row.device_id)] = row.latency_ms
            log.info(f"Loaded {len(self._latency)} latency entries from DB")
        except Exception as e:
            log.warning(f"Could not load latencies from DB: {e}")


agent_manager = AgentManager()
