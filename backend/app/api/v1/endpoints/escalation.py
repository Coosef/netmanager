"""
Escalation Rule CRUD + test/dry-run + notification log.

Endpoints:
  GET    /escalation-rules
  POST   /escalation-rules
  GET    /escalation-rules/logs
  GET    /escalation-rules/{id}
  PUT    /escalation-rules/{id}
  DELETE /escalation-rules/{id}
  POST   /escalation-rules/{id}/test
"""
from __future__ import annotations
import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.core.security import encrypt_credential, decrypt_credential_safe
from app.models.escalation_rule import EscalationRule, EscalationNotificationLog
from app.models.incident import Incident, IncidentState
from app.services.escalation_matcher import matches_rule
from app.services.escalation_sender import send_webhook

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class RuleCreate(BaseModel):
    name: str
    enabled: bool = True
    description: Optional[str] = None
    match_severity:    Optional[list[str]] = None
    match_event_types: Optional[list[str]] = None
    match_sources:     Optional[list[str]] = None
    min_duration_secs: Optional[int] = None
    match_states:      Optional[list[str]] = None
    webhook_type: str
    webhook_url: str
    webhook_headers: Optional[dict[str, str]] = None
    cooldown_secs: int = 3600


class RuleUpdate(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    description: Optional[str] = None
    match_severity:    Optional[list[str]] = None
    match_event_types: Optional[list[str]] = None
    match_sources:     Optional[list[str]] = None
    min_duration_secs: Optional[int] = None
    match_states:      Optional[list[str]] = None
    webhook_type: Optional[str] = None
    webhook_url: Optional[str] = None
    webhook_headers: Optional[dict[str, str]] = None
    cooldown_secs: Optional[int] = None


class RuleResponse(BaseModel):
    id: int
    name: str
    enabled: bool
    description: Optional[str]
    match_severity:    Optional[list[str]]
    match_event_types: Optional[list[str]]
    match_sources:     Optional[list[str]]
    min_duration_secs: Optional[int]
    match_states:      Optional[list[str]]
    webhook_type: str
    webhook_url: str
    # Headers masked — keys only
    webhook_header_keys: list[str]
    cooldown_secs: int
    created_at: datetime
    created_by: Optional[int]

    model_config = {"from_attributes": True}


class LogEntry(BaseModel):
    id: int
    rule_id: int
    incident_id: int
    channel: str
    status: str
    response_code: Optional[int]
    error_msg: Optional[str]
    sent_at: datetime

    model_config = {"from_attributes": True}


class LogListResponse(BaseModel):
    items: list[LogEntry]
    total: int
    offset: int
    limit: int


class TestResult(BaseModel):
    dry_run: bool
    incident_id: Optional[int]
    matched: bool
    success: Optional[bool]
    response_code: Optional[int]
    error_msg: Optional[str]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_response(rule: EscalationRule) -> RuleResponse:
    header_keys: list[str] = []
    if rule.webhook_headers:
        try:
            _raw = decrypt_credential_safe(rule.webhook_headers)
            header_keys = list(json.loads(_raw).keys()) if _raw else []
        except (json.JSONDecodeError, TypeError):
            pass
    return RuleResponse(
        id=rule.id,
        name=rule.name,
        enabled=rule.enabled,
        description=rule.description,
        match_severity=_parse_list(rule.match_severity),
        match_event_types=_parse_list(rule.match_event_types),
        match_sources=_parse_list(rule.match_sources),
        min_duration_secs=rule.min_duration_secs,
        match_states=_parse_list(rule.match_states),
        webhook_type=rule.webhook_type,
        webhook_url=rule.webhook_url,
        webhook_header_keys=header_keys,
        cooldown_secs=rule.cooldown_secs,
        created_at=rule.created_at,
        created_by=rule.created_by,
    )


def _parse_list(value: Optional[str]) -> Optional[list[str]]:
    if not value:
        return None
    try:
        result = json.loads(value)
        return result if isinstance(result, list) else None
    except (json.JSONDecodeError, TypeError):
        return None


def _apply_create(rule: EscalationRule, data: RuleCreate | RuleUpdate) -> None:
    for field in ("name", "enabled", "description", "min_duration_secs",
                  "webhook_type", "webhook_url", "cooldown_secs"):
        val = getattr(data, field, None)
        if val is not None:
            setattr(rule, field, val)
    for list_field in ("match_severity", "match_event_types", "match_sources", "match_states"):
        val = getattr(data, list_field, None)
        if val is not None:
            setattr(rule, list_field, json.dumps(val))
        elif isinstance(data, RuleCreate):
            setattr(rule, list_field, None)
    if data.webhook_headers is not None:
        rule.webhook_headers = encrypt_credential(json.dumps(data.webhook_headers))
    elif isinstance(data, RuleCreate):
        rule.webhook_headers = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("", response_model=list[RuleResponse])
async def list_rules(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    rules = (await db.execute(select(EscalationRule).order_by(EscalationRule.id))).scalars().all()
    return [_to_response(r) for r in rules]


@router.post("", response_model=RuleResponse, status_code=201)
async def create_rule(
    body: RuleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    rule = EscalationRule(created_by=getattr(current_user, "id", None))
    _apply_create(rule, body)
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return _to_response(rule)


@router.get("/logs", response_model=LogListResponse)
async def list_logs(
    rule_id:    Optional[int] = Query(default=None),
    incident_id: Optional[int] = Query(default=None),
    status:     Optional[str] = Query(default=None),
    limit:  int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    q = select(EscalationNotificationLog)
    if rule_id:
        q = q.where(EscalationNotificationLog.rule_id == rule_id)
    if incident_id:
        q = q.where(EscalationNotificationLog.incident_id == incident_id)
    if status:
        q = q.where(EscalationNotificationLog.status == status)

    total_q = select(func.count()).select_from(q.subquery())
    total = (await db.execute(total_q)).scalar_one()

    rows = (
        await db.execute(
            q.order_by(EscalationNotificationLog.sent_at.desc()).offset(offset).limit(limit)
        )
    ).scalars().all()

    return LogListResponse(items=list(rows), total=total, offset=offset, limit=limit)


@router.get("/{rule_id}", response_model=RuleResponse)
async def get_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    rule = await db.get(EscalationRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    return _to_response(rule)


@router.put("/{rule_id}", response_model=RuleResponse)
async def update_rule(
    rule_id: int,
    body: RuleUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    rule = await db.get(EscalationRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    _apply_create(rule, body)
    await db.commit()
    await db.refresh(rule)
    return _to_response(rule)


@router.delete("/{rule_id}", status_code=204)
async def delete_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    rule = await db.get(EscalationRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await db.delete(rule)
    await db.commit()


@router.post("/{rule_id}/test", response_model=TestResult)
async def test_rule(
    rule_id: int,
    dry_run: bool = Query(default=True),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """
    Find the most recent active incident that matches the rule and send a test notification.
    dry_run=true (default): log only, don't actually POST.
    dry_run=false: real POST (use to verify webhook connectivity).
    """
    rule = await db.get(EscalationRule, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")

    # Find a matching active incident
    incidents = (
        await db.execute(
            select(Incident)
            .where(Incident.state.in_(["OPEN", "DEGRADED"]))
            .order_by(Incident.opened_at.desc())
            .limit(100)
        )
    ).scalars().all()

    matched_incident: Optional[Incident] = None
    now = datetime.now(timezone.utc)
    for inc in incidents:
        if matches_rule(inc, rule, now=now):
            matched_incident = inc
            break

    if not matched_incident:
        # No active matching incident — return matched=False without sending
        return TestResult(
            dry_run=dry_run, incident_id=None,
            matched=False, success=None, response_code=None, error_msg=None,
        )

    success, code, err = await send_webhook(rule, matched_incident, dry_run=dry_run)

    # Log the test attempt
    log_entry = EscalationNotificationLog(
        rule_id=rule.id,
        incident_id=matched_incident.id,
        channel=rule.webhook_type,
        status="dry_run" if dry_run else ("sent" if success else "failed"),
        response_code=code,
        error_msg=err,
    )
    db.add(log_entry)
    await db.commit()

    return TestResult(
        dry_run=dry_run,
        incident_id=matched_incident.id,
        matched=True,
        success=success,
        response_code=code,
        error_msg=err,
    )
