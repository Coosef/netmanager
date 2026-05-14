# NetManager — Multi-Vendor Network Management Platform

> Enterprise-grade network management platform for Cisco, Aruba, Ruijie, Fortinet, Juniper and more.  
> FastAPI · React · Celery · Redis · TimescaleDB · Docker

---

## Overview

NetManager is a full-stack network management system (NMS) built for teams managing heterogeneous switch/router fleets across multiple sites. It goes beyond simple ping monitoring — combining SSH automation, topology intelligence, config compliance, AI-assisted parser generation, and a rich automation engine into a single platform.

**Key capabilities at a glance:**

| Area | What it does |
|------|-------------|
| Device Management | CRUD + SSH test + bulk operations (1000+ devices) |
| Config Intelligence | Automated backups, diff viewer, golden baseline drift detection |
| Topology | LLDP/CDP auto-discovery, blast radius analysis, L2 anomaly detection |
| Monitoring | SNMP polling, threshold alerting, bandwidth monitor, event correlation |
| Automation | Playbook engine (6 step types, event/schedule/manual triggers) |
| Security | Approval workflow, RBAC, credential vault with auto-rotation, compliance scoring |
| AI Integration | Claude-powered driver template generation, command parser suggestions |
| Multi-Vendor Parsing | Regex / TextFSM / ntc-templates fallback chain with health tracking |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser  →  React 18 + Ant Design 5  (Vite, TypeScript)   │
│  └─ WebSocket reconnect: backoff+jitter (useReconnecting…)  │
└──────────────────────┬──────────────────────────────────────┘
                       │ REST / WebSocket
┌──────────────────────▼──────────────────────────────────────┐
│  FastAPI 0.115  (async, Pydantic v2)   :8000                │
│  ├─ /api/v1/*  (35+ endpoint groups)  /metrics (Prometheus) │
│  ├─ WebSocket  /ws/events  /ws/tasks/{id}                   │
│  ├─ Background tasks: tracked create_task, cancel on exit   │
│  └─ Startup: 30s DB timeout, Alembic upgrade head           │
└──────┬───────────────┬───────────────────────────────────────┘
       │               │
┌──────▼─────┐  ┌──────▼──────────────────────────────────────┐
│TimescaleDB │  │  Celery Workers  (30 concurrent, mem 4 GB)  │
│(PostgreSQL │  │  ├─ SSH tasks (backup, probe, run)          │
│ pg16)      │  │  ├─ SNMP polling (5 min beat)               │
│            │  │  ├─ Monitor / event detection                │
│            │  │  ├─ Playbook execution                       │
│            │  │  ├─ Config drift check (daily)              │
│            │  │  └─ Time limits: global 25 min, rollout 65 min │
└────────────┘  └──────┬──────────────────────────────────────┘
                        │
┌───────────────────────▼──────┐  ┌──────────────────────────┐
│  Redis 8  (broker + cache)   │  │  Proxy Agents            │
│  └─ Celery broker/result     │  │  (Python WebSocket —     │
│  └─ Event dedup TTL          │  │   macOS/Linux/Windows)   │
│  └─ ExponentialBackoff retry │  │                          │
└──────────────────────────────┘  └──────────────────────────┘
```

---

## Features

### Device Management
- Multi-vendor support: Cisco IOS/IOS-XE/NX-OS, Aruba OS-Switch/AOS-CX, Ruijie RGOS, Fortinet FortiOS, Juniper JunOS, MikroTik RouterOS, H3C Comware
- SSH connection test with latency tracking
- Auto-pull: hostname, model, firmware version, serial number
- Tag & alias system with clickable filter
- Bulk operations: backup, credential update, SSH test
- CSV import/export (upsert on IP address)
- 5-step onboarding wizard
- Device groups with auto-grouping suggestions (site/layer/topology clustering)

### Proxy Agent System
- Lightweight Python WebSocket agent deployable on any OS
- One-liner installer (OS detection, pip fallback chain)
- Online/offline heartbeat tracking
- Remote restart via API
- Latency-based automatic route selection (EMA latency per device)
- Fallback agent chain (primary → fallback list)
- CPU/RAM metrics via psutil (agent v1.1+)

### Config Intelligence
- Automated config backup with change detection (SHA-256 hash)
- Side-by-side diff viewer (unified diff, color-coded)
- Golden baseline: mark a backup as reference, detect drift automatically (daily Celery task)
- Config template push: `{variable}` syntax, multi-device push, dry-run mode
- 4 built-in templates: NTP, Syslog, Banner MOTD, AAA user

### Topology
- LLDP + CDP auto-discovery
- Bidirectional link map (React Flow / D3)
- Layer-based views: core / distribution / access / edge / wireless
- Site → Building → Floor cascading filter
- Link quality: utilization color (≥80% red), speed badge (10G/1G/100M), PoE/trunk/VLAN tooltips
- Ghost node detection (discovered but not onboarded)
- Ghost edge: dashed amber lines for stale connections
- Blast radius analysis: graph traversal showing affected devices by layer/vendor
- L2 anomaly detection: duplicate hostnames, asymmetric links, stale connections
- 3D topology view (Three.js)

### Monitoring & Alerting
- SNMP v1/v2c/v3 polling (asyncio-native via puresnmp)
- Vendor-specific CPU/RAM OIDs (Cisco, HOST-RESOURCES-MIB fallback)
- Interface utilization history (expandable sparkline charts)
- Alert rules: metric threshold, interface pattern (fnmatch), consecutive polls, cooldown, severity
- Maintenance windows: suppress alerts during planned work
- Event correlation: ≥3 devices offline simultaneously → root cause analysis
- Flapping detection: ≥4 state changes per hour
- Real-time WebSocket event stream on dashboard
- Bandwidth monitor: top interfaces by utilization, auto-refresh
- Interface error dashboard: in/out error delta, errors/min, 24-poll history chart

### Automation & Playbooks
- **6 step types**: `ssh_command`, `backup`, `compliance_check`, `notify`, `wait`, `pre_run_backup`
- **3 trigger types**: manual, scheduled (Celery Beat), event-based (fires on specific event types)
- Dry-run simulation mode
- Blast radius warning before execution
- Pre-run rollback point (automatic backup before changes)
- 6 built-in playbook templates: Offline Recheck, Config Backup + Compliance, Interface Error Scan, NTP/Syslog Push, VLAN Rollout, Compliance Fix
- Per-step output/diff/error recording

### Security & Compliance
- **RBAC**: super_admin / admin / operator / viewer
- **Approval workflow**: high/medium risk commands require admin approval (4-eyes principle)
- **CLI denylist**: block dangerous commands (config/reload/erase)
- Security compliance scoring (0–100): Telnet, SNMP defaults, NTP, AAA, Syslog rules
- Weekly automated compliance scan (Celery Beat)
- Fleet compliance trend chart (7/14/30/60/90 day periods)
- Audit log: who, when, what — with before/after state diff, request_id, duration_ms

### Credential Vault
- Fernet-encrypted SSH + SNMP credentials per profile
- Passwords never exposed in API responses
- Device ↔ profile assignment (single device or entire group)
- Auto-rotation policies: vendor-aware SSH password change (Cisco IOS/IOS-XE, Ruijie)
- Rotation result tracking per device

### Multi-Vendor Driver Templates (Parsing Engine)
- **TemplateResolver**: scoring algorithm — priority + firmware regex match + is_verified + success_rate bonuses; skips persistently broken templates
- **ParserEngine**: centralized dispatch → regex → TextFSM → ntc-templates (500+ community templates) → raw fallback
- AI-assisted template generation (Claude API): paste raw output → get command string + parser template
- Template health tracking: success/failure counts, success rate, health_status (healthy/warning/broken)
- **Parser Health Dashboard**: problematic templates table + recent parse failure log with raw output
- Probe device: auto-detect vendor/model/firmware + create templates in one click
- Free-text OS Type and Command Type: type any vendor, not limited to the built-in list

### Asset Lifecycle
- Purchase date, warranty expiry, EOL (End of Life), EOS (End of Support) dates
- Automated EOL lookup: 120+ Cisco/Aruba/Ruijie/Fortinet models (static DB)
- Dashboard widget: approaching dates in next 90 days (color-coded)
- Daily Celery alert at 7/30/90 day thresholds

### SLA & Uptime Analytics
- SLA policies: target uptime %, measurement window, device/group scope, breach notifications
- Fleet summary: ≥99% / 95–99% / <95% distribution
- Per-device uptime % with daily breakdown (calculated from NetworkEvent history)
- Dedicated SLA report page

### Notifications
- Email (SMTP)
- Slack webhook
- Microsoft Teams webhook
- Telegram bot
- Generic webhook (custom JSON payload)
- Jira ticket creation (REST API v3, priority mapping, ADF description)

### Reporting
- Device report (CSV / PDF / browser print)
- Uptime trend charts (7/14/30 day)
- Firmware compliance matrix
- Executive PDF summary
- Weekly email digest (Celery Beat)

### Internationalization
- Turkish, English, German, Russian (i18next)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI 0.115, Python 3.11, Pydantic v2 |
| Database | PostgreSQL 16 (TimescaleDB image) |
| ORM | SQLAlchemy 2.0 async + psycopg2 (sync) |
| Task Queue | Celery 5.4 + Redis 7 |
| Task Monitor | Flower 2.0 |
| Network Automation | Netmiko 4.4, NAPALM 5.0, puresnmp, ntc-templates |
| AI | Anthropic Claude API |
| Frontend | React 18, TypeScript 5, Vite 6 |
| UI Library | Ant Design 5 |
| State | Zustand 5, TanStack Query 5 |
| Charts | Recharts 3, React Force Graph 3D, React Flow |
| Maps | Leaflet + React-Leaflet |
| Auth | JWT (python-jose), bcrypt, Fernet encryption |
| Security | passlib, cryptography 43 |
| Infrastructure | Docker Compose |

---

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Git

### 1. Clone the repository

```bash
git clone https://github.com/Coosef/netmanager.git
cd netmanager
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set the required values:

```bash
# Generate a secure secret key:
openssl rand -hex 32

# Generate a Fernet encryption key:
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Key variables to change:

| Variable | Description |
|----------|-------------|
| `SECRET_KEY` | JWT signing secret (generate with openssl) |
| `CREDENTIAL_ENCRYPTION_KEY` | Fernet key for encrypting device passwords |
| `POSTGRES_PASSWORD` | PostgreSQL password |
| `ANTHROPIC_API_KEY` | Claude API key (optional — needed for AI template generation) |
| `FLOWER_PASSWORD` | Celery Flower web UI password |

### 3. Start all services

```bash
docker compose up -d
```

Or using the Makefile:

```bash
make up
```

This starts 7 containers:
- `postgres` — TimescaleDB (port 5432)
- `redis` — Redis 7 (port 6379)
- `backend` — FastAPI (port 8000)
- `celery_worker` — Celery workers (concurrency 30)
- `celery_beat` — Scheduled task runner
- `flower` — Celery monitor (port 5555)
- `frontend` — React dev server (port 3000)

### 4. Access the application

| Service | URL | Default Credentials |
|---------|-----|-------------------|
| Frontend | http://localhost:3000 | admin / admin123 |
| API Docs | http://localhost:8000/docs | — |
| Flower | http://localhost:5555 | admin / admin123 |

> The backend automatically creates tables and seeds initial data on first startup (no manual migrations needed).

---

## Project Structure

```
netmanager/
├── backend/
│   ├── app/
│   │   ├── api/v1/endpoints/   # 35+ REST endpoint modules
│   │   ├── models/             # SQLAlchemy ORM models
│   │   ├── schemas/            # Pydantic request/response schemas
│   │   ├── services/           # Business logic
│   │   │   ├── ssh_manager.py      # Netmiko SSH wrapper
│   │   │   ├── parser_engine.py    # Multi-format output parser
│   │   │   ├── template_resolver.py# Best-template scoring engine
│   │   │   ├── agent_manager.py    # Proxy agent WebSocket hub
│   │   │   └── ...
│   │   ├── workers/tasks/      # Celery task modules
│   │   │   ├── monitor_tasks.py    # SNMP + SSH polling
│   │   │   ├── backup_tasks.py     # Config backup + drift
│   │   │   ├── playbook_tasks.py   # Playbook execution engine
│   │   │   └── ...
│   │   ├── core/               # Config, DB, security, deps
│   │   └── main.py             # App factory + DB migration lifespan
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── pages/              # 30+ page components
│   │   ├── api/                # Typed API client modules
│   │   ├── components/         # Shared UI components
│   │   ├── contexts/           # Theme, Site context
│   │   ├── hooks/              # Custom React hooks
│   │   ├── i18n/locales/       # TR / EN / DE / RU translations
│   │   └── store/              # Zustand auth store
│   ├── package.json
│   └── Dockerfile
├── agent/
│   ├── netmanager_mcp.py       # MCP server (Claude integration)
│   └── requirements.txt
├── docker-compose.yml
├── .env.example
├── Makefile
└── ROADMAP.md
```

---

## Proxy Agent

For networks where the backend cannot directly reach devices, deploy a lightweight Python agent on a jump host:

```bash
# Install agent on the jump host
curl -sSL <agent-installer-url> | bash

# Or manually:
pip install websockets psutil
python agent/netmanager_mcp.py --server ws://your-backend:8000 --token <api-token>
```

The agent connects via WebSocket and proxies SSH commands to local network devices. Multiple agents can be deployed; the backend selects the lowest-latency route automatically.

---

## Makefile Commands

```bash
make up              # Start all services in background
make down            # Stop all services
make build           # Rebuild Docker images
make logs            # Tail backend + worker logs
make ps              # Show container status
make restart-backend # Restart backend + celery_worker
make shell-backend   # Open bash shell in backend container
make db-shell        # Open psql shell in postgres container
```

---

## API Documentation

Interactive Swagger UI available at **http://localhost:8000/docs** after startup.

Key endpoint groups:

| Prefix | Description |
|--------|-------------|
| `/api/v1/devices` | Device CRUD, SSH test, bulk operations |
| `/api/v1/driver-templates` | Parser templates, AI suggest, health |
| `/api/v1/topology` | LLDP discovery, blast radius, anomalies |
| `/api/v1/monitor` | Events, polling, flapping |
| `/api/v1/snmp` | SNMP metrics, utilization, errors |
| `/api/v1/playbooks` | Automation playbooks + execution |
| `/api/v1/approvals` | Approval workflow |
| `/api/v1/config-templates` | Config push templates |
| `/api/v1/sla` | SLA policies + uptime reports |
| `/api/v1/security-audit` | Compliance scoring + trends |
| `/api/v1/notifications` | Notification channel management |
| `/api/v1/credential-profiles` | Encrypted credential vault |
| `/api/v1/agents` | Proxy agent management |

---

## Adding a New Vendor

NetManager is not locked to built-in vendor list. To add a new OS type:

1. In the **Driver Templates** page, type your OS type directly in the "OS Type" field (CreatableSelect — accepts any value).
2. Fill in the command string and sample output.
3. Click **AI Suggest** to let Claude generate a parser template automatically.
4. Test the parser with live raw output using the **Test Parse** feature.
5. Click **Probe Device** on any device to auto-detect vendor and create templates in bulk.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGRES_USER` | No | `netmgr` | PostgreSQL username |
| `POSTGRES_PASSWORD` | Yes | — | PostgreSQL password |
| `POSTGRES_DB` | No | `network_manager` | Database name |
| `SECRET_KEY` | Yes | — | JWT signing secret (min 32 chars) |
| `CREDENTIAL_ENCRYPTION_KEY` | Yes | — | Fernet key for credential encryption |
| `REDIS_URL` | No | `redis://redis:6379/0` | Redis connection URL |
| `ENVIRONMENT` | No | `development` | `development` or `production` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | No | `480` | JWT token lifetime |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | CORS allowed origins |
| `SSH_MAX_CONCURRENT` | No | `50` | Max parallel SSH connections |
| `SSH_CONNECT_TIMEOUT` | No | `30` | SSH connect timeout (seconds) |
| `SSH_COMMAND_TIMEOUT` | No | `60` | SSH command timeout (seconds) |
| `ANTHROPIC_API_KEY` | No | — | Claude API key (AI features) |
| `FLOWER_USER` | No | `admin` | Flower web UI username |
| `FLOWER_PASSWORD` | No | `admin123` | Flower web UI password |

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full feature roadmap with sprint history and planned improvements.

---

## License

MIT License — see [LICENSE](LICENSE) for details.
