"""T9 Tur 8 — Firmware management endpoints.

  /firmware/artifacts                       — catalog list + create
  /firmware/artifacts/upload                — multipart upload of .bin/.tar/.img
  /firmware/artifacts/{id}                  — GET / PATCH / DELETE
  /firmware/install                         — start a per-device install
  /firmware/jobs                            — list install jobs
  /firmware/jobs/{id}                       — GET (status + log)
  /firmware/jobs/{id}/approve-reload        — operator-gated reboot
  /firmware/jobs/{id}/cancel                — cancel a queued/awaiting job
"""
from __future__ import annotations

import hashlib
import os
import shutil
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Request, UploadFile,
)
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.deps import CurrentUser
from app.models.device import Device
from app.models.firmware import FirmwareArtifact, FirmwareInstallJob
from app.services.audit_service import log_action

router = APIRouter()

# Firmware uploads live on the backend volume. The dir is created on first
# use (so a fresh deploy that hasn't yet uploaded anything doesn't crash).
FIRMWARE_DIR = os.path.join(getattr(settings, "DATA_DIR", "/data"), "firmware")


# ─── Pydantic ───────────────────────────────────────────────────────────────

class ArtifactCreate(BaseModel):
    name: str
    version: str
    vendor: str
    os_type: str
    model: Optional[str] = None
    source_url: str  # for source_type='url' rows; ignored for uploads
    release_notes_url: Optional[str] = None
    release_date: Optional[datetime] = None
    severity: str = "maintenance"
    install_commands: Optional[dict] = None
    sha256: Optional[str] = None
    notes: Optional[str] = None


class ArtifactUpdate(BaseModel):
    name: Optional[str] = None
    version: Optional[str] = None
    model: Optional[str] = None
    release_notes_url: Optional[str] = None
    release_date: Optional[datetime] = None
    severity: Optional[str] = None
    install_commands: Optional[dict] = None
    notes: Optional[str] = None


class InstallStartRequest(BaseModel):
    artifact_id: int
    device_id: int
    transfer_method: str = "scp"
    reload_required: bool = True


class ReloadApproveRequest(BaseModel):
    confirm: bool = False


# ─── Serializers ────────────────────────────────────────────────────────────

def _artifact(a: FirmwareArtifact) -> dict:
    return {
        "id": a.id, "name": a.name, "version": a.version, "vendor": a.vendor,
        "os_type": a.os_type, "model": a.model,
        "source_type": a.source_type, "file_path": a.file_path,
        "source_url": a.source_url, "file_size_bytes": a.file_size_bytes,
        "sha256": a.sha256, "checksum_verified": a.checksum_verified,
        "release_notes_url": a.release_notes_url,
        "release_date": a.release_date.isoformat() if a.release_date else None,
        "severity": a.severity, "install_commands": a.install_commands,
        "notes": a.notes,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
        "deleted_at": a.deleted_at.isoformat() if a.deleted_at else None,
    }


def _job(j: FirmwareInstallJob) -> dict:
    return {
        "id": j.id, "artifact_id": j.artifact_id, "device_id": j.device_id,
        "status": j.status, "transfer_method": j.transfer_method,
        "pre_version": j.pre_version, "post_version": j.post_version,
        "reload_required": j.reload_required, "reload_approved": j.reload_approved,
        "reload_approved_by": j.reload_approved_by,
        "reload_approved_at": j.reload_approved_at.isoformat() if j.reload_approved_at else None,
        "error": j.error, "log": j.log or [],
        "celery_task_id": j.celery_task_id,
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "completed_at": j.completed_at.isoformat() if j.completed_at else None,
    }


# ─── Helpers ────────────────────────────────────────────────────────────────

async def _get_artifact_or_404(db: AsyncSession, artifact_id: int) -> FirmwareArtifact:
    a = (await db.execute(
        select(FirmwareArtifact).where(
            FirmwareArtifact.id == artifact_id,
            FirmwareArtifact.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if a is None:
        raise HTTPException(status_code=404, detail="Firmware artifact bulunamadı")
    return a


# ─── Artifact catalog ───────────────────────────────────────────────────────

@router.get("/artifacts")
async def list_artifacts(
    vendor: Optional[str] = None, os_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db), _: CurrentUser = None,
):
    q = select(FirmwareArtifact).where(FirmwareArtifact.deleted_at.is_(None))
    if vendor:
        q = q.where(FirmwareArtifact.vendor == vendor)
    if os_type:
        q = q.where(FirmwareArtifact.os_type == os_type)
    rows = (await db.execute(q.order_by(FirmwareArtifact.created_at.desc()))).scalars().all()
    return [_artifact(a) for a in rows]


@router.post("/artifacts", status_code=201)
async def create_artifact_url(
    body: ArtifactCreate, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    """Catalog a URL-sourced artifact (vendor server, S3, …). For a file
    upload use POST /artifacts/upload instead."""
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="device:edit yetkisi gerekli")
    if not body.source_url:
        raise HTTPException(status_code=400, detail="source_url gerekli")

    a = FirmwareArtifact(
        name=body.name, version=body.version, vendor=body.vendor,
        os_type=body.os_type, model=body.model,
        source_type="url", source_url=body.source_url,
        release_notes_url=body.release_notes_url,
        release_date=body.release_date, severity=body.severity,
        install_commands=body.install_commands, sha256=body.sha256,
        notes=body.notes, created_by=current_user.id,
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    await log_action(
        db, current_user, "firmware_artifact_created",
        "firmware_artifact", a.id, f"{a.name} {a.version}", request=request,
    )
    return _artifact(a)


@router.post("/artifacts/upload", status_code=201)
async def upload_artifact(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(...),
    version: str = Form(...),
    vendor: str = Form(...),
    os_type: str = Form(...),
    model: Optional[str] = Form(None),
    severity: str = Form("maintenance"),
    release_notes_url: Optional[str] = Form(None),
    notes: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    """Multipart upload — stores the file under FIRMWARE_DIR and computes sha256."""
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="device:edit yetkisi gerekli")

    os.makedirs(FIRMWARE_DIR, exist_ok=True)
    # Random suffix avoids collisions when two operators upload the same name.
    safe_name = "".join(c for c in (file.filename or "firmware") if c.isalnum() or c in ".-_")
    final_name = f"{uuid.uuid4().hex[:8]}_{safe_name}"
    dst = os.path.join(FIRMWARE_DIR, final_name)

    sha = hashlib.sha256()
    size = 0
    try:
        with open(dst, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                sha.update(chunk)
                size += len(chunk)
                out.write(chunk)
    except Exception:
        if os.path.exists(dst):
            os.remove(dst)
        raise HTTPException(status_code=500, detail="Yükleme başarısız")

    a = FirmwareArtifact(
        name=name, version=version, vendor=vendor, os_type=os_type, model=model,
        source_type="uploaded", file_path=dst,
        file_size_bytes=size, sha256=sha.hexdigest(), checksum_verified=True,
        release_notes_url=release_notes_url, severity=severity, notes=notes,
        created_by=current_user.id,
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    await log_action(
        db, current_user, "firmware_artifact_uploaded",
        "firmware_artifact", a.id, f"{a.name} {a.version} ({size // 1024} KB)",
        request=request,
        details={"size_bytes": size, "sha256": sha.hexdigest()},
    )
    return _artifact(a)


@router.patch("/artifacts/{artifact_id}")
async def update_artifact(
    artifact_id: int, body: ArtifactUpdate, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="device:edit yetkisi gerekli")
    a = await _get_artifact_or_404(db, artifact_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(a, field, value)
    await db.commit()
    await db.refresh(a)
    await log_action(
        db, current_user, "firmware_artifact_updated",
        "firmware_artifact", a.id, a.name, request=request,
    )
    return _artifact(a)


@router.delete("/artifacts/{artifact_id}", status_code=204)
async def delete_artifact(
    artifact_id: int, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(status_code=403, detail="device:edit yetkisi gerekli")
    a = await _get_artifact_or_404(db, artifact_id)
    # Refuse if there's an in-flight install job referencing this artifact.
    active = (await db.execute(
        select(FirmwareInstallJob).where(
            FirmwareInstallJob.artifact_id == artifact_id,
            FirmwareInstallJob.status.in_([
                "pending", "transferring", "transferred",
                "awaiting_reload", "reloading", "verifying",
            ]),
        )
    )).scalars().all()
    if active:
        raise HTTPException(
            status_code=409,
            detail=f"Bu artifact'i kullanan {len(active)} aktif install job var.",
        )
    a.deleted_at = datetime.now(timezone.utc)
    # If it was uploaded, delete the on-disk file (best-effort).
    if a.source_type == "uploaded" and a.file_path and os.path.exists(a.file_path):
        try:
            os.remove(a.file_path)
        except OSError:
            pass
    await db.commit()
    await log_action(
        db, current_user, "firmware_artifact_deleted",
        "firmware_artifact", artifact_id, a.name, request=request,
    )


# ─── Install jobs ──────────────────────────────────────────────────────────

@router.post("/install", status_code=202)
async def start_install(
    body: InstallStartRequest, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("config:push"):
        raise HTTPException(status_code=403, detail="config:push yetkisi gerekli")

    artifact = await _get_artifact_or_404(db, body.artifact_id)
    device = (await db.execute(
        select(Device).where(Device.id == body.device_id)
    )).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="Cihaz bulunamadı")
    if device.status == "offline":
        raise HTTPException(status_code=409, detail="Cihaz çevrimdışı — önce çevrimiçi yapın.")
    if artifact.os_type != device.os_type:
        raise HTTPException(
            status_code=400,
            detail=f"Artifact os_type ({artifact.os_type}) cihaz os_type ile uyuşmuyor ({device.os_type}).",
        )

    job = FirmwareInstallJob(
        artifact_id=artifact.id, device_id=device.id,
        transfer_method=body.transfer_method,
        reload_required=body.reload_required,
        status="pending",
        location_id=device.location_id,
        created_by=current_user.id,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    from app.workers.tasks.firmware_tasks import run_install_job
    run_install_job.delay(job.id)

    await log_action(
        db, current_user, "firmware_install_started",
        "device", device.id, device.hostname, request=request,
        details={
            "artifact_id": artifact.id, "artifact_version": artifact.version,
            "job_id": job.id, "transfer_method": body.transfer_method,
        },
    )
    return _job(job)


@router.get("/jobs")
async def list_jobs(
    status: Optional[str] = None, device_id: Optional[int] = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db), _: CurrentUser = None,
):
    q = select(FirmwareInstallJob).order_by(FirmwareInstallJob.created_at.desc())
    if status:
        q = q.where(FirmwareInstallJob.status == status)
    if device_id is not None:
        q = q.where(FirmwareInstallJob.device_id == device_id)
    rows = (await db.execute(q.limit(limit))).scalars().all()
    return [_job(j) for j in rows]


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: int, db: AsyncSession = Depends(get_db), _: CurrentUser = None,
):
    j = (await db.execute(
        select(FirmwareInstallJob).where(FirmwareInstallJob.id == job_id)
    )).scalar_one_or_none()
    if j is None:
        raise HTTPException(status_code=404, detail="Install job bulunamadı")
    return _job(j)


@router.post("/jobs/{job_id}/approve-reload")
async def approve_reload(
    job_id: int, body: ReloadApproveRequest, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    """Operator-gated reboot. Triggers phase-2 of the install worker
    (reload + post-version verify)."""
    if not current_user.has_permission("config:push"):
        raise HTTPException(status_code=403, detail="config:push yetkisi gerekli")
    if not body.confirm:
        raise HTTPException(status_code=400, detail="Reload onayı için confirm:true gerekli")

    j = (await db.execute(
        select(FirmwareInstallJob).where(FirmwareInstallJob.id == job_id)
    )).scalar_one_or_none()
    if j is None:
        raise HTTPException(status_code=404, detail="Install job bulunamadı")
    if j.status != "awaiting_reload":
        raise HTTPException(
            status_code=409,
            detail=f"Job şu anda '{j.status}' durumunda — reload onaylanamaz.",
        )

    j.reload_approved = True
    j.reload_approved_by = current_user.id
    j.reload_approved_at = datetime.now(timezone.utc)
    await db.commit()

    from app.workers.tasks.firmware_tasks import resume_install_job
    resume_install_job.delay(j.id)

    await log_action(
        db, current_user, "firmware_install_reload_approved",
        "device", j.device_id, None, request=request,
        details={"job_id": j.id},
    )
    return _job(j)


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(
    job_id: int, request: Request,
    db: AsyncSession = Depends(get_db), current_user: CurrentUser = None,
):
    if not current_user.has_permission("config:push"):
        raise HTTPException(status_code=403, detail="config:push yetkisi gerekli")
    j = (await db.execute(
        select(FirmwareInstallJob).where(FirmwareInstallJob.id == job_id)
    )).scalar_one_or_none()
    if j is None:
        raise HTTPException(status_code=404, detail="Install job bulunamadı")
    if j.status in ("success", "failed", "cancelled"):
        raise HTTPException(
            status_code=409,
            detail=f"Job '{j.status}' durumunda — iptal edilemez.",
        )
    j.status = "cancelled"
    j.completed_at = datetime.now(timezone.utc)
    j.error = (j.error or "") + " [cancelled by operator]"
    await db.commit()
    await log_action(
        db, current_user, "firmware_install_cancelled",
        "device", j.device_id, None, request=request,
        details={"job_id": j.id, "prev_status": j.status},
    )
    return _job(j)
