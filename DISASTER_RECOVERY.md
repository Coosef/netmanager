# NetManager — Disaster Recovery Runbook

> Son güncelleme: 2026-05-14  
> Platform: FastAPI · Celery · Redis · TimescaleDB · Docker

---

## Hızlı Referans — RTO / RPO

| Senaryo | RTO | RPO | Notlar |
|---------|-----|-----|--------|
| Backend yeniden başlatma | < 2 dk | 0 | `restart: unless-stopped` otomatik |
| Celery worker yeniden başlatma | < 1 dk | 0 | Task yeniden kuyruğa alınır |
| Redis yeniden başlatma | < 30 sn | 0 | Broker/cache geçici; DB state korunur |
| DB restore (son pg_dump) | < 30 dk | 24 saat | Günlük backup; commit log yok |
| Tam stack yeniden başlatma | < 5 dk | 24 saat | Docker Compose sırası önemli |
| Key rotation acil | < 15 dk | 0 | MultiFernet geçiş penceresi |

---

## 1 — PostgreSQL / TimescaleDB Çökmesi

### Belirtiler
- `/health/ready` → `{"checks": {"db": {"status": "error"}}}`
- Celery task'lar `sqlalchemy.exc.OperationalError` ile başarısız
- Backend log: `asyncpg.exceptions.ConnectionRefusedError`

### Müdahale

```bash
# 1. Container durumunu kontrol et
docker compose ps postgres

# 2. Log incele
docker compose logs postgres --since=5m | tail -50

# 3. Yeniden başlat
docker compose restart postgres

# 4. Sağlık kontrolü (30s bekle)
sleep 30 && docker compose exec postgres pg_isready -U netmgr -d network_manager

# 5. Backend + worker yeniden başlat (bağlantı pool'u temizle)
docker compose restart backend celery_worker
```

### Veri Kurtarma (tam çökme sonrası)

```bash
# Mevcut volume'u yedekle
docker compose stop postgres
docker run --rm -v switch_postgres_data:/data -v $(pwd)/emergency:/backup \
  alpine tar czf /backup/postgres_emergency_$(date +%Y%m%d_%H%M%S).tar.gz /data

# Son pg_dump'tan restore (backup volume'dan)
LATEST=$(ls -t /var/backups/netmanager/*.dump 2>/dev/null | head -1)
docker compose exec -T postgres pg_restore \
  -U netmgr -d network_manager --clean --if-exists "$LATEST"

# Alembic durumunu doğrula
docker compose exec backend alembic current
# (head) görünmeli; görünmüyorsa: alembic upgrade head
```

---

## 2 — Redis Geçici Kesinti

### Belirtiler
- `/health/ready` → `{"checks": {"redis": {"status": "error"}}}` (HTTP 503)
- Celery task'lar kuyruğa alınamıyor — `redis.exceptions.ConnectionError`
- WebSocket event akışı duruyor

### Davranış (Beklenen)
Sistem **çökmez** — health endpoint degraded döner, task kabulü durur, Redis dönünce otomatik recover. `ExponentialBackoff(cap=10, base=0.5)` + 6 retry ile bağlantı yeniden kurulur.

### Müdahale

```bash
# 1. Redis durumu
docker compose ps redis
docker compose exec redis redis-cli ping  # PONG bekleniyor

# 2. Yeniden başlat
docker compose restart redis

# 3. Bağlantı doğrula
sleep 5 && curl -s http://localhost:8000/health/ready | python3 -m json.tool
# status: ok bekleniyor

# 4. Celery queue derinliği
docker compose exec redis redis-cli LLEN celery
```

### Kritik Not
Redis yeniden başladıktan sonra event dedup TTL'leri sıfırlanır. Bu, 30 saniye içinde tekrar gelen olayların duplicate incident açmasına neden olabilir. Eğer bu süre içinde kritik event'lar varsa, incidents sayfasından manuel duplicate kontrolü yapın.

---

## 3 — Backend (FastAPI) Çökmesi

### Belirtiler
- `curl http://localhost:8000/health/live` başarısız
- Nginx 502 Bad Gateway
- Docker: `docker compose ps backend` → `Exit` durumu

### Müdahale

```bash
# 1. Log incele (son crash sebebini bul)
docker compose logs backend --since=10m | grep -E "ERROR|CRITICAL|Traceback" | tail -30

# 2. Yeniden başlat
docker compose restart backend

# 3. Startup sağlığını izle (60s start_period sonrası healthcheck başlar)
watch -n5 'docker compose ps backend'

# 4. Verify
./scripts/netmanager-verify.sh
```

### Startup Başarısız Oluyorsa

```bash
# DB bağlantı sorunu mu?
docker compose logs backend | grep "Startup: DB"

# Alembic migration gerekiyor mu?
docker compose exec backend alembic current
docker compose exec backend alembic upgrade head

# Encryption key eksik mi?
docker compose exec backend env | grep CREDENTIAL_ENCRYPTION_KEY
```

---

## 4 — Celery Worker Çökmesi

### Belirtiler
- Task'lar kuyruğa alınıyor ama çalışmıyor
- `docker compose ps celery_worker` → Exit / Restarting

### Müdahale

```bash
# 1. Log incele
docker compose logs celery_worker --since=10m | tail -50

# 2. Queue derinliği (birikmiş mi?)
docker compose exec redis redis-cli LLEN celery

# 3. Yeniden başlat
docker compose restart celery_worker celery_beat

# 4. Worker ping
docker compose exec celery_worker celery -A app.workers.celery_app inspect ping
```

### Memory Limit Aşımı (OOMKilled)

`mem_limit: "4g"` aşılırsa Docker container'ı durdurur. `restart: unless-stopped` otomatik yeniden başlatır.

```bash
# Önceki exit sebebini kontrol et
docker inspect $(docker compose ps -q celery_worker) | python3 -c \
  "import sys,json; c=json.load(sys.stdin)[0]; print(c['State']['OOMKilled'], c['State']['ExitCode'])"

# OOMKilled: true ise → worker_max_memory_per_child=524288 (512MB) ayarı geçerli,
# worker zaten recycle edilmeli. Eğer tekrarlanıyorsa: concurrency azalt veya mem_limit artır.
```

---

## 5 — Tam Stack Yeniden Başlatma

```bash
# Sıra önemli: DB ve Redis önce healthy olmali
docker compose up -d postgres redis
sleep 20

# DB sağlığı onaylanınca backend + worker
docker compose up -d backend celery_worker celery_beat flower

# Frontend + Nginx
docker compose up -d frontend nginx

# Doğrulama
./scripts/netmanager-verify.sh
```

---

## 6 — Incident Lifecycle Kurtarma

### RECOVERING'de Sıkışmış Incident'lar

Celery Beat her 5 dakikada `confirm_stale_recovering` task'ını çalıştırır. RECOVERING durumunda 10+ dakika kalmış incident'lar otomatik CLOSED'a geçer.

Manuel müdahale gerekirse:

```bash
# RECOVERING incident'ları listele
docker compose exec postgres psql -U netmgr -d network_manager \
  -c "SELECT id, title, status, recovering_at FROM incidents WHERE status='RECOVERING';"

# Elle kapat (son çare)
docker compose exec postgres psql -U netmgr -d network_manager \
  -c "UPDATE incidents SET status='CLOSED', closed_at=NOW() WHERE status='RECOVERING' AND recovering_at < NOW() - INTERVAL '30 minutes';"
```

---

## 7 — Credential Encryption Key Yönetimi

### Key Rotation (Planlı)

Bkz. `DEPLOY_CHECKLIST.md §6 (6A–6E)` — tam prosedür.

Özet:
```bash
# 1. Yeni key oluştur
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

# 2. .env'ye ekle (eski key'i OLD olarak tut)
CREDENTIAL_ENCRYPTION_KEY_OLD=<eski_key>
CREDENTIAL_ENCRYPTION_KEY=<yeni_key>

# 3. Backend yeniden başlat — startup migration otomatik re-encrypt eder
docker compose restart backend

# 4. Doğrula
./scripts/netmanager-verify.sh
```

### Credential Encryption Key Kaybı — Kritik Risk

> **UYARI:** `CREDENTIAL_ENCRYPTION_KEY` kaybolursa, bu key ile şifrelenmiş veriler **kalıcı olarak** kurtarılamaz hale gelir.

Etkilenen veriler:
- `EscalationRule.webhook_headers` (tüm Slack/Jira/Generic webhook credential'ları)
- `AgentCredentialBundle` (SSH/SNMP parolaları)
- `CredentialProfile` şifreli alanları

**Önerilen önlemler:**
1. `CREDENTIAL_ENCRYPTION_KEY` değerini backup.sh ile birlikte güvenli bir secret manager'da (HashiCorp Vault, AWS Secrets Manager vb.) saklayın.
2. Key'i `.env` dosyasında tutuyorsanız, bu dosyayı DB backup'larıyla aynı güvenlikte yedekleyin — farklı lokasyonda.
3. Key rotation sonrasında eski key'i hemen silmeyin; `CREDENTIAL_ENCRYPTION_KEY_OLD` olarak 48 saat tutun.

**Key kaybı sonrası kurtarma:**
```bash
# 1. Backup'tan key'i kurtar (backup ile birlikte saklandıysa)
# 2. .env'ye geri yaz ve backend'i yeniden başlat
# 3. Key kurtarılamıyorsa → etkilenen credential'ları DB'den temizle ve yeniden gir:
docker compose exec postgres psql -U netmgr -d network_manager \
  -c "UPDATE escalation_rules SET webhook_headers = NULL WHERE webhook_headers IS NOT NULL;"
# Ardından webhook header'larını UI üzerinden yeniden yapılandır.
```

---

## 8 — Post-Recovery Kontrol Listesi

```bash
# 1. Tüm servisler ayakta mı?
docker compose ps

# 2. Sağlık durumu
curl -s http://localhost:8000/health/ready | python3 -m json.tool

# 3. Alembic head'de mi?
docker compose exec backend alembic current

# 4. Celery worker çalışıyor mu?
docker compose exec celery_worker celery -A app.workers.celery_app inspect ping

# 5. Tam smoke test
./scripts/netmanager-verify.sh

# 6. Son incident'ları kontrol et (yeni yanlış alarm var mı?)
docker compose exec postgres psql -U netmgr -d network_manager \
  -c "SELECT id, title, status, opened_at FROM incidents ORDER BY opened_at DESC LIMIT 10;"
```
