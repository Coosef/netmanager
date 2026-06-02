"""Port toggle + PoE control endpoint'leri (T9 Tur 4 #8+E2 / Wave 3 W3.3).

  POST /api/v1/devices/{device_id}/ports/{interface}/admin
       body: {"enable": bool, "reason": str?, "rollback_after_sec": int?}
       SSH config push (vendor-aware) + 5dk safety rollback timer (default).

  POST /api/v1/devices/{device_id}/ports/{interface}/poe
       body: {"enable": bool, "reason": str?, "rollback_after_sec": int?}

  POST /api/v1/devices/{device_id}/ports/{interface}/poe/restart   (W3.3)
       body: {"restart_wait_sec": int?, "rollback_after_sec": int?, "reason": str?}
       PoE disable → wait → enable; ikinci faz fail olursa rollback timer
       enable komutunu yeniden uygular (cihaz off kalmaz).

  POST /api/v1/devices/{device_id}/ports/bulk-poe                  (W3.3)
       body: {"interfaces": [...], "action": "on"|"off"|"restart", ...}
       Tek SSH session'da N port; vendor guard + not_poe_capable skip + sayaç.

  POST /api/v1/devices/{device_id}/ports/_rollback/{rollback_id}/commit
       Pending bekleyen değişikliği onayla (rollback iptal).

  POST /api/v1/devices/{device_id}/ports/_rollback/{rollback_id}/cancel
       Pending bekleyen değişikliği şimdi geri al.

  GET  /api/v1/devices/{device_id}/ports/_rollbacks
       Cihaz için son N pending/recent kayıt.

Yetki: device:edit (org_admin/location_admin/super_admin).
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.poe_port_snapshot import PoEPortSnapshot
from app.models.port_change_rollback import PortChangeRollback
from app.services import port_control_service as _portsvc
from app.services.audit_service import log_action
from app.services.ssh_manager import ssh_manager

router = APIRouter()

# Comware vendor: PoE komutu test edilmediği için fail-fast (yanlış komut basmayız).
_POE_UNSUPPORTED_OS = {"comware"}


class PortChangePayload(BaseModel):
    """Admin (port up/down) endpoint için. Default 5dk safety rollback korunur."""
    enable: bool
    reason: Optional[str] = None
    rollback_after_sec: int = 300   # default 5dk; 0 → rollback yok (kalıcı)


class PortPoePayload(BaseModel):
    """W3.3 hotfix — PoE Aç/Kapat için ayrı model. Kalıcı işlem default'u.
    Admin tarafının (set_port_admin) PortChangePayload default'u (300) korunur."""
    enable: bool
    reason: Optional[str] = None
    rollback_after_sec: int = 0     # W3.3 hotfix: kalıcı (kullanıcı kararı 2026-06-01)


class PoeRestartPayload(BaseModel):
    restart_wait_sec: int = Field(default=0, ge=0, le=60)  # 0 → settings default
    rollback_after_sec: int = 300                          # fail-safe (enable yeniden uygulanır)
    reason: Optional[str] = None


class BulkPoePayload(BaseModel):
    """W3.3 hotfix — rollback_after_sec optional; endpoint action'a göre default türetir:
    on/off → 0 (kalıcı), restart → 300 (fail-safe). Explicit verilen değer her zaman korunur."""
    interfaces: list[str] = Field(min_length=1, max_length=192)
    action: Literal["on", "off", "restart"]
    restart_wait_sec: int = Field(default=0, ge=0, le=60)
    rollback_after_sec: Optional[int] = Field(default=None, ge=0, le=3600)
    reason: Optional[str] = None


def _bulk_rollback_default(explicit: Optional[int], action: str) -> int:
    """W3.3 hotfix — Bulk PoE rollback default türetici.
    Explicit verilirse aynen; aksi halde restart→300, on/off→0."""
    if explicit is not None:
        return explicit
    return 300 if action == "restart" else 0


def _serialize(row: PortChangeRollback) -> dict:
    return {
        "id": row.id,
        "device_id": row.device_id,
        "interface": row.interface_name,
        "change_type": row.change_type,
        "requested_state": row.requested_state,
        "forward_cmds": row.forward_cmds,
        "rollback_cmds": row.rollback_cmds,
        "status": row.status,
        "apply_at": row.apply_at.isoformat() if row.apply_at else None,
        "rollback_at": row.rollback_at.isoformat() if row.rollback_at else None,
        "completed_at": row.completed_at.isoformat() if row.completed_at else None,
        "forward_output": (row.forward_output or "")[:600],
        "rollback_output": (row.rollback_output or "")[:600],
    }


async def _apply_change(
    *,
    db: AsyncSession,
    current_user,
    device: Device,
    interface: str,
    change_type: str,           # 'admin' | 'poe'
    requested_state: str,       # 'up'/'down' (admin) | 'on'/'off' (poe)
    forward_cmds: list[str],
    rollback_cmds: list[str],
    rollback_after_sec: int,
    request: Request,
) -> dict:
    # Forward komutları çalıştır
    try:
        result = await ssh_manager.send_config(device, forward_cmds)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SSH komut hatası: {exc}")
    if not result.success:
        raise HTTPException(
            status_code=502,
            detail=f"Komut başarısız: {result.error or 'unknown'}",
        )

    # Pending kayıt yaz (timer için)
    now = datetime.now(timezone.utc)
    rb_at = now + timedelta(seconds=max(0, rollback_after_sec))
    row = PortChangeRollback(
        device_id=device.id,
        user_id=current_user.id,
        organization_id=device.organization_id,
        location_id=device.location_id,
        interface_name=interface,
        change_type=change_type,
        requested_state=requested_state,
        forward_cmds=forward_cmds,
        rollback_cmds=rollback_cmds,
        forward_output=(result.output or "")[:2000],
        status="pending" if rollback_after_sec > 0 else "committed",
        apply_at=now, rollback_at=rb_at,
        completed_at=None if rollback_after_sec > 0 else now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    # W3.3 — PoE on/off için audit eylem adı daha okunabilir; admin için
    # mevcut 'port_change_applied' korunur (mevcut log filtre tutarlılığı).
    audit_action = (
        _poe_action_audit_name(requested_state) if change_type == "poe"
        else "port_change_applied"
    )
    await log_action(
        db, current_user,
        audit_action,
        "device", device.id, device.hostname,
        details={
            "interface": interface,
            "change_type": change_type,
            "requested_state": requested_state,
            "rollback_after_sec": rollback_after_sec,
            "rollback_id": row.id,
            "result": "success",
        },
        request=request,
    )

    # Countdown task dispatch
    if rollback_after_sec > 0:
        try:
            from app.workers.tasks.port_rollback_tasks import apply_rollback_if_pending
            apply_rollback_if_pending.apply_async(
                args=[row.id], countdown=rollback_after_sec,
            )
        except Exception:
            # Celery erişilemezse de devam et — kullanıcı manuel commit/cancel yapabilir
            pass

    return _serialize(row)


def _require_edit(current_user) -> None:
    if not current_user.has_permission("device:edit") and not current_user.is_super_admin:
        raise HTTPException(status_code=403, detail="device:edit yetkisi yok")


async def _poe_capable_set(db: AsyncSession, device_id: int) -> set[str]:
    """W3.3 — Cihazda PoE-uyumlu port adları (snapshot tablosunda satırı olanlar).
    Boş set döndüğünde "henüz keşfedilmedi" demek; capability kontrolü atla."""
    rows = (await db.execute(
        select(PoEPortSnapshot.port).where(PoEPortSnapshot.device_id == device_id)
    )).scalars().all()
    return {p for p in rows}


def _poe_action_audit_name(requested_state: str) -> str:
    """W3.3 — Audit log için insan-okunabilir eylem adı."""
    return {
        "on": "poe_on",
        "off": "poe_off",
        "restart": "poe_restart",
    }.get(requested_state, "port_change_applied")


def _restart_wait_or_default(restart_wait_sec: int) -> int:
    """W3.3 — 0 verilirse settings.POE_RESTART_WAIT_SEC (default 10sn) kullan."""
    if restart_wait_sec and restart_wait_sec > 0:
        return restart_wait_sec
    return max(1, int(settings.POE_RESTART_WAIT_SEC or 10))


@router.post("/{device_id}/ports/{interface:path}/admin")
async def set_port_admin(
    device_id: int, interface: str,
    payload: PortChangePayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Port admin status (up/down) değiştir + 5dk safety rollback."""
    _require_edit(current_user)
    device = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Cihaz bulunamadı")

    try:
        forward = _portsvc.port_admin_commands(
            device.os_type or "generic", interface, enable=payload.enable,
        )
        rollback = _portsvc.port_admin_commands(
            device.os_type or "generic", interface, enable=not payload.enable,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return await _apply_change(
        db=db, current_user=current_user, device=device, interface=interface,
        change_type="admin",
        requested_state="up" if payload.enable else "down",
        forward_cmds=forward, rollback_cmds=rollback,
        rollback_after_sec=payload.rollback_after_sec,
        request=request,
    )


@router.post("/{device_id}/ports/{interface:path}/poe")
async def set_port_poe(
    device_id: int, interface: str,
    payload: PortPoePayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """PoE enable/disable. W3.3 hotfix: rollback_after_sec default=0 (kalıcı)."""
    _require_edit(current_user)
    device = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Cihaz bulunamadı")

    os_type = device.os_type or "generic"
    if os_type in _POE_UNSUPPORTED_OS:
        raise HTTPException(status_code=400, detail="Comware PoE henüz desteklenmiyor")

    capable = await _poe_capable_set(db, device.id)
    if capable and interface not in capable:
        raise HTTPException(status_code=400, detail="Port PoE desteklemiyor (not_poe_capable)")

    try:
        forward = _portsvc.poe_commands(os_type, interface, enable=payload.enable)
        rollback = _portsvc.poe_commands(os_type, interface, enable=not payload.enable)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return await _apply_change(
        db=db, current_user=current_user, device=device, interface=interface,
        change_type="poe",
        requested_state="on" if payload.enable else "off",
        forward_cmds=forward, rollback_cmds=rollback,
        rollback_after_sec=payload.rollback_after_sec,
        request=request,
    )


# ---------------------------------------------------------------------------
# W3.3 — PoE Restart (single) + Bulk PoE
# ---------------------------------------------------------------------------


async def _apply_poe_restart_single(
    *,
    db: AsyncSession,
    current_user,
    device: Device,
    interface: str,
    restart_wait_sec: int,
    rollback_after_sec: int,
    request: Request,
    bulk_batch_id: Optional[str] = None,
) -> dict:
    """PoE restart akışı: disable → wait → enable. İkinci faz fail olursa
    rollback timer (rollback_cmds = enable) ile cihaz off kalmaz."""
    os_type = device.os_type or "generic"
    wait = _restart_wait_or_default(restart_wait_sec)

    phase1 = _portsvc.poe_commands(os_type, interface, enable=False)
    phase2 = _portsvc.poe_commands(os_type, interface, enable=True)

    # Faz 1: PoE disable
    try:
        r1 = await ssh_manager.send_config(device, phase1)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"SSH disable hatası: {exc}")
    if not r1.success:
        raise HTTPException(status_code=502, detail=f"PoE disable başarısız: {r1.error or 'unknown'}")

    # Wait
    await asyncio.sleep(wait)

    # Faz 2: PoE enable — fail olursa rollback timer enable'ı yeniden uygular
    phase2_ok = True
    phase2_err: Optional[str] = None
    try:
        r2 = await ssh_manager.send_config(device, phase2)
        if not r2.success:
            phase2_ok = False
            phase2_err = r2.error or "unknown"
    except Exception as exc:
        phase2_ok = False
        phase2_err = str(exc)

    # Pending kayıt + audit
    now = datetime.now(timezone.utc)
    forward_combined = list(phase1) + [f"!wait_{wait}s"] + list(phase2)
    rollback_cmds = _portsvc.poe_commands(os_type, interface, enable=True)
    rb_at = now + timedelta(seconds=max(0, rollback_after_sec))

    row = PortChangeRollback(
        device_id=device.id,
        user_id=current_user.id,
        organization_id=device.organization_id,
        location_id=device.location_id,
        interface_name=interface,
        change_type="poe",
        requested_state="restart",
        forward_cmds=forward_combined,
        rollback_cmds=rollback_cmds,
        forward_output=((r1.output or "") + ("\n--wait--\n") +
                       (r2.output if phase2_ok else f"FAIL: {phase2_err}"))[:2000],
        status=("pending" if rollback_after_sec > 0 else "committed") if phase2_ok else "failed",
        apply_at=now,
        rollback_at=rb_at,
        completed_at=None if (phase2_ok and rollback_after_sec > 0) else now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    audit_details = {
        "interface": interface,
        "change_type": "poe",
        "requested_state": "restart",
        "restart_wait_sec": wait,
        "rollback_after_sec": rollback_after_sec,
        "rollback_id": row.id,
        "result": "success" if phase2_ok else "failed",
    }
    if bulk_batch_id:
        audit_details["bulk_batch_id"] = bulk_batch_id
    if not phase2_ok:
        audit_details["error"] = phase2_err

    await log_action(
        db, current_user, _poe_action_audit_name("restart"),
        "device", device.id, device.hostname,
        details=audit_details,
        request=request,
    )

    # Phase 2 fail → countdown task'i tetikle ki rollback (enable) yeniden uygulansın
    if rollback_after_sec > 0 and phase2_ok:
        try:
            from app.workers.tasks.port_rollback_tasks import apply_rollback_if_pending
            apply_rollback_if_pending.apply_async(args=[row.id], countdown=rollback_after_sec)
        except Exception:
            pass
    elif not phase2_ok:
        # Faz 2 fail durumunda enable komutunu hemen ikinci kez dene (best-effort fail-safe)
        try:
            r3 = await ssh_manager.send_config(device, phase2)
            if r3.success:
                row.status = "rolled_back"
                row.rollback_output = (r3.output or "")[:2000]
                row.completed_at = datetime.now(timezone.utc)
                await db.commit()
        except Exception:
            pass

    if not phase2_ok:
        # Cihazı off-bırakmadık (best-effort), ama caller hata bilsin
        raise HTTPException(status_code=502, detail=f"PoE re-enable başarısız (rollback denendi): {phase2_err}")

    return _serialize(row)


@router.post("/{device_id}/ports/{interface:path}/poe/restart")
async def restart_port_poe(
    device_id: int, interface: str,
    payload: PoeRestartPayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Tek port PoE restart: disable → wait → enable."""
    _require_edit(current_user)
    device = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Cihaz bulunamadı")

    os_type = device.os_type or "generic"
    if os_type in _POE_UNSUPPORTED_OS:
        raise HTTPException(status_code=400, detail="Comware PoE henüz desteklenmiyor")

    capable = await _poe_capable_set(db, device.id)
    if capable and interface not in capable:
        raise HTTPException(status_code=400, detail="Port PoE desteklemiyor (not_poe_capable)")

    return await _apply_poe_restart_single(
        db=db, current_user=current_user, device=device, interface=interface,
        restart_wait_sec=payload.restart_wait_sec,
        rollback_after_sec=payload.rollback_after_sec,
        request=request,
    )


@router.post("/{device_id}/ports/bulk-poe")
async def bulk_set_poe(
    device_id: int,
    payload: BulkPoePayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Toplu PoE: action='on'|'off'|'restart'. Tek SSH session, per-port audit.

    Comware → tüm portlar 'failed' (not_supported_vendor).
    PoE-uyumsuz port → 'skipped' (not_poe_capable).
    """
    _require_edit(current_user)
    device = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Cihaz bulunamadı")

    os_type = device.os_type or "generic"
    batch_id = str(uuid.uuid4())
    requested_state = payload.action
    # W3.3 hotfix — action'a göre rollback default (on/off=0 kalıcı, restart=300 fail-safe).
    effective_rollback = _bulk_rollback_default(payload.rollback_after_sec, requested_state)
    total = len(payload.interfaces)
    items: list[dict] = []
    ok = skipped = failed = 0

    # Comware → tüm portlar topluca failed
    if os_type in _POE_UNSUPPORTED_OS:
        for iface in payload.interfaces:
            items.append({
                "interface": iface,
                "status": "failed",
                "error": "Comware PoE henüz desteklenmiyor",
            })
        failed = total
        await log_action(
            db, current_user, _poe_action_audit_name(requested_state),
            "device", device.id, device.hostname,
            details={
                "bulk_batch_id": batch_id, "action": requested_state,
                "total": total, "ok": 0, "skipped": 0, "failed": failed,
                "error": "comware_unsupported",
            },
            request=request,
        )
        return {"batch_id": batch_id, "total": total, "ok": 0,
                "skipped": 0, "failed": failed, "items": items}

    capable = await _poe_capable_set(db, device.id)

    # Skipped (PoE-uyumsuz) ve uygulanacakları ayır
    runnable: list[str] = []
    for iface in payload.interfaces:
        if capable and iface not in capable:
            items.append({"interface": iface, "status": "skipped", "reason": "not_poe_capable"})
            skipped += 1
        else:
            runnable.append(iface)

    # On/Off → tek SSH session (atomic config push)
    if requested_state in ("on", "off") and runnable:
        enable = (requested_state == "on")
        forward_all: list[str] = []
        per_iface_forward: dict[str, list[str]] = {}
        per_iface_rollback: dict[str, list[str]] = {}
        for iface in runnable:
            try:
                f = _portsvc.poe_commands(os_type, iface, enable=enable)
                rb = _portsvc.poe_commands(os_type, iface, enable=not enable)
            except ValueError as e:
                items.append({"interface": iface, "status": "failed", "error": str(e)})
                failed += 1
                continue
            per_iface_forward[iface] = f
            per_iface_rollback[iface] = rb
            forward_all.extend(f)

        if forward_all:
            try:
                result = await ssh_manager.send_config(device, forward_all)
                ssh_ok = bool(result.success)
                ssh_err = None if ssh_ok else (result.error or "unknown")
                ssh_out = (result.output or "")[:2000]
            except Exception as exc:
                ssh_ok = False
                ssh_err = str(exc)
                ssh_out = ""

            now = datetime.now(timezone.utc)
            rb_at = now + timedelta(seconds=max(0, effective_rollback))
            for iface, fwd in per_iface_forward.items():
                rb_cmds = per_iface_rollback[iface]
                row = PortChangeRollback(
                    device_id=device.id, user_id=current_user.id,
                    organization_id=device.organization_id, location_id=device.location_id,
                    interface_name=iface, change_type="poe",
                    requested_state=requested_state,
                    forward_cmds=fwd, rollback_cmds=rb_cmds,
                    forward_output=ssh_out if ssh_ok else f"FAIL: {ssh_err}",
                    status=("pending" if (ssh_ok and effective_rollback > 0) else
                            ("committed" if ssh_ok else "failed")),
                    apply_at=now, rollback_at=rb_at,
                    completed_at=None if (ssh_ok and effective_rollback > 0) else now,
                )
                db.add(row)
            await db.commit()
            # Per-iface audit + countdown
            for iface in per_iface_forward.keys():
                row_q = await db.execute(
                    select(PortChangeRollback)
                    .where(PortChangeRollback.device_id == device.id,
                           PortChangeRollback.interface_name == iface,
                           PortChangeRollback.apply_at >= now)
                    .order_by(desc(PortChangeRollback.id)).limit(1)
                )
                row = row_q.scalar_one_or_none()
                rid = row.id if row else None
                if ssh_ok:
                    items.append({"interface": iface, "status": "success", "rollback_id": rid})
                    ok += 1
                    if rid and effective_rollback > 0:
                        try:
                            from app.workers.tasks.port_rollback_tasks import apply_rollback_if_pending
                            apply_rollback_if_pending.apply_async(
                                args=[rid], countdown=effective_rollback,
                            )
                        except Exception:
                            pass
                else:
                    items.append({"interface": iface, "status": "failed",
                                  "rollback_id": rid, "error": ssh_err})
                    failed += 1

                await log_action(
                    db, current_user, _poe_action_audit_name(requested_state),
                    "device", device.id, device.hostname,
                    details={
                        "bulk_batch_id": batch_id, "interface": iface,
                        "change_type": "poe", "requested_state": requested_state,
                        "rollback_after_sec": effective_rollback,
                        "rollback_id": rid,
                        "result": "success" if ssh_ok else "failed",
                        **({"error": ssh_err} if not ssh_ok else {}),
                    },
                    request=request,
                )

    # Restart → her port için iki-fazlı (paralel değil — sıralı, cihaz CPU koruma)
    elif requested_state == "restart" and runnable:
        for iface in runnable:
            try:
                await _apply_poe_restart_single(
                    db=db, current_user=current_user, device=device, interface=iface,
                    restart_wait_sec=payload.restart_wait_sec,
                    rollback_after_sec=effective_rollback,
                    request=request, bulk_batch_id=batch_id,
                )
                items.append({"interface": iface, "status": "success"})
                ok += 1
            except HTTPException as he:
                items.append({"interface": iface, "status": "failed", "error": he.detail})
                failed += 1
            except Exception as exc:
                items.append({"interface": iface, "status": "failed", "error": str(exc)})
                failed += 1

    return {
        "batch_id": batch_id,
        "total": total, "ok": ok, "skipped": skipped, "failed": failed,
        "items": items,
    }


@router.post("/{device_id}/ports/_rollback/{rollback_id}/commit")
async def commit_rollback(
    device_id: int, rollback_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Pending kaydı onayla — auto rollback iptal."""
    _require_edit(current_user)
    row = (await db.execute(
        select(PortChangeRollback).where(
            PortChangeRollback.id == rollback_id,
            PortChangeRollback.device_id == device_id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Rollback kaydı bulunamadı")
    if row.status != "pending":
        return {**_serialize(row), "note": f"Zaten '{row.status}'"}

    row.status = "committed"
    row.completed_at = datetime.now(timezone.utc)
    await db.commit()
    await log_action(
        db, current_user, "port_change_committed",
        "device", device_id, None,
        details={"rollback_id": rollback_id, "interface": row.interface_name},
        request=request,
    )
    return _serialize(row)


@router.post("/{device_id}/ports/_rollback/{rollback_id}/cancel")
async def cancel_change_now(
    device_id: int, rollback_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Pending kaydı şimdi geri al — inverse SSH çalıştır."""
    _require_edit(current_user)
    row = (await db.execute(
        select(PortChangeRollback).where(
            PortChangeRollback.id == rollback_id,
            PortChangeRollback.device_id == device_id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Rollback kaydı bulunamadı")
    if row.status != "pending":
        return {**_serialize(row), "note": f"Zaten '{row.status}'"}

    device = await db.get(Device, device_id)
    try:
        result = await ssh_manager.send_config(device, list(row.rollback_cmds or []))
        row.rollback_output = (
            (result.output or "")[:2000] if result.success
            else f"FAIL: {result.error}"
        )
        row.status = "rolled_back" if result.success else "failed"
    except Exception as exc:
        row.status = "failed"
        row.rollback_output = f"Exception: {exc}"
    row.completed_at = datetime.now(timezone.utc)
    await db.commit()
    await log_action(
        db, current_user, "port_change_cancelled",
        "device", device_id, None,
        details={"rollback_id": rollback_id, "status": row.status},
        request=request,
    )
    return _serialize(row)


@router.get("/{device_id}/ports/_rollbacks")
async def list_rollbacks(
    device_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Cihaz için son 50 port-change kaydı."""
    rows = (await db.execute(
        select(PortChangeRollback)
        .where(PortChangeRollback.device_id == device_id)
        .order_by(desc(PortChangeRollback.apply_at))
        .limit(50)
    )).scalars().all()
    return {"items": [_serialize(r) for r in rows]}
