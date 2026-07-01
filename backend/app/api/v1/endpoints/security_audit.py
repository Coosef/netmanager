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
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.security_audit import SecurityAudit
from app.models.task import Task, TaskType, TaskStatus
from app.services.audit_service import log_action

router = APIRouter()


# RBAC-SPRINT-2.2A (2026-07-01) — inline permission gates for the
# Security Audit surface.
#
# Pre-2.2A all 12 endpoints were auth-only; frontend PermRoute
# (monitoring, view) gated /security-audit page but a direct API caller
# with monitoring:view could POST /profiles (create org-wide compliance
# policy), PUT /profiles/{id} (modify policy), DELETE /profiles/{id}
# (remove policy) and POST /run (trigger audit scan). The recycled
# monitoring:view gate was semantically wrong — monitoring is network
# telemetry, security audit is compliance policy + device hardening.
#
# The new security_audit module gives the surface its own verbs:
#   - view           — GET /rules, /profiles, /stats, /export.csv,
#                       "" (list), /{id}, /device/{id}/history,
#                       /fleet-trend (all read-only)
#   - profile_manage — POST /profiles, PUT /profiles/{id},
#                       DELETE /profiles/{id} (compliance policy CRUD,
#                       org-wide; org_admin+ only)
#   - run            — POST /run (trigger audit scan on org devices;
#                       location_admin CAN opt-in for own location's
#                       devices per Sprint 2.2 design report Q2)
#
# The Alembic migration f9aj_rbac_authorization_hardening.py backfills
# every existing permission_set row: monitoring.view=true carries over
# to security_audit.view=true so current monitoring viewers keep read
# access; profile_manage + run stay FALSE for custom sets (name-based
# opt-in only for Tam Yetki / Org Admin).
def _require_security_audit_view(user) -> None:
    if not user.has_permission("security_audit:view"):
        raise HTTPException(status_code=403, detail="Permission denied: security_audit.view")


def _require_security_audit_profile_manage(user) -> None:
    if not user.has_permission("security_audit:profile_manage"):
        raise HTTPException(status_code=403, detail="Permission denied: security_audit.profile_manage")


def _require_security_audit_run(user) -> None:
    if not user.has_permission("security_audit:run"):
        raise HTTPException(status_code=403, detail="Permission denied: security_audit.run")


class RunAuditRequest(BaseModel):
    device_ids: Optional[list[int]] = None  # None = all active devices
    # T8.4 — opsiyonel ComplianceProfile.id; verilirse audit sadece o
    #profile'ın enabled_rule_ids set'i ile filtrelenir. None ise default
    #profile (varsa) kullanılır, yoksa eski davranış: tüm built-in kurallar.
    profile_id: Optional[int] = None


# ── T8.4 — Built-in rules listing + ComplianceProfile CRUD ───────────────────

class ProfilePayload(BaseModel):
    name: str
    description: Optional[str] = None
    enabled_rule_ids: list[str]
    is_default: bool = False


@router.get("/rules")
async def list_builtin_rules(current_user: CurrentUser = None):
    """Built-in rule kataloğu — kullanıcı bir profile yaratırken bu listeden
    seçer. Hiçbir DB call'u yok; sadece in-process registry'yi expose eder."""
    _require_security_audit_view(current_user)
    from app.services.security_audit_service import BUILTIN_RULES
    return {"rules": BUILTIN_RULES, "total": len(BUILTIN_RULES)}


@router.get("/profiles")
async def list_profiles(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    _require_security_audit_view(current_user)
    from app.models.compliance_profile import ComplianceProfile
    rows = (await db.execute(
        select(ComplianceProfile).order_by(ComplianceProfile.is_default.desc(), ComplianceProfile.name)
    )).scalars().all()
    return [
        {
            "id": p.id, "name": p.name, "description": p.description,
            "enabled_rule_ids": p.enabled_rule_ids, "is_default": p.is_default,
            "created_at": p.created_at.isoformat(),
            "updated_at": p.updated_at.isoformat(),
        } for p in rows
    ]


@router.post("/profiles")
async def create_profile(
    payload: ProfilePayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    _require_security_audit_profile_manage(current_user)
    from app.models.compliance_profile import ComplianceProfile
    from app.services.security_audit_service import BUILTIN_RULE_IDS

    # Validate rule_ids — bilinmeyenleri sessizce drop etmek yerine 400
    unknown = [r for r in payload.enabled_rule_ids if r not in BUILTIN_RULE_IDS]
    if unknown:
        raise HTTPException(400, f"Bilinmeyen kural id: {unknown}")

    # Eğer is_default seçildiyse aynı org'taki diğer profile'lardan default
    #bayrağını kaldır (DB'de unique partial index v2'de eklenecek).
    if payload.is_default:
        await db.execute(
            __import__('sqlalchemy').text(
                "UPDATE compliance_profiles SET is_default=false WHERE is_default=true"
            )
        )

    p = ComplianceProfile(
        name=payload.name,
        description=payload.description,
        enabled_rule_ids=payload.enabled_rule_ids,
        is_default=payload.is_default,
        created_by_id=current_user.id,
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    await log_action(db, current_user, "compliance_profile_created", "compliance_profile", p.id, p.name, request=request)
    return {"id": p.id, "name": p.name, "is_default": p.is_default}


@router.put("/profiles/{profile_id}")
async def update_profile(
    profile_id: int,
    payload: ProfilePayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    _require_security_audit_profile_manage(current_user)
    from app.models.compliance_profile import ComplianceProfile
    from app.services.security_audit_service import BUILTIN_RULE_IDS

    unknown = [r for r in payload.enabled_rule_ids if r not in BUILTIN_RULE_IDS]
    if unknown:
        raise HTTPException(400, f"Bilinmeyen kural id: {unknown}")

    p = (await db.execute(
        select(ComplianceProfile).where(ComplianceProfile.id == profile_id)
    )).scalar_one_or_none()
    if not p:
        raise HTTPException(404, "Profile bulunamadı")

    if payload.is_default and not p.is_default:
        await db.execute(
            __import__('sqlalchemy').text(
                "UPDATE compliance_profiles SET is_default=false WHERE is_default=true AND id <> :i"
            ), {"i": profile_id}
        )

    p.name = payload.name
    p.description = payload.description
    p.enabled_rule_ids = payload.enabled_rule_ids
    p.is_default = payload.is_default
    await db.commit()
    await log_action(db, current_user, "compliance_profile_updated", "compliance_profile", p.id, p.name, request=request)
    return {"id": p.id, "name": p.name}


@router.delete("/profiles/{profile_id}", status_code=204)
async def delete_profile(
    profile_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    _require_security_audit_profile_manage(current_user)
    from app.models.compliance_profile import ComplianceProfile
    p = (await db.execute(
        select(ComplianceProfile).where(ComplianceProfile.id == profile_id)
    )).scalar_one_or_none()
    if not p:
        raise HTTPException(404, "Profile bulunamadı")
    name = p.name
    await db.delete(p)
    await db.commit()
    await log_action(db, current_user, "compliance_profile_deleted", "compliance_profile", profile_id, name, request=request)


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats")
async def get_audit_stats(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    site: Optional[str] = Query(None),
):
    _require_security_audit_view(current_user)
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
    current_user: CurrentUser = None,
    site: Optional[str] = Query(None),
):
    """Stream latest security audit results as CSV."""
    _require_security_audit_view(current_user)
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
    if site:
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
    current_user: CurrentUser = None,
):
    _require_security_audit_view(current_user)
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
    current_user: CurrentUser = None,
):
    _require_security_audit_view(current_user)
    q = select(SecurityAudit).where(SecurityAudit.id == audit_id)
    audit = (await db.execute(q)).scalar_one_or_none()
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
    current_user: CurrentUser = None,
):
    _require_security_audit_view(current_user)
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
    current_user: CurrentUser = None,
):
    """Daily average compliance score across all successfully audited devices."""
    _require_security_audit_view(current_user)
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
    _require_security_audit_run(current_user)
    from app.workers.tasks.security_audit_tasks import run_security_audit
    from app.models.compliance_profile import ComplianceProfile

    # T8.4 — profile çözümlemesi:
    #   1. body.profile_id verildi → onu kullan
    #   2. verilmediyse → org'taki is_default=True profile'ı bul
    #   3. yoksa → None (audit eski davranış: tüm built-in kuralları çalıştır)
    enabled_rule_ids: Optional[list[str]] = None
    profile_name: Optional[str] = None
    target_pid = body.profile_id
    if target_pid is None:
        row = (await db.execute(
            select(ComplianceProfile).where(ComplianceProfile.is_default == True).limit(1)
        )).scalar_one_or_none()
        if row:
            target_pid = row.id
    if target_pid is not None:
        prof = (await db.execute(
            select(ComplianceProfile).where(ComplianceProfile.id == target_pid)
        )).scalar_one_or_none()
        if prof is None and body.profile_id is not None:
            raise HTTPException(400, "Belirtilen compliance profile bulunamadı")
        if prof is not None:
            enabled_rule_ids = list(prof.enabled_rule_ids or [])
            profile_name = prof.name

    if body.device_ids:
        q = select(Device.id).where(Device.id.in_(body.device_ids), Device.is_active == True)
        res = await db.execute(q)
        device_ids = [r[0] for r in res.all()]
    else:
        q = select(Device.id).where(Device.is_active == True)
        res = await db.execute(q)
        device_ids = [r[0] for r in res.all()]

    if not device_ids:
        raise HTTPException(400, "Aktif cihaz bulunamadı")

    task_name = f"Security Audit ({profile_name})" if profile_name else "Security Audit"
    task = Task(
        name=task_name,
        type=TaskType.MONITOR_POLL,
        status=TaskStatus.PENDING,
        device_ids=device_ids,
        total_devices=len(device_ids),
        created_by=current_user.id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    # Pass enabled_rule_ids as positional arg (Celery worker signature
    # updated to accept it as an optional 3rd arg with default=None).
    run_security_audit.apply_async(
        args=[task.id, device_ids, enabled_rule_ids],
        queue="monitor",
    )

    await log_action(
        db, current_user, "security_audit_run", "security_audit", str(task.id),
        f"{len(device_ids)} cihaz için güvenlik denetimi" + (f" — profile: {profile_name}" if profile_name else ""),
        request=request,
    )

    return {
        "task_id": task.id,
        "device_count": len(device_ids),
        "profile_id": target_pid,
        "profile_name": profile_name,
        "rule_count": len(enabled_rule_ids) if enabled_rule_ids is not None else None,
    }
