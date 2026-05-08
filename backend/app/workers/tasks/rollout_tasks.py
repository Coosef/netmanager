import asyncio
import hashlib
from datetime import datetime, timezone

from sqlalchemy import select, update

from app.workers.celery_app import celery_app


def _run_async(coro):
    return asyncio.run(coro)


def _diff_configs(before: str, after: str) -> list[str]:
    """Return unified-style diff lines between two config strings."""
    import difflib
    return list(difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile="before",
        tofile="after",
        lineterm="",
    ))


@celery_app.task(bind=True, name="app.workers.tasks.rollout_tasks.execute_rollout_task")
def execute_rollout_task(self, rollout_id: int):
    async def _run():
        from app.core.database import make_worker_session
        from app.models.device import Device
        from app.models.config_template import ConfigTemplate
        from app.models.change_rollout import ChangeRollout
        from app.models.config_backup import ConfigBackup
        from app.services.ssh_manager import ssh_manager

        async with make_worker_session()() as db:
            rollout = (await db.execute(
                select(ChangeRollout).where(ChangeRollout.id == rollout_id)
            )).scalar_one_or_none()
            if not rollout:
                return

            await db.execute(
                update(ChangeRollout).where(ChangeRollout.id == rollout_id).values(
                    status="running",
                    started_at=datetime.now(timezone.utc),
                )
            )
            await db.commit()

            # Build command list
            commands: list[str] = []
            if rollout.raw_commands:
                commands = rollout.raw_commands
            elif rollout.template_id:
                tpl = (await db.execute(
                    select(ConfigTemplate).where(ConfigTemplate.id == rollout.template_id)
                )).scalar_one_or_none()
                if tpl:
                    variables = rollout.template_variables or {}
                    try:
                        rendered = tpl.template.format(**variables)
                        commands = [ln for ln in rendered.splitlines() if ln.strip()]
                    except KeyError as e:
                        await db.execute(
                            update(ChangeRollout).where(ChangeRollout.id == rollout_id).values(
                                status="failed",
                                completed_at=datetime.now(timezone.utc),
                                device_results={"error": f"Template variable missing: {e}"},
                            )
                        )
                        await db.commit()
                        return

            if not commands:
                await db.execute(
                    update(ChangeRollout).where(ChangeRollout.id == rollout_id).values(
                        status="failed",
                        completed_at=datetime.now(timezone.utc),
                        device_results={"error": "No commands to execute"},
                    )
                )
                await db.commit()
                return

            # Load devices
            devices = (await db.execute(
                select(Device).where(Device.id.in_(rollout.device_ids), Device.is_active == True)
            )).scalars().all()

            success_count = 0
            failed_count = 0
            device_results: dict[str, dict] = {}

            for device in devices:
                dev_key = str(device.id)
                backup_id = None
                before_config = None

                # Take before-backup
                try:
                    backup_result = await ssh_manager.get_running_config(device)
                    if backup_result.success and backup_result.output:
                        before_config = backup_result.output
                        cfg_hash = hashlib.sha256(before_config.encode()).hexdigest()
                        backup = ConfigBackup(
                            device_id=device.id,
                            config_text=before_config,
                            config_hash=cfg_hash,
                            size_bytes=len(before_config),
                            notes=f"Pre-rollout backup — rollout #{rollout_id}",
                            tenant_id=device.tenant_id,
                        )
                        db.add(backup)
                        await db.commit()
                        await db.refresh(backup)
                        backup_id = backup.id
                except Exception:
                    pass

                # Apply commands
                try:
                    apply_result = await ssh_manager.send_config(device, commands)
                    ok = apply_result.success
                    output = (apply_result.output or "")[:4096]
                    error = apply_result.error or None

                    if ok:
                        # Save to NVRAM best-effort
                        save_cmd = (
                            "copy running-config startup-config"
                            if device.os_type in ("cisco_ios", "cisco_nxos")
                            else "write memory"
                        )
                        await ssh_manager.execute_command(device, save_cmd)
                except Exception as exc:
                    ok = False
                    output = ""
                    error = str(exc)

                # Compute diff
                diff_lines: list[str] = []
                if ok and before_config:
                    try:
                        after_result = await ssh_manager.get_running_config(device)
                        if after_result.success and after_result.output:
                            diff_lines = _diff_configs(before_config, after_result.output)
                    except Exception:
                        pass

                device_results[dev_key] = {
                    "hostname": device.hostname,
                    "ip": device.ip_address,
                    "status": "success" if ok else "failed",
                    "backup_id": backup_id,
                    "output": output,
                    "error": error,
                    "diff": diff_lines[:200],  # cap at 200 diff lines
                }

                if ok:
                    success_count += 1
                else:
                    failed_count += 1

            final_status = "done" if failed_count == 0 else ("failed" if success_count == 0 else "partial")

            await db.execute(
                update(ChangeRollout).where(ChangeRollout.id == rollout_id).values(
                    status=final_status,
                    completed_at=datetime.now(timezone.utc),
                    device_results=device_results,
                    total_devices=len(devices),
                    success_devices=success_count,
                    failed_devices=failed_count,
                )
            )
            await db.commit()

            if final_status in ("failed", "partial"):
                await _notify_rollout_failure(db, rollout, rollout_id, final_status, failed_count, success_count, device_results)

    _run_async(_run())


async def _notify_rollout_failure(db, rollout, rollout_id: int, final_status: str, failed_count: int, success_count: int, device_results: dict) -> None:
    try:
        import json
        import redis as _redis_lib
        from sqlalchemy import select
        from app.core.config import settings
        from app.models.network_event import NetworkEvent
        from app.models.notification import NotificationChannel, NotificationLog
        from app.services.notification_service import send_channel

        _redis = _redis_lib.from_url(settings.REDIS_URL, decode_responses=True)

        label = "Başarısız" if success_count == 0 else "Kısmen Başarılı"
        name = getattr(rollout, "name", None) or f"Rollout #{rollout_id}"
        title = f"Config Rollout {label}: '{name}' — {failed_count} cihaz başarısız"
        failed_hosts = [v["hostname"] for v in device_results.values() if v.get("status") != "success"]
        message = "Başarısız cihazlar: " + ", ".join(failed_hosts[:10]) if failed_hosts else title

        evt = NetworkEvent(
            device_id=None,
            device_hostname=None,
            event_type="rollout_failure",
            severity="warning",
            title=title,
            message=message,
            details={"rollout_id": rollout_id, "rollout_name": name, "failed_count": failed_count, "failed_hosts": failed_hosts[:20]},
        )
        db.add(evt)
        await db.flush()

        channels = (await db.execute(
            select(NotificationChannel).where(NotificationChannel.is_active == True)
        )).scalars().all()

        for ch in channels:
            notify_on = ch.notify_on or []
            if "critical_event" not in notify_on and "warning_event" not in notify_on and "any_event" not in notify_on:
                continue
            ok, err = await send_channel(ch, f"[ROLLOUT] {title}", message)
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
            "event_type": "rollout_failure",
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


@celery_app.task(bind=True, name="app.workers.tasks.rollout_tasks.execute_rollback_task")
def execute_rollback_task(self, rollout_id: int):
    """Restore pre-rollout backup for each successfully applied device."""
    async def _run():
        from app.core.database import make_worker_session
        from app.models.device import Device
        from app.models.config_backup import ConfigBackup
        from app.models.change_rollout import ChangeRollout
        from app.services.ssh_manager import ssh_manager

        async with make_worker_session()() as db:
            rollout = (await db.execute(
                select(ChangeRollout).where(ChangeRollout.id == rollout_id)
            )).scalar_one_or_none()
            if not rollout or not rollout.device_results:
                return

            results = dict(rollout.device_results)
            rolled_back = 0
            failed_rollback = 0

            for dev_key, dev_data in results.items():
                backup_id = dev_data.get("backup_id")
                if not backup_id or dev_data.get("status") != "success":
                    continue

                try:
                    device = (await db.execute(
                        select(Device).where(Device.id == int(dev_key))
                    )).scalar_one_or_none()
                    backup = (await db.execute(
                        select(ConfigBackup).where(ConfigBackup.id == backup_id)
                    )).scalar_one_or_none()

                    if not device or not backup:
                        continue

                    # Push backup config lines via send_config
                    cfg_lines = [
                        ln for ln in backup.config_text.splitlines()
                        if ln.strip() and not ln.startswith("!")
                    ]
                    result = await ssh_manager.send_config(device, cfg_lines)
                    if result.success:
                        save_cmd = (
                            "copy running-config startup-config"
                            if device.os_type in ("cisco_ios", "cisco_nxos")
                            else "write memory"
                        )
                        await ssh_manager.execute_command(device, save_cmd)
                        results[dev_key]["status"] = "rolled_back"
                        rolled_back += 1
                    else:
                        results[dev_key]["rollback_error"] = result.error
                        failed_rollback += 1
                except Exception as exc:
                    results[dev_key]["rollback_error"] = str(exc)
                    failed_rollback += 1

            await db.execute(
                update(ChangeRollout).where(ChangeRollout.id == rollout_id).values(
                    status="rolled_back",
                    device_results=results,
                    rolled_back_devices=rolled_back,
                )
            )
            await db.commit()

    _run_async(_run())
