"""
Sprint 14A — Ağ Davranış Analitiği

  update_baselines  : Günlük — MAC sayısı, trafik, VLAN için 7 günlük EMA baseline günceller
  detect_anomalies  : 30 dakikada bir — baseline 2× aşımı ve döngü şüphesini tespit eder
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone

import redis

from app.core.config import settings
from app.workers.celery_app import celery_app

_redis = redis.from_url(settings.REDIS_URL, decode_responses=True)

_ANOMALY_TYPES = ("mac_anomaly", "traffic_spike", "vlan_anomaly", "mac_loop_suspicion")


# ── Topology Twin drift check ─────────────────────────────────────────────────

@celery_app.task(name="app.workers.tasks.behavior_analytics_tasks.check_topology_drift")
def check_topology_drift():
    asyncio.run(_do_check_topology_drift())


async def _do_check_topology_drift():
    """
    Altın topoloji baseline ile mevcut topology_links tablosunu karşılaştırır.
    Eklenen veya kaybolan bağlantılar varsa topology_drift event'i yazar.
    """
    from sqlalchemy import select
    from app.core.database import make_worker_session
    from app.models.topology import TopologyLink
    from app.models.topology_snapshot import TopologySnapshot
    from app.models.network_event import NetworkEvent

    def _link_key(link: dict) -> str:
        return f"{link.get('device_id')}:{link.get('local_port')}:{link.get('neighbor_hostname')}"

    async with make_worker_session()() as db:
        golden = (await db.execute(
            select(TopologySnapshot).where(TopologySnapshot.is_golden == True)
        )).scalar_one_or_none()

        if not golden:
            print("[topology_twin] No golden baseline — skipping drift check")
            return

        golden_keys = {_link_key(lnk) for lnk in (golden.links or [])}

        current_rows = (await db.execute(select(TopologyLink))).scalars().all()
        current_links = {
            f"{r.device_id}:{r.local_port}:{r.neighbor_hostname}"
            for r in current_rows
        }

        added_count = len(current_links - golden_keys)
        removed_count = len(golden_keys - current_links)

        if added_count == 0 and removed_count == 0:
            print("[topology_twin] No drift detected")
            return

        if _is_dup(0, "topology_drift", f"{added_count}_{removed_count}", ttl=3600 * 6):
            return

        evt = NetworkEvent(
            device_id=None,
            device_hostname=None,
            event_type="topology_drift",
            severity="warning",
            title="Topoloji Drift Tespiti",
            message=(
                f"{added_count} yeni bağlantı eklendi, "
                f"{removed_count} bağlantı kayboldu (altın baseline: '{golden.name}')"
            ),
            details={
                "added_count": added_count,
                "removed_count": removed_count,
                "golden_id": golden.id,
                "golden_name": golden.name,
            },
        )
        db.add(evt)
        await db.commit()
        print(f"[topology_twin] Drift event fired: +{added_count} / -{removed_count}")


# ── helpers ──────────────────────────────────────────────────────────────────

def _is_dup(device_id: int, event_type: str, key: str, ttl: int = 3600) -> bool:
    rkey = f"dedup:{device_id}:{event_type}:{key}"
    if _redis.get(rkey):
        return True
    _redis.setex(rkey, ttl, "1")
    return False


async def _fire(db, device, event_type: str, severity: str, title: str,
                message: str = "", details: dict = None, dedup_key: str = ""):
    from sqlalchemy import select as _select
    from app.models.network_event import NetworkEvent

    if dedup_key and _is_dup(device.id, event_type, dedup_key):
        # Even when deduped, refresh details so port lists stay current
        if details:
            existing = (await db.execute(
                _select(NetworkEvent)
                .where(NetworkEvent.device_id == device.id)
                .where(NetworkEvent.event_type == event_type)
                .where(NetworkEvent.acknowledged == False)
                .order_by(NetworkEvent.created_at.desc())
                .limit(1)
            )).scalar_one_or_none()
            if existing:
                existing.details = details
        return
    evt = NetworkEvent(
        device_id=device.id,
        device_hostname=device.hostname,
        event_type=event_type,
        severity=severity,
        title=title,
        message=message,
        details=details or {},
    )
    db.add(evt)


async def _upsert_baseline(db, device_id: int, metric_type: str,
                           value: float, known_vlans=None):
    from sqlalchemy import select
    from app.models.network_baseline import NetworkBaseline

    row = (await db.execute(
        select(NetworkBaseline).where(
            NetworkBaseline.device_id == device_id,
            NetworkBaseline.metric_type == metric_type,
        )
    )).scalar_one_or_none()

    if row:
        # EMA: 30% new value, 70% history
        row.baseline_value = 0.7 * row.baseline_value + 0.3 * value
        row.sample_count += 1
        row.last_updated = datetime.now(timezone.utc)
        if known_vlans is not None:
            row.known_vlans = known_vlans
    else:
        db.add(NetworkBaseline(
            device_id=device_id,
            metric_type=metric_type,
            baseline_value=value,
            sample_count=1,
            known_vlans=known_vlans,
        ))


# ── Celery tasks ──────────────────────────────────────────────────────────────

@celery_app.task(name="app.workers.tasks.behavior_analytics_tasks.update_baselines")
def update_baselines():
    asyncio.run(_do_update_baselines())


@celery_app.task(name="app.workers.tasks.behavior_analytics_tasks.detect_anomalies")
def detect_anomalies():
    asyncio.run(_do_detect_anomalies())


# ── update_baselines impl ─────────────────────────────────────────────────────

async def _do_update_baselines():
    from sqlalchemy import func, select
    from app.core.database import make_worker_session
    from app.models.mac_arp import MacAddressEntry
    from app.models.snmp_metric import SnmpPollResult

    since = datetime.now(timezone.utc) - timedelta(days=7)

    async with make_worker_session()() as db:
        # ── MAC count per device ───────────────────────────────────────────────
        mac_rows = (await db.execute(
            select(MacAddressEntry.device_id,
                   func.count(MacAddressEntry.id).label("cnt"))
            .where(MacAddressEntry.is_active == True)
            .group_by(MacAddressEntry.device_id)
        )).all()

        for r in mac_rows:
            await _upsert_baseline(db, r.device_id, "mac_count", float(r.cnt))

        # ── Traffic averages per device ────────────────────────────────────────
        traffic_rows = (await db.execute(
            select(
                SnmpPollResult.device_id,
                func.avg(SnmpPollResult.in_utilization_pct).label("avg_in"),
                func.avg(SnmpPollResult.out_utilization_pct).label("avg_out"),
            )
            .where(SnmpPollResult.polled_at >= since)
            .where(SnmpPollResult.in_utilization_pct.isnot(None))
            .group_by(SnmpPollResult.device_id)
        )).all()

        for r in traffic_rows:
            if r.avg_in is not None:
                await _upsert_baseline(db, r.device_id, "traffic_in_pct", float(r.avg_in))
            if r.avg_out is not None:
                await _upsert_baseline(db, r.device_id, "traffic_out_pct", float(r.avg_out))

        # ── VLAN count + known VLAN set per device ─────────────────────────────
        vlan_count_rows = (await db.execute(
            select(
                MacAddressEntry.device_id,
                func.count(func.distinct(MacAddressEntry.vlan_id)).label("cnt"),
            )
            .where(MacAddressEntry.is_active == True)
            .where(MacAddressEntry.vlan_id.isnot(None))
            .group_by(MacAddressEntry.device_id)
        )).all()

        vlan_set_rows = (await db.execute(
            select(MacAddressEntry.device_id, MacAddressEntry.vlan_id)
            .where(MacAddressEntry.is_active == True)
            .where(MacAddressEntry.vlan_id.isnot(None))
            .distinct()
        )).all()

        device_vlans: dict[int, set] = {}
        for r in vlan_set_rows:
            device_vlans.setdefault(r.device_id, set()).add(r.vlan_id)

        for r in vlan_count_rows:
            known = sorted(device_vlans.get(r.device_id, set()))
            await _upsert_baseline(db, r.device_id, "vlan_count", float(r.cnt),
                                   known_vlans=known)

        await db.commit()
        print(f"[behavior] Baselines updated — "
              f"{len(mac_rows)} MAC, {len(traffic_rows)} traffic, {len(vlan_count_rows)} VLAN")


# ── detect_anomalies impl ─────────────────────────────────────────────────────

async def _do_detect_anomalies():
    from sqlalchemy import func, select
    from app.core.database import make_worker_session
    from app.models.device import Device
    from app.models.mac_arp import MacAddressEntry
    from app.models.network_baseline import NetworkBaseline
    from app.models.snmp_metric import SnmpPollResult

    since_snmp = datetime.now(timezone.utc) - timedelta(minutes=10)
    fired = 0

    async with make_worker_session()() as db:
        # ── load all baselines ─────────────────────────────────────────────────
        all_bl = (await db.execute(select(NetworkBaseline))).scalars().all()
        bl: dict[tuple, NetworkBaseline] = {(b.device_id, b.metric_type): b for b in all_bl}

        if not bl:
            print("[behavior] No baselines yet — skipping anomaly detection")
            return

        def _get_device_cache() -> dict:
            return {}

        device_cache: dict[int, Device | None] = {}

        async def _dev(device_id: int) -> Device | None:
            if device_id not in device_cache:
                device_cache[device_id] = (
                    await db.execute(select(Device).where(Device.id == device_id))
                ).scalar_one_or_none()
            return device_cache[device_id]

        # ── 1. MAC count anomaly ───────────────────────────────────────────────
        mac_counts = (await db.execute(
            select(MacAddressEntry.device_id,
                   func.count(MacAddressEntry.id).label("cnt"))
            .where(MacAddressEntry.is_active == True)
            .group_by(MacAddressEntry.device_id)
        )).all()

        for r in mac_counts:
            b = bl.get((r.device_id, "mac_count"))
            if b and b.sample_count >= 3 and b.baseline_value > 0:
                if r.cnt > 2 * b.baseline_value:
                    dev = await _dev(r.device_id)
                    if dev:
                        await _fire(db, dev, "mac_anomaly", "warning",
                            f"MAC Sayısı Anomalisi: {dev.hostname}",
                            f"Aktif MAC {r.cnt} (baseline: {b.baseline_value:.0f})",
                            details={"current": r.cnt, "baseline": round(b.baseline_value, 1)},
                            dedup_key=f"mac_{dev.id}_{r.cnt}")
                        fired += 1

        # ── 2. Traffic spike ───────────────────────────────────────────────────
        traffic_rows = (await db.execute(
            select(
                SnmpPollResult.device_id,
                func.avg(SnmpPollResult.in_utilization_pct).label("avg_in"),
                func.avg(SnmpPollResult.out_utilization_pct).label("avg_out"),
            )
            .where(SnmpPollResult.polled_at >= since_snmp)
            .where(SnmpPollResult.in_utilization_pct.isnot(None))
            .group_by(SnmpPollResult.device_id)
        )).all()

        for r in traffic_rows:
            for metric, current in [("traffic_in_pct", r.avg_in),
                                     ("traffic_out_pct", r.avg_out)]:
                if current is None:
                    continue
                b = bl.get((r.device_id, metric))
                if b and b.sample_count >= 3 and b.baseline_value > 1.0:
                    if current > 2 * b.baseline_value:
                        dev = await _dev(r.device_id)
                        if dev:
                            direction = "Gelen" if "in" in metric else "Giden"
                            await _fire(db, dev, "traffic_spike", "warning",
                                f"Trafik Spike: {dev.hostname}",
                                f"{direction} trafik %{current:.1f} (baseline: %{b.baseline_value:.1f})",
                                details={"direction": direction.lower(),
                                         "current_pct": round(current, 1),
                                         "baseline_pct": round(b.baseline_value, 1)},
                                dedup_key=f"traffic_{dev.id}_{metric}_{int(current)}")
                            fired += 1

        # ── 3. VLAN anomaly ────────────────────────────────────────────────────
        vlan_rows = (await db.execute(
            select(MacAddressEntry.device_id, MacAddressEntry.vlan_id)
            .where(MacAddressEntry.is_active == True)
            .where(MacAddressEntry.vlan_id.isnot(None))
            .distinct()
        )).all()

        current_vlans: dict[int, set] = {}
        for r in vlan_rows:
            current_vlans.setdefault(r.device_id, set()).add(r.vlan_id)

        for device_id, vset in current_vlans.items():
            b = bl.get((device_id, "vlan_count"))
            if b and b.known_vlans and b.sample_count >= 3:
                new_vlans = vset - set(b.known_vlans)
                if new_vlans:
                    dev = await _dev(device_id)
                    if dev:
                        await _fire(db, dev, "vlan_anomaly", "warning",
                            f"Beklenmeyen VLAN: {dev.hostname}",
                            f"Yeni VLAN'lar: {sorted(new_vlans)}",
                            details={"new_vlans": sorted(new_vlans),
                                     "known_vlans": sorted(b.known_vlans)},
                            dedup_key=f"vlan_{device_id}_{'_'.join(str(v) for v in sorted(new_vlans))}")
                        fired += 1

        # ── 4. MAC loop suspicion ──────────────────────────────────────────────
        loop_rows = (await db.execute(
            select(
                MacAddressEntry.device_id,
                MacAddressEntry.mac_address,
                func.count(func.distinct(MacAddressEntry.port)).label("port_cnt"),
            )
            .where(MacAddressEntry.is_active == True)
            .where(MacAddressEntry.port.isnot(None))
            .group_by(MacAddressEntry.device_id, MacAddressEntry.mac_address)
            .having(func.count(func.distinct(MacAddressEntry.port)) >= 2)
        )).all()

        for r in loop_rows:
            dev = await _dev(r.device_id)
            if dev:
                port_q = await db.execute(
                    select(MacAddressEntry.port)
                    .where(MacAddressEntry.device_id == r.device_id)
                    .where(MacAddressEntry.mac_address == r.mac_address)
                    .where(MacAddressEntry.is_active == True)
                    .where(MacAddressEntry.port.isnot(None))
                    .distinct()
                )
                ports = [row[0] for row in port_q.all()]
                await _fire(db, dev, "mac_loop_suspicion", "warning",
                    f"Döngü Şüphesi: {dev.hostname}",
                    f"MAC {r.mac_address} → {r.port_cnt} farklı portta",
                    details={
                        "mac": r.mac_address,
                        "port_count": r.port_cnt,
                        "ports": ports,
                        "device": dev.hostname,
                    },
                    dedup_key=f"loop_{dev.id}_{r.mac_address}")
                fired += 1

        if fired:
            await db.commit()

        print(f"[behavior] Anomaly scan done — {fired} events fired")
