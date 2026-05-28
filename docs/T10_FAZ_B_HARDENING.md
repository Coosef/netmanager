# T10 Faz B — Güvenlik Sertleştirme: Plan + Risk Review

> Durum: **TAMAMLANDI — checkpoint closed (2026-05-29).** Tüm adımlar main'e merge +
> origin/main'e push edildi. **Production/VPS deploy YAPILMADI** (VPS deploy hazard geçerli).
> Tamamlananlar: **B1a** (postgres/redis ports→expose) · **B1b** (backend/flower→expose, nginx tek kapı) ·
> **B1c** (edge/internal network segmentation) · **B2a** (netmgr_app DB perm audit 25/25) ·
> **B2b** (startup DDL gate, BOOTSTRAP_SCHEMA default OFF) · **B3** (DR/Key Recovery Runbook taslağı) ·
> **B4** (log separation + redaction: log_category + security stream + audit dual-emit).
> Backlog: B4.5 trace_id (OTel kurulumu sonrası), agent-auth/API-token security event'leri,
> otomatik DB backup, B2b migration-service ayrımı. Sıradaki büyük aşama: **Faz C — Security Policy Engine**.
>
> Kaynak: T10_ROADMAP.md Faz B (#12 network, #15 log, #2 DB perm, #13 DR/key)
> Kısıtlar: **production deploy YOK** · dev ortamı bozulmayacak · postgres/redis
> dış portları kapatılırsa local debug için override opsiyonu olacak · her adımda
> `docker compose up` + health + test çalışacak · küçük, local-only test edilebilir commitler

---

## B0 — Mevcut Infra Envanteri (audit sonucu)

### Compose topolojisi
- **Tek `docker-compose.yml`** hem dev hem prod'a hizmet ediyor. `docker-compose.override.yml`
  (gitignored, auto-load) yalnız frontend'i dev target + `src` mount yapıyor. VPS'te override
  yok → prod'a düşer (`FRONTEND_TARGET=production`).
- **`networks:` TANIMSIZ** → tüm servisler tek default bridge ağında. Segmentasyon yok.

### Host'a publish edilen portlar (`ports:` — dışarı açık)
| Servis | Port | Durum / Risk |
|--------|------|--------------|
| nginx | `80:80` | Beklenen giriş (Cloudflare önünde). ✓ |
| **postgres** | `5432:5432` | **DB host'a açık** — direct-IP erişim yüzeyi ⚠️ |
| **redis** | `6379:6379` | **Redis host'a açık** (authsız) ⚠️ |
| **backend** | `8000:8000` | API nginx'i bypass ediyor (direct-IP) ⚠️ |
| **flower** | `5555:5555` | Celery UI (basic auth var ama dışarı açık) ⚠️ |
| frontend | `expose: 3000` | Yalnız internal — host'a publish YOK. ✓ |
| prometheus/grafana | `9090` / `3001` | Ayrı monitoring overlay dosyasında. |

> **Önemli:** Konteynerler arası iletişim servis DNS adıyla (`postgres:5432`, `redis:6379`)
> default ağ üzerinden yürür; `ports:` yalnız **host→konteyner** erişimi açar. Yani `ports:`
> kaldırmak konteynerler arası bağlantıyı **bozmaz** — sadece host/direct-IP erişimini kapatır.

### DB kullanıcı ayrımı (Faz 7'de kurulu — sağlam)
- **`netmgr`** = POSTGRES_USER = **superuser** (TimescaleDB image bootstrap). Alembic DDL +
  RLS bypass için `MIGRATION_DATABASE_URL` ile kullanılır.
- **`netmgr_app`** = `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, migration
  `f7a5_create_app_role` ile yaratılır. Yalnız **DML** (SELECT/INSERT/UPDATE/DELETE) + USAGE
  + sequence grant'ları (public + `_timescaledb_internal`). **DDL grant'ı YOK.** Tüm runtime
  servisleri (backend, celery×3, beat, event_consumer, flower) bununla bağlanır → RLS biter. ✓
- **Açık nokta:** `main.py` lifespan'i her backend başlangıcında `MIGRATION_DATABASE_URL`
  (superuser) ile ayrı bir engine açıp `create_all` + idempotent `ALTER TABLE` çalıştırıyor
  (legacy "deprecated" blok). Yani **superuser creds backend konteyner env'inde duruyor** ve
  startup'ta superuser DDL koşuyor — sadece deploy'da değil. (B2 hedefi.)

### Migration zamanlaması
- `alembic upgrade head` **deploy'da elle** çalışır (`docker exec ... alembic upgrade head`,
  DEPLOY_CHECKLIST). Container start'ta otomatik migration YOK. Alembic `env.py`
  `MIGRATION_DATABASE_URL` (superuser) kullanır, yoksa `SYNC_DATABASE_URL`'e düşer.
- `MIGRATION_DATABASE_URL` yalnız **backend** servis env'inde tanımlı; celery/event_consumer
  yalnız `netmgr_app` URL'lerine sahip. ✓

### Şifreleme / sırlar (B3 için)
- `.env` (gitignored): POSTGRES_PASSWORD, APP_DB_PASSWORD, SECRET_KEY,
  **CREDENTIAL_ENCRYPTION_KEY** (Fernet, +`_OLD` rotation = MultiFernet), FLOWER/GRAFANA creds.
- Fernet ile şifrelenen `*_enc` kolonları: `devices.ssh_password_enc`, `enable_secret_enc`,
  `credential_profiles.*`, `ai_settings.*_api_key_enc`, `agent_credential_bundle.agent_aes_key_enc`,
  `organizations.pg_pass_enc`. **Key kaybı → tüm bu kolonlar decrypt edilemez.** Config/topology/
  metrik verisi şifresiz → key kaybından etkilenmez.

### Dev vs Prod farkı (özet)
- **Aynı** compose; tek fark override.yml (frontend dev mount). **postgres:5432 + redis:6379
  hem dev hem prod'da host'a açık.** Prod'a özel hardening yok.

---

## B1 — Network Segmentation (#12, #15)

**Amaç:** Direct-IP saldırı yüzeyini kapat. nginx tek dış kapı (80/443→Cloudflare); postgres/
redis/backend/flower host'tan erişilemez olsun. Konteynerler arası erişim korunur.

### Yaklaşım — 3 küçük adım (kolaydan zora, her biri test edilir)

**B1a — postgres/redis host portlarını kaldır (en yüksek kazanç / en düşük risk)**
- Base compose: `postgres` ve `redis`'ten `ports:` kaldır → `expose:` ekle (5432 / 6379).
- Konteynerler arası erişim DNS ile sürer (etkilenmez). Yalnız host→DB/redis kapanır.
- **Local debug:** portları geri açan opsiyonel overlay (aşağıdaki "Local debug" bölümü).

**B1b — backend:8000 ve flower:5555 host portlarını kaldır**
- backend yalnız nginx üzerinden erişilsin (nginx zaten `backend:8000`'e proxy'liyor).
- flower → host'tan kaldır; gerekiyorsa nginx altında auth'lu bir path veya local overlay.
- Risk: backend'e direct `:8000` ile bağlanan harici bir araç/script varsa kırılır
  (envanterde yok; nginx tüm API trafiğini taşıyor).

**B1c — explicit `edge` / `internal` ağları (defense-in-depth) — DONE (2026-05-29)**
- `edge`: nginx (host:80) + frontend. `internal`: backend, celery×3, beat, event_consumer,
  flower, postgres, redis. nginx her iki ağda. postgres/redis yalnız `internal`.
- `internal: true` KULLANILMADI (backend egress: OUI/AI/agent); izolasyon ağ üyeliğiyle.
- Canlı doğrulama: nginx→backend/frontend 200; backend→pg/redis OK (pozitif); frontend→pg/redis
  DNS çözülemedi (negatif/izole); dev overlay debug portları çalışıyor; base'de tek kapı nginx 80.
- monitoring overlay kullanılırsa Prometheus `networks:[internal]`'a eklenmeli (compose yorumu).

### Local debug opsiyonu (kritik — dev bozulmasın)
İki seçenek; **öneri = (2) committed dev overlay** (izlenebilir, tekrarlanabilir):

1. **Auto-load `docker-compose.override.yml`** (gitignored): mevcut frontend-dev override'a
   postgres/redis (+ backend/flower) `ports:` eklenir. Local'de otomatik açılır, VPS'te dosya
   yok → kapalı kalır. Dezavantaj: gitignored, izlenmez; yeni dev'in elle kurması gerekir.
2. **Committed `docker-compose.dev.yml`** (opt-in overlay): debug portlarını yeniden publish
   eder. Kullanım: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`.
   İzlenebilir, herkes aynı. + `docker-compose.override.example.yml` ile auto-load deseni
   dokümante edilir. **Öneri bu.**

> Compose merge kuralı: base'de port yok + overlay'de port var → local'de port açık;
> overlay olmayan VPS → kapalı. Bu tam istenen davranış.

### B1 Riskleri
- **Düşük (B1a):** ports kaldırmak inter-container'ı bozmaz; geri alma = compose revert.
- **Orta (B1c):** ağ ayrımı yanlışsa servisler birbirini bulamaz → tam health turu şart.
- Cloudflare/nginx zaten tek giriş; üretimde direct-IP'yi firewall da kapatmalı (compose
  hardening firewall'ın yerine geçmez — runbook'a not).

---

## B2 — DB Permission Audit (#2)

**Mevcut durum (sağlam):** `netmgr_app` NOSUPERUSER/NOBYPASSRLS, yalnız DML; DDL yok; RLS
FORCE biter. Bu kısım büyük ölçüde **zaten doğru** — audit + iki sertleştirme:

- **B2a — Grant doğrulama scripti (TAMAMLANDI):** `backend/scripts/audit_db_permissions.py`
  — netmgr_app olarak bağlanır, rol attribute + has_*_privilege + ownership + RLS katalog
  kontrolleri yapar; CANLI DDL denemelerini (CREATE TABLE/SCHEMA) transaction içinde dener ve
  KOŞULSUZ rollback eder (destructive değil). Human + `--json` çıktı; tüm PASS → exit 0.
  Çalıştırma: `docker compose exec -T backend python scripts/audit_db_permissions.py [--json]`.
- **B2b — Startup DDL'i runtime'dan ayır (DONE):** `main.py` lifespan'deki create_all+ALTER
  bloğu artık `BOOTSTRAP_SCHEMA` flag'i arkasında (**varsayılan OFF**). Kapalıyken `_NoopDDLConn`
  597 satırlık bloğu no-op'a çevirir (gövdeye dokunulmadı). `_ddl_engine` yalnız ON iken
  oluşur/dispose edilir. `docker-compose.dev.yml` backend'e `BOOTSTRAP_SCHEMA=1` (local fresh dev);
  prod base'de YOK = OFF. `MIGRATION_DATABASE_URL` backend env'inde kaldı (deploy alembic için).
  Canlı doğrulama (5 senaryo):
  | Senaryo | Sonuç |
  |---|---|
  | Mevcut DB + OFF | ✅ startup clean, "DDL atlandı" logu, /health/ready 200, regresyon yok |
  | Fresh DB + OFF | ✅ tablo yok (0) → seeding `users` bulamaz → startup fail (beklenen, dokümante) |
  | Fresh DB + create_all (BOOTSTRAP_SCHEMA=1) | ✅ 68 tablo kuruldu |
  | Mevcut DB + dev overlay (ON) | ✅ DDL koştu (skip logu yok), startup complete, host:8000 200 |
  | Test suite + health | ✅ 41 test, /health/ready 200 |

  **Bulgu:** `alembic upgrade head` TEK BAŞINA boş DB'yi kuramaz (var olmayan tabloya ALTER) →
  fresh sıra: create_all → alembic (grant/RLS). DR_RUNBOOK §7.2'ye işlendi. Ayrıca B1b'den gelen
  nginx tek-dosya bind-mount inode footgun'u keşfedildi (config değişince `--force-recreate nginx`)
  → DR_RUNBOOK §7.3.
- RLS/FORCE etkilenmez (netmgr_app zaten NOBYPASSRLS).

### B2a — Audit Sonucu (2026-05-28, local canlı, daemon)
`audit_db_permissions.py` → **25/25 PASS → GO**. Doğrulananlar:
- **Rol attribute (pg_roles):** netmgr_app = NOSUPERUSER, NOBYPASSRLS, NOCREATEDB,
  NOCREATEROLE, LOGIN. Kontrast: netmgr = SUPERUSER (migration/DDL bu rolle).
- **Şema/DB yetkisi:** public USAGE ✓; public CREATE **kapalı**; DB CREATE **kapalı**
  (şema yaratamaz).
- **CRUD:** devices/alert_rules/network_events/incidents/topology_links/config_backups →
  SELECT/INSERT/UPDATE/DELETE hepsi True (has_table_privilege).
- **Ownership:** netmgr_app public'te **0 tablo** sahibi (69 tablodan) → ALTER/DROP yapamaz.
- **Canlı DDL denemesi (rollback'li):** `CREATE TABLE public.*` ve `CREATE SCHEMA *` →
  **permission denied** (DENIED). Kalıcı nesne oluşmadı.
- **Canlı okuma:** `SELECT 1` + `SELECT count(*) FROM devices` → çalışıyor.
- **RLS:** 58 tablo RLS-enabled, **hepsi FORCE** (FORCE olmayan = 0), 60 policy. Örnek
  scoped tabloların hepsi enabled+force.

**Sonuç:** runtime/migration user ayrımı **gerçek ortamda doğrulandı** — netmgr_app DDL
yapamıyor, yalnız RLS-scoped CRUD; extension/schema/role yaratamıyor. Hardening main'e
alınmadan önce istenen DB-permission güvencesi sağlanmış durumda. (Bu script CI/deploy
smoke'una da eklenebilir — exit kodu PASS/FAIL.)

---

## B3 — DR / Key Recovery Runbook (#13) — DONE (draft committed)

**Çıktı:** `docs/DR_RUNBOOK.md` (taslak, commit edildi). Dokümantasyon — kod yok.
11 bölüm: temel gerçekler · severity (S0–S4, öneri RTO/RPO) · Fernet key kaybı matrisi ·
key escrow (araç-bağımsız, dual-control/offline/rotation-history/audit) · backup (pg_dump —
**otomatik DEĞİL, manuel**) · restore + doğrulama · rollback anchor (kod SHA + alembic + image) ·
**VPS deploy hazard** + **§7.1 schema/image drift** (yaşanan crash-loop incident'i) ·
retention↔backup · volume kurtarma (`down -v` high-severity uyarısı) · **§11 break-glass admin**.
Açık/sonraki: otomatik backup kurulumu, RTO/RPO SLA'laştırma, **restore-doğrulama smoke scripti
(opsiyonel mini-task)**.

---

## B4 — Log Separation (#15) — Yaklaşım A (tag + route), büyük ölçüde DONE

**Karar:** tek stdout + structured JSON korunur (12-factor); ayrım `log_category` etiketiyle,
ayrıştırma/retention **downstream aggregator**'da (Loki/ELK). File/volume split YOK.
Kategoriler: `access · audit · security · db · task · app · health · ws`.

- **B4.1 (DONE):** `_add_log_category` processor (logger→log_category) + redaction sertleştirme
  (`authorization`/`cookie`/`bearer` key + değer-içi `Bearer`/JWT maskesi). IP maskelenmez.
- **B4.2 (DONE):** `app/core/security_log.py` `log_security_event` → `netmanager.security`
  (category=security, SIEM). login success/failure, login_blocked_ip, mfa verify success/failure,
  logout, 403 permission_denied. DB audit'ten bağımsız/paralel. Canlı doğrulandı (token sızıntısı yok).
- **B4.3 (DONE):** `audit_service.log_action` → `netmanager.audit` dual-emit (category=audit). DB
  `audit_logs` kayıt-of-truth; log satırı SIEM için (action/status/user/org/resource/ip/duration).

### B4.4 — Retention / log driver stratejisi (dokümantasyon)
- **Mevcut:** her servis stdout → docker `json-file` (50m×5). Structured JSON + log_category.
- **Strateji (tag+route):** prod'da stdout bir aggregator'a (Loki+Promtail / Docker log driver /
  Vector) gönderilir; **retention kategori bazlı orada** uygulanır:
  - `audit`, `security` → **uzun** retention (uyumluluk/forensics).
  - `access`, `db`, `task`, `app` → **kısa-orta** retention (operasyonel).
- **File/volume split YAPILMADI** (12-factor; konteyner içine dosya yazımı modeli bozardı).
  Gerekirse SIEM dosya-ingest istiyorsa yalnız `audit`/`security` için seçici stream eklenebilir
  (ayrı görev). docker json-file kategoriden bağımsız döner; ayrıştırma label/parse ile aggregator'da.
- **request_id** her satırda (middleware contextvars) → access/security/audit korelasyonu hazır.

### B4.5 — trace_id (BACKLOG)
OTel SDK image'da kurulu DEĞİL ve kodda span/trace_id propagation yok (`TRACING_ENABLED` env
var ama no-op). Hazır olmadığı için **backlog**. Tracing aktifleşince log context'ine `trace_id`
eklenir (request_id'ye ek korelasyon).

### B4 Backlog (sonraki tur)
- **agent-auth failure** + **API-token invalid** security event'leri: tek-nokta net değil
  (agent_stream/internal akışı) → düşük-risk tek noktaya indirgenince eklenecek.
- B4.5 trace_id (OTel kurulumu sonrası).
- Opsiyonel: SIEM dosya-ingest için seçici audit/security stream.

- **Risk:** düşük (additive processor/log + auth log-only). Gürültü/perf: redaction yalnız
  bearer/eyj içeren string'lerde regex; security/audit hacmi seviye (info/warning) ile yönetilir.

---

## Sıra & Bağımlılıklar
1. **B1a** (postgres/redis ports → expose + local overlay) — ilk, en güvenli, en yüksek kazanç.
2. **B1b** (backend/flower ports).
3. **B2a** (grant doğrulama scripti) — kodsuz, paralel gidebilir.
4. **B1c** (edge/internal ağları) — dikkatli, tam health turu.
5. **B2b** (startup DDL ayrımı) — dev fresh-install'a dikkat, opt-in flag.
6. **B3** (DR runbook) — dokümantasyon, bağımsız.
7. **B4** (log separation) — son.

## Her adımın kabul kriteri (DoD)
- `docker compose up -d` temiz ayağa kalkar; tüm servisler `healthy`.
- Inter-container: backend→postgres/redis, nginx→backend/frontend çalışır.
- Local debug overlay ile host→postgres/redis erişimi (opsiyonel) çalışır; overlay'siz erişilemez.
- `pytest -m "not postgres"` yeşil; ilgili compose/health smoke geçer.
- Geri alma planı: her adım tek commit, `git revert` ile dönülebilir; **prod deploy yok.**

## Kapsam dışı (bu fazda değil)
- #14 web/api cloud DR (kullanıcı "cloud halleder" dedi).
- Faz C (Security Policy Engine) — B sonrası.
- Üretim firewall/WAF kuralları (compose hardening'in tamamlayıcısı, ayrı ops işi).
