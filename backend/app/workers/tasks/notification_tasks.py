"""Periodic notification processing task."""
from datetime import datetime, timezone, timedelta

import asyncio

from app.workers.celery_app import celery_app


def _run_async(coro):
    return asyncio.run(coro)


@celery_app.task(name="app.workers.tasks.notification_tasks.process_notifications")
def process_notifications():
    """Runs every 5 minutes. Sends notifications for new events to active channels."""
    async def _run():
        from sqlalchemy import select, and_
        from app.core.database import make_worker_session
        from app.models.network_event import NetworkEvent
        from app.models.approval import ApprovalRequest
        from app.models.playbook import PlaybookRun
        from app.models.notification import NotificationChannel, NotificationLog
        from app.services.notification_service import send_channel

        window_start = datetime.now(timezone.utc) - timedelta(minutes=6)

        async with make_worker_session()() as db:
            # Load active channels
            ch_result = await db.execute(
                select(NotificationChannel).where(NotificationChannel.is_active == True)
            )
            channels = ch_result.scalars().all()
            if not channels:
                return

            # Helper: check if already notified
            async def already_sent(channel_id: int, source_type: str, source_id: int) -> bool:
                r = await db.execute(
                    select(NotificationLog).where(
                        NotificationLog.channel_id == channel_id,
                        NotificationLog.source_type == source_type,
                        NotificationLog.source_id == source_id,
                    )
                )
                return r.scalar_one_or_none() is not None

            async def log_send(channel_id: int, source_type: str, source_id: int, success: bool, error: str | None):
                db.add(NotificationLog(
                    channel_id=channel_id,
                    source_type=source_type,
                    source_id=source_id,
                    success=success,
                    error=error,
                ))

            # 1. Critical / warning NetworkEvents
            ev_result = await db.execute(
                select(NetworkEvent).where(
                    NetworkEvent.created_at >= window_start,
                    NetworkEvent.severity.in_(["critical", "warning"]),
                )
            )
            events = ev_result.scalars().all()

            _BEHAVIOR_TYPES = {"mac_anomaly", "traffic_spike", "vlan_anomaly",
                               "mac_loop_suspicion", "loop_detected", "stp_anomaly", "port_flap"}

            for ev in events:
                severity_cat = "critical_event" if ev.severity == "critical" else "warning_event"
                offline_cat = "device_offline" if ev.event_type == "device_offline" else None
                # Specific event-type subscriptions (channels can subscribe to individual types)
                specific_cats = {ev.event_type}  # e.g. "config_drift", "rollout_failure", etc.
                # Alias behavior analytics types → "behavior_anomaly" subscription category
                if ev.event_type in _BEHAVIOR_TYPES:
                    specific_cats.add("behavior_anomaly")

                for ch in channels:
                    cats = set(ch.notify_on or [])
                    matched = (
                        "any_event" in cats
                        or severity_cat in cats
                        or (offline_cat and offline_cat in cats)
                        or bool(specific_cats & cats)
                    )
                    if not matched:
                        continue
                    if await already_sent(ch.id, "network_event", ev.id):
                        continue
                    subject = f"[{ev.severity.upper()}] {ev.title}"
                    body = f"Cihaz: {ev.device_hostname or 'Bilinmiyor'}\n{ev.message or ''}"
                    ok, err = await send_channel(ch, subject, body)
                    await log_send(ch.id, "network_event", ev.id, ok, err)

            # 2. New pending ApprovalRequests
            ap_result = await db.execute(
                select(ApprovalRequest).where(
                    ApprovalRequest.created_at >= window_start,
                    ApprovalRequest.status == "pending",
                )
            )
            approvals = ap_result.scalars().all()

            for req in approvals:
                for ch in channels:
                    if "approval_request" not in (ch.notify_on or []):
                        continue
                    if await already_sent(ch.id, "approval", req.id):
                        continue
                    subject = f"Onay Talebi: {req.device_hostname}"
                    body = (
                        f"Kullanıcı: {req.requester_username}\n"
                        f"Komut: {req.command}\n"
                        f"Risk: {req.risk_level.upper()}\n"
                        f"Talep #{req.id} admin onayı bekliyor."
                    )
                    ok, err = await send_channel(ch, subject, body)
                    await log_send(ch.id, "approval", req.id, ok, err)

            # 3. Failed/partial PlaybookRuns
            pr_result = await db.execute(
                select(PlaybookRun).where(
                    PlaybookRun.completed_at >= window_start,
                    PlaybookRun.status.in_(["failed", "partial"]),
                    PlaybookRun.is_dry_run == False,
                )
            )
            runs = pr_result.scalars().all()

            for run in runs:
                for ch in channels:
                    if "playbook_failure" not in (ch.notify_on or []):
                        continue
                    if await already_sent(ch.id, "playbook_run", run.id):
                        continue
                    subject = f"Playbook #{run.playbook_id} {run.status.upper()}"
                    body = (
                        f"Çalışma #{run.id} | Tetikleyen: {run.triggered_by_username}\n"
                        f"Başarılı: {run.success_devices} / Başarısız: {run.failed_devices} / Toplam: {run.total_devices}"
                    )
                    ok, err = await send_channel(ch, subject, body)
                    await log_send(ch.id, "playbook_run", run.id, ok, err)

            await db.commit()

    _run_async(_run())


@celery_app.task(name="app.workers.tasks.notification_tasks.send_weekly_digest")
def send_weekly_digest():
    """Send weekly network health summary to all active email channels."""
    async def _run():
        from sqlalchemy import select, func
        from app.core.database import make_worker_session
        from app.models.device import Device
        from app.models.network_event import NetworkEvent
        from app.models.notification import NotificationChannel
        from app.services.notification_service import send_channel

        now = datetime.now(timezone.utc)
        week_ago = now - timedelta(days=7)

        async with make_worker_session()() as db:
            ch_result = await db.execute(
                select(NotificationChannel).where(
                    NotificationChannel.is_active == True,
                    NotificationChannel.type == "email",
                )
            )
            channels = ch_result.scalars().all()
            if not channels:
                return

            # Build summary
            devices = (await db.execute(select(Device).where(Device.is_active == True))).scalars().all()
            total = len(devices)
            online = sum(1 for d in devices if d.status == "online")

            ev_result = await db.execute(
                select(NetworkEvent.severity, func.count())
                .where(NetworkEvent.created_at >= week_ago)
                .group_by(NetworkEvent.severity)
            )
            ev_counts = {r[0]: r[1] for r in ev_result.fetchall()}

            subject = f"Haftalık Ağ Özeti — {now.strftime('%d.%m.%Y')}"
            body = (
                f"Haftalık NetManager Özeti\n"
                f"{'=' * 40}\n"
                f"Cihazlar:  {online}/{total} çevrimiçi\n"
                f"Çevrimdışı: {total - online}\n\n"
                f"Son 7 günde olaylar:\n"
                f"  Kritik:  {ev_counts.get('critical', 0)}\n"
                f"  Uyarı:   {ev_counts.get('warning', 0)}\n"
                f"  Bilgi:   {ev_counts.get('info', 0)}\n"
            )

            for ch in channels:
                await send_channel(ch, subject, body)

    _run_async(_run())
