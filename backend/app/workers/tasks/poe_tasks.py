"""T9 Tur 6B — Periodic PoE per-port snapshot.

Every 15 minutes a fleet-wide sweep:

  1. **SNMP first** (default, much lighter): try POWER-ETHERNET-MIB
     (pethPsePortDetectionStatus + Cisco proprietary cpeExtPsePortPwrConsumption)
     via puresnmp. One UDP burst per device.
  2. **SSH fallback** ONLY if SNMP returned nothing (e.g. community wrong,
     v3 not configured, or non-PoE platform). Parses `show power inline`
     with `topology_service._parse_power_inline`.

Unreachable / non-PoE devices leave their last snapshot untouched (operator
sees they're stale via `updated_at`). Ports that vanished from the latest
read get deleted (e.g. line-card removed).
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
    from app.services import snmp_service
    from app.services.ssh_manager import ssh_manager
    from app.services.topology_service import (
        EXTENDED_COMMANDS, _parse_power_inline,
    )

    # SSH fallback is only viable for OS types that have a parsed
    # `show power inline` command in topology_service. SNMP works for any
    # POWER-ETHERNET-MIB-speaking device regardless of os_type.
    ssh_fallback_os = set(k for k, v in EXTENDED_COMMANDS.items() if "power" in v)
    factory = make_worker_session()
    async with factory() as db:
        with superadmin_context():
            devices = (await db.execute(
                select(Device).where(Device.is_active.is_(True))
            )).scalars().all()

        log.info("poe: snapshotting up to %d active devices", len(devices))
        success_snmp = 0
        success_ssh = 0
        failed = 0
        ports_seen = 0

        for device in devices:
            poe_rows = await _read_via_snmp(device, snmp_service)
            source = "snmp"

            # SSH fallback when SNMP unavailable OR returned no rows.
            if not poe_rows and device.os_type in ssh_fallback_os:
                ssh_rows = await _read_via_ssh(device, ssh_manager, EXTENDED_COMMANDS, _parse_power_inline)
                if ssh_rows:
                    poe_rows = ssh_rows
                    source = "ssh"

            if not poe_rows:
                # Device is not PoE-capable OR unreachable on both paths.
                # Don't churn the snapshot table either way.
                if device.os_type in ssh_fallback_os:
                    # PoE-capable but failed — count as failed for telemetry.
                    failed += 1
                continue

            with org_context(device.organization_id, device.location_id):
                seen_ports: set[str] = set()
                for row in poe_rows:
                    port = row["port"]
                    seen_ports.add(port)
                    existing = (await db.execute(
                        select(PoEPortSnapshot).where(
                            PoEPortSnapshot.device_id == device.id,
                            PoEPortSnapshot.port == port,
                        )
                    )).scalar_one_or_none()
                    oper = row["oper_status"]
                    admin = row.get("admin_status")
                    power_mw = int(row.get("power_mw") or 0)
                    device_class = row.get("device_class")
                    if existing is None:
                        snap = PoEPortSnapshot(
                            device_id=device.id, port=port,
                            oper_status=oper, admin_status=admin,
                            power_mw=power_mw, device_class=device_class,
                            source=source,
                        )
                        db.add(snap)
                    else:
                        existing.oper_status = oper
                        existing.admin_status = admin or existing.admin_status
                        existing.power_mw = power_mw
                        existing.device_class = device_class or existing.device_class
                        existing.source = source
                        existing.updated_at = datetime.now(timezone.utc)

                # Drop rows for ports that vanished from the latest read.
                if seen_ports:
                    await db.execute(
                        delete(PoEPortSnapshot).where(
                            PoEPortSnapshot.device_id == device.id,
                            PoEPortSnapshot.port.notin_(list(seen_ports)),
                        )
                    )
                ports_seen += len(seen_ports)

            await db.commit()
            if source == "snmp":
                success_snmp += 1
            else:
                success_ssh += 1

        log.info(
            "poe: snapshot done — snmp_ok=%d ssh_ok=%d failed=%d ports=%d",
            success_snmp, success_ssh, failed, ports_seen,
        )


async def _read_via_snmp(device, snmp_service) -> list[dict]:
    """Return normalized PoE rows via SNMP. Empty list when device has no
    SNMP credential or POWER-ETHERNET-MIB isn't supported."""
    if not device.snmp_community or not device.ip_address:
        return []
    try:
        rows = await snmp_service.get_poe_status(
            host=device.ip_address,
            community=device.snmp_community,
            version=device.snmp_version or "v2c",
            port=device.snmp_port or 161,
            vendor=(device.vendor or "").lower(),
        )
        return rows or []
    except Exception as exc:  # noqa: BLE001
        log.debug("poe: snmp probe failed for %s — %s", device.hostname, exc)
        return []


async def _read_via_ssh(device, ssh_manager, EXTENDED_COMMANDS, _parse_power_inline) -> list[dict]:
    """SSH fallback — runs `show power inline` and converts to the same row
    shape SNMP returns so the caller is source-agnostic."""
    try:
        cmd = EXTENDED_COMMANDS[device.os_type]["power"]
        result = await ssh_manager.execute_command(device, cmd)
    except Exception as exc:
        log.debug("poe: ssh probe failed for %s — %s", device.hostname, exc)
        return []
    if not result.success or not result.output:
        return []
    parsed = _parse_power_inline(result.output)
    if not parsed:
        return []
    return [
        {
            "port": port,
            "oper_status": "on" if info["enabled"] else "off",
            "admin_status": None,
            "power_mw": int(info.get("mw") or 0),
            "device_class": None,
        }
        for port, info in parsed.items()
    ]
