import time
from typing import Optional

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog
from app.models.user import User


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

    entry = AuditLog(
        user_id=user.id if user else None,
        username=user.username if user else "system",
        action=action,
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id else None,
        resource_name=resource_name,
        details=details,
        client_ip=client_ip,
        user_agent=user_agent,
        status=status,
        request_id=request_id,
        duration_ms=computed_duration_ms,
        before_state=before_state,
        after_state=after_state,
    )
    db.add(entry)
    await db.commit()
