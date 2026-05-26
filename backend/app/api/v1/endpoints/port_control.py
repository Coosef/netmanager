"""Port toggle + PoE control endpoint'leri (T9 Tur 4 #8+E2).

  POST /api/v1/devices/{device_id}/ports/{interface}/admin
       body: {"enable": bool, "reason": str?, "rollback_after_sec": int?}
       SSH config push (vendor-aware) + 5dk safety rollback timer (default).

  POST /api/v1/devices/{device_id}/ports/{interface}/poe
       body: {"enable": bool, "reason": str?, "rollback_after_sec": int?}

  POST /api/v1/devices/{device_id}/ports/_rollback/{rollback_id}/commit
       Pending bekleyen değişikliği onayla (rollback iptal).

  POST /api/v1/devices/{device_id}/ports/_rollback/{rollback_id}/cancel
       Pending bekleyen değişikliği şimdi geri al.

  GET  /api/v1/devices/{device_id}/ports/_rollbacks
       Cihaz için son N pending/recent kayıt.

Yetki: device:edit (org_admin/location_admin/super_admin).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.port_change_rollback import PortChangeRollback
from app.services import port_control_service as _portsvc
from app.services.audit_service import log_action
from app.services.ssh_manager import ssh_manager

router = APIRouter()


class PortChangePayload(BaseModel):
    enable: bool
    reason: Optional[str] = None
    rollback_after_sec: int = 300   # default 5dk; 0 → rollback yok (kalıcı)


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

    await log_action(
        db, current_user,
        "port_change_applied",
        "device", device.id, device.hostname,
        details={
            "interface": interface,
            "change_type": change_type,
            "requested_state": requested_state,
            "rollback_after_sec": rollback_after_sec,
            "rollback_id": row.id,
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
    payload: PortChangePayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """PoE enable/disable + 5dk safety rollback."""
    _require_edit(current_user)
    device = (await db.execute(
        select(Device).where(Device.id == device_id)
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Cihaz bulunamadı")

    try:
        forward = _portsvc.poe_commands(
            device.os_type or "generic", interface, enable=payload.enable,
        )
        rollback = _portsvc.poe_commands(
            device.os_type or "generic", interface, enable=not payload.enable,
        )
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
