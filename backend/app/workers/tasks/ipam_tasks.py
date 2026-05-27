"""T9 Tur 7 — IPAM background tasks.

Two periodic jobs:
  sync_arp_to_ipam      — every 15 min — read fresh arp_entries, for each
                          (ip, mac) find the containing subnet (PostgreSQL
                          CIDR contains via GIST index), upsert an
                          IpamAssignment with source='arp'. NEVER touches
                          a row with source='manual'.

  check_subnet_utilization — hourly — for each subnet whose utilization
                          crosses its `utilization_warn_pct`, emit a
                          network_event 'ipam_subnet_high_utilization' so
                          the existing alert engine can route it.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import and_, cast, select, text
from sqlalchemy.dialects.postgresql import INET

from app.workers.celery_app import celery_app

log = logging.getLogger("netmanager.ipam")


@celery_app.task(name="app.workers.tasks.ipam_tasks.sync_arp_to_ipam",
                 soft_time_limit=600, time_limit=900)
def sync_arp_to_ipam():
    asyncio.run(_run_arp_sync())


async def _run_arp_sync():
    from app.core.database import make_worker_session
    from app.core.org_context import org_context, superadmin_context
    from app.models.ipam import IpamAssignment, IpamSubnet
    from app.models.mac_arp import ArpEntry

    factory = make_worker_session()
    async with factory() as db:
        # Fleet-wide select — we route writes per-org below.
        with superadmin_context():
            rows = (await db.execute(
                select(ArpEntry).where(ArpEntry.is_active.is_(True))
            )).scalars().all()
        log.info("ipam: arp sync — %d active ARP entries", len(rows))

        # Group by organization for bulk org_context scoping.
        by_org: dict[int, list[ArpEntry]] = {}
        for e in rows:
            by_org.setdefault(e.organization_id, []).append(e)

        total_upserted = 0
        total_skipped = 0
        import ipaddress
        for org_id, entries in by_org.items():
            with org_context(org_id):
                # Pull this org's subnets + ALL existing assignments once.
                # 3431 ARP × per-row SELECT = ~5dk; bulk preload + in-memory
                # dedupe = ~2sn.
                subnets = (await db.execute(
                    select(IpamSubnet).where(IpamSubnet.deleted_at.is_(None))
                )).scalars().all()
                if not subnets:
                    continue
                parsed_subnets = []
                for s in subnets:
                    try:
                        parsed_subnets.append((s, ipaddress.ip_network(str(s.cidr))))
                    except ValueError:
                        continue
                # Sort by prefix length DESC → longest match wins.
                parsed_subnets.sort(key=lambda x: x[1].prefixlen, reverse=True)

                subnet_ids = [s.id for s, _ in parsed_subnets]
                existing_rows = (await db.execute(
                    select(IpamAssignment).where(
                        IpamAssignment.subnet_id.in_(subnet_ids)
                    )
                )).scalars().all()
                # Build (subnet_id, ip_str_no_mask) → row lookup
                existing_by_key: dict[tuple[int, str], IpamAssignment] = {}
                for a in existing_rows:
                    ip_only = str(a.ip_address).split("/")[0]
                    existing_by_key[(a.subnet_id, ip_only)] = a

                # T9 follow-up — hostname autofill: bu org'taki TÜM cihazları
                # tek query'de bulk al, ip→hostname dict'i kur. ARP entry
                # bir cihaza karşılık geliyorsa Device.hostname kullan.
                from app.models.device import Device
                device_rows = (await db.execute(
                    select(Device.ip_address, Device.hostname)
                )).all()
                ip_to_hostname: dict[str, str] = {}
                for ip_addr, hn in device_rows:
                    if ip_addr and hn:
                        ip_to_hostname[ip_addr] = hn

                for e in entries:
                    try:
                        ip_obj = ipaddress.ip_address(e.ip_address)
                    except ValueError:
                        continue
                    target = next(
                        (s for s, net in parsed_subnets if ip_obj in net),
                        None,
                    )
                    if target is None:
                        total_skipped += 1
                        continue
                    key = (target.id, e.ip_address)
                    existing = existing_by_key.get(key)
                    # Hostname tahmini — cihaz IP'siyse Device.hostname
                    auto_hostname = ip_to_hostname.get(e.ip_address)

                    if existing is None:
                        a = IpamAssignment(
                            subnet_id=target.id, ip_address=e.ip_address,
                            mac_address=e.mac_address,
                            hostname=auto_hostname,
                            description="ARP discovery" + (f" ({auto_hostname})" if auto_hostname else ""),
                            type="dynamic", source="arp",
                            device_id=e.device_id, interface=e.interface,
                            location_id=target.location_id,
                            last_seen_at=e.last_seen,
                        )
                        db.add(a)
                        # cache that we just added — avoid double insert
                        existing_by_key[key] = a
                        total_upserted += 1
                    else:
                        # Only refresh ARP-sourced rows — manual entries
                        # are not clobbered with stale ARP data.
                        if existing.source == "arp":
                            existing.mac_address = e.mac_address
                            existing.device_id = e.device_id
                            existing.interface = e.interface
                            existing.last_seen_at = e.last_seen
                            # Hostname yoksa veya farklıysa güncelle
                            if auto_hostname and existing.hostname != auto_hostname:
                                existing.hostname = auto_hostname
                            total_upserted += 1
                await db.commit()

        log.info(
            "ipam: arp sync done — upserted=%d skipped(no-matching-subnet)=%d",
            total_upserted, total_skipped,
        )


@celery_app.task(name="app.workers.tasks.ipam_tasks.check_subnet_utilization",
                 soft_time_limit=300, time_limit=600)
def check_subnet_utilization():
    asyncio.run(_run_util_check())


async def _run_util_check():
    """Emit network_event for any subnet at/above its warn_pct."""
    from app.core.database import make_worker_session
    from app.core.org_context import org_context, superadmin_context
    from app.models.ipam import IpamAssignment, IpamSubnet
    from app.models.network_event import NetworkEvent
    from app.services import ipam_service

    factory = make_worker_session()
    async with factory() as db:
        with superadmin_context():
            subnets = (await db.execute(
                select(IpamSubnet).where(IpamSubnet.deleted_at.is_(None))
            )).scalars().all()

        fired = 0
        for s in subnets:
            with org_context(s.organization_id):
                util = await ipam_service.compute_utilization(db, s)
                if not util["is_high"]:
                    continue
                # Dedup: don't spam — only one event per subnet per day.
                # The existing network_event dedup mechanism (24h key) will
                # collapse rapid re-fires; rely on it rather than custom logic.
                evt = NetworkEvent(
                    device_id=None,
                    device_hostname=None,
                    event_type="ipam_subnet_high_utilization",
                    severity="warning",
                    title=f"IPAM: {s.cidr} doluluk %{util['pct']}",
                    message=(
                        f"Subnet {s.cidr} ({s.name or '—'}) "
                        f"%{util['pct']} dolu (eşik %{util['warn_pct']}). "
                        f"{util['used']}/{util['total']} IP kullanılıyor."
                    ),
                    details={
                        "subnet_id": s.id, "cidr": str(s.cidr),
                        "used": util["used"], "total": util["total"],
                        "pct": util["pct"], "warn_pct": util["warn_pct"],
                    },
                )
                db.add(evt)
                fired += 1
        await db.commit()
        log.info("ipam: utilization check fired %d high-usage events", fired)
