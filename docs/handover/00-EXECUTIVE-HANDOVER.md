# 00 — Yönetici Devir Özeti

## 1. Projenin amacı

**Charon / NetManager**, kurumsal sınıf bir **anahtar (switch) yönetim ve gözlem platformudur**. Hedef: birden çok organizasyon ve lokasyon altında bulunan 1000+ adet Cisco, Aruba ve Ruijie cihazını tek bir kontrol düzleminden izlemek, konfigüre etmek, yedeklemek, port/PoE/VLAN operasyonu yapmak ve güvenlik politikalarını uygulamak.

İki ana kullanım profili vardır:

1. **Multi-tenant SaaS-benzeri model:** birden çok organizasyon tek bir platform üzerinde, **Postgres Row-Level Security** ve uygulama seviyesi org/loc scoping ile birbirinden izole çalışır.
2. **Hybrid edge model:** her organizasyonun saha noktalarında çalışan, backend ile WebSocket ile konuşan **Charon Agent**'ları cihazlara olan SSH/SNMP işlemini private network üzerinden gerçekleştirir.

## 2. Kapsam

| Modül | Görev |
|---|---|
| **Backend (FastAPI)** | REST API, WebSocket, RBAC, RLS, audit log, credential vault, task dispatch |
| **Frontend (React + Vite + React Query)** | Operatör UI, dashboard, device detail, terminal, audit log, raporlar |
| **Charon Agent (Python)** | Saha tarafı SSH/SNMP/LLDP yürütücüsü, backend ile WebSocket relay |
| **Celery workers (3 havuz)** | Periyodik polling, bulk komutlar, agent dispatch, syslog ingestion |
| **PostgreSQL (TimescaleDB pg16)** | Tüm kalıcı veri, audit log, snapshot tabloları |
| **Redis 8** | Celery broker, cache, terminal session state, syslog ingestion stream |
| **Nginx + Cloudflare** | Tek dış kapı, TLS termination (CF), HSTS, WS proxy |

## 3. Kullanıcı tipleri

Uygulama 4 kanonik rol kullanır (kaynak: `backend/app/services/rbac/engine.py` — `class PermissionEngine` + `async def resolve(...)`, Sprint 1A "canonical 4-role" geçişi):

| Rol | Kapsam |
|---|---|
| `super_admin` | Platform yönetimi; tüm organizasyonlara erişim; "Platform Mgmt" menüsü yalnız bu role açıktır |
| `org_admin` | Bir organizasyonun tüm lokasyonlarına yönetici erişim (`PermissionEngine.resolve` org-wide kısa devre) |
| `engineer` | Atandığı lokasyonlarda cihaz operasyonu (terminal, config, port, backup) |
| `viewer` | Salt okuma; cihaz listesi, dashboard, raporlar |

> ⚠ **VERIFY BEFORE HANDOVER**: Backend canonical rol resolution `backend/app/services/rbac/engine.py` içinde encode edilmiştir. Frontend tarafında permission/role davranışı **tek bir dosyada toplanmaz**; başlıca referans noktaları: `frontend/src/App.tsx`, `frontend/src/utils/menuGroups.ts`, `frontend/src/types/index.ts`, `frontend/src/contexts/SiteContext.tsx` ve ilgili route/component permission gate'leri. Bu dağınıklığın konsolidasyonu [12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) TD-20 olarak listelidir. Devir alacak ekip canonical key listesini backend + dağıtık frontend noktalarından doğrulamalı.

## 4. Temel modüller (üst seviye)

| Frontend Sayfası | Backend Endpoint Ailesi | Veri kaynağı |
|---|---|---|
| Dashboard | `/api/v1/dashboard/*`, `/api/v1/health/*` | Cache + snapshot tablolar |
| Devices (liste / detay) | `/api/v1/devices/*`, `/api/v1/interfaces/*` | DB + SSH (canlı) |
| Topology | `/api/v1/topology/*`, `/api/v1/topology_links/*` | LLDP snapshot tablolar |
| Terminal | `/api/v1/devices/{id}/terminal/ws` (WS) | Agent SSH bridge |
| Audit Log | `/api/v1/audit/*` | `audit_logs` tablosu |
| Backup & Config | `/api/v1/backup/*`, `/api/v1/config_templates/*` | Object storage / FS |
| Users / Orgs / Locations | `/api/v1/users`, `/api/v1/organizations`, `/api/v1/locations` | DB |
| MAC / ARP / PoE / VLAN | `/api/v1/mac_arp/*`, `/api/v1/poe/*` | Snapshot tabloları |
| Security Policies | `/api/v1/security_policies/*` | Policy + assignment tabloları |

(Tam endpoint inventarı için bkz. `backend/app/api/v1/endpoints/` dizini ve [03-BACKEND-FRONTEND-AGENT-ARCHITECTURE.md](03-BACKEND-FRONTEND-AGENT-ARCHITECTURE.md).)

## 5. Canlı ortamın genel durumu (devir tarihi itibarıyla)

Bu paket hazırlandığı sırada:

- **Production VPS** üzerinde 12 Docker Compose servisi çalışıyor: `postgres`, `redis`, `backend`, `celery_worker` (monitor), `celery_agent_worker`, `celery_default_worker`, `celery_beat`, `event_consumer`, `flower`, `frontend`, `nginx`, opsiyonel `monitoring` overlay.
- **Cloudflare** edge katmanında TLS/edge erişimi vardır. Production ingress modelinin **Cloudflare Tunnel** mı, **DNS A-record + origin certificate** mi olduğu devir öncesinde doğrulanmalıdır — ⚠ **VERIFY BEFORE HANDOVER** (bkz. [02-DEPLOYMENT-AND-INFRASTRUCTURE.md](02-DEPLOYMENT-AND-INFRASTRUCTURE.md)).
- **Postgres** TimescaleDB image (pg16). RLS açık. Migration head'i Alembic ile yönetilir; toplam 39 migration dosyası.
- **Charon Agent**'lar saha noktalarına manuel kurulur, backend ile WebSocket ile bağlanır. Bir adet **Windows Agent v2** çalışması arşivde (`windows-agent-v2-manual-test/`); production'da `WINDOWS_AGENT_V2_ENABLED=False`.
- **Kayda değer son ürün dalgaları:** P0.2.x SiteContext fix zinciri (PR #117, #118), Audit Log v2 (PR #51–#58), Sprint 1A canonical roles, Charon menu restructure, T9/T10 roadmap maddeleri.

> ⚠ **VERIFY BEFORE HANDOVER**: Production VPS IP, domain, Cloudflare tunnel adı, image tag'leri ve `.env` dosyası şu anda devir veren ekipte. [14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md) doldurulmadan production'a temas edilmemeli.

## 6. Devralacak kişinin ilk 30 dakikası

Sırayla:

1. [02-DEPLOYMENT-AND-INFRASTRUCTURE.md](02-DEPLOYMENT-AND-INFRASTRUCTURE.md) okunur — production stack'i kafanda otur.
2. `docker-compose.yml` dosyası gözden geçirilir — kaynak ile doküman tutarlılığı.
3. `[READ ONLY]` `docker compose ps` (yetki teslim edildiyse) — hangi servisler `healthy` durumda?
4. `[READ ONLY]` `docker compose logs --tail=50 backend` — son hata yok mu?
5. Frontend `https://<domain>/login` açılır, görsel olarak erişilebilirlik doğrulanır.
6. Bir test hesabıyla giriş yapılır (admin yetkilerinde olmayan, salt okuma hesap), Dashboard + Devices + Audit Log sayfaları açılır.
7. [11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) hızlıca taranır — yangın anında nereden başlanır?

## 7. Kritik riskler

Devir alacak ekibin ilk haftada **bilmesi gereken** riskler:

### R1 — VPS schema-vs-main drift

Production VPS uzun aralıklarla deploy edildiğinde `main` ile schema arasında fark birikebilir. Naive bir `git pull && docker compose up -d --build` zinciri **yıkıcı bir Alembic migration**'a yol açabilir.
**Etki:** veri kaybı veya uzun downtime.
**Hafifletme:** [02-DEPLOYMENT-AND-INFRASTRUCTURE.md §Deploy öncesi checklist](02-DEPLOYMENT-AND-INFRASTRUCTURE.md) ve `DEPLOY_CHECKLIST.md`.

### R2 — Credential update sonrası stale agent connection pool

Bir cihazın credential'ı (UI'dan) güncellendiğinde, agent script `_POOL_TTL = 300s` TTL'li **connection pool**'unda eski credential'la açılmış canlı bir oturumu pool key (host, port, username) eşleştiğinde tekrar kullanır. Bu yüzden UI'da credential update **anlık değildir**.
**Etki:** UI'da "credential güncellendi" sonra 0–5 dk arası eski user-mode oturumdan gelen privilege-denied çıktıları görünür.
**Hafifletme:** [08-DEVICE-ONBOARDING-AND-CREDENTIALS.md §Credential update sonrası bekleme](08-DEVICE-ONBOARDING-AND-CREDENTIALS.md).

### R3 — Privilege-denied output parser-empty olarak görünür

Ruijie cihazlarda enable mode'a geçilemezse `show interfaces status` gibi komutlar `% User doesn't have sufficient privilege` döndürür. Parser bu metin için "0 entry" üretir. UI bunu "No ports found" olarak gösterir.
**Etki:** Sağlıklı gibi görünen sıfır-veri operatörü yanıltır.
**Hafifletme:** [09-RUIJIE-SSH-AND-PARSER-OPERATIONS.md §Parser hata vs privilege-denied](09-RUIJIE-SSH-AND-PARSER-OPERATIONS.md) + [12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) maddesi.

### R4 — Celery queue purge yasağı

`celery -A app.workers.celery_app purge`, `redis-cli FLUSHDB`, `redis-cli DEL celery` gibi komutlar **uçtan uca task ledger'ını siler**; pending backup, terminal session cleanup, schedule snapshot zincirleri bozulur.
**Etki:** session kayıpları, backup penceresi kaçırılması, stale-task gönderimi.
**Hafifletme:** [07-CELERY-REDIS-BACKGROUND-JOBS.md §Queue purge yasağı](07-CELERY-REDIS-BACKGROUND-JOBS.md).

### R5 — Private IP cihazlara backend direct SSH

`devices.agent_id IS NULL` olan ve private IP taşıyan bir cihaz için backend doğrudan SSH dener; VPS public network'ten reachable olmadığı için bu zincir **TCP timeout** ile biter; UI hem yavaş hem yanıltıcı bir hata gösterir.
**Etki:** Yeni cihaz onboard'larında "cihaz online ama hiçbir komut çalışmıyor" tablosu.
**Hafifletme:** [08-DEVICE-ONBOARDING-AND-CREDENTIALS.md](08-DEVICE-ONBOARDING-AND-CREDENTIALS.md) onboarding checklist ve [11](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) ilk karar kolu.

### R6 — Cloudflare 5xx cache window

Backend container recreate edilirken (30–60 sn) Cloudflare 5xx response'larını kısa süre cache'leyebilir; browser CF sticky 5xx görür. Naive bir "deploy etti, smoke testten geçti, restart attı" zinciri 5xx görür ve yanlış rollback tetikleyebilir.
**Etki:** Geri alınması zor "deploy doğru ama gözüken yanlış" durum.
**Hafifletme:** [10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md §Cloudflare/origin 502](10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md).

## 8. Handover sonrası ilk hafta kontrolleri

| Gün | Kontrol | Referans |
|---|---|---|
| 1 | Production stack health + browser smoke + erişim doğrulama | [13-OPERATIONS-CHECKLISTS.md §Handover sonrası ilk hafta](13-OPERATIONS-CHECKLISTS.md) |
| 2 | Backup restore testi (staging environment) | [10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md §Restore](10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md) |
| 3 | Yeni cihaz onboarding test (test cihazı) | [08-DEVICE-ONBOARDING-AND-CREDENTIALS.md](08-DEVICE-ONBOARDING-AND-CREDENTIALS.md) |
| 4 | RBAC test (her rol için temsilci hesap, beklenen erişim matrisi) | [05-SECURITY-RBAC-ORGANIZATION-SCOPING.md](05-SECURITY-RBAC-ORGANIZATION-SCOPING.md) |
| 5 | Worker/queue health + bir tane periyodik task'ın sonucu DB'de göründü mü | [07-CELERY-REDIS-BACKGROUND-JOBS.md](07-CELERY-REDIS-BACKGROUND-JOBS.md) |
| 6–7 | Incident runbook dry-run (gerçek olmayan bir senaryo seçilir, karar ağacı uygulanır) | [11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) |
| 7 sonu | [15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md](15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md) imzalanır | — |

## 9. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış (kaynak kod / compose / migration üzerinden)
- Compose servis listesi ve `expose`/`networks` topolojisi (`docker-compose.yml`)
- Celery task modülleri, 33 beat schedule, 3 queue (`backend/app/workers/celery_app.py`)
- Frontend production target = `nginx + dist build` (compose `target: ${FRONTEND_TARGET:-production}`)
- Nginx WS path: `/api/v1/ws` + `/api/v1/agents/ws` (1 saat timeout)
- Postgres max_connections=200, shared_buffers=512MB
- 39 alembic migration (`backend/alembic/versions/`)

### VERIFY BEFORE HANDOVER
- Cloudflare tunnel adı, panel sahipliği, DNS kayıtları
- VPS IP, OS sürüm, Docker daemon ayarları
- `.env` dosyasının VPS'teki konumu ve içerik anahtarları (yalnız KEY listesi devir edilecek, value'lar değil)
- Backup'ların offsite kopyası var mı, nerede
- Production'da çalışan tam agent envanteri ve agent host işletim sistemleri
- "WindowsAgentV2 T1.01 BLOCKED" durumunun şu anki canlı kararı
