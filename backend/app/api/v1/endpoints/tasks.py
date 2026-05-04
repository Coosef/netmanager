from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, TenantFilter
from app.models.audit_log import AuditLog
from app.models.task import Task, TaskStatus, TaskType
from app.schemas.task import TaskCreate, TaskResponse
from app.services.audit_service import log_action
from app.workers.tasks.bulk_tasks import (
    bulk_backup_configs,
    bulk_password_change,
    run_bulk_command,
)
from app.workers.tasks.monitor_tasks import check_loop_detection, check_stp_anomalies

router = APIRouter()


@router.get("/", response_model=dict)
async def list_tasks(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    tenant_filter: TenantFilter = None,
    skip: int = 0,
    limit: int = 50,
    status: str = Query(None),
    type: str = Query(None),
):
    query = select(Task)
    if tenant_filter is not None:
        query = query.where(Task.tenant_id == tenant_filter)
    if status:
        query = query.where(Task.status == status)
    if type:
        query = query.where(Task.type == type)

    total = await db.execute(select(func.count()).select_from(query.subquery()))
    result = await db.execute(
        query.order_by(Task.created_at.desc()).offset(skip).limit(limit)
    )
    tasks = result.scalars().all()
    return {
        "total": total.scalar(),
        "items": [TaskResponse.model_validate(t) for t in tasks],
    }


@router.post("/", response_model=TaskResponse, status_code=201)
async def create_task(
    payload: TaskCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("task:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    task = Task(
        name=payload.name,
        type=payload.type,
        status=TaskStatus.PENDING,
        device_ids=payload.device_ids,
        parameters=payload.parameters or {},
        total_devices=len(payload.device_ids),
        created_by=current_user.id,
        tenant_id=current_user.tenant_id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    # Dispatch to appropriate Celery task
    _dispatch_task(task, current_user.id)

    await log_action(
        db, current_user, "task_created", "task", task.id, task.name,
        details={"type": task.type, "device_count": len(payload.device_ids)},
        request=request,
    )
    return task


def _dispatch_task(task: Task, user_id: int):
    params = task.parameters or {}
    if task.type == TaskType.BULK_COMMAND:
        run_bulk_command.apply_async(
            args=[task.id, task.device_ids, params.get("commands", []), params.get("is_config", False)],
            queue="bulk",
        )
    elif task.type == TaskType.BACKUP_CONFIG:
        bulk_backup_configs.apply_async(
            args=[task.id, task.device_ids, user_id],
            queue="bulk",
        )
    elif task.type == TaskType.BULK_PASSWORD_CHANGE:
        if not current_user_has_permission_check(params):
            raise HTTPException(status_code=403, detail="Insufficient permissions for bulk password change")
        bulk_password_change.apply_async(
            args=[task.id, task.device_ids, params["new_password"], user_id],
            queue="bulk",
        )
    elif task.type == TaskType.MONITOR_POLL:
        check_stp_anomalies.apply_async(args=[task.device_ids], queue="monitor")
        check_loop_detection.apply_async(args=[task.device_ids], queue="monitor")


def current_user_has_permission_check(params: dict) -> bool:
    return "new_password" in params


@router.get("/audit-log", response_model=dict)
async def get_audit_log(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    skip: int = 0,
    limit: int = 100,
    action: str = Query(None),
    resource_type: str = Query(None),
    username: str = Query(None),
    status: str = Query(None),
    client_ip: str = Query(None),
    date_from: str = Query(None),
    date_to: str = Query(None),
    request_id: str = Query(None),
):
    from datetime import datetime, timezone
    from app.models.user import User
    if not current_user.has_permission("audit:view"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    query = select(AuditLog)
    if action:
        query = query.where(AuditLog.action.ilike(f"%{action}%"))
    if resource_type:
        query = query.where(AuditLog.resource_type == resource_type)
    if username:
        query = query.where(AuditLog.username.ilike(f"%{username}%"))
    if status:
        query = query.where(AuditLog.status == status)
    if client_ip:
        query = query.where(AuditLog.client_ip.ilike(f"%{client_ip}%"))
    if request_id:
        query = query.where(AuditLog.request_id == request_id)
    if date_from:
        try:
            query = query.where(AuditLog.created_at >= datetime.fromisoformat(date_from))
        except ValueError:
            pass
    if date_to:
        try:
            query = query.where(AuditLog.created_at <= datetime.fromisoformat(date_to))
        except ValueError:
            pass

    total_scalar = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar()
    logs = (await db.execute(
        query.order_by(AuditLog.created_at.desc()).offset(skip).limit(limit)
    )).scalars().all()

    # Fetch user roles for current page in one query
    user_ids = list({l.user_id for l in logs if l.user_id})
    role_map: dict[int, str] = {}
    if user_ids:
        rows = (await db.execute(select(User.id, User.role).where(User.id.in_(user_ids)))).fetchall()
        role_map = {row[0]: row[1] for row in rows}

    # Summary stats for header
    failure_count = (await db.execute(
        select(func.count()).select_from(query.where(AuditLog.status == "failure").subquery())
    )).scalar()
    unique_users = (await db.execute(
        select(func.count(func.distinct(AuditLog.username))).select_from(query.subquery())
    )).scalar()

    return {
        "total": total_scalar,
        "failure_count": failure_count,
        "unique_users": unique_users,
        "items": [
            {
                "id": l.id, "user_id": l.user_id, "username": l.username,
                "user_role": role_map.get(l.user_id) if l.user_id else None,
                "action": l.action, "resource_type": l.resource_type,
                "resource_id": l.resource_id, "resource_name": l.resource_name,
                "details": l.details, "client_ip": l.client_ip,
                "user_agent": l.user_agent,
                "status": l.status, "created_at": l.created_at,
                "request_id": l.request_id,
                "duration_ms": l.duration_ms,
                "before_state": l.before_state,
                "after_state": l.after_state,
            }
            for l in logs
        ],
    }


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    q = select(Task).where(Task.id == task_id)
    if tenant_filter is not None:
        q = q.where(Task.tenant_id == tenant_filter)
    task = (await db.execute(q)).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.post("/{task_id}/cancel", response_model=dict)
async def cancel_task(
    task_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Cancel a PENDING or RUNNING task. Revokes the Celery task if possible."""
    if not current_user.has_permission("task:create"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    from sqlalchemy import update as _upd
    from datetime import datetime, timezone
    from app.workers.celery_app import celery_app

    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if task.status not in (TaskStatus.PENDING, TaskStatus.RUNNING):
        raise HTTPException(status_code=400, detail=f"Cannot cancel task in '{task.status}' state")

    # Revoke Celery task if we have the ID
    if task.celery_task_id:
        try:
            celery_app.control.revoke(task.celery_task_id, terminate=True, signal="SIGTERM")
        except Exception:
            pass

    await db.execute(
        _upd(Task).where(Task.id == task_id).values(
            status=TaskStatus.CANCELLED,
            completed_at=datetime.now(timezone.utc),
        )
    )
    await db.commit()

    await log_action(db, current_user, "task_cancelled", "task", task_id, task.name, request=request)
    return {"task_id": task_id, "status": "cancelled"}
