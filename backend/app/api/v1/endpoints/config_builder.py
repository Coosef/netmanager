"""T9 Tur 5 #11 — Easy Config Builder endpoints.

GET  /config-builder/operations           — operation registry (FE rendering)
POST /config-builder/preview              — dry-run; returns per-device CLI
POST /config-builder/push                 — execute on devices (SSH send_config)
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.services.audit_service import log_action
from app.services.config_builder_service import (
    ALL_SUPPORTED,
    build_commands,
    list_operations,
)
from app.services.ssh_manager import ssh_manager

router = APIRouter()


class PreviewRequest(BaseModel):
    operation: str
    params: dict[str, Any]
    device_ids: list[int]
    with_save: bool = True


class PushRequest(PreviewRequest):
    reason: Optional[str] = None
    confirm: bool = False


def _per_device_commands(operation: str, devices: list[Device],
                         params: dict[str, Any], *, with_save: bool) -> list[dict]:
    """Generate the per-device command list, capturing per-device errors
    (vendor unsupported, missing field) inline rather than aborting the
    whole batch."""
    out: list[dict] = []
    for dev in devices:
        os_type = dev.os_type or ""
        entry: dict[str, Any] = {
            "device_id": dev.id,
            "hostname": dev.hostname,
            "os_type": os_type,
            "supported": os_type in ALL_SUPPORTED,
        }
        if not entry["supported"]:
            entry["error"] = f"Vendor desteklenmiyor: {os_type or '?'}"
            entry["commands"] = []
        else:
            try:
                entry["commands"] = build_commands(
                    operation, os_type, params, with_save=with_save,
                )
                entry["error"] = None
            except ValueError as exc:
                entry["commands"] = []
                entry["error"] = str(exc)
        out.append(entry)
    return out


@router.get("/operations")
async def get_operations(_: CurrentUser = None):
    """Form-driven UI için operation registry."""
    return {"operations": list_operations()}


@router.post("/preview")
async def preview(
    body: PreviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Dry-run — herhangi bir komut göndermeden, her cihaz için
    üretilecek CLI listesini döner. push butonu aktiflenmeden önce
    operator'ün gözden geçirmesi içindir."""
    if not body.device_ids:
        raise HTTPException(status_code=400, detail="device_ids boş olamaz")

    devices = (await db.execute(
        select(Device).where(Device.id.in_(body.device_ids))
    )).scalars().all()
    found_ids = {d.id for d in devices}
    missing = [i for i in body.device_ids if i not in found_ids]

    items = _per_device_commands(
        body.operation, devices, body.params, with_save=body.with_save,
    )
    return {
        "operation": body.operation,
        "params": body.params,
        "items": items,
        "missing_device_ids": missing,
        "supported_count": sum(1 for it in items if it["supported"] and not it["error"]),
        "error_count": sum(1 for it in items if it["error"]),
    }


@router.post("/push")
async def push(
    body: PushRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """SSH üzerinden komut gönder.

    Operator önce /preview ile farkı görür, sonra `confirm: true` ile
    push'lar. Cihaz başına bir SSH oturumu ve `send_config` (save dahil)
    çağrılır; sonuçlar audit_log'a ve dönen JSON'a yazılır.
    """
    if not current_user.has_permission("config:push"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    if not body.confirm:
        raise HTTPException(
            status_code=400,
            detail="Bu işlemi onaylamadınız (confirm: true gerekli).",
        )
    if not body.device_ids:
        raise HTTPException(status_code=400, detail="device_ids boş olamaz")

    devices = (await db.execute(
        select(Device).where(Device.id.in_(body.device_ids))
    )).scalars().all()
    device_map = {d.id: d for d in devices}

    plan = _per_device_commands(
        body.operation, list(devices), body.params, with_save=body.with_save,
    )

    async def _run_one(item: dict):
        if item["error"] or not item["commands"]:
            return {**item, "success": False, "output": "", "skipped": True}
        device = device_map.get(item["device_id"])
        if not device:
            return {**item, "success": False, "error": "Device gone", "output": ""}
        if device.status == "offline":
            return {**item, "success": False, "error": "Cihaz çevrimdışı", "output": ""}
        try:
            result = await ssh_manager.send_config(device, item["commands"])
            return {
                **item,
                "success": result.success,
                "output": (result.output or "")[:2000],
                "error": result.error if not result.success else None,
            }
        except Exception as exc:  # noqa: BLE001
            return {**item, "success": False, "error": str(exc), "output": ""}

    results = await asyncio.gather(*[_run_one(it) for it in plan])
    success_count = sum(1 for r in results if r.get("success"))

    await log_action(
        db, current_user, "config_builder_push",
        "device", body.device_ids[0] if body.device_ids else None,
        f"{body.operation} on {len(body.device_ids)} device(s)",
        request=request,
        details={
            "operation": body.operation,
            "params": body.params,
            "device_ids": body.device_ids,
            "success_count": success_count,
            "total": len(results),
            "reason": body.reason,
        },
    )

    return {
        "operation": body.operation,
        "params": body.params,
        "results": results,
        "success_count": success_count,
        "total": len(results),
    }
