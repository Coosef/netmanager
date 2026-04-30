import asyncio
import socket
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device

router = APIRouter()


class DiagRequest(BaseModel):
    type: Literal["ping", "traceroute", "dns", "port_check"]
    target: str = Field(..., description="Target IP or hostname")
    source: Literal["server", "device"] = "server"
    device_id: Optional[int] = None
    count: int = Field(4, ge=1, le=20)
    port: Optional[int] = Field(None, ge=1, le=65535)
    timeout: int = Field(5, ge=1, le=30)


async def _run_subprocess(cmd: list[str], timeout: int = 30) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
            return proc.returncode or 0, stdout.decode("utf-8", errors="replace")
        except asyncio.TimeoutError:
            proc.kill()
            return 1, f"Zaman aşımı ({timeout}s)"
    except FileNotFoundError as e:
        return 1, f"Komut bulunamadı: {e}"


def _find_cmd(*names: str) -> str:
    import shutil
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    return names[0]


async def _ping_server(target: str, count: int, timeout: int) -> dict:
    import platform
    sys_platform = platform.system().lower()
    ping_bin = _find_cmd("ping")
    if sys_platform == "windows":
        cmd = [ping_bin, "-n", str(count), "-w", str(timeout * 1000), target]
    else:
        cmd = [ping_bin, "-c", str(count), "-W", str(timeout), target]

    rc, output = await _run_subprocess(cmd, timeout=timeout * count + 10)
    lines = output.strip().splitlines()

    # Parse summary: packet loss + rtt
    loss_pct: Optional[float] = None
    rtt_avg: Optional[float] = None
    for line in lines:
        ll = line.lower()
        if "packet loss" in ll or "kayıp" in ll or "loss" in ll:
            for part in ll.split(","):
                if "%" in part:
                    try:
                        loss_pct = float("".join(c for c in part if c.isdigit() or c == "."))
                    except ValueError:
                        pass
        if "rtt" in ll or "round-trip" in ll or "avg" in ll:
            parts = line.split("/")
            if len(parts) >= 4:
                try:
                    rtt_avg = float(parts[4])
                except (ValueError, IndexError):
                    pass

    return {
        "success": rc == 0,
        "output": output,
        "packet_loss_pct": loss_pct,
        "rtt_avg_ms": rtt_avg,
    }


async def _traceroute_server(target: str, timeout: int) -> dict:
    import platform
    # Clamp per-hop timeout: 1–3s; max 20 hops → worst case ~60s total
    per_hop = max(1, min(timeout, 3))
    max_hops = 20
    sys_platform = platform.system().lower()
    if sys_platform == "windows":
        tracert_bin = _find_cmd("tracert")
        cmd = [tracert_bin, "-d", "-h", str(max_hops), "-w", str(per_hop * 1000), target]
    else:
        trace_bin = _find_cmd("traceroute", "tracepath")
        cmd = [trace_bin, "-n", "-w", str(per_hop), "-m", str(max_hops), target]

    total_timeout = per_hop * max_hops * 3 + 10  # 3 probes per hop
    rc, output = await _run_subprocess(cmd, timeout=total_timeout)
    return {"success": rc == 0, "output": output}


async def _dns_server(target: str) -> dict:
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, lambda: socket.getaddrinfo(target, None)
        )
        ips = list({r[4][0] for r in result})
        try:
            hostname = socket.gethostbyaddr(target)[0]
        except Exception:
            hostname = None

        # Also run nslookup for richer output
        nslookup_bin = _find_cmd("nslookup", "host", "dig")
        rc, nsl_out = await _run_subprocess([nslookup_bin, target], timeout=10)
        output = nsl_out if rc == 0 else f"Çözümlenen IP'ler: {', '.join(ips)}" + (f"\nTers DNS: {hostname}" if hostname else "")

        return {
            "success": True,
            "output": output,
            "resolved_ips": ips,
            "reverse_hostname": hostname,
        }
    except socket.gaierror as e:
        return {"success": False, "output": f"DNS çözümlenemedi: {e}", "resolved_ips": [], "reverse_hostname": None}


async def _port_check_server(target: str, port: int, timeout: int) -> dict:
    try:
        loop = asyncio.get_event_loop()
        conn = asyncio.open_connection(target, port)
        reader, writer = await asyncio.wait_for(conn, timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return {"success": True, "output": f"Port {port} açık — bağlantı başarılı"}
    except asyncio.TimeoutError:
        return {"success": False, "output": f"Port {port} zaman aşımı ({timeout}s)"}
    except ConnectionRefusedError:
        return {"success": False, "output": f"Port {port} kapalı (bağlantı reddedildi)"}
    except Exception as e:
        return {"success": False, "output": f"Port {port} hatası: {e}"}


# ── Device-side commands via SSH ────────────────────────────────────────────

# Ruijie IOS — uses Linux-style ping syntax
_RUIJIE_CMDS: dict[str, str] = {
    "ping":       "ping {target}",          # default count (5); -c not supported
    "traceroute": "traceroute {target}",
    "dns":        "ping {target}",           # no nslookup; ping resolves and shows IP
}

# Cisco IOS
_CISCO_CMDS: dict[str, str] = {
    "ping":       "ping {target} repeat {count}",
    "traceroute": "traceroute {target}",
    "dns":        "ping {target}",           # nslookup unreliable on IOS
}

# port_check is intentionally absent — not supportable via SSH (telnet hangs)
_UNSUPPORTED_DEVICE = {"port_check"}

# Long-running commands need more read_timeout
_LONG_CMDS = {"traceroute"}


async def _diag_via_device(device: Device, req: DiagRequest) -> dict:
    from app.services.ssh_manager import ssh_manager

    if req.type in _UNSUPPORTED_DEVICE:
        return {
            "success": False,
            "output": "Port kontrolü cihaz üzerinden desteklenmiyor.\nLütfen kaynak olarak 'Sunucu' seçin.",
        }

    vendor = (device.vendor or "").lower()
    templates = _RUIJIE_CMDS if vendor == "ruijie" else _CISCO_CMDS
    tpl = templates.get(req.type)

    if not tpl:
        return {"success": False, "output": f"Bu cihaz türü için {req.type} desteklenmiyor"}

    cmd = tpl.format(target=req.target, count=req.count, port=req.port or 22)

    # Traceroute can take 60–120 s; use extended read_timeout
    read_timeout = 120 if req.type in _LONG_CMDS else 60

    _DEVICE_ERROR_MARKERS = (
        "% invalid input",
        "% unknown command",
        "% ambiguous command",
        "error: command not found",
        "invalid command",
    )

    try:
        result = await asyncio.wait_for(
            ssh_manager.execute_command(device, cmd, read_timeout=read_timeout),
            timeout=read_timeout + 15,
        )
        output = result.output or result.error or ""
        # Mark as failed if device returned a CLI error
        is_success = result.success and not any(
            m in output.lower() for m in _DEVICE_ERROR_MARKERS
        )
        return {"success": is_success, "output": output}
    except asyncio.TimeoutError:
        return {"success": False, "output": f"SSH zaman aşımı ({read_timeout + 15}s)"}
    except Exception as e:
        return {"success": False, "output": f"SSH hatası: {e}"}


# ── Endpoint ─────────────────────────────────────────────────────────────────

@router.post("/run")
async def run_diagnostic(
    req: DiagRequest,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    if not req.target.strip():
        raise HTTPException(400, "Hedef IP/hostname boş olamaz")
    if req.type == "port_check" and not req.port:
        raise HTTPException(400, "port_check için port numarası gerekli")

    started_at = datetime.now(timezone.utc)
    result: dict

    if req.source == "device":
        if not req.device_id:
            raise HTTPException(400, "Cihaz kaynağı için device_id gerekli")
        dev_result = await db.execute(
            select(Device).where(Device.id == req.device_id, Device.is_active == True)
        )
        device = dev_result.scalar_one_or_none()
        if not device:
            raise HTTPException(404, "Cihaz bulunamadı")
        result = await _diag_via_device(device, req)
        source_label = f"{device.hostname} ({device.ip_address})"
    else:
        if req.type == "ping":
            result = await _ping_server(req.target, req.count, req.timeout)
        elif req.type == "traceroute":
            result = await _traceroute_server(req.target, req.timeout)
        elif req.type == "dns":
            result = await _dns_server(req.target)
        else:
            result = await _port_check_server(req.target, req.port, req.timeout)
        source_label = "Backend Sunucu"

    duration_ms = round((datetime.now(timezone.utc) - started_at).total_seconds() * 1000)

    return {
        "type": req.type,
        "target": req.target,
        "source": req.source,
        "source_label": source_label,
        "success": result.get("success", False),
        "output": result.get("output", ""),
        "extra": {k: v for k, v in result.items() if k not in ("success", "output")},
        "duration_ms": duration_ms,
        "ran_at": started_at.isoformat(),
    }


@router.get("/history")
async def diag_history(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Placeholder — diagnostics are stateless; no history stored."""
    return {"items": [], "total": 0}
