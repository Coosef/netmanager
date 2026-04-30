import asyncio
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.config_template import ConfigTemplate
from app.models.device import Device
from app.services.audit_service import log_action
from app.services.ssh_manager import ssh_manager

router = APIRouter()


class TemplateVariable(BaseModel):
    name: str
    label: str
    default: Optional[str] = ""
    required: bool = False


class TemplateCreate(BaseModel):
    name: str
    description: Optional[str] = None
    os_types: Optional[list[str]] = None
    template: str
    variables: Optional[list[dict]] = None


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    os_types: Optional[list[str]] = None
    template: Optional[str] = None
    variables: Optional[list[dict]] = None


class PushRequest(BaseModel):
    device_ids: list[int]
    variables: dict[str, str] = {}
    dry_run: bool = False


def _render(template: str, variables: dict[str, str]) -> list[str]:
    """Substitute {var} placeholders and split into config lines."""
    try:
        rendered = template.format(**variables)
    except KeyError as e:
        raise ValueError(f"Template variable missing: {e}")
    return [ln for ln in rendered.splitlines() if ln.strip()]


def _serialize(t: ConfigTemplate) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "os_types": t.os_types,
        "template": t.template,
        "variables": t.variables or [],
        "created_by": t.created_by,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


# ─── CRUD ────────────────────────────────────────────────────────────────────

@router.get("")
async def list_templates(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    rows = (await db.execute(select(ConfigTemplate).order_by(ConfigTemplate.name))).scalars().all()
    return [_serialize(r) for r in rows]


@router.post("", status_code=201)
async def create_template(
    body: TemplateCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    existing = (await db.execute(
        select(ConfigTemplate).where(ConfigTemplate.name == body.name)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Template name already exists")

    t = ConfigTemplate(
        name=body.name,
        description=body.description,
        os_types=body.os_types,
        template=body.template,
        variables=body.variables,
        created_by=current_user.username,
    )
    db.add(t)
    await db.commit()
    await db.refresh(t)

    await log_action(db, current_user, "config_template_created", "config_template", t.id, t.name, request=request)
    return _serialize(t)


@router.patch("/{template_id}")
async def update_template(
    template_id: int,
    body: TemplateUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    t = (await db.execute(select(ConfigTemplate).where(ConfigTemplate.id == template_id))).scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")

    for field, value in body.model_dump(exclude_none=True).items():
        setattr(t, field, value)
    t.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(t)

    await log_action(db, current_user, "config_template_updated", "config_template", t.id, t.name, request=request)
    return _serialize(t)


@router.delete("/{template_id}", status_code=204)
async def delete_template(
    template_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    t = (await db.execute(select(ConfigTemplate).where(ConfigTemplate.id == template_id))).scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")

    name = t.name
    await db.delete(t)
    await db.commit()

    await log_action(db, current_user, "config_template_deleted", "config_template", template_id, name, request=request)


# ─── Push ────────────────────────────────────────────────────────────────────

@router.post("/{template_id}/push")
async def push_template(
    template_id: int,
    body: PushRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    t = (await db.execute(select(ConfigTemplate).where(ConfigTemplate.id == template_id))).scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")

    try:
        commands = _render(t.template, body.variables)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not body.device_ids:
        raise HTTPException(status_code=400, detail="No devices specified")

    devices = (await db.execute(
        select(Device).where(Device.id.in_(body.device_ids))
    )).scalars().all()

    device_map = {d.id: d for d in devices}
    results = []

    async def _push_one(device_id: int):
        device = device_map.get(device_id)
        if not device:
            return {"device_id": device_id, "hostname": "?", "success": False, "error": "Device not found", "output": ""}

        if body.dry_run:
            return {
                "device_id": device.id,
                "hostname": device.hostname,
                "success": True,
                "output": "\n".join(commands),
                "error": "",
                "dry_run": True,
            }

        result = await ssh_manager.send_config(device, commands)
        return {
            "device_id": device.id,
            "hostname": device.hostname,
            "success": result.success,
            "output": result.output,
            "error": result.error,
            "dry_run": False,
        }

    push_results = await asyncio.gather(*[_push_one(did) for did in body.device_ids])
    results = list(push_results)

    success_count = sum(1 for r in results if r["success"])
    await log_action(
        db, current_user, "config_template_pushed", "config_template", t.id, t.name,
        details={
            "device_ids": body.device_ids,
            "variables": body.variables,
            "dry_run": body.dry_run,
            "success_count": success_count,
            "total": len(results),
        },
        request=request,
    )

    return {"results": results, "success_count": success_count, "total": len(results)}


@router.post("/{template_id}/preview")
async def preview_template(
    template_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    t = (await db.execute(select(ConfigTemplate).where(ConfigTemplate.id == template_id))).scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")

    variables = body.get("variables", {})
    try:
        commands = _render(t.template, variables)
        return {"success": True, "preview": "\n".join(commands)}
    except ValueError as e:
        return {"success": False, "error": str(e)}
