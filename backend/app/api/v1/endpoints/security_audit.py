"""Security Audit & Hardening Score endpoints."""
import csv
import io
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import cast, Date, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, LocationNameFilter
from app.models.device import Device
from app.models.security_audit import SecurityAudit
from app.models.task import Task, TaskType, TaskStatus
from app.services.audit_service import log_action

router = APIRouter()


class RunAuditRequest(BaseModel):
    device_ids: Optional[list[int]] = None  # None = all active devices


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats")
async def get_audit_stats(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    location_filter: LocationNameFilter = None,
    site: Optional[str] = Query(None),
):
    subq = (
        select(SecurityAudit.device_id, func.max(SecurityAudit.created_at).label("latest"))
        .group_by(SecurityAudit.device_id)
        .subquery()
    )
    q = select(SecurityAudit).join(
        subq,
        (SecurityAudit.device_id == subq.c.device_id)
        & (SecurityAudit.created_at == subq.c.latest),
    )
    if location_filter is not None:
        eff = [s for s in location_filter if not site or s == site] if site else location_filter
        if not eff:
            return {"total": 0, "avg_score": 0, "grades": {"A": 0, "B": 0, "C": 0, "D": 0, "F": 0}, "critical_count": 0}
        site_ids = select(Device.id).where(Device.site.in_(eff), Device.is_active == True)
        q = q.where(SecurityAudit.device_id.in_(site_ids))
        site = None
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        q = q.where(SecurityAudit.device_id.in_(site_ids))
    result = await db.execute(q)
    audits = result.scalars().all()

    if not audits:
        return {"total": 0, "avg_score": 0, "grades": {"A": 0, "B": 0, "C": 0, "D": 0, "F": 0}, "critical_count": 0}

    grade_dist: dict[str, int] = {"A": 0, "B": 0, "C": 0, "D": 0, "F": 0}
    total_score = 0
    critical_count = 0

    for a in audits:
        grade_dist[a.grade] = grade_dist.get(a.grade, 0) + 1
        total_score += a.score
        for f in a.findings or []:
            if f.get("status") == "fail" and f.get("weight", 0) >= 10:
                critical_count += 1

    return {
        "total": len(audits),
        "avg_score": round(total_score / len(audits), 1),
        "grades": grade_dist,
        "critical_count": critical_count,
    }


# ── CSV Export ───────────────────────────────────────────────────────────────

@router.get("/export.csv")
async def export_audits_csv(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    site: Optional[str] = Query(None),
    location_filter: LocationNameFilter = None,
):
    """Stream latest security audit results as CSV."""
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo("Europe/Istanbul")
    except Exception:
        tz = timezone.utc

    subq = (
        select(SecurityAudit.device_id, func.max(SecurityAudit.created_at).label("latest"))
        .group_by(SecurityAudit.device_id)
        .subquery()
    )
    q = select(SecurityAudit).join(
        subq,
        (SecurityAudit.device_id == subq.c.device_id)
        & (SecurityAudit.created_at == subq.c.latest),
    )
    if location_filter is not None:
        eff = [s for s in location_filter if not site or s == site] if site else location_filter
        if eff:
            site_ids = select(Device.id).where(Device.site.in_(eff), Device.is_active == True)
            q = q.where(SecurityAudit.device_id.in_(site_ids))
    elif site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        q = q.where(SecurityAudit.device_id.in_(site_ids))

    audits = (await db.execute(q.order_by(desc(SecurityAudit.score)))).scalars().all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["device_hostname", "device_id", "score", "grade", "status",
                     "findings_total", "failed", "warnings", "passed", "audited_at", "error"])
    for a in audits:
        findings = a.findings or []
        ts = a.created_at.astimezone(tz).strftime("%Y-%m-%d %H:%M") if a.created_at else ""
        writer.writerow([
            a.device_hostname, a.device_id, a.score, a.grade, a.status,
            len(findings),
            sum(1 for f in findings if f.get("status") == "fail"),
            sum(1 for f in findings if f.get("status") == "warning"),
            sum(1 for f in findings if f.get("status") == "pass"),
            ts,
            a.error or "",
        ])

    now_str = datetime.now().strftime("%Y%m%d_%H%M")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=security_audit_{now_str}.csv"},
    )


# ── List (latest per device) ──────────────────────────────────────────────────

@router.get("/")
async def list_audits(
    search: Optional[str] = None,
    grade: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    site: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    location_filter: LocationNameFilter = None,
):
    subq = (
        select(SecurityAudit.device_id, func.max(SecurityAudit.created_at).label("latest"))
        .group_by(SecurityAudit.device_id)
        .subquery()
    )
    q = select(SecurityAudit).join(
        subq,
        (SecurityAudit.device_id == subq.c.device_id)
        & (SecurityAudit.created_at == subq.c.latest),
    )
    if location_filter is not None:
        eff = [s for s in location_filter if not site or s == site] if site else location_filter
        if not eff:
            return {"total": 0, "items": []}
        site_ids = select(Device.id).where(Device.site.in_(eff), Device.is_active == True)
        q = q.where(SecurityAudit.device_id.in_(site_ids))
        site = None
    if grade:
        q = q.where(SecurityAudit.grade == grade)
    if search:
        q = q.where(SecurityAudit.device_hostname.ilike(f"%{search}%"))
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        q = q.where(SecurityAudit.device_id.in_(site_ids))

    count_result = await db.execute(select(func.count()).select_from(q.subquery()))
    total = count_result.scalar_one()

    q = q.order_by(desc(SecurityAudit.score)).offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(q)
    audits = result.scalars().all()

    return {
        "total": total,
        "items": [
            {
                "id": a.id,
                "device_id": a.device_id,
                "device_hostname": a.device_hostname,
                "score": a.score,
                "grade": a.grade,
                "status": a.status,
                "error": a.error,
                "findings_count": len(a.findings or []),
                "failed_count": sum(1 for f in (a.findings or []) if f.get("status") == "fail"),
                "warning_count": sum(1 for f in (a.findings or []) if f.get("status") == "warning"),
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in audits
        ],
    }


# ── Detail ────────────────────────────────────────────────────────────────────

@router.get("/{audit_id}")
async def get_audit_detail(
    audit_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    audit = (
        await db.execute(select(SecurityAudit).where(SecurityAudit.id == audit_id))
    ).scalar_one_or_none()
    if not audit:
        raise HTTPException(404, "Audit bulunamadı")
    return {
        "id": audit.id,
        "device_id": audit.device_id,
        "device_hostname": audit.device_hostname,
        "score": audit.score,
        "grade": audit.grade,
        "status": audit.status,
        "error": audit.error,
        "findings": audit.findings or [],
        "created_at": audit.created_at.isoformat() if audit.created_at else None,
    }


# ── History per device ────────────────────────────────────────────────────────

@router.get("/device/{device_id}/history")
async def get_device_audit_history(
    device_id: int,
    limit: int = Query(10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    result = await db.execute(
        select(SecurityAudit)
        .where(SecurityAudit.device_id == device_id)
        .order_by(desc(SecurityAudit.created_at))
        .limit(limit)
    )
    return [
        {
            "id": a.id,
            "score": a.score,
            "grade": a.grade,
            "status": a.status,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in result.scalars().all()
    ]


# ── Fleet trend ──────────────────────────────────────────────────────────────

@router.get("/fleet-trend")
async def fleet_compliance_trend(
    days: int = Query(30, ge=7, le=90),
    site: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    """Daily average compliance score across all successfully audited devices."""
    since = datetime.now(timezone.utc) - timedelta(days=days)

    trend_q = (
        select(
            cast(SecurityAudit.created_at, Date).label("scan_date"),
            func.round(func.avg(SecurityAudit.score), 1).label("avg_score"),
            func.min(SecurityAudit.score).label("min_score"),
            func.max(SecurityAudit.score).label("max_score"),
            func.count(SecurityAudit.id.distinct()).label("scan_count"),
        )
        .where(
            SecurityAudit.status == "done",
            SecurityAudit.created_at >= since,
        )
        .group_by(cast(SecurityAudit.created_at, Date))
        .order_by(cast(SecurityAudit.created_at, Date))
    )
    if site:
        site_ids = select(Device.id).where(Device.site == site, Device.is_active == True)
        trend_q = trend_q.where(SecurityAudit.device_id.in_(site_ids))

    result = await db.execute(trend_q)
    rows = result.all()
    return [
        {
            "date": str(r.scan_date),
            "avg_score": float(r.avg_score) if r.avg_score is not None else None,
            "min_score": r.min_score,
            "max_score": r.max_score,
            "scan_count": r.scan_count,
        }
        for r in rows
    ]


# ── Trigger ───────────────────────────────────────────────────────────────────

@router.post("/run")
async def trigger_audit(
    body: RunAuditRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    from app.workers.tasks.security_audit_tasks import run_security_audit

    if body.device_ids:
        res = await db.execute(
            select(Device.id).where(Device.id.in_(body.device_ids), Device.is_active == True)
        )
        device_ids = [r[0] for r in res.all()]
    else:
        res = await db.execute(select(Device.id).where(Device.is_active == True))
        device_ids = [r[0] for r in res.all()]

    if not device_ids:
        raise HTTPException(400, "Aktif cihaz bulunamadı")

    task = Task(
        name="Security Audit",
        type=TaskType.MONITOR_POLL,
        status=TaskStatus.PENDING,
        device_ids=device_ids,
        total_devices=len(device_ids),
        created_by=current_user.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    run_security_audit.apply_async(
        args=[task.id, device_ids],
        queue="monitor",
    )

    await log_action(
        db, current_user, "security_audit_run", "security_audit", str(task.id),
        f"{len(device_ids)} cihaz için güvenlik denetimi",
        request=request,
    )

    return {"task_id": task.id, "device_count": len(device_ids)}
