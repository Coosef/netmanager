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

# ── T10 A3 — Customer-based retention ─────────────────────────────────────────
# (T10 A3 öncesi sabit _RETENTION / _MAC_ARP_INACTIVE_DAYS / _CONFIG_BACKUP_DAYS
# dict'leri kaldırıldı — retention artık org bazlı, system_settings'ten okunur
# ve org.max_retention_days tavanı + RETENTION_FLOOR_DAYS tabanı ile clamp'lenir.)
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
def cleanup_old_data(dry_run: bool = False):
    """Org bazlı veri saklama temizliği. dry_run=True → hiçbir şey silinmez,
    yalnız silinecek satır sayıları raporlanır (veri kaybı önizleme)."""
    return asyncio.run(_run(dry_run=dry_run))


async def _purge_or_count(db, dry_run: bool, from_where: str, params: dict) -> int:
    """dry_run ise COUNT(*), değilse DELETE — silinen/aday satır sayısını döner.
    `from_where` 'FROM <tablo> WHERE ...' ile başlar."""
    from sqlalchemy import text
    if dry_run:
        row = await db.execute(text(f"SELECT COUNT(*) {from_where}"), params)
        return int(row.scalar() or 0)
    res = await db.execute(text(f"DELETE {from_where}"), params)
    return res.rowcount or 0


async def _run(dry_run: bool = False, only_org_id: int | None = None) -> dict:
    """only_org_id verilirse yalnız o org işlenir (org-admin dry-run önizleme);
    None ise tüm org'lar (beat sweep / super-admin)."""
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import select
    from app.core.database import make_worker_session
    from app.core.org_context import superadmin_context
    from app.core.rls import apply_rls_context
    from app.models.shared.organization import Organization
    from app.services import system_settings_service as svc

    now = datetime.now(timezone.utc)
    # summary: {organization_id: {table: count}}
    summary: dict[int, dict[str, int]] = {}

    async with make_worker_session()() as db:
        # Fleet-wide sweep: RLS'i bypass et, her satırı explicit
        # organization_id ile org'a kıs (context.py _device_counts paterni).
        with superadmin_context():
            await apply_rls_context(db)

            org_q = (
                select(Organization.id, Organization.max_retention_days)
                .where(Organization.deleted_at.is_(None))
            )
            if only_org_id is not None:
                org_q = org_q.where(Organization.id == only_org_id)
            orgs = (await db.execute(org_q)).all()

            for org_id, max_ret in orgs:
                max_ret = int(max_ret or 90)
                org_sum: dict[str, int] = {}

                async def _retain(settings_key: str) -> int:
                    raw = await svc.get(db, settings_key, org_id)
                    return effective_retention_days(int(raw), max_ret)

                # ── Regular time-series tables (org-scoped) ─────────────────
                for table, (settings_key, ts_col) in _RETENTION_KEYS.items():
                    cutoff = now - timedelta(days=await _retain(settings_key))
                    cnt = await _purge_or_count(
                        db, dry_run,
                        f"FROM {table} WHERE {ts_col} < :cutoff AND organization_id = :org",
                        {"cutoff": cutoff, "org": org_id},
                    )
                    if cnt:
                        org_sum[table] = cnt

                # ── Stale MAC/ARP entries (org-scoped) ──────────────────────
                mac_cutoff = now - timedelta(days=await _retain("retention.mac_arp_inactive_days"))
                for tbl in ("mac_address_entries", "arp_entries"):
                    cnt = await _purge_or_count(
                        db, dry_run,
                        f"FROM {tbl} WHERE is_active = FALSE AND last_seen < :cutoff "
                        f"AND organization_id = :org",
                        {"cutoff": mac_cutoff, "org": org_id},
                    )
                    if cnt:
                        org_sum[tbl] = cnt

                # ── Old non-golden config backups (org-scoped) ──────────────
                # Keep: golden always + latest 5 per device + within retention.
                cb_cutoff = now - timedelta(days=await _retain("retention.config_backup_days"))
                cnt = await _purge_or_count(
                    db, dry_run,
                    """FROM config_backups
                       WHERE is_golden = FALSE
                         AND created_at < :cutoff
                         AND organization_id = :org
                         AND id NOT IN (
                           SELECT id FROM (
                               SELECT id, ROW_NUMBER() OVER (
                                          PARTITION BY device_id ORDER BY created_at DESC
                                      ) AS rn
                               FROM config_backups
                               WHERE is_golden = FALSE AND organization_id = :org
                           ) ranked
                           WHERE rn <= 5
                         )""",
                    {"cutoff": cb_cutoff, "org": org_id},
                )
                if cnt:
                    org_sum["config_backups"] = cnt

                if org_sum:
                    summary[org_id] = org_sum

            if not dry_run:
                await db.commit()

    total = sum(c for o in summary.values() for c in o.values())
    mode = "DRY-RUN" if dry_run else "cleanup"
    log.info("retention: %s complete — %d satır, summary=%s", mode, total, summary)
    return {"dry_run": dry_run, "total": total, "summary": summary}
