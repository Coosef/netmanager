"""Port change auto-rollback task (T9 Tur 4 #8+E2).

Celery task: Bir port_change_rollbacks satırı oluşturulduktan 5 dakika
sonra status hala 'pending' ise inverse_cmds çalıştır ve status='rolled_back'
olarak işaretle. Kullanıcı zaman zarfında "Onayla" basarsa status='committed'
yapar; "Geri Al" basarsa anında hard-rollback yapar.

Bu task .apply_async(countdown=300) ile dispatch edilir; commit/cancel
edilirse status check ile no-op olur.
"""
import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select, update as sa_update

from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)


@celery_app.task(name="app.workers.tasks.port_rollback_tasks.apply_rollback_if_pending")
def apply_rollback_if_pending(rollback_id: int) -> dict:
    """5dk countdown sonrası tetiklenir."""
    return asyncio.run(_run(rollback_id))


async def _run(rollback_id: int) -> dict:
    from app.core.database import make_worker_session
    from app.models.device import Device
    from app.models.port_change_rollback import PortChangeRollback
    from app.services.ssh_manager import ssh_manager
    from sqlalchemy import text as _sql_text

    async with make_worker_session()() as db:
        # Worker context — super_admin bypass (cron-style)
        await db.execute(_sql_text("SELECT set_config('app.is_super_admin','on',true)"))

        row = (await db.execute(
            select(PortChangeRollback).where(PortChangeRollback.id == rollback_id)
        )).scalar_one_or_none()
        if row is None:
            log.info("port_rollback: row %s not found, skip", rollback_id)
            return {"status": "not_found"}
        if row.status != "pending":
            log.info("port_rollback: row %s status=%s (commit/cancel'd), skip",
                     rollback_id, row.status)
            return {"status": "skipped", "row_status": row.status}

        device = await db.get(Device, row.device_id)
        if device is None:
            row.status = "failed"
            row.rollback_output = "Device not found"
            row.completed_at = datetime.now(timezone.utc)
            await db.commit()
            return {"status": "failed", "reason": "device_not_found"}

        # Inverse cmds çalıştır
        try:
            result = await ssh_manager.send_config(device, list(row.rollback_cmds or []))
            row.rollback_output = (
                (result.output or "")[:2000] if result.success
                else f"FAIL: {result.error}"
            )
            row.status = "rolled_back" if result.success else "failed"
        except Exception as exc:
            log.warning("port_rollback: ssh_manager hata %s: %r", rollback_id, exc)
            row.rollback_output = f"Exception: {exc}"
            row.status = "failed"
        row.completed_at = datetime.now(timezone.utc)
        await db.commit()
        return {"status": row.status, "device_id": row.device_id}
