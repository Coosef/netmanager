"""Daily lifecycle expiration check — warranty, EOL and EOS approaching alerts."""
import asyncio

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.tasks.lifecycle_tasks.check_lifecycle_expirations")
def check_lifecycle_expirations():
    asyncio.run(_run())


async def _run():
    from datetime import date, timedelta

    from sqlalchemy import select

    from app.core.database import make_worker_session
    from app.models.asset_lifecycle import AssetLifecycle
    from app.models.notification import NotificationChannel
    from app.services.notification_service import send_channel

    # Thresholds in days — warn when remaining ≤ these values
    WARN_DAYS = [90, 30, 7]

    today = date.today()

    async with make_worker_session()() as db:
        result = await db.execute(select(AssetLifecycle))
        assets = result.scalars().all()

        if not assets:
            return

        alerts: list[str] = []

        for asset in assets:
            hostname = asset.device_hostname or f"Device #{asset.device_id}"
            for label, field_date in [
                ("Garanti Bitiş", asset.warranty_expiry),
                ("EOL (Son Kullanım)", asset.eol_date),
                ("EOS (Destek Sonu)", asset.eos_date),
            ]:
                if field_date is None:
                    continue
                remaining = (field_date - today).days
                # Only alert on exact threshold days (±1 to handle timing)
                if remaining < 0:
                    continue  # already expired — skip (would spam)
                if any(abs(remaining - t) <= 1 for t in WARN_DAYS):
                    emoji = "🔴" if remaining <= 7 else "🟡" if remaining <= 30 else "🟠"
                    alerts.append(
                        f"{emoji} {hostname}: {label} = {field_date.isoformat()} "
                        f"({remaining} gün kaldı)"
                    )

        if not alerts:
            return

        import json
        import redis as _redis_lib
        from app.core.config import settings
        from app.models.network_event import NetworkEvent
        from app.models.notification import NotificationLog

        subject = f"Lifecycle Uyarısı: {len(alerts)} cihazda yaklaşan tarih"
        body = "Aşağıdaki cihazlarda kritik tarihler yaklaşıyor:\n\n" + "\n".join(alerts)
        _redis = _redis_lib.from_url(settings.REDIS_URL, decode_responses=True)

        evt = NetworkEvent(
            device_id=None,
            device_hostname=None,
            event_type="lifecycle_alert",
            severity="warning",
            title=subject,
            message=body[:500],
            details={"alert_count": len(alerts), "alerts": alerts[:20]},
        )
        db.add(evt)
        await db.flush()

        channels_result = await db.execute(
            select(NotificationChannel).where(NotificationChannel.is_active == True)
        )
        channels = channels_result.scalars().all()
        for ch in channels:
            notify_on = ch.notify_on or []
            if not ({"lifecycle_alert", "warning_event", "any_event"} & set(notify_on)):
                continue
            try:
                ok, err = await send_channel(ch, f"[LİFECYCLE] {subject}", body)
                db.add(NotificationLog(
                    channel_id=ch.id,
                    source_type="network_event",
                    source_id=evt.id,
                    success=ok,
                    error=err,
                ))
            except Exception:
                pass
        await db.commit()

        payload = json.dumps({
            "device_id": None,
            "device_hostname": None,
            "event_type": "lifecycle_alert",
            "severity": "warning",
            "title": subject,
            "message": body[:200],
            "ts": date.today().isoformat(),
        })
        _redis.publish("network:events", payload)
        _redis.lpush("network:events:recent", payload)
        _redis.ltrim("network:events:recent", 0, 499)
