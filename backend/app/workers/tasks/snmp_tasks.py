"""Periodic SNMP polling task — collects interface counters for all SNMP-enabled devices."""
import asyncio
import fnmatch
from datetime import timezone

import redis as _redis_lib

from app.core.config import settings
from app.workers.celery_app import celery_app

_redis = _redis_lib.from_url(settings.REDIS_URL, decode_responses=True)


@celery_app.task(name="app.workers.tasks.snmp_tasks.poll_snmp_all")
def poll_snmp_all():
    """Runs every 5 minutes. Polls all SNMP-enabled devices concurrently (up to 20 at a time)."""
    asyncio.run(_run())


async def _run():
    from datetime import datetime

    from sqlalchemy import or_, select, text

    from app.core.database import make_worker_session
    from app.core.security import decrypt_credential_safe
    from app.models.alert_rule import AlertRule
    from app.models.credential_profile import CredentialProfile
    from app.models.device import Device
    from app.models.maintenance_window import MaintenanceWindow
    from app.models.snmp_metric import SnmpPollResult
    from app.services import snmp_service

    async with make_worker_session()() as db:
        # ── 1. Get SNMP-enabled devices ────────────────────────────────────────
        result = await db.execute(
            select(Device).where(
                Device.is_active == True,
                Device.snmp_enabled == True,
                or_(
                    Device.snmp_community.isnot(None),
                    Device.snmp_v3_username.isnot(None),
                ),
            )
        )
        devices = result.scalars().all()
        if not devices:
            return

        # ── 2. Load alert rules and maintenance windows ────────────────────────
        active_rules: list[AlertRule] = (
            await db.execute(select(AlertRule).where(AlertRule.enabled == True))
        ).scalars().all()

        now = datetime.now(timezone.utc)
        active_windows: list[MaintenanceWindow] = (
            await db.execute(
                select(MaintenanceWindow).where(
                    MaintenanceWindow.start_time <= now,
                    MaintenanceWindow.end_time >= now,
                )
            )
        ).scalars().all()

        # ── 3. Build credential profile cache ─────────────────────────────────
        profile_ids = {d.credential_profile_id for d in devices if d.credential_profile_id}
        profile_cache: dict = {}
        if profile_ids:
            for p in (
                await db.execute(
                    select(CredentialProfile).where(CredentialProfile.id.in_(profile_ids))
                )
            ).scalars().all():
                profile_cache[p.id] = p

        # ── 4. Batch-load latest previous snapshots (single SQL query) ─────────
        device_ids = [d.id for d in devices]
        prev_map = await _load_prev_snapshots(db, device_ids)

        # ── 5. Concurrent SNMP polling (max 20 simultaneous connections) ───────
        semaphore = asyncio.Semaphore(20)

        async def fetch_one(device: Device):
            profile = profile_cache.get(device.credential_profile_id) if device.credential_profile_id else None
            src = profile if (profile and getattr(profile, "snmp_enabled", False)) else device
            async with semaphore:
                try:
                    ifaces = await snmp_service.get_interfaces(
                        device.ip_address,
                        src.snmp_community or device.snmp_community or "",
                        src.snmp_version or device.snmp_version,
                        src.snmp_port or device.snmp_port,
                        v3_username=getattr(src, "snmp_v3_username", None) or device.snmp_v3_username,
                        v3_auth_protocol=getattr(src, "snmp_v3_auth_protocol", None) or device.snmp_v3_auth_protocol,
                        v3_auth_passphrase=decrypt_credential_safe(getattr(src, "snmp_v3_auth_passphrase", None)) or decrypt_credential_safe(device.snmp_v3_auth_passphrase),
                        v3_priv_protocol=getattr(src, "snmp_v3_priv_protocol", None) or device.snmp_v3_priv_protocol,
                        v3_priv_passphrase=decrypt_credential_safe(getattr(src, "snmp_v3_priv_passphrase", None)) or decrypt_credential_safe(device.snmp_v3_priv_passphrase),
                    )
                    return device, ifaces
                except Exception:
                    return device, []

        poll_results = list(await asyncio.gather(*[fetch_one(d) for d in devices]))

        # ── 6. Sequential DB writes + utilization calculation ──────────────────
        all_new_rows: list[dict] = []
        for device, ifaces in poll_results:
            if not ifaces:
                continue
            device_prev = prev_map.get(device.id, {})
            rows = _write_rows(db, device, ifaces, device_prev, now)
            all_new_rows.extend(rows)

        await db.commit()

        # ── 7. Alert rule checks ───────────────────────────────────────────────
        if active_rules and all_new_rows:
            device_map = {d.id: d for d in devices}
            seen_devices = {r["device_id"] for r in all_new_rows}
            for device_id in seen_devices:
                device = device_map.get(device_id)
                if device and not _in_maintenance(device_id, active_windows):
                    d_rows = [r for r in all_new_rows if r["device_id"] == device_id]
                    await _check_alert_rules(device, d_rows, active_rules)


async def _load_prev_snapshots(db, device_ids: list[int]) -> dict[int, dict]:
    """Batch-load the latest snapshot per (device_id, if_index) in a single query.
    Returns {device_id: {if_index: {polled_at, in_octets, out_octets, in_errors, out_errors}}}."""
    if not device_ids:
        return {}
    from sqlalchemy import text
    rows = (await db.execute(
        text("""
            SELECT DISTINCT ON (device_id, if_index)
                device_id, if_index, polled_at, in_octets, out_octets, in_errors, out_errors
            FROM snmp_poll_results
            WHERE device_id = ANY(:ids)
            ORDER BY device_id, if_index, polled_at DESC
        """),
        {"ids": device_ids},
    )).mappings().all()

    result: dict[int, dict] = {}
    for row in rows:
        d_id = row["device_id"]
        if_idx = row["if_index"]
        if d_id not in result:
            result[d_id] = {}
        result[d_id][if_idx] = dict(row)
    return result


def _write_rows(db, device, ifaces: list, device_prev: dict, now) -> list[dict]:
    """Calculate utilization from pre-loaded snapshots and add SnmpPollResult rows to session."""
    from app.models.snmp_metric import SnmpPollResult

    new_rows: list[dict] = []
    for iface in ifaces:
        if_index = iface.get("if_index")
        if if_index is None:
            continue

        prev = device_prev.get(if_index)
        in_util = out_util = error_rate = None

        if prev and prev.get("in_octets") is not None and iface.get("in_octets") is not None:
            prev_at = prev["polled_at"]
            if hasattr(prev_at, "tzinfo") and prev_at.tzinfo is None:
                prev_at = prev_at.replace(tzinfo=timezone.utc)
            elapsed = (now - prev_at).total_seconds()
            raw_speed = iface.get("speed_mbps") or prev.get("speed_mbps")
            speed_bps = (raw_speed or 0) * 1_000_000
            if elapsed > 0 and speed_bps > 0:
                in_delta = _safe_delta(iface["in_octets"], prev["in_octets"])
                out_delta = _safe_delta(iface.get("out_octets"), prev.get("out_octets"))
                in_util = min(100.0, round(in_delta * 8 / elapsed / speed_bps * 100, 2))
                out_util = min(100.0, round(out_delta * 8 / elapsed / speed_bps * 100, 2))

        if prev and iface.get("in_errors") is not None and prev.get("in_errors") is not None:
            in_err_delta = _safe_delta(iface["in_errors"], prev["in_errors"])
            out_err_delta = _safe_delta(iface.get("out_errors"), prev.get("out_errors") or 0)
            prev_at = prev["polled_at"]
            if hasattr(prev_at, "tzinfo") and prev_at.tzinfo is None:
                prev_at = prev_at.replace(tzinfo=timezone.utc)
            elapsed = max((now - prev_at).total_seconds(), 1)
            error_rate = round((in_err_delta + out_err_delta) / elapsed * 60, 4)

        db.add(SnmpPollResult(
            device_id=device.id,
            polled_at=now,
            if_index=if_index,
            if_name=iface.get("name"),
            speed_mbps=iface.get("speed_mbps"),
            in_octets=iface.get("in_octets"),
            out_octets=iface.get("out_octets"),
            in_errors=iface.get("in_errors"),
            out_errors=iface.get("out_errors"),
            in_utilization_pct=in_util,
            out_utilization_pct=out_util,
        ))

        new_rows.append({
            "device_id": device.id,
            "hostname": device.hostname,
            "if_name": iface.get("name") or "",
            "in_util": in_util,
            "out_util": out_util,
            "error_rate": error_rate,
        })

    return new_rows


async def _check_alert_rules(device, new_rows: list[dict], rules: list):
    """Check thresholds for each new poll row; fire notifications when breached."""
    from datetime import datetime

    r = _redis

    now_ts = datetime.now(timezone.utc).timestamp()

    for row in new_rows:
        if_name = row["if_name"]
        in_util = row["in_util"]
        out_util = row["out_util"]
        error_rate = row["error_rate"]

        for rule in rules:
            if rule.device_id is not None and rule.device_id != device.id:
                continue

            pattern = rule.if_name_pattern
            if pattern and pattern not in ("", "*"):
                if not fnmatch.fnmatch(if_name, pattern):
                    continue

            if rule.metric == "in_util_pct":
                val = in_util
            elif rule.metric == "out_util_pct":
                val = out_util
            elif rule.metric == "max_util_pct":
                val = max(v for v in [in_util, out_util] if v is not None) if any(
                    v is not None for v in [in_util, out_util]
                ) else None
            elif rule.metric == "error_rate":
                val = error_rate
            else:
                val = None

            if val is None:
                continue

            vkey = f"alert:vcount:{rule.id}:{device.id}:{if_name}"
            ckey = f"alert:cooldown:{rule.id}:{device.id}:{if_name}"

            if val >= rule.threshold_value:
                count = r.incr(vkey)
                r.expire(vkey, 1200)

                if count >= rule.consecutive_count:
                    last_sent = r.get(ckey)
                    if last_sent and (now_ts - float(last_sent)) < rule.cooldown_minutes * 60:
                        continue
                    await _dispatch_alert(rule, device, if_name, val, count)
                    r.delete(vkey)
                    r.set(ckey, now_ts, ex=rule.cooldown_minutes * 60 + 300)
            else:
                r.delete(vkey)


async def _dispatch_alert(rule, device, if_name: str, value: float, count: int):
    """Send alert notification through all active channels and persist a NetworkEvent."""
    try:
        from sqlalchemy import select

        from app.core.database import make_worker_session
        from app.models.network_event import NetworkEvent
        from app.models.notification import NotificationChannel
        from app.services.notification_service import send_channel

        metric_label = {
            "in_util_pct": "Giriş Util.",
            "out_util_pct": "Çıkış Util.",
            "max_util_pct": "Maks. Util.",
            "error_rate": "Hata Oranı",
        }.get(rule.metric, rule.metric)

        unit = "%" if "util" in rule.metric else "/dk"
        severity_emoji = "🔴" if rule.severity == "critical" else "🟡"

        subject = f"{severity_emoji} [{rule.severity.upper()}] {rule.name}: {device.hostname} / {if_name}"
        body = (
            f"Uyarı Kuralı: {rule.name}\n"
            f"Cihaz: {device.hostname} ({device.ip_address})\n"
            f"Interface: {if_name}\n"
            f"Metrik: {metric_label} = {value:.1f}{unit}\n"
            f"Eşik: {rule.threshold_value}{unit}\n"
            f"Ardışık İhlal: {count} poll\n"
        )

        import json
        title = f"{rule.name}: {device.hostname}/{if_name} {metric_label}={value:.1f}{unit}"
        async with make_worker_session()() as db:
            # Persist alert fire as a NetworkEvent for history tracking
            db.add(NetworkEvent(
                device_id=device.id,
                device_hostname=device.hostname,
                event_type="threshold_alert",
                severity=rule.severity,
                title=title,
                message=body,
                details={
                    "rule_id": rule.id,
                    "rule_name": rule.name,
                    "if_name": if_name,
                    "metric": rule.metric,
                    "value": round(value, 2),
                    "threshold": rule.threshold_value,
                    "unit": unit,
                    "consecutive_count": count,
                },
            ))
            await db.commit()
            from datetime import datetime
            payload = json.dumps({
                "device_id": device.id,
                "device_hostname": device.hostname,
                "event_type": "threshold_alert",
                "severity": rule.severity,
                "title": title,
                "message": body,
                "ts": datetime.now(timezone.utc).isoformat(),
            })
            _redis.publish("network:events", payload)
            _redis.lpush("network:events:recent", payload)
            _redis.ltrim("network:events:recent", 0, 499)

            channels = (
                await db.execute(
                    select(NotificationChannel).where(NotificationChannel.is_active == True)
                )
            ).scalars().all()
            for ch in channels:
                notify_on = ch.notify_on or []
                if "threshold_alert" in notify_on or (
                    rule.severity == "critical" and "critical_event" in notify_on
                ) or (
                    rule.severity == "warning" and "warning_event" in notify_on
                ):
                    await send_channel(ch, subject, body)
    except Exception:
        pass


def _in_maintenance(device_id: int, windows: list) -> bool:
    for w in windows:
        if w.applies_to_all:
            return True
        if w.device_ids and device_id in w.device_ids:
            return True
    return False


def _safe_delta(current, previous) -> float:
    """Handle 64-bit counter wrap-around."""
    if current is None or previous is None:
        return 0.0
    delta = current - previous
    if delta < 0:
        delta += 2**64
    return float(delta)
