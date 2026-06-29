# 10 — Monitoring, Backup ve Recovery Runbook

## 1. Health endpoint'leri

| Endpoint | Beklenen | Risk |
|---|---|---|
| `GET /health/live` | `200 OK` (FastAPI ayakta) | READ ONLY |
| `GET /health/ready` | `200 OK` (DB + Redis erişilebilir) | READ ONLY |
| `GET /api/v1/diagnostics/*` *(varsa)* | Modüler diagnostic endpoint'leri | READ ONLY (genelde super_admin) |

Kullanım:
```bash
# READ ONLY
curl -fsS https://<domain>/health/live  # 200
curl -fsS https://<domain>/health/ready # 200
```

## 2. Docker Compose health kontrolü

```bash
# READ ONLY
docker compose ps
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Health}}"
```

Beklenen: tüm 11 servis `Up` ve `(healthy)`. Detay:

| Servis | Healthcheck | Süre / interval |
|---|---|---|
| postgres | `pg_isready` | 10s / 5s |
| redis | `redis-cli ping` | 10s / 5s |
| backend | Python urllib `/health/live` | 30s / 10s, start_period 60s |
| celery_worker | `inspect ping --destination=monitor@$HOSTNAME` | 60s / 15s |
| celery_agent_worker | aynı (`agent_cmd@...`) | 60s / 15s |
| celery_default_worker | aynı (`default@...`) | 60s / 15s |
| celery_beat | `grep -aq beat /proc/1/cmdline` | 120s / 15s |
| event_consumer | `redis.exists('event_consumer:alive')` | 30s / 10s |
| nginx | `nginx -t` | 30s / 5s |

## 3. Backend / frontend / DB / Redis / Celery kontrolü

### Backend
```bash
# READ ONLY
docker compose logs --tail=100 backend | grep -iE 'error|warning|critical'
docker compose exec backend python -c "import sys; print(sys.version)"
```

### Frontend
```bash
# READ ONLY
docker compose logs --tail=50 frontend  # nginx start logs
curl -fsS https://<domain>/ -o /dev/null -w "%{http_code}\n"  # 200
```

### Postgres
```bash
# READ ONLY
docker compose exec postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT now(), version();"
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\
  SELECT count(*) AS active_connections FROM pg_stat_activity;"
```

### Redis
```bash
# READ ONLY
docker compose exec redis redis-cli ping            # PONG
docker compose exec redis redis-cli info memory     # used_memory_human
docker compose exec redis redis-cli info stats      # rejected_connections vb.
docker compose exec redis redis-cli dbsize          # key sayısı
```

### Celery
```bash
# READ ONLY
docker compose exec celery_worker celery -A app.workers.celery_app inspect ping --timeout=5
docker compose exec celery_worker celery -A app.workers.celery_app inspect active
docker compose exec celery_worker celery -A app.workers.celery_app inspect reserved
docker compose exec celery_worker celery -A app.workers.celery_app inspect stats | head -30
```

## 4. Backup alınması

### DB backup (`MUTATING`)
```bash
# MUTATING — backup container içine düşer
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -F c -f /tmp/netmgr-$(date -u +%Y%m%dT%H%M%SZ).pgdump

# Sonra host'a çek
docker compose cp postgres:/tmp/netmgr-<timestamp>.pgdump ./backups/
```

> ⚠ **VERIFY BEFORE HANDOVER**: Bu paketin hazırlandığı sırada **otomatik nightly DB backup** olup olmadığı doğrulanmamıştır. Eğer otomasyon **yoksa**, ekibin ilk haftası içinde cron tabanlı bir runbook eklemesi gerekir.

### Volume backup
- `postgres_data` Docker volume `/var/lib/docker/volumes/...` altında durur.
- Offline backup için: `docker compose stop postgres → rsync → docker compose start postgres`.
- **DO NOT RUN CASUALLY** — postgres durmuşken DB erişilemez.

### Config backup
- `config_backups` named volume — `bulk_tasks.scheduled_backup` task'ı buraya yazar.
- Bu volume host backup'a dahil edilmeli.

### Redis backup
- AOF açık (`--appendonly yes`).
- `redis-cli BGSAVE` ile RDB snapshot tetiklenebilir.
- Genelde Redis kritik veri değil (broker + cache) — kayıp tolerans var.

## 5. Restore yaklaşımı

### DB restore (`DO NOT RUN CASUALLY`)
```bash
# DO NOT RUN CASUALLY — production DB üzerine yazar
docker compose stop backend celery_worker celery_agent_worker celery_default_worker celery_beat event_consumer
docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists /tmp/netmgr-<timestamp>.pgdump
docker compose start backend celery_worker celery_agent_worker celery_default_worker celery_beat event_consumer
```

Önce **staging** bir VPS / lokal'de doğrulanır. Production restore yalnız felaket durumunda.

### Volume restore
- Postgres durdurulur → eski volume bağlanır → başlatılır.
- ⚠ **VERIFY BEFORE HANDOVER**: Volume snapshot mekanizması var mı (cloud provider snapshot, vb.).

## 6. Config backup modülü (`bulk_tasks.scheduled_backup`)

- 24 saatte bir çalışır.
- Tüm aktif cihazları dolaşır; `show running-config` çeker.
- Output `config_backups` named volume'una dosya olarak yazılır.
- Önceki ile diff çıkarılır; **drift** varsa `audit_logs` ve potansiyel olarak notification.

```bash
# READ ONLY
docker compose exec backend ls -lah /app/backups/ | head -30
```

## 7. Device backup prosedürleri (manuel / on-demand)

UI'dan **Backups** sayfasında:
- "Şimdi backup al" → ilgili cihaz için config çeker
- Geçmiş listesi gösterilir (history)
- Diff viewer iki backup arası farkı highlight eder

API'den (servis hesabı / CI için):
```
POST /api/v1/devices/{id}/backup    # backup.create yetkisi
GET  /api/v1/devices/{id}/backups   # backup.read
```

## 8. Sistem recovery sırası

Felaket sonrası temiz başlatma:

1. `[READ ONLY]` Host erişimi doğrulanır (SSH).
2. `[READ ONLY]` Docker daemon ayakta mı (`systemctl status docker`).
3. `[READ ONLY]` `git status` — working tree temiz mi.
4. `[READ ONLY]` `.env` dosyası mevcut mu, ACL kilitli mi (`stat .env`).
5. `[SAFE RESTART]` `docker compose pull` — image güncellemesi (varsa).
6. `[MUTATING]` `docker compose up -d postgres redis` — önce data tier.
7. Postgres healthy olana kadar bekle (~60s).
8. `[MUTATING]` `docker compose up -d backend` — backend, migration'lar uygulanır.
9. `[READ ONLY]` `curl https://<domain>/health/ready` → 200.
10. `[MUTATING]` `docker compose up -d celery_beat celery_worker celery_agent_worker celery_default_worker event_consumer flower`.
11. `[MUTATING]` `docker compose up -d frontend nginx`.
12. `[READ ONLY]` Browser smoke: login + dashboard + devices.

Eğer backup'tan restore gerekiyorsa: §5 prosedürünü §6'dan önce uygula.

## 9. Log toplama ve incident evidence standardı

Bir incident raporu için tutarlı log seti:

```bash
# READ ONLY — toplama klasörü
EVIDENCE=/tmp/incident-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$EVIDENCE"

# Compose durum
docker compose ps > "$EVIDENCE/ps.txt"

# Son N satır log her servis için
for svc in backend celery_worker celery_agent_worker celery_default_worker celery_beat event_consumer postgres redis nginx frontend flower; do
  docker compose logs --tail=200 "$svc" > "$EVIDENCE/$svc.log" 2>&1
done

# DB istatistik
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT now(), version();" > "$EVIDENCE/db-version.txt"

# Redis stats
docker compose exec -T redis redis-cli info > "$EVIDENCE/redis-info.txt"

# Tar
tar -C /tmp -czf "$EVIDENCE.tar.gz" "$(basename $EVIDENCE)"
```

**Evidence kuralları:**
- Secret / token / .env içeriği **asla** evidence içine dahil edilmez (`docker compose config` çıktısı bile env değerlerini gösterir; **bu yolu kullanma**).
- Operatör adı / IP'ler / cihaz hostname'leri masking gerekiyorsa rapor öncesi temizle.
- Evidence sahibinin yetkili olduğu lokasyona/organizasyona scope'lu olmalı (org_admin sadece kendi org'unun verisini görmeli).

## 10. Cloudflare / origin 502 ayırımı

Bir 502 hatası dışarıdan görüldüğünde:

| Belirti | Yorum |
|---|---|
| Cloudflare error page (CF logosu görünüyor) | Origin Nginx + backend zinciri **ulaşılamıyor** veya 5xx döndü; CF sticky cache 502'yi kısa süre tutabilir |
| Direct origin curl 200, browser CF üzerinden 502 | CF tarafında cache veya WAF kuralı |
| Origin curl 502 ama nginx ayakta | Backend container down veya backend hata |
| Browser 502 + origin curl 200 | CF cache'i; **browser hard refresh** veya `Cache-Control: no-store` yolu |
| Tüm endpoint'ler 502 | Nginx → backend reach problemi |

**Doğrulama yolu:**
```bash
# READ ONLY
curl -fsS -H "Host: <domain>" https://<vps-ip>/health/live --resolve "<domain>:443:<vps-ip>" -k
```
Bu Cloudflare'i bypass eder; origin gerçekten 200 mü 5xx mı görürsün.

Tarihsel ders (Pentest Finding 1 rollback incident — historical internal context, VERIFY BEFORE HANDOVER): backend recreate window'unda CF/browser sticky 5xx cache, kodun doğru olmasına rağmen rollback tetiklenmesine yol açmıştır. **Restart sonrası 30-60 sn cache window'una sabırla yaklaş**.

## 11. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- Health endpoint kontratı (compose backend healthcheck)
- Tüm 11 servisin healthcheck komutları
- `bulk_tasks.scheduled_backup` 24 saatlik cycle (`celery_app.py`)
- Cloudflare 5xx cache window risk (pentest finding 1 rollback'i)

### VERIFY BEFORE HANDOVER
- Production'da nightly DB backup automation var mı (cron / Celery)
- `config_backups` volume'unun offsite snapshot yolu
- Restore tatbikatı en son ne zaman yapıldı
- Cloudflare cache TTL ve "Always Use HTTPS" / Page Rules
- Origin SSL: termination CF'de mi yoksa nginx'te de ayrıca certificate mı
