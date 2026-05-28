"""T9 Tur 3A follow-up — Terminal session stale cleanup.

WebSocket disconnect bazı tarayıcı/proxy kombinasyonlarında server'a
yansımayabilir (TCP yarı-açık, ya da ws revalidate task'i exception
yutar). Bu durumda TerminalSessionLog.ended_at NULL kalır ve UI hep
'Devam ediyor' gösterir.

Hourly beat: ended_at IS NULL + started_at > STALE_AFTER → ended_at=now,
exit_reason='stale_cleanup'. Komut/output buffer'lar zaten ilk close()
sırasında flush olmuştu (ya da loglanmadı, zaten kullanıcı oturum
kapanmamış sandı).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import update

from app.workers.celery_app import celery_app

log = logging.getLogger("netmanager.terminal")

# Bir oturum bu kadar süredir aktif görünüyorsa "muhtemelen kopmuş" sayılır.
# 30 dakika interactive shell için makul üst sınır; daha uzun gerçek
# kullanım olan operatörler için kolayca artırılabilir.
STALE_AFTER = timedelta(minutes=30)


@celery_app.task(name="app.workers.tasks.terminal_session_tasks.cleanup_stale_sessions",
                 soft_time_limit=120, time_limit=180)
def cleanup_stale_sessions():
    asyncio.run(_run())


async def _run():
    from app.core.database import make_worker_session
    from app.core.org_context import superadmin_context
    from app.models.terminal_session_log import TerminalSessionLog

    factory = make_worker_session()
    async with factory() as db:
        # T10 A2 — stale eşiği system_settings'ten (global scope, dakika);
        # kod sabiti (STALE_AFTER) fallback.
        from app.services import system_settings_service as _svc
        stale_min = int(await _svc.get(
            db, "session.terminal_stale_min", None,
        ))
        threshold = datetime.now(timezone.utc) - timedelta(minutes=stale_min)
        # Sweep tüm org'ları — kullanıcı yerine biz kapatıyoruz.
        with superadmin_context():
            result = await db.execute(
                update(TerminalSessionLog)
                .where(
                    TerminalSessionLog.ended_at.is_(None),
                    TerminalSessionLog.started_at < threshold,
                )
                .values(
                    ended_at=datetime.now(timezone.utc),
                    exit_reason="stale_cleanup",
                )
            )
            await db.commit()
            count = result.rowcount or 0
            if count:
                log.info(
                    "terminal: cleanup_stale_sessions kapattı %d eski oturum "
                    "(> %d dk)", count, stale_min,
                )
