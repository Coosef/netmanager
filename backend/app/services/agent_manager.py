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

import redis as _redis_sync

from fastapi import WebSocket
from app.core.config import settings

log = logging.getLogger("agent_manager")


def _decrypt_community(value) -> str:
    from app.core.security import decrypt_credential_safe
    return decrypt_credential_safe(value) or "public"

_COMMAND_TIMEOUT = 90   # seconds to wait for SSH result from agent
_AGENT_ONLINE_TTL = 120  # seconds; refreshed on every heartbeat (agent sends every 10s)

def _get_sync_redis():
    return _redis_sync.from_url(settings.REDIS_URL, decode_responses=True, socket_timeout=2)
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
        try:
            _get_sync_redis().setex(f"agent:{agent_id}:online", _AGENT_ONLINE_TTL, "1")
        except Exception:
            pass
        log.info(f"Agent connected: {agent_id} ({meta.get('hostname', '?')} / {meta.get('platform', '?')})")

    async def disconnect(self, agent_id: str):
        self._connections.pop(agent_id, None)
        self._meta.pop(agent_id, None)
        self._security.pop(agent_id, None)
        to_cancel = [rid for rid, fut in self._pending.items() if not fut.done()]
        for rid in to_cancel:
            self._pending[rid].set_exception(RuntimeError(f"Agent {agent_id} disconnected"))
        try:
            _get_sync_redis().delete(f"agent:{agent_id}:online")
        except Exception:
            pass
        log.info(f"Agent disconnected: {agent_id}")

    def is_online(self, agent_id: str) -> bool:
        if agent_id in self._connections:
            return True
        try:
            return bool(_get_sync_redis().exists(f"agent:{agent_id}:online"))
        except Exception:
            return False

    def refresh_online(self, agent_id: str) -> None:
        """Called on heartbeat to reset the Redis TTL."""
        try:
            _get_sync_redis().expire(f"agent:{agent_id}:online", _AGENT_ONLINE_TTL)
        except Exception:
            pass

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

        elif msg_type == "update_ack":
            new_ver = msg.get("new_version", "?")
            log.info(f"Agent {agent_id} güncelleme tamamlandı → v{new_ver}, yeniden başlatılıyor")

        elif msg_type == "update_failed":
            log.warning(f"Agent {agent_id} güncelleme başarısız: {msg.get('error', '?')}")

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

        elif msg_type == "queued_events":
            events = msg.get("events", [])
            log.info(f"Agent {agent_id} delivered {len(events)} queued monitoring events from offline period")
            for ev in events:
                ev_type = ev.get("type", "")
                if ev_type == "device_status_report":
                    asyncio.get_running_loop().create_task(
                        self._handle_device_status_report(agent_id, ev)
                    )
                elif ev_type == "syslog_event":
                    asyncio.get_running_loop().create_task(
                        self._handle_syslog_event(agent_id, ev)
                    )
                elif ev_type == "snmp_trap":
                    asyncio.get_running_loop().create_task(
                        self._handle_snmp_trap(agent_id, ev)
                    )
                elif ev_type == "local_anomaly":
                    asyncio.get_running_loop().create_task(
                        self._handle_local_anomaly(agent_id, ev)
                    )

        elif msg_type == "device_status_report":
            asyncio.get_running_loop().create_task(
                self._handle_device_status_report(agent_id, msg)
            )

        elif msg_type == "syslog_event":
            asyncio.get_running_loop().create_task(
                self._handle_syslog_event(agent_id, msg)
            )

        elif msg_type == "snmp_trap":
            asyncio.get_running_loop().create_task(
                self._handle_snmp_trap(agent_id, msg)
            )

        elif msg_type == "ping_result":
            req_id = msg.get("req_id", "")
            if req_id and req_id in self._pending:
                fut = self._pending.pop(req_id)
                if not fut.done():
                    fut.set_result(msg.get("reachable", False))

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
            from sqlalchemy import update, select, and_
            from app.core.database import make_worker_session
            from app.models.device import Device, DeviceStatus
            from app.models.network_event import NetworkEvent
            from app.models.maintenance_window import MaintenanceWindow

            results = msg.get("results", [])
            if not results:
                return

            _redis = _get_sync_redis()
            now_utc = datetime.now(timezone.utc)

            async with make_worker_session()() as db:
                # Fetch active maintenance windows once for this batch
                mw_rows = await db.execute(
                    select(MaintenanceWindow).where(
                        and_(
                            MaintenanceWindow.start_time <= now_utc,
                            MaintenanceWindow.end_time >= now_utc,
                        )
                    )
                )
                active_windows = mw_rows.scalars().all()

                def _in_maintenance(device_id: int) -> bool:
                    for w in active_windows:
                        if w.applies_to_all:
                            return True
                        if w.device_ids and device_id in w.device_ids:
                            return True
                    return False

                for r in results:
                    device_id = r.get("device_id")
                    reachable = r.get("reachable", False)
                    is_flapping = r.get("flapping", False)
                    ip = r.get("ip", "")

                    # Update device status in DB
                    new_status = DeviceStatus.ONLINE if reachable else DeviceStatus.OFFLINE
                    values: dict = {"status": new_status}
                    if reachable:
                        values["last_seen"] = datetime.now(timezone.utc)
                    await db.execute(
                        update(Device).where(Device.id == device_id).values(**values)
                    )

                    # Skip event creation if device is in an active maintenance window
                    if _in_maintenance(device_id):
                        log.debug(f"Device {device_id} in maintenance window — event suppressed")
                        continue

                    # Determine event type
                    if is_flapping:
                        event_type = "device_flapping"
                        severity = "warning"
                    elif reachable:
                        event_type = "device_online"
                        severity = "info"
                    else:
                        event_type = "device_offline"
                        severity = "critical"

                    # Dedup: skip if same event already fired in last 10 min
                    dedup_key = f"event:dedup:{device_id}:{event_type}"
                    try:
                        if _redis.get(dedup_key):
                            continue
                        _redis.setex(dedup_key, 600, "1")
                    except Exception:
                        pass

                    # Get hostname for readable event title
                    row = await db.execute(select(Device.hostname).where(Device.id == device_id))
                    hostname = row.scalar() or ip

                    if is_flapping:
                        title = f"Cihaz kararsız: {hostname}"
                        message = f"{hostname} ({ip}) kısa sürede birden fazla kez durum değiştirdi"
                    elif reachable:
                        title = f"Cihaz çevrimiçi: {hostname}"
                        message = f"{hostname} ({ip}) tekrar erişilebilir"
                    else:
                        title = f"Cihaz çevrimdışı: {hostname}"
                        message = f"{hostname} ({ip}) — 2 ardışık kontrol başarısız"

                    ev = NetworkEvent(
                        device_id=device_id,
                        device_hostname=hostname,
                        event_type=event_type,
                        severity=severity,
                        title=title,
                        message=message,
                        details={"ip": ip, "agent_id": agent_id, "flapping": is_flapping},
                    )
                    db.add(ev)

                await db.commit()

                # ── Correlation engine — stateful Incident lifecycle ──────────
                # Runs after commit so the NetworkEvent is persisted first.
                # Flapping events are not fed into the correlation engine —
                # they are transient by definition.
                try:
                    from app.services.correlation_engine import process_event as _corr_process
                    for r in results:
                        device_id_r = r.get("device_id")
                        if not device_id_r:
                            continue
                        is_flapping_r = r.get("flapping", False)
                        if is_flapping_r:
                            continue  # flapping handled by existing NetworkEvent only
                        reachable_r = r.get("reachable", False)
                        await _corr_process(
                            device_id  = device_id_r,
                            event_type = "device_unreachable",
                            component  = "device",
                            source     = "agent",
                            is_problem = not reachable_r,
                            db         = db,
                            sync_redis = _redis,
                            severity   = "critical" if not reachable_r else "info",
                        )
                except Exception as corr_err:
                    # Correlation engine errors must never break the main event flow
                    log.warning(f"Correlation engine error (non-fatal): {corr_err}")

            log.debug(f"Agent {agent_id} status report: {len(results)} device(s) changed")
        except Exception as e:
            log.warning(f"Device status report handler error: {e}")

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

    # ── D4: SNMP Trap handling ────────────────────────────────────────────────

    async def _handle_snmp_trap(self, agent_id: str, msg: dict):
        """Find device by source IP, check maintenance window, create NetworkEvent."""
        try:
            from sqlalchemy import select, and_
            from app.core.database import make_worker_session
            from app.models.device import Device
            from app.models.network_event import NetworkEvent
            from app.models.maintenance_window import MaintenanceWindow
            import json as _json

            source_ip = msg.get("source_ip", "")
            trap_name = msg.get("trap_name", "unknown")
            severity = msg.get("severity", "warning")
            trap_oid = msg.get("trap_oid", "")
            community = msg.get("community", "")
            version = msg.get("version", "unknown")

            _redis = _get_sync_redis()
            now_utc = datetime.now(timezone.utc)

            async with make_worker_session()() as db:
                # Find device by IP
                row = await db.execute(
                    select(Device.id, Device.hostname).where(Device.ip_address == source_ip)
                )
                device_row = row.first()

                device_id = device_row[0] if device_row else None
                hostname = device_row[1] if device_row else source_ip

                # Check maintenance window (suppress events during maintenance)
                if device_id:
                    mw_rows = await db.execute(
                        select(MaintenanceWindow).where(
                            and_(
                                MaintenanceWindow.start_time <= now_utc,
                                MaintenanceWindow.end_time >= now_utc,
                            )
                        )
                    )
                    active_windows = mw_rows.scalars().all()
                    for w in active_windows:
                        if w.applies_to_all or (w.device_ids and device_id in w.device_ids):
                            log.debug(f"SNMP trap from {source_ip} suppressed (maintenance window)")
                            return

                # Dedup: same trap type from same IP, 5-minute window
                dedup_key = f"trap:dedup:{source_ip}:{trap_name}"
                try:
                    if _redis.get(dedup_key):
                        return
                    _redis.setex(dedup_key, 300, "1")
                except Exception:
                    pass

                title = f"SNMP Trap: {trap_name} — {hostname}"
                message = (
                    f"{hostname} ({source_ip}) gönderdi: {trap_name}"
                    + (f" [OID: {trap_oid}]" if trap_oid else "")
                )

                ev = NetworkEvent(
                    device_id=device_id,
                    device_hostname=hostname,
                    event_type=f"snmp_trap_{trap_name}",
                    severity=severity,
                    title=title,
                    message=message,
                    details={
                        "source_ip": source_ip,
                        "trap_oid": trap_oid,
                        "trap_name": trap_name,
                        "community": community,
                        "version": version,
                        "agent_id": agent_id,
                        "varbinds": msg.get("varbinds", []),
                    },
                )
                db.add(ev)
                await db.commit()

                # ── Correlation engine — availability-impacting traps only ────
                # authFailure is a security event, not availability → excluded.
                # NetworkEvent raw log is always written above, regardless.
                _TRAP_CORRELATION = {
                    "linkDown":  ("port_down",      "device", True),   # is_problem
                    "linkUp":    ("port_down",      "device", False),  # recovery
                    "coldStart": ("device_restart", "device", True),
                    "warmStart": ("device_restart", "device", True),
                }
                corr = _TRAP_CORRELATION.get(trap_name)
                if corr and device_id:
                    event_type_c, component_c, is_problem_c = corr
                    try:
                        from app.services.correlation_engine import process_event as _corr
                        await _corr(
                            device_id  = device_id,
                            event_type = event_type_c,
                            component  = component_c,
                            source     = "snmp_trap",
                            is_problem = is_problem_c,
                            db         = db,
                            sync_redis = _redis,
                            severity   = severity,
                        )
                    except Exception as corr_err:
                        # Correlation errors must never break trap ingest flow
                        log.warning(f"SNMP trap correlation error (non-fatal): {corr_err}")

            # Publish to Redis event stream for real-time UI updates
            try:
                r = _get_sync_redis()
                r.publish("network:events", _json.dumps({
                    "event_type": f"snmp_trap_{trap_name}",
                    "severity": severity,
                    "title": title,
                    "message": message,
                    "source_ip": source_ip,
                    "agent_id": agent_id,
                }))
            except Exception:
                pass

            log.info(f"SNMP trap from {source_ip}: {trap_name} (device_id={device_id})")
        except Exception as e:
            log.debug(f"SNMP trap handler error: {e}")

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
            "full_auth": True,
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

    async def ping_check(self, agent_id: str, ip: str, timeout: int = 3) -> bool:
        """Ask the agent to ICMP-ping `ip`; returns True if reachable."""
        loop = asyncio.get_running_loop()
        req_id = uuid.uuid4().hex
        fut: asyncio.Future = loop.create_future()
        self._pending[req_id] = fut
        ws = self._connections.get(agent_id)
        if not ws:
            self._pending.pop(req_id, None)
            return False
        try:
            await ws.send_text(json.dumps({
                "type": "ping_check",
                "req_id": req_id,
                "ip": ip,
                "timeout": timeout,
            }))
            return await asyncio.wait_for(fut, timeout=timeout + 2)
        except Exception:
            return False
        finally:
            self._pending.pop(req_id, None)

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
            "snmp_community": _decrypt_community(getattr(device, "snmp_community", None)),
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
            "snmp_community": _decrypt_community(getattr(device, "snmp_community", None)),
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

    async def send_trap_config(self, agent_id: str, enabled: bool, bind_port: int = 162) -> bool:
        ws = self._connections.get(agent_id)
        if not ws:
            return False
        try:
            await ws.send_text(json.dumps({
                "type": "trap_config",
                "enabled": enabled,
                "port": bind_port,
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
