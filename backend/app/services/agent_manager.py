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
from app.core.metrics import WS_CONNECTIONS_ACTIVE

log = logging.getLogger("agent_manager")


def _decrypt_community(value) -> str:
    from app.core.security import decrypt_credential_safe
    return decrypt_credential_safe(value) or "public"

_COMMAND_TIMEOUT = 90   # seconds to wait for SSH result from agent
_AGENT_ONLINE_TTL = 120  # seconds; refreshed on every heartbeat (agent sends every 10s)

def _get_sync_redis():
    return _redis_sync.from_url(settings.REDIS_URL, decode_responses=True, socket_timeout=2)


def _bump_publish_metric(stream: str, result: str) -> None:
    """Faz 6C: record an event-bus publish outcome. Never raises."""
    try:
        from app.core.metrics import EVENT_BUS_PUBLISH_TOTAL
        EVENT_BUS_PUBLISH_TOTAL.labels(stream=stream, result=result).inc()
    except Exception:
        pass


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
        # Faz T8.5 — Interactive SSH shell sessions (agent-relay terminal).
        # session_id (UUID hex) → {agent_id, on_output (async fn), on_close (async fn)}
        # Browser↔backend WS handler bu callback'leri verir; backend
        # ssh_shell_output/closed mesajları geldiğinde callback'leri çağırır.
        self._shell_sessions: dict[str, dict] = {}
        # session_id → Future (ssh_shell_opened response için)
        self._shell_open_pending: dict[str, asyncio.Future] = {}

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
        WS_CONNECTIONS_ACTIVE.inc()
        try:
            _get_sync_redis().setex(f"agent:{agent_id}:online", _AGENT_ONLINE_TTL, "1")
        except Exception:
            pass
        log.info(f"Agent connected: {agent_id} ({meta.get('hostname', '?')} / {meta.get('platform', '?')})")

    async def disconnect(self, agent_id: str):
        if agent_id in self._connections:
            WS_CONNECTIONS_ACTIVE.dec()
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

        # Faz 7 — agent message handling is trusted data-plane code; run
        # it RLS-bypassed (this WS task is agent-scoped). Rows written
        # here are org-stamped per row by the before_insert hook.
        from app.core.org_context import set_org_context
        set_org_context(None, None, is_super_admin=True)

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
                # Incident HF#12b (2026-06-04) — vault_active is the routing
                # flag execute_ssh_command/config/stream consult to decide
                # whether to send only credential_id (vault path) or the full
                # plaintext credentials (non-vault path). An empty vault still
                # used to set vault_active=True, which then routed every SSH
                # call to a credential_id the agent could not resolve →
                # _build_params fell back to msg.get("ssh_username", "") = ""
                # → netmiko "Authentication failed". Treat count == 0 as
                # "vault not really active" so the non-vault path (HF#11
                # _resolve_credentials with full creds) is used instead.
                self._meta[agent_id]["vault_active"] = count > 0
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

        elif msg_type == "synthetic_probe_result":
            req_id = msg.get("req_id", "")
            if req_id and req_id in self._pending:
                fut = self._pending.pop(req_id)
                if not fut.done():
                    fut.set_result({
                        "success":    msg.get("success", False),
                        "latency_ms": msg.get("latency_ms"),
                        "detail":     msg.get("detail", ""),
                    })

        # Sprint 14C: Agent edge intelligence anomaly report
        elif msg_type == "local_anomaly":
            asyncio.get_running_loop().create_task(
                self._handle_local_anomaly(agent_id, msg)
            )

        # Faz T8.5 — Interactive shell (browser↔backend↔agent↔device)
        elif msg_type == "ssh_shell_opened":
            session_id = msg.get("session_id", "")
            fut = self._shell_open_pending.pop(session_id, None)
            if fut and not fut.done():
                fut.set_result(msg)

        elif msg_type == "ssh_shell_output":
            session_id = msg.get("session_id", "")
            s = self._shell_sessions.get(session_id)
            if s:
                try:
                    data = base64.b64decode(msg.get("data", ""))
                    on_output = s.get("on_output")
                    if on_output:
                        asyncio.get_running_loop().create_task(on_output(data))
                except Exception as exc:
                    log.warning(f"shell_output deliver hata session={session_id[:8]}: {exc}")

        elif msg_type == "ssh_shell_closed":
            session_id = msg.get("session_id", "")
            s = self._shell_sessions.pop(session_id, None)
            if s:
                on_close = s.get("on_close")
                if on_close:
                    try:
                        asyncio.get_running_loop().create_task(on_close())
                    except Exception:
                        pass

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

    # ── Agent ingest scope enforcement (Faz 7 phase6e, Faz 8 Phase D) ─────────

    async def _devices_in_agent_scope(
        self, db, agent_id: str, device_ids, operation: str = "ingest"
    ) -> set:
        """Of `device_ids`, return the subset whose organization + location
        match the agent's. An agent is bound to exactly one org+location;
        a report referencing a device outside that sandbox is a cross-scope
        write — dropped here with a structured log so the agent cannot
        mutate another location's devices.

        Faz 8 Phase D: delegates to the central app.services.agent_scope
        enforcement module — one implementation shared by the API,
        runtime-handler and command-dispatch layers."""
        from app.services.agent_scope import (
            AgentScopeError, filter_device_ids_in_scope, resolve_agent_scope,
        )
        try:
            scope = await resolve_agent_scope(db, agent_id)
        except AgentScopeError as exc:
            log.warning("agent_manager: %s — %s dropped", exc, operation)
            return set()
        return await filter_device_ids_in_scope(db, scope, device_ids, operation)

    # ── Agent command-dispatch scope enforcement (Faz 8 Phase D) ──────────────

    def _session_scope(self, agent_id: str) -> tuple | None:
        """The (organization_id, location_id) bound to this agent's WS
        session, captured from the agent row at authentication time. The
        agent token thereby fixes the agent's org+location for the life of
        the connection. None when the session predates Phase D."""
        meta = self._meta.get(agent_id) or {}
        org = meta.get("organization_id")
        loc = meta.get("location_id")
        if org is None or loc is None:
            return None
        return (org, loc)

    def _enforce_device_scope(self, agent_id: str, device, operation: str) -> None:
        """Defense-in-depth at the command-dispatch layer: reject a command
        whose target device is outside the agent's session org+location
        sandbox. The API layer is authoritative; this catches any path
        that reaches dispatch unchecked. A scopeless device proxy (the
        internal SSH relay) or a pre-Phase-D session is left to the API
        layer — it cannot be cross-checked here."""
        scope = self._session_scope(agent_id)
        d_org = getattr(device, "organization_id", None)
        d_loc = getattr(device, "location_id", None)
        if scope is None or d_org is None or d_loc is None:
            return
        if (d_org, d_loc) != scope:
            from app.services.agent_scope import AgentScopeError, log_scope_rejection
            log_scope_rejection(
                agent_id=agent_id, device_id=getattr(device, "id", None),
                organization_id=scope[0], location_id=scope[1],
                operation=operation,
                reason=(f"device org/location ({d_org}/{d_loc}) outside "
                        f"agent session sandbox ({scope[0]}/{scope[1]})"),
            )
            # RBAC F11 — Turkish, action-guidance message. The raw English
            # 'Cross-location ssh_command rejected for device 105 — not in
            # the agent's location' confused operators. Tell the user
            # exactly which agent + location pair the device needs.
            raise AgentScopeError(
                f"Cihaz #{getattr(device, 'id', None)} bu agent'ın "
                f"lokasyonunda değil. Atanmış agent farklı bir lokasyona "
                f"bağlı (cihaz: loc={d_loc}, agent oturumu: loc={scope[1]}). "
                f"Doğru lokasyondaki agent atanmalı."
            )

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
                # Faz 7 — drop reports for devices outside the agent's
                # organization + location before any write.
                allowed_ids = await self._devices_in_agent_scope(
                    db, agent_id, [r.get("device_id") for r in results],
                    "device_status_report",
                )
                results = [r for r in results if r.get("device_id") in allowed_ids]
                if not results:
                    return

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

                    # Telemetry-aware status resolution. The agent's own
                    # device_status_report is the primary signal — when
                    # reachable=true we still go straight to ONLINE — but
                    # when reachable=false we now consult the resolver
                    # so a recent SSH/PoE/MAC success can VETO the
                    # OFFLINE write. Without this, a single failed ICMP
                    # probe inside the agent (transient WS blip or
                    # midway-through credential rotate) would mark a
                    # healthy device OFFLINE for the next 5+ minutes.
                    from app.services.device_status_resolver import (
                        get_latest_device_signal_async,
                        resolve_device_status,
                        REASON_AGENT_REPORT,
                    )
                    # Pull the current Device row so the resolver sees
                    # the freshest last_seen + current status.
                    device_row = (await db.execute(
                        select(Device).where(Device.id == device_id)
                    )).scalar_one_or_none()
                    if device_row is None:
                        continue
                    signal = await get_latest_device_signal_async(db, device_id, now=now_utc)
                    resolved = resolve_device_status(
                        device_row, signal,
                        agent_online=True,
                        agent_reachable_report=bool(reachable),
                        icmp_reachable=None,
                        now=now_utc,
                    )
                    new_status = resolved.status
                    values: dict = {"status": new_status}
                    # Only stamp last_seen forward when we are actually
                    # claiming ONLINE. Going to OFFLINE preserves the
                    # last successful timestamp (same as the previous
                    # behaviour).
                    if new_status == DeviceStatus.ONLINE.value:
                        values["last_seen"] = datetime.now(timezone.utc)
                    await db.execute(
                        update(Device).where(Device.id == device_id).values(**values)
                    )
                    # Surface the resolver reason via Redis (no schema
                    # migration). UI / debug can read this side key.
                    try:
                        _redis.setex(
                            f"device:{device_id}:status:reason", 600,
                            resolved.reason,
                        )
                    except Exception:
                        pass
                    # If the resolver overruled the agent's reachable=false
                    # because of fresh telemetry, the row stays ONLINE and
                    # we skip the rest of the event-firing block.
                    if not reachable and new_status == DeviceStatus.ONLINE.value:
                        log.debug(
                            "device %s OFFLINE report vetoed by fresh telemetry (reason=%s)",
                            device_id, resolved.reason,
                        )
                        continue
                    # Convert the resolver's status string back to the
                    # boolean the legacy event-firing block below expects.
                    reachable = new_status == DeviceStatus.ONLINE.value

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
        """
        Faz 6C: publish the syslog event to the Redis Streams event bus
        instead of writing it to the DB inline.

        The old path opened one DB connection per event via make_worker_session
        — under a burst that meant thousands of concurrent connections and pool
        exhaustion (KI-4). Now ingestion is a single XADD (microseconds, no DB);
        the event_consumer service drains the stream in bounded batches.

        If the event bus is unavailable, fall back to a *bounded* direct insert
        (semaphore-capped) so a burst still cannot exhaust the pool.
        """
        payload = {
            "agent_id": agent_id,
            "source_ip": msg.get("source_ip", ""),
            "facility": msg.get("facility", 0),
            "severity": msg.get("severity", 7),
            "message": msg.get("message", ""),
            "received_at": datetime.now(timezone.utc),
        }
        from app.services.event_bus import STREAM_SYSLOG, get_event_bus
        try:
            entry_id = await get_event_bus().publish(STREAM_SYSLOG, payload)
            if entry_id is not None:
                _bump_publish_metric(STREAM_SYSLOG, "ok")
                return  # handed off to the event_consumer
        except Exception as exc:
            log.debug(f"Syslog event bus publish error: {exc}")

        # Fallback — event bus unavailable. Bounded direct insert.
        try:
            from app.services.syslog_ingest import fallback_persist
            ok = await fallback_persist(payload, _get_sync_redis())
            _bump_publish_metric(STREAM_SYSLOG, "fallback" if ok else "error")
        except Exception as exc:
            log.debug(f"Syslog fallback persist error: {exc}")
            _bump_publish_metric(STREAM_SYSLOG, "error")

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

                # Faz 7 — a trap may only be attributed to a device in the
                # agent's own org+location; otherwise drop the device link.
                if device_id is not None:
                    if device_id not in await self._devices_in_agent_scope(
                        db, agent_id, [device_id], "snmp_trap"
                    ):
                        device_id = None

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

            # Publish to Redis event stream for real-time UI updates —
            # org-scoped: derive org from the trap's device_id.
            try:
                from app.core.event_publish import publish_network_event
                publish_network_event({
                    "event_type": f"snmp_trap_{trap_name}",
                    "severity": severity,
                    "title": title,
                    "message": message,
                    "source_ip": source_ip,
                    "agent_id": agent_id,
                    "device_id": device_id,
                }, _get_sync_redis())
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

            from app.models.agent import Agent

            async with make_worker_session()() as db:
                # Device-less event — derive org/location from the agent
                # (Faz 7: organization_id is NOT NULL).
                agent = await db.get(Agent, agent_id)
                evt = NetworkEvent(
                    device_id=None,
                    device_hostname=None,
                    event_type="local_anomaly",
                    severity=msg.get("severity", "warning"),
                    title=title,
                    message=message,
                    details=details,
                    organization_id=agent.organization_id if agent else None,
                    location_id=agent.location_id if agent else None,
                )
                if evt.organization_id is None:
                    log.warning(
                        "agent_manager: local_anomaly from unknown agent %s — skipping",
                        agent_id,
                    )
                    return
                _evt_org = evt.organization_id
                _evt_loc = evt.location_id
                db.add(evt)
                await db.commit()

            # Publish to Redis event stream — org-scoped to the agent's org.
            from app.core.event_publish import publish_network_event
            publish_network_event({
                "event_type": "local_anomaly",
                "severity": "warning",
                "title": title,
                "message": message,
                "agent_id": agent_id,
                "anomaly_type": anomaly_type,
            }, _redis_sync.from_url(_settings.REDIS_URL, decode_responses=True),
               organization_id=_evt_org, location_id=_evt_loc)
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
        # QF-2 (2026-06-03) — timeout audit context. When _send_request raises
        # on agent timeout, write an agent_command_logs row so forensics is not
        # blind. Passed by callers; if any field is None, audit is skipped.
        command_type: str | None = None,
        command: str | None = None,
        device_ip: str | None = None,
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
            duration_ms = int((time.perf_counter() - t0) * 1000)
            self._pending.pop(rid, None)
            if device_id is not None:
                self._update_latency(agent_id, device_id, float(timeout * 1000), success=False)
            # QF-2 — record the failed call in agent_command_logs. command_type
            # is the only literal we accept from the caller; payload's password
            # fields are NEVER passed to _log_command_async (security regression
            # protection — see test_qf2_log_has_no_password).
            if command_type is not None:
                self._log_command_async(
                    agent_id=agent_id, device_id=device_id, device_ip=device_ip,
                    command_type=command_type, command=command,
                    success=False, duration_ms=duration_ms,
                    blocked=False, block_reason=f"timeout_after_{timeout}s",
                    request_id=rid,
                )
            raise RuntimeError(f"Agent {agent_id} did not respond within {timeout}s")
        except Exception:
            self._pending.pop(rid, None)
            raise

    async def _resolve_credentials(self, device) -> tuple[str, str, str]:
        """Incident HF#11 (2026-06-03) — CredentialProfile resolve.

        device.credential_profile_id set ise profile değerleri device alanlarına
        göre önceliklidir (HF#9 sonrası device.ssh_username='' /
        device.ssh_password_enc=encrypt('') olabiliyor; bu boş değerler ile
        execute_ssh_command/execute_ssh_config/test_ssh_connection agent'a
        relay edildiğinde "Authentication failed" üretiyordu).

        Returns:
            (ssh_username, ssh_password_plain, enable_secret_plain)
            — agent payload'ında düz metin olarak kullanılır (mevcut sözleşme).
        """
        from app.core.security import decrypt_credential
        profile_id = getattr(device, "credential_profile_id", None)
        profile = None
        if profile_id:
            try:
                from sqlalchemy import select
                from app.core.database import make_worker_session
                from app.models.credential_profile import CredentialProfile
                async with make_worker_session()() as db:
                    r = await db.execute(
                        select(CredentialProfile).where(CredentialProfile.id == profile_id)
                    )
                    profile = r.scalar_one_or_none()
            except Exception:
                profile = None

        def _pick(attr: str, default=None):
            if profile is not None:
                pv = getattr(profile, attr, None)
                if pv:
                    return pv
            return getattr(device, attr, default)

        ssh_username = _pick("ssh_username", "") or ""
        ssh_password_enc = _pick("ssh_password_enc")
        enable_secret_enc = _pick("enable_secret_enc")

        ssh_password = decrypt_credential(ssh_password_enc) if ssh_password_enc else ""
        enable_secret = decrypt_credential(enable_secret_enc) if enable_secret_enc else ""
        return ssh_username, ssh_password, enable_secret

    async def execute_ssh_command(self, agent_id: str, device, command: str) -> dict:
        from app.core.security import decrypt_credential  # noqa: F401 — vault path için

        self._enforce_device_scope(agent_id, device, "ssh_command")
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
            # Incident HF#12 (2026-06-04) — agent _build_params ALWAYS reads
            # msg["device_ip"] / ssh_port / os_type regardless of vault path.
            # Pre-HF#12 the vault payload omitted these, triggering KeyError
            # 'device_ip' inside _ssh_command on every call; backend then hit
            # _COMMAND_TIMEOUT=90s because the agent thread crashed before
            # sending ssh_result. Add them here so the contract matches.
            payload = {
                "type": "ssh_command",
                "request_id": rid,
                "credential_id": device.id,
                "device_ip": device.ip_address,
                "ssh_port": device.ssh_port or 22,
                "os_type": device.os_type,
                "command": command,
                "command_mode": sec["command_mode"],
                "allowed_commands": sec["allowed_commands"],
            }
        else:
            # HF#11 — credential_profile_id varsa profile resolve; aksi halde device fallback
            _user, _pass, _enable = await self._resolve_credentials(device)
            payload = {
                "type": "ssh_command",
                "request_id": rid,
                "device_ip": device.ip_address,
                "ssh_username": _user,
                "ssh_password": _pass,
                "ssh_port": device.ssh_port or 22,
                "os_type": device.os_type,
                "enable_secret": _enable,
                "command": command,
                "command_mode": sec["command_mode"],
                "allowed_commands": sec["allowed_commands"],
            }
        t0 = time.perf_counter()
        # QF-2 — pass audit context so _send_request logs on timeout
        result = await self._send_request(
            agent_id, payload, device_id=device.id,
            command_type="ssh_command", command=command, device_ip=device.ip_address,
        )
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

        self._enforce_device_scope(agent_id, device, "ssh_config")
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
            # HF#12 — agent _build_params requires device_ip/ssh_port/os_type
            # regardless of vault path. See ssh_command branch for context.
            payload = {
                "type": "ssh_config",
                "request_id": rid,
                "credential_id": device.id,
                "device_ip": device.ip_address,
                "ssh_port": device.ssh_port or 22,
                "os_type": device.os_type,
                "commands": commands,
                "command_mode": sec["command_mode"],
                "allowed_commands": sec["allowed_commands"],
            }
        else:
            # HF#11 — credential_profile_id varsa profile resolve; aksi halde device fallback
            _user, _pass, _enable = await self._resolve_credentials(device)
            payload = {
                "type": "ssh_config",
                "request_id": rid,
                "device_ip": device.ip_address,
                "ssh_username": _user,
                "ssh_password": _pass,
                "ssh_port": device.ssh_port or 22,
                "os_type": device.os_type,
                "enable_secret": _enable,
                "commands": commands,
                "command_mode": sec["command_mode"],
                "allowed_commands": sec["allowed_commands"],
            }
        t0 = time.perf_counter()
        # QF-2 — audit context for timeout path
        _cfg_label = f"config:{len(commands)} komut"
        result = await self._send_request(
            agent_id, payload, device_id=device.id,
            command_type="ssh_config", command=_cfg_label, device_ip=device.ip_address,
        )
        duration_ms = int((time.perf_counter() - t0) * 1000)

        self._log_command_async(
            agent_id=agent_id, device_id=device.id, device_ip=device.ip_address,
            command_type="ssh_config", command=_cfg_label,
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
        # HF#11 — credential_profile_id varsa profile resolve; aksi halde device fallback
        _user, _pass, _enable = await self._resolve_credentials(device)
        rid = uuid.uuid4().hex
        payload = {
            "type": "ssh_test",
            "request_id": rid,
            "device_ip": device.ip_address,
            "ssh_username": _user,
            "ssh_password": _pass,
            "ssh_port": device.ssh_port or 22,
            "os_type": device.os_type,
            "enable_secret": _enable,
            "full_auth": True,
        }
        t0 = time.perf_counter()
        # QF-2 — audit context for timeout path
        result = await self._send_request(
            agent_id, payload, timeout=30, device_id=device.id,
            command_type="ssh_test", command="ssh_test", device_ip=device.ip_address,
        )
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

    async def execute_synthetic_probe(
        self,
        agent_id: str,
        probe_type: str,
        target: str,
        timeout: int = 5,
        **kwargs,
    ) -> dict:
        """
        Ask an agent to run a synthetic probe (icmp/tcp/dns/http).

        Returns {"success": bool, "latency_ms": float|None, "detail": str}.
        Returns success=False, detail="agent offline" when agent not connected —
        caller should NOT correlate this as a device fault.
        """
        ws = self._connections.get(agent_id)
        if not ws:
            return {"success": False, "latency_ms": None, "detail": "agent offline"}

        req_id = uuid.uuid4().hex
        loop   = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[req_id] = fut

        payload = {
            "type":       "synthetic_probe",
            "req_id":     req_id,
            "probe_type": probe_type,
            "target":     target,
            "timeout":    timeout,
            **kwargs,
        }
        try:
            await ws.send_text(json.dumps(payload))
            return await asyncio.wait_for(fut, timeout=timeout + 5)
        except asyncio.TimeoutError:
            return {"success": False, "latency_ms": None, "detail": "probe timeout"}
        except Exception as exc:
            return {"success": False, "latency_ms": None, "detail": str(exc)[:80]}
        finally:
            self._pending.pop(req_id, None)

    # ── Faz 4A: A→B peer latency ─────────────────────────────────────────────

    async def measure_ab_peer_latency(self, db) -> int:
        """
        For every ordered pair (A, B) of currently connected agents that have
        a known last_ip, ask agent A to ICMP-probe agent B's IP via the existing
        execute_synthetic_probe("icmp") protocol.

        Returns the number of (A→B) measurements inserted.
        Silently skips agents with no last_ip or that go offline mid-sweep.
        """
        from datetime import datetime, timezone
        from sqlalchemy import select as _select
        from app.models.agent import Agent
        from app.models.agent_peer_latency import AgentPeerLatency

        online = set(self.online_agent_ids())
        if len(online) < 2:
            return 0

        rows = (
            await db.execute(
                _select(Agent.id, Agent.last_ip).where(
                    Agent.id.in_(online),
                    Agent.last_ip.isnot(None),
                    Agent.is_active == True,
                )
            )
        ).all()

        ip_map: dict[str, str] = {r.id: r.last_ip for r in rows}
        if len(ip_map) < 2:
            return 0

        now = datetime.now(timezone.utc)
        count = 0
        for a_from_id, _from_ip in ip_map.items():
            for a_to_id, a_to_ip in ip_map.items():
                if a_from_id == a_to_id:
                    continue
                result = await self.execute_synthetic_probe(
                    a_from_id, probe_type="icmp", target=a_to_ip, timeout=3,
                )
                db.add(AgentPeerLatency(
                    agent_from=a_from_id,
                    agent_to=a_to_id,
                    target_ip=a_to_ip,
                    latency_ms=result.get("latency_ms"),
                    reachable=result.get("success", False),
                    measured_at=now,
                ))
                count += 1

        await db.commit()
        log.info("A→B peer latency sweep complete — %d pairs measured", count)
        return count

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
        self._enforce_device_scope(agent_id, device, "snmp_get")
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
        self._enforce_device_scope(agent_id, device, "snmp_walk")
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

        self._enforce_device_scope(agent_id, device, "stream_command")
        rid = uuid.uuid4().hex
        meta = self._meta.get(agent_id, {})
        if meta.get("vault_active"):
            # HF#12 — agent _build_params requires device_ip/ssh_port/os_type
            # regardless of vault path. See ssh_command branch for context.
            payload = {
                "type": "ssh_command_stream",
                "request_id": rid,
                "credential_id": device.id,
                "device_ip": device.ip_address,
                "ssh_port": device.ssh_port or 22,
                "os_type": device.os_type,
                "command": command,
            }
        else:
            # HF#11 — credential_profile_id varsa profile resolve
            _user, _pass, _enable = await self._resolve_credentials(device)
            payload = {
                "type": "ssh_command_stream",
                "request_id": rid,
                "device_ip": device.ip_address,
                "ssh_username": _user,
                "ssh_password": _pass,
                "ssh_port": device.ssh_port or 22,
                "os_type": device.os_type,
                "enable_secret": _enable,
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
        # T8.4 hotfix — Faz 8 fail-closed scoping rejected this insert because
        # the worker session has no RLS context and the _scoping.py parent-FK
        # lookup on the `agents` table also reads through RLS (returns 0 rows
        # under an unscoped session). We resolve the agent's org/location
        # ourselves (in-memory meta first, then a super-admin DB lookup for
        # cold-start cases) and stamp the row explicitly.
        try:
            from app.core.database import make_worker_session
            from app.models.agent_command_log import AgentCommandLog

            org_id, loc_id = await self._resolve_agent_scope(agent_id)
            if org_id is None:
                # Agent not in DB (orphaned WS session) — drop the audit row
                # silently; scoping would reject the insert anyway.
                log.debug("Command log dropped: agent %s has no org scope", agent_id)
                return

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
                    organization_id=org_id,
                    location_id=loc_id,
                )
                db.add(entry)
                await db.commit()
        except Exception as e:
            log.debug(f"Command log persist error: {e}")

    async def _resolve_agent_scope(self, agent_id: str) -> tuple[Optional[int], Optional[int]]:
        """Return (organization_id, location_id) for an agent.

        Hot path: the WS-connect handler stamped these into ``self._meta`` on
        accept; no DB round-trip needed. Cold path (worker process / agent
        connected on a different replica): a super-admin DB lookup so RLS
        doesn't hide the agent row from us.
        """
        cached = self._meta.get(agent_id) or {}
        org = cached.get("organization_id")
        loc = cached.get("location_id")
        if org is not None:
            return org, loc

        try:
            from sqlalchemy import text as _sql_text
            from app.core.database import make_worker_session
            async with make_worker_session()() as db:
                await db.execute(_sql_text("SELECT set_config('app.is_super_admin','on',true)"))
                row = (await db.execute(_sql_text(
                    "SELECT organization_id, location_id FROM agents WHERE id = :a"
                ), {"a": agent_id})).first()
            if row is not None:
                # Warm the cache for subsequent log writes on this process.
                self._meta.setdefault(agent_id, {}).update(
                    {"organization_id": row[0], "location_id": row[1]}
                )
                return row[0], row[1]
        except Exception as e:
            log.debug(f"Agent scope resolve failed for {agent_id}: {e}")
        return None, None

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
        # T8.4 hotfix — AgentDeviceLatency is NOT NULL on organization_id /
        # location_id. The worker session has no RLS context; stamp the
        # agent's scope explicitly (cached in _meta from WS connect, with a
        # super-admin DB fallback).
        try:
            from sqlalchemy.dialects.postgresql import insert
            from app.core.database import make_worker_session
            from app.models.agent_latency import AgentDeviceLatency

            org_id, loc_id = await self._resolve_agent_scope(agent_id)
            if org_id is None:
                log.debug("Latency dropped: agent %s has no org scope", agent_id)
                return

            async with make_worker_session()() as db:
                stmt = (
                    insert(AgentDeviceLatency)
                    .values(
                        agent_id=agent_id,
                        device_id=device_id,
                        latency_ms=latency_ms,
                        success=success,
                        measured_at=datetime.now(timezone.utc),
                        organization_id=org_id,
                        location_id=loc_id,
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

    # ── Faz T8.5 — Interactive SSH shell (agent-relay terminal) ──────────────
    # Backend WS endpoint /ws/ssh/{device_id} cihazın atanmış agent'ı
    # üzerinden tunnel açar. Bağlantı ömrü kısa olmayabilir (kullanıcı
    # terminale uzun süre takılı kalabilir); request_id+future modeli sadece
    # ilk handshake (ssh_shell_opened) için kullanılır. Sonraki tüm I/O
    # (input/output/resize) callback bazlı, asenkron forward edilir.

    async def open_shell_session(
        self, agent_id: str, device, cols: int, rows: int,
        on_output, on_close, timeout: float = 20.0,
    ) -> str:
        """Agent üzerinde interaktif SSH shell aç. Döner: session_id.
        Backend WS endpoint on_output(bytes) ve on_close() callback'leri
        sağlar; gelen veri/kapanış olayları bu callback'lere yönlendirilir.

        Yükselen exception'lar:
          - RuntimeError: agent bağlı değil / scope check başarısız
          - TimeoutError: shell open response timeout
          - RuntimeError(error str): agent paramiko exception (cihaz hatası)
        """
        if agent_id not in self._connections:
            raise RuntimeError(f"Agent {agent_id} not connected")

        # Scope check — Faz 8 Phase D ile aynı kural (cihaz agent'a izinli mi?)
        self._enforce_device_scope(agent_id, device, "ssh_shell")

        from app.core.security import decrypt_credential
        session_id = uuid.uuid4().hex

        self._shell_sessions[session_id] = {
            "agent_id":  agent_id,
            "on_output": on_output,
            "on_close":  on_close,
        }
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._shell_open_pending[session_id] = fut

        # HF#11 — credential_profile_id varsa profile resolve
        _user, _pass, _enable = await self._resolve_credentials(device)
        payload = {
            "type": "ssh_shell_open",
            "session_id": session_id,
            "request_id": session_id,  # log korelasyonu için alias
            "device_ip": device.ip_address,
            "ssh_port":  device.ssh_port or 22,
            "ssh_username": _user,
            "ssh_password": _pass,
            "cols": int(cols), "rows": int(rows),
        }

        try:
            await self._connections[agent_id].send_text(json.dumps(payload))
        except Exception as exc:
            self._shell_open_pending.pop(session_id, None)
            self._shell_sessions.pop(session_id, None)
            raise RuntimeError(f"Agent'a shell open mesajı gönderilemedi: {exc}")

        # Open handshake
        try:
            result = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._shell_open_pending.pop(session_id, None)
            self._shell_sessions.pop(session_id, None)
            raise TimeoutError(f"Agent shell open timeout ({int(timeout)}s)")

        if not result.get("success"):
            # Agent reader_task hiç başlamadı; ssh_shell_closed gelmez,
            # callback'i temizle
            self._shell_sessions.pop(session_id, None)
            raise RuntimeError(result.get("error") or "Agent shell open failed")

        return session_id

    async def send_shell_input(self, session_id: str, data: bytes) -> None:
        """Tuşlamaları agent'a forward et. Hata gözükmez (best-effort)."""
        s = self._shell_sessions.get(session_id)
        if not s:
            return
        ws = self._connections.get(s["agent_id"])
        if not ws:
            return
        try:
            await ws.send_text(json.dumps({
                "type": "ssh_shell_input",
                "session_id": session_id,
                "data": base64.b64encode(data).decode("ascii"),
            }))
        except Exception:
            pass

    async def send_shell_resize(self, session_id: str, cols: int, rows: int) -> None:
        """Terminal boyut değişikliği — best-effort."""
        s = self._shell_sessions.get(session_id)
        if not s:
            return
        ws = self._connections.get(s["agent_id"])
        if not ws:
            return
        try:
            await ws.send_text(json.dumps({
                "type": "ssh_shell_resize",
                "session_id": session_id,
                "cols": int(cols), "rows": int(rows),
            }))
        except Exception:
            pass

    async def close_shell_session(self, session_id: str) -> None:
        """Agent'a kapatma sinyali yolla + local state'i temizle. Idempotent."""
        s = self._shell_sessions.pop(session_id, None)
        if not s:
            return
        ws = self._connections.get(s["agent_id"])
        if ws:
            try:
                await ws.send_text(json.dumps({
                    "type": "ssh_shell_close",
                    "session_id": session_id,
                }))
            except Exception:
                pass


agent_manager = AgentManager()
