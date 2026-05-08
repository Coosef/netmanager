import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.database import async_engine, Base
import app.models  # noqa: F401 — register all models with Base


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with async_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Safe column additions (idempotent)
        await conn.execute(text(
            "ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS neighbor_type VARCHAR(32)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS layer VARCHAR(32)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS site VARCHAR(64)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS building VARCHAR(64)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS floor VARCHAR(32)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS is_readonly BOOLEAN NOT NULL DEFAULT TRUE"
        ))
        await conn.execute(text(
            "ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS is_scheduled BOOLEAN NOT NULL DEFAULT FALSE"
        ))
        await conn.execute(text(
            "ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS schedule_interval_hours INTEGER NOT NULL DEFAULT 0"
        ))
        await conn.execute(text(
            "ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ"
        ))
        await conn.execute(text(
            "ALTER TABLE playbook_runs ADD COLUMN IF NOT EXISTS is_dry_run BOOLEAN NOT NULL DEFAULT FALSE"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT FALSE"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_type VARCHAR(32) NOT NULL DEFAULT 'switch'"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_enabled BOOLEAN NOT NULL DEFAULT FALSE"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_community VARCHAR(128)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_version VARCHAR(8) NOT NULL DEFAULT 'v2c'"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_port INTEGER NOT NULL DEFAULT 161"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_v3_username VARCHAR(128)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_v3_auth_protocol VARCHAR(8)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_v3_auth_passphrase VARCHAR(256)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_v3_priv_protocol VARCHAR(8)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_v3_priv_passphrase VARCHAR(256)"
        ))
        # Forensics audit columns
        await conn.execute(text(
            "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id VARCHAR(36)"
        ))
        await conn.execute(text(
            "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS duration_ms FLOAT"
        ))
        await conn.execute(text(
            "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS before_state JSONB"
        ))
        await conn.execute(text(
            "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS after_state JSONB"
        ))
        # Credential profile FK on devices
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS credential_profile_id INTEGER REFERENCES credential_profiles(id) ON DELETE SET NULL"
        ))
        # Agent routing intelligence
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS fallback_agent_ids JSONB"
        ))
        # LLDP extended port attributes
        await conn.execute(text(
            "ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS local_duplex VARCHAR(16)"
        ))
        await conn.execute(text(
            "ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS local_port_mode VARCHAR(16)"
        ))
        await conn.execute(text(
            "ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS local_vlan INTEGER"
        ))
        await conn.execute(text(
            "ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS local_poe_enabled BOOLEAN"
        ))
        await conn.execute(text(
            "ALTER TABLE topology_links ADD COLUMN IF NOT EXISTS local_poe_mw INTEGER"
        ))
        # change_rollouts is created via create_all (no ALTER needed — new table)
        # mac_address_entries OUI enrichment columns
        await conn.execute(text(
            "ALTER TABLE mac_address_entries ADD COLUMN IF NOT EXISTS oui_vendor VARCHAR(128)"
        ))
        await conn.execute(text(
            "ALTER TABLE mac_address_entries ADD COLUMN IF NOT EXISTS device_type VARCHAR(32)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_mac_address_entries_device_type ON mac_address_entries(device_type)"
        ))
        # mac_address_entries and arp_entries are created via create_all
        # notification_channels and notification_logs are created via create_all
        # ipam_subnets and ipam_addresses are created via create_all
        # Sprint 8: advanced playbook step types + event triggers + pre-run backup
        await conn.execute(text(
            "ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS trigger_type VARCHAR(16) NOT NULL DEFAULT 'manual'"
        ))
        await conn.execute(text(
            "ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS trigger_event_type VARCHAR(64)"
        ))
        await conn.execute(text(
            "ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS pre_run_backup BOOLEAN NOT NULL DEFAULT FALSE"
        ))
        # Sprint 9: config drift detection
        await conn.execute(text(
            "ALTER TABLE config_backups ADD COLUMN IF NOT EXISTS is_golden BOOLEAN NOT NULL DEFAULT FALSE"
        ))
        await conn.execute(text(
            "ALTER TABLE config_backups ADD COLUMN IF NOT EXISTS golden_set_at TIMESTAMPTZ"
        ))
        # Sprint 10: SLA policies table (created via create_all — no ALTER needed)
        # Rack placement fields on devices
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS rack_name VARCHAR(64)"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS rack_unit INTEGER"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS rack_height INTEGER NOT NULL DEFAULT 1"
        ))
        # rack_items table is created via create_all
        # Multi-tenant: tenant_id on core tables
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "ALTER TABLE ipam_subnets ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_users_tenant_id ON users(tenant_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_devices_tenant_id ON devices(tenant_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_playbooks_tenant_id ON playbooks(tenant_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_tasks_tenant_id ON tasks(tenant_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_alert_rules_tenant_id ON alert_rules(tenant_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_ipam_subnets_tenant_id ON ipam_subnets(tenant_id)"
        ))
        # Secondary resource tenant isolation
        await conn.execute(text(
            "ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "ALTER TABLE change_rollouts ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "ALTER TABLE config_backups ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_approval_requests_tenant_id ON approval_requests(tenant_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_change_rollouts_tenant_id ON change_rollouts(tenant_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_config_backups_tenant_id ON config_backups(tenant_id)"
        ))

        # Agent security & health columns
        await conn.execute(text(
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS command_mode VARCHAR(16) NOT NULL DEFAULT 'all'"
        ))
        await conn.execute(text(
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_commands TEXT"
        ))
        await conn.execute(text(
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS allowed_ips TEXT"
        ))
        await conn.execute(text(
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS failed_auth_count INTEGER NOT NULL DEFAULT 0"
        ))
        await conn.execute(text(
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS key_last_rotated TIMESTAMPTZ"
        ))
        await conn.execute(text(
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_connected_at TIMESTAMPTZ"
        ))
        await conn.execute(text(
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_disconnected_at TIMESTAMPTZ"
        ))
        await conn.execute(text(
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS total_connections INTEGER NOT NULL DEFAULT 0"
        ))
        await conn.execute(text(
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS local_ip VARCHAR(64)"
        ))

        # Driver template health tracking fields
        await conn.execute(text(
            "ALTER TABLE driver_templates ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100"
        ))
        await conn.execute(text(
            "ALTER TABLE driver_templates ADD COLUMN IF NOT EXISTS success_count INTEGER NOT NULL DEFAULT 0"
        ))
        await conn.execute(text(
            "ALTER TABLE driver_templates ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0"
        ))
        await conn.execute(text(
            "ALTER TABLE driver_templates ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ"
        ))
        await conn.execute(text(
            "ALTER TABLE driver_templates ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ"
        ))

        # Agent features v2: syslog, discovery, credential vault
        await conn.execute(text(
            "CREATE TABLE IF NOT EXISTS syslog_events ("
            "id SERIAL PRIMARY KEY, agent_id VARCHAR(32) NOT NULL, "
            "source_ip VARCHAR(45) NOT NULL, facility INTEGER NOT NULL DEFAULT 0, "
            "severity INTEGER NOT NULL DEFAULT 7, message VARCHAR(4096) NOT NULL DEFAULT '', "
            "received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
            ")"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_syslog_agent_received ON syslog_events(agent_id, received_at)"
        ))
        await conn.execute(text(
            "CREATE TABLE IF NOT EXISTS discovery_results ("
            "id SERIAL PRIMARY KEY, agent_id VARCHAR(32) NOT NULL, subnet VARCHAR(64) NOT NULL, "
            "triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ, "
            "status VARCHAR(16) NOT NULL DEFAULT 'completed', "
            "total_discovered INTEGER NOT NULL DEFAULT 0, scanned_count INTEGER NOT NULL DEFAULT 0, "
            "results JSONB NOT NULL DEFAULT '[]'::jsonb"
            ")"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_discovery_results_agent ON discovery_results(agent_id)"
        ))
        await conn.execute(text(
            "CREATE TABLE IF NOT EXISTS agent_credential_bundles ("
            "id SERIAL PRIMARY KEY, agent_id VARCHAR(32) NOT NULL UNIQUE, "
            "agent_aes_key_enc TEXT NOT NULL, bundle_version INTEGER NOT NULL DEFAULT 1, "
            "last_refreshed TIMESTAMPTZ NOT NULL DEFAULT NOW(), device_count INTEGER NOT NULL DEFAULT 0"
            ")"
        ))
        # Sprint 13C: services table is created via create_all (new model Service)
        # No ALTER needed — new table with all columns defined in model

        # Sprint 15A: migrate deprecated Gemini 1.5.x model names to current
        await conn.execute(text(
            "UPDATE ai_settings SET gemini_model = 'gemini-3-flash-preview' "
            "WHERE gemini_model IN ('gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash-8b', "
            "'gemini-2.0-flash-exp')"
        ))

        # Org/Location/RBAC enhancements
        await conn.execute(text(
            "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_tier VARCHAR(32) NOT NULL DEFAULT 'free'"
        ))
        await conn.execute(text(
            "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_devices INTEGER NOT NULL DEFAULT 50"
        ))
        await conn.execute(text(
            "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_users INTEGER NOT NULL DEFAULT 5"
        ))
        await conn.execute(text(
            "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255)"
        ))
        await conn.execute(text(
            "ALTER TABLE locations ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE"
        ))
        await conn.execute(text(
            "ALTER TABLE locations ADD COLUMN IF NOT EXISTS city VARCHAR(128)"
        ))
        await conn.execute(text(
            "ALTER TABLE locations ADD COLUMN IF NOT EXISTS country VARCHAR(64)"
        ))
        await conn.execute(text(
            "ALTER TABLE locations ADD COLUMN IF NOT EXISTS timezone VARCHAR(64)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_locations_tenant_id ON locations(tenant_id)"
        ))
        await conn.execute(text(
            "CREATE TABLE IF NOT EXISTS user_locations ("
            "id SERIAL PRIMARY KEY, "
            "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, "
            "location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE, "
            "loc_role VARCHAR(32) NOT NULL DEFAULT 'location_viewer', "
            "assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), "
            "assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL, "
            "CONSTRAINT uq_user_location UNIQUE(user_id, location_id)"
            ")"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_user_locations_user_id ON user_locations(user_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_user_locations_location_id ON user_locations(location_id)"
        ))
        await conn.execute(text(
            "CREATE TABLE IF NOT EXISTS invite_tokens ("
            "id SERIAL PRIMARY KEY, "
            "token VARCHAR(64) NOT NULL UNIQUE, "
            "email VARCHAR(255) NOT NULL, "
            "role VARCHAR(32) NOT NULL DEFAULT 'viewer', "
            "tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE, "
            "created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, "
            "expires_at TIMESTAMPTZ NOT NULL, "
            "used_at TIMESTAMPTZ, "
            "used_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, "
            "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
            ")"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_invite_tokens_token ON invite_tokens(token)"
        ))

        # RBAC v2: plans, organizations, permission_sets, user_location_perms
        # (tables created via create_all above; just add idempotent columns/indexes below)
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS system_role VARCHAR(32) NOT NULL DEFAULT 'member'"
        ))
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_users_org_id ON users(org_id)"
        ))
        await conn.execute(text(
            "ALTER TABLE invite_tokens ADD COLUMN IF NOT EXISTS system_role VARCHAR(32) NOT NULL DEFAULT 'member'"
        ))
        await conn.execute(text(
            "ALTER TABLE invite_tokens ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE"
        ))
        await conn.execute(text(
            "ALTER TABLE invite_tokens ADD COLUMN IF NOT EXISTS permission_set_id INTEGER REFERENCES permission_sets(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "ALTER TABLE invite_tokens ADD COLUMN IF NOT EXISTS full_name VARCHAR(255)"
        ))

    await _create_default_tenant()
    await _create_default_admin()
    await _ensure_default_org()
    await _seed_builtin_templates()
    await _seed_default_backup_schedule()
    await _seed_driver_templates()

    # Load persisted latency measurements into memory so routing is smart immediately
    from app.services.agent_manager import agent_manager as _am
    await _am.load_latencies_from_db()

    # Load OUI vendor database (downloads IEEE CSV if not cached)
    from app.services import oui_service as _oui
    await _oui.ensure_loaded()

    # Backfill oui_vendor/device_type for existing MAC entries (runs in background)
    import asyncio as _asyncio
    _asyncio.ensure_future(_backfill_mac_oui())

    # Agent-aware device status poller — runs inside FastAPI so agent_manager connections are live
    _asyncio.ensure_future(_agent_device_status_loop())

    yield
    await async_engine.dispose()


async def _agent_device_status_loop():
    """Poll device reachability every 5 minutes using ICMP ping (agent-side ping for private LANs)."""
    import asyncio as _asyncio
    import logging
    import sys
    from datetime import datetime, timezone
    from sqlalchemy import select, update
    from app.core.database import AsyncSessionLocal
    from app.models.device import Device, DeviceStatus
    from app.services.agent_manager import agent_manager

    _log = logging.getLogger("device-status-poller")
    await _asyncio.sleep(30)  # wait for app to fully start

    async def _icmp_ping(ip: str, timeout: int = 3) -> bool:
        flag = "-n" if sys.platform == "win32" else "-c"
        w_flag = ["-w", str(timeout * 1000)] if sys.platform == "win32" else ["-W", str(timeout)]
        try:
            proc = await _asyncio.create_subprocess_exec(
                "ping", flag, "1", *w_flag, ip,
                stdout=_asyncio.subprocess.DEVNULL,
                stderr=_asyncio.subprocess.DEVNULL,
            )
            await _asyncio.wait_for(proc.communicate(), timeout=timeout + 1)
            return proc.returncode == 0
        except Exception:
            return False

    async def _check_reachable(device) -> bool:
        agent_id = getattr(device, "agent_id", None)
        if agent_id and agent_manager.is_online(agent_id):
            # Agent-proxied and agent is live: ask agent to ping (no SSH)
            try:
                return await agent_manager.ping_check(agent_id, device.ip_address, timeout=3)
            except Exception:
                return device.status == DeviceStatus.ONLINE
        # Direct device or agent offline: ICMP from backend
        return await _icmp_ping(device.ip_address)

    while True:
        try:
            async with AsyncSessionLocal() as db:
                devices = (await db.execute(
                    select(Device).where(Device.is_active == True)
                )).scalars().all()

            sem = _asyncio.Semaphore(20)

            async def _check(device):
                async with sem:
                    try:
                        reachable = await _check_reachable(device)
                        new_status = DeviceStatus.ONLINE if reachable else DeviceStatus.OFFLINE
                        values = {"status": new_status}
                        if reachable:
                            values["last_seen"] = datetime.now(timezone.utc)
                        async with AsyncSessionLocal() as db2:
                            await db2.execute(
                                update(Device).where(Device.id == device.id).values(**values)
                            )
                            await db2.commit()
                    except Exception:
                        pass

            await _asyncio.gather(*[_check(d) for d in devices])
            _log.debug(f"Device status poll complete: {len(devices)} devices checked")
        except Exception as exc:
            _log.warning(f"Poll cycle error: {exc}")

        await _asyncio.sleep(300)  # 5 minutes


async def _backfill_mac_oui():
    """One-time background task: fill oui_vendor/device_type for NULL entries."""
    from app.core.database import AsyncSessionLocal
    from app.models.mac_arp import MacAddressEntry
    from app.services import oui_service as _oui
    from sqlalchemy import select

    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(MacAddressEntry.id, MacAddressEntry.mac_address)
            .where(MacAddressEntry.oui_vendor.is_(None))
            .limit(200_000)
        )).fetchall()

        if not rows:
            return

        batch_size = 2000
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            updates = []
            for r in batch:
                vendor = _oui.lookup(r.mac_address)
                dtype = _oui._classify_vendor(vendor) if vendor else "other"
                updates.append({"_id": r.id, "v": vendor, "d": dtype})
            await db.execute(
                text("UPDATE mac_address_entries SET oui_vendor=:v, device_type=:d WHERE id=:_id"),
                updates,
            )
            await db.commit()

        print(f"[OUI backfill] {len(rows)} MAC entries enriched.")


async def _seed_builtin_templates():
    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.models.config_template import ConfigTemplate

    BUILTIN = [
        {
            "name": "[Yerleşik] SNMP v2c Yapılandırma",
            "description": "Cihazda SNMPv2c okuma-only community yapılandırır. Mevcut konfigürasyona dokunmaz.",
            "os_types": ["cisco_ios", "cisco_nxos", "ruijie_os", "generic"],
            "template": "snmp-server community {community} ro",
            "variables": [{"name": "community", "label": "Community String", "default": "netmanager", "required": True}],
            "created_by": "system",
        },
        {
            "name": "[Yerleşik] SNMP v3 Yapılandırma (Cisco)",
            "description": "Cisco IOS/NX-OS için SNMPv3 kullanıcı ve grup oluşturur.",
            "os_types": ["cisco_ios", "cisco_nxos"],
            "template": "snmp-server group NETMANAGER v3 priv\nsnmp-server user {username} NETMANAGER v3 auth sha {auth_password} priv aes 128 {priv_password}",
            "variables": [
                {"name": "username", "label": "SNMP Kullanıcı Adı", "default": "netmanager", "required": True},
                {"name": "auth_password", "label": "Auth Parolası (SHA)", "default": "", "required": True},
                {"name": "priv_password", "label": "Priv Parolası (AES128)", "default": "", "required": True},
            ],
            "created_by": "system",
        },
        {
            "name": "[Yerleşik] SNMP v3 Yapılandırma (Ruijie)",
            "description": "Ruijie OS için SNMPv3 kullanıcı oluşturur.",
            "os_types": ["ruijie_os"],
            "template": "snmp-server v3 user {username} auth sha {auth_password} priv aes128 {priv_password}",
            "variables": [
                {"name": "username", "label": "SNMP Kullanıcı Adı", "default": "netmanager", "required": True},
                {"name": "auth_password", "label": "Auth Parolası (SHA)", "default": "", "required": True},
                {"name": "priv_password", "label": "Priv Parolası (AES128)", "default": "", "required": True},
            ],
            "created_by": "system",
        },
        {
            "name": "[Yerleşik] NTP Sunucu Yapılandırma",
            "description": "Cihaza NTP sunucu adresi ekler.",
            "os_types": ["cisco_ios", "cisco_nxos", "ruijie_os", "generic"],
            "template": "ntp server {ntp_server}",
            "variables": [{"name": "ntp_server", "label": "NTP Sunucu IP", "default": "pool.ntp.org", "required": True}],
            "created_by": "system",
        },
        {
            "name": "[Yerleşik] Syslog Sunucu Yapılandırma",
            "description": "Cihaz loglarını merkezi syslog sunucusuna yönlendirir.",
            "os_types": ["cisco_ios", "cisco_nxos", "ruijie_os", "generic"],
            "template": "logging host {syslog_server}",
            "variables": [{"name": "syslog_server", "label": "Syslog Sunucu IP", "default": "", "required": True}],
            "created_by": "system",
        },
    ]

    async with AsyncSessionLocal() as db:
        for tpl in BUILTIN:
            existing = (await db.execute(
                select(ConfigTemplate).where(ConfigTemplate.name == tpl["name"])
            )).scalar_one_or_none()
            if not existing:
                db.add(ConfigTemplate(**tpl))
        await db.commit()


async def _create_default_tenant():
    """Ensure a default tenant exists and assign unassigned resources to it."""
    from sqlalchemy import select, update as _upd
    from app.core.database import AsyncSessionLocal
    from app.models.tenant import Tenant
    from app.models.user import User
    from app.models.device import Device
    from app.models.playbook import Playbook
    from app.models.task import Task
    from app.models.alert_rule import AlertRule
    from app.models.ipam import IpamSubnet
    from app.models.approval import ApprovalRequest
    from app.models.change_rollout import ChangeRollout
    from app.models.config_backup import ConfigBackup

    async with AsyncSessionLocal() as db:
        tenant = (await db.execute(
            select(Tenant).where(Tenant.slug == "default")
        )).scalar_one_or_none()

        if not tenant:
            tenant = Tenant(name="Varsayılan Organizasyon", slug="default", description="Otomatik oluşturulan varsayılan kiracı")
            db.add(tenant)
            await db.flush()

        tid = tenant.id
        for model in (User, Device, Playbook, Task, AlertRule, IpamSubnet,
                      ApprovalRequest, ChangeRollout, ConfigBackup):
            await db.execute(
                _upd(model).where(model.tenant_id.is_(None)).values(tenant_id=tid)
            )
        await db.commit()
        print(f"[Tenant] Default tenant ensured (id={tid})")


async def _seed_default_backup_schedule():
    """Create the default daily backup schedule if no schedules exist."""
    from datetime import datetime, timezone, timedelta
    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.models.backup_schedule import BackupSchedule
    from app.workers.tasks.bulk_tasks import _compute_next_run

    async with AsyncSessionLocal() as db:
        existing = (await db.execute(select(BackupSchedule).limit(1))).scalar_one_or_none()
        if existing:
            return

        now = datetime.now(timezone.utc)
        next_run = _compute_next_run("daily", 2, 0, None, 24, from_dt=now)
        schedule = BackupSchedule(
            name="Varsayılan Günlük Yedekleme",
            enabled=True,
            schedule_type="daily",
            run_hour=2,
            run_minute=0,
            days_of_week=None,
            interval_hours=24,
            device_filter="all",
            site=None,
            next_run_at=next_run,
            is_default=True,
            created_by=None,
        )
        db.add(schedule)
        await db.commit()
        print("[BackupSchedule] Default daily schedule created (02:00 every day)")


async def _seed_driver_templates():
    from app.core.database import AsyncSessionLocal
    from app.services.driver_seed import seed_driver_templates
    async with AsyncSessionLocal() as db:
        await seed_driver_templates(db)
        print("[DriverTemplates] Built-in templates seeded")


async def _ensure_default_org():
    """Create a default organization and assign all org-less users to it."""
    import copy
    from sqlalchemy import select, func as _func, update as _upd
    from app.core.database import AsyncSessionLocal
    from app.models.shared.organization import Organization
    from app.models.shared.permission_set import PermissionSet, DEFAULT_PERMISSIONS
    from app.models.user import User

    async with AsyncSessionLocal() as db:
        org = (await db.execute(
            select(Organization).where(Organization.slug == "default")
        )).scalar_one_or_none()

        if not org:
            org = Organization(
                name="Varsayılan Organizasyon",
                slug="default",
                description="Sistem tarafından otomatik oluşturuldu",
            )
            db.add(org)
            await db.flush()
            print(f"[Org] Default organization created (id={org.id})")

        org_id = org.id

        # Migrate legacy role → system_role for existing users stuck with default 'member'
        from app.models.user import UserRole
        await db.execute(
            _upd(User)
            .where(User.role == UserRole.SUPER_ADMIN, User.system_role == 'member')
            .values(system_role='super_admin')
        )
        await db.execute(
            _upd(User)
            .where(User.role == UserRole.ADMIN, User.system_role == 'member')
            .values(system_role='org_admin')
        )

        # Assign all org-less users to this org
        result = await db.execute(
            _upd(User).where(User.org_id.is_(None)).values(org_id=org_id)
        )
        if result.rowcount:
            print(f"[Org] {result.rowcount} user(s) assigned to default org")

        # Create default permission sets if none exist for this org
        existing_count = (await db.execute(
            select(_func.count()).select_from(PermissionSet).where(PermissionSet.org_id == org_id)
        )).scalar()

        if not existing_count:
            viewer_perms = copy.deepcopy(DEFAULT_PERMISSIONS)
            for mod in viewer_perms["modules"].values():
                if "view" in mod:
                    mod["view"] = True

            operator_perms = copy.deepcopy(viewer_perms)
            for mod_key, mod in operator_perms["modules"].items():
                if mod_key in ("tasks",):
                    mod["view"] = True
                    mod["create"] = True
                if mod_key == "devices":
                    mod["ssh"] = True
                if mod_key == "playbooks":
                    mod["view"] = True
                    mod["run"] = True

            full_perms = copy.deepcopy(DEFAULT_PERMISSIONS)
            for mod in full_perms["modules"].values():
                for k in mod:
                    mod[k] = True

            db.add(PermissionSet(
                name="Görüntüleyici", description="Salt okunur erişim",
                org_id=org_id, permissions=viewer_perms, is_default=True,
            ))
            db.add(PermissionSet(
                name="Operatör", description="Görüntüle ve temel operasyonlar",
                org_id=org_id, permissions=operator_perms,
            ))
            db.add(PermissionSet(
                name="Tam Yetki", description="Tüm modüllere tam erişim",
                org_id=org_id, permissions=full_perms,
            ))
            print("[Org] Default permission sets created")

        await db.commit()


async def _create_default_admin():
    from sqlalchemy import select
    from app.core.database import AsyncSessionLocal
    from app.core.security import hash_password
    from app.models.user import User, UserRole

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).limit(1))
        if result.scalar_one_or_none() is None:
            from app.models.user import SystemRole
            admin = User(
                username="admin",
                email="admin@netmanager.local",
                hashed_password=hash_password("Admin@1234!"),
                full_name="System Administrator",
                role=UserRole.SUPER_ADMIN,
                system_role=SystemRole.SUPER_ADMIN,
            )
            db.add(admin)
            await db.commit()
            print("Default admin created — username: admin  password: Admin@1234!")


app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    """Attach a unique request_id and start timer to every request."""
    request.state.request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    request.state.started_at = time.monotonic()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response


app.include_router(api_router, prefix="/api/v1")


@app.get("/health")
async def health():
    return {"status": "ok", "app": settings.APP_NAME}
