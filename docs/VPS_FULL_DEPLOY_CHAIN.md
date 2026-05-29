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

## 0. Temel gerçekler

> ✅ **CANLI INVENTORY İLE DÜZELTİLDİ (2026-05-29).** Bu dokümanın ilk taslağı, eski/bayat
> hafıza notuna ("VPS d5e6f7a8b9c0'da, 2 ay geride, 32 migration, 2 destructive") dayanıyordu.
> **Gerçek durum çok daha iyi** — aşağıdaki tablo VPS'te çalıştırılan read-only inventory'nin sonucudur.

| | Değer (DOĞRULANDI) |
|---|---|
| origin/main HEAD | `2a80464` (T10 A+B+C MVP + TD-2 + bu doc) |
| Alembic **head** (hedef) | **`f9adsecrls`** |
| **VPS git HEAD** | **`0dface5`** (branch main) — origin/main'in **temiz atası** (fast-forward; diverjans yok) |
| **VPS alembic current** | **`f9aafirmware`** ✓ (DB `alembic_version` + `alembic current` aynı) |
| **Bekleyen migration** | **yalnız 3 ADDITIVE** — `f9ab` (policy tabloları), `f9ac` (device FK kolon), `f9ad` (RLS+seed). `upgrade()`'lerde drop YOK |
| Eksik kod | **49 commit** (tüm T10 Faz A1/A2/A3 + Faz B + Faz C + TD-2 + docs) |
| ✅ Destructive migration'lar | **`f8a5` (M6 tenant drop) + `f9a9` (IPAM rebuild) ZATEN UYGULANMIŞ** — tenants ABSENT, 0 tenant_id, IPAM rebuilt+boş. **Pending'de destructive YOK.** |
| Migration kullanıcısı | **`netmgr`** (super+bypassrls) — `MIGRATION_DATABASE_URL` compose'ta tanımlı, runtime env'de doğrulandı ✓ |
| Runtime kullanıcısı | **`netmgr_app`** (NOSUPER/NOBYPASSRLS) — `DATABASE_URL`/`SYNC_DATABASE_URL` compose'ta, runtime env'de doğrulandı ✓ |
| Prod veri | 4 org · 3 user · 8 location · 71 device · 27 agent · DB **383 MB** · disk **%80 (9.3G boş)** |

**Düzeltilmiş migration deltası (VPS → hedef):**
```
f9aafirmware (VPS current)
  └─ f9absecpol  (CREATE switch/port policy tabloları)        [additive]
  └─ f9acdevsecfk(devices: security_policy_id + port_security_policy_id FK kolon) [additive]
  └─ f9adsecrls  (RLS enable/force + org-bazlı seed)          [additive]   ← HEAD f9adsecrls
```
> Faz 7/8/M6/9 zincirinin tamamı (f7a1…f9aa) VPS'te **zaten uygulanmış**. Eski "32 migration / 2 destructive"
> çerçevesi GEÇERSİZ. Kalan DB işi: 3 additive migration. **DB-yıkım riski yok.**

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

### 2.1 Migration zinciri riskleri — DÜZELTİLDİ (düşük)
Bekleyen yalnız **3 additive** migration; f8a5/f9a9 destructive'leri zaten geçmişte. DB riski düşük.

| Migration | İşlem | Risk |
|---|---|---|
| **f9absecpol** | `switch_security_policies` + `port_security_policies` tabloları CREATE | düşük — yeni tablo |
| **f9acdevsecfk** | `devices`'a `security_policy_id` + `port_security_policy_id` FK kolon ADD (nullable) | düşük — nullable kolon, mevcut satırlar NULL |
| **f9adsecrls** | RLS enable/force + org-bazlı preset seed (3 switch/7 port × org) | düşük — RLS pattern f7a4 ile aynı; seed idempotent değilse org başına tekrar kontrol et |

- Migration kullanıcısı **`netmgr` superuser** (runtime env'de doğrulandı: `MIGRATION_DATABASE_URL=...netmgr...`) → RLS'i atlar. **Kanıt:** VPS'te f7a4 sonrası tüm migration'lar (f9aa'ya kadar) bu yolla zaten başarıyla koştu.
- **ARTIK GEÇERSİZ:** f7a2 backfill / f7a3 NOT NULL / f7a4 RLS-enable / f8a5 M6 / f9a9 IPAM riskleri — hepsi VPS'te **çoktan uygulanmış**; bu deploy'da tekrar koşmaz.

> **Yine de pre-deploy pg_dump ŞART** (additive olsa da geri-dönüş güvencesi + DR_RUNBOOK §4).

### 2.2 Migration RLS davranışı — DOĞRULANDI ✓
- VPS runtime env'inde **`MIGRATION_DATABASE_URL=postgresql+psycopg2://netmgr:****@postgres:5432/network_manager`**
  → migration'lar **`netmgr` superuser** ile koşar; superuser RLS'i (FORCE dahil) atlar. compose.yml satır 68 + comment
  "the app URLs above use the non-superuser netmgr_app role so RLS bites". Kanıt: f7a4 sonrası tüm migration'lar
  (→f9aa) zaten bu yolla başarılı. 3 yeni migration aynı kanıtlı yoldan gider. **Ek aksiyon gerekmez.**

### 2.3 Runtime kullanıcı — ZATEN netmgr_app ✓ (geçiş gerekmez)
- VPS runtime env: **`DATABASE_URL=...netmgr_app:****@...`**, `SYNC_DATABASE_URL=...netmgr_app:****@...`
  → runtime **zaten** non-superuser `netmgr_app` (NOBYPASSRLS) ile bağlı; RLS aktif (58 tablo FORCE).
  Faz7'de yapılmış olan netmgr→netmgr_app geçişi **tamamlanmış durumda** — bu deploy'da yapılacak bir cut-over YOK.
- DB URL'leri `.env`'de değil **`docker-compose.yml`**'de (`${APP_DB_USER:-netmgr_app}` / `${POSTGRES_USER:-netmgr}`
  default'ları ile). `.env`'de `APP_DB_PASSWORD` görünmese de netmgr_app bağlantısı çalışıyor → parola compose
  default'undan geliyor ve f7a5'in kurduğu parola ile **eşleşiyor** (kanıt: app healthy). 3 yeni migration rol
  parolasına dokunmaz.

### 2.4 Compose / network / bootstrap (B1b/B1c/B2b) etkisi — DOĞRULANDI
**Mevcut (B1c ÖNCESİ) yayınlanan portlar (VPS canlı):** nginx `0.0.0.0:80`, **backend `0.0.0.0:8000`**,
**flower `0.0.0.0:5555`**, **redis `0.0.0.0:6379`**, **postgres `0.0.0.0:5432`** — yani DB/redis/backend
şu an internete açık (yalnız bulut firewall'u koruyorsa). Tek network: `netmanager_default`.

**Aktif dış erişim zinciri (doğrulandı):**
`Cloudflare → cloudflared (token tunnel) / host-nginx :443 (ws-systrack.conf) → 127.0.0.1:80
(netmanager-nginx-1 container) → backend/frontend`. Host nginx `ws-systrack.conf` (sites-**enabled**)
`proxy_pass http://127.0.0.1:80`'e gidiyor. `:8000`'e giden `netmanager.conf` sites-**available**
(ENABLED DEĞİL). `https://localhost/api/v1/auth/login → 405` ile zincir backend'e ulaşıyor (doğrulandı).

**B1c etkisi → DÜŞÜK risk:** B1c backend:8000/postgres/redis/flower host-publish'ini kaldırır, yalnız
nginx:80 kalır. Aktif yol zaten **:80 üzerinden** → kırılmaz. Yan fayda: DB/redis/backend internete
kapanır (hardening). edge={nginx,frontend} / internal={backend,celery×3,beat,event_consumer,flower,
postgres,redis}, nginx ikisinde.

> ⚠️ **DEPLOY ÖNCESİ TEYİT (tek açık nokta):** cloudflared **token tunnel** (ingress Cloudflare Zero
> Trust panelinde, VPS'te yerel config yok). Tunnel'in public hostname'i **`localhost:80`'e mi yoksa
> `:8000`/`:3000`'e mi** işaret ettiği panelden doğrulanmalı. `:80` ise B1c güvenli; `:8000`/`:3000` ise
> B1c öncesi `:80`'e (container nginx) çevrilmeli. (Host nginx `:8000` config'i zaten devre dışı → yol
> büyük olasılıkla :80.)
> ⚠️ **Güvenlik:** cloudflared tunnel **token'ı** inventory çıktısında maskelenmeden göründü → sızmış
> kabul et; paylaşılan bir ortamsa Cloudflare'de **rotate** et.
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
7. **Migration step-by-step:** ⚠️ B1c nedeniyle `docker compose run` DEĞİL — `up` öncesi network topolojisi
   değiştiğinden one-off container çalışan postgres'e ulaşamaz. Mevcut `netmanager_default` ağında, yeni
   image + çalışan backend env'iyle koş (bkz. §8 P6):
   `docker run --rm --network netmanager_default --env-file <(docker inspect netmanager-backend-1 --format '{{range .Config.Env}}{{println .}}{{end}}') netmanager-backend:latest alembic upgrade head`
   (yalnız migration; uygulama henüz yeni şemaya yazmıyor). Çıktıyı izle.
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

## 8. PRE-FLIGHT CHECKLIST (deploy günü — somut, VPS'e özel)

> Bağlam doğrulandı (staging provası YEŞİL): VPS `0dface5`/`f9aafirmware` → hedef `2a80464`/`f9adsecrls`,
> **3 additive migration** (f9ab/f9ac/f9ad), migration=`netmgr` & runtime=`netmgr_app` (compose'ta — **env değişikliği gerekmez**).
> Container'lar `netmanager-*`, dizin `/opt/netmanager`. **Her adım çıktısı kaydedilir; ilk kırmızıda dur → §7 Rollback.**

### P0 — GO ön-koşulları (hepsi ✓ olmadan başlama)
- [ ] **cloudflared ingress** Cloudflare panelinde public hostname → **`localhost:80`** (`:8000`/`:3000` ise önce :80'e çevir). *(operatör panelden teyit)*
- [ ] **cloudflared token rotate** edildi (sızmış kabul).
- [ ] Staging provası YEŞİL (bu doc §0/üst — tamam).
- [ ] **Maintenance window** ilan edildi; **freeze** (yeni merge/push durdu); hedef SHA sabit = `2a80464`.

### P1 — Fresh backup + SHA (read-only DB; dosya yazar)
```bash
cd /opt/netmanager
TS=$(date -u +%Y%m%d_%H%M%S); OUT=backups/pre-deploy-${TS}.dump
docker exec -i netmanager-postgres-1 pg_dump -U netmgr -Fc -d network_manager > "$OUT"
sha256sum "$OUT" | tee backups/pre-deploy-${TS}.sha256
ls -lah "$OUT"          # boyut makul mü
```
- [ ] Dump alındı, **SHA-256 kaydedildi**, boyut ~13MB+ (prova dump'ı referans).

### P2 — Rollback anchor (deploy ÖNCESİ durumu dondur)
```bash
git rev-parse HEAD                                   # beklenen: 0dface5...
docker exec -i netmanager-postgres-1 psql -U netmgr -d network_manager -tAc "SELECT version_num FROM alembic_version;"  # f9aafirmware
docker inspect --format '{{.Name}} {{.Image}}' $(docker ps -q --filter name=netmanager)  # image digest'leri
```
- [ ] Anchor kaydı: git=`0dface5` · alembic=`f9aafirmware` · image digest'leri · dump yolu+SHA (P1). → tek "PRE-DEPLOY ANCHOR" notu.

### P3 — Disk headroom (build öncesi; %80 dolu, 9.3G boş)
```bash
df -h /opt/netmanager; docker system df
docker image prune -f          # dangling image'lar
docker builder prune -f        # ~1.98GB build cache
```
- [ ] Build için yeterli alan (reclaimable ~5.6GB temizlendi).

### P4 — Kod hedef SHA (naive pull DEĞİL — pinned + fast-forward)
```bash
git fetch origin
git merge --ff-only 2a80464     # FF değilse DURUR (diverjans guard); main → 2a80464
git rev-parse HEAD              # doğrula: 2a80464...
```
- [ ] HEAD = `2a80464` (FF temiz). Untracked `a`/`backups/` zararsız.

### P5 — Image build (frontend production)
```bash
docker compose build           # FRONTEND_TARGET default=production (dist+nginx)
```
- [ ] Build hatasız bitti (tsc+vite build geçer — staging'de kanıtlandı).

### P6 — Migration (3 additive — yeni image, up'tan ÖNCE)
> ⚠️ **B1c DÜZELTMESİ:** `docker compose run … alembic` KULLANMA. B1c yeni compose'u postgres/backend'i
> `internal` ağına koyar; ama `up` ÖNCESİ çalışan postgres hâlâ `netmanager_default`'ta. `compose run`
> one-off backend'i boş `internal`'a bağlar → `postgres` DNS çözülmez (migration bağlantı hatası) ya da
> dep'leri recreate etmeye kalkar (restart). Bunun yerine migration'ı **mevcut `netmanager_default`**
> ağında, yeni image + çalışan backend'in env'iyle koş (ağ topolojisi anahtarı zaten P7'de olur):
```bash
docker run --rm --network netmanager_default \
  --env-file <(docker inspect netmanager-backend-1 --format '{{range .Config.Env}}{{println .}}{{end}}') \
  netmanager-backend:latest \
  alembic upgrade head
# Beklenen TAM OLARAK: f9aafirmware→f9absecpol→f9acdevsecfk→f9adsecrls
docker exec netmanager-postgres-1 psql -U netmgr -d network_manager -tAc "SELECT version_num FROM alembic_version;"  # f9adsecrls
```
Ön-doğrula: `MIGRATION_DATABASE_URL` env'de **netmgr** (superuser) + `netmanager-backend:latest` = P5 yeni image.
- [ ] 3 migration koştu, `alembic current = f9adsecrls`, hata yok. *(migration `netmgr` superuser; up/restart/yeni-network YOK)*

### P7 — Servisleri kaldır (rolling recreate; down DEĞİL)
```bash
docker compose up -d
# nginx.conf değiştiyse (B1c): docker compose up -d --force-recreate nginx
docker compose ps             # tüm servis healthy
```
- [ ] Tüm container Up/healthy. B1c: yalnız nginx:80 publish (backend/pg/redis/flower artık expose-only).

### P8 — 11 SMOKE GATE (ilk kırmızıda dur → Rollback)
```bash
# host nginx :443 / container :80 üzerinden (operatör admin kimliğiyle)
curl -s -o /dev/null -w "1 /health/ready: %{http_code}\n" -k https://localhost/health/ready
# 2 login → token (operatör parolası):  POST /api/v1/auth/login
# 3 super-admin /api/v1/context/current → orgs/role
# 4 agent WS /api/v1/agents/ws/{id} → 5xx YOK (TD-2)
# 5 /api/v1/topology → org/loc-scoped
# 6 /api/v1/security-policies/switch → 200, seed (org×3)
# 7 /api/v1/devices → liste
# 8 /api/v1/ws/events valid token → 101
# 9 backend log: docker compose logs backend --since 5m | grep -iE "5xx|Traceback|OAuth2"  → BOŞ
# 10 RLS izolasyon: org-A kullanıcısı yalnız org-A görür
# 11 DB perm audit: docker compose exec backend python scripts/audit_db_permissions.py → PASS
```
- [ ] 11/11 yeşil. Dış erişim (cloudflared/host-nginx → :80) çalışıyor: `https://<domain>/login`.

### P9 — Rollback kriteri & prosedür
**Geri al:** migration ortada durdu / smoke kırmızı / dış erişim koptu / beklenmedik veri kaybı.
**Prosedür (DR_RUNBOOK §6):** yazan servisleri durdur → **pre-deploy dump restore** (downgrade tek başına yetmez) →
`git merge --ff-only`/`checkout 0dface5` → image rollback (anchor digest) → P8 gate'leri (1-3,9,10) yeşil + `alembic current=f9aafirmware`.

---

## Ek — referanslar
- `docs/DR_RUNBOOK.md` — §3 key escrow, §4 backup, §5 restore+doğrulama, §6 rollback anchor, §7 VPS hazard + §7.2 fresh bootstrap sırası + §7.3 nginx inode.
- `docs/M6_DEPLOY_LOG.md` — M6 (f8a5) geçmiş deploy notları.
- `backend/scripts/audit_db_permissions.py` — netmgr_app least-privilege audit (B2a).
- `backend/alembic/env.py` — `get_url()` (MIGRATION_DATABASE_URL önceliği), RLS notu.
