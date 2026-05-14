import os
import re
import time
import uuid
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import text

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.database import async_engine, Base
from app.core.logging_config import configure_logging
from app.core.metrics import (
    HTTP_REQUESTS_TOTAL,
    HTTP_REQUEST_DURATION_SECONDS,
)
from app.core.utils import normalize_path
import app.models  # noqa: F401 — register all models with Base

configure_logging()

_req_log = structlog.get_logger("netmanager.http")

# Paths excluded from request logging and HTTP metrics (avoid log storms)
_SKIP_LOG_PATHS = frozenset({
    "/health", "/health/ready", "/health/live",
    "/metrics", "/openapi.json", "/api/docs", "/api/redoc",
})

limiter = Limiter(key_func=get_remote_address, default_limits=["1000/minute"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with async_engine.begin() as conn:
        # ── DEPRECATED: create_all + ALTER TABLE pattern ──────────────────────
        # Faz 5A (2026-05-13): Alembic is now the authoritative schema manager.
        # DO NOT add new ALTER TABLE, CREATE TABLE, or CREATE INDEX statements
        # to this block. All future DDL changes must go through an Alembic
        # revision in backend/alembic/versions/.
        #
        # create_all() is kept for fresh-install compatibility only (new dev
        # envs that spin up without a pre-existing DB). On existing DBs, Alembic
        # handles all incremental changes via `alembic upgrade head`.
        # See: backend/alembic/versions/ and DEPLOY_CHECKLIST.md §2
        # ─────────────────────────────────────────────────────────────────────
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
        # Composite indexes for Monitor page queries — single-col indexes managed by Alembic;
        # composite/partial ones mirrored in model __table_args__ (create_all handles fresh DBs).
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_network_events_created_sev ON network_events(created_at, severity)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_snmp_poll_results_device_polled ON snmp_poll_results(device_id, polled_at)"
        ))
        # Composite indexes for config_backups — speeds up latest-per-device subquery in config_search
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_config_backups_device_created ON config_backups(device_id, created_at DESC)"
        ))
        # Composite index for per-device event queries in DeviceDetail syslog tab
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_network_events_device_created ON network_events(device_id, created_at DESC)"
        ))
        # Index for notification_logs dedup lookups (channel + source)
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_notification_logs_channel_source ON notification_logs(channel_id, source_type, source_id)"
        ))
        # Partial index: unacknowledged events only — used in acknowledge-all and unacked_only filter
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_network_events_unacked ON network_events(created_at DESC) WHERE acknowledged = FALSE"
        ))
        # Expand snmp_community columns to hold Fernet-encrypted values (~200 chars)
        await conn.execute(text(
            "ALTER TABLE devices ALTER COLUMN snmp_community TYPE VARCHAR(512)"
        ))
        await conn.execute(text(
            "ALTER TABLE credential_profiles ALTER COLUMN snmp_community TYPE VARCHAR(512)"
        ))
        # Encrypt any existing plaintext SNMP community strings
        await _encrypt_existing_snmp_communities(conn)
        # change_rollouts execution result columns
        await conn.execute(text(
            "ALTER TABLE change_rollouts ADD COLUMN IF NOT EXISTS total_devices INTEGER NOT NULL DEFAULT 0"
        ))
        await conn.execute(text(
            "ALTER TABLE change_rollouts ADD COLUMN IF NOT EXISTS success_devices INTEGER NOT NULL DEFAULT 0"
        ))
        await conn.execute(text(
            "ALTER TABLE change_rollouts ADD COLUMN IF NOT EXISTS failed_devices INTEGER NOT NULL DEFAULT 0"
        ))
        await conn.execute(text(
            "ALTER TABLE change_rollouts ADD COLUMN IF NOT EXISTS rolled_back_devices INTEGER NOT NULL DEFAULT 0"
        ))

        # Agent tenant isolation
        await conn.execute(text(
            "ALTER TABLE agents ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_agents_tenant_id ON agents(tenant_id)"
        ))

        # MAC/ARP composite indexes (non-unique, always safe)
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_mac_entries_device_active ON mac_address_entries(device_id, is_active)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_arp_entries_device_active ON arp_entries(device_id, is_active)"
        ))

        # Faz 2D — availability scoring fields (daily computed, all nullable)
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS availability_24h FLOAT"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS availability_7d FLOAT"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS mtbf_hours FLOAT"
        ))
        await conn.execute(text(
            "ALTER TABLE devices ADD COLUMN IF NOT EXISTS experience_score FLOAT"
        ))
        # Faz 3A — availability snapshot history
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS device_availability_snapshots (
                id SERIAL PRIMARY KEY,
                device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                ts TIMESTAMPTZ NOT NULL,
                availability_24h FLOAT NOT NULL,
                availability_7d FLOAT NOT NULL,
                mtbf_hours FLOAT,
                experience_score FLOAT NOT NULL
            )
        """))
        # Faz 3B — synthetic probe definitions + results
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS synthetic_probes (
                id SERIAL PRIMARY KEY,
                name VARCHAR(128) NOT NULL,
                device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
                agent_id VARCHAR(32),
                probe_type VARCHAR(16) NOT NULL,
                target VARCHAR(255) NOT NULL,
                port INTEGER,
                http_method VARCHAR(8) NOT NULL DEFAULT 'GET',
                expected_status INTEGER,
                dns_record_type VARCHAR(8) NOT NULL DEFAULT 'A',
                interval_secs INTEGER NOT NULL DEFAULT 300,
                timeout_secs INTEGER NOT NULL DEFAULT 5,
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS synthetic_probe_results (
                id SERIAL PRIMARY KEY,
                probe_id INTEGER NOT NULL REFERENCES synthetic_probes(id) ON DELETE CASCADE,
                success BOOLEAN NOT NULL,
                latency_ms FLOAT,
                detail VARCHAR(512),
                measured_at TIMESTAMPTZ NOT NULL
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_spr_probe_ts "
            "ON synthetic_probe_results (probe_id, measured_at)"
        ))
        # Faz 3C — agent peer latency history
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS agent_peer_latencies (
                id SERIAL PRIMARY KEY,
                agent_from VARCHAR(32) NOT NULL,
                agent_to VARCHAR(32) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                target_ip VARCHAR(64) NOT NULL,
                latency_ms FLOAT,
                reachable BOOLEAN NOT NULL,
                measured_at TIMESTAMPTZ NOT NULL
            )
        """))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_apl_agent_to_ts "
            "ON agent_peer_latencies (agent_to, measured_at)"
        ))
        # Faz 4C — SLA threshold columns on synthetic_probes
        await conn.execute(text(
            "ALTER TABLE synthetic_probes ADD COLUMN IF NOT EXISTS "
            "sla_enabled BOOLEAN NOT NULL DEFAULT TRUE"
        ))
        await conn.execute(text(
            "ALTER TABLE synthetic_probes ADD COLUMN IF NOT EXISTS "
            "sla_success_rate_pct FLOAT NOT NULL DEFAULT 99.0"
        ))
        await conn.execute(text(
            "ALTER TABLE synthetic_probes ADD COLUMN IF NOT EXISTS "
            "sla_latency_ms FLOAT"
        ))
        await conn.execute(text(
            "ALTER TABLE synthetic_probes ADD COLUMN IF NOT EXISTS "
            "sla_window_hours INTEGER NOT NULL DEFAULT 24"
        ))

        # ── Faz 4B — TimescaleDB hypertables ─────────────────────────────────
        # Each DO block is idempotent: converts only if not already a hypertable.
        # PK is changed to (id, time_col) because TimescaleDB requires the
        # partition column to be part of any UNIQUE / PRIMARY KEY constraint.
        for _tbl, _time_col, _interval in [
            ("snmp_poll_results",             "polled_at",   "1 week"),
            ("device_availability_snapshots", "ts",          "1 month"),
            ("agent_peer_latencies",          "measured_at", "1 week"),
            ("synthetic_probe_results",       "measured_at", "1 week"),
            ("syslog_events",                 "received_at", "1 week"),
        ]:
            await conn.execute(text(f"""
                DO $do$
                BEGIN
                  IF NOT EXISTS (
                    SELECT 1 FROM timescaledb_information.hypertables
                    WHERE hypertable_name = '{_tbl}'
                  ) THEN
                    ALTER TABLE {_tbl} DROP CONSTRAINT {_tbl}_pkey;
                    ALTER TABLE {_tbl} ADD CONSTRAINT {_tbl}_pkey
                      PRIMARY KEY (id, {_time_col});
                    PERFORM create_hypertable('{_tbl}', '{_time_col}',
                      migrate_data => true,
                      chunk_time_interval => INTERVAL '{_interval}'
                    );
                  END IF;
                END $do$;
            """))

        # Compression for snmp_poll_results (highest volume table)
        await conn.execute(text("""
            DO $do$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM timescaledb_information.compression_settings
                WHERE hypertable_name = 'snmp_poll_results'
              ) THEN
                ALTER TABLE snmp_poll_results SET (
                  timescaledb.compress,
                  timescaledb.compress_segmentby = 'device_id',
                  timescaledb.compress_orderby = 'polled_at DESC'
                );
                PERFORM add_compression_policy('snmp_poll_results',
                  INTERVAL '7 days', if_not_exists => true);
              END IF;
            END $do$;
        """))

        # ── Faz 4E — Escalation Rule Engine ──────────────────────────────────
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS escalation_rules (
                id               SERIAL PRIMARY KEY,
                name             VARCHAR(200) NOT NULL,
                enabled          BOOLEAN NOT NULL DEFAULT TRUE,
                description      TEXT,
                match_severity   TEXT,
                match_event_types TEXT,
                match_sources    TEXT,
                min_duration_secs INTEGER,
                match_states     TEXT,
                webhook_type     VARCHAR(20) NOT NULL,
                webhook_url      VARCHAR(500) NOT NULL,
                webhook_headers  TEXT,
                cooldown_secs    INTEGER NOT NULL DEFAULT 3600,
                created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
            )
        """))
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS escalation_notification_logs (
                id           SERIAL PRIMARY KEY,
                rule_id      INTEGER NOT NULL REFERENCES escalation_rules(id) ON DELETE CASCADE,
                incident_id  INTEGER NOT NULL,
                channel      VARCHAR(20) NOT NULL,
                status       VARCHAR(20) NOT NULL,
                response_code INTEGER,
                error_msg    TEXT,
                sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))

        # TimescaleDB retention policies — drop old chunks automatically.
        # These replace the manual DELETE approach in retention_tasks.py.
        for _tbl, _interval in [
            ("snmp_poll_results",             "30 days"),
            ("syslog_events",                 "30 days"),
            ("device_availability_snapshots", "90 days"),
            ("agent_peer_latencies",          "90 days"),
            ("synthetic_probe_results",       "90 days"),
        ]:
            await conn.execute(text(
                f"SELECT add_retention_policy('{_tbl}', INTERVAL '{_interval}',"
                f" if_not_exists => true)"
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

    # A→B agent peer latency loop — requires live WebSocket connections (FastAPI process only)
    _asyncio.ensure_future(_ab_peer_latency_loop())

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


async def _ab_peer_latency_loop():
    """Measure A→B latency between all online agent pairs every 15 minutes."""
    import asyncio as _asyncio
    import logging
    from app.core.database import AsyncSessionLocal
    from app.services.agent_manager import agent_manager

    _log = logging.getLogger("ab-peer-latency")
    await _asyncio.sleep(120)  # wait for agents to connect on startup
    while True:
        try:
            async with AsyncSessionLocal() as db:
                count = await agent_manager.measure_ab_peer_latency(db)
                _log.debug("A→B peer latency sweep: %d pairs", count)
        except Exception:
            _log.exception("A→B peer latency sweep failed")
        await _asyncio.sleep(900)


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


async def _encrypt_existing_snmp_communities(conn) -> None:
    """One-time migration: encrypt any plaintext SNMP community strings in devices and credential_profiles."""
    from app.core.security import encrypt_credential, decrypt_credential_safe
    from cryptography.fernet import InvalidToken

    def _needs_encryption(val: str) -> bool:
        try:
            from cryptography.fernet import Fernet
            from app.core.config import settings
            Fernet(settings.CREDENTIAL_ENCRYPTION_KEY.encode()).decrypt(val.encode())
            return False  # already encrypted
        except Exception:
            return True  # plaintext

    for table in ("devices", "credential_profiles"):
        rows = (await conn.execute(
            text(f"SELECT id, snmp_community FROM {table} WHERE snmp_community IS NOT NULL AND snmp_community != ''")
        )).fetchall()
        for row_id, community in rows:
            if _needs_encryption(community):
                encrypted = encrypt_credential(community)
                await conn.execute(
                    text(f"UPDATE {table} SET snmp_community = :enc WHERE id = :id"),
                    {"enc": encrypted, "id": row_id},
                )


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
    """Create one Organization per Tenant and assign users to matching org."""
    import copy
    from sqlalchemy import select, func as _func, update as _upd
    from app.core.database import AsyncSessionLocal
    from app.models.shared.organization import Organization
    from app.models.shared.permission_set import PermissionSet, DEFAULT_PERMISSIONS
    from app.models.user import User
    from app.models.tenant import Tenant

    async with AsyncSessionLocal() as db:
        # Migrate legacy role → system_role
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

        # Create one Organization per Tenant (idempotent by slug)
        tenants = (await db.execute(select(Tenant))).scalars().all()
        tenant_to_org_id: dict[int, int] = {}

        for tenant in tenants:
            org = (await db.execute(
                select(Organization).where(Organization.slug == tenant.slug)
            )).scalar_one_or_none()

            if not org:
                org = Organization(
                    name=tenant.name,
                    slug=tenant.slug,
                    description=getattr(tenant, 'description', None),
                    contact_email=getattr(tenant, 'contact_email', None),
                    is_active=tenant.is_active,
                )
                db.add(org)
                await db.flush()
                print(f"[Org] Created org '{org.name}' for tenant {tenant.id}")

            tenant_to_org_id[tenant.id] = org.id

        # Fallback default org if no tenants exist
        if not tenant_to_org_id:
            fallback = (await db.execute(
                select(Organization).where(Organization.slug == "default")
            )).scalar_one_or_none()
            if not fallback:
                fallback = Organization(
                    name="Varsayılan Organizasyon", slug="default",
                    description="Sistem tarafından otomatik oluşturuldu",
                )
                db.add(fallback)
                await db.flush()
            tenant_to_org_id[0] = fallback.id  # sentinel

        # Assign users to the org matching their tenant_id (re-runs are safe)
        for t_id, o_id in tenant_to_org_id.items():
            if t_id == 0:
                # fallback: assign users with no tenant and no org
                r = await db.execute(
                    _upd(User).where(User.tenant_id.is_(None), User.org_id.is_(None)).values(org_id=o_id)
                )
            else:
                r = await db.execute(
                    _upd(User).where(User.tenant_id == t_id).values(org_id=o_id)
                )
            if r.rowcount:
                print(f"[Org] {r.rowcount} user(s) → org_id={o_id} (tenant={t_id})")

        # Use first org for permission set seeding
        first_org_id = next(iter(tenant_to_org_id.values()))
        org_id = first_org_id

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

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID", "Accept"],
)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    """Attach request_id + timing, log completed requests, update HTTP metrics."""
    request.state.request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    request.state.started_at = time.monotonic()

    # Bind context so every log line during this request carries request_id
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        request_id=request.state.request_id,
        method=request.method,
        path=request.url.path,
    )

    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id

    if request.url.path not in _SKIP_LOG_PATHS:
        duration_ms = round((time.monotonic() - request.state.started_at) * 1000, 1)
        _req_log.info(
            "http_request",
            status_code=response.status_code,
            duration_ms=duration_ms,
        )
        norm = normalize_path(request.url.path)
        HTTP_REQUESTS_TOTAL.labels(
            method=request.method,
            path=norm,
            status_code=str(response.status_code),
        ).inc()
        HTTP_REQUEST_DURATION_SECONDS.labels(
            method=request.method,
            path=norm,
        ).observe(duration_ms / 1000)

    return response


app.include_router(api_router, prefix="/api/v1")

# /health is served by the health router (health.py) — backward-compat
# endpoint is included there.  Register it after api_router so /health/ready
# does not collide with any /api/v1 route.
from app.api.v1.endpoints.health import router as health_router  # noqa: E402
app.include_router(health_router)


@app.get("/metrics", include_in_schema=False)
async def metrics_endpoint():
    """Prometheus scrape endpoint. Supports multiprocess mode via PROMETHEUS_MULTIPROC_DIR."""
    from prometheus_client import (
        CollectorRegistry,
        generate_latest,
        multiprocess,
        CONTENT_TYPE_LATEST,
    )
    prom_dir = os.environ.get("PROMETHEUS_MULTIPROC_DIR", "")
    if prom_dir:
        registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(registry)
        data = generate_latest(registry)
    else:
        data = generate_latest()
    return Response(content=data, media_type=CONTENT_TYPE_LATEST)
