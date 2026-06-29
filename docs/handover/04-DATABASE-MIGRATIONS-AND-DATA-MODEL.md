# 04 — Veritabanı, Migration ve Veri Modeli

## 1. Genel

| Alan | Değer |
|---|---|
| Veritabanı | PostgreSQL (TimescaleDB image `timescale/timescaledb:latest-pg16`) |
| Migration aracı | Alembic |
| Migration dosyaları | `backend/alembic/versions/` (toplam 39 dosya) |
| Async sürücü | `asyncpg` (uygulama) |
| Sync sürücü | `psycopg2` (Alembic + bazı sync flow'lar) |
| RLS | Aktif — organization_id ve location_id üzerinden |
| Roller | `POSTGRES_USER` (superuser, sadece Alembic) + `APP_DB_USER` (RLS scope'lu app) |

## 2. Alembic migration yaklaşımı

### 2.1 Üç URL kontratı

Compose'tan üç ayrı `DATABASE_URL` setlenir:
```
DATABASE_URL          (asyncpg, APP_DB_USER, RLS aktif)
SYNC_DATABASE_URL     (psycopg2, APP_DB_USER, RLS aktif)
MIGRATION_DATABASE_URL (psycopg2, POSTGRES_USER superuser, RLS bypass)
```

**Sebep:** Alembic'in `CREATE TABLE`, `CREATE POLICY`, `ALTER ROLE` gibi DDL'i çalıştırabilmesi için superuser gerekir. Uygulamanın ise RLS bite eden, daha kısıtlı bir role bağlanması gerekir.

### 2.2 Migration head doğrulama

```bash
# READ ONLY
docker compose exec backend alembic current
docker compose exec backend alembic heads
docker compose exec backend alembic history --verbose | head -50
```

Beklenen: tek bir head; `current` ile `heads` aynı revision'ı söylemeli.

> ⚠ **VERIFY BEFORE HANDOVER**: Production head'i bu paket hazırlandığı sırada bilinmiyor. Devir teslimden önce `current = heads` doğrulanmalı.

### 2.3 Migration uygulama (`MUTATING`)

```bash
# MUTATING
docker compose exec backend alembic upgrade head
```

**Asla** `--sql` çıktısını kör kör çalıştırma; migration üzerinden gitsin.

### 2.4 Migration üretme

```bash
# MUTATING (yeni revision file üretir)
docker compose exec backend alembic revision -m "<kısa açıklama>"
# veya autogenerate:
docker compose exec backend alembic revision --autogenerate -m "<kısa açıklama>"
```

Autogenerate çıktısı **her zaman** elle gözden geçirilir; özellikle RLS policy'leri, hypertable conversion'ları, GIN/BRIN index'leri otomatik üretilmez.

## 3. Kritik tablolar

> ⚠ **VERIFY BEFORE HANDOVER**: Tam kolon listesi `backend/app/models/` ve migration dosyalarından derive edilir; aşağıdaki liste başlıca tabloların **kavramsal** dökümüdür.

### 3.1 `devices`
- `id`, `organization_id`, `location_id` (RLS scope kolonları)
- `name`, `hostname`, `ip_address`, `model`, `firmware_version`, `serial_number`
- `device_type` (`cisco_ios`, `ruijie_os`, ...)
- `agent_id` (NULLABLE — backend direct SSH için NULL, agent-relay için set)
- Credential kolonları (encrypted): `ssh_username`, `ssh_password_enc`, `enable_secret_enc`, `snmp_community_enc`, `credential_profile_id` (FK)
- `is_active`, `status` (online/offline/unknown), `last_seen_at`
- `tags`, `layer`, `building`, `floor`, `rack_id` (metadata)
- `created_at`, `updated_at`, `deleted_at` (soft delete)

### 3.2 `agents`
- `id`, `organization_id`, `location_id`
- `name`, `agent_key_hash` (X-Agent-Key sha)
- `host_os`, `host_ip`, `version`
- `is_active`, `last_seen_at`, `enrolled_at`
- WebSocket bağlantı state'i memory'dedir, DB'de tutulmaz

### 3.3 `organizations`
- `id`, `name`, `slug`
- `created_at`, `updated_at`, `deleted_at` (soft delete)
- `settings` (jsonb) — branding, locale defaults

### 3.4 `locations`
- `id`, `organization_id`, `name`, `slug`
- `parent_location_id` (hiyerarşik)
- `created_at`, `updated_at`, `deleted_at` (soft delete)

### 3.5 `users`
- `id`, `organization_id`, `email`, `password_hash`
- `is_org_wide` (org_admin gibi tüm lokasyonlara erişim)
- `role`, `is_active`, `mfa_enrolled`, `mfa_secret_enc`
- `created_at`, `updated_at`, `deleted_at`

### 3.6 `roles` / `permissions` / `role_permissions`
- Canonical permission key'leri (`devices.read`, `devices.write`, `audit_logs.read`, `port_control.toggle`, ...)
- Sprint 1A sonrası 4 kanonik rol

### 3.7 `credentials` / `credential_profiles`
- `credential_profile_id` → cihaza tek tek girmek yerine paylaşılan profil
- Şifreli alanlar Fernet (env'den `CREDENTIAL_ENCRYPTION_KEY`)

### 3.8 `agent_command_logs`
- Agent'a/gönderilen tüm SSH komutlarının audit'i
- `device_id`, `agent_id`, `command`, `command_type` (ssh_command, snmp_get, ...)
- `executed_at`, `duration_ms`, `success` (boolean), `error` (text)
- `request_user_id`, `request_source` (ui/celery/internal)

### 3.9 Snapshot tabloları (collection cycle'larla beslenir)
| Tablo | Kaynak task | Yenilenme |
|---|---|---|
| `mac_address_entries` | `mac_arp_tasks.collect_mac_arp_all` | 15 dk |
| `arp_entries` | aynı | 15 dk |
| `poe_port_snapshots` | `poe_tasks.snapshot_poe_status` | 15 dk |
| `vlan_snapshots` | ⚠ **şu an periyodik collector YOK** — bkz. [12](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) | — |
| `interfaces_snapshot` *(varsa)* | SNMP / collect | ⚠ VERIFY |
| `topology_links` | `topology_tasks.scheduled_topology_discovery` | 6 saat |
| `lldp_neighbors` | aynı | 6 saat |

### 3.10 `audit_logs`
- `id`, `created_at`, `user_id`, `organization_id`
- `action` (canonical action key: `device_created`, `bulk_credentials_updated`, `login`, vb.)
- `resource_type`, `resource_id`
- `status` (success/failure)
- `details` (jsonb) — action-specific payload
- `ip_address`, `user_agent`

Audit Log v2 (PR #51–#58) bu tabloyu yeniden render eden frontend bileşenleri ekledi; backend schema değişmedi.

## 4. Soft-delete ve tenant scoping davranışları

### 4.1 Soft-delete
- Tablolarda `deleted_at TIMESTAMP NULL` kolonu kullanılır.
- App katmanı default olarak `deleted_at IS NULL` filtreler.
- Soft-deleted satır da **organization_id** taşır; RLS hala uygulanır.
- Eğer bir organization soft-deleted ise üzerindeki devices/locations da soft-deleted olarak işaretlenir (gözlemlenmiş örnek: bir Ruijie pilot saha lokasyonu soft-delete'lendiğinde altındaki cihazlar ve agent kayıtları da soft-deleted işaretlendi).

### 4.2 RLS (Row-Level Security) — Faz 7
- Tüm tenant-aware tablolar `organization_id` taşır; RLS policy bu kolon üstünden.
- Bağlam atama: `SET LOCAL app.current_organization_id = ...` (her transaction'ın başında).
- App kodu için `org_context` context manager (`backend/app/core/org_context.py` — doğrulandı).
- Celery task'larının `with org_context(device.organization_id, device.location_id):` blokları içinde DB erişmesi **şart**.
- Alembic süper-user role'ü RLS bypass eder; bu sayede migration çalışır.

### 4.3 Tenant scoping katmanları
1. **RLS** (DB seviyesi) — en sıkı katman
2. **org_context** (Python seviyesi) — DB'ye yazmadan önce session bağlamı
3. **Endpoint permission gate** (`require_permission`) — kullanıcı seviyesi yetki
4. **Frontend route guard** — UI seviyesi gözle koruma (tek başına güvenli değil)

## 5. Production DB'ye doğrudan SQL yazmanın neden riskli olduğu

Production'da `psql` ile elle UPDATE / DELETE / TRUNCATE / ALTER:

| Risk | Açıklama |
|---|---|
| **RLS bypass** | Superuser ile bağlanırsan RLS çalışmaz → yanlışlıkla başka organizasyonun verisini değiştirebilirsin |
| **Cache invalidation yok** | App katmanı Redis cache'ten okumaya devam eder; UI eski veriyi gösterir; "verdi/almadı" tartışması başlar |
| **Audit log yazılmaz** | `audit_logs` tablosuna app katmanı yazar; doğrudan SQL bu satırı bırakmaz; "kim ne yaptı" izlenmez |
| **Triggerlar ve ORM hooks bypass'lanır** | `updated_at`, computed kolonlar, JSON validation patlayabilir |
| **Alembic head'i değişmez** | Şema değişikliğini SQL ile elle yaparsan migration dosyası ve revision pointer arasında drift birikir |
| **Soft-delete cascade'i kaybolur** | `DELETE` kullanırsan referential integrity kaybolabilir |

**Genel kural:** Production'da DB mutation **yalnız Alembic migration üzerinden** veya **API üzerinden** yapılır. Acil veri düzeltme şart ise:

1. `[READ ONLY]` `BEGIN; SELECT ...` — durum doğrulanır
2. SQL planı yazılır (önce SELECT, sonra UPDATE, en sonda COMMIT)
3. Sahibiyle gözden geçirilir
4. Backup taze olduğu doğrulanır
5. `[MUTATING / DO NOT RUN CASUALLY]` `BEGIN; UPDATE ... WHERE ...; -- audit_log INSERT manual; COMMIT;`
6. App katmanında cache invalidation (Redis key sil veya container restart)

## 6. Hypertable / TimescaleDB

TimescaleDB image kullanılıyor ama hangi tabloların hypertable olduğu **migration'lardan tek tek doğrulanmalı**.

```bash
# READ ONLY (production'da çalıştırılabilir)
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\
  SELECT hypertable_name, num_chunks, chunk_time_interval \
  FROM timescaledb_information.hypertables;"
```

⚠ **VERIFY BEFORE HANDOVER**: Hypertable kümesi devir alma zamanı doğrulanmalı; muhtemel adaylar: `agent_command_logs`, `audit_logs`, `mac_address_entries`, `arp_entries`, `poe_port_snapshots`.

## 7. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- Alembic dosya sayısı (40)
- 3 DATABASE_URL kontratı (compose env)
- Soft-delete + RLS prensibi (compose `Faz 7` yorumu + Faz 7 isolation rework historical internal context — VERIFY BEFORE HANDOVER)
- TimescaleDB image kullanımı

### VERIFY BEFORE HANDOVER
- Production migration head'i
- Hypertable kümesi
- `backend/app/core/org_context.py` context manager API'si (yapı doğrulandı, tam imza VERIFY)
- `audit_logs` ve `agent_command_logs` tablolarının retention policy'si (`retention_tasks.cleanup_old_data` çalıştığında neyi siliyor?)
- Her snapshot tablosunun beklenen row sayısı (cihaz başına; healthy baseline)
