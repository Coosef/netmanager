"""Periodic data retention / table cleanup task."""
import asyncio

from app.workers.celery_app import celery_app

# Tables converted to TimescaleDB hypertables — retention is handled by
# TimescaleDB's add_retention_policy (chunk drops), not manual DELETEs.
HYPERTABLE_MANAGED = {
    "snmp_poll_results",
    "syslog_events",
    "device_availability_snapshots",
    "agent_peer_latencies",
    "synthetic_probe_results",
}

# Retention windows (days) for plain-table time-series data.
# Hypertable-managed tables are intentionally excluded from this dict.
_RETENTION = {
    "notification_logs":  30,   # dedup/audit, low priority
    "command_executions": 90,   # useful audit trail
    "network_events":     90,   # event history
    "audit_logs":         180,  # compliance / security audit
}

# How many days of inactive MAC/ARP entries to keep
_MAC_ARP_INACTIVE_DAYS = 30
# Keep non-golden config backups for this many days; golden backups are never deleted
_CONFIG_BACKUP_DAYS = 90


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
        # ── Standard time-series tables ───────────────────────────────────────
        for table, days in _RETENTION.items():
            cutoff = now - timedelta(days=days)
            ts_col = "sent_at" if table == "notification_logs" else "created_at"
            result = await db.execute(
                text(f"DELETE FROM {table} WHERE {ts_col} < :cutoff"),
                {"cutoff": cutoff},
            )
            if result.rowcount:
                summary[table] = result.rowcount

        # ── Stale MAC/ARP entries not seen recently ────────────────────────────
        mac_cutoff = now - timedelta(days=_MAC_ARP_INACTIVE_DAYS)
        r = await db.execute(
            text("DELETE FROM mac_address_entries WHERE is_active = FALSE AND last_seen < :cutoff"),
            {"cutoff": mac_cutoff},
        )
        if r.rowcount:
            summary["mac_address_entries"] = r.rowcount

        r = await db.execute(
            text("DELETE FROM arp_entries WHERE is_active = FALSE AND last_seen < :cutoff"),
            {"cutoff": mac_cutoff},
        )
        if r.rowcount:
            summary["arp_entries"] = r.rowcount

        # ── Old non-golden config backups ────────────────────────────────────
        # Keep: (1) golden backups always, (2) latest 5 per device, (3) last 90 days
        backup_cutoff = now - timedelta(days=_CONFIG_BACKUP_DAYS)
        r = await db.execute(
            text("""
                DELETE FROM config_backups
                WHERE is_golden = FALSE
                  AND created_at < :cutoff
                  AND id NOT IN (
                    SELECT id FROM (
                        SELECT id,
                               ROW_NUMBER() OVER (
                                   PARTITION BY device_id ORDER BY created_at DESC
                               ) AS rn
                        FROM config_backups
                        WHERE is_golden = FALSE
                    ) ranked
                    WHERE rn <= 5
                  )
            """),
            {"cutoff": backup_cutoff},
        )
        if r.rowcount:
            summary["config_backups"] = r.rowcount

        await db.commit()

    if summary:
        print(f"[retention] Cleaned up: { {k: v for k, v in summary.items()} }")
