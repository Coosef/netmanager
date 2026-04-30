from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, TenantFilter
from app.models.approval import ApprovalRequest
from app.models.device import Device
from app.services.audit_service import log_action

router = APIRouter()


def _summary(r: ApprovalRequest) -> dict:
    return {
        "id": r.id,
        "device_id": r.device_id,
        "device_hostname": r.device_hostname,
        "command": r.command,
        "risk_level": r.risk_level,
        "status": r.status,
        "requester_username": r.requester_username,
        "reviewer_username": r.reviewer_username,
        "review_note": r.review_note,
        "result_success": r.result_success,
        "result_output": r.result_output,
        "result_error": r.result_error,
        "created_at": r.created_at.isoformat(),
        "expires_at": r.expires_at.isoformat(),
        "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "executed_at": r.executed_at.isoformat() if r.executed_at else None,
    }


@router.get("", response_model=dict)
async def list_approvals(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
    status: str | None = None,
    skip: int = 0,
    limit: int = 100,
):
    if not current_user.has_permission("approval:view"):
        raise HTTPException(403, "Insufficient permissions")

    query = select(ApprovalRequest).order_by(ApprovalRequest.created_at.desc())

    if tenant_filter is not None:
        query = query.where(ApprovalRequest.tenant_id == tenant_filter)

    # Operators only see their own requests; admins see all
    if not current_user.has_permission("approval:review"):
        query = query.where(ApprovalRequest.requester_id == current_user.id)

    if status:
        query = query.where(ApprovalRequest.status == status)

    result = await db.execute(query.offset(skip).limit(limit))
    items = result.scalars().all()
    return {"total": len(items), "items": [_summary(r) for r in items]}


@router.get("/pending-count", response_model=dict)
async def pending_count(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    """Returns count of pending approvals. Admins see global count, operators see own."""
    if not current_user.has_permission("approval:view"):
        return {"count": 0}

    query = select(ApprovalRequest).where(ApprovalRequest.status == "pending")
    if tenant_filter is not None:
        query = query.where(ApprovalRequest.tenant_id == tenant_filter)
    if not current_user.has_permission("approval:review"):
        query = query.where(ApprovalRequest.requester_id == current_user.id)

    result = await db.execute(query)
    return {"count": len(result.scalars().all())}


@router.get("/{request_id}", response_model=dict)
async def get_approval(
    request_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    req = await _get_or_404(db, request_id, current_user)
    return _summary(req)


@router.post("/{request_id}/approve", response_model=dict)
async def approve_request(
    request_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("approval:review"):
        raise HTTPException(403, "Only admins can approve requests")

    req = await _get_or_404(db, request_id, current_user)
    if req.status != "pending":
        raise HTTPException(400, f"Request is already '{req.status}'")
    if req.expires_at < datetime.now(timezone.utc):
        req.status = "expired"
        await db.commit()
        raise HTTPException(400, "Request has expired")

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    note = body.get("note", "")

    # Load device and execute
    dev_result = await db.execute(select(Device).where(Device.id == req.device_id))
    device = dev_result.scalar_one_or_none()
    if not device:
        raise HTTPException(404, "Device not found")

    from app.services.ssh_manager import ssh_manager
    try:
        result = await ssh_manager.execute_command(device, req.command)
        req.result_success = result.success
        req.result_output = (result.output or "")[:8192]
        req.result_error = result.error
    except Exception as exc:
        req.result_success = False
        req.result_error = str(exc)

    req.status = "executed"
    req.reviewer_id = current_user.id
    req.reviewer_username = current_user.username
    req.review_note = note
    req.reviewed_at = datetime.now(timezone.utc)
    req.executed_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(req)
    await log_action(db, current_user, "approval_approved", "device", req.device_id, req.device_hostname,
                     details={"request_id": req.id, "command": req.command, "success": req.result_success},
                     request=request)
    return _summary(req)


@router.post("/{request_id}/reject", response_model=dict)
async def reject_request(
    request_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("approval:review"):
        raise HTTPException(403, "Only admins can reject requests")

    req = await _get_or_404(db, request_id, current_user)
    if req.status != "pending":
        raise HTTPException(400, f"Request is already '{req.status}'")

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    req.status = "rejected"
    req.reviewer_id = current_user.id
    req.reviewer_username = current_user.username
    req.review_note = body.get("note", "")
    req.reviewed_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(req)
    await log_action(db, current_user, "approval_rejected", "device", req.device_id, req.device_hostname,
                     details={"request_id": req.id, "command": req.command, "note": req.review_note},
                     request=request)
    return _summary(req)


@router.post("/{request_id}/cancel", response_model=dict)
async def cancel_request(
    request_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("approval:view"):
        raise HTTPException(403, "Insufficient permissions")

    result = await db.execute(
        select(ApprovalRequest).where(
            ApprovalRequest.id == request_id,
            ApprovalRequest.requester_id == current_user.id,
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(404, "Request not found or not yours")
    if req.status != "pending":
        raise HTTPException(400, f"Cannot cancel a '{req.status}' request")

    req.status = "cancelled"
    await db.commit()
    await db.refresh(req)
    await log_action(db, current_user, "approval_cancelled", "device", req.device_id, req.device_hostname,
                     details={"request_id": req.id, "command": req.command}, request=request)
    return _summary(req)


async def _get_or_404(db, request_id: int, current_user) -> ApprovalRequest:
    result = await db.execute(select(ApprovalRequest).where(ApprovalRequest.id == request_id))
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(404, "Approval request not found")
    # Operators can only access their own
    if not current_user.has_permission("approval:review") and req.requester_id != current_user.id:
        raise HTTPException(403, "Access denied")
    return req
