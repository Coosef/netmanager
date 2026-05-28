# T10 Faz B — Güvenlik Sertleştirme: Plan + Risk Review

> Durum: **PLAN** (kod yazılmadı, önce gözden geçirilecek)
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

**B1c — explicit `edge` / `internal` ağları (defense-in-depth, en invaziv → en son)**
- `edge`: nginx (host:80) + frontend.
- `internal`: backend, celery×3, beat, event_consumer, flower, postgres, redis.
- nginx her iki ağda (dış + backend/frontend'e ulaşmak için). postgres/redis yalnız `internal`.
- Risk: yanlış ağ ataması → servis birbirini bulamaz. Bu yüzden B1a/B1b'den sonra,
  ayrı commit + tam health turu ile.

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

- **B2a — Grant doğrulama (kod yok, doğrulama scripti):** çalışan DB'de `\du netmgr_app` +
  `information_schema.role_table_grants` ile netmgr_app'in CREATE/ALTER/DROP yapamadığını,
  yalnız CRUD olduğunu doğrula. Bir test/script olarak DEPLOY_CHECKLIST'e ekle.
- **B2b — Startup DDL'i runtime'dan ayır:** `main.py` lifespan'deki `create_all`+`ALTER`
  bloğu superuser ile her başlangıçta koşuyor. Hedef: şema yönetimi yalnız Alembic'te (deploy),
  runtime startup'ta DDL yok. → `MIGRATION_DATABASE_URL`'i uzun-ömürlü backend env'inden
  çıkar/gate'le; fresh-install dev için ayrı bir opt-in yol bırak (örn. `BOOTSTRAP_SCHEMA=1`).
  **Risk:** fresh dev env create_all'a bağımlı; geçişi dikkatli + dev'de test. Bu yüzden B2b
  ayrı commit, varsayılan davranış korunur, opt-out flag ile.
- RLS/FORCE etkilenmez (netmgr_app zaten NOBYPASSRLS).

---

## B3 — DR / Key Recovery Runbook (#13)

**Büyük ölçüde dokümantasyon** (düşük kod riski). `docs/DR_RUNBOOK.md` (yeni):

- **Fernet key kaybı matrisi:** key kaybında ne kurtulur / ne kaybolur:
  - **Kaybolur (decrypt edilemez):** device SSH şifreleri (`ssh_password_enc`, `enable_secret_enc`),
    credential_profile sırları, AI API anahtarları, agent AES bundle, org pg_pass.
  - **Kurtulur (şifresiz):** config backup'lar, topoloji, metrikler, event/incident, audit.
- **Key escrow prosedürü:** CREDENTIAL_ENCRYPTION_KEY (+`_OLD`) offline/secret-manager yedeği;
  rotation MultiFernet ile (eski key `_OLD`'da kalır → eski veri okunur). Rotation adımları.
- **Backup + restore:** postgres volume / `pg_dump` restore adımları + key restore sırası
  (önce key, sonra DB; aksi halde decrypt patlar).
- **Restore testi:** manuel checklist (DEPLOY_CHECKLIST'e veya runbook'a).

---

## B4 — Log Separation (#15)

**Amaç:** access ↔ audit ↔ DB/query log ayrı stream + retention + sensitive redaction.

- **B4a — Logger ayrımı:** mevcut `netmanager.http` + structured logging üzerine; API access,
  audit (audit_service zaten DB'de) ve uygulama log'larını ayrı logger/handler'a böl.
- **B4b — Sensitive redaction:** log'larda şifre/token/Fernet/Authorization header sızıntısı
  için redaction filtresi (parola, `*_enc`, Bearer token).
- **B4c — Retention:** docker json-file zaten 50m×5; gerekiyorsa log tipine göre ayrı volume/
  retention. (A3'teki veri retention'dan ayrı — bu log dosyası retention'ı.)
- Risk: düşük; logging config + filter. Gürültü/perf'e dikkat.

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
