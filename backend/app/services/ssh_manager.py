import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from netmiko import ConnectHandler, NetmikoAuthenticationException, NetmikoTimeoutException
from netmiko.exceptions import NetmikoBaseException

from app.core.config import settings
from app.core.security import decrypt_credential


@dataclass
class CommandResult:
    device_id: int
    hostname: str
    ip_address: str
    success: bool
    output: str = ""
    error: str = ""
    duration_ms: float = 0.0


@dataclass
class ConnectionEntry:
    connection: ConnectHandler
    last_used: float = field(default_factory=time.time)
    in_use: bool = False


class SSHManager:
    """
    Thread-pool-backed SSH connection manager for Netmiko.
    Maintains per-device connection pool with configurable concurrency limit.
    """

    def __init__(self):
        self._pool: Dict[int, ConnectionEntry] = {}
        self._locks: Dict[int, asyncio.Lock] = {}
        self._semaphore = asyncio.Semaphore(settings.SSH_MAX_CONCURRENT)
        self._executor = ThreadPoolExecutor(max_workers=settings.SSH_MAX_CONCURRENT)
        self._pool_lock = asyncio.Lock()

    def _get_device_lock(self, device_id: int) -> asyncio.Lock:
        if device_id not in self._locks:
            self._locks[device_id] = asyncio.Lock()
        return self._locks[device_id]

    def _build_netmiko_params(self, device, profile=None) -> dict:
        # Use credential profile if provided, otherwise fall back to device-level fields
        src = profile if profile is not None else device
        password_enc = src.ssh_password_enc if src.ssh_password_enc else device.ssh_password_enc
        username = src.ssh_username if src.ssh_username else device.ssh_username
        port = (src.ssh_port if src.ssh_port else device.ssh_port) or 22
        enable_enc = src.enable_secret_enc if src.enable_secret_enc else device.enable_secret_enc

        os_type = device.os_type or "generic"
        # Some embedded/generic devices have non-standard SSH auth (returns allowed_types=['']);
        # paramiko needs look_for_keys=False + allow_agent=False to avoid confusing them.
        # Also, generic devices often work better with linux driver (handles keyboard-interactive).
        effective_type = "linux" if os_type == "generic" else os_type
        params = {
            "device_type": effective_type,
            "host": device.ip_address,
            "username": username,
            "password": decrypt_credential(password_enc),
            "port": port,
            "timeout": settings.SSH_CONNECT_TIMEOUT,
            "auth_timeout": 30,
            "session_timeout": settings.SSH_COMMAND_TIMEOUT,
            "banner_timeout": 30,
            "blocking_timeout": 40,
            "fast_cli": False,
            "global_delay_factor": 3,
            "use_keys": False,
            "allow_agent": False,
        }
        if enable_enc:
            params["secret"] = decrypt_credential(enable_enc)
        return params

    def _connect_sync(self, device, profile=None) -> ConnectHandler:
        params = self._build_netmiko_params(device, profile)
        conn = ConnectHandler(**params)
        enable_enc = (profile.enable_secret_enc if profile else None) or device.enable_secret_enc
        if enable_enc:
            try:
                conn.enable()
            except Exception:
                pass
        return conn

    def _is_alive(self, entry: ConnectionEntry) -> bool:
        try:
            return entry.connection.is_alive()
        except Exception:
            return False

    async def _load_profile(self, device):
        """Load credential profile from DB if device has one assigned."""
        profile_id = getattr(device, "credential_profile_id", None)
        if not profile_id:
            return None
        try:
            from sqlalchemy import select
            from app.core.database import make_worker_session
            from app.models.credential_profile import CredentialProfile
            async with make_worker_session()() as db:
                r = await db.execute(select(CredentialProfile).where(CredentialProfile.id == profile_id))
                return r.scalar_one_or_none()
        except Exception:
            return None

    async def _get_connection(self, device) -> ConnectHandler:
        loop = asyncio.get_running_loop()
        device_lock = self._get_device_lock(device.id)

        async with device_lock:
            entry = self._pool.get(device.id)
            if entry and self._is_alive(entry):
                entry.last_used = time.time()
                return entry.connection

            # Close stale connection if exists
            if entry:
                try:
                    await loop.run_in_executor(self._executor, entry.connection.disconnect)
                except Exception:
                    pass

            profile = await self._load_profile(device)
            conn = await loop.run_in_executor(
                self._executor, lambda: self._connect_sync(device, profile)
            )
            self._pool[device.id] = ConnectionEntry(connection=conn)
            return conn

    def _via_agent(self, device) -> Optional[str]:
        """Return the lowest-latency online agent for this device.
        Considers primary agent + fallback_agent_ids; sorts online candidates
        by measured SSH latency (EMA). Falls back to direct SSH if none online."""
        from app.services.agent_manager import agent_manager

        candidates = []
        primary = getattr(device, "agent_id", None)
        if primary:
            candidates.append(primary)

        fallbacks = getattr(device, "fallback_agent_ids", None) or []
        candidates.extend(f for f in fallbacks if f and f != primary)

        online = [aid for aid in candidates if agent_manager.is_online(aid)]
        if not online:
            return None

        # Sort by measured latency ascending; unknown latency → infinity (try last)
        online.sort(key=lambda aid: agent_manager.get_latency(aid, device.id) or float("inf"))
        return online[0]

    def _relay_payload(self, device) -> dict:
        return {
            "device_id": device.id,
            "hostname": getattr(device, "hostname", ""),
            "ip_address": device.ip_address,
            "ssh_username": getattr(device, "ssh_username", None),
            "ssh_password_enc": getattr(device, "ssh_password_enc", None),
            "ssh_port": getattr(device, "ssh_port", None) or 22,
            "os_type": getattr(device, "os_type", None) or "cisco_ios",
            "enable_secret_enc": getattr(device, "enable_secret_enc", None),
            "credential_profile_id": getattr(device, "credential_profile_id", None),
        }

    def _relay_ssh(self, agent_id: str, device, command: str) -> CommandResult:
        """Relay SSH command via FastAPI backend HTTP endpoint (used by Celery workers)."""
        import requests as _req
        payload = {"agent_id": agent_id, "command": command, **self._relay_payload(device)}
        try:
            resp = _req.post(
                "http://backend:8000/api/v1/internal/agent-relay",
                json=payload,
                headers={"X-Internal-Key": settings.SECRET_KEY},
                timeout=120,
            )
            data = resp.json()
            return CommandResult(
                device_id=device.id, hostname=getattr(device, "hostname", ""),
                ip_address=device.ip_address,
                success=data.get("success", False),
                output=data.get("output", ""),
                error=data.get("error", ""),
                duration_ms=data.get("duration_ms", 0),
            )
        except Exception as e:
            return CommandResult(
                device_id=device.id, hostname=getattr(device, "hostname", ""),
                ip_address=device.ip_address, success=False, error=f"Relay error: {e}",
            )

    def _relay_config(self, agent_id: str, device, commands: list) -> CommandResult:
        """Relay config commands via FastAPI backend HTTP endpoint (used by Celery workers)."""
        import requests as _req
        payload = {"agent_id": agent_id, "commands": commands, **self._relay_payload(device)}
        try:
            resp = _req.post(
                "http://backend:8000/api/v1/internal/agent-relay-config",
                json=payload,
                headers={"X-Internal-Key": settings.SECRET_KEY},
                timeout=120,
            )
            data = resp.json()
            return CommandResult(
                device_id=device.id, hostname=getattr(device, "hostname", ""),
                ip_address=device.ip_address,
                success=data.get("success", False),
                output=data.get("output", ""),
                error=data.get("error", ""),
                duration_ms=data.get("duration_ms", 0),
            )
        except Exception as e:
            return CommandResult(
                device_id=device.id, hostname=getattr(device, "hostname", ""),
                ip_address=device.ip_address, success=False, error=f"Relay error: {e}",
            )

    def _agent_result(self, device, res: dict) -> CommandResult:
        return CommandResult(
            device_id=device.id,
            hostname=device.hostname,
            ip_address=device.ip_address,
            success=res.get("success", False),
            output=res.get("output", ""),
            error=res.get("error", ""),
            duration_ms=res.get("duration_ms", 0.0),
        )

    async def test_connection(self, device) -> CommandResult:
        agent_id = self._via_agent(device)
        if agent_id:
            from app.services.agent_manager import agent_manager
            try:
                res = await agent_manager.test_ssh_connection(agent_id, device)
                return self._agent_result(device, res)
            except Exception as e:
                return CommandResult(device_id=device.id, hostname=device.hostname,
                                     ip_address=device.ip_address, success=False, error=str(e))

        start = time.time()
        try:
            conn = await self._get_connection(device)
            duration = (time.time() - start) * 1000
            return CommandResult(
                device_id=device.id,
                hostname=device.hostname,
                ip_address=device.ip_address,
                success=True,
                output="Connection successful",
                duration_ms=round(duration, 2),
            )
        except NetmikoAuthenticationException as e:
            return CommandResult(
                device_id=device.id, hostname=device.hostname, ip_address=device.ip_address,
                success=False, error=f"Authentication failed: {e}",
            )
        except NetmikoTimeoutException as e:
            return CommandResult(
                device_id=device.id, hostname=device.hostname, ip_address=device.ip_address,
                success=False, error=f"Connection timeout: {e}",
            )
        except Exception as e:
            return CommandResult(
                device_id=device.id, hostname=device.hostname, ip_address=device.ip_address,
                success=False, error=str(e),
            )

    async def execute_command(self, device, command: str, use_textfsm: bool = False, read_timeout: int = 120) -> CommandResult:
        agent_id = self._via_agent(device)
        if agent_id:
            from app.services.agent_manager import agent_manager
            if agent_id in agent_manager._connections:
                # FastAPI process: direct WebSocket call
                try:
                    res = await agent_manager.execute_ssh_command(agent_id, device, command)
                    return self._agent_result(device, res)
                except Exception as e:
                    return CommandResult(device_id=device.id, hostname=device.hostname,
                                         ip_address=device.ip_address, success=False, error=str(e))
            else:
                # Celery worker: relay via backend HTTP endpoint
                return self._relay_ssh(agent_id, device, command)

        loop = asyncio.get_running_loop()
        start = time.time()
        async with self._semaphore:
            try:
                conn = await self._get_connection(device)

                def _run():
                    if use_textfsm:
                        return conn.send_command(command, use_textfsm=True, read_timeout=read_timeout)
                    return conn.send_command(command, read_timeout=read_timeout)

                output = await loop.run_in_executor(self._executor, _run)
                duration = (time.time() - start) * 1000
                return CommandResult(
                    device_id=device.id, hostname=device.hostname, ip_address=device.ip_address,
                    success=True, output=str(output), duration_ms=round(duration, 2),
                )
            except Exception as e:
                self._pool.pop(device.id, None)
                return CommandResult(
                    device_id=device.id, hostname=device.hostname, ip_address=device.ip_address,
                    success=False, error=str(e),
                )

    async def send_config(self, device, config_commands: List[str]) -> CommandResult:
        agent_id = self._via_agent(device)
        if agent_id:
            from app.services.agent_manager import agent_manager
            if agent_id in agent_manager._connections:
                # FastAPI process: direct WebSocket call
                try:
                    res = await agent_manager.execute_ssh_config(agent_id, device, config_commands)
                    return self._agent_result(device, res)
                except Exception as e:
                    return CommandResult(device_id=device.id, hostname=device.hostname,
                                         ip_address=device.ip_address, success=False, error=str(e))
            else:
                # Celery worker: relay via backend HTTP endpoint
                return self._relay_config(agent_id, device, config_commands)

        loop = asyncio.get_running_loop()
        start = time.time()
        async with self._semaphore:
            try:
                conn = await self._get_connection(device)
                output = await loop.run_in_executor(
                    self._executor,
                    lambda: conn.send_config_set(config_commands),
                )
                await loop.run_in_executor(
                    self._executor,
                    lambda: conn.save_config(),
                )
                duration = (time.time() - start) * 1000
                return CommandResult(
                    device_id=device.id, hostname=device.hostname, ip_address=device.ip_address,
                    success=True, output=output, duration_ms=round(duration, 2),
                )
            except Exception as e:
                self._pool.pop(device.id, None)
                return CommandResult(
                    device_id=device.id, hostname=device.hostname, ip_address=device.ip_address,
                    success=False, error=str(e),
                )

    async def get_running_config(self, device) -> CommandResult:
        vendor = getattr(device, "vendor", "other")
        if vendor == "ruijie":
            cmd = "show running-config"
        elif vendor == "aruba":
            cmd = "show running-config"
        else:
            cmd = "show running-config"
        return await self.execute_command(device, cmd)

    async def execute_bulk(
        self,
        devices: list,
        command: str,
        is_config: bool = False,
        progress_cb=None,
    ) -> List[CommandResult]:
        async def _single(device):
            if is_config:
                result = await self.send_config(device, [command])
            else:
                result = await self.execute_command(device, command)
            if progress_cb:
                await progress_cb(result)
            return result

        tasks = [_single(d) for d in devices]
        return await asyncio.gather(*tasks, return_exceptions=False)

    async def close_device(self, device_id: int) -> None:
        loop = asyncio.get_running_loop()
        entry = self._pool.pop(device_id, None)
        if entry:
            try:
                await loop.run_in_executor(self._executor, entry.connection.disconnect)
            except Exception:
                pass

    async def close_all(self) -> None:
        loop = asyncio.get_running_loop()
        device_ids = list(self._pool.keys())
        for did in device_ids:
            await self.close_device(did)


# Global singleton
ssh_manager = SSHManager()
