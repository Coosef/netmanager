# VPS tam deploy zinciri — pre-deploy inventory

> **Durum: PLAN + INVENTORY (taslak).** Bu doküman kod yazma/deploy talimatı DEĞİL.
> Amaç: origin/main'in ~2 ay gerideki VPS'e güvenli taşınması için (a) VPS mevcut
> durum envanteri, (b) risk haritası, (c) backup, (d) staging provası, (e) deploy
> runbook, (f) smoke gate'leri, (g) rollback yolunu önceden netleştirmek.
>
> **YASAK (bu aşamada, VPS'te):** `git pull` · `alembic upgrade` · `docker compose down`
> · herhangi bir destructive/migration işlemi. Sadece **read-only** envanter komutları
> çalıştırılır. Asıl deploy ayrı, açık onayla yapılır.
>
> Backup/restore/rollback/key-escrow prosedürleri `docs/DR_RUNBOOK.md` §4/§5/§6/§7'de
> tanımlı — burada tekrarlanmaz, **referans verilir**. M6 geçmişi: `docs/M6_DEPLOY_LOG.md`.

---

## 0. Temel gerçekler (yerel repo'dan doğrulandı, 2026-05-29)

| | Değer |
|---|---|
| origin/main HEAD | `5a1f3c8` (T10 A+B+C MVP + TD-2) |
| Alembic **head** (hedef) | **`f9adsecrls`** |
| VPS beklenen revision | **`d5e6f7a8b9c0`** (Faz 5D — Faz 7 ÖNCESİ son revision) — **inventory ile doğrula** |
| Uygulanacak migration sayısı | **32** (Faz7×9 + Faz8×10 + Faz9×10 + T10-C×3) |
| Migration kullanıcısı | **`netmgr`** (superuser) — `MIGRATION_DATABASE_URL` |
| Runtime kullanıcısı (deploy SONRASI) | **`netmgr_app`** (NOSUPERUSER/NOBYPASSRLS) — `DATABASE_URL` |
| Forward-destructive migration'lar | **`f8a5_drop_legacy_tenant`** (M6), **`f9a9_ipam_rebuild`** (IPAM tabloları DROP+rebuild, **veri korunmaz**) |

**Migration zinciri (özet, sıra önemli):**
```
d5e6f7a8b9c0 (VPS)
  └─ Faz 7 (org/location + RLS):
       f7a1addorgloc → f7a2backfill → f7a3notnull → f7a4rls → f7a5approle
       → f7a6roles → f7a7softdel → f7a8auditrls → f7b1toposnaploc
  └─ Faz 8 (isolation + M6 destructive):
       f8a1snmpview → f8a2lochier → f8a3deviceip → f8a4orgmgmt
       → ⚠️ f8a5droplegacytenant (M6) → f8a6auditpermissivewrites → f8a7mfauserfields
       → f8a8compliance → f8a9vlansnap → f8a10sessions
  └─ Faz 9:
       f9a1sysset → f9a2userips → f9a3pwpolicy → f9a4termses → f9a5lifecycle
       → f9a6portchg → f9a7cyclicmw → f9a8poesnap → ⚠️ f9a9ipamrebld → f9aafirmware
  └─ T10 Faz C:
       f9absecpol → f9acdevsecfk → f9adsecrls   ← HEAD
```

---

## 1. VPS mevcut durum inventory (READ-ONLY)

> Hepsi okuma. Hiçbiri yazmıyor/migrate etmiyor. VPS'te SSH ile, repo dizininde çalıştır.
> Komutlardaki servis/DB adları (`postgres`, `network_manager`, `netmgr`) VPS compose'una
> göre teyit edilmeli. Secret'ları **gösterme** (aşağıda maskeli env komutu var).

### 1.1 Kod / image
```bash
# git HEAD (deploy edilmemiş local değişiklik var mı?)
git rev-parse HEAD; git status --porcelain | head; git log --oneline -3

# docker image digest'leri (çalışan konteynerlerin gerçek image'ı)
docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
docker inspect --format '{{.Name}} {{.Image}} {{.Config.Image}}' $(docker compose ps -q) 2>/dev/null
docker images --digests | grep -iE "switch|netmanager"
```

### 1.2 Alembic durumu (read-only — `current`/`heads` migrate ETMEZ)
```bash
# VPS DB'nin bulunduğu revision (alembic_version tablosunu OKUR)
docker compose exec -T backend alembic current 2>&1 | tail -3
# Bu kod tabanındaki head(ler) (script dosyalarını okur)
docker compose exec -T backend alembic heads 2>&1 | tail -3
# Doğrudan tablo (alembic exec başarısızsa):
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT version_num FROM alembic_version;"
```

### 1.3 Şema sayımı + legacy tenant kontrolü
```bash
# Tablo sayısı + tablo listesi
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT count(*) AS table_count FROM information_schema.tables WHERE table_schema='public';"
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1;"

# Toplam kolon sayısı (drift ölçümü)
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT count(*) AS column_count FROM information_schema.columns WHERE table_schema='public';"

# ⚠️ LEGACY: tenants tablosu var mı? (f7a2 backfill bunu OKUR; f8a5 DROP eder)
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT to_regclass('public.tenants') AS tenants_table;"
# tenant_id kolonu olan tablolar
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' ORDER BY 1;"
# organization_id kolonu olan tablo var mı? (varsa Faz7 KISMEN uygulanmış olabilir → DİKKAT)
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT count(*) AS tables_with_org_id FROM information_schema.columns WHERE table_schema='public' AND column_name='organization_id';"
# users.role (legacy enum) var mı? (f8a5 DROP eder)
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name IN ('role','system_role');"
```

### 1.4 Veri sayımları (backfill etkisi + IPAM destructive riski)
```bash
docker compose exec -T postgres psql -U netmgr -d network_manager -c "
  SELECT 'tenants' t, count(*) FROM tenants
  UNION ALL SELECT 'organizations', count(*) FROM organizations
  UNION ALL SELECT 'users', count(*) FROM users
  UNION ALL SELECT 'locations', count(*) FROM locations
  UNION ALL SELECT 'devices', count(*) FROM devices;" 2>&1
# (organizations/locations tabloları yoksa Faz7 hiç uygulanmamış demektir — beklenen.)

# ⚠️ IPAM — f9a9_ipam_rebuild bu tabloları DROP+yeniden kurar (VERİ KORUNMAZ).
#    Boş değilse: deploy öncesi export + sonrası manuel re-import PLANI gerekir.
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT to_regclass('public.ipam_subnets'), to_regclass('public.ipam_addresses');"
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT (SELECT count(*) FROM ipam_subnets) AS subnets, (SELECT count(*) FROM ipam_addresses) AS addresses;" 2>&1
```

### 1.5 Agent'lar / hypertable / DB rolleri
```bash
# Aktif agent sayısı (varsa) — deploy sonrası WS reconnect doğrulaması için
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT count(*) FILTER (WHERE is_active) AS active_agents, count(*) AS total FROM agents;" 2>&1
# DB rolleri (netmgr / netmgr_app durumu) — f7a5 netmgr_app'i KURAR
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('netmgr','netmgr_app');"
# RLS aktif tablo var mı? (Faz7 öncesi 0 beklenir)
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT count(*) AS rls_forced FROM pg_class WHERE relrowsecurity AND relforcerowsecurity;"
# TimescaleDB sürümü (staging imajı eşleşmeli)
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT extname, extversion FROM pg_extension WHERE extname='timescaledb';"
```

### 1.6 Backup klasörü / disk / env (secret göstermeden)
```bash
# Mevcut backup dosyaları + boyutları
ls -lah backups/ 2>/dev/null; ls -lah /var/backups/netmanager 2>/dev/null
# Disk alanı (pg_dump + staging restore için yeterli mi?)
df -h .; docker system df
# Postgres veri dizini boyutu (dump süresi/boyut tahmini)
docker compose exec -T postgres psql -U netmgr -d network_manager -c \
  "SELECT pg_size_pretty(pg_database_size('network_manager'));"

# Env ANAHTAR İSİMLERİ (değerleri MASKELE — secret sızdırma)
sed -E 's/=.*/=********/' .env | sort
# Kritik anahtarların VARLIĞINI doğrula (değer gösterme):
for k in DATABASE_URL SYNC_DATABASE_URL MIGRATION_DATABASE_URL APP_DB_PASSWORD \
         POSTGRES_PASSWORD CREDENTIAL_ENCRYPTION_KEY SECRET_KEY BOOTSTRAP_SCHEMA \
         FRONTEND_TARGET GRAFANA_PASSWORD; do
  grep -q "^$k=" .env && echo "$k: SET" || echo "$k: MISSING"
done
```

**Inventory çıktısı ile doğrulanacak kabuller:**
- VPS revision = `d5e6f7a8b9c0` (değilse zinciri yeniden hesapla).
- `tenants` tablosu + `tenant_id` kolonları **VAR** (f7a2 backfill için gerekli).
- `organization_id` kolonu olan tablo **YOK** (Faz7 hiç uygulanmamış). Varsa → **kısmi/yarım migration** → ayrı analiz.
- IPAM tabloları **boş** ya da boş değilse export planı.
- `netmgr_app` rolü **YOK** (f7a5 kuracak); `netmgr` superuser.
- `MIGRATION_DATABASE_URL` ve `APP_DB_PASSWORD` env'de **SET** (değilse deploy bloklanır — bkz. §2).

---

## 2. Risk haritası

### 2.1 Migration zinciri riskleri (sıralı)
| Migration | Risk | Azaltma |
|---|---|---|
| **f7a2backfill** | tenant→org/location backfill; veri tutarsızsa sonraki NOT NULL patlar | staging'de tam prova; "Unassigned" location raporunu incele |
| **f7a3notnull** | `organization_id NOT NULL` — backfill eksikse migration ortada DURUR (yarım şema) | f7a2 sonrası NULL org taraması; CONCURRENTLY index → tek tx değil |
| **f7a4rls** | `ENABLE + FORCE ROW LEVEL SECURITY` — anlık + global. Sonraki tüm runtime sorguları RLS context ister | Migration `netmgr` **superuser** ile koşar → RLS'i atlar (sorun yok). **Runtime netmgr_app'e geçmeli** (§2.3) |
| **f7a5approle** | `netmgr_app` rolünü `APP_DB_PASSWORD`'dan kurar; parola env'den okunur | Deploy öncesi `APP_DB_PASSWORD` set + runtime `DATABASE_URL` aynı parolayı kullanmalı |
| **f7a6roles** | UserRole→SystemRole remap; eşleşmeyen rol → viewer'a düşebilir | staging'de kullanıcı rol dağılımını doğrula |
| **⚠️ f8a5droplegacytenant (M6)** | `DROP COLUMN tenant_id` (tüm tablolar) + `DROP COLUMN users.role` + `DROP TABLE tenants CASCADE` — **GERİ ALINAMAZ** | Veri f7a2'de org'a taşındı; **yine de pre-deploy pg_dump şart** (downgrade veriyi geri getirmez) |
| **⚠️ f9a9ipamrebld** | `DROP TABLE ipam_subnets/ipam_addresses CASCADE` → yeni şema (zones/subnets/assignments). **Mevcut IPAM verisi KORUNMAZ** | Inventory §1.4'te IPAM boş değilse: deploy öncesi export, sonrası manuel re-import. Boşsa risk yok |
| f9aa / f9ad | yeni tablolar + RLS + seed (org bazlı) | düşük risk; staging'de seed sayısını doğrula |

> **Not:** `f7a1`, `f8a7`, `f9a2`, `f9a3`, `f9a5`, `f9a7` vb. migration'lardaki `drop_column`/`drop_table`
> çağrılarının çoğu **downgrade()** içindedir (forward'da tablo/kolon EKLER). Forward-destructive
> olanlar yalnız **f8a5** ve **f9a9**'dur.

### 2.2 Migration RLS davranışı (kritik kabul)
- Migration'lar **`netmgr` superuser** ile koşmalı (`MIGRATION_DATABASE_URL`). PostgreSQL superuser'ı
  RLS'i (FORCE dahil) **atlar** → f7a4 sonrası DDL/data migration'ları satır-filtreye takılmaz.
- **TEHLİKE:** `MIGRATION_DATABASE_URL` set DEĞİLSE, `env.py` `SYNC_DATABASE_URL`'e düşer; bu `netmgr_app`
  (NOBYPASSRLS) ise f7a4 sonrası migration'lar 0-satır görüp **bozuk geçiş** üretir. **Deploy öncesi
  `MIGRATION_DATABASE_URL=...netmgr...` doğrula** (inventory §1.6).

### 2.3 Runtime kullanıcı geçişi (kod+DB birlikte taşınmalı)
- Deploy ÖNCESİ VPS runtime'ı muhtemelen tek superuser (`netmgr`) ile bağlanıyor (netmgr_app yoktu).
- Deploy SONRASI runtime **`netmgr_app`** (NOBYPASSRLS) + RLS context ile çalışmalı. Bu yüzden:
  - `.env` `DATABASE_URL`/`SYNC_DATABASE_URL` → `netmgr_app` kullanıcısına çevrilecek (parola = `APP_DB_PASSWORD`, f7a5 ile aynı).
  - Deploy edilen **kod** Faz7+ olmalı (RLS context'i deps/worker'larda kuruyor). Eski kod + yeni RLS şeması = 0 satır. **Kod ve DB aynı anda cut-over.**

### 2.4 Compose / network / bootstrap (B1b/B1c/B2b) etkisi
- **B1c network segmentation:** `edge` (nginx, frontend) / `internal` (backend, celery×3, beat,
  event_consumer, flower, postgres, redis); dış kapı yalnız nginx. VPS'te daha önce backend:8000 /
  flower:5555 / postgres:5432 host'a publish ediliyorsa **artık edilmeyecek** — VPS reverse-proxy /
  firewall / monitoring beklentileri buna göre güncellenmeli.
- **B2b `BOOTSTRAP_SCHEMA` default OFF:** `main.py` artık startup'ta `create_all` YAPMAZ. Mevcut DB
  için doğru (şema tek otorite = alembic). **VPS .env'de `BOOTSTRAP_SCHEMA` set edilmemeli** (fresh
  bootstrap değil; bu bir UPGRADE). Fresh DB sırası için DR_RUNBOOK §7.2.
- **dev overlay (`docker-compose.dev.yml`) VPS'te KULLANILMAYACAK** — debug portları açar, BOOTSTRAP_SCHEMA=1
  set eder. VPS yalnız `docker-compose.yml` (+ gerekiyorsa `docker-compose.monitoring.yml`) ile koşar.
  `FRONTEND_TARGET=production` (varsayılan) — dist + nginx; Vite dev yolları nginx'te 404.
- **nginx inode footgun** (DR_RUNBOOK §7.3): nginx.conf değişirse `--force-recreate nginx`.

### 2.5 Kapsam dışı bırakılan açık riskler
- **C5 auto-quarantine** dahil DEĞİL (port shutdown YOK — bu deploy davranışı değiştirmez).
- **TD-2** zaten çözüldü (agent WS 5xx). Deploy sonrası agent WS reconnect smoke ile doğrulanır.

---

## 3. Backup planı (deploy ÖNCESİ — DR_RUNBOOK §4/§5/§6 referans)
1. **Full `pg_dump`** (mantıksal) — DR_RUNBOOK §4a komutu. Bütünlük için **SHA-256** kaydı (§4a).
2. **Backup restore dry-run** — dump'ı **ayrı/boş** bir DB'ye restore edip §5b doğrulama sorgularını koştur
   (bu aynı zamanda §4 Staging provasının girdisi).
3. **Key escrow kontrolü** — `CREDENTIAL_ENCRYPTION_KEY` (+ varsa `_OLD`) escrow'da mı? DR_RUNBOOK §3.
   Key kaybı = şifreli SSH/SNMP credential'ları geri DÖNÜLEMEZ (§2 matris).
4. **Rollback anchor kaydı** (deploy öncesi durumu dondur): `git rev-parse HEAD` (kod SHA),
   çalışan image digest'leri (§1.1), `alembic current` (§1.2), pg_dump dosya yolu + SHA-256.
   Hepsi tek bir "PRE-DEPLOY ANCHOR" notuna yazılır (DR_RUNBOOK §6).
5. (Opsiyonel) **Volume snapshot** — fiziksel alternatif (DR_RUNBOOK §4b).

> Backup + restore dry-run **YEŞİL olmadan** deploy'a geçilmez.

---

## 4. Staging provası (zorunlu — VPS'e dokunmadan)
Amaç: 32-migration zincirini **VPS'in gerçek verisi** üzerinde, izole bir ortamda baştan sona koşmak.
1. **Ayrı staging DB/konteyner** ayağa kaldır (VPS ile **aynı** Postgres+TimescaleDB sürümü — inventory §1.5).
2. VPS pre-deploy **pg_dump'ını** staging DB'ye restore et (boş DB'ye).
3. Staging `.env`: `MIGRATION_DATABASE_URL` = staging superuser; `APP_DB_PASSWORD` set;
   `BOOTSTRAP_SCHEMA` set DEĞİL; `FRONTEND_TARGET=production`.
4. **`alembic upgrade head`** — 32 migration baştan sona. Beklenen son revision: `f9adsecrls`.
   - Her faz sınırında dur/incele (özellikle f7a3 NOT NULL, f8a5 M6, f9a9 IPAM).
   - f7a2 sonrası "Unassigned" location'a düşen cihaz raporunu çıkar.
5. **Uygulama boot** (staging compose) — backend healthy, RLS aktif tablo sayısı beklenen, `netmgr_app` rolü var.
6. **Smoke testleri** (§6) staging'de koş. Hepsi yeşilse VPS deploy'una "hazır" denir.
7. Staging'i yık; öğrenilenleri runbook'a (§5) işle.

---

## 5. Deploy runbook (asıl deploy — AYRI onayla)
> Sıra bağlayıcı. Her adımda çıktı kaydedilir. Herhangi bir gate kırmızıysa → §7 Rollback.
1. **Maintenance window** ilan et; kullanıcıya duyur.
2. **Freeze:** yeni merge/push durdur; origin/main `5a1f3c8` (veya o anki onaylı SHA) sabit.
3. **Backup (§3):** full pg_dump + SHA-256 + rollback anchor. Restore dry-run yeşil.
4. **Kod güncelle:** `git fetch` + `git checkout <onaylı-SHA>` (naive `git pull` DEĞİL; anchor'lı SHA).
5. **Env hazırla:** `MIGRATION_DATABASE_URL` (netmgr), `APP_DB_PASSWORD`, `DATABASE_URL`/`SYNC_DATABASE_URL`
   (netmgr_app), `BOOTSTRAP_SCHEMA` unset, `FRONTEND_TARGET=production`. (IPAM doluysa export alındı.)
6. **Image build:** `docker compose build` (gerekirse `--no-cache`). Frontend production stage (dist).
7. **Migration step-by-step:** `docker compose run --rm backend alembic upgrade head`
   (yalnız migration; uygulama henüz yeni şemaya yazmıyor). Çıktıyı izle; faz sınırlarında doğrula.
   - Alternatif güvenli mod: faz faz (`alembic upgrade f7b1toposnaploc`, sonra `f8a10sessions`, ...).
8. **Servisleri kaldır:** `docker compose up -d` (down DEĞİL; rolling recreate). nginx.conf değiştiyse
   `--force-recreate nginx`.
9. **Smoke gates (§6):** sırayla; ilk kırmızıda dur.
10. **Maintenance window kapat** (tüm gate'ler yeşilse).

**Rollback kriterleri (deploy'u geri al):** migration zinciri ortada durdu / NOT NULL ya da RLS hatası /
smoke gate kırmızı (login, agent connect, RLS izolasyonu, 5xx) / IPAM verisi beklenmedik kayıp.

---

## 6. Smoke gate'leri (deploy sonrası — staging + prod)
| # | Gate | Beklenen |
|---|---|---|
| 1 | `GET /health/ready` (nginx üzerinden) | 200 |
| 2 | Login (super-admin) | 200 + token |
| 3 | Super-admin → orgs listesi | tüm org'lar görünür |
| 4 | Agent connect (WS `/api/v1/agents/ws/{id}`) | bağlanıyor; **5xx YOK** (TD-2) |
| 5 | Topology build | org/location-scoped, hata yok |
| 6 | Security Policies sayfası/API | switch/port list 200; org-izole |
| 7 | Events + `/ws/events` (valid token) | 101 open; akış geliyor |
| 8 | WebSocket genel | 5xx/handshake hatası yok |
| 9 | Backend logs taraması | `5xx` / `Traceback` / `OAuth2PasswordBearer` **yok** |
| 10 | RLS izolasyonu | org A kullanıcısı yalnız org A verisini görür; cross-org INSERT WITH CHECK reddi |
| 11 | DB permission audit | `backend/scripts/audit_db_permissions.py` → netmgr_app least-privilege PASS |

---

## 7. Rollback (deploy başarısızsa — DR_RUNBOOK §6)
> **Tek başına `alembic downgrade` veriyi GERİ GETİRMEZ** (f8a5/f9a9 destructive). Rollback = kod + image
> + **DB restore** birlikte.
1. **Yazan servisleri durdur** (event_consumer, celery, backend) — yazımı kes (DR_RUNBOOK §6).
2. **DB restore:** pre-deploy pg_dump'ı geri yükle (DR_RUNBOOK §5a) — şema + veri deploy-öncesi haline döner.
   (Downgrade'e güvenme; destructive migration'lar için backup tek doğru yol.)
3. **Kod:** `git checkout <pre-deploy-anchor-SHA>`.
4. **Image:** önceki tag/digest'e dön ya da anchor SHA ile `docker compose build`.
5. **Key:** gerekiyorsa escrow'dan `CREDENTIAL_ENCRYPTION_KEY` geri yükle (DR_RUNBOOK §3/§5).
6. **Doğrulama:** §6 smoke gate'leri (1-3, 9, 10) yeşil; `alembic current` = pre-deploy revision; veri sayımları
   (§1.4) deploy-öncesi ile eşleşiyor.
7. **IPAM** (eğer f9a9 koştuysa ve geri dönülüyorsa): restore zaten eski IPAM şemasını/verisini getirir.

---

## Ek — referanslar
- `docs/DR_RUNBOOK.md` — §3 key escrow, §4 backup, §5 restore+doğrulama, §6 rollback anchor, §7 VPS hazard + §7.2 fresh bootstrap sırası + §7.3 nginx inode.
- `docs/M6_DEPLOY_LOG.md` — M6 (f8a5) geçmiş deploy notları.
- `backend/scripts/audit_db_permissions.py` — netmgr_app least-privilege audit (B2a).
- `backend/alembic/env.py` — `get_url()` (MIGRATION_DATABASE_URL önceliği), RLS notu.
