"""Scheduled credential rotation — SSH password change on managed devices."""
import asyncio
import random
import string

from app.workers.celery_app import celery_app


def _generate_password(length: int = 16) -> str:
    chars = string.ascii_letters + string.digits + "!@#$%^&*"
    return "".join(random.SystemRandom().choice(chars) for _ in range(length))


# Vendor-aware password change command builders
def _change_password_commands(vendor: str, username: str, new_password: str) -> list[str] | None:
    v = (vendor or "").lower()
    if v in ("cisco", "cisco_ios", "cisco_nxos", "cisco_xe"):
        return [
            "configure terminal",
            f"username {username} privilege 15 secret {new_password}",
            "end",
            "write memory",
        ]
    if v == "ruijie":
        return [
            "configure terminal",
            f"username {username} privilege 15 password {new_password}",
            "end",
            "write",
        ]
    if v in ("aruba", "hp", "hpe"):
        return [
            f"password manager user-name {username} plaintext {new_password}",
        ]
    return None  # unsupported — skip


@celery_app.task(name="app.workers.tasks.rotation_tasks.check_rotation_policies")
def check_rotation_policies():
    asyncio.run(_check_due())


@celery_app.task(name="app.workers.tasks.rotation_tasks.rotate_profile")
def rotate_profile(policy_id: int):
    asyncio.run(_rotate(policy_id))


async def _check_due():
    from datetime import datetime, timezone

    from sqlalchemy import select

    from app.core.database import make_worker_session
    from app.models.rotation_policy import RotationPolicy

    async with make_worker_session()() as db:
        now = datetime.now(timezone.utc)
        result = await db.execute(
            select(RotationPolicy).where(
                RotationPolicy.is_active == True,
                RotationPolicy.status != "running",
                RotationPolicy.next_rotate_at <= now,
            )
        )
        due = result.scalars().all()

    for policy in due:
        rotate_profile.delay(policy.id)


async def _rotate(policy_id: int):
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select

    from app.core.database import make_worker_session
    from app.core.security import decrypt_credential, encrypt_credential
    from app.models.credential_profile import CredentialProfile
    from app.models.device import Device
    from app.models.rotation_policy import RotationPolicy
    from app.services.ssh_manager import ssh_manager

    async with make_worker_session()() as db:
        policy = await db.get(RotationPolicy, policy_id)
        if not policy or not policy.is_active:
            return

        profile = await db.get(CredentialProfile, policy.credential_profile_id)
        if not profile or not profile.ssh_username or not profile.ssh_password_enc:
            return

        # Mark running
        policy.status = "running"
        await db.commit()

        username = profile.ssh_username
        new_password = _generate_password()

        # Get all active devices using this profile
        result = await db.execute(
            select(Device).where(
                Device.credential_profile_id == profile.id,
                Device.is_active == True,
            )
        )
        devices = result.scalars().all()

        if not devices:
            policy.status = "success"
            policy.last_rotated_at = datetime.now(timezone.utc)
            policy.next_rotate_at = policy.last_rotated_at + timedelta(days=policy.interval_days)
            policy.last_result = {"message": "No devices assigned to this profile.", "device_results": []}
            await db.commit()
            return

        device_results = []
        all_success = True

        for device in devices:
            cmds = _change_password_commands(device.vendor, username, new_password)
            if cmds is None:
                device_results.append({
                    "device_id": device.id,
                    "hostname": device.hostname,
                    "success": False,
                    "message": f"Vendor '{device.vendor}' desteklenmiyor — manuel rotasyon gerekli",
                })
                all_success = False
                continue

            try:
                # Run commands via SSH — send_config_set equivalent
                loop = asyncio.get_running_loop()
                conn = await ssh_manager._get_connection(device)

                def _run_cmds(c=conn, commands=cmds):
                    # Use send_config_set for config block, last cmd is save
                    config_cmds = [cmd for cmd in commands
                                   if cmd not in ("configure terminal", "end", "write memory", "write")]
                    c.send_config_set(config_cmds)
                    # Save config
                    save_cmd = next((cmd for cmd in commands if cmd in ("write memory", "write")), None)
                    if save_cmd:
                        c.send_command_timing(save_cmd)
                    return "ok"

                await loop.run_in_executor(ssh_manager._executor, _run_cmds)
                device_results.append({
                    "device_id": device.id,
                    "hostname": device.hostname,
                    "success": True,
                    "message": "Şifre başarıyla değiştirildi",
                })
            except Exception as exc:
                device_results.append({
                    "device_id": device.id,
                    "hostname": device.hostname,
                    "success": False,
                    "message": str(exc),
                })
                all_success = False

        now = datetime.now(timezone.utc)

        if all_success:
            # Update profile password
            profile.ssh_password_enc = encrypt_credential(new_password)
            policy.status = "success"
            policy.last_rotated_at = now
            policy.next_rotate_at = now + timedelta(days=policy.interval_days)
        else:
            # Keep old password — do NOT update profile
            policy.status = "failed"

        policy.last_result = {
            "rotated_at": now.isoformat(),
            "all_success": all_success,
            "device_count": len(devices),
            "device_results": device_results,
        }
        await db.commit()

        # Flush SSH pool so next connection uses new creds
        if all_success:
            await ssh_manager.close_all()
