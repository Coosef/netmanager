from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.notification import NotificationChannel
from app.services.audit_service import log_action

router = APIRouter()

VALID_TYPES = {"email", "slack", "telegram", "teams", "webhook"}
VALID_NOTIFY_ON = {
    "device_offline", "critical_event", "warning_event",
    "approval_request", "playbook_failure", "backup_failure", "any_event",
}


def _summary(ch: NotificationChannel) -> dict:
    # Mask sensitive config fields before returning
    cfg = dict(ch.config or {})
    if "smtp_password" in cfg:
        cfg["smtp_password"] = "••••••"
    if "bot_token" in cfg:
        cfg["bot_token"] = cfg["bot_token"][:8] + "••••••" if cfg["bot_token"] else ""
    return {
        "id": ch.id,
        "name": ch.name,
        "type": ch.type,
        "config": cfg,
        "notify_on": ch.notify_on,
        "is_active": ch.is_active,
        "created_at": ch.created_at.isoformat(),
    }


@router.get("", response_model=dict)
async def list_channels(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("approval:review"):
        raise HTTPException(403, "Admin only")
    result = await db.execute(
        select(NotificationChannel).order_by(NotificationChannel.created_at.asc())
    )
    channels = result.scalars().all()
    return {"total": len(channels), "items": [_summary(ch) for ch in channels]}


@router.post("", response_model=dict, status_code=201)
async def create_channel(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("approval:review"):
        raise HTTPException(403, "Admin only")

    body = await request.json()
    _validate(body)

    ch = NotificationChannel(
        name=body["name"],
        type=body["type"],
        config=body.get("config", {}),
        notify_on=body.get("notify_on", []),
        is_active=body.get("is_active", True),
    )
    db.add(ch)
    await db.commit()
    await db.refresh(ch)
    await log_action(db, current_user, "notification_channel_created", "notification", ch.id, ch.name, request=request)
    return _summary(ch)


@router.patch("/{channel_id}", response_model=dict)
async def update_channel(
    channel_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("approval:review"):
        raise HTTPException(403, "Admin only")

    ch = await _get_or_404(db, channel_id)
    body = await request.json()

    if "name" in body:
        ch.name = body["name"]
    if "type" in body:
        if body["type"] not in VALID_TYPES:
            raise HTTPException(400, f"Invalid type. Must be one of: {VALID_TYPES}")
        ch.type = body["type"]
    if "config" in body:
        # Merge config — keep existing password if masked value sent
        existing = dict(ch.config or {})
        for k, v in body["config"].items():
            if "••••••" not in str(v):
                existing[k] = v
        ch.config = existing
    if "notify_on" in body:
        invalid = set(body["notify_on"]) - VALID_NOTIFY_ON
        if invalid:
            raise HTTPException(400, f"Invalid notify_on values: {invalid}")
        ch.notify_on = body["notify_on"]
    if "is_active" in body:
        ch.is_active = bool(body["is_active"])

    await db.commit()
    await db.refresh(ch)
    await log_action(db, current_user, "notification_channel_updated", "notification", ch.id, ch.name, request=request)
    return _summary(ch)


@router.delete("/{channel_id}", status_code=204)
async def delete_channel(
    channel_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("approval:review"):
        raise HTTPException(403, "Admin only")
    ch = await _get_or_404(db, channel_id)
    await db.delete(ch)
    await db.commit()
    await log_action(db, current_user, "notification_channel_deleted", "notification", channel_id, ch.name, request=request)


@router.post("/{channel_id}/test", response_model=dict)
async def test_channel(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("approval:review"):
        raise HTTPException(403, "Admin only")

    ch = await _get_or_404(db, channel_id)
    from app.services.notification_service import send_channel
    ok, err = await send_channel(
        ch,
        "NetManager Test Bildirimi",
        f"Bu bir test mesajıdır. Kanal: {ch.name} ({ch.type})\nZaman: {datetime.now(timezone.utc).strftime('%d.%m.%Y %H:%M UTC')}",
    )
    return {"success": ok, "error": err}


@router.post("/send-weekly-digest", response_model=dict)
async def trigger_weekly_digest(
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("approval:review"):
        raise HTTPException(403, "Admin only")
    from app.workers.tasks.notification_tasks import send_weekly_digest
    send_weekly_digest.apply_async(queue="monitor")
    return {"status": "queued"}


# ── Helpers ──────────────────────────────────────────────────────────────────

async def _get_or_404(db, channel_id: int) -> NotificationChannel:
    result = await db.execute(
        select(NotificationChannel).where(NotificationChannel.id == channel_id)
    )
    ch = result.scalar_one_or_none()
    if not ch:
        raise HTTPException(404, "Channel not found")
    return ch


def _validate(body: dict):
    if not body.get("name"):
        raise HTTPException(400, "name is required")
    if body.get("type") not in VALID_TYPES:
        raise HTTPException(400, f"type must be one of: {VALID_TYPES}")
    invalid = set(body.get("notify_on", [])) - VALID_NOTIFY_ON
    if invalid:
        raise HTTPException(400, f"Invalid notify_on values: {invalid}")
