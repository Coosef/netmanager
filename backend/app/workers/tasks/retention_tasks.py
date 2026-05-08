"""Periodic data retention / table cleanup task."""
import asyncio

from app.workers.celery_app import celery_app

# Retention windows (days)
_RETENTION = {
    "snmp_poll_results":  30,   # high-volume, polled every 5 min
    "syslog_events":      30,   # high-volume syslog stream
    "notification_logs":  30,   # dedup/audit, low priority
    "command_executions": 90,   # useful audit trail
    "network_events":     90,   # event history
    "audit_logs":         180,  # compliance / security audit
}


@celery_app.task(name="app.workers.tasks.retention_tasks.cleanup_old_data")
def cleanup_old_data():
    asyncio.run(_run())


async def _run():
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import text
    from app.core.database import make_worker_session

    now = datetime.now(timezone.utc)
    summary: dict[str, int] = {}

    async with make_worker_session()() as db:
        for table, days in _RETENTION.items():
            cutoff = now - timedelta(days=days)
            ts_col = "polled_at" if table == "snmp_poll_results" else (
                "received_at" if table == "syslog_events" else
                "sent_at" if table == "notification_logs" else
                "created_at"
            )
            result = await db.execute(
                text(f"DELETE FROM {table} WHERE {ts_col} < :cutoff"),
                {"cutoff": cutoff},
            )
            if result.rowcount:
                summary[table] = result.rowcount

        await db.commit()

    if summary:
        print(f"[retention] Cleaned up: { {k: v for k, v in summary.items()} }")
