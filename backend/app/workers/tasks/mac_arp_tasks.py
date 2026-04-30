"""Periodic MAC address table and ARP table collection task."""
import asyncio
import concurrent.futures

from app.workers.celery_app import celery_app


def _run_async(coro):
    return asyncio.run(coro)


@celery_app.task(name="app.workers.tasks.mac_arp_tasks.collect_mac_arp_all")
def collect_mac_arp_all():
    """Runs every 15 minutes. Collects MAC + ARP tables from all online devices."""
    async def _run():
        from sqlalchemy import select, delete as _del
        from datetime import datetime, timezone
        from app.core.database import make_worker_session
        from app.models.device import Device
        from app.models.mac_arp import MacAddressEntry, ArpEntry
        from app.api.v1.endpoints.mac_arp import _collect_device

        async with make_worker_session()() as db:
            result = await db.execute(
                select(Device).where(
                    Device.is_active == True,
                    Device.status == "online",
                )
            )
            devices = result.scalars().all()

            if not devices:
                return

            results = await asyncio.gather(
                *[_collect_device(d, db) for d in devices],
                return_exceptions=True,
            )
            await db.commit()

            succeeded = sum(1 for r in results if isinstance(r, dict))
            total_mac = sum(r.get("mac_collected", 0) for r in results if isinstance(r, dict))
            total_arp = sum(r.get("arp_collected", 0) for r in results if isinstance(r, dict))
            print(
                f"[mac_arp] Collected from {succeeded}/{len(devices)} devices — "
                f"MAC: {total_mac}, ARP: {total_arp}"
            )

    _run_async(_run())
