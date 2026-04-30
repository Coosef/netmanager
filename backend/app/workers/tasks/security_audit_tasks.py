"""Security audit Celery tasks."""
import asyncio
import concurrent.futures

from app.workers.celery_app import celery_app


def _run_async(coro):
    return asyncio.run(coro)


@celery_app.task(bind=True, name="app.workers.tasks.security_audit_tasks.run_security_audit")
def run_security_audit(self, task_id: int, device_ids: list[int]):
    async def _run():
        from datetime import datetime, timezone
        from sqlalchemy import select, update
        from app.core.database import make_worker_session
        from app.models.device import Device
        from app.models.security_audit import SecurityAudit
        from app.models.task import Task, TaskStatus
        from app.services.security_audit_service import run_device_audit
        from app.services.ssh_manager import ssh_manager

        async with make_worker_session()() as db:
            await db.execute(
                update(Task).where(Task.id == task_id).values(
                    status=TaskStatus.RUNNING,
                    started_at=datetime.now(timezone.utc),
                    celery_task_id=self.request.id,
                )
            )
            await db.commit()

            result = await db.execute(
                select(Device).where(Device.id.in_(device_ids), Device.is_active == True)
            )
            devices = result.scalars().all()

            success_count = 0
            failed_count = 0

            for device in devices:
                score, grade, findings, error = await run_device_audit(device, ssh_manager)
                audit = SecurityAudit(
                    device_id=device.id,
                    device_hostname=device.hostname,
                    score=score,
                    grade=grade,
                    findings=findings,
                    status="done" if not error else "error",
                    error=error,
                )
                db.add(audit)
                await db.commit()

                if error:
                    failed_count += 1
                else:
                    success_count += 1

            final_status = (
                TaskStatus.SUCCESS if failed_count == 0
                else TaskStatus.PARTIAL if success_count > 0
                else TaskStatus.FAILED
            )
            await db.execute(
                update(Task).where(Task.id == task_id).values(
                    status=final_status,
                    completed_devices=success_count,
                    failed_devices=failed_count,
                    completed_at=datetime.now(timezone.utc),
                )
            )
            await db.commit()

    _run_async(_run())


@celery_app.task(name="app.workers.tasks.security_audit_tasks.scheduled_compliance_scan")
def scheduled_compliance_scan():
    """Weekly beat task: run compliance audit on all active devices."""
    async def _run():
        from datetime import datetime, timezone
        from sqlalchemy import select
        from app.core.database import make_worker_session
        from app.models.device import Device
        from app.models.security_audit import SecurityAudit
        from app.services.security_audit_service import run_device_audit
        from app.services.ssh_manager import ssh_manager

        async with make_worker_session()() as db:
            result = await db.execute(
                select(Device).where(Device.is_active == True)
            )
            devices = result.scalars().all()

            for device in devices:
                try:
                    score, grade, findings, error = await run_device_audit(device, ssh_manager)
                    audit = SecurityAudit(
                        device_id=device.id,
                        device_hostname=device.hostname,
                        score=score,
                        grade=grade,
                        findings=findings,
                        status="done" if not error else "error",
                        error=error,
                    )
                    db.add(audit)
                    await db.commit()
                except Exception:
                    pass

    _run_async(_run())
