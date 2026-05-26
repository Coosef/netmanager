"""T9 Tur 6B — Periodic PoE per-port snapshot.

Every 15 minutes:
  - for each PoE-capable device (vendor declared `show power inline`),
    run the command, parse it, upsert one PoEPortSnapshot row per port,
    delete rows for ports that disappeared from the latest output.
  - missing/unreachable devices: their last snapshot rows are left
    untouched (operator sees they're stale via `updated_at`).

We deliberately reuse `topology_service._parse_power_inline` so any
fix to the parser benefits both paths.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import delete, select

from app.workers.celery_app import celery_app

log = logging.getLogger("netmanager.poe")


@celery_app.task(name="app.workers.tasks.poe_tasks.snapshot_poe_status",
                 soft_time_limit=900, time_limit=1200)
def snapshot_poe_status():
    """Iterate PoE-capable devices, snapshot per-port PoE state."""
    asyncio.run(_run())


async def _run():
    from app.core.database import make_worker_session
    from app.core.org_context import org_context, superadmin_context
    from app.models.device import Device
    from app.models.poe_port_snapshot import PoEPortSnapshot
    from app.services.ssh_manager import ssh_manager
    from app.services.topology_service import (
        EXTENDED_COMMANDS, _parse_power_inline,
    )

    poe_os_types = [k for k, v in EXTENDED_COMMANDS.items() if "power" in v]
    factory = make_worker_session()
    async with factory() as db:
        # Fleet-wide sweep — super-admin bypass for the device select; we
        # switch into each device's org_context before writing snapshots.
        with superadmin_context():
            devices = (await db.execute(
                select(Device).where(
                    Device.os_type.in_(poe_os_types),
                    Device.is_active.is_(True),
                )
            )).scalars().all()

        log.info("poe: snapshotting %d candidate devices", len(devices))
        success = 0
        failed = 0
        ports_seen = 0

        for device in devices:
            try:
                cmd = EXTENDED_COMMANDS[device.os_type]["power"]
                result = await ssh_manager.execute_command(device, cmd)
            except Exception:
                failed += 1
                continue
            if not result.success or not result.output:
                failed += 1
                continue

            poe_rows = _parse_power_inline(result.output)
            if not poe_rows:
                # Device claims PoE-capable but parsed nothing — non-PoE
                # platform. Don't churn the snapshot table.
                continue

            with org_context(device.organization_id, device.location_id):
                seen_ports: set[str] = set()
                for port, info in poe_rows.items():
                    seen_ports.add(port)
                    existing = (await db.execute(
                        select(PoEPortSnapshot).where(
                            PoEPortSnapshot.device_id == device.id,
                            PoEPortSnapshot.port == port,
                        )
                    )).scalar_one_or_none()
                    if existing is None:
                        snap = PoEPortSnapshot(
                            device_id=device.id, port=port,
                            oper_status="on" if info["enabled"] else "off",
                            power_mw=int(info["mw"] or 0),
                        )
                        db.add(snap)
                    else:
                        existing.oper_status = "on" if info["enabled"] else "off"
                        existing.power_mw = int(info["mw"] or 0)
                        existing.updated_at = datetime.now(timezone.utc)

                # Drop rows for ports that vanished (e.g. removed line card).
                if seen_ports:
                    await db.execute(
                        delete(PoEPortSnapshot).where(
                            PoEPortSnapshot.device_id == device.id,
                            PoEPortSnapshot.port.notin_(list(seen_ports)),
                        )
                    )
                ports_seen += len(seen_ports)

            await db.commit()
            success += 1

        log.info(
            "poe: snapshot done — devices ok=%d failed=%d ports=%d",
            success, failed, ports_seen,
        )
