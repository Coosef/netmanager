import asyncio
import difflib
import hashlib
from datetime import datetime, timezone

from sqlalchemy import select, update

from app.workers.celery_app import celery_app


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
            invalidate_device_risk(_inv_redis, device_id, tenant_id=device.tenant_id)
        except Exception:
            pass  # invalidation is best-effort; never block backup completion

        return {"success": True, "backup_id": backup.id, "hash": config_hash}

    except Exception as exc:
        return {"success": False, "error": str(exc)}
    finally:
        _run_async(ssh.close_all())
        db.close()


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
