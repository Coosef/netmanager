import asyncio
import difflib
import hashlib
import json
from datetime import datetime, timezone

import redis
from sqlalchemy import select, update

from app.core.config import settings
from app.workers.celery_app import celery_app

_redis = redis.from_url(settings.REDIS_URL, decode_responses=True)


def _run_async(coro):
    return asyncio.run(coro)


def _get_db():
    from app.core.database import SyncSessionLocal
    return SyncSessionLocal()


@celery_app.task(name="app.workers.tasks.backup_tasks.backup_device_task")
def backup_device_task(device_id: int, created_by: int | None = None):
    """Take a single config backup for a device. Used by playbook backup step."""
    from app.models.config_backup import ConfigBackup
    from app.models.device import Device
    from app.services.ssh_manager import SSHManager

    db = _get_db()
    ssh = SSHManager()
    try:
        device = db.execute(select(Device).where(Device.id == device_id)).scalar_one_or_none()
        if not device:
            return {"success": False, "error": "Device not found"}

        ssh_result = _run_async(ssh.get_running_config(device))
        if not ssh_result.success:
            return {"success": False, "error": ssh_result.error}

        config_hash = hashlib.sha256(ssh_result.output.encode()).hexdigest()

        existing = db.execute(
            select(ConfigBackup)
            .where(ConfigBackup.device_id == device_id, ConfigBackup.config_hash == config_hash)
            .limit(1)
        ).scalar_one_or_none()
        if existing:
            return {"success": True, "skipped": True, "message": "Config unchanged"}

        backup = ConfigBackup(
            device_id=device_id,
            config_text=ssh_result.output,
            config_hash=config_hash,
            size_bytes=len(ssh_result.output.encode()),
            created_by=created_by,
        )
        db.add(backup)
        db.execute(
            update(Device).where(Device.id == device_id).values(last_backup=datetime.now(timezone.utc))
        )
        db.commit()
        db.refresh(backup)

        # Faz 6B G4: backup freshness changed → invalidate device risk cache
        try:
            import redis as _redis_lib
            from app.core.config import settings
            from app.services.cache_invalidation import invalidate_device_risk
            _inv_redis = _redis_lib.from_url(
                settings.REDIS_URL, decode_responses=True, socket_timeout=2,
            )
            invalidate_device_risk(_inv_redis, device_id)
        except Exception:
            pass  # invalidation is best-effort; never block backup completion

        return {"success": True, "backup_id": backup.id, "hash": config_hash}

    except Exception as exc:
        return {"success": False, "error": str(exc)}
    finally:
        _run_async(ssh.close_all())
        db.close()


@celery_app.task(bind=True, name="app.workers.tasks.backup_tasks.restore_backup_task",
                 soft_time_limit=900, time_limit=1200)
def restore_backup_task(self, task_id: int, device_id: int, backup_id: int,
                        created_by: int, reason: str | None = None):
    """T9 Tur 5 #12+E3 — Push a historic ConfigBackup back to a device.

    Flow: open SSH → take a fresh "pre-restore" snapshot (cheap insurance) →
    send_config the historic config → save running-config. Progress + result
    surface through the existing Task row so the FE can watch it like any
    bulk task.
    """
    from app.core.org_context import org_context
    from app.models.config_backup import ConfigBackup
    from app.models.device import Device
    from app.models.task import Task, TaskStatus
    from app.services.ssh_manager import SSHManager

    db = _get_db()
    ssh = SSHManager()
    pre_restore_id: int | None = None
    try:
        # Step 1: load device + target backup OUTSIDE org_context (we need
        # the FK values first) — RLS will let the rows through because the
        # caller already had access; if not, the SELECT returns None and
        # we fail fast.
        device = db.execute(select(Device).where(Device.id == device_id)).scalar_one_or_none()
        backup = db.execute(select(ConfigBackup).where(ConfigBackup.id == backup_id)).scalar_one_or_none()
        if not device or not backup or backup.device_id != device_id:
            _finalize_task(db, task_id, TaskStatus.FAILED, {
                "error": "Device or backup not found / mismatched",
            })
            return

        # Step 2: switch into the device's org/location for the rest — RLS
        # WITH CHECK passes; the new pre-restore ConfigBackup is stamped
        # with the right org/location by the before_insert hook.
        with org_context(device.organization_id, device.location_id):
            db.execute(
                update(Task).where(Task.id == task_id).values(
                    status=TaskStatus.RUNNING,
                    started_at=datetime.now(timezone.utc),
                    celery_task_id=self.request.id,
                )
            )
            db.commit()
            _publish_progress(task_id, 0, 0, TaskStatus.RUNNING, "pre_backup")

            # Step 3 — pre-restore snapshot (best-effort: failure here only
            # produces a warning; the restore can still proceed because the
            # target backup itself was once a snapshot).
            try:
                cur = _run_async(ssh.get_running_config(device))
                if cur.success and cur.output:
                    cur_hash = hashlib.sha256(cur.output.encode()).hexdigest()
                    # Skip if the device is already on this exact config.
                    if cur_hash == backup.config_hash:
                        _finalize_task(db, task_id, TaskStatus.SUCCESS, {
                            "device_id": device_id,
                            "hostname": device.hostname,
                            "backup_id": backup_id,
                            "pre_restore_backup_id": None,
                            "skipped": True,
                            "message": "Cihaz zaten bu konfigürasyonda — değişiklik yapılmadı.",
                            "reason": reason,
                        })
                        return
                    pre = ConfigBackup(
                        device_id=device_id,
                        config_text=cur.output,
                        config_hash=cur_hash,
                        size_bytes=len(cur.output.encode()),
                        created_by=created_by,
                        notes=f"PRE-RESTORE snapshot — restoring to backup #{backup_id}",
                    )
                    db.add(pre)
                    db.commit()
                    db.refresh(pre)
                    pre_restore_id = pre.id
            except Exception as snap_exc:  # noqa: BLE001
                # Non-fatal — we record the warning but continue.
                _publish_progress(task_id, 0, 0, TaskStatus.RUNNING,
                                  f"pre_backup_warn:{snap_exc}")

            _publish_progress(task_id, 0, 0, TaskStatus.RUNNING, "pushing_config")

            # Step 4 — push the backup. Drop banner / comment / blank lines
            # — they confuse send_config_set and don't carry semantic state.
            cfg_lines = [
                ln for ln in backup.config_text.splitlines()
                if ln.strip() and not ln.lstrip().startswith("!")
            ]
            if not cfg_lines:
                _finalize_task(db, task_id, TaskStatus.FAILED, {
                    "error": "Backup içerisinde gönderilebilir komut bulunamadı (boş veya yalnızca yorum).",
                    "pre_restore_backup_id": pre_restore_id,
                })
                return

            push_res = _run_async(ssh.send_config(device, cfg_lines))
            if not push_res.success:
                _finalize_task(db, task_id, TaskStatus.FAILED, {
                    "device_id": device_id,
                    "hostname": device.hostname,
                    "backup_id": backup_id,
                    "pre_restore_backup_id": pre_restore_id,
                    "error": f"SSH push failed: {push_res.error}",
                    "reason": reason,
                })
                return

            # Step 5 — save running-config (vendor-aware). send_config()
            # already calls save_config() on direct netmiko sessions; for
            # agent-relayed sessions we still send the explicit save.
            try:
                save_cmd = (
                    "copy running-config startup-config"
                    if device.os_type in ("cisco_ios", "cisco_nxos")
                    else "write memory"
                )
                _run_async(ssh.execute_command(device, save_cmd))
            except Exception:
                pass  # save failure is non-fatal — config is already running

            db.execute(
                update(Device).where(Device.id == device_id).values(
                    last_backup=datetime.now(timezone.utc)
                )
            )
            db.commit()

            _finalize_task(db, task_id, TaskStatus.SUCCESS, {
                "device_id": device_id,
                "hostname": device.hostname,
                "backup_id": backup_id,
                "pre_restore_backup_id": pre_restore_id,
                "output": (push_res.output or "")[:2000],
                "reason": reason,
            })

    except Exception as exc:  # noqa: BLE001
        _finalize_task(db, task_id, TaskStatus.FAILED, {
            "error": str(exc),
            "pre_restore_backup_id": pre_restore_id,
        })
    finally:
        try:
            _run_async(ssh.close_all())
        except Exception:
            pass
        db.close()


def _publish_progress(task_id: int, completed: int, failed: int, status: str,
                      phase: str | None = None) -> None:
    """T9 Tur 5 — surface restore phases to the WS task channel."""
    payload = {
        "task_id": task_id, "completed": completed,
        "failed": failed, "status": status,
    }
    if phase:
        payload["phase"] = phase
    try:
        _redis.publish(f"task:{task_id}:progress", json.dumps(payload))
    except Exception:
        pass


def _finalize_task(db, task_id: int, status: str, result: dict) -> None:
    """Set Task row to final status with the per-device result blob."""
    from app.models.task import Task

    total = 1
    completed = 1 if status == "success" else 0
    failed = 1 if status == "failed" else 0
    db.execute(
        update(Task).where(Task.id == task_id).values(
            status=status,
            result={str(result.get("device_id", "")): result},
            total_devices=total,
            completed_devices=completed,
            failed_devices=failed,
            completed_at=datetime.now(timezone.utc),
        )
    )
    db.commit()
    _publish_progress(task_id, completed, failed, status, "done")


@celery_app.task(name="app.workers.tasks.backup_tasks.check_config_drift")
def check_config_drift():
    """Daily task: compare each device's latest backup to its golden baseline; fire events on drift."""
    from app.models.config_backup import ConfigBackup
    from app.models.device import Device
    from app.workers.tasks.monitor_tasks import _save_event

    db = _get_db()
    try:
        devices = db.execute(select(Device).where(Device.is_active == True)).scalars().all()
        for device in devices:
            try:
                golden = db.execute(
                    select(ConfigBackup)
                    .where(ConfigBackup.device_id == device.id, ConfigBackup.is_golden == True)
                    .order_by(ConfigBackup.golden_set_at.desc())
                ).scalar_one_or_none()
                if not golden:
                    continue

                latest = db.execute(
                    select(ConfigBackup)
                    .where(ConfigBackup.device_id == device.id, ConfigBackup.id != golden.id)
                    .order_by(ConfigBackup.created_at.desc())
                ).scalar_one_or_none()
                if not latest or golden.config_hash == latest.config_hash:
                    continue

                diff = list(difflib.unified_diff(
                    golden.config_text.splitlines(keepends=True),
                    latest.config_text.splitlines(keepends=True),
                    n=0,
                ))
                added = sum(1 for ln in diff if ln.startswith("+") and not ln.startswith("+++"))
                removed = sum(1 for ln in diff if ln.startswith("-") and not ln.startswith("---"))

                _save_event(
                    db, device,
                    "config_drift", "warning",
                    f"{device.hostname} — Config Sapması Tespit Edildi",
                    f"Altın yapılandırmadan {added} satır eklendi, {removed} satır silindi.",
                    details={
                        "golden_id": golden.id,
                        "latest_id": latest.id,
                        "lines_added": added,
                        "lines_removed": removed,
                    },
                    dedup_key=f"drift:{device.id}:{latest.id}",
                    dedup_ttl=86400,
                )
            except Exception:
                pass
    finally:
        db.close()
