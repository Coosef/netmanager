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
        import json
        from datetime import datetime, timezone
        from sqlalchemy import select
        import redis as _redis_lib
        from app.core.config import settings
        from app.core.database import make_worker_session
        from app.models.device import Device
        from app.models.network_event import NetworkEvent
        from app.models.notification import NotificationChannel, NotificationLog
        from app.models.security_audit import SecurityAudit
        from app.services.notification_service import send_channel
        from app.services.security_audit_service import run_device_audit
        from app.services.ssh_manager import ssh_manager

        _redis = _redis_lib.from_url(settings.REDIS_URL, decode_responses=True)
        critical: list[dict] = []  # score < 50 (grade D or F)

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

                    if not error and score < 50:
                        critical.append({
                            "device_id": device.id,
                            "hostname": device.hostname,
                            "score": score,
                            "grade": grade,
                        })
                except Exception:
                    pass

            if not critical:
                return

            title = f"Güvenlik Uyumu Kritik: {len(critical)} cihazda düşük skor"
            lines = [f"{c['hostname']}: {c['score']}/100 (Not: {c['grade']})" for c in critical[:10]]
            message = "\n".join(lines)
            now = datetime.now(timezone.utc)

            evt = NetworkEvent(
                device_id=None,
                device_hostname=None,
                event_type="security_audit_critical",
                severity="warning" if all(c["score"] >= 30 for c in critical) else "critical",
                title=title,
                message=message,
                details={"critical_count": len(critical), "devices": critical[:20]},
            )
            db.add(evt)
            await db.flush()

            channels = (await db.execute(
                select(NotificationChannel).where(NotificationChannel.is_active == True)
            )).scalars().all()

            for ch in channels:
                notify_on = ch.notify_on or []
                if "critical_event" not in notify_on and "any_event" not in notify_on:
                    continue
                ok, err = await send_channel(ch, f"[GÜVENLİK] {title}", message)
                db.add(NotificationLog(
                    channel_id=ch.id,
                    source_type="network_event",
                    source_id=evt.id,
                    success=ok,
                    error=err,
                ))

            await db.commit()

            payload = json.dumps({
                "device_id": None,
                "device_hostname": None,
                "event_type": "security_audit_critical",
                "severity": evt.severity,
                "title": title,
                "message": message,
                "ts": now.isoformat(),
            })
            _redis.publish("network:events", payload)
            _redis.lpush("network:events:recent", payload)
            _redis.ltrim("network:events:recent", 0, 499)

    _run_async(_run())
