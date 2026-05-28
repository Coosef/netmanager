# NetManager — Disaster Recovery & Key Recovery Runbook

> Durum: **TASLAK (B3)** — gözden geçirilecek. Kod değişikliği yok; operasyonel prosedür.
> Kapsam: Fernet key kaybı, backup/restore, volume kurtarma, rollback, VPS deploy hazard,
> retention↔backup ilişkisi, severity seviyeleri.
> İlgili: `docs/T10_FAZ_B_HARDENING.md`, `docs/M6_DEPLOY_LOG.md`, `DEPLOY_CHECKLIST.md`,
> memory: vps-deploy-hazard.

---

## 0. Önce oku — temel gerçekler

| Bileşen | Nerede | DR önemi |
|---------|--------|----------|
| **DB (Postgres/TimescaleDB)** | docker volume `postgres_data` | **Taç mücevher** — tüm uygulama verisi. |
| **Fernet credential key** | `.env` → `CREDENTIAL_ENCRYPTION_KEY` (+ `_OLD`) | Kaybı → şifreli kolonlar geri DÖNÜLEMEZ. |
| **Device config backup'ları** | docker volume `config_backups` (+ DB `config_backups` tablosu) | Cihaz config metinleri; DB'den ayrı. |
| **Redis** | docker volume `redis_data` (AOF) | Cache + Celery kuyruğu + dedup. Çoğu **ephemeral** (yeniden üretilir). |
| **prom_multiproc** | tmpfs (RAM) | Metrik; **ephemeral**, kurtarma gerekmez. |
| **DB rolleri** | `netmgr` (superuser → restore/DDL), `netmgr_app` (runtime, DDL YOK) | Restore `netmgr` ile yapılır. |
| **pg_dump yedekleri** | `backups/` (gitignored) | Mantıksal DB yedeği. Örnek: `backups/pre-m6-production-deploy-*.sql.gz`. |

> **Uyarı:** `backups/` git'e dahil DEĞİL (gitignored). Yedekler ve key escrow repo dışında,
> ayrı/offline saklanmalı (aşağıda escrow).

---

## 1. Disaster Severity Seviyeleri

| Sev | Senaryo | Veri kaybı | Öneri RTO/RPO* | Ana aksiyon |
|-----|---------|------------|----------------|-------------|
| **S0** | Tam host/VPS kaybı | Olası tam | RTO 4–8h / RPO 24h (≤ son backup) | Yeni host + volume/backup restore + key restore |
| **S1** | Fernet key kaybı (DB sağlam) | Yalnız şifreli kolonlar | RTO <1h / RPO 0 (kullanıcı re-entry) | Key escrow'dan geri yükle; yoksa §2 matrisi |
| **S2** | DB (postgres) bozulması/kaybı (key sağlam) | DB içeriği | RTO 1–2h / RPO son backup | `pg_dump` restore veya volume snapshot |
| **S3** | Hatalı deploy / destructive migration | Migration'a bağlı | RTO <1h / RPO deploy-öncesi backup | §6 rollback + restore |
| **S4** | Yanlış retention/silme (A3) | Silinen eski veri | RTO <1h / RPO son backup | §8 retention↔backup; backup'tan restore |

\* **Öneri değerler — bağlayıcı SLA DEĞİL.** Kurumsal SLA belirlendiğinde revize edilir.
RPO "son backup"a bağlı olduğundan, otomatik backup aktif olana kadar (§4a) RPO **manuel
backup sıklığı** kadardır — yani şu an garanti edilmez.

---

## 2. Fernet Key Kaybı — "Ne kurtulur / ne kaybolur" matrisi

Şifreleme: `MultiFernet([Fernet(CREDENTIAL_ENCRYPTION_KEY), Fernet(CREDENTIAL_ENCRYPTION_KEY_OLD)])`
(`backend/app/core/security.py`). Primary key ile şifreler; her iki key ile çözer.
**Key (ve `_OLD`) kaybolursa `*_enc` kolonları MATEMATİKSEL OLARAK geri dönülemez.**

| Veri | Kolon | Key kaybında |
|------|-------|--------------|
| Cihaz SSH şifresi | `devices.ssh_password_enc` | ❌ Kayıp → cihaz cihaz **yeniden girilmeli** |
| Cihaz enable secret | `devices.enable_secret_enc` | ❌ Kayıp → yeniden gir |
| Credential profil sırları | `credential_profiles.ssh_password_enc / enable_secret_enc` | ❌ Kayıp → yeniden gir |
| AI API anahtarları | `ai_settings.{claude,openai,gemini}_api_key_enc` | ❌ Kayıp → sağlayıcıdan yeni key |
| Agent AES bundle | `agent_credential_bundle.agent_aes_key_enc` | ❌ Kayıp → agent **yeniden enroll** |
| Org PG rol şifresi | `organizations.pg_pass_enc` | ❌ Kayıp → rol şifresi reset |
| **Config / topoloji / metrik / event / incident / audit / IPAM / kullanıcı hesapları** | (şifresiz) | ✅ **Tam kurtulur** — Fernet'ten bağımsız |

**Sonuç:** Key kaybı = "tüm cihaz/erişim sırları yeniden girilir" operasyonu; envanter/geçmiş/topoloji korunur.
Etki sınırlı ama operasyonel olarak ağır → **key escrow zorunlu (§3).**

---

## 3. Key Escrow Prosedürü (önleyici — en kritik DR adımı)

**Amaç:** `CREDENTIAL_ENCRYPTION_KEY`'i DB ile aynı yerde tek kopya tutma.

**Araç-bağımsız** — tek ürüne bağlı prosedür yazma. Örnek araçlar: HashiCorp Vault,
1Password, Bitwarden Secrets, HSM/KMS. Hangisi seçilirse seçilsin şu 4 ilke zorunlu:
- **Dual-control:** key'e tek kişi tek başına erişememeli (en az iki onay / bölünmüş bilgi).
- **Offline copy:** en az bir kopya çevrimdışı/air-gapped (secret-manager komple kaybında
  son sığınak). Repo'ya, image'a, log'a, `.env`'in commit'lenen kopyasına ASLA yazma.
- **Rotation history:** her key sürümü (primary + emekliye ayrılan `_OLD`) tarih/sürümle
  saklanır — eski backup'lar eski key gerektirir (§3 rotation, backup↔key eşleşmesi).
- **Erişim audit'i:** key okuma/çıkarma olayları loglanır ve periyodik gözden geçirilir.
- **Rotation (MultiFernet ile, kesintisiz):**
  1. Yeni key üret: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
  2. Mevcut `CREDENTIAL_ENCRYPTION_KEY` → `.env`'de `CREDENTIAL_ENCRYPTION_KEY_OLD` olarak taşı.
  3. Yeni key → `CREDENTIAL_ENCRYPTION_KEY` (primary).
  4. Servisleri restart et → yeni yazımlar yeni key ile; eski veri `_OLD` ile çözülmeye devam.
  5. (Opsiyonel) Toplu re-encrypt: tüm `*_enc` değerlerini decrypt→encrypt ile yeniden yaz
     (bkz. `backend/app/core/encryption_migrations.py` / `scripts/rotate_credentials.py`),
     sonra `_OLD`'u kaldır.
- **Escrow doğrulama:** Yılda en az 1 kez "key'i escrow'dan getir, staging'de bir
  `*_enc` değeri decrypt et" tatbikatı.
- **Key ↔ backup eşleşmesi:** Her DB backup'ı, o an aktif key sürümüyle anlamlı. Backup'ı
  restore ederken o döneme ait key gerekir → **backup ve key sürümünü birlikte etiketle.**

---

## 4. Backup Prosedürü

> **⚠️ OTOMATİK BACKUP DURUMU: HENÜZ AKTİF DEĞİL.** Şu an yalnız **manuel** precedent var
> (`docs/M6_DEPLOY_LOG.md` deseni + `backups/pre-m6-...sql.gz`). Zamanlanmış/otomatik backup,
> offsite kopya ve restore doğrulama **kurulmadı**. Bu nedenle RPO garanti edilmez (§1).
>
> **Hedef durum (kurulacak):** cron veya systemd timer ile periyodik `pg_dump` → **offsite**
> kopya (S3/uzak host) + periyodik **restore doğrulama** tatbikatı. Aşağıdaki komut bu kurulana
> kadar elle çalıştırılmalı (özellikle her deploy öncesi — §6/§7).

### 4a. DB (mantıksal — pg_dump) — şu an MANUEL
```
# Konteyner içinden:
docker compose exec -T postgres pg_dump -U netmgr -d network_manager | gzip \
  > backups/db-$(date -u +%Y%m%dT%H%M%SZ).sql.gz
# SHA-256 ile bütünlük kaydı:
shasum -a 256 backups/db-*.sql.gz | tee -a backups/CHECKSUMS.txt
```
- `netmgr` (superuser) ile al → RLS/owner kısıtı olmadan tam dump.
- **Her deploy öncesi ZORUNLU** (bkz. §6, §7). Düzenli/otomatik versiyonu henüz yok (yukarı).

### 4b. Volume snapshot (fiziksel — alternatif)
```
docker run --rm -v switch_postgres_data:/data -v "$PWD/backups":/backup alpine \
  tar czf /backup/postgres_data-$(date -u +%Y%m%dT%H%M%SZ).tgz -C /data .
```
- config_backups volume'u için aynı kalıp (`switch_config_backups`).
- Volume snapshot, postgres DURDURULMUŞKEN tutarlıdır (canlıda pg_dump tercih).

### 4c. Key
- §3 escrow. Backup ile aynı kasaya DEĞİL, ayrı sakla (ikisi birden sızmasın).

---

## 5. Restore Prosedürü + Doğrulama

### 5a. pg_dump restore (mantıksal)
```
# 1. Bağımlı servisleri durdur (yazımı kes):
docker compose stop backend celery_worker celery_agent_worker \
  celery_default_worker celery_beat event_consumer flower
# 2. (Gerekirse) temiz şema: dikkatli — mevcut veriyi siler!
#    Tercihen boş/yeni DB'ye restore edip doğrula, sonra cut-over.
gunzip -c backups/db-<UTC>.sql.gz | \
  docker compose exec -T postgres psql -U netmgr -d network_manager
# 3. Servisleri başlat:
docker compose up -d
```
### 5b. Restore doğrulama (zorunlu)
- `docker compose exec -T postgres psql -U netmgr -d network_manager -c "\dt" | wc -l` → tablo sayısı beklenen.
- Row sanity: `SELECT count(*) FROM devices; SELECT count(*) FROM organizations;`
- `alembic current` → head ile uyumlu (şema sürümü doğru).
- `curl localhost/health/ready` (nginx) → 200, db/redis/timescaledb ok.
- **Key teyidi:** bir cihazın `ssh_password_enc`'i decrypt ediliyor mu (uygulamadan bir SSH testi
  veya `decrypt_credential_safe`). Decrypt patlıyorsa → backup/key sürümü uyuşmuyor (§3).
- TimescaleDB: `SELECT count(*) FROM timescaledb_information.hypertables;` → 5 bekleniyor.

---

## 6. Rollback Anchor / SHA / Image Rollback

> Precedent: `docs/M6_DEPLOY_LOG.md` — gerçek destructive deploy + rollback.

**Her riskli deploy ÖNCESİ kaydet (rollback anchor):**
- `git rev-parse HEAD` → son green commit SHA (rollback hedefi).
- Aktif image digest'leri: `docker compose images` (geri dönülecek tag/digest).
- `alembic current` → mevcut migration head.
- §4a `pg_dump` + SHA-256.

**Rollback (son çare — M6 deseninden):**
```
# 1. Yazan servisleri durdur:
docker compose stop backend celery_worker celery_agent_worker \
  celery_default_worker celery_beat event_consumer
# 2. Migration geri al (HEDEF = deploy öncesi revision; destructive ise downgrade
#    şemayı boş kurar → mutlaka backup restore ile birlikte):
docker compose exec -T backend alembic downgrade <pre-deploy-revision>
# 3. Pre-deploy pg_dump'ı restore et (§5a) — downgrade tek başına veriyi getirmez!
# 4. Koda dön:
git checkout <pre-deploy-SHA>
# 5. Image rollback (kod/deps değiştiyse): önceki tag'e dön veya --build ile yeniden kur:
docker compose build backend && docker compose up -d
```
- **Kritik:** destructive migration downgrade'i "boş şema recreate" yapar; **backup restore
  edilmeden** çalıştırılırsa veri kaybı kalıcılaşır (M6_DEPLOY_LOG uyarısı).

---

## 7. VPS Deploy Hazard ⚠️

> memory: vps-deploy-hazard. **Bu repo'da deploy = manuel ve riskli; naive `git pull` TEHLİKELİ.**

- VPS şeması main'den **geride** olabilir. `main` artık T10 A+B'nin tamamını içeriyor; ayrıca
  zincirde **destructive M6** (`f8a5_drop_legacy_tenant` — `tenants`/`tenant_id`/`users.role` düşürür) var.
- **Asla** doğrudan `git pull && alembic upgrade head` yapma. Sıra:
  1. §4a `pg_dump` (zorunlu) + SHA + §6 anchor.
  2. `alembic current` (VPS) vs `alembic heads` (yeni kod) farkını ÇIKAR — hangi revision'lar
     uygulanacak, destructive var mı (özellikle `f8a5`) belirle.
  3. Bayat image uyarısı: local/VPS image bağımlılıkları eskimiş olabilir (örn. `pyotp`
     eksikti) → deploy'da `docker compose build` ile **yeniden kur**.
  4. Staging/yedek üzerinde migration dry-run; sonra cut-over.
  5. `docker-compose.dev.yml` VPS'te KULLANILMAZ (debug portları açar) — yalnız base compose.
- B1a/B1b sonrası: VPS'te dışarı açık tek port **nginx 80** olmalı; firewall ile 5432/6379/8000/5555
  zaten kapalı tutulmalı (compose hardening firewall'ın yerine geçmez).

### 7.1 Schema Drift / Image Drift ⚠️ (yaşanan gerçek incident)
**Olan:** VPS şeması ESKİ + image YENİ + alembic zinciri FARKLI → runtime **crash loop**
(örn. yeni kod `pyotp` import ediyor ama eski image'da yok; ya da kod yeni şema kolonu
bekliyor ama migration VPS'te uygulanmamış). Tek başına git SHA bu durumu yakalamaz.

**Kural — deploy state'i ÜÇ boyutla snapshot'lanır, sadece git SHA YETERSİZ:**
1. **Kod:** `git rev-parse HEAD`.
2. **Şema:** `alembic current` (uygulanan revision). Deploy öncesi `alembic current` (VPS) vs
   `alembic heads` (yeni kod) **diff'i ZORUNLU** — hangi migration'lar uygulanacak, destructive
   var mı (§7 `f8a5`) belirlenir. Sürpriz migration ile deploy etme.
3. **Image:** `docker compose images` (digest/tag). Kod/deps değiştiyse **`docker compose build`
   ile yeniden kur** — `restart`/`up` mevcut (bayat) image'ı yeniden kullanır.

**Cached image riski:** `docker compose up -d` var olan image'ı bağımlılıklar değişse bile
**yeniden build ETMEZ**. requirements/Dockerfile değiştiyse `--build` (veya `build` + `up`)
şart; aksi halde "kod yeni, image eski" drift'i → import/runtime crash. (B1a doğrulamasında
local image'ın `pyotp`'siz bayat olması tam bu drift'ti.)

**Deploy-öncesi drift checklist (zorunlu):**
- [ ] `git rev-parse HEAD` kaydedildi (rollback SHA).
- [ ] `alembic current` (hedef) vs `alembic heads` (kod) diff alındı; destructive migration işaretlendi.
- [ ] requirements/Dockerfile değişti mi → değiştiyse `docker compose build` planlandı.
- [ ] §4a pg_dump + SHA alındı.
- [ ] Restart değil, image gerekiyorsa rebuild ile deploy.

### 7.2 Fresh DB bootstrap sırası (B2b sonrası) ⚠️
**T10 B2b:** runtime startup'ta DDL **varsayılan KAPALI** (`BOOTSTRAP_SCHEMA` yok = OFF).
Mevcut DB'de etkisiz (create_all zaten no-op). **Boş/yeni DB'de** doğru sıra:
1. **`BOOTSTRAP_SCHEMA=1`** ile ilk start (veya eşdeğer `create_all`) → tüm tablolar + hypertable.
2. **`alembic upgrade head`** → netmgr_app grant'ları (`f7a5`) + RLS policy'leri (`f7a4`) + retention.
> **`alembic upgrade head` TEK BAŞINA boş DB'yi KURAMAZ** — zincirde var olmayan tabloya `ALTER`
> var (örn. `agent_credential_bundles` DROP CONSTRAINT). Önce create_all, sonra alembic.
- Fresh + OFF + bootstrap yapılmadan: tablo yok → seeding `users` bulamaz → **startup fail**
  (beklenen; "önce bootstrap et" sinyali). B2b doğrulamasında bu davranış gözlendi.
- `docker-compose.dev.yml` local fresh dev için `BOOTSTRAP_SCHEMA=1` taşır; prod base'de YOK.

### 7.3 nginx tek-dosya bind-mount inode footgun
`nginx.conf` konteynere **tek dosya** olarak mount'lu (`./nginx/nginx.conf:...default.conf`).
Host'ta dosyayı bir editör **yeniden yazarsa inode değişir** → konteynerdeki mount eski inode'a
bakar; çalışan nginx eski config'le devam eder ama `nginx -t` "no such file" verir → healthcheck
**unhealthy** (işlevsel değil, kozmetik ama yanıltıcı). **Çözüm:** config değişince `docker compose
restart nginx` YETMEYEBİLİR; **`docker compose up -d --force-recreate nginx`** ile mount'u tazele.
Deploy'da nginx.conf değiştiyse nginx'i **recreate et** (sadece restart değil).

---

## 8. Retention (A3) ↔ Backup İlişkisi

- A3 retention task'ı (`cleanup_old_data`) **org bazlı** eski veriyi siler: etkili gün =
  `clamp(system_settings, org.max_retention_days tavan, RETENTION_FLOOR_DAYS=7 taban)`.
- **Backup, retention'dan ÖNCEKİ durumu korur.** Retention bir veriyi sildikten sonra onu geri
  istemenin tek yolu, o veriyi içeren bir **backup'tan restore**'dur.
- Restore sonrası dikkat: bir sonraki `cleanup_old_data` çalışması, restore edilen eski veriyi
  retention penceresi dışındaysa **tekrar siler** → restore sonrası gerekiyorsa ilgili org'un
  retention'ını geçici yükselt veya veriyi ayrı export et.
- **Yanlış silme önleme:** retention değişikliğinden önce `GET /system-settings/retention-preview`
  (dry-run) ile "ne silinecek" gör; `RETENTION_FLOOR_DAYS` son N günü her zaman korur.
- Hypertable retention (snmp/syslog/availability/probe) TimescaleDB chunk-drop ile **global**;
  pg_dump bunları da içerir.

---

## 9. Volume Kurtarma Notları

> 🔴 **SEVERITY-HIGH FOOTGUN — `docker compose down -v`**
> `-v` (veya `--volumes`) **TÜM volume'ları SİLER** → `postgres_data` dahil = **kalıcı veri imhası**,
> backup yoksa geri dönüş YOK. Production/VPS'te `down -v` **ASLA** çalıştırma. Servisi durdurmak
> için `docker compose stop` veya `docker compose down` (volume'a dokunmaz) kullan. `-v` yalnız
> bilerek, boş/atılabilir bir local dev ortamında.

- Volume adları compose project prefix'li: `switch_postgres_data`, `switch_redis_data`,
  `switch_config_backups`. `docker volume ls | grep switch`.
- `docker compose down` volume'ları **silmez** (sadece konteyner/ağ kaldırır). Veri korunur.
- postgres_data bozulursa: yeni volume + §5a pg_dump restore (tercih) veya §4b tgz snapshot'tan
  `tar xzf` ile geri yükle (postgres durdurulmuşken).
- redis_data kaybı: tolere edilebilir — cache/dedup yeniden üretilir; Celery'de uçan task'lar
  kaybolabilir (beat yeniden zamanlar). AOF açık (`--appendonly yes`).
- config_backups volume kaybı: cihaz config geçmişi kaybolur ama DB `config_backups` tablosu
  (pg_dump kapsamında) metadata/golden referansları tutar; cihazlardan yeniden çekilebilir.

---

## 10. Hızlı Karar Akışı (severity → aksiyon)
1. **Sır mı, veri mi gitti?** Sır (key) → §2 matris + §3 escrow restore. Veri (DB) → §5 restore.
2. **Deploy mi bozdu?** → §6 rollback (backup restore ŞART) + §7 hazard.
3. **Yanlış silme/retention?** → §8 + en yakın backup restore.
4. **Tam host kaybı (S0)?** → yeni host + volume/backup restore + key escrow restore + §5b doğrulama.
5. Her durumda: önce **§4a pg_dump al** (durum kötüleşmeden mevcut hâli dondur), sonra müdahale.

---

## 11. Break-Glass Admin Access (auth/SSO tamamen bozulduğunda)

**Ne zaman:** Hiçbir admin uygulamadan giriş yapamıyor (SSO/auth çökmüş, MFA kilidi, tüm
admin hesapları kilitli/pasif). Amaç: app RBAC'ı **DB seviyesinden** geçici olarak aşıp erişimi
geri kazanmak. **Son çare** — normal akış denenmeden kullanılmaz.

**Önkoşul (erişim kontrolü):** local/konteyner postgres'e `netmgr` (superuser, RLS bypass) ile
erişim. Bu erişimin kendisi kısıtlı/dual-control olmalı (host SSH + DB superuser şifresi).

**Prosedür:**
```
# 1. Mevcut durumu DONDUR — önce §4a pg_dump al.
# 2. DB'ye superuser ile bağlan:
docker compose exec -T postgres psql -U netmgr -d network_manager
# 3. Bilinen bir hesabı geçici super_admin + aktif yap:
#    UPDATE users SET system_role='super_admin', is_active=true WHERE username='<admin>';
# 4. Geçici şifre ata (bcrypt hash app fonksiyonuyla üretilir — düz şifre DB'ye yazılmaz):
docker compose exec -T backend python -c \
  "from app.core.security import hash_password; print(hash_password('<GECICI_GUCLU_SIFRE>'))"
#    Sonra psql'de:
#    UPDATE users SET hashed_password='<uretilen_hash>' WHERE username='<admin>';
# 5. MFA giriş yolunu tıkıyorsa geçici devre dışı bırak (sonra yeniden enroll):
#    UPDATE users SET mfa_enabled=false, mfa_totp_secret=NULL, mfa_pending_secret=NULL,
#                     mfa_methods=NULL WHERE username='<admin>';
# 6. (Gerekirse) aktif oturumları iptal et — T8.4 session revoke:
#    UPDATE user_sessions SET revoked_at=now() WHERE revoked_at IS NULL;
```
**Audit notu:** Bu işlem app RBAC'ını ve `audit_logs` hook'unu **bypass eder** — doğrudan SQL
audit_log üretmez. Kim/ne zaman/neden bilgisini **out-of-band** bir incident kaydına geç (DB
audit'i bu değişikliği yakalamayabilir).

**İşlem SONRASI ZORUNLU (rotate/reset):**
- [ ] Geçici şifreyi giriş yapar yapmaz **değiştir**; geçici hesap promotion'unu geri al
      (gereksiz super_admin bırakma).
- [ ] MFA'yı **yeniden enroll** et (devre dışı bırakıldıysa).
- [ ] Break-glass sırasında değişen her şeyi gözden geçir (system_role/şifre/session).
- [ ] Bu yol geniş kullanıldıysa **`netmgr` DB superuser şifresini ve gerekiyorsa
      `CREDENTIAL_ENCRYPTION_KEY`'i rotate et** (§3).
- [ ] Incident kaydını kapat: kök neden (auth/SSO neden bozuldu) + kalıcı düzeltme.

---

## Açık sorular / sonraki adımlar (taslak)
- **Otomatik DB backup (AÇIK — henüz aktif değil):** cron/systemd timer + offsite kopya +
  restore doğrulama kurulacak. Şu an yalnız manuel precedent (§4a). Ayrı görev.
- **RTO/RPO:** §1'deki değerler **öneri**; kurumsal SLA belirlenince bağlayıcı hâle getirilir.
- **Key escrow aracı:** araç-bağımsız prosedür (§3) yeterli; somut ürün seçimi (Vault/1Password/
  Bitwarden Secrets/HSM) ops kararı.
- **Restore doğrulama otomasyonu (B3 OPSİYONEL SONRAKİ MİNİ-TASK — şimdi kodlanmayacak):**
  `audit_db_permissions.py` benzeri bir script ile restore sonrası otomatik smoke:
  `alembic current==head` · `/health/ready` 200 · tablo/row sanity · **sample credential
  decrypt** (key↔backup uyumu). Ayrı mini-task olarak ele alınacak.
