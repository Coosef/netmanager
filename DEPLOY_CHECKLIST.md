# Production Deploy Checklist

> NetManager — Faz 5B sonrası üretim ortamı prosedürleri  
> Güncellendi: 2026-05-13

Bu döküman; ilk kurulum, güncellemeler ve acil rollback senaryoları için adım adım prosedürleri kapsar.

---

## 1 — Ön Deploy Kontrolleri

Tüm adımlar tamamlanmadan `docker compose up` çalıştırılmamalıdır.

```bash
# 1. Test süiti tümüyle geçmeli (236/236)
cd backend && python -m pytest tests/ -q
# Beklenen: 236 passed in X.XXs

# 2. TypeScript sıfır hata
cd frontend && npm run type-check
# Beklenen: çıktı yok (hata yoksa 0 exit code)

# 3. Frontend build temiz
npm run build
# Beklenen: dist/ oluşur, uyarı yok

# 4. .env dosyası kontrol — zorunlu değerler
grep -E "^(SECRET_KEY|DB_URL|REDIS_URL|ALLOWED_ORIGINS)" .env
# SECRET_KEY en az 32 karakter olmalı

# 5. Docker image build
docker compose build --no-cache
# Her iki servis de başarıyla build olmalı
```

---

## 2 — Veritabanı Migration

**Faz 5A itibarıyla Alembic aktif** — `backend/alembic/` altında 3 revision zinciri kurulu.

### 2A — Mevcut DB (Production Upgrade)

```bash
# 1. Deploy öncesi schema snapshot al
docker exec switch-postgres-1 pg_dump -U netmgr -d network_manager \
  --schema-only -f /tmp/schema_before_$(date +%Y%m%d).sql

# 2. Alembic mevcut revision kontrolü (eğer DB zaten stamp edilmişse)
docker exec -w /app switch-backend-1 alembic current
# Beklenen: c3d4e5f6a7b8 (head) — zaten güncel
# Eğer baseline (2b6c64e3a91e) ise:
docker exec -w /app switch-backend-1 alembic upgrade head
# 3 revision uygulanır: reconcile_baseline_indexes + cleanup_duplicate_indexes

# 3. Hiç stamp edilmemişse (ilk Alembic kurulumu mevcut DB'de):
docker exec -w /app switch-backend-1 alembic stamp 2b6c64e3a91e  # baseline
docker exec -w /app switch-backend-1 alembic upgrade head          # 2 revision uygular
```

### 2B — Temiz / Yeni DB Kurulumu

```bash
# Yeni ortamda tablolar main.py lifespan create_all() ile oluşur.
# Sonrasında DB'yi head'e işaretle:
docker exec -w /app switch-backend-1 alembic stamp head
# c3d4e5f6a7b8 (head) görünmeli — migration çalıştırmaya gerek yok
```

### 2C — Rollback (Migration Geri Alma)

```bash
# Bir adım geri: cleanup_duplicate_indexes öncesine
docker exec -w /app switch-backend-1 alembic downgrade -1

# Baseline'a tam geri dön (tüm index operasyonlarını sıfırla):
docker exec -w /app switch-backend-1 alembic downgrade base

# Tekrar upgrade:
docker exec -w /app switch-backend-1 alembic upgrade head
```

### 2D — Bilinen Kabul Edilmiş Farklar (`alembic check`)

`alembic check` şu anda 2 tip gürültü üretir — ikisi de kasıtlı ertelendi:

| Diff türü | Tablo/kolon | Neden ertelendi |
|-----------|-------------|-----------------|
| `modify_default` | ~40 kolon | server_default cosmetic fark, functional etkisi yok |
| `modify_type` JSONB→JSON | `audit_logs`, `devices`, `discovery_results` | table rewrite riski var |

```bash
# Doğrulama: sadece modify_default ve modify_type kalmalı, add/remove_index sıfır
docker exec -w /app switch-backend-1 alembic check 2>&1 | grep -c "add_index\|remove_index"
# Beklenen: 0

# TimescaleDB hypertable kontrol
docker exec switch-postgres-1 psql -U netmgr -d network_manager \
  -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
# 5 tablo listelenmeli
```

---

## 3 — Deploy Adımları

### 3A — Sıfır Kesinti için Önerilen Sıra

```bash
# 1. Backend yeniden başlat (migration + yeni endpoint'ler)
docker compose up -d --no-deps backend

# 2. Backend sağlık kontrolü (30s bekle)
sleep 10
curl -s http://localhost:8000/health | python3 -m json.tool
# {"status": "ok"} beklenir

# 3. Celery worker yeniden başlat (yeni task'lar)
docker compose up -d --no-deps celery_worker celery_beat

# 4. Frontend yeniden başlat
docker compose up -d --no-deps frontend

# 5. Nginx yeniden yükle (config değişikliği varsa)
docker compose exec nginx nginx -s reload
```

### 3B — Tam Yeniden Başlatma (bakım penceresi gerektirir)

```bash
docker compose down
docker compose up -d
docker compose logs -f --tail=50
```

---

## 4 — Deploy Sonrası Doğrulama

```bash
# API sağlık
curl -s http://localhost:8000/api/v1/monitor/stats | python3 -m json.tool \
  | grep -E "fleet_experience|fleet_availability"

# Escalation kuralları endpoint
curl -s -H "Authorization: Bearer <token>" \
  http://localhost:8000/api/v1/escalation-rules | python3 -m json.tool

# Celery task kontrol (son 5 dakika içinde çalışmış mı)
docker exec switch-celery_worker-1 celery -A app.workers.celery_app inspect active

# TimescaleDB sorgu performansı (örnek)
docker exec switch-postgres-1 psql -U netmgr -d network_manager \
  -c "EXPLAIN ANALYZE SELECT * FROM device_availability_snapshots \
      WHERE device_id=1 AND ts > NOW() - INTERVAL '30 days';"
# "Custom Scan (ChunkAppend)" görünmeli

# Frontend erişim
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
# 200 beklenir
```

---

## 5 — Backup & Restore (Faz 5B)

Otomasyon scriptleri: `scripts/` dizininde 3 dosya.

| Script | Amaç |
|--------|------|
| `netmanager-backup.sh` | TimescaleDB uyumlu tam yedek (pg custom format, compress=6) |
| `netmanager-restore.sh` | `timescaledb_pre_restore` / `timescaledb_post_restore` ile güvenli restore |
| `netmanager-backup-test.sh` | Geçici DB'ye dry-run restore, doğrulama, otomatik temizlik |

### 5A — Otomatik Tam Yedek

```bash
# Varsayılan: ./backups/YYYYMMDD_HHMMSS/ altına yazar, 7 gün saklar
cd /path/to/switch
./scripts/netmanager-backup.sh

# Özel dizin / saklama süresi
BACKUP_DIR=/mnt/nas/netmanager-backups KEEP_DAYS=30 ./scripts/netmanager-backup.sh

# Çıktı dosyaları:
#   db.dump              — pg custom format (sıkıştırılmış, ~10MB)
#   schema.sql           — sadece şema, insan okunabilir
#   alembic_revision.txt — yedek anındaki Alembic revision
#   manifest.json        — metadata (timestamp, tablo sayısı, DB boyutu)
#   restore_catalog.txt  — pg_restore --list çıktısı (integrity kanıtı)
```

**Bütünlük kontrolü:** Script, `pg_restore --list` çıktısında `< 50` TABLE DATA varsa otomatik hata verir.

### 5B — Yedekten Restore (Production)

```bash
# 1. Uygulama servislerini durdur
docker compose stop backend celery_worker celery_beat

# 2. Restore (onay sorar — production DB'ye yazıyor, dikkatli!)
TARGET_DB=network_manager_restore \
  ./scripts/netmanager-restore.sh ./backups/20260513_164326

# Onayı atlamak için (CI / otomatik senaryo):
SKIP_CONFIRM=yes TARGET_DB=network_manager_restore \
  ./scripts/netmanager-restore.sh ./backups/20260513_164326

# 3. Geçiş (emin olunca)
# .env → DB_URL'yi network_manager_restore'a çevir
docker compose up -d backend celery_worker celery_beat

# 4. Alembic stamp (restore sonrası head'i işaretle)
docker exec -w /app switch-backend-1 alembic current
# c3d4e5f6a7b8 (head) görünmeli — görünmüyorsa:
docker exec -w /app switch-backend-1 alembic stamp head
```

**TimescaleDB notu:** Restore script `timescaledb_pre_restore()` ve `timescaledb_post_restore()` çağrılarını otomatik yapar. Manuel pg_restore kullanıyorsanız bu çağrıları elle yapın.

### 5C — Yedek Bütünlük Testi (Dry-Run)

```bash
# En son yedeği geçici DB'ye restore et, doğrula, sil:
./scripts/netmanager-backup-test.sh

# Belirli yedeği test et:
./scripts/netmanager-backup-test.sh ./backups/20260513_164326

# Başarılı çıktı:
# [PASS] Table count: 59
# [PASS] Hypertables: 5 (agent_peer_latencies, device_availability_snapshots, ...)
# [PASS] Core table counts OK
# [PASS] Alembic revision: c3d4e5f6a7b8
# [PASS] TimescaleDB version: 2.26.3
```

**CI entegrasyonu:** `netmanager-backup-test.sh` sıfır exit code ile çıkarsa yedek geçerlidir. Başarısız olursa geçici DB otomatik silinir, exit 1 döner.

### 5D — TimescaleDB Retention + Yedek Çakışması

TimescaleDB retention policy varsayılan olarak **30 gün** veri tutar. Backup script son yedekten bu yana 30 günden fazla zaman geçmişse uyarı verir:

```
WARNING: last backup was X days ago — TimescaleDB retention (30d) may have
         deleted data not captured in any backup.
```

| Backup sıklığı | Retention penceresi | Veri kaybı riski |
|----------------|---------------------|------------------|
| Günlük | 30 gün | Yok |
| Haftalık | 30 gün | Haftalık — retention ile çakışmaz |
| 30 gün+ arası | 30 gün | ⚠️ Bazı hypertable verileri backup'a alınmadan silinebilir |

**Öneri:** Production'da `cron` ile günlük veya haftalık backup.

```bash
# Crontab (haftalık, Pazar 02:00)
0 2 * * 0 cd /path/to/switch && BACKUP_DIR=/mnt/backups KEEP_DAYS=30 ./scripts/netmanager-backup.sh >> /var/log/netmanager-backup.log 2>&1
```

### 5E — Volume Backup (İkincil)

PostgreSQL verisi `postgres_data` named volume'ündedir. DB dump'a ek olarak, volume snapshot alınabilir:

```bash
# Volume tar snapshot (container durdurulmuş halde — veri tutarlılığı için)
docker compose stop postgres
docker run --rm \
  -v switch_postgres_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/postgres_volume_$(date +%Y%m%d).tar.gz -C /data .
docker compose start postgres
```

Bu ikincil yöntemdir. Birincil yöntem her zaman `netmanager-backup.sh` (pg_dump tabanlı).

---

## 6 — Rollback Prosedürü

> **Rollback öncesi zorunlu adım:** Deploy öncesi her zaman bir yedek alın.
> ```bash
> ./scripts/netmanager-backup.sh   # yedek ./backups/YYYYMMDD_HHMMSS/ altına yazılır
> ```

### 6A — Hızlı Rollback (image tag ile)

```bash
# 0. Deploy öncesi yedek alındığından emin ol (yukarıdaki zorunlu adım)

# 1. Önceki başarılı image tag'ini bul
docker images | grep switch-backend | head -5

# 2. Backend'i önceki image ile başlat
docker compose stop backend
docker tag switch-backend:previous switch-backend:current
docker compose up -d backend

# 3. Doğrula
curl -s http://localhost:8000/health
```

### 6B — Git ile Rollback

```bash
# Son başarılı commit'i bul
git log --oneline -10

# Önceki sürüme dön
git checkout <commit-hash>

# Yeniden build + deploy
docker compose build --no-cache backend
docker compose up -d backend
```

### 6C — Kısmi Rollback (sadece migration)

```bash
# Yeni tablolar oluşturulduysa kaldır (üretimde dikkatli kullan)
docker exec switch-postgres-1 psql -U netmgr -d network_manager \
  -c "DROP TABLE IF EXISTS escalation_notification_logs, escalation_rules CASCADE;"

# main.py'deki migration bloğu idempotent — sonraki başlatmada yeniden oluşturur
```

---

## 7 — Gözlemlenebilirlik Kontrol Noktaları

### Hızlı Durum Özeti

```bash
# Tüm container sağlık durumu
docker compose ps

# Son hata logları
docker compose logs --since=10m backend | grep -i "error\|exception\|traceback"

# Celery beat schedule doğrulama
docker compose logs --since=5m celery_beat | grep -i "escalation\|peer_latency\|availability"

# Redis bağlantısı
docker exec switch-redis-1 redis-cli ping
# PONG beklenir

# TimescaleDB bağlantısı + extension
docker exec switch-postgres-1 psql -U netmgr -d network_manager \
  -c "SELECT extversion FROM pg_extension WHERE extname='timescaledb';"
```

### Kritik Metrikler (İzlenecekler)

| Metrik | Kontrol Yöntemi | Eşik |
|--------|----------------|------|
| Backend yanıt süresi | `curl -w "%{time_total}" http://localhost:8000/health` | < 200ms |
| DB bağlantı havuzu | `docker logs backend \| grep "pool"` | Dolu değil |
| Celery kuyruk derinliği | `docker exec celery_worker celery inspect active` | < 50 task |
| Redis bellek | `docker exec redis redis-cli info memory \| grep used_memory_human` | < 500MB |
| TimescaleDB chunk boyutu | `psql -c "SELECT * FROM chunk_detailed_size ORDER BY total_bytes DESC LIMIT 5;"` | < 10GB |

---

## 8 — Ortam Değişkenleri (Zorunlu)

```bash
# Backend zorunlu
SECRET_KEY=          # min 32 karakter, rastgele
DB_URL=              # postgresql+asyncpg://user:pass@host:5432/db
REDIS_URL=           # redis://host:6379/0
ALLOWED_ORIGINS=     # https://your-domain.com

# Backend opsiyonel (varsayılan değerler var)
CELERY_BROKER_URL=   # varsayılan REDIS_URL ile aynı
LOG_LEVEL=           # INFO (prod) / DEBUG (dev)

# TimescaleDB (Faz 4B)
# DB_URL'de TimescaleDB'ye işaret etmeli — plain PostgreSQL değil
```

---

## 9 — Bilinen Sorunlar & Geçici Çözümler

| Sorun | Çözüm |
|-------|-------|
| `__pycache__` sorunu: container restart loop, eski `.pyc` | `find backend -name "__pycache__" -type d \| xargs rm -rf` + restart |
| Celery Beat duplicate task (restart sonrası) | `docker compose restart celery_beat` — beat state temizlenir |
| TimescaleDB ilk başlatmada yavaş | Extension yüklenmesi 30–60s sürebilir; health check'e bekleme ekle |
| `webhook_headers` plaintext (KL-10) | Faz 5'e kadar: webhook URL + header değerlerini `.env`'de tutmayın, DB'de saklayın |

---

## 10 — Migration Review Checklist (Zorunlu)

Her PR'da schema değişikliği varsa aşağıdaki liste tamamlanmadan merge edilmez.

### PR Açmadan Önce

```bash
# 1. Revision üret (autogenerate veya manuel)
cd backend && alembic revision --autogenerate -m "kısa_açıklama"
# VEYA manuel:
alembic revision -m "kısa_açıklama"

# 2. Üretilen dosyayı incele — sadece beklenen değişiklikler olmalı
#    server_default ve JSONB→JSON noise'u kaldır (bilinen kabul edilmiş farklar)
cat alembic/versions/<yeni_revision>.py

# 3. Offline SQL üret — DDL mantıklı görünmeli
alembic upgrade head --sql 2>&1 | grep -E "^(CREATE|DROP|ALTER)"

# 4. Temiz ortamda round-trip test
alembic downgrade -1 && alembic upgrade head
alembic check 2>&1 | grep -c "add_index\|remove_index"
# Beklenen: 0

# 5. Test suite geçmeli
python -m pytest tests/ -q
```

### PR Checklist (Review Sırasında)

- [ ] Revision dosyası `backend/alembic/versions/` altında commit edilmiş
- [ ] `main.py` lifespan'a yeni ALTER TABLE / CREATE INDEX eklenmemiş
- [ ] `downgrade()` doğru ve test edilmiş
- [ ] `if_exists=True` (drop_index) / `IF EXISTS` SQL (drop_constraint) kullanılmış
- [ ] İndex isimleri Alembic convention: `ix_{tablo}_{kolon}` formatında
- [ ] Composite/partial index varsa modele `Index(...)` eklenmiş (autogenerate sessiz kalmalı)
- [ ] `alembic check` → `add_index` / `remove_index` sayısı 0

---

## 11 — Staging → Production Migration Dry-Run Prosedürü

### Adım 1 — Staging'de Uygula

```bash
# Staging ortamını production DB dump ile besle
pg_restore -U netmgr -d network_manager_staging /backup/latest.dump

# Alembic state'ini staging'e kopyala
docker exec -w /app switch-staging-backend-1 alembic current
# Beklenen: production ile aynı revision

# Yeni revisionları staging'de çalıştır
docker exec -w /app switch-staging-backend-1 alembic upgrade head
```

### Adım 2 — Staging Doğrulama

```bash
# index diff sıfır olmalı
docker exec -w /app switch-staging-backend-1 alembic check 2>&1 \
  | grep -c "add_index\|remove_index"

# Backend sağlık
curl -s http://staging:8000/health

# Test suite staging DB'ye karşı
docker exec -w /app switch-staging-backend-1 python -m pytest tests/ -q

# Kritik sorgu planları (yeni index var mı, seq scan yok mu)
docker exec switch-staging-postgres-1 psql -U netmgr -d network_manager_staging \
  -c "EXPLAIN ANALYZE SELECT * FROM network_events WHERE acknowledged=FALSE ORDER BY created_at DESC LIMIT 50;"
# Index Scan beklenir, Seq Scan değil
```

### Adım 3 — Production Uygulaması

```bash
# 1. Bakım moduna al (opsiyonel — zero-downtime için atlanabilir)
# 2. Schema snapshot al
docker exec switch-postgres-1 pg_dump -U netmgr -d network_manager \
  --schema-only -f /backup/pre_migration_$(date +%Y%m%d_%H%M).sql

# 3. Migration uygula
docker exec -w /app switch-backend-1 alembic upgrade head

# 4. Doğrula
docker exec -w /app switch-backend-1 alembic current
# c3d4e5f6a7b8 (head) — veya yeni head revision

# 5. Rollback gerekirse
docker exec -w /app switch-backend-1 alembic downgrade -1
```

### Rollback Kararı

| Semptom | Aksiyon |
|---------|---------|
| `alembic upgrade` hata fırlattı | `alembic downgrade -1` → root cause araştır |
| Backend /health başarısız | `alembic downgrade base` → schema snapshot'tan restore |
| Sorgu planları kötüleşti | Yeni index DROP et, eski index RE-CREATE |
| Test suite failure | Downgrade → fix → yeni revision → re-deploy |

---

## 12 — Açık Maddeler (KL Tablosu)

| ID | Açıklama | Planlanan Çözüm |
|----|----------|----------------|
| KL-1 | `main.py` ALTER TABLE — Alembic yok | ✅ Faz 5A — kapatıldı |
| KL-2 | Backup/restore TimescaleDB uyumluluğu | ✅ Faz 5B — kapatıldı |
| KL-8 | SyntheticProbe.runNow agent gerektiriyor | Faz 5 — local fallback |
| KL-10 | `webhook_headers` plaintext JSON | Faz 5D — EncryptedJSON TypeDecorator |
| KL-11 | Escalation evaluator min tepki 5 dk | Faz 5 — konfigüre edilebilir interval |
