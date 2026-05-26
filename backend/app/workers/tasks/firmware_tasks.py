"""T9 Tur 8 — Firmware install worker.

State machine progresses through:
  pending → transferring → transferred → awaiting_reload → reloading →
  verifying → success / failed.

Reload is the operator-gated stop. The worker pauses at awaiting_reload
and exits cleanly; the operator approves via POST /firmware/jobs/{id}/approve-reload
which dispatches `resume_install_job` to finish the work.
"""
from __future__ import annotations

import asyncio
import logging
import os
import os.path
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select, update

from app.workers.celery_app import celery_app

log = logging.getLogger("netmanager.firmware")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@celery_app.task(bind=True,
                 name="app.workers.tasks.firmware_tasks.run_install_job",
                 soft_time_limit=1800, time_limit=2100)
def run_install_job(self, job_id: int):
    """Phase 1 — transfer + boot set + save. Stops at awaiting_reload."""
    asyncio.run(_run_phase1(self.request.id, job_id))


@celery_app.task(bind=True,
                 name="app.workers.tasks.firmware_tasks.resume_install_job",
                 soft_time_limit=1800, time_limit=2100)
def resume_install_job(self, job_id: int):
    """Phase 2 — reload + verify. Called after operator approves the reboot."""
    asyncio.run(_run_phase2(self.request.id, job_id))


# ─── Worker phases ─────────────────────────────────────────────────────────

async def _run_phase1(celery_id: str, job_id: int):
    from app.core.database import make_worker_session
    from app.core.org_context import org_context, superadmin_context
    from app.models.device import Device
    from app.models.firmware import FirmwareArtifact, FirmwareInstallJob
    from app.services.firmware_service import build_install_plan, extract_version
    from app.services.ssh_manager import ssh_manager

    factory = make_worker_session()
    async with factory() as db:
        with superadmin_context():
            job = (await db.execute(
                select(FirmwareInstallJob).where(FirmwareInstallJob.id == job_id)
            )).scalar_one_or_none()
        if job is None or job.status not in ("pending",):
            log.warning("firmware: phase1 — job %s missing or not pending", job_id)
            return

        with org_context(job.organization_id, job.location_id):
            device = (await db.execute(
                select(Device).where(Device.id == job.device_id)
            )).scalar_one_or_none()
            artifact = (await db.execute(
                select(FirmwareArtifact).where(FirmwareArtifact.id == job.artifact_id)
            )).scalar_one_or_none()
            if device is None or artifact is None:
                await _fail_job(db, job, "device veya artifact bulunamadı")
                return

            await _log(db, job, "transferring", "Pre-install version sorgulanıyor")
            await _set_status(db, job, "transferring", celery_id=celery_id)

            # 1. capture pre-version
            verify_out = await ssh_manager.execute_command(device, "show version")
            if verify_out.success:
                pre = extract_version(verify_out.output or "")
                if pre:
                    job.pre_version = pre
                    await db.commit()
                await _log(db, job, "transferring", f"Pre-version: {pre or 'bilinmiyor'}")

            # 2. build install plan
            source_url = artifact.source_url or ""
            file_basename = os.path.basename(source_url or artifact.file_path or "firmware.bin")
            try:
                plan = build_install_plan(
                    artifact.install_commands, device.os_type,
                    source_url=source_url, file_basename=file_basename,
                    transfer_method=job.transfer_method,
                )
            except ValueError as exc:
                await _fail_job(db, job, f"install plan üretilemedi: {exc}")
                return

            # 3. transfer
            await _log(db, job, "transferring", f"Dosya kopyalanıyor: {file_basename}")
            for cmd in plan.transfer_cmds:
                r = await ssh_manager.execute_command(device, cmd, read_timeout=600)
                await _log(db, job, "transferring", f"$ {cmd}", level="cmd")
                if not r.success:
                    await _fail_job(db, job, f"transfer failed: {r.error or 'unknown'}")
                    return
            await _set_status(db, job, "transferred")
            await _log(db, job, "transferred", "Dosya transferi başarılı")

            # 4. boot set
            for cmd in plan.boot_set_cmds:
                r = await ssh_manager.send_config(device, [cmd])
                await _log(db, job, "transferred", f"$ {cmd}", level="cmd")
                if not r.success:
                    await _fail_job(db, job, f"boot set failed: {r.error or 'unknown'}")
                    return

            # 5. save
            for cmd in plan.save_cmds:
                r = await ssh_manager.execute_command(device, cmd)
                await _log(db, job, "transferred", f"$ {cmd}", level="cmd")
                if not r.success:
                    await _log(db, job, "transferred",
                               f"save uyarısı: {r.error or 'unknown'}", level="warn")

            # 6. Stop here — operator approves the reload via POST.
            await _set_status(db, job, "awaiting_reload")
            await _log(
                db, job, "awaiting_reload",
                "Cihaz reload onayı bekliyor — onay sonrası reboot tetiklenir.",
                level="info",
            )


async def _run_phase2(celery_id: str, job_id: int):
    """Reload + post-version verification."""
    from app.core.database import make_worker_session
    from app.core.org_context import org_context, superadmin_context
    from app.models.device import Device
    from app.models.firmware import FirmwareArtifact, FirmwareInstallJob
    from app.services.firmware_service import build_install_plan, extract_version
    from app.services.ssh_manager import ssh_manager

    factory = make_worker_session()
    async with factory() as db:
        with superadmin_context():
            job = (await db.execute(
                select(FirmwareInstallJob).where(FirmwareInstallJob.id == job_id)
            )).scalar_one_or_none()
        if job is None or job.status != "awaiting_reload":
            log.warning("firmware: phase2 — job %s missing or not awaiting_reload", job_id)
            return
        if not job.reload_approved:
            log.warning("firmware: phase2 — job %s reload_approved=False, refusing", job_id)
            return

        with org_context(job.organization_id, job.location_id):
            device = (await db.execute(
                select(Device).where(Device.id == job.device_id)
            )).scalar_one_or_none()
            artifact = (await db.execute(
                select(FirmwareArtifact).where(FirmwareArtifact.id == job.artifact_id)
            )).scalar_one_or_none()
            if device is None or artifact is None:
                await _fail_job(db, job, "device veya artifact bulunamadı (phase2)")
                return

            try:
                plan = build_install_plan(
                    artifact.install_commands, device.os_type,
                    source_url=artifact.source_url or "",
                    file_basename=os.path.basename(
                        (artifact.source_url or artifact.file_path or "firmware.bin"),
                    ),
                    transfer_method=job.transfer_method,
                )
            except ValueError as exc:
                await _fail_job(db, job, f"phase2 install plan üretilemedi: {exc}")
                return

            await _set_status(db, job, "reloading", celery_id=celery_id)
            await _log(db, job, "reloading", "Reload komutu gönderiliyor — bağlantı düşecek")

            for cmd in plan.reload_cmds:
                # Reload kills the SSH session — failure here is expected.
                try:
                    await ssh_manager.execute_command(device, cmd, read_timeout=10)
                except Exception as exc:
                    await _log(db, job, "reloading", f"reload command exit ({exc})", level="info")

            # Wait for the device to come back. Poll show version up to ~6 min.
            await _set_status(db, job, "verifying")
            await _log(db, job, "verifying", "Cihaz dönüşü bekleniyor (180s grace)…")
            await asyncio.sleep(180)

            verified_version: Optional[str] = None
            for attempt in range(20):  # ~6 min more
                try:
                    r = await ssh_manager.execute_command(device, plan.verify_cmd, read_timeout=30)
                except Exception:
                    r = None
                if r and r.success and r.output:
                    verified_version = extract_version(r.output)
                    if verified_version:
                        break
                await asyncio.sleep(20)

            if verified_version:
                job.post_version = verified_version
                await db.commit()
                await _log(
                    db, job, "verifying",
                    f"Post-version: {verified_version}",
                )
                if (job.pre_version and verified_version == job.pre_version):
                    await _fail_job(
                        db, job,
                        f"Reload sonrası version değişmedi (pre={job.pre_version}); "
                        f"boot kaydı düşmüş olabilir.",
                    )
                    return
                await _set_status(db, job, "success",
                                  completed_at=datetime.now(timezone.utc))
                await _log(db, job, "success", "Firmware yüklemesi başarılı")
            else:
                await _fail_job(db, job, "Cihaza reload sonrası ulaşılamadı veya version okunamadı")


# ─── Helpers ───────────────────────────────────────────────────────────────

async def _set_status(db, job, status: str, *,
                      celery_id: Optional[str] = None,
                      completed_at: Optional[datetime] = None):
    job.status = status
    if status in ("transferring",) and job.started_at is None:
        job.started_at = datetime.now(timezone.utc)
    if celery_id is not None:
        job.celery_task_id = celery_id
    if completed_at is not None:
        job.completed_at = completed_at
    await db.commit()


async def _log(db, job, stage: str, message: str, *, level: str = "info"):
    entry = {"ts": _now_iso(), "stage": stage, "message": message, "level": level}
    job.log = (list(job.log or []) + [entry])
    await db.commit()


async def _fail_job(db, job, error: str):
    job.error = error
    job.status = "failed"
    job.completed_at = datetime.now(timezone.utc)
    await _log(db, job, "failed", error, level="error")
