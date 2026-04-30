from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, TenantFilter
from app.models.change_rollout import ChangeRollout
from app.models.config_template import ConfigTemplate
from app.models.device import Device
from app.services.audit_service import log_action

router = APIRouter()

ALLOWED_STATUSES = {
    "draft", "pending_approval", "approved", "running",
    "done", "partial", "failed", "rolled_back",
}


class RolloutCreate(BaseModel):
    name: str
    description: Optional[str] = None
    template_id: Optional[int] = None
    template_variables: Optional[dict] = None
    raw_commands: Optional[list[str]] = None
    device_ids: list[int]


class RolloutUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    template_id: Optional[int] = None
    template_variables: Optional[dict] = None
    raw_commands: Optional[list[str]] = None
    device_ids: Optional[list[int]] = None


class ApproveRequest(BaseModel):
    note: Optional[str] = None


class RejectRequest(BaseModel):
    note: str


def _serialize(r: ChangeRollout) -> dict:
    return {
        "id": r.id,
        "name": r.name,
        "description": r.description,
        "template_id": r.template_id,
        "template_variables": r.template_variables,
        "raw_commands": r.raw_commands,
        "device_ids": r.device_ids,
        "status": r.status,
        "submitted_by": r.submitted_by,
        "approved_by": r.approved_by,
        "approved_at": r.approved_at.isoformat() if r.approved_at else None,
        "rejection_note": r.rejection_note,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
        "device_results": r.device_results,
        "total_devices": r.total_devices,
        "success_devices": r.success_devices,
        "failed_devices": r.failed_devices,
        "rolled_back_devices": r.rolled_back_devices,
        "created_by": r.created_by,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


@router.get("")
async def list_rollouts(
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    q = select(ChangeRollout).order_by(ChangeRollout.created_at.desc())
    if tenant_filter is not None:
        q = q.where(ChangeRollout.tenant_id == tenant_filter)
    if status:
        q = q.where(ChangeRollout.status == status)
    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    rows = (await db.execute(q.limit(limit).offset(offset))).scalars().all()
    return {"total": total, "items": [_serialize(r) for r in rows]}


@router.get("/{rollout_id}")
async def get_rollout(
    rollout_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    r = await _get_or_404(db, rollout_id, tenant_filter)
    return _serialize(r)


@router.post("", status_code=201)
async def create_rollout(
    payload: RolloutCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("config:push"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    if not payload.template_id and not payload.raw_commands:
        raise HTTPException(status_code=400, detail="Provide template_id or raw_commands")
    if not payload.device_ids:
        raise HTTPException(status_code=400, detail="device_ids cannot be empty")

    # Validate devices exist
    devices = (await db.execute(
        select(Device).where(Device.id.in_(payload.device_ids))
    )).scalars().all()
    found_ids = {d.id for d in devices}
    missing = set(payload.device_ids) - found_ids
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown device ids: {sorted(missing)}")

    r = ChangeRollout(
        name=payload.name,
        description=payload.description,
        template_id=payload.template_id,
        template_variables=payload.template_variables,
        raw_commands=payload.raw_commands,
        device_ids=payload.device_ids,
        total_devices=len(payload.device_ids),
        created_by=current_user.username,
        tenant_id=current_user.tenant_id,
    )
    db.add(r)
    await db.commit()
    await db.refresh(r)
    await log_action(db, current_user, "change_rollout_created", "change_rollout", r.id, r.name, request=request)
    return _serialize(r)


@router.patch("/{rollout_id}")
async def update_rollout(
    rollout_id: int,
    payload: RolloutUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    r = await _get_or_404(db, rollout_id, tenant_filter)
    if r.status not in ("draft",):
        raise HTTPException(status_code=400, detail="Only draft rollouts can be edited")

    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(r, field, value)
    if "device_ids" in data:
        r.total_devices = len(data["device_ids"])
    await db.commit()
    await db.refresh(r)
    return _serialize(r)


@router.delete("/{rollout_id}", status_code=204)
async def delete_rollout(
    rollout_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    r = await _get_or_404(db, rollout_id, tenant_filter)
    if r.status in ("running",):
        raise HTTPException(status_code=400, detail="Cannot delete a running rollout")
    await db.delete(r)
    await db.commit()


@router.post("/{rollout_id}/submit")
async def submit_for_approval(
    rollout_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    """Move rollout from draft → pending_approval."""
    r = await _get_or_404(db, rollout_id, tenant_filter)
    if r.status != "draft":
        raise HTTPException(status_code=400, detail=f"Cannot submit from status '{r.status}'")

    r.status = "pending_approval"
    r.submitted_by = current_user.username
    await db.commit()
    await log_action(db, current_user, "change_rollout_submitted", "change_rollout", r.id, r.name, request=request)
    return _serialize(r)


@router.post("/{rollout_id}/approve")
async def approve_rollout(
    rollout_id: int,
    payload: ApproveRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    """Approve a pending rollout (admin/super_admin only)."""
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    r = await _get_or_404(db, rollout_id, tenant_filter)
    if r.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot approve from status '{r.status}'")

    r.status = "approved"
    r.approved_by = current_user.username
    r.approved_at = datetime.now(timezone.utc)
    await db.commit()
    await log_action(db, current_user, "change_rollout_approved", "change_rollout", r.id, r.name, request=request)
    return _serialize(r)


@router.post("/{rollout_id}/reject")
async def reject_rollout(
    rollout_id: int,
    payload: RejectRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    r = await _get_or_404(db, rollout_id, tenant_filter)
    if r.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot reject from status '{r.status}'")

    r.status = "draft"
    r.rejection_note = payload.note
    await db.commit()
    await log_action(db, current_user, "change_rollout_rejected", "change_rollout", r.id, r.name, request=request,
                     details={"note": payload.note})
    return _serialize(r)


@router.post("/{rollout_id}/start")
async def start_rollout(
    rollout_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    """Dispatch Celery task to execute the rollout."""
    if not current_user.has_permission("config:push"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    r = await _get_or_404(db, rollout_id, tenant_filter)
    if r.status != "approved":
        raise HTTPException(status_code=400, detail=f"Rollout must be approved before starting (current: '{r.status}')")

    from app.workers.tasks.rollout_tasks import execute_rollout_task
    execute_rollout_task.delay(rollout_id)

    await log_action(db, current_user, "change_rollout_started", "change_rollout", r.id, r.name, request=request)
    return {"message": "Rollout queued", "rollout_id": rollout_id}


@router.post("/{rollout_id}/rollback")
async def rollback_rollout(
    rollout_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    """Dispatch Celery task to restore pre-rollout backups."""
    if not current_user.has_permission("config:push"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    r = await _get_or_404(db, rollout_id, tenant_filter)
    if r.status not in ("done", "partial", "failed"):
        raise HTTPException(status_code=400, detail=f"Cannot rollback from status '{r.status}'")
    if not r.device_results:
        raise HTTPException(status_code=400, detail="No device results to rollback — were backups taken?")

    # Check that at least one device has a backup
    has_backup = any(
        v.get("backup_id") and v.get("status") == "success"
        for v in r.device_results.values()
    )
    if not has_backup:
        raise HTTPException(status_code=400, detail="No successful devices with backups found for rollback")

    from app.workers.tasks.rollout_tasks import execute_rollback_task
    execute_rollback_task.delay(rollout_id)

    await log_action(db, current_user, "change_rollout_rollback_initiated", "change_rollout", r.id, r.name, request=request)
    return {"message": "Rollback queued", "rollout_id": rollout_id}


async def _get_or_404(db: AsyncSession, rollout_id: int, tenant_filter=None) -> ChangeRollout:
    q = select(ChangeRollout).where(ChangeRollout.id == rollout_id)
    if tenant_filter is not None:
        q = q.where(ChangeRollout.tenant_id == tenant_filter)
    r = (await db.execute(q)).scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Rollout not found")
    return r
