"""CRUD for interface utilization / error threshold alert rules."""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, TenantFilter
from app.models.alert_rule import AlertRule
from app.services.audit_service import log_action

router = APIRouter()

VALID_METRICS = {"in_util_pct", "out_util_pct", "max_util_pct", "error_rate"}
VALID_SEVERITIES = {"warning", "critical"}


def _serialize(rule: AlertRule) -> dict:
    return {
        "id": rule.id,
        "name": rule.name,
        "device_id": rule.device_id,
        "if_name_pattern": rule.if_name_pattern,
        "metric": rule.metric,
        "threshold_value": rule.threshold_value,
        "consecutive_count": rule.consecutive_count,
        "severity": rule.severity,
        "cooldown_minutes": rule.cooldown_minutes,
        "enabled": rule.enabled,
        "created_by": rule.created_by,
        "created_at": rule.created_at.isoformat() if rule.created_at else None,
    }


@router.get("", response_model=list)
async def list_rules(
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    q = select(AlertRule)
    if tenant_filter is not None:
        q = q.where(AlertRule.tenant_id == tenant_filter)
    result = await db.execute(q.order_by(AlertRule.id))
    return [_serialize(r) for r in result.scalars().all()]


@router.post("", response_model=dict, status_code=201)
async def create_rule(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(403, "Insufficient permissions")

    body = await request.json()
    _validate(body)

    rule = AlertRule(
        name=body["name"],
        device_id=body.get("device_id"),
        if_name_pattern=body.get("if_name_pattern") or None,
        metric=body.get("metric", "max_util_pct"),
        threshold_value=float(body["threshold_value"]),
        consecutive_count=int(body.get("consecutive_count", 2)),
        severity=body.get("severity", "warning"),
        cooldown_minutes=int(body.get("cooldown_minutes", 60)),
        enabled=bool(body.get("enabled", True)),
        created_by=current_user.id,
        tenant_id=current_user.tenant_id,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    await log_action(db, current_user, "alert_rule_created", "alert_rule", rule.id, rule.name, request=request)
    return _serialize(rule)


@router.patch("/{rule_id}", response_model=dict)
async def update_rule(
    rule_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(403, "Insufficient permissions")

    rule = await _get_or_404(db, rule_id, tenant_filter)
    body = await request.json()

    for field in ("name", "device_id", "if_name_pattern", "metric",
                  "threshold_value", "consecutive_count", "severity",
                  "cooldown_minutes", "enabled"):
        if field in body:
            val = body[field]
            if field == "threshold_value":
                val = float(val)
            elif field in ("consecutive_count", "cooldown_minutes"):
                val = int(val)
            elif field == "if_name_pattern":
                val = val or None
            setattr(rule, field, val)

    await db.commit()
    await db.refresh(rule)
    await log_action(db, current_user, "alert_rule_updated", "alert_rule", rule.id, rule.name, request=request)
    return _serialize(rule)


@router.delete("/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(403, "Insufficient permissions")

    rule = await _get_or_404(db, rule_id, tenant_filter)
    await db.delete(rule)
    await db.commit()
    await log_action(db, current_user, "alert_rule_deleted", "alert_rule", rule_id, rule.name, request=request)


async def _get_or_404(db: AsyncSession, rule_id: int, tenant_filter=None) -> AlertRule:
    q = select(AlertRule).where(AlertRule.id == rule_id)
    if tenant_filter is not None:
        q = q.where(AlertRule.tenant_id == tenant_filter)
    rule = (await db.execute(q)).scalar_one_or_none()
    if not rule:
        raise HTTPException(404, "Alert rule not found")
    return rule


def _validate(body: dict):
    if not body.get("name"):
        raise HTTPException(400, "name is required")
    if body.get("threshold_value") is None:
        raise HTTPException(400, "threshold_value is required")
    metric = body.get("metric", "max_util_pct")
    if metric not in VALID_METRICS:
        raise HTTPException(400, f"metric must be one of: {VALID_METRICS}")
    sev = body.get("severity", "warning")
    if sev not in VALID_SEVERITIES:
        raise HTTPException(400, f"severity must be one of: {VALID_SEVERITIES}")
