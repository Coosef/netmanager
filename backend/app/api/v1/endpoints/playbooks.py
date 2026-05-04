from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.deps import CurrentUser, TenantFilter
from app.models.device import Device, DeviceGroup
from app.models.playbook import Playbook, PlaybookRun
from app.services.audit_service import log_action

router = APIRouter()

# ── Built-in templates ───────────────────────────────────────────────────────

BUILTIN_TEMPLATES = [
    {
        "id": "offline_recheck",
        "name": "Offline Cihaz Yeniden Kontrol",
        "description": "SSH test yapar, cihaz hâlâ offline ise bildirim kanalına uyarı gönderir.",
        "trigger_type": "event",
        "trigger_event_type": "device_offline",
        "pre_run_backup": False,
        "schedule_interval_hours": 0,
        "icon": "ExclamationCircleOutlined",
        "steps": [
            {"type": "ssh_command", "command": "show version | include uptime", "description": "Cihaz erişim testi", "stop_on_error": False},
            {"type": "notify", "channel_id": None, "subject": "[NetManager] Cihaz Offline: {hostname}", "message": "Cihaz {hostname} ({ip}) SSH üzerinden erişilemiyor.", "description": "Offline bildirimi"},
        ],
    },
    {
        "id": "config_backup_diff",
        "name": "Config Yedek Yenile + Uyumluluk",
        "description": "Cihazın mevcut config'ini yedekler ve uyumluluk skorunu günceller.",
        "trigger_type": "manual",
        "trigger_event_type": None,
        "pre_run_backup": False,
        "schedule_interval_hours": 0,
        "icon": "DatabaseOutlined",
        "steps": [
            {"type": "backup", "description": "Config yedeği al"},
            {"type": "compliance_check", "description": "Uyumluluk taraması"},
        ],
    },
    {
        "id": "interface_error_scan",
        "name": "Interface Hata Taraması",
        "description": "Tüm interface'lerdeki hata sayaçlarını kontrol eder, bildirim gönderir.",
        "trigger_type": "scheduled",
        "trigger_event_type": None,
        "pre_run_backup": False,
        "schedule_interval_hours": 24,
        "icon": "AlertOutlined",
        "steps": [
            {"type": "ssh_command", "command": "show interfaces | include error", "description": "Interface hata taraması", "stop_on_error": False},
            {"type": "notify", "channel_id": None, "subject": "[NetManager] Interface Hata Raporu: {hostname}", "message": "Interface hata taraması tamamlandı: {hostname} ({ip})", "description": "Hata raporu bildirimi"},
        ],
    },
    {
        "id": "ntp_syslog_push",
        "name": "NTP/Syslog Standart Push",
        "description": "NTP ve Syslog sunucu adresini cihaza standart yapılandırma ile gönderir.",
        "trigger_type": "manual",
        "trigger_event_type": None,
        "pre_run_backup": True,
        "schedule_interval_hours": 0,
        "icon": "SyncOutlined",
        "steps": [
            {"type": "backup", "description": "Değişiklik öncesi yedek al"},
            {"type": "ssh_command", "command": "ntp server pool.ntp.org", "description": "NTP sunucu ayarla", "stop_on_error": True},
            {"type": "ssh_command", "command": "logging on", "description": "Syslog aktif et", "stop_on_error": False},
            {"type": "compliance_check", "description": "Uyumluluk doğrula"},
        ],
    },
    {
        "id": "vlan_rollout",
        "name": "VLAN Rollout",
        "description": "Çoklu cihaza VLAN oluşturma ve isim atama uygular.",
        "trigger_type": "manual",
        "trigger_event_type": None,
        "pre_run_backup": True,
        "schedule_interval_hours": 0,
        "icon": "NodeExpandOutlined",
        "steps": [
            {"type": "backup", "description": "Değişiklik öncesi yedek al"},
            {"type": "ssh_command", "command": "vlan 100", "description": "VLAN oluştur", "stop_on_error": True},
            {"type": "ssh_command", "command": "name NETMANAGER_VLAN", "description": "VLAN isim ayarla", "stop_on_error": False},
            {"type": "ssh_command", "command": "exit", "description": "Config modundan çık", "stop_on_error": False},
            {"type": "compliance_check", "description": "Uyumluluk doğrula"},
        ],
    },
    {
        "id": "compliance_fix",
        "name": "Uyumluluk İhlali Düzeltme",
        "description": "Güvenlik taraması yapar, kritik ihlalleri (Telnet, şifresiz config) düzeltir, yedek alır.",
        "trigger_type": "scheduled",
        "trigger_event_type": None,
        "pre_run_backup": True,
        "schedule_interval_hours": 168,
        "icon": "SafetyCertificateOutlined",
        "steps": [
            {"type": "compliance_check", "description": "Mevcut uyumluluk durumunu tara"},
            {"type": "ssh_command", "command": "no service telnet", "description": "Telnet'i kapat", "stop_on_error": False},
            {"type": "ssh_command", "command": "service password-encryption", "description": "Parola şifrelemeyi aktif et", "stop_on_error": False},
            {"type": "backup", "description": "Düzeltme sonrası yedek al"},
            {"type": "notify", "channel_id": None, "subject": "[NetManager] Uyumluluk Düzeltme: {hostname}", "message": "Uyumluluk düzeltme tamamlandı: {hostname} ({ip})", "description": "Tamamlama bildirimi"},
        ],
    },
]


# ── CRUD ────────────────────────────────────────────────────────────────────

@router.get("/templates", response_model=list)
async def list_playbook_templates(_: CurrentUser = None):
    """Return the list of built-in playbook templates."""
    return BUILTIN_TEMPLATES


@router.post("/from-template", response_model=dict, status_code=201)
async def create_from_template(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("task:create"):
        raise HTTPException(403, "Insufficient permissions")

    body = await request.json()
    template_id = body.get("template_id")
    tpl = next((t for t in BUILTIN_TEMPLATES if t["id"] == template_id), None)
    if not tpl:
        raise HTTPException(404, "Template not found")

    interval_hours = int(body.get("schedule_interval_hours") or tpl.get("schedule_interval_hours") or 0)
    trigger_type = tpl["trigger_type"]
    is_scheduled = trigger_type == "scheduled" and interval_hours > 0
    next_run = datetime.now(timezone.utc) + timedelta(hours=interval_hours) if is_scheduled else None

    pb = Playbook(
        name=body.get("name") or tpl["name"],
        description=body.get("description") or tpl["description"],
        steps=tpl["steps"],
        target_group_id=body.get("target_group_id"),
        target_device_ids=body.get("target_device_ids", []),
        trigger_type=trigger_type,
        trigger_event_type=tpl.get("trigger_event_type"),
        pre_run_backup=tpl.get("pre_run_backup", False),
        is_scheduled=is_scheduled,
        schedule_interval_hours=interval_hours,
        next_run_at=next_run,
        created_by=current_user.id,
        tenant_id=current_user.tenant_id,
    )
    db.add(pb)
    await db.commit()
    await db.refresh(pb)
    await log_action(db, current_user, "playbook_created_from_template", "playbook", pb.id, pb.name,
                     details={"template_id": template_id}, request=request)
    return _pb_detail(pb)


@router.get("", response_model=dict)
async def list_playbooks(
    db: AsyncSession = Depends(get_db),
    tenant_filter: TenantFilter = None,
    _: CurrentUser = None,
):
    q = select(Playbook).where(Playbook.is_active == True)
    if tenant_filter is not None:
        q = q.where(Playbook.tenant_id == tenant_filter)
    result = await db.execute(q.order_by(Playbook.created_at.desc()))
    playbooks = result.scalars().all()
    return {
        "total": len(playbooks),
        "items": [_pb_summary(pb) for pb in playbooks],
    }


@router.post("", response_model=dict, status_code=201)
async def create_playbook(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("task:create"):
        raise HTTPException(403, "Insufficient permissions")

    body = await request.json()
    _validate_body(body)

    interval_hours = int(body.get("schedule_interval_hours") or 0)
    trigger_type = body.get("trigger_type", "manual")
    is_scheduled = trigger_type == "scheduled" and interval_hours > 0
    next_run = datetime.now(timezone.utc) + timedelta(hours=interval_hours) if is_scheduled else None

    pb = Playbook(
        name=body["name"],
        description=body.get("description"),
        steps=body.get("steps", []),
        target_group_id=body.get("target_group_id"),
        target_device_ids=body.get("target_device_ids", []),
        is_scheduled=is_scheduled,
        schedule_interval_hours=interval_hours,
        next_run_at=next_run,
        trigger_type=trigger_type,
        trigger_event_type=body.get("trigger_event_type"),
        pre_run_backup=bool(body.get("pre_run_backup", False)),
        created_by=current_user.id,
        tenant_id=current_user.tenant_id,
    )
    db.add(pb)
    await db.commit()
    await db.refresh(pb)
    await log_action(db, current_user, "playbook_created", "playbook", pb.id, pb.name, request=request)
    return _pb_detail(pb)


@router.get("/{playbook_id}", response_model=dict)
async def get_playbook(
    playbook_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    pb = await _get_or_404(db, playbook_id, tenant_filter)
    return _pb_detail(pb)


@router.patch("/{playbook_id}", response_model=dict)
async def update_playbook(
    playbook_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    if not current_user.has_permission("task:create"):
        raise HTTPException(403, "Insufficient permissions")

    pb = await _get_or_404(db, playbook_id, tenant_filter)
    body = await request.json()

    for field in ("name", "description", "steps", "target_group_id", "target_device_ids",
                  "trigger_event_type", "pre_run_backup"):
        if field in body:
            setattr(pb, field, body[field])

    if "trigger_type" in body:
        pb.trigger_type = body["trigger_type"]

    interval_hours = int(body.get("schedule_interval_hours", pb.schedule_interval_hours) or 0)
    trigger_type = body.get("trigger_type", pb.trigger_type)
    is_scheduled = trigger_type == "scheduled" and interval_hours > 0
    pb.is_scheduled = is_scheduled
    pb.schedule_interval_hours = interval_hours
    if is_scheduled and not pb.next_run_at:
        pb.next_run_at = datetime.now(timezone.utc) + timedelta(hours=interval_hours)
    elif not is_scheduled:
        pb.next_run_at = None

    pb.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(pb)
    await log_action(db, current_user, "playbook_updated", "playbook", pb.id, pb.name, request=request)
    return _pb_detail(pb)


@router.delete("/{playbook_id}", status_code=204)
async def delete_playbook(
    playbook_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    if not current_user.has_permission("task:create"):
        raise HTTPException(403, "Insufficient permissions")

    pb = await _get_or_404(db, playbook_id, tenant_filter)
    pb.is_active = False
    await db.commit()
    await log_action(db, current_user, "playbook_deleted", "playbook", pb.id, pb.name, request=request)


# ── Run ─────────────────────────────────────────────────────────────────────

@router.post("/{playbook_id}/run", response_model=dict, status_code=202)
async def run_playbook(
    playbook_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    if not current_user.has_permission("task:create"):
        raise HTTPException(403, "Insufficient permissions")

    pb = await _get_or_404(db, playbook_id, tenant_filter)
    if not pb.steps:
        raise HTTPException(400, "Playbook has no steps")

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    dry_run: bool = bool(body.get("dry_run", False))

    # Resolve target devices
    device_ids = await _resolve_targets(db, pb)
    if not device_ids:
        raise HTTPException(400, "No target devices found for this playbook")

    run = PlaybookRun(
        playbook_id=pb.id,
        status="pending",
        triggered_by=current_user.id,
        triggered_by_username=current_user.username,
        total_devices=len(device_ids),
        is_dry_run=dry_run,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    from app.workers.tasks.playbook_tasks import execute_playbook_task
    execute_playbook_task.apply_async(
        args=[run.id, pb.id, device_ids, dry_run],
        queue="monitor",
    )

    action = "playbook_dry_run_started" if dry_run else "playbook_run_started"
    await log_action(db, current_user, action, "playbook", pb.id, pb.name,
                     details={"run_id": run.id, "device_count": len(device_ids), "dry_run": dry_run}, request=request)

    return {"run_id": run.id, "playbook_id": pb.id, "device_count": len(device_ids), "status": "accepted", "dry_run": dry_run}


@router.get("/{playbook_id}/runs", response_model=dict)
async def list_runs(
    playbook_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
    tenant_filter: TenantFilter = None,
):
    await _get_or_404(db, playbook_id, tenant_filter)
    result = await db.execute(
        select(PlaybookRun)
        .where(PlaybookRun.playbook_id == playbook_id)
        .order_by(PlaybookRun.created_at.desc())
        .limit(50)
    )
    runs = result.scalars().all()
    return {"total": len(runs), "items": [_run_summary(r) for r in runs]}


@router.get("/{playbook_id}/runs/{run_id}", response_model=dict)
async def get_run(
    playbook_id: int,
    run_id: int,
    db: AsyncSession = Depends(get_db),
    _: CurrentUser = None,
):
    result = await db.execute(
        select(PlaybookRun).where(
            PlaybookRun.id == run_id,
            PlaybookRun.playbook_id == playbook_id,
        )
    )
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(404, "Run not found")
    return _run_detail(run)


# ── Helpers ──────────────────────────────────────────────────────────────────

async def _get_or_404(db: AsyncSession, playbook_id: int, tenant_filter=None) -> Playbook:
    q = select(Playbook).where(Playbook.id == playbook_id, Playbook.is_active == True)
    if tenant_filter is not None:
        q = q.where(Playbook.tenant_id == tenant_filter)
    pb = (await db.execute(q)).scalar_one_or_none()
    if not pb:
        raise HTTPException(404, "Playbook not found")
    return pb


async def _resolve_targets(db: AsyncSession, pb: Playbook) -> list[int]:
    if pb.target_device_ids:
        return pb.target_device_ids
    query = select(Device.id).where(Device.is_active == True)
    if pb.target_group_id:
        query = query.where(Device.group_id == pb.target_group_id)
    result = await db.execute(query)
    return [row[0] for row in result.all()]


def _validate_body(body: dict):
    if not body.get("name"):
        raise HTTPException(400, "name is required")
    steps = body.get("steps", [])
    for i, step in enumerate(steps):
        step_type = step.get("type", "ssh_command")
        if step_type == "ssh_command" and not step.get("command"):
            raise HTTPException(400, f"Step {i+1}: command is required for ssh_command")
        if step_type == "notify" and not step.get("channel_id"):
            raise HTTPException(400, f"Step {i+1}: channel_id is required for notify step")
        if step_type == "condition_check":
            if not step.get("condition"):
                raise HTTPException(400, f"Step {i+1}: condition is required for condition_check")
            if step.get("on_true", "continue") not in ("continue",):
                raise HTTPException(400, f"Step {i+1}: on_true must be 'continue'")
            if step.get("on_false", "skip") not in ("skip", "abort"):
                raise HTTPException(400, f"Step {i+1}: on_false must be 'skip' or 'abort'")
    trigger_type = body.get("trigger_type", "manual")
    if trigger_type not in ("manual", "scheduled", "event"):
        raise HTTPException(400, "trigger_type must be manual, scheduled, or event")
    if trigger_type == "event" and not body.get("trigger_event_type"):
        raise HTTPException(400, "trigger_event_type is required when trigger_type is event")


def _pb_summary(pb: Playbook) -> dict:
    return {
        "id": pb.id,
        "name": pb.name,
        "description": pb.description,
        "step_count": len(pb.steps),
        "target_group_id": pb.target_group_id,
        "target_device_ids": pb.target_device_ids,
        "is_scheduled": pb.is_scheduled,
        "schedule_interval_hours": pb.schedule_interval_hours,
        "next_run_at": pb.next_run_at.isoformat() if pb.next_run_at else None,
        "trigger_type": pb.trigger_type,
        "trigger_event_type": pb.trigger_event_type,
        "pre_run_backup": pb.pre_run_backup,
        "created_at": pb.created_at.isoformat(),
        "updated_at": pb.updated_at.isoformat(),
    }


def _pb_detail(pb: Playbook) -> dict:
    return {**_pb_summary(pb), "steps": pb.steps}


def _run_summary(run: PlaybookRun) -> dict:
    return {
        "id": run.id,
        "playbook_id": run.playbook_id,
        "status": run.status,
        "is_dry_run": run.is_dry_run,
        "triggered_by_username": run.triggered_by_username,
        "total_devices": run.total_devices,
        "success_devices": run.success_devices,
        "failed_devices": run.failed_devices,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "created_at": run.created_at.isoformat(),
    }


def _run_detail(run: PlaybookRun) -> dict:
    return {**_run_summary(run), "device_results": run.device_results}
