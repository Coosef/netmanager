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


# RBAC-SPRINT-2.2A (2026-07-01) — inline permission gates.
#
# Pre-2.2A all 4 endpoints were auth-only; frontend PermRoute(audit_logs,
# view) gated the /terminal-sessions page but a direct API call with a
# valid token would let any authenticated user list org-wide session
# transcripts and trigger the Claude summarize endpoint (which incurs
# LLM cost + exposes sensitive command output).
#
# The new terminal_sessions module gives the surface its own verbs:
#   - view       — GET list, /_stats, GET /{id} (read-only immutable
#                   audit trail; location_admin YES within org RLS)
#   - summarize  — POST /{id}/summarize (Claude AI call; cost + exposure
#                   gate; org_admin+ only per operator brief)
#
# The Alembic migration f9aj_rbac_authorization_hardening.py backfills
# every existing permission_set row: audit_logs.view=true carries over
# to terminal_sessions.view=true, and Tam Yetki / Org Admin templates
# gain both verbs = true.
def _require_terminal_sessions_view(user) -> None:
    if not user.has_permission("terminal_sessions:view"):
        raise HTTPException(403, "Permission denied: terminal_sessions.view")


def _require_terminal_sessions_summarize(user) -> None:
    if not user.has_permission("terminal_sessions:summarize"):
        raise HTTPException(403, "Permission denied: terminal_sessions.summarize")


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
    _require_terminal_sessions_view(current_user)
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
    _require_terminal_sessions_view(current_user)
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
    _require_terminal_sessions_view(current_user)
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


@router.post("/{session_id}/summarize")
async def summarize_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """T9 Tur 3B — AI ile session özetle (manuel trigger).

    Async olarak Claude API çağırır + ai_summary alanını doldurur.
    Tipik tamamlanma: 3-8 saniye (network + tokens).
    `ai_summary_status` durumlar:
      - 'pending'   → ilk insert (henüz çalışmamış)
      - 'running'   → bu çağrı sırasında
      - 'completed' → ai_summary text'i hazır
      - 'failed'    → exception (mesaj ai_summary alanına yazılır)
    """
    _require_terminal_sessions_summarize(current_user)
    row = (await db.execute(
        select(TerminalSessionLog).where(TerminalSessionLog.session_id == session_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Session bulunamadı")

    if row.ai_summary_status == "running":
        return {"status": "running", "note": "Özet üretimi zaten devam ediyor"}

    # 'running' olarak işaretle (lock — eş zamanlı tetiklemeleri engelle)
    row.ai_summary_status = "running"
    await db.commit()

    # User + device meta'sını al
    user = None
    if row.user_id:
        user = (await db.execute(select(User).where(User.id == row.user_id))).scalar_one_or_none()
    device = None
    if row.device_id:
        device = (await db.execute(select(Device).where(Device.id == row.device_id))).scalar_one_or_none()

    try:
        from app.services import ai_service as _ai
        result = await _ai.summarize_terminal_session(
            db,
            device_hostname=device.hostname if device else None,
            device_ip=device.ip_address if device else None,
            username=user.username if user else None,
            duration_ms=row.duration_ms,
            commands=row.commands_extracted or [],
            output_excerpt=row.output_excerpt,
        )
        summary_text = result.get("message", "")
        row.ai_summary = summary_text
        row.ai_summary_status = "completed"
        await db.commit()
        return {
            "status": "completed",
            "ai_summary": summary_text,
            "provider": result.get("provider"),
            "model": result.get("model"),
            "tokens_used": result.get("tokens_used"),
        }
    except ValueError as e:
        # AI provider configure değil veya geçersiz key
        row.ai_summary = f"[Hata] {e}"
        row.ai_summary_status = "failed"
        await db.commit()
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        row.ai_summary = f"[Hata] {e}"
        row.ai_summary_status = "failed"
        await db.commit()
        raise HTTPException(status_code=500, detail=f"AI özet üretilemedi: {e}")
