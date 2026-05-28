"""T10 Faz C C3 — policy-driven device health anomaly (CPU + Memory).

Periyodik `poll_device_health`: SNMP-enabled cihazlardan CPU/RAM çeker
(mevcut snmp_service.get_cpu_ram), switch policy resolve eder, cpu_warning/critical
+ memory_warning/critical eşiklerini değerlendirir ve `_save_event` ile alarm üretir.

Kurallar:
  * NULL eşik → ilgili kontrol SESSİZCE atlanır (NULL semantic).
  * Alarm mesajı `[policy=<name>]` ile etiketlenir.
  * Org'un planında `security_policy` feature KAPALIYSA o org'un cihazları atlanır
    (security_policy_enabled_sync; arka plan task'ı org planına uyar).
  * Fleet-wide: superadmin_context (RLS bypass) — _scoping org'u device'tan damgalar.

Temperature + PoE budget bu turda YOK (veri kaynağı yok → v2). Bkz. docs/T10_FAZ_C_PLAN.md §6.
"""
import asyncio
import logging

from app.workers.celery_app import celery_app

log = logging.getLogger("netmanager.poe")  # security/anomaly app log
_HEALTH_DEDUP_TTL = 1800  # 30 dk — aynı cihaz/eşik tekrar spam'ini engelle


@celery_app.task(name="app.workers.tasks.security_policy_tasks.poll_device_health")
def poll_device_health():
    from app.core.org_context import superadmin_context
    with superadmin_context():
        return _run()


def _run() -> dict:
    from sqlalchemy import select
    from app.core.database import SyncSessionLocal
    from app.core.security import decrypt_credential_safe
    from app.models.device import Device, DeviceStatus
    from app.services import snmp_service
    from app.services.security_policy_service import (
        evaluate_switch_health, resolve_switch_policy_sync, security_policy_enabled_sync,
    )
    from app.workers.tasks.monitor_tasks import _save_event

    summary = {"checked": 0, "alarms": 0, "feature_skipped": 0}
    db = SyncSessionLocal()
    feat_cache: dict = {}
    try:
        devices = db.execute(
            select(Device).where(
                Device.is_active.is_(True),
                Device.snmp_enabled.is_(True),
                Device.status != DeviceStatus.OFFLINE,   # offline cihaza SNMP atma
            )
        ).scalars().all()

        for dev in devices:
            org_id = dev.organization_id
            if org_id not in feat_cache:
                feat_cache[org_id] = security_policy_enabled_sync(db, org_id)
            if not feat_cache[org_id]:
                summary["feature_skipped"] += 1
                continue

            try:
                metrics = asyncio.run(snmp_service.get_cpu_ram(
                    host=dev.ip_address,
                    community=decrypt_credential_safe(dev.snmp_community) or "",
                    version=dev.snmp_version,
                    port=dev.snmp_port,
                    vendor=dev.vendor,
                    v3_username=dev.snmp_v3_username,
                    v3_auth_protocol=dev.snmp_v3_auth_protocol,
                    v3_auth_passphrase=decrypt_credential_safe(dev.snmp_v3_auth_passphrase),
                    v3_priv_protocol=dev.snmp_v3_priv_protocol,
                    v3_priv_passphrase=decrypt_credential_safe(dev.snmp_v3_priv_passphrase),
                ))
            except Exception as exc:  # noqa: BLE001 — bir cihaz SNMP'si patlarsa diğerleri sürsün
                log.debug("health poll SNMP error %s: %s", dev.hostname, exc)
                continue

            summary["checked"] += 1
            pol = resolve_switch_policy_sync(db, dev)
            for spec in evaluate_switch_health(dev.hostname, pol, metrics):
                _save_event(
                    db, dev, spec["event_type"], spec["severity"], spec["message"],
                    details=spec["details"],
                    dedup_key=f"{spec['metric']}:{dev.id}", dedup_ttl=_HEALTH_DEDUP_TTL,
                )
                summary["alarms"] += 1
    finally:
        db.close()

    if summary["checked"] or summary["alarms"]:
        log.info("security_policy: health poll %s", summary)
    return summary


# ── C4a — MAC flood (port başına MAC sayısı; read-only) ──────────────────────

@celery_app.task(name="app.workers.tasks.security_policy_tasks.poll_mac_anomalies")
def poll_mac_anomalies():
    """Periyodik MAC anomaly (C4a flood). mac_address_entries'ten port başına aktif
    MAC sayısı → port policy mac_flood_warning/critical. NULL→skip, feature kapalı→skip,
    `[policy=]` etiketi, **shutdown YOK** (sadece alarm). Flap C4b'de (collection hook)."""
    from app.core.org_context import superadmin_context
    with superadmin_context():
        return _run_mac_flood()


def _run_mac_flood() -> dict:
    from sqlalchemy import func, select
    from app.core.database import SyncSessionLocal
    from app.models.device import Device
    from app.models.mac_arp import MacAddressEntry
    from app.services.security_policy_service import (
        evaluate_port_flood, is_uplink_port, resolve_port_policy_sync,
        security_policy_enabled_sync,
    )
    from app.services import system_settings_service as _settings
    from app.workers.tasks.monitor_tasks import _save_event

    summary = {"ports_checked": 0, "alarms": 0, "feature_skipped": 0,
               "flag_skipped": 0, "uplink_skipped": 0}
    db = SyncSessionLocal()
    feat_cache: dict = {}   # org_id → security_policy feature on?
    flag_cache: dict = {}   # org_id → security.mac_flood_enabled?
    dev_cache: dict = {}
    try:
        # Aktif MAC'leri port başına say (port NULL olanları atla).
        rows = db.execute(
            select(
                MacAddressEntry.device_id,
                MacAddressEntry.port,
                func.count(func.distinct(MacAddressEntry.mac_address)),
            ).where(
                MacAddressEntry.is_active.is_(True),
                MacAddressEntry.port.isnot(None),
            ).group_by(MacAddressEntry.device_id, MacAddressEntry.port)
        ).all()

        for device_id, port, mac_count in rows:
            dev = dev_cache.get(device_id)
            if dev is None:
                dev = db.get(Device, device_id)
                dev_cache[device_id] = dev
            if dev is None:
                continue
            org_id = dev.organization_id
            if org_id not in feat_cache:
                feat_cache[org_id] = security_policy_enabled_sync(db, org_id)
            if not feat_cache[org_id]:
                summary["feature_skipped"] += 1
                continue
            # C4a — opt-in: org açıkça security.mac_flood_enabled=true yapmadıysa sessiz.
            if org_id not in flag_cache:
                flag_cache[org_id] = bool(_settings.get_sync(db, "security.mac_flood_enabled", org_id))
            if not flag_cache[org_id]:
                summary["flag_skipped"] += 1
                continue
            # C4a — uplink/trunk portlarını atla (binlerce MAC normal; per-port=v2).
            if is_uplink_port(port):
                summary["uplink_skipped"] += 1
                continue

            summary["ports_checked"] += 1
            pol = resolve_port_policy_sync(db, dev, port)
            spec = evaluate_port_flood(dev.hostname, port, mac_count, pol)
            if spec is not None:
                _save_event(db, dev, spec["event_type"], spec["severity"], spec["message"],
                            details=spec["details"],
                            dedup_key=f"macflood:{device_id}:{port}", dedup_ttl=_HEALTH_DEDUP_TTL)
                summary["alarms"] += 1
    finally:
        db.close()

    if summary["ports_checked"] or summary["alarms"]:
        log.info("security_policy: mac flood poll %s", summary)
    return summary
