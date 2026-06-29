# 01 — Mimari Genel Bakış

## 1. Yüksek seviye topoloji

```mermaid
flowchart TB
    User[Operatör Tarayıcısı]

    subgraph CF[Cloudflare Edge]
        CFE[TLS Termination + HSTS + WAF]
    end

    subgraph VPS[Production VPS - Docker Compose]
        direction TB

        subgraph EDGE[edge ag]
            NGX[nginx 80 / 443]
            FE[frontend - nginx + dist 3000]
        end

        subgraph INT[internal ag]
            BE[backend FastAPI 8000]
            PG[(postgres TimescaleDB pg16)]
            RD[(redis 8)]
            CW[celery_worker monitor q]
            CAW[celery_agent_worker agent_cmd q]
            CDW[celery_default_worker default,bulk q]
            CB[celery_beat scheduler]
            EC[event_consumer syslog stream]
            FL[flower 5555]
        end
    end

    subgraph SITE[Site / Saha]
        AG[Charon Agent Python]
        SW1[Cisco Switch]
        SW2[Aruba Switch]
        SW3[Ruijie Switch]
    end

    User -->|HTTPS| CFE
    CFE -->|HTTP X-Forwarded-Proto| NGX
    NGX -->|/api/*| BE
    NGX -->|/| FE
    NGX -->|/api/v1/ws + /api/v1/agents/ws WS| BE

    BE --> PG
    BE --> RD
    CW --> PG
    CW --> RD
    CAW --> RD
    CDW --> PG
    CDW --> RD
    CB --> RD
    EC --> PG
    EC --> RD
    FL --> RD

    BE <-.WS bridge.-> AG
    AG -->|SSH 22| SW1
    AG -->|SSH 22 / SNMP 161| SW2
    AG -->|SSH 22| SW3
```

**Önemli kontratlar:**

| Bileşen | Network üyeliği | Dışarıdan erişilebilir mi? |
|---|---|---|
| `nginx` | `edge` + `internal` | Evet — tek dış kapı (80) |
| `frontend` | `edge` | Hayır (yalnız nginx üzerinden) |
| `backend` | `internal` | Hayır (yalnız nginx üzerinden) |
| `postgres`, `redis` | `internal` | Hayır — host'a publish edilmez |
| Celery worker'lar / beat / event_consumer / flower | `internal` | Hayır |

Kaynak: [docker-compose.yml](../../docker-compose.yml) `T10 B1c — network segmentation` bloğu.

> Cloudflare tunnel veya origin certificate kullanımı: ⚠ **VERIFY BEFORE HANDOVER** — paketin hazırlandığı oturumda doğrulanmamıştır.

## 2. Frontend, backend, PostgreSQL, Redis, Celery, Flower, Nginx, Cloudflare, agent ve cihaz ilişkisi

### Frontend
- **Vite + React + React Query 5 + Zustand** stack.
- Build sonucu `dist/` Nginx ile servis edilir (`frontend/Dockerfile` production stage).
- Auth token Zustand `persist` middleware ile `localStorage` üstünde tutulur.
- API çağrıları React Query üstünden yapılır; cache key + queryKey ile per-tenant ayrılır (`SiteContext` queryKey: `['context', 'current', sessionEpoch, routeOrgId, activeLocationId]`).

### Backend
- **FastAPI** + **SQLAlchemy** (`asyncpg` ve sync `psycopg2` her ikisi de kullanılır; bkz. compose env).
- WebSocket endpoints: `/api/v1/ws` (operatör event stream), `/api/v1/agents/ws` (agent ↔ backend bridge).
- Endpoint katmanları `backend/app/api/v1/endpoints/` altında modüler.

### PostgreSQL
- TimescaleDB latest pg16 image; `max_connections=200`, `shared_buffers=512MB` (compose).
- İki rol: `POSTGRES_USER` (superuser; **yalnız Alembic** kullanır — `MIGRATION_DATABASE_URL`) ve `APP_DB_USER` (uygulama; RLS aktif).
- Snapshot tabloları (mac/arp/poe/vlan) Timescale hypertable olabilir — ⚠ **VERIFY BEFORE HANDOVER** (`backend/alembic/versions/` içinde hypertable seçenekleri var; production'da hangileri açık doğrulanmalı).

### Redis
- Celery broker + result backend (`REDIS_URL=redis://redis:6379/0`).
- Cache: device interfaces (`_IFACE_CACHE_TTL=300`), VLAN, aggregation cache, terminal session metadata.
- `event_consumer:alive` TTL=30s heartbeat key.
- Syslog ingestion stream: `ingest:syslog`.

### Celery
- **3 worker havuzu, ayrı queue** (Faz 6A):
  - `monitor` queue → `celery_worker` (concurrency=16) → SNMP, topology, playbooks, analytics, mac_arp
  - `agent_cmd` queue → `celery_agent_worker` (concurrency=8) → synthetic probes, agent peer latency
  - `default,bulk` queue → `celery_default_worker` (concurrency=8) → correlation, backup, bulk SSH/config
- `celery_beat`: 32 zamanlanmış görev (`celery_app.py beat_schedule`).
- Flower: `5555` üzerinde basic_auth; production'da host'a publish edilmez, yalnız `docker-compose.dev.yml` overlay'i ile dev erişimi.

### event_consumer
- Bağımsız Python servisi (`python -m app.services.event_consumer`); Redis stream `ingest:syslog`'u drain eder.

### Nginx
- `frontend/nginx.conf` (frontend container içi) + `nginx/nginx.conf` (edge proxy).
- Edge nginx: TLS termination CF tarafında olabilir; nginx HSTS + X-Frame + Referrer-Policy + Permissions-Policy ekler.
- Vite dev path'leri (`/@vite`, `/src/`, `/node_modules/`, `/__open-in-editor`) production'da 404 (pentest gereği).
- HTTP → HTTPS redirect, `X-Forwarded-Proto = http` ise 308.

### Cloudflare
- Edge'de TLS terminate, HSTS edge'de zorlanır.
- ⚠ **VERIFY BEFORE HANDOVER**: Tunnel adı, panel hesabı sahipliği, DNS, WAF kuralları, page rules.

### Charon Agent
- Saha tarafı **Python servisi** (`backend/agent_script/netmanager_agent.py`).
- Backend'e **WebSocket** ile bağlanır; backend'den gelen SSH/SNMP komutlarını ilgili cihaza iletir.
- Agent ↔ cihaz SSH bağlantıları **`(host, port, username)` keyli pool** üstünde `_POOL_TTL=300s` TTL'li tutulur. Bu pool'un detayı [03](03-BACKEND-FRONTEND-AGENT-ARCHITECTURE.md) ve [06](06-AGENT-INSTALLATION-AND-OPERATIONS.md) dosyalarında.

## 3. Request flow — bir REST çağrısı

```mermaid
sequenceDiagram
    autonumber
    participant U as Operator
    participant CF as Cloudflare
    participant NX as Nginx (origin)
    participant BE as Backend (FastAPI)
    participant PG as Postgres
    participant RD as Redis

    U->>CF: GET https://app/api/v1/devices/95/interfaces
    CF->>NX: HTTP (X-Forwarded-Proto: https)
    NX->>BE: proxy_pass http://backend:8000
    BE->>BE: AuthMiddleware (JWT verify)
    BE->>BE: org_context (organization_id, location_id) set
    BE->>RD: GET cache:device:o=6:95:interfaces
    alt cache miss
        BE->>PG: SELECT device + scopes (RLS aktif)
        BE-->>BE: Agent path mı? backend-direct path mı?
        BE-->>BE: (agent path icinse [agent-relay flow])
        BE->>RD: SET cache:device:o=6:95:interfaces (TTL 300s)
    end
    BE-->>NX: 200 JSON
    NX-->>CF: 200
    CF-->>U: 200
```

## 4. Device command flow — bir terminal komutu

```mermaid
sequenceDiagram
    autonumber
    participant U as Operator
    participant FE as Frontend
    participant BE as Backend
    participant AG as Agent (saha)
    participant SW as Switch

    U->>FE: Terminal aç (Device 95)
    FE->>BE: WS /api/v1/devices/95/terminal/ws
    BE->>BE: Permission check (terminal.read/write)
    BE->>AG: Agent-relay session başlat (WS uzerinden)
    AG->>SW: SSH (host, port, username) - pool'dan / fresh
    AG-->>BE: shell open, prompt
    BE-->>FE: WS frame: prompt
    U->>FE: "show interfaces status"
    FE->>BE: WS frame
    BE->>AG: command
    AG->>SW: yazma
    SW-->>AG: output
    AG-->>BE: WS frame
    BE-->>FE: WS frame
    BE->>BE: audit_logs insert (terminal_session)
```

## 5. Agent WebSocket / relay flow

```mermaid
sequenceDiagram
    autonumber
    participant AG as Agent
    participant NX as Nginx
    participant BE as Backend
    participant Q as Redis (broker)
    participant CAW as Celery agent_cmd worker

    AG->>NX: WS Upgrade /api/v1/agents/ws (X-Agent-Key)
    NX->>BE: proxy_pass (1 saat read/send timeout)
    BE->>BE: agent enrollment / key check
    BE-->>AG: ack + connection registered
    Note over BE,AG: AG -> BE keepalive ping/pong

    Note over BE: bir kullanici bir komut tetiklerse
    BE->>BE: ssh_manager.execute_command
    BE->>BE: agent_id var mi?
    alt agent online (memory'de)
        BE->>AG: RPC frame
        AG-->>BE: result
    else agent disconnected
        BE-->>BE: 502 Bad Gateway "Agent not connected to this process"
    end
```

## 6. Background collection flow

```mermaid
sequenceDiagram
    autonumber
    participant CB as celery_beat
    participant Q as Redis broker
    participant CW as celery_worker (monitor q)
    participant PG as Postgres
    participant AG as Agent
    participant SW as Switch

    CB->>Q: collect-mac-arp-every-15min (mac_arp_tasks.collect_mac_arp_all)
    Q->>CW: dequeue
    CW->>PG: SELECT devices WHERE is_active AND status='online'
    loop her cihaz icin
        CW->>CW: org_context set (devicen organizasyonu/lokasyonu)
        CW->>AG: agent-relay SSH (show mac-address-table)
        AG->>SW: SSH
        SW-->>AG: output
        AG-->>CW: output
        CW->>CW: _parse_mac_table
        CW->>PG: INSERT mac_address_entries
    end
```

Benzer akış: `snmp_tasks.poll_snmp_all` (5 dk), `poe_tasks.snapshot_poe_status` (15 dk), `topology_tasks.scheduled_topology_discovery` (6 saat), `bulk_tasks.scheduled_backup` (24 saat), `behavior_analytics_tasks.detect_anomalies` (30 dk), vb.

Tam beat schedule listesi: [07-CELERY-REDIS-BACKGROUND-JOBS.md](07-CELERY-REDIS-BACKGROUND-JOBS.md) §Periyodik task'lar.

## 7. Tenant / organization / location ilişkisi

```mermaid
flowchart LR
    ORG[organizations] --1..N--> LOC[locations]
    ORG --1..N--> USR[users]
    LOC --1..N--> DEV[devices]
    LOC --1..N--> AGN[agents]
    USR --N..M--> LOC
    DEV --1..1--> AGN
    USR --rol--> RBAC[permissions]
```

- **organizations**: tenant boundary. Postgres RLS bu kolon (`organization_id`) üstünden uygulanır.
- **locations**: bir organizasyonun saha bölümleri (bina, kat, oda); cihaz ve agent atamasının birimi.
- **devices**: bir lokasyona aittir; opsiyonel olarak bir `agent_id` taşıyabilir (private network erişim için).
- **users**: bir organizasyona aittir; rol + lokasyon ataması ile yetkilendirilir.
- **org-wide kullanıcı**: `is_org_wide=True` flag'li kullanıcı tüm lokasyonlara erişir (`org_admin` örneği).

Detay: [05-SECURITY-RBAC-ORGANIZATION-SCOPING.md](05-SECURITY-RBAC-ORGANIZATION-SCOPING.md).

## 8. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- 11 compose servisi + ağ üyeliği (`docker-compose.yml`)
- Nginx WS / REST / health proxy bloğu (`nginx/nginx.conf`)
- Celery 3 queue + 33 beat schedule (`backend/app/workers/celery_app.py`)
- Frontend production target ve dev path 404 koruması
- Agent script pool key (host, port, username) ve TTL 300s

### VERIFY BEFORE HANDOVER
- Cloudflare tunnel mı yoksa A-record + origin cert mı? Edge WAF kuralları?
- Production'da etkin Timescale hypertable seti
- Monitoring overlay (Prometheus/Grafana) production'da çalışıyor mu, yoksa dev-only mu
