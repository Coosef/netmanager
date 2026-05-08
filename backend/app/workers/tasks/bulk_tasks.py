import asyncio
import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any, List, Optional

import redis
from celery import current_task
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import decrypt_credential, encrypt_credential
from app.models.config_backup import ConfigBackup
from app.models.device import Device
from app.models.task import Task, TaskStatus
from app.services.ssh_manager import SSHManager
from app.workers.celery_app import celery_app

_redis = redis.from_url(settings.REDIS_URL, decode_responses=True)


def _get_db() -> Session:
    from app.core.database import SyncSessionLocal
    return SyncSessionLocal()


def _update_task_progress(db: Session, task_id: int, completed: int, failed: int, status: str):
    db.execute(
        update(Task)
        .where(Task.id == task_id)
        .values(
            completed_devices=completed,
            failed_devices=failed,
            status=status,
        )
    )
    db.commit()
    # Publish for WebSocket consumers
    _redis.publish(
        f"task:{task_id}:progress",
        json.dumps({"task_id": task_id, "completed": completed, "failed": failed, "status": status}),
    )


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@celery_app.task(bind=True, name="app.workers.tasks.bulk_tasks.run_bulk_command")
def run_bulk_command(self, task_id: int, device_ids: list[int], commands: list[str], is_config: bool = False):
    db = _get_db()
    ssh = SSHManager()
    results = {}
    completed = 0
    failed = 0

    try:
        db.execute(
            update(Task).where(Task.id == task_id).values(
                status=TaskStatus.RUNNING,
                started_at=datetime.now(timezone.utc),
                celery_task_id=self.request.id,
            )
        )
        db.commit()

        devices = db.execute(select(Device).where(Device.id.in_(device_ids))).scalars().all()

        for device in devices:
            device_result = {}
            all_ok = True
            for cmd in commands:
                try:
                    if is_config:
                        result = _run_async(ssh.send_config(device, [cmd]))
                    else:
                        result = _run_async(ssh.execute_command(device, cmd))
                    device_result[cmd] = {"success": result.success, "output": result.output, "error": result.error}
                    if not result.success:
                        all_ok = False
                except Exception as e:
                    device_result[cmd] = {"success": False, "output": "", "error": str(e)}
                    all_ok = False

            results[str(device.id)] = {"hostname": device.hostname, "commands": device_result, "success": all_ok}
            if all_ok:
                completed += 1
            else:
                failed += 1
            _update_task_progress(db, task_id, completed, failed, TaskStatus.RUNNING)

        final_status = TaskStatus.SUCCESS if failed == 0 else (
            TaskStatus.PARTIAL if completed > 0 else TaskStatus.FAILED
        )
        db.execute(
            update(Task).where(Task.id == task_id).values(
                status=final_status,
                result=results,
                completed_at=datetime.now(timezone.utc),
            )
        )
        db.commit()

    except Exception as e:
        db.execute(
            update(Task).where(Task.id == task_id).values(
                status=TaskStatus.FAILED,
                error=str(e),
                completed_at=datetime.now(timezone.utc),
            )
        )
        db.commit()
    finally:
        _run_async(ssh.close_all())
        db.close()


@celery_app.task(bind=True, name="app.workers.tasks.bulk_tasks.bulk_backup_configs")
def bulk_backup_configs(self, task_id: int, device_ids: list[int], created_by: int):
    db = _get_db()
    ssh = SSHManager()
    results = {}
    completed = 0
    failed = 0

    try:
        db.execute(
            update(Task).where(Task.id == task_id).values(
                status=TaskStatus.RUNNING,
                started_at=datetime.now(timezone.utc),
                celery_task_id=self.request.id,
            )
        )
        db.commit()

        devices = db.execute(select(Device).where(Device.id.in_(device_ids))).scalars().all()

        for device in devices:
            try:
                result = _run_async(ssh.get_running_config(device))
                if result.success and result.output:
                    config_hash = hashlib.sha256(result.output.encode()).hexdigest()
                    backup = ConfigBackup(
                        device_id=device.id,
                        config_text=result.output,
                        config_hash=config_hash,
                        size_bytes=len(result.output.encode()),
                        created_by=created_by,
                        task_id=task_id,
                        tenant_id=device.tenant_id,
                    )
                    db.add(backup)
                    db.execute(
                        update(Device).where(Device.id == device.id).values(
                            last_backup=datetime.now(timezone.utc)
                        )
                    )
                    db.commit()
                    results[str(device.id)] = {"hostname": device.hostname, "success": True, "hash": config_hash}
                    completed += 1
                else:
                    results[str(device.id)] = {"hostname": device.hostname, "success": False, "error": result.error}
                    failed += 1
            except Exception as e:
                results[str(device.id)] = {"hostname": device.hostname, "success": False, "error": str(e)}
                failed += 1
            _update_task_progress(db, task_id, completed, failed, TaskStatus.RUNNING)

        final_status = TaskStatus.SUCCESS if failed == 0 else (
            TaskStatus.PARTIAL if completed > 0 else TaskStatus.FAILED
        )
        db.execute(
            update(Task).where(Task.id == task_id).values(
                status=final_status,
                result=results,
                completed_at=datetime.now(timezone.utc),
            )
        )
        db.commit()

        # Notify on backup failures
        if failed > 0:
            _notify_backup_failures(db, failed, completed, results)

    except Exception as e:
        db.execute(
            update(Task).where(Task.id == task_id).values(
                status=TaskStatus.FAILED, error=str(e), completed_at=datetime.now(timezone.utc),
            )
        )
        db.commit()
    finally:
        _run_async(ssh.close_all())
        db.close()


def _notify_backup_failures(db: Session, failed: int, completed: int, results: dict) -> None:
    """Send backup_failure notifications and publish to real-time event stream."""
    try:
        from app.models.network_event import NetworkEvent
        from app.models.notification import NotificationChannel, NotificationLog
        from app.services.notification_service import send_channel as _send

        failed_hostnames = [
            v["hostname"] for v in results.values() if not v.get("success")
        ][:10]
        title = f"Yedekleme Hatası: {failed} cihaz başarısız"
        message = f"Başarısız: {', '.join(failed_hostnames)}{'...' if failed > 10 else ''}"

        evt = NetworkEvent(
            device_id=None,
            device_hostname=None,
            event_type="backup_failure",
            severity="warning",
            title=title,
            message=message,
            details={"failed": failed, "completed": completed, "failed_devices": failed_hostnames},
        )
        db.add(evt)
        db.flush()

        channels = db.execute(
            select(NotificationChannel).where(NotificationChannel.is_active == True)
        ).scalars().all()

        for ch in channels:
            notify_on = ch.notify_on or []
            if "backup_failure" not in notify_on and "any_event" not in notify_on:
                continue
            ok, err = _run_async(_send(ch, f"[UYARI] {title}", message))
            db.add(NotificationLog(
                channel_id=ch.id,
                source_type="network_event",
                source_id=evt.id,
                success=ok,
                error=err,
            ))

        db.commit()

        payload = json.dumps({
            "device_id": None,
            "device_hostname": None,
            "event_type": "backup_failure",
            "severity": "warning",
            "title": title,
            "message": message,
            "ts": datetime.now(timezone.utc).isoformat(),
        })
        _redis.publish("network:events", payload)
        _redis.lpush("network:events:recent", payload)
        _redis.ltrim("network:events:recent", 0, 499)
    except Exception:
        pass


@celery_app.task(bind=True, name="app.workers.tasks.bulk_tasks.bulk_password_change")
def bulk_password_change(self, task_id: int, device_ids: list[int], new_password: str, created_by: int):
    db = _get_db()
    ssh = SSHManager()
    results = {}
    completed = 0
    failed = 0

    try:
        db.execute(
            update(Task).where(Task.id == task_id).values(
                status=TaskStatus.RUNNING,
                started_at=datetime.now(timezone.utc),
                celery_task_id=self.request.id,
            )
        )
        db.commit()

        devices = db.execute(select(Device).where(Device.id.in_(device_ids))).scalars().all()

        for device in devices:
            try:
                username = device.ssh_username
                # Build vendor-specific password change commands
                commands = _build_password_change_commands(device.vendor, username, new_password)
                result = _run_async(ssh.send_config(device, commands))

                if result.success:
                    # Update stored credential
                    db.execute(
                        update(Device).where(Device.id == device.id).values(
                            ssh_password_enc=encrypt_credential(new_password)
                        )
                    )
                    db.commit()
                    results[str(device.id)] = {"hostname": device.hostname, "success": True}
                    completed += 1
                else:
                    results[str(device.id)] = {"hostname": device.hostname, "success": False, "error": result.error}
                    failed += 1
            except Exception as e:
                results[str(device.id)] = {"hostname": device.hostname, "success": False, "error": str(e)}
                failed += 1
            _update_task_progress(db, task_id, completed, failed, TaskStatus.RUNNING)

        final_status = TaskStatus.SUCCESS if failed == 0 else (
            TaskStatus.PARTIAL if completed > 0 else TaskStatus.FAILED
        )
        db.execute(
            update(Task).where(Task.id == task_id).values(
                status=final_status, result=results, completed_at=datetime.now(timezone.utc),
            )
        )
        db.commit()

    except Exception as e:
        db.execute(
            update(Task).where(Task.id == task_id).values(
                status=TaskStatus.FAILED, error=str(e), completed_at=datetime.now(timezone.utc),
            )
        )
        db.commit()
    finally:
        _run_async(ssh.close_all())
        db.close()


def _build_password_change_commands(vendor: str, username: str, new_password: str) -> list[str]:
    if vendor in ("cisco", "ruijie"):
        return [f"username {username} privilege 15 secret {new_password}"]
    elif vendor == "aruba":
        return [f"password manager user-name {username} plaintext {new_password}"]
    else:
        return [f"username {username} privilege 15 secret {new_password}"]


def _compute_next_run(
    schedule_type: str,
    run_hour: int,
    run_minute: int,
    days_of_week: Optional[List[int]],
    interval_hours: int,
    from_dt: Optional[datetime] = None,
) -> datetime:
    """Calculate the next execution time for a backup schedule."""
    now = from_dt or datetime.now(timezone.utc)

    if schedule_type == "interval":
        return now + timedelta(hours=max(1, interval_hours))

    # For daily/weekly: find next HH:MM that satisfies day constraints
    candidate = now.replace(hour=run_hour, minute=run_minute, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)

    if schedule_type == "weekly" and days_of_week:
        # Advance until we hit an allowed weekday (Monday=0)
        for _ in range(8):
            if candidate.weekday() in days_of_week:
                break
            candidate += timedelta(days=1)

    return candidate


def _get_devices_for_filter(db, device_filter: str, site: Optional[str]) -> List[int]:
    from app.models.config_backup import ConfigBackup
    from datetime import timedelta

    if device_filter == "all":
        devices = db.execute(select(Device).where(Device.is_active == True)).scalars().all()
        return [d.id for d in devices]

    if device_filter == "site" and site:
        devices = db.execute(
            select(Device).where(Device.is_active == True, Device.site == site)
        ).scalars().all()
        return [d.id for d in devices]

    # stale or never — need to check last_backup
    threshold = datetime.now(timezone.utc) - timedelta(days=7)
    devices = db.execute(select(Device).where(Device.is_active == True)).scalars().all()
    ids = []
    for d in devices:
        if device_filter == "never":
            if not d.last_backup:
                ids.append(d.id)
        elif device_filter == "stale":
            if not d.last_backup or d.last_backup < threshold:
                ids.append(d.id)
    return ids


def _trigger_schedule_backup_sync(device_filter: str, site: Optional[str], created_by: int) -> Optional[int]:
    """Synchronous version — called from Celery worker context."""
    from app.models.task import Task as TaskModel, TaskType, TaskStatus
    db = _get_db()
    try:
        device_ids = _get_devices_for_filter(db, device_filter, site)
        if not device_ids:
            return None

        task = TaskModel(
            name=f"Scheduled Backup ({device_filter})",
            type=TaskType.BACKUP_CONFIG,
            status=TaskStatus.PENDING,
            device_ids=device_ids,
            total_devices=len(device_ids),
            created_by=created_by,
        )
        db.add(task)
        db.commit()
        db.refresh(task)

        bulk_backup_configs.apply_async(
            args=[task.id, device_ids, created_by],
            queue="bulk",
        )
        return task.id
    finally:
        db.close()


async def _trigger_schedule_backup(device_filter: str, site: Optional[str], created_by: int) -> Optional[int]:
    """Async version — called from FastAPI endpoint (run-now)."""
    from app.models.task import Task as TaskModel, TaskType, TaskStatus
    from app.core.database import AsyncSessionLocal
    from sqlalchemy import select as aselect

    async with AsyncSessionLocal() as db:
        if device_filter == "all":
            result = await db.execute(aselect(Device).where(Device.is_active == True))
            devices = result.scalars().all()
            device_ids = [d.id for d in devices]
        elif device_filter == "site" and site:
            result = await db.execute(
                aselect(Device).where(Device.is_active == True, Device.site == site)
            )
            devices = result.scalars().all()
            device_ids = [d.id for d in devices]
        else:
            threshold = datetime.now(timezone.utc) - timedelta(days=7)
            result = await db.execute(aselect(Device).where(Device.is_active == True))
            devices = result.scalars().all()
            device_ids = []
            for d in devices:
                if device_filter == "never" and not d.last_backup:
                    device_ids.append(d.id)
                elif device_filter == "stale" and (not d.last_backup or d.last_backup < threshold):
                    device_ids.append(d.id)

        if not device_ids:
            return None

        task = TaskModel(
            name=f"Scheduled Backup ({device_filter})",
            type=TaskType.BACKUP_CONFIG,
            status=TaskStatus.PENDING,
            device_ids=device_ids,
            total_devices=len(device_ids),
            created_by=created_by,
        )
        db.add(task)
        await db.commit()
        await db.refresh(task)

        bulk_backup_configs.apply_async(
            args=[task.id, device_ids, created_by],
            queue="bulk",
        )
        return task.id


@celery_app.task(name="app.workers.tasks.bulk_tasks.check_backup_schedules")
def check_backup_schedules():
    """Runs every minute. Fires any backup schedules whose next_run_at has passed."""
    from app.models.backup_schedule import BackupSchedule

    db = _get_db()
    try:
        now = datetime.now(timezone.utc)
        due = db.execute(
            select(BackupSchedule).where(
                BackupSchedule.enabled == True,
                BackupSchedule.next_run_at <= now,
            )
        ).scalars().all()

        for schedule in due:
            try:
                dow = [int(x) for x in schedule.days_of_week.split(",") if x] if schedule.days_of_week else None
                task_id = _trigger_schedule_backup_sync(
                    schedule.device_filter,
                    schedule.site,
                    schedule.created_by or 1,
                )
                schedule.last_run_at = now
                schedule.last_task_id = task_id
                schedule.next_run_at = _compute_next_run(
                    schedule.schedule_type,
                    schedule.run_hour,
                    schedule.run_minute,
                    dow,
                    schedule.interval_hours,
                    from_dt=now,
                )
                db.commit()
            except Exception:
                pass
    finally:
        db.close()


@celery_app.task(name="app.workers.tasks.bulk_tasks.scheduled_backup")
def scheduled_backup():
    """Legacy daily fallback — only runs if no user-defined schedules exist."""
    from app.models.backup_schedule import BackupSchedule

    db = _get_db()
    try:
        count = db.execute(
            select(BackupSchedule).where(BackupSchedule.enabled == True, BackupSchedule.is_default == False)
        ).scalars().first()
        if count is not None:
            # User has custom schedules — skip the legacy run
            return

        from app.models.task import Task as TaskModel, TaskType, TaskStatus
        devices = db.execute(select(Device).where(Device.is_active == True)).scalars().all()
        device_ids = [d.id for d in devices]
        if not device_ids:
            return

        task = TaskModel(
            name="Scheduled Daily Backup (Default)",
            type=TaskType.BACKUP_CONFIG,
            status=TaskStatus.PENDING,
            device_ids=device_ids,
            total_devices=len(device_ids),
            created_by=1,
        )
        db.add(task)
        db.commit()
        db.refresh(task)

        bulk_backup_configs.apply_async(
            args=[task.id, device_ids, 1],
            queue="bulk",
        )
    finally:
        db.close()
