import time
from datetime import datetime, timezone
from typing import Optional

import structlog
from fastapi import Request
from sqlalchemy import JSON, String, bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User

# T10 B4.3 — audit dual-emit logger. DB audit_logs kayıt-of-truth; bu logger
# (logging_config'te log_category=audit) aynı olayı SIEM/aggregator için
# structured log akışına yansıtır. Tam details/before/after DB'de kalır;
# log satırı SIEM-dostu kimlik alanlarını taşır.
_audit_log = structlog.get_logger("netmanager.audit")


async def log_action(
    db: AsyncSession,
    user: Optional[User],
    action: str,
    resource_type: Optional[str] = None,
    resource_id=None,
    resource_name: Optional[str] = None,
    details: Optional[dict] = None,
    status: str = "success",
    request: Optional[Request] = None,
    before_state: Optional[dict] = None,
    after_state: Optional[dict] = None,
    duration_ms: Optional[float] = None,
) -> None:
    client_ip = None
    user_agent = None
    request_id = None
    computed_duration_ms = duration_ms

    if request:
        # Prefer proxy-forwarded headers so the real client IP is recorded
        forwarded_for = request.headers.get("X-Forwarded-For")
        real_ip_header = request.headers.get("X-Real-IP")
        if forwarded_for:
            client_ip = forwarded_for.split(",")[0].strip()
        elif real_ip_header:
            client_ip = real_ip_header.strip()
        else:
            client_ip = request.client.host if request.client else None
        user_agent = request.headers.get("user-agent")
        request_id = getattr(request.state, "request_id", None)
        if computed_duration_ms is None and hasattr(request.state, "started_at"):
            computed_duration_ms = round((time.monotonic() - request.state.started_at) * 1000, 1)

    # M6 production-readiness fix — write via raw `text()` INSERT with no
    # RETURNING clause. The `audit_logs` RLS USING clause (Faz 7 phase 6c)
    # is intentionally strict — only super-admins / matching-org sessions
    # may SELECT. SQLAlchemy's ORM (`db.add()` + `commit()`) AND its Core
    # `insert()` both emit `INSERT … RETURNING audit_logs.id` to fetch the
    # SERIAL PK; the RETURNING re-reads the inserted row through USING,
    # which fails for two real call paths:
    #   1. login_failed audit  (NULL org + no GUC ⇒ NULL = NULL is NULL,
    #      not TRUE — USING rejects the read-back);
    #   2. login success audit (user.org_id ≠ NULL but the auth endpoint
    #      runs on the unscoped `get_db` session, so the GUC is still
    #      empty when log_action fires).
    # Companion migration f8a6 relaxed WITH CHECK to `true` so this write
    # succeeds; raw `text()` here skips RETURNING so the post-insert read
    # is never attempted. The audit row's `id` is never needed by callers
    # — `log_action` is fire-and-forget.
    organization_id = user.organization_id if user else None
    # Per-dialect JSON: native JSONB on Postgres for performance + index
    # support, generic JSON on SQLite (tests) so suite still passes.
    dialect = db.bind.dialect.name if db.bind else "sqlite"
    json_type = JSONB if dialect == "postgresql" else JSON
    stmt = text(
        "INSERT INTO audit_logs ("
        "  organization_id, user_id, username, action, resource_type,"
        "  resource_id, resource_name, details, client_ip, user_agent,"
        "  status, request_id, duration_ms, before_state, after_state, created_at"
        ") VALUES ("
        "  :organization_id, :user_id, :username, :action, :resource_type,"
        "  :resource_id, :resource_name, :details, :client_ip, :user_agent,"
        "  :status, :request_id, :duration_ms,"
        "  :before_state, :after_state, :created_at)"
    ).bindparams(
        bindparam("details", type_=JSON),
        bindparam("before_state", type_=json_type),
        bindparam("after_state", type_=json_type),
        bindparam("resource_id", type_=String),
        bindparam("username", type_=String),
    )
    await db.execute(
        stmt,
        {
            "organization_id": organization_id,
            "user_id": user.id if user else None,
            "username": user.username if user else "system",
            "action": action,
            "resource_type": resource_type,
            "resource_id": str(resource_id) if resource_id else None,
            "resource_name": resource_name,
            "details": details,
            "client_ip": client_ip,
            "user_agent": user_agent,
            "status": status,
            "request_id": request_id,
            "duration_ms": computed_duration_ms,
            "before_state": before_state,
            "after_state": after_state,
            "created_at": datetime.now(timezone.utc),
        },
    )
    await db.commit()

    # T10 B4.3 — DB yazımı (kayıt-of-truth) başarılı; aynı olayı log akışına
    # da yansıt (category=audit). Fire-and-forget: log hatası audit'i bozmaz.
    try:
        emit = _audit_log.info if status == "success" else _audit_log.warning
        emit(
            action,
            audit_action=action,
            status=status,
            username=user.username if user else "system",
            user_id=user.id if user else None,
            organization_id=organization_id,
            resource_type=resource_type,
            resource_id=str(resource_id) if resource_id else None,
            resource_name=resource_name,
            client_ip=client_ip,
            duration_ms=computed_duration_ms,
        )
    except Exception:  # noqa: BLE001 — audit logging asla çağıranı kırmaz
        pass
