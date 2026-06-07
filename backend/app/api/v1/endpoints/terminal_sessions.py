"""Terminal session audit — interaktif SSH session log'ları (T9 Tur 3A).

  GET  /api/v1/terminal-sessions                — sayfalı liste (filter:
                                                  user/device/status/text)
  GET  /api/v1/terminal-sessions/{session_id}   — detay (komutlar + excerpt)
  GET  /api/v1/terminal-sessions/_stats          — özet (KPI)
  POST /api/v1/terminal-sessions/{session_id}/terminate
       — admin force-close aktif SSH oturumu (SSH_SESSION_TERMINATION).

Yetki:
  - viewer / member: salt-okuma yok, kendi org/lokasyonu (RLS)
  - location_admin: kendi org+lokasyonunu görür ve terminate edebilir
  - org_admin: org'unun tüm session'ları + terminate
  - super_admin: hepsi + cross-org terminate (audit row session'ın org'una)
RLS politikası zaten org-scope; ek kullanıcı bazlı kısıt eklenmedi.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import and_, desc, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.terminal_session_log import TerminalSessionLog
from app.models.user import User
from app.services import audit_service

log = logging.getLogger("netmanager.terminal")

router = APIRouter()


# ── Pydantic schemas — SSH Session Termination ──────────────────────────────
class TerminateSessionRequest(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=256)


class TerminateSessionResponse(BaseModel):
    session_id: str
    status: Literal["terminated"]
    ended_at: datetime
    duration_seconds: int
    websocket_close_pending: bool
    audit_log_id: Optional[int] = None  # RETURNING kullanılmıyor → her zaman None


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


# ── SSH Session Termination ─────────────────────────────────────────────────
@router.post("/{session_id}/terminate", response_model=TerminateSessionResponse)
async def terminate_session(
    session_id: str,
    request: Request,
    body: Optional[TerminateSessionRequest] = None,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
) -> TerminateSessionResponse:
    """Admin aktif SSH oturumunu sonlandırır.

    Akış (tasarım dokümanı SSH_SESSION_TERMINATION_DESIGN.md §3):
      1. RBAC gate: ``terminal_sessions:terminate`` izni zorunlu
      2. RLS-scoped SELECT — org dışı session 404
      3. ``ended_at IS NOT NULL`` → 410 (idempotent / zaten kapalı)
      4. Redis pub/sub ``terminal:terminate`` publish (best-effort)
      5. DB UPDATE ``WHERE ended_at IS NULL`` race guard (stale_cleanup
         veya concurrent terminate ile çakışmayı önler)
      6. Audit log (cross-org için ``organization_id_override`` ile
         session'ın org'una stamp)
      7. Response — WS handler kendisini pub/sub mesajıyla kapatır
         (~<300ms latency)
    """
    if not current_user.has_permission("terminal_sessions:terminate"):
        raise HTTPException(
            status_code=403,
            detail="terminal_sessions:terminate izni yok",
        )

    # RLS-scoped SELECT — non super_admin için org filtre otomatik
    row = (await db.execute(
        select(TerminalSessionLog).where(TerminalSessionLog.session_id == session_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Session bulunamadı")

    # Idempotent / zaten kapalı
    if row.ended_at is not None:
        raise HTTPException(
            status_code=410,
            detail={
                "code": "session_already_closed",
                "ended_at": row.ended_at.isoformat(),
                "exit_reason": row.exit_reason,
            },
        )

    # Reason (opsiyonel) — default: tasarım §6
    reason = (body.reason if body else None) or "force_terminated_by_admin"

    ended_at = datetime.now(timezone.utc)
    # SQLite (test) timezone bilgisini düşürür; PostgreSQL TIMESTAMPTZ aware.
    # Portable kalmak için started_at naive ise UTC olarak yorumla.
    started_at_aware = row.started_at
    if started_at_aware.tzinfo is None:
        started_at_aware = started_at_aware.replace(tzinfo=timezone.utc)
    duration_ms = int((ended_at - started_at_aware).total_seconds() * 1000)

    # Redis pub/sub publish — best-effort. Down ise log + DB devam.
    try:
        from app.core.redis_client import publish as _redis_publish
        await _redis_publish("terminal:terminate", {
            "session_id": session_id,
            "reason": reason,
            "terminated_by_user_id": current_user.id,
            "terminated_by_username": current_user.username,
            "at": ended_at.isoformat(),
        })
        log.info(
            "ssh-term: terminate publish success",
            extra={
                "event": "ssh_term_publish",
                "session_id": session_id,
                "channel": "terminal:terminate",
            },
        )
    except Exception as exc:
        # Tasarım §10.7 — pub/sub fallback: WS 30sn revalidate ile kapanır
        log.warning(
            "ssh-term: Redis publish failed (continuing): %r", exc,
            extra={"event": "ssh_term_publish_failed", "session_id": session_id},
        )

    # HOTFIX (Bug #2) — pub/sub'a güvenmeyen direct agent close. Agent path
    # session'ı ise agent_manager._shell_sessions'tan kaldır + agent'a
    # ssh_shell_close gönder. Pub/sub mesajı listener'a ulaşmasa bile shell
    # transport kapanır → WS read loop EOF görür → finally çalışır.
    if row.agent_id:
        try:
            from app.services.agent_manager import agent_manager as _ag
            await _ag.close_shell_session(session_id)
            log.info(
                "ssh-term: direct agent close attempted",
                extra={
                    "event": "ssh_term_agent_close",
                    "session_id": session_id,
                    "agent_id": row.agent_id,
                },
            )
        except Exception as exc:
            log.warning(
                "ssh-term: agent close failed (continuing): %r", exc,
                extra={
                    "event": "ssh_term_agent_close_failed",
                    "session_id": session_id,
                    "agent_id": row.agent_id,
                },
            )

    # Race guard: WHERE ended_at IS NULL — concurrent terminate veya
    # stale_cleanup'tan önce davranıyorsak 1 row affected; aksi 0 → 410.
    upd = await db.execute(
        update(TerminalSessionLog)
        .where(
            TerminalSessionLog.session_id == session_id,
            TerminalSessionLog.ended_at.is_(None),
        )
        .values(
            ended_at=ended_at,
            exit_reason="force_closed",
            duration_ms=duration_ms,
        )
    )
    if upd.rowcount == 0:
        # Birisi (başka admin veya stale_cleanup beat) önce davrandı
        await db.rollback()
        raise HTTPException(
            status_code=410,
            detail={"code": "session_already_closed_during_race"},
        )
    await db.commit()

    # Audit log — cross-org: row.organization_id'ye stamp
    device = None
    if row.device_id:
        device = (await db.execute(
            select(Device).where(Device.id == row.device_id)
        )).scalar_one_or_none()
    session_user = None
    if row.user_id:
        session_user = (await db.execute(
            select(User).where(User.id == row.user_id)
        )).scalar_one_or_none()

    await audit_service.log_action(
        db,
        user=current_user,
        action="terminal_sessions.terminate",
        resource_type="terminal_session",
        resource_id=session_id,
        resource_name=device.hostname if device else None,
        details={
            "device_id": row.device_id,
            "device_name": device.hostname if device else None,
            "target_ip": device.ip_address if device else None,
            "session_user_id": row.user_id,
            "session_username": session_user.username if session_user else None,
            "terminated_by_user_id": current_user.id,
            "terminated_by_username": current_user.username,
            "termination_reason": reason,
            "started_at": started_at_aware.isoformat(),
            "terminated_at": ended_at.isoformat(),
            "duration_seconds": duration_ms // 1000,
            "agent_id": row.agent_id,
            "connection_path": row.connection_path,
            "commands_count_at_terminate": row.commands_count or 0,
            "input_bytes_at_terminate": row.input_bytes or 0,
            "output_bytes_at_terminate": row.output_bytes or 0,
        },
        before_state={
            "ended_at": None,
            "exit_reason": None,
            "status": "active",
        },
        after_state={
            "ended_at": ended_at.isoformat(),
            "exit_reason": "force_closed",
            "duration_ms": duration_ms,
            "status": "closed",
        },
        request=request,
        organization_id_override=row.organization_id,
    )

    return TerminateSessionResponse(
        session_id=session_id,
        status="terminated",
        ended_at=ended_at,
        duration_seconds=duration_ms // 1000,
        websocket_close_pending=True,
        audit_log_id=None,
    )
