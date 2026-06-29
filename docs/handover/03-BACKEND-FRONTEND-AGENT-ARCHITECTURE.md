# 03 — Backend, Frontend ve Agent Mimarisi

## 1. Backend modülleri

### 1.1 Tepe seviye paket düzeni (`backend/app/`)
| Paket | Sorumluluk |
|---|---|
| `app.api.v1.endpoints` | REST + WebSocket endpoint'ler — 50+ dosya, modüler |
| `app.core` | `config.py` (settings, feature flags), security, exceptions, deps |
| `app.db` | SQLAlchemy session yönetimi, RLS context (org_context) |
| `app.models` | SQLAlchemy modelleri |
| `app.schemas` | Pydantic request/response modelleri |
| `app.services` | İş kuralları (`permission_engine`, `ssh_manager`, `topology_service`, `event_consumer`, `audit_service`, ...) |
| `app.workers` | Celery worker'ları, beat schedule, task modülleri |
| `app.utils` | Şifre, encryption, helpers |
| `agent_script` | Saha tarafı agent kodu (`netmanager_agent.py`) — backend container içine kopyalanır ama ayrıca agent host'a deploy edilir |

### 1.2 Endpoint dosyaları (özet)

`backend/app/api/v1/endpoints/` altındaki başlıca dosyalar:

| Dosya | Amaç |
|---|---|
| `auth.py`, `mfa.py`, `invites.py` | Auth, MFA enroll/login, davetiye akışı |
| `users.py`, `org_admin.py`, `super_admin.py` | Kullanıcı + organizasyon yönetimi |
| `organizations.py`, `locations.py`, `racks.py` | Tenant + saha yapısı |
| `devices.py`, `interfaces.py`, `credential_profiles.py` | Cihaz + interface + credential |
| `agents.py`, `agent_stream.py`, `internal.py` | Agent enroll, WS, agent-relay (internal RPC) |
| `topology.py` *(opsiyonel)* | LLDP topology |
| `mac_arp.py`, `poe.py`, `snmp.py` | Snapshot tabloları üstünden veri okuma |
| `port_control.py`, `port_policy_assignments.py` | Port aç/kapat, PoE on/off, port policy |
| `config_builder.py`, `config_templates.py`, `driver_templates.py` | Config template + driver |
| `backup_schedules.py` *(varsa)* | Backup schedule |
| `incidents.py`, `escalation.py`, `alert_rules.py`, `notifications.py` | Olay yönetimi |
| `ipam.py`, `synthetic.py`, `availability.py` *(varsa)* | IPAM + ölçüm |
| ⚠ Audit log okuma + filtreleme — endpoint dağılımı `app/main.py` üzerinden doğrulanmalı (`audit.py` adında ayrı bir dosya bulunmayabilir; rotalar `super_admin.py` veya başka modüle gömülü olabilir) — VERIFY BEFORE HANDOVER |
| `dashboard.py`, `reports.py` | Dashboard + raporlar |
| `intelligence.py`, `ai_assistant.py` | İçerik / AI |
| `health.py`, `diagnostics.py` | `/health/live`, `/health/ready` |
| `firmware.py`, `change_rollouts.py`, `maintenance_windows.py`, `approvals.py` | Yaşam döngüsü + bakım |

> ⚠ **VERIFY BEFORE HANDOVER**: Bu liste `backend/app/api/v1/endpoints/` dosyalarından derlenmiştir. Devir alacak ekip her dosyayı **router prefix + tag** açısından `app/main.py` (veya `app/api/v1/__init__.py`) içinden kontrol etmeli; bazı endpoint'ler feature-flag gated olabilir.

### 1.3 API katmanları

```
nginx → uvicorn (FastAPI app)
        ↓
        AuthMiddleware (JWT verify → request.state.user)
        ↓
        OrgContextMiddleware (organization_id + location_id'i request scope'a koyar)
        ↓
        Router (e.g. /api/v1/devices/{id}/interfaces)
        ↓
        Dependency: get_db (SQLAlchemy async session, RLS aktif)
        Dependency: get_current_user
        Dependency: require_permission("devices.interfaces.read")
        ↓
        Endpoint handler
        ↓
        Service layer (permission_engine, ssh_manager, ...)
        ↓
        DB session (RLS scope'lu)
```

### 1.4 Cache katmanları

| Katman | TTL | Anahtar deseni | Amaç |
|---|---|---|---|
| Redis: device interfaces | `_IFACE_CACHE_TTL = 300s` | `cache:device:o={org}:{device_id}:interfaces` | UI port listesinin SSH'a her seferinde gitmemesi |
| Redis: VLAN | `_VLAN_CACHE_TTL = 300s` | `cache:device:o={org}:{device_id}:vlans` | VLAN listesi cache |
| Redis: aggregation cache (KI-1) | 60s warm | `cache:agg:*` | Dashboard sayaç |
| React Query (frontend) | `staleTime: 60_000` | `['context', 'current', sessionEpoch, routeOrgId, activeLocationId]` | SiteContext per-tenant cache |
| Agent connection pool | `_POOL_TTL = 300s` | `(host, port, username)` | SSH oturumunun yeniden kullanımı |

**Cache invalidation**: önceki incident dersi — credential update **cache'i otomatik invalidate etmez**; pool entry de `(host, port, username)` keyli olduğundan credential değiştiğinde pool eski oturumu kullanır. Bu davranışın bilinçli olarak kabul edildiği [12](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) içinde tech-debt olarak listelenir.

### 1.5 Error handling zinciri

```
SSH error
   ↓
agent_script._classify_ssh_exception(exc, msg)
   ↓ → returns layer code: AUTH_FAILED / CONNECTION_TIMEOUT / CONNECTION_RESET /
   ↓                       ENABLE_MODE_FAILED / PROMPT_OR_COMMAND_FAILED / UNKNOWN
   ↓
agent_script._ssh_command exception handler → result.error = redacted message
   ↓
backend/agent-relay endpoint → JSON {"success": false, "error": "..."}
   ↓
endpoint (e.g. devices.fetch_device_info) → HTTPException 502 with f"SSH error: {result.error}"
   ↓
frontend axios interceptor → toast / UI error
   ↓
audit_logs entry (best-effort)
```

Hassas bilgi filtreleme: `agent_script._redact_secrets()` parola/enable_secret değerlerini logdan ve return payload'tan temizler.

> ⚠ **VERIFY BEFORE HANDOVER**: SSH error classification PR #119 ile eklendi (`t10/device96-ssh-error-classification-v1` dalı, `765fb6b`). Production'a deploy edildiği VERIFY edilmeli.

### 1.6 Agent connection pool davranışı

Kaynak: `backend/agent_script/netmanager_agent.py` — pool key + TTL kontratı.

| Özellik | Değer |
|---|---|
| Pool key | `(host, port, username)` — **credential değeri içermez** |
| TTL | `_POOL_TTL = 300` saniye |
| Eviction | `_pool_evict_idle` her ~60 sn arada çalışır; `last_used + TTL` geçmiş entry'leri kapatır |
| Yeniden kullanım | Aynı key gelirse mevcut paramiko/netmiko oturumu yeniden kullanılır |
| Credential update etkisi | Pool eski oturumu (eski credential ile açılmış) kullanmaya devam eder; **fresh credential** yalnız yeni oturum açıldığında devreye girer |

Detay ve bekleme prosedürü: [08-DEVICE-ONBOARDING-AND-CREDENTIALS.md §Credential update sonrası bekleme](08-DEVICE-ONBOARDING-AND-CREDENTIALS.md).

### 1.7 Redis cache TTL davranışı

| Cache | TTL | Sıfırlanma yolu |
|---|---|---|
| `cache:device:*:interfaces` | 300s | Doğal süre dolumu; yeni başarılı SSH cevabı set eder |
| `cache:device:*:vlans` | 300s | Aynı |
| `cache:agg:*` | 60s (warmer) | `cache_warmer_tasks.warm_aggregation_cache` |
| Terminal session metadata | session yaşam süresi | session close handler |

**Cache TTL ile pool TTL aynı (300s) olduğu için credential update sonrası UI'da "Doğru veri" görünmesi 5–10 dk alabilir.**

## 2. Frontend route / modül yapısı

### 2.1 Route düzeni (özet)

| Path | Komponent | Yetki |
|---|---|---|
| `/login` | `Login` | Anonim |
| `/welcome/*` | `Welcome*` | Anonim / auth-required (akışa göre) |
| `/dashboard` | `Dashboard` | `dashboard.read` |
| `/devices`, `/devices/:id` | `Devices`, `DeviceDetail` | `devices.read` |
| `/topology` | `Topology` | `topology.read` |
| `/audit` | `AuditLog` | `audit_logs.read` |
| `/users`, `/organizations`, `/locations` | RBAC tablolar | `*.manage` |
| `/settings` | `Settings` | `settings.read` |
| `/terminal-sessions` | `TerminalSessions` | `terminal_sessions.read` |
| `/platform-mgmt/*` | Platform yönetimi | **super_admin only** |

> ⚠ **VERIFY BEFORE HANDOVER**: Tam route + permission map tek bir dosyada toplanmaz. Başlıca referans noktaları: `frontend/src/App.tsx` (router), `frontend/src/utils/menuGroups.ts` (menü + permission gate), `frontend/src/types/index.ts` (tip tanımları), `frontend/src/contexts/SiteContext.tsx` (org/loc scope) ve ilgili route/component permission gate'leri. Bu dağınıklığın konsolidasyonu [12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) TD-20 olarak listelidir.

### 2.2 State yönetimi

| Bileşen | Sorumluluk |
|---|---|
| **Zustand auth store** (`frontend/src/store/auth.ts`) | `token`, `user`, `sessionEpoch`; persist middleware ile `localStorage`'a yazılır; partialize ile `sessionEpoch` persist EDİLMEZ |
| **React Query** | Server state cache + invalidation |
| **SiteContext** (`frontend/src/contexts/SiteContext.tsx`) | Aktif organizasyon + lokasyon; queryKey `['context', 'current', sessionEpoch, routeOrgId, activeLocationId]`; `enabled: !!token` (P0.2.2 sonrası) |
| **ProtectedRoute** | Token-first matrix (PR #73); `token VAR ise hydrated bağımsız children render`; aksi halde login'e |

Bu üç parça [12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) ve [11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) içinde tekrar tekrar adı geçer: blank-screen incident'ları, logout deadlock'ları, session epoch refetch — hepsi bu üçünün etkileşiminden çıkmıştır.

### 2.3 API client

- `axios` instance, interceptor JWT token'ı `Authorization: Bearer` header'ına yazar.
- 401 response'ta token clear + login'e redirect.
- Tüm endpoint'ler `frontend/src/api/*` altında **modüler** — `contextApi.current()`, `deviceApi.list()` gibi.

## 3. Agent script yapısı

### 3.1 Dosya

`backend/agent_script/netmanager_agent.py` — saha tarafında çalışacak tek dosyalık Python servisi (~ binlerce satır). Agent host'a deploy edilir.

### 3.2 Çekirdek bileşenler

| Bileşen | Görev |
|---|---|
| WS client | Backend `/api/v1/agents/ws`'ya bağlanır, `X-Agent-Key` ile kimlik doğrular |
| RPC handler | Backend'den gelen `ssh_command`, `snmp_get`, `lldp_discover`, `terminal_shell_open/close`, vb. komutları işler |
| Connection pool | `(host, port, username)` keyli paramiko/netmiko oturumları, `_POOL_TTL=300s` |
| Idle evict | `_pool_evict_idle` ~60 sn arada idle oturumları kapatır |
| Netmiko driver router | Cihaz tipine göre (`cisco_ios`, `cisco_nxos`, `cisco_sg300`, `ruijie_os`, `aruba_os`, vb.) doğru driver seçer |
| Enable mode handling | Ruijie: `enable_secret` set ise auto-enable; değilse user mode'da kal |
| Error classifier | `_classify_ssh_exception` 6 layer code (AUTH_FAILED, CONNECTION_TIMEOUT, CONNECTION_RESET, ENABLE_MODE_FAILED, PROMPT_OR_COMMAND_FAILED, UNKNOWN) |
| Secret redaction | `_redact_secrets` log + error payload'tan password/enable_secret çıkartır |

### 3.3 Backend ↔ Agent bridge

Backend tarafında bir endpoint çağrısı agent'a yönelirse:

1. Backend `ssh_manager.execute_command` → `agent_id` lookup
2. `_relay_ssh` path: `/api/v1/internal/agent-relay` endpoint'i üzerinden agent'a komut gönderilir
3. Agent komutu çalıştırır, sonucu döner
4. Backend `agent_command_logs` tablosuna fire-and-forget audit yazar (`_log_command_async`)

Agent o anda backend ile WS bağlantısında değilse (örnek: backend container restart sonrası):
```json
{"success": false, "error": "Agent {agent_id} not connected to this process"}
```
Bu, [11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md "Agent connected ama snapshot yok"](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) karar ağacında ilk filter'dır.

## 4. Device driver / SSH flow

```
Backend endpoint  ─► ssh_manager.execute_command(device_id, command)
                     │
                     ├─ device.agent_id IS NULL ──► direct paramiko (backend host'tan)
                     │                              (private IP cihazlarda timeout riski)
                     │
                     └─ device.agent_id IS NOT NULL ─► agent-relay (WS uzerinden)
                                                       │
                                                       ▼
                                          Agent: _ssh_command(host, port, username, ...)
                                                       │
                                                       ├─ pool key (host, port, username) lookup
                                                       │   var ► aynı oturum kullanılır
                                                       │   yok ► fresh ConnectHandler
                                                       │
                                                       ├─ Cihaz Ruijie ise:
                                                       │   enable_secret SET ► auto-enable
                                                       │   enable_secret YOK ► user mode'da kal
                                                       │
                                                       ├─ command run
                                                       │
                                                       └─ result / exception classifier
```

## 5. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- `backend/app/workers/celery_app.py` — task modülleri + 3 queue + 33 beat schedule
- Agent pool key + TTL kontratı
- Redis cache TTL'leri (interfaces, VLAN)
- Nginx WS proxy timeout 3600s
- SiteContext queryKey + enabled kontratı (P0.2.x sprint sonrası)

### VERIFY BEFORE HANDOVER
- Endpoint inventarı tam liste; her endpoint'in router prefix + permission gate'i
- Agent script PR #119 (SSH error classification) production'a deploy edilmiş mi
- Frontend route + permission map; her sayfa için canonical permission key
- `app/main.py` startup zinciri (middleware sırası)
