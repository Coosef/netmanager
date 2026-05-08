"""Daily SLA breach check — notify when device uptime falls below policy target."""
import asyncio

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.tasks.sla_tasks.check_sla_breaches")
def check_sla_breaches():
    asyncio.run(_run())


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
    from app.models.sla_policy import SlaPolicy
    from app.services.notification_service import send_channel
    from app.api.v1.endpoints.sla import _calc_uptime

    _redis = _redis_lib.from_url(settings.REDIS_URL, decode_responses=True)
    now = datetime.now(timezone.utc)

    async with make_worker_session()() as db:
        policies = (await db.execute(select(SlaPolicy))).scalars().all()

        breaches: list[dict] = []

        for policy in policies:
            if not policy.notify_on_breach:
                continue

            # Resolve target device IDs
            try:
                import json as _json
                policy_device_ids: list[int] = _json.loads(policy.device_ids) if policy.device_ids else []
                policy_group_ids: list[int] = _json.loads(policy.group_ids) if policy.group_ids else []
            except Exception:
                policy_device_ids = []
                policy_group_ids = []

            if policy_device_ids:
                devices = (await db.execute(
                    select(Device).where(Device.id.in_(policy_device_ids), Device.is_active == True)
                )).scalars().all()
            elif policy_group_ids:
                devices = (await db.execute(
                    select(Device).where(Device.group_id.in_(policy_group_ids), Device.is_active == True)
                )).scalars().all()
            else:
                devices = (await db.execute(
                    select(Device).where(Device.is_active == True)
                )).scalars().all()

            for device in devices:
                uptime = await _calc_uptime(db, device.id, policy.measurement_window_days, now)
                if uptime < policy.target_uptime_pct:
                    breaches.append({
                        "policy_id": policy.id,
                        "policy_name": policy.name,
                        "device_id": device.id,
                        "hostname": device.hostname,
                        "uptime_pct": uptime,
                        "target_pct": policy.target_uptime_pct,
                        "window_days": policy.measurement_window_days,
                    })

        if not breaches:
            return

        title = f"SLA İhlali: {len(breaches)} cihaz hedefin altında"
        lines = [
            f"{b['hostname']}: {b['uptime_pct']:.2f}% (hedef: {b['target_pct']}%, politika: {b['policy_name']})"
            for b in breaches[:10]
        ]
        message = "\n".join(lines)

        evt = NetworkEvent(
            device_id=None,
            device_hostname=None,
            event_type="sla_breach",
            severity="warning",
            title=title,
            message=message,
            details={"breach_count": len(breaches), "breaches": breaches[:20]},
        )
        db.add(evt)
        await db.flush()

        channels = (await db.execute(
            select(NotificationChannel).where(NotificationChannel.is_active == True)
        )).scalars().all()

        for ch in channels:
            notify_on = ch.notify_on or []
            if not ({"sla_breach", "warning_event", "critical_event", "any_event"} & set(notify_on)):
                continue
            ok, err = await send_channel(ch, f"[SLA] {title}", message)
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
            "event_type": "sla_breach",
            "severity": "warning",
            "title": title,
            "message": message,
            "ts": now.isoformat(),
        })
        _redis.publish("network:events", payload)
        _redis.lpush("network:events:recent", payload)
        _redis.ltrim("network:events:recent", 0, 499)
