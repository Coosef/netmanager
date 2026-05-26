"""Terminal session audit — interaktif SSH session log'ları (T9 Tur 3A).

  GET  /api/v1/terminal-sessions                — sayfalı liste (filter:
                                                  user/device/status/text)
  GET  /api/v1/terminal-sessions/{session_id}   — detay (komutlar + excerpt)
  GET  /api/v1/terminal-sessions/_stats          — özet (KPI)

Yetki:
  - viewer / location_admin: kendi org/lokasyon kapsamında SELECT
  - org_admin: org'unun tüm session'ları
  - super_admin: hepsi
RLS politikası zaten org-scope; ek kullanıcı bazlı kısıt eklenmedi.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.terminal_session_log import TerminalSessionLog
from app.models.user import User

router = APIRouter()


def _serialize_list_item(row: TerminalSessionLog, user: Optional[User], device: Optional[Device]) -> dict[str, Any]:
    return {
        "session_id": row.session_id,
        "user_id": row.user_id,
        "username": user.username if user else None,
        "device_id": row.device_id,
        "device_hostname": device.hostname if device else None,
        "device_ip": device.ip_address if device else None,
        "client_ip": row.client_ip,
        "connection_path": row.connection_path,
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "ended_at": row.ended_at.isoformat() if row.ended_at else None,
        "duration_ms": row.duration_ms,
        "exit_reason": row.exit_reason,
        "commands_count": row.commands_count or 0,
        "input_bytes": row.input_bytes or 0,
        "output_bytes": row.output_bytes or 0,
        "ai_summary_status": row.ai_summary_status,
        "has_ai_summary": bool(row.ai_summary),
    }


def _serialize_detail(row: TerminalSessionLog, user: Optional[User], device: Optional[Device]) -> dict[str, Any]:
    base = _serialize_list_item(row, user, device)
    base.update({
        "user_agent": row.user_agent,
        "agent_id": row.agent_id,
        "commands_extracted": row.commands_extracted or [],
        "output_excerpt": row.output_excerpt,
        "ai_summary": row.ai_summary,
    })
    return base


@router.get("")
async def list_sessions(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user_id: Optional[int] = Query(None),
    device_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None, regex="^(active|closed)$"),
    search: Optional[str] = Query(None, max_length=200),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Sayfalı liste. RLS org/scope otomatik filtreliyor; ek `status` filter
    'active' (ended_at NULL) veya 'closed' yapabilir.

    search: hostname / username içinde ILIKE arama (basic).
    """
    q = select(TerminalSessionLog)
    if user_id is not None:
        q = q.where(TerminalSessionLog.user_id == user_id)
    if device_id is not None:
        q = q.where(TerminalSessionLog.device_id == device_id)
    if status == "active":
        q = q.where(TerminalSessionLog.ended_at.is_(None))
    elif status == "closed":
        q = q.where(TerminalSessionLog.ended_at.isnot(None))

    if search:
        like = f"%{search.lower()}%"
        # username / hostname için subquery — basic, devasa veri için optimize
        # edilebilir (özel index gerekirse sonraki turda).
        u_ids = select(User.id).where(func.lower(User.username).like(like))
        d_ids = select(Device.id).where(func.lower(Device.hostname).like(like))
        q = q.where(or_(
            TerminalSessionLog.user_id.in_(u_ids),
            TerminalSessionLog.device_id.in_(d_ids),
        ))

    total = (await db.execute(
        select(func.count()).select_from(q.subquery())
    )).scalar() or 0

    q = q.order_by(desc(TerminalSessionLog.started_at)).limit(limit).offset(offset)
    rows = (await db.execute(q)).scalars().all()

    # User/Device ları toplu çek
    user_ids = [r.user_id for r in rows if r.user_id]
    device_ids = [r.device_id for r in rows if r.device_id]
    users_map: dict[int, User] = {}
    devices_map: dict[int, Device] = {}
    if user_ids:
        users_map = {
            u.id: u for u in (await db.execute(
                select(User).where(User.id.in_(user_ids))
            )).scalars().all()
        }
    if device_ids:
        devices_map = {
            d.id: d for d in (await db.execute(
                select(Device).where(Device.id.in_(device_ids))
            )).scalars().all()
        }

    return {
        "items": [
            _serialize_list_item(r, users_map.get(r.user_id or 0), devices_map.get(r.device_id or 0))
            for r in rows
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/_stats")
async def session_stats(
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Üst KPI bar için: son 24sa içinde N session + N komut + ort süre."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    rows = (await db.execute(
        select(TerminalSessionLog).where(TerminalSessionLog.started_at >= cutoff)
    )).scalars().all()
    total_cmds = sum((r.commands_count or 0) for r in rows)
    completed = [r for r in rows if r.duration_ms]
    avg_ms = int(sum(r.duration_ms for r in completed) / len(completed)) if completed else 0
    active = sum(1 for r in rows if r.ended_at is None)
    return {
        "sessions_24h": len(rows),
        "commands_24h": total_cmds,
        "avg_duration_ms": avg_ms,
        "active_now": active,
    }


@router.get("/{session_id}")
async def get_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    row = (await db.execute(
        select(TerminalSessionLog).where(TerminalSessionLog.session_id == session_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Session bulunamadı")

    user = None
    if row.user_id:
        user = (await db.execute(select(User).where(User.id == row.user_id))).scalar_one_or_none()
    device = None
    if row.device_id:
        device = (await db.execute(select(Device).where(Device.id == row.device_id))).scalar_one_or_none()
    return _serialize_detail(row, user, device)
