from datetime import datetime, timezone, timedelta
import ast
import asyncio
import operator

from sqlalchemy import select, update

from app.workers.celery_app import celery_app


# ── Safe AST condition evaluator ─────────────────────────────────────────────
# Evaluates simple boolean expressions with whitelist operators only.
# No eval(), no exec(). Supported: comparisons, AND/OR/NOT, literals.

_ALLOWED_OPS = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
}


def _eval_condition(node, ctx: dict):
    """Recursively evaluate an AST node against context dict."""
    if isinstance(node, ast.Expression):
        return _eval_condition(node.body, ctx)
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Attribute):
        obj = _eval_condition(node.value, ctx)
        if isinstance(obj, dict):
            return obj.get(node.attr)
        return None
    if isinstance(node, ast.Name):
        return ctx.get(node.id)
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            return all(_eval_condition(v, ctx) for v in node.values)
        if isinstance(node.op, ast.Or):
            return any(_eval_condition(v, ctx) for v in node.values)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return not _eval_condition(node.operand, ctx)
    if isinstance(node, ast.Compare):
        left = _eval_condition(node.left, ctx)
        for op, comparator in zip(node.ops, node.comparators):
            op_fn = _ALLOWED_OPS.get(type(op))
            if op_fn is None:
                raise ValueError(f"Unsupported operator: {type(op).__name__}")
            right = _eval_condition(comparator, ctx)
            try:
                if not op_fn(left, right):
                    return False
                left = right
            except TypeError:
                return False
        return True
    raise ValueError(f"Unsupported AST node: {type(node).__name__}")


def evaluate_condition(expression: str, ctx: dict) -> tuple[bool, str]:
    """
    Safely evaluate a condition string against context.
    Returns (result: bool, explanation: str).
    Raises ValueError on syntax/security errors.
    """
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"Syntax error in condition: {exc}") from exc

    # Security: reject any node type not in the safe set
    allowed_types = (
        ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.UnaryOp, ast.Not,
        ast.Compare, ast.Attribute, ast.Name, ast.Constant,
        ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
        ast.Load,
    )
    for node in ast.walk(tree):
        if not isinstance(node, allowed_types):
            raise ValueError(f"Disallowed node type in condition: {type(node).__name__}")

    result = bool(_eval_condition(tree, ctx))
    return result, f"'{expression}' → {'true' if result else 'false'} (ctx={ctx})"


def _run_async(coro):
    return asyncio.run(coro)


# ── Step executors ───────────────────────────────────────────────────────────

async def _exec_ssh_command(step: dict, device, ssh_manager, dry_run: bool) -> dict:
    command = step.get("command", "").strip()
    if dry_run:
        return {"success": True, "output": f"[DRY-RUN] would execute: {command}", "error": None, "simulated": True}
    try:
        result = await ssh_manager.execute_command(device, command)
        return {"success": result.success, "output": (result.output or "")[:2048], "error": result.error}
    except Exception as exc:
        return {"success": False, "output": "", "error": str(exc)}


async def _exec_backup(step: dict, device, dry_run: bool) -> dict:
    if dry_run:
        return {"success": True, "output": "[DRY-RUN] would take config backup", "error": None, "simulated": True}
    try:
        from app.workers.tasks.backup_tasks import backup_device_task
        backup_device_task.apply_async(args=[device.id], queue="monitor")
        return {"success": True, "output": f"Backup triggered for {device.hostname}", "error": None}
    except Exception as exc:
        return {"success": False, "output": "", "error": str(exc)}


async def _exec_compliance_check(step: dict, device, db, dry_run: bool) -> dict:
    if dry_run:
        return {"success": True, "output": "[DRY-RUN] would run compliance scan", "error": None, "simulated": True}
    try:
        from app.services.security_audit_service import run_security_audit
        audit_result = await run_security_audit(db, device)
        score = audit_result.get("score", 0)
        passed = audit_result.get("passed", 0)
        failed = audit_result.get("failed", 0)
        output = f"Compliance score: {score}/100 — {passed} passed, {failed} failed"
        return {"success": True, "output": output, "error": None, "score": score}
    except Exception as exc:
        return {"success": False, "output": "", "error": str(exc)}


async def _exec_notify(step: dict, device, db, dry_run: bool) -> dict:
    channel_id = step.get("channel_id")
    message = step.get("message", "Playbook notification")
    subject = step.get("subject", f"[NetManager] Playbook — {device.hostname}")
    if dry_run:
        return {"success": True, "output": f"[DRY-RUN] would notify channel {channel_id}: {subject}", "error": None, "simulated": True}
    if not channel_id:
        return {"success": False, "output": "", "error": "channel_id not specified"}
    try:
        from app.models.notification import NotificationChannel
        from app.services.notification_service import send_channel
        ch_result = await db.execute(select(NotificationChannel).where(NotificationChannel.id == channel_id))
        channel = ch_result.scalar_one_or_none()
        if not channel:
            return {"success": False, "output": "", "error": f"Channel {channel_id} not found"}
        body = message.replace("{hostname}", device.hostname).replace("{ip}", device.ip_address or "")
        ok, err = await send_channel(channel, subject, body)
        return {"success": ok, "output": f"Notification sent via {channel.name}" if ok else "", "error": err}
    except Exception as exc:
        return {"success": False, "output": "", "error": str(exc)}


async def _exec_condition_check(step: dict, device, db, dry_run: bool) -> dict:
    """
    AST-based condition evaluation. Builds context from device fields and recent events.
    on_true / on_false: 'continue' | 'skip' | 'abort'
    Returns success=True if condition met (continue), success=False otherwise.
    """
    expression = step.get("condition", "").strip()
    if not expression:
        return {"success": False, "output": "", "error": "condition expression is required", "condition_result": None}

    # Build evaluation context
    from app.models.network_event import NetworkEvent
    from sqlalchemy import select as _select
    now = datetime.now(timezone.utc)

    # Last offline event for this device
    last_offline = (await db.execute(
        _select(NetworkEvent)
        .where(NetworkEvent.device_id == device.id)
        .where(NetworkEvent.event_type == "device_offline")
        .order_by(NetworkEvent.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()

    offline_duration_min = 0
    if last_offline:
        offline_duration_min = int((now - last_offline.created_at).total_seconds() / 60)

    ctx = {
        "device": {
            "id": device.id,
            "hostname": device.hostname,
            "status": device.status if hasattr(device, 'status') else "unknown",
            "vendor": str(device.vendor) if hasattr(device, 'vendor') else "unknown",
            "offline_duration_min": offline_duration_min,
        },
        "time": {
            "hour": now.hour,
            "weekday": now.weekday(),  # 0=Mon, 6=Sun
            "is_business_hours": 8 <= now.hour < 18 and now.weekday() < 5,
        },
    }

    try:
        result, explanation = evaluate_condition(expression, ctx)
    except ValueError as exc:
        return {"success": False, "output": "", "error": str(exc), "condition_result": None}

    on_true = step.get("on_true", "continue")
    on_false = step.get("on_false", "skip")

    if dry_run:
        return {
            "success": True,
            "output": f"[DRY-RUN] Condition: {explanation} | on_true={on_true} on_false={on_false}",
            "error": None,
            "condition_result": result,
            "simulated": True,
        }

    if result:
        return {
            "success": True,
            "output": f"Koşul sağlandı → {on_true}: {explanation}",
            "error": None,
            "condition_result": True,
            "action": on_true,
        }
    else:
        # on_false=abort → success=False, stop_on_error will catch it
        # on_false=skip → success=True but mark skipped
        if on_false == "abort":
            return {
                "success": False,
                "output": f"Koşul sağlanmadı → abort: {explanation}",
                "error": "Condition not met — playbook aborted",
                "condition_result": False,
                "action": "abort",
            }
        else:  # skip
            return {
                "success": True,
                "output": f"Koşul sağlanmadı → skip: {explanation}",
                "error": None,
                "condition_result": False,
                "action": "skip",
                "skipped": True,
            }


async def _exec_wait(step: dict, dry_run: bool) -> dict:
    seconds = int(step.get("seconds", 5))
    if dry_run:
        return {"success": True, "output": f"[DRY-RUN] would wait {seconds}s", "error": None, "simulated": True}
    await asyncio.sleep(min(seconds, 300))
    return {"success": True, "output": f"Waited {seconds}s", "error": None}


async def _exec_step(step: dict, device, db, ssh_manager, dry_run: bool) -> dict:
    step_type = step.get("type", "ssh_command")
    base = {"type": step_type, "description": step.get("description", ""), "command": step.get("command", "")}
    if step_type == "ssh_command":
        result = await _exec_ssh_command(step, device, ssh_manager, dry_run)
    elif step_type == "backup":
        result = await _exec_backup(step, device, dry_run)
    elif step_type == "compliance_check":
        result = await _exec_compliance_check(step, device, db, dry_run)
    elif step_type == "notify":
        result = await _exec_notify(step, device, db, dry_run)
    elif step_type == "wait":
        result = await _exec_wait(step, dry_run)
    elif step_type == "condition_check":
        result = await _exec_condition_check(step, device, db, dry_run)
    else:
        result = {"success": False, "output": "", "error": f"Unknown step type: {step_type}"}
    return {**base, **result}


# ── Main task ────────────────────────────────────────────────────────────────

@celery_app.task(bind=True, name="app.workers.tasks.playbook_tasks.execute_playbook_task")
def execute_playbook_task(self, run_id: int, playbook_id: int, device_ids: list[int], dry_run: bool = False):
    async def _run():
        from app.core.database import make_worker_session
        from app.models.device import Device
        from app.models.playbook import Playbook, PlaybookRun
        from app.services.ssh_manager import ssh_manager

        async with make_worker_session()() as db:
            await db.execute(
                update(PlaybookRun).where(PlaybookRun.id == run_id).values(
                    status="running",
                    started_at=datetime.now(timezone.utc),
                )
            )
            await db.commit()

            pb_result = await db.execute(select(Playbook).where(Playbook.id == playbook_id))
            pb = pb_result.scalar_one_or_none()
            if not pb:
                await db.execute(
                    update(PlaybookRun).where(PlaybookRun.id == run_id).values(
                        status="failed",
                        completed_at=datetime.now(timezone.utc),
                        device_results={"error": "Playbook not found"},
                    )
                )
                await db.commit()
                return

            dev_result = await db.execute(
                select(Device).where(Device.id.in_(device_ids), Device.is_active == True)
            )
            devices = dev_result.scalars().all()

            success_count = 0
            failed_count = 0
            device_results: dict[str, dict] = {}

            for device in devices:
                dev_key = str(device.id)
                step_results = []
                device_ok = True

                # Pre-run backup (rollback point)
                if pb.pre_run_backup and not dry_run:
                    try:
                        from app.workers.tasks.backup_tasks import backup_device_task
                        backup_device_task.apply_async(args=[device.id], queue="monitor")
                        step_results.append({
                            "type": "pre_run_backup",
                            "description": "Rollback noktası yedeği",
                            "command": "",
                            "success": True,
                            "output": "Pre-run backup triggered",
                            "error": None,
                        })
                    except Exception as exc:
                        step_results.append({
                            "type": "pre_run_backup",
                            "description": "Rollback noktası yedeği",
                            "command": "",
                            "success": False,
                            "output": "",
                            "error": str(exc),
                        })

                for step in pb.steps:
                    step_result = await _exec_step(step, device, db, ssh_manager, dry_run)
                    step_results.append(step_result)
                    if not step_result["success"]:
                        device_ok = False
                        if step.get("stop_on_error", False):
                            break

                device_results[dev_key] = {
                    "hostname": device.hostname,
                    "ip": device.ip_address,
                    "steps": step_results,
                    "ok": device_ok,
                }

                if device_ok:
                    success_count += 1
                else:
                    failed_count += 1

            if dry_run:
                final_status = "dry_run"
            elif failed_count == 0:
                final_status = "success"
            elif success_count > 0:
                final_status = "partial"
            else:
                final_status = "failed"

            await db.execute(
                update(PlaybookRun).where(PlaybookRun.id == run_id).values(
                    status=final_status,
                    success_devices=success_count,
                    failed_devices=failed_count,
                    device_results=device_results,
                    completed_at=datetime.now(timezone.utc),
                )
            )
            await db.commit()

            if final_status in ("failed", "partial") and not dry_run:
                await _notify_playbook_failure(db, pb, run_id, failed_count, success_count, device_results)

    _run_async(_run())


async def _notify_playbook_failure(db, pb, run_id: int, failed_count: int, success_count: int, device_results: dict) -> None:
    try:
        import json
        import redis as _redis_lib
        from app.core.config import settings
        from app.models.network_event import NetworkEvent
        from app.models.notification import NotificationChannel, NotificationLog
        from app.services.notification_service import send_channel

        _redis = _redis_lib.from_url(settings.REDIS_URL, decode_responses=True)

        status_label = "başarısız" if success_count == 0 else "kısmen başarısız"
        title = f"Playbook Hatası: '{pb.name}' — {failed_count} cihaz {status_label}"
        failed_hosts = [v["hostname"] for v in device_results.values() if not v.get("ok")]
        message = "Başarısız cihazlar: " + ", ".join(failed_hosts[:10]) if failed_hosts else title

        evt = NetworkEvent(
            device_id=None,
            device_hostname=None,
            event_type="playbook_failure",
            severity="warning",
            title=title,
            message=message,
            details={"run_id": run_id, "playbook_name": pb.name, "failed_count": failed_count, "failed_hosts": failed_hosts[:20]},
        )
        db.add(evt)
        await db.flush()

        channels = (await db.execute(
            select(NotificationChannel).where(NotificationChannel.is_active == True)
        )).scalars().all()

        for ch in channels:
            notify_on = ch.notify_on or []
            if "playbook_failure" not in notify_on and "any_event" not in notify_on:
                continue
            ok, err = await send_channel(ch, f"[PLAYBOOK] {title}", message)
            db.add(NotificationLog(
                channel_id=ch.id,
                source_type="network_event",
                source_id=evt.id,
                success=ok,
                error=err,
            ))

        await db.commit()

        now = datetime.now(timezone.utc)
        payload = json.dumps({
            "device_id": None,
            "device_hostname": None,
            "event_type": "playbook_failure",
            "severity": "warning",
            "title": title,
            "message": message,
            "ts": now.isoformat(),
        })
        _redis.publish("network:events", payload)
        _redis.lpush("network:events:recent", payload)
        _redis.ltrim("network:events:recent", 0, 499)
    except Exception:
        pass


# ── Scheduled trigger ────────────────────────────────────────────────────────

@celery_app.task(name="app.workers.tasks.playbook_tasks.run_scheduled_playbooks")
def run_scheduled_playbooks():
    """Check for due scheduled playbooks and trigger them."""
    async def _run():
        from app.core.database import make_worker_session
        from app.models.playbook import Playbook, PlaybookRun

        now = datetime.now(timezone.utc)
        async with make_worker_session()() as db:
            result = await db.execute(
                select(Playbook).where(
                    Playbook.is_active == True,
                    Playbook.is_scheduled == True,
                    Playbook.schedule_interval_hours > 0,
                    Playbook.next_run_at <= now,
                )
            )
            due = result.scalars().all()

            for pb in due:
                from app.models.device import Device
                dev_result = await db.execute(
                    select(Device.id).where(Device.is_active == True)
                    if not pb.target_group_id and not pb.target_device_ids
                    else (
                        select(Device.id).where(Device.group_id == pb.target_group_id, Device.is_active == True)
                        if pb.target_group_id
                        else select(Device.id).where(Device.id.in_(pb.target_device_ids), Device.is_active == True)
                    )
                )
                device_ids = [r[0] for r in dev_result.all()]
                if not device_ids:
                    continue

                run = PlaybookRun(
                    playbook_id=pb.id,
                    status="pending",
                    triggered_by=pb.created_by,
                    triggered_by_username="scheduler",
                    total_devices=len(device_ids),
                    is_dry_run=False,
                )
                db.add(run)
                await db.flush()

                pb.next_run_at = now + timedelta(hours=pb.schedule_interval_hours)
                await db.commit()
                await db.refresh(run)

                execute_playbook_task.apply_async(
                    args=[run.id, pb.id, device_ids, False],
                    queue="monitor",
                )

    _run_async(_run())


# ── Event-based trigger ──────────────────────────────────────────────────────

@celery_app.task(name="app.workers.tasks.playbook_tasks.trigger_event_playbooks")
def trigger_event_playbooks(event_type: str, device_id: int | None):
    """Called when a network event fires; runs any playbooks listening to that event_type."""
    async def _run():
        from app.core.database import make_worker_session
        from app.models.playbook import Playbook, PlaybookRun

        async with make_worker_session()() as db:
            result = await db.execute(
                select(Playbook).where(
                    Playbook.is_active == True,
                    Playbook.trigger_type == "event",
                    Playbook.trigger_event_type == event_type,
                )
            )
            playbooks = result.scalars().all()
            if not playbooks:
                return

            for pb in playbooks:
                target_ids = await _resolve_event_targets(db, pb, device_id)
                if not target_ids:
                    continue

                run = PlaybookRun(
                    playbook_id=pb.id,
                    status="pending",
                    triggered_by=pb.created_by,
                    triggered_by_username=f"event:{event_type}",
                    total_devices=len(target_ids),
                    is_dry_run=False,
                )
                db.add(run)
                await db.flush()
                await db.commit()
                await db.refresh(run)

                execute_playbook_task.apply_async(
                    args=[run.id, pb.id, target_ids, False],
                    queue="monitor",
                )

    _run_async(_run())


async def _resolve_event_targets(db, pb, event_device_id: int | None) -> list[int]:
    from app.models.device import Device
    if pb.target_device_ids:
        if event_device_id and event_device_id in pb.target_device_ids:
            return [event_device_id]
        return pb.target_device_ids if not event_device_id else []
    if event_device_id:
        if pb.target_group_id:
            result = await db.execute(
                select(Device.id).where(
                    Device.id == event_device_id,
                    Device.group_id == pb.target_group_id,
                    Device.is_active == True,
                )
            )
            return [r[0] for r in result.all()]
        return [event_device_id]
    query = select(Device.id).where(Device.is_active == True)
    if pb.target_group_id:
        query = query.where(Device.group_id == pb.target_group_id)
    result = await db.execute(query)
    return [r[0] for r in result.all()]
