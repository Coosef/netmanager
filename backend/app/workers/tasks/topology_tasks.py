import asyncio
import json
import re
from datetime import datetime, timezone
from dataclasses import asdict

import redis
from sqlalchemy import select, update

from app.core.config import settings
from app.core.security import decrypt_credential, encrypt_credential
from app.models.device import Device
from app.models.task import Task, TaskStatus
from app.services.ssh_manager import SSHManager
from app.services.topology_service import TopologyService, detect_device_type
from app.workers.celery_app import celery_app


def _parse_show_version(output: str) -> dict:
    """Extract hostname, model, firmware from show version output."""
    result = {}

    for pattern in [
        r"[Ss]ystem\s+[Hh]ostname\s*[:\s]+(\S+)",
        r"^(\S+)\s+uptime\s+is",
        r"hostname\s+(\S+)",
    ]:
        m = re.search(pattern, output, re.MULTILINE)
        if m:
            result["hostname"] = m.group(1).strip()
            break

    for pattern in [
        r"[Ss]ystem\s+description\s*:\s*Ruijie\s+[^(]+\(([^)]+)\)",
        r"[Mm]odel\s*[Nn]umber\s*[:\s]+(\S+)",
        r"[Mm]odel\s*[:\s]+(\S+)",
        r"Cisco\s+([\w-]+)\s+(?:Software|processor|Series)",
        r"Ruijie\s+([\w-]+)\s+Software",
        r"RG-([\w-]+)[\s,]",
    ]:
        m = re.search(pattern, output, re.MULTILINE)
        if m:
            result["model"] = m.group(1).strip()
            break

    for pattern in [
        r"[Vv]ersion\s+\S*RGOS\s+([\d\.]+\S*)",
        r"[Ss]ystem\s+[Ss]oftware\s+[Vv]ersion\s*[:\s]+\S+\s+([\d\.]+\S*)",
        r"[Vv]ersion\s+([\d\.]+\([^)]+\)[a-zA-Z0-9]*)",
        r"[Ss]oftware\s+[Vv]ersion\s*[,:\s]+([\d\.]+\S*)",
        r"[Vv]ersion\s+([\d\.]+)",
    ]:
        m = re.search(pattern, output)
        if m:
            result["firmware_version"] = m.group(1).strip().rstrip(",")
            break

    for pattern in [
        r"[Ss]ystem\s+[Ss]erial\s+[Nn]umber\s*[:\s]+(\S+)",
        r"[Ss]erial\s*[Nn]umber\s*[:\s]+(\S+)",
        r"Processor board ID\s+(\S+)",
    ]:
        m = re.search(pattern, output)
        if m:
            result["serial_number"] = m.group(1).strip()
            break

    return result

_redis = redis.from_url(settings.REDIS_URL, decode_responses=True)


def _run_async(coro):
    return asyncio.run(coro)


def _get_db():
    from app.core.database import SyncSessionLocal
    return SyncSessionLocal()


@celery_app.task(bind=True, name="app.workers.tasks.topology_tasks.discover_topology")
def discover_topology(self, task_id: int, device_ids: list[int]):
    from app.core.database import AsyncSessionLocal

    async def _run():
        from sqlalchemy import select, update
        from app.models.task import Task, TaskStatus
        from app.models.device import Device

        async with AsyncSessionLocal() as db:
            await db.execute(
                update(Task).where(Task.id == task_id).values(
                    status=TaskStatus.RUNNING,
                    started_at=datetime.now(timezone.utc),
                    celery_task_id=self.request.id,
                )
            )
            await db.commit()

            ssh = SSHManager()
            svc = TopologyService(ssh)

            devices_result = await db.execute(
                select(Device).where(Device.id.in_(device_ids), Device.is_active == True)
            )
            devices: list[Device] = devices_result.scalars().all()

            # Build hostname lookup map for matching
            all_devices_result = await db.execute(select(Device).where(Device.is_active == True))
            all_devices = all_devices_result.scalars().all()
            hostname_map = {d.hostname.lower(): d.id for d in all_devices}

            completed, failed = 0, 0
            results = {}

            for device in devices:
                try:
                    neighbors = await svc.discover_device(device)
                    await svc.save_links(db, device, neighbors, hostname_map)
                    results[str(device.id)] = {
                        "hostname": device.hostname,
                        "success": True,
                        "neighbor_count": len(neighbors),
                        "neighbors": [
                            {"hostname": n.neighbor_hostname, "port": n.local_port, "protocol": n.protocol}
                            for n in neighbors
                        ],
                    }
                    completed += 1
                except Exception as e:
                    results[str(device.id)] = {"hostname": device.hostname, "success": False, "error": str(e)}
                    failed += 1

                # Publish progress
                _redis.publish(
                    f"task:{task_id}:progress",
                    json.dumps({
                        "task_id": task_id,
                        "completed": completed,
                        "failed": failed,
                        "status": TaskStatus.RUNNING,
                    }),
                )

            final_status = (
                TaskStatus.SUCCESS if failed == 0
                else TaskStatus.PARTIAL if completed > 0
                else TaskStatus.FAILED
            )

            await db.execute(
                update(Task).where(Task.id == task_id).values(
                    status=final_status,
                    completed_devices=completed,
                    failed_devices=failed,
                    result=results,
                    completed_at=datetime.now(timezone.utc),
                )
            )
            await db.commit()

            # Invalidate topology cache (pattern match — keys are topology:graph:all, topology:graph:123…)
            for key in _redis.keys("topology:graph:*"):
                _redis.delete(key)

            await ssh.close_all()

    _run_async(_run())


@celery_app.task(bind=True, name="app.workers.tasks.topology_tasks.hop_discover_task")
def hop_discover_task(self, task_id: int, source_device_id: int, target_ips: list[str], max_depth: int = 5):
    """
    Cascade LLDP: SSH into discovered ghost switches using source device credentials,
    run LLDP, find more switches, repeat up to max_depth hops.
    Safe: read-only show commands only.
    """
    async def _run():
        from app.core.database import make_worker_session

        async with make_worker_session()() as db:
            await db.execute(
                update(Task).where(Task.id == task_id).values(
                    status=TaskStatus.RUNNING,
                    started_at=datetime.now(timezone.utc),
                    celery_task_id=self.request.id,
                )
            )
            await db.commit()

            # Get source device credentials
            source = (await db.execute(select(Device).where(Device.id == source_device_id))).scalar_one_or_none()
            if not source:
                await db.execute(update(Task).where(Task.id == task_id).values(
                    status=TaskStatus.FAILED, result={"error": "Source device not found"}
                ))
                await db.commit()
                return

            ssh_username = source.ssh_username
            ssh_password = decrypt_credential(source.ssh_password_enc)
            ssh_port = source.ssh_port
            os_type = source.os_type

            all_devices = (await db.execute(select(Device).where(Device.is_active == True))).scalars().all()
            hostname_map = {d.hostname.lower(): d.id for d in all_devices}
            ip_map = {d.ip_address: d.id for d in all_devices}

            discovered_new: list[dict] = []
            visited_ips: set[str] = set(ip_map.keys())  # don't revisit known devices
            # Deduplicate target_ips preserving order (defensive: endpoint already deduplicates)
            _seen: set[str] = set()
            queue: list[str] = []
            for _ip in target_ips:
                if _ip and _ip not in visited_ips and _ip not in _seen:
                    _seen.add(_ip)
                    queue.append(_ip)
            depth = 0
            completed = 0
            failed = 0

            while queue and depth < max_depth:
                depth += 1
                next_queue: list[str] = []

                for ip in queue:
                    if ip in visited_ips:
                        continue
                    visited_ips.add(ip)

                    # Use IP-derived unique ID so SSHManager never reuses a cached connection
                    # across different IPs (all id=0 would share the same pool slot).
                    parts = ip.split(".")
                    try:
                        temp_id = -(int(parts[0]) * 16777216 + int(parts[1]) * 65536 +
                                    int(parts[2]) * 256 + int(parts[3]))
                    except Exception:
                        temp_id = -abs(hash(ip))

                    # Fresh SSH manager per IP — avoids connection pool cross-contamination
                    hop_ssh = SSHManager()
                    hop_svc = TopologyService(hop_ssh)

                    temp_device = Device(
                        id=temp_id,
                        hostname=ip,
                        ip_address=ip,
                        ssh_username=ssh_username,
                        ssh_password_enc=source.ssh_password_enc,
                        enable_secret_enc=source.enable_secret_enc,
                        ssh_port=ssh_port,
                        os_type=os_type,
                        vendor=source.vendor,
                    )

                    neighbors: list = []
                    device_info: dict = {}
                    try:
                        neighbors = await hop_svc.discover_device(temp_device)
                        # While the connection is still open, grab show version for device info
                        ver_result = await hop_svc.ssh.execute_command(temp_device, "show version")
                        if ver_result.success and ver_result.output:
                            device_info = _parse_show_version(ver_result.output)
                    except Exception as e:
                        failed += 1
                        _redis.publish(f"task:{task_id}:progress", json.dumps({
                            "task_id": task_id, "completed": completed, "failed": failed,
                            "depth": depth, "ip": ip, "error": str(e),
                        }))
                        continue
                    finally:
                        await hop_svc.ssh.close_all()

                    # Add device to inventory if not already there (use nested try for DB safety)
                    real_device = None
                    try:
                        existing = (await db.execute(
                            select(Device).where(Device.ip_address == ip)
                        )).scalar_one_or_none()

                        if existing:
                            real_device = existing
                            # Update info on existing device if we got better data
                            if device_info.get("hostname") and existing.hostname == ip:
                                existing.hostname = device_info["hostname"]
                            if device_info.get("model"):
                                existing.model = device_info["model"]
                            if device_info.get("firmware_version"):
                                existing.firmware_version = device_info["firmware_version"]
                            if device_info.get("serial_number"):
                                existing.serial_number = device_info["serial_number"]
                            existing.status = "online"
                            await db.commit()
                            await db.refresh(existing)
                        else:
                            real_device = Device(
                                hostname=device_info.get("hostname") or ip,
                                ip_address=ip,
                                vendor=source.vendor,
                                os_type=os_type,
                                model=device_info.get("model"),
                                firmware_version=device_info.get("firmware_version"),
                                serial_number=device_info.get("serial_number"),
                                ssh_username=ssh_username,
                                ssh_password_enc=source.ssh_password_enc,
                                enable_secret_enc=source.enable_secret_enc,
                                ssh_port=ssh_port,
                                status="online",
                                is_active=True,
                                location=source.location,
                                group_id=source.group_id,
                            )
                            db.add(real_device)
                            await db.commit()
                            await db.refresh(real_device)
                            # Refresh lookup maps after adding a new device
                            all_devices_new = (await db.execute(
                                select(Device).where(Device.is_active == True)
                            )).scalars().all()
                            hostname_map = {d.hostname.lower(): d.id for d in all_devices_new}
                            ip_map = {d.ip_address: d.id for d in all_devices_new}
                    except Exception as db_err:
                        # Rollback so the session stays usable for the next iteration
                        await db.rollback()
                        _redis.publish(f"task:{task_id}:progress", json.dumps({
                            "task_id": task_id, "completed": completed, "failed": failed,
                            "depth": depth, "ip": ip, "error": f"DB: {db_err}",
                        }))
                        failed += 1
                        continue

                    # Save LLDP links with the real device ID
                    if real_device and neighbors:
                        try:
                            await hop_svc.save_links(db, real_device, neighbors, hostname_map)
                        except Exception:
                            await db.rollback()

                    found_switches = []
                    for n in neighbors:
                        ntype = detect_device_type(n.neighbor_platform, n.neighbor_hostname)
                        discovered_new.append({
                            "source_ip": ip,
                            "local_port": n.local_port,
                            "hostname": n.neighbor_hostname,
                            "ip": n.neighbor_ip,
                            "port": n.neighbor_port,
                            "device_type": ntype,
                            "protocol": n.protocol,
                        })
                        if ntype == "switch" and n.neighbor_ip and n.neighbor_ip not in visited_ips:
                            found_switches.append(n.neighbor_ip)
                            next_queue.append(n.neighbor_ip)

                    completed += 1
                    _redis.publish(f"task:{task_id}:progress", json.dumps({
                        "task_id": task_id, "completed": completed, "failed": failed,
                        "depth": depth, "ip": ip, "found": len(found_switches),
                    }))

                queue = next_queue

            final_status = TaskStatus.SUCCESS if failed == 0 else (
                TaskStatus.PARTIAL if completed > 0 else TaskStatus.FAILED
            )
            await db.execute(
                update(Task).where(Task.id == task_id).values(
                    status=final_status,
                    completed_devices=completed,
                    failed_devices=failed,
                    result={"discovered": discovered_new, "depth_reached": depth},
                    completed_at=datetime.now(timezone.utc),
                )
            )
            await db.commit()

            for key in _redis.keys("topology:graph:*"):
                _redis.delete(key)

    _run_async(_run())


@celery_app.task(name="app.workers.tasks.topology_tasks.scheduled_topology_discovery")
def scheduled_topology_discovery():
    async def _run():
        from app.core.database import AsyncSessionLocal
        from app.models.task import Task, TaskType, TaskStatus

        async with AsyncSessionLocal() as db:
            devices_result = await db.execute(
                select(Device).where(Device.is_active == True)
            )
            devices = devices_result.scalars().all()
            device_ids = [d.id for d in devices]
            if not device_ids:
                return

            task = Task(
                name="Scheduled Topology Discovery",
                type=TaskType.MONITOR_POLL,
                status=TaskStatus.PENDING,
                device_ids=device_ids,
                total_devices=len(device_ids),
                created_by=1,
            )
            db.add(task)
            await db.commit()
            await db.refresh(task)

            discover_topology.apply_async(
                args=[task.id, device_ids],
                queue="monitor",
            )

    _run_async(_run())
