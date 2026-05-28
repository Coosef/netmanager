"""Periodic data retention / table cleanup task."""
import asyncio
import logging

from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)

# Tables converted to TimescaleDB hypertables — retention is handled by
# TimescaleDB's add_retention_policy (chunk drops), not manual DELETEs.
HYPERTABLE_MANAGED = {
    "snmp_poll_results",
    "syslog_events",
    "device_availability_snapshots",
    "agent_peer_latencies",
    "synthetic_probe_results",
}

# Retention windows (days, ts_column) for plain-table time-series data.
# Hypertable-managed tables are intentionally excluded from this dict.
# T8.5 — agent_command_logs eklendi: tablo executed_at kolonu kullanıyor
# (created_at yok). VPS prod'da 135K satır / 87MB seviyesine çıktığı için
# kapsama alındı.
_RETENTION = {
    "notification_logs":  (30,  "sent_at"),       # dedup/audit, low priority
    "command_executions": (90,  "created_at"),    # useful audit trail
    "network_events":     (90,  "created_at"),    # event history
    "audit_logs":         (180, "created_at"),    # compliance / security audit
    "agent_command_logs": (90,  "executed_at"),   # agent ssh/snmp komut audit'i
}

# How many days of inactive MAC/ARP entries to keep
_MAC_ARP_INACTIVE_DAYS = 30
# Keep non-golden config backups for this many days; golden backups are never deleted
_CONFIG_BACKUP_DAYS = 90

# ── T10 A3 — Customer-based retention ─────────────────────────────────────────
# Hard floor: bir ayar / plan ne olursa olsun bu kadar günden taze veri ASLA
# silinmez. Yanlış girilmiş çok küçük bir retention değerinin son veriyi
# silip süpürmesine karşı güvenlik tabanı.
RETENTION_FLOOR_DAYS = 7

# Regular (hypertable olmayan) tablo → (system_settings retention key, ts_col).
# Org bazlı retention bu tablolara uygulanır; her satır organization_id taşır.
_RETENTION_KEYS: dict[str, tuple[str, str]] = {
    "notification_logs":  ("retention.notification_logs_days",  "sent_at"),
    "command_executions": ("retention.command_executions_days", "created_at"),
    "network_events":     ("retention.network_events_days",     "created_at"),
    "audit_logs":         ("retention.audit_logs_days",         "created_at"),
    "agent_command_logs": ("retention.agent_command_logs_days", "executed_at"),
}


def effective_retention_days(raw: int, max_retention_days: int,
                             floor: int = RETENTION_FLOOR_DAYS) -> int:
    """Bir org için etkili saklama günü.

    raw                = system_settings değeri (org override → global → default)
    max_retention_days = org plan tavanı (lisanslı en uzun saklama)
    floor              = güvenlik tabanı (bundan taze veri silinmez)

    Clamp: önce lisans tavanına indir (müşteri lisanstan fazla saklayamaz),
    sonra güvenlik tabanına yükselt. Çakışmada (tavan < taban) TABAN kazanır
    — fazla saklamak güvenli, az saklamak veri kaybı riskidir.
    """
    eff = min(int(raw), int(max_retention_days))
    eff = max(eff, int(floor))
    return eff


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
        for table, (days, ts_col) in _RETENTION.items():
            cutoff = now - timedelta(days=days)
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
        log.info("retention: cleanup complete, summary=%s", dict(summary))
