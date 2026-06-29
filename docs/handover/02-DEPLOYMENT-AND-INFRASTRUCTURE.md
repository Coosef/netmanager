# 02 — Deployment ve Altyapı

## 1. Production stack bileşenleri (üst seviye)

| Katman | Bileşen | Notlar |
|---|---|---|
| Edge | Cloudflare | TLS termination, HSTS, DNS |
| Origin (VPS) | Linux + Docker + Docker Compose | Tüm uygulama tek host'ta |
| Reverse proxy | `nginx:1.27-alpine` (compose service) | Tek dış kapı (port 80) |
| Frontend | Vite production build → Nginx içi serve (`frontend/Dockerfile` production target) | `target=production` default |
| Backend | FastAPI (`backend/Dockerfile`) | uvicorn `--proxy-headers --forwarded-allow-ips='*'` |
| Worker | Celery (3 havuz) + Beat + Flower | `mem_limit` per servis (`backend/app/workers/celery_app.py`) |
| Background | event_consumer (Redis stream drain) | `python -m app.services.event_consumer` |
| Veri | PostgreSQL TimescaleDB pg16 | RLS aktif |
| Cache/broker | Redis 8 alpine | `maxmemory 512mb`, `allkeys-lru`, `appendonly yes` |

## 2. Docker Compose servisleri (`docker-compose.yml`)

```text
postgres                     timescale/timescaledb:latest-pg16
redis                        redis:8-alpine
backend                      backend/Dockerfile (uvicorn)
celery_worker                backend/Dockerfile (monitor queue, concurrency=16, mem 3g)
celery_agent_worker          backend/Dockerfile (agent_cmd queue, concurrency=8, mem 1g)
celery_default_worker        backend/Dockerfile (default+bulk queue, concurrency=8, mem 2g)
celery_beat                  backend/Dockerfile (scheduler, mem 512m)
event_consumer               backend/Dockerfile (Redis stream drain, mem 512m)
flower                       backend/Dockerfile (Celery monitoring UI)
frontend                     frontend/Dockerfile (target=production)
nginx                        nginx:1.27-alpine
```

Ek (opsiyonel) overlay'ler:

| Dosya | Amaç | Kullanım |
|---|---|---|
| `docker-compose.dev.yml` | Lokal dev: `5432`/`6379`/`8000`/`5555` portlarını host'a publish eder | `docker compose -f docker-compose.yml -f docker-compose.dev.yml ...` |
| `docker-compose.override.yml.example` | Lokal/dev özelleştirme şablonu | `cp .example docker-compose.override.yml` |
| `docker-compose.monitoring.yml` | Prometheus + Grafana overlay (opsiyonel) | ⚠ **VERIFY BEFORE HANDOVER** — production'da etkin mi? |

## 3. VPS dizin yapısı (öneri)

> ⚠ **VERIFY BEFORE HANDOVER**: VPS'teki gerçek path ekipten doğrulanmalı.

Tipik kurulum:
```
/opt/netmanager/
├── switch/                          ← git clone (bu repo)
│   ├── docker-compose.yml
│   ├── .env                         ← SECRET — git'e girmez
│   ├── backend/
│   ├── frontend/
│   ├── nginx/
│   └── ...
└── agent-bins/                      ← agent binary / runtime assets
```

Yan yana:
- `/var/lib/docker/volumes/switch_postgres_data` — Postgres veri
- `/var/lib/docker/volumes/switch_redis_data` — Redis AOF
- `/var/lib/docker/volumes/switch_config_backups` — backup artifact'leri

## 4. Image / build yaklaşımı

- **Image-baked frontend dist**: production'da frontend build artefact'ları image içine gömülür; host bind-mount kullanılmaz. Bu sayede deploy "frontend container'ı recreate et" düzeyinde basitleşir.
- Backend bir bind-mount kullanır (`./backend:/app`), build cache zayıf ancak iteratif deploy kolay. ⚠ **VERIFY BEFORE HANDOVER**: production'da bu bind-mount kalkıp built-in code'a geçildi mi?

### Disposable build worktree (uygulamada doğrulanmış)
Frontend image build'i `main` kirli olduğunda hatalı sonuç verebilir. Pratikte aşağıdaki pattern kullanılır:

```bash
# READ ONLY (kontrol)
git status
# MUTATING (disposable worktree)
git worktree add /tmp/p021-build origin/main
cd /tmp/p021-build
# MUTATING (image build, container recreate)
docker compose -f /opt/netmanager/switch/docker-compose.yml \
  up -d --no-deps --no-build --force-recreate frontend
```

Bu pattern "main branch'ın bilinen iyi commit'inden image üret + sadece frontend recreate" yapar; backend/DB/queue/Alembic dokunulmaz.

> ⚠ **VERIFY BEFORE HANDOVER**: Bu pattern P0.2.x sprintinde uygulamalı doğrulandı; ekiplerin **standart deploy yolu** olarak benimsenip benimsenmediği teyit edilmeli.

## 5. Nginx ve Cloudflare rolü

### Cloudflare (edge)
- TLS termination
- HSTS edge'de açık
- "Always Use HTTPS" ile HTTP→HTTPS edge'de 301
- WAF / Bot / Rate kuralları varsa CF panelinde tanımlı

⚠ **VERIFY BEFORE HANDOVER**:
- CF tunnel kullanılıyor mu yoksa A-record + origin cert mı?
- WAF / Page Rules envanteri?
- `Cache-Control: no-store` ile `/sw.js` için kill-switch durumu (önceki incident bağlamı — bkz. [12](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md))

### Nginx (origin)
- Tek dış kapı (port 80, CF arkasında)
- `/api/v1/ws` ve `/api/v1/agents/ws` 1 saat read/send timeout
- `/api` 120 sn timeout
- `/health` 10 sn timeout
- `/` frontend
- Vite dev path'leri 404
- Global güvenlik header'ları: `HSTS`, `X-Content-Type-Options nosniff`, `X-Frame-Options SAMEORIGIN`, `Referrer-Policy strict-origin-when-cross-origin`, `Permissions-Policy geolocation=(), microphone=(), camera=()`

## 6. Environment variable kategorileri

Tüm değerler `.env` üzerinde tutulur — git'e **kesinlikle** girmez. Kategoriler:

| Kategori | Örnek anahtarlar | Açıklama |
|---|---|---|
| **Postgres** | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `APP_DB_USER`, `APP_DB_PASSWORD` | İki rol: superuser (Alembic) + app (RLS) |
| **Redis** | `REDIS_URL` (compose'da sabit `redis://redis:6379/0`) | — |
| **Auth** | `JWT_SECRET`, `JWT_ALGORITHM`, `JWT_EXPIRE_MINUTES` | ⚠ Rotate prosedürü için bkz. [05](05-SECURITY-RBAC-ORGANIZATION-SCOPING.md) |
| **Credential vault** | `CREDENTIAL_ENCRYPTION_KEY` (Fernet) | Cihaz SSH/SNMP/enable secret'larını encrypt eder |
| **MFA** | `MFA_ISSUER`, `MFA_TOTP_*` | TOTP enroll/login |
| **Internal RPC** | `INTERNAL_API_KEY` (X-Internal-Key) | agent-relay endpoint auth |
| **Flower** | `FLOWER_USER`, `FLOWER_PASSWORD` | Basic auth |
| **Frontend build** | `VITE_API_URL`, `VITE_WS_URL` | Compose'da sabit (`http://backend:8000`, `ws://backend:8000`) |
| **Feature flags** | `WINDOWS_AGENT_V2_ENABLED`, ... | Roll-out gating |
| **Frontend target** | `FRONTEND_TARGET` | `production` (default) veya `development` |

> ⚠ **VERIFY BEFORE HANDOVER**: `.env` tam anahtar listesi `backend/app/core/config.py` üzerinden derivable. Her bir secret için sahiplik ve rotation [14](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md) içinde işaretlenmeli.

## 7. Portlar ve network segmentleri

| Servis | Port (container) | Host'a publish? | Network |
|---|---|---|---|
| nginx | 80 | **Evet** | edge + internal |
| frontend | 3000 | Hayır | edge |
| backend | 8000 | Hayır | internal |
| postgres | 5432 | Hayır | internal |
| redis | 6379 | Hayır | internal |
| flower | 5555 | Hayır (prod) | internal |
| celery worker'lar / beat / event_consumer | — | Hayır | internal |

`docker-compose.dev.yml` ile (lokal dev için) `5432`, `6379`, `8000`, `5555` publish edilebilir. Production'da bu overlay **kullanılmaz**.

## 8. Deploy öncesi/sonrası checklist

### Pre-deploy (`MUTATING`)
1. `[READ ONLY]` `git status` — VPS working tree temiz olmalı
2. `[READ ONLY]` `git log --oneline HEAD..origin/main` — gelecek commit'leri inceleme
3. `[READ ONLY]` Alembic head karşılaştırması:
   ```bash
   # READ ONLY
   docker compose exec backend alembic heads
   docker compose exec backend alembic current
   ```
4. `[READ ONLY]` Yeni Alembic migration var mı? `ls backend/alembic/versions/ | wc -l` — last-known değerle karşılaştır
5. Migration varsa: **şemayı oku**, riskli operasyon (DROP, TYPE değişiklik, NOT NULL ekleme without default) yoksa devam
6. `[READ ONLY]` Mevcut backup taze mi? (en az 24 saat içinde, [10](10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md))
7. `[MUTATING]` Branch checkout: `git fetch && git checkout <tag>` (release tag kullanımı önerilir)
8. **Adım 8 iki alt-adıma ayrılır** (etiket ayrımına dikkat):
   - 8a. `[MUTATING]` **Image build** — Dockerfile + bağımlılık çözümlemesi; image cache + layer mutation; geri alınması için önceki image tag'ine dön + recreate. Frontend için disposable build worktree pattern önerilir.
     ```bash
     # MUTATING (image-only build, container çalışmaz halde dokunulmaz)
     docker compose build backend frontend
     ```
   - 8b. `[SAFE RESTART]` **Container recreate** — yeni image ile container ayağa kalkar; veri kaybı yok, state container'da değil volume + DB'de.
     ```bash
     # SAFE RESTART (yeni image ile recreate; DB/Redis volume'ları korunur)
     docker compose up -d --no-build backend frontend
     ```
   - Pratikte zincir tek satıra düşer ama anlamı korunur:
     ```bash
     # MUTATING (8a) + SAFE RESTART (8b) — pratik tek-satır
     docker compose up -d --build backend frontend
     ```
9. `[MUTATING]` Alembic migration (varsa, backend ayakta):
   ```bash
   # MUTATING
   docker compose exec backend alembic upgrade head
   ```

### Post-deploy (`READ ONLY`)
1. `docker compose ps` — tüm servisler `healthy`
2. `curl -fsS https://<domain>/health/live` — `200 OK`
3. `curl -fsS https://<domain>/health/ready` — `200 OK`
4. Browser smoke: login → dashboard → bir devices sayfası
5. Audit log: son 5 dk içinde error pattern var mı? UI'dan kontrol
6. Celery: bir önceki periyodik task DB'de yeni snapshot bıraktı mı? (`mac_address_entries`, `arp_entries`, vb.)

## 9. Rollback yaklaşımı

### Kod rollback (image-based)
```bash
# MUTATING
git checkout <previous-stable-tag>
docker compose up -d --build backend frontend
```

### DB rollback (DİKKAT)
- Alembic `downgrade` kullanımı **production'da varsayılan olarak yasaktır**.
- Bir migration sorunluysa, **forward-fix** (yeni bir migration) tercih edilir.
- Felaket kurtarma için: backup'tan restore → [10](10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md) (DO NOT RUN CASUALLY).

### Frontend-only rollback
```bash
# MUTATING (frontend recreate)
git checkout <previous-stable-tag> -- frontend
docker compose up -d --build frontend
```

## 10. Stale working tree / disposable build — bilinen deploy riskleri

| Risk | Bağlam | Hafifletme |
|---|---|---|
| **VPS working tree kirli** | VPS'te biri elle değişiklik bırakmış olabilir | `git status` ile önceden kontrol; "Stale Netmanager.zip / Netmanager-handoff.zip" untracked dosyalar varsa anla, dokunma |
| **Frontend image cache** | Eski `dist` image içine yapışmış kalabilir | `docker compose build --no-cache frontend` (DO NOT RUN CASUALLY — uzun sürer) veya disposable worktree pattern |
| **Backend bind-mount + image mismatch** | Bind-mount aktifse code change image rebuild gerektirmez ama Dockerfile değişmişse rebuild lazım | Backend'de hem code hem Dockerfile değiştiyse rebuild zorunlu |
| **Cloudflare 5xx cache window** | Backend recreate sırasında 5xx CF'de kısa süre cache'lenir | Browser hard-refresh; veya backend recreate'i mesai dışı yap |
| **`docker compose down -v`** | Volume'ları siler — Postgres ve Redis data gider | **DO NOT RUN CASUALLY** — yalnız staging'de, yalnız backup sonrası |

## 11. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- Compose service inventarı, ağ üyeliği, expose vs publish (`docker-compose.yml`)
- Nginx kontratı, WS timeout, dev path 404 (`nginx/nginx.conf`)
- Frontend `target=production` default
- Postgres `max_connections=200`, Redis `maxmemory 512mb allkeys-lru`

### VERIFY BEFORE HANDOVER
- VPS dizini, OS sürüm, Docker daemon ayarları
- Cloudflare modeli (tunnel vs A-record), WAF, page rules envanteri
- Production'da disposable build worktree'nin standart yol olduğu
- Backend bind-mount'un production'da hala etkin olduğu / image-baked'a geçilip geçilmediği
- Monitoring overlay'in (Prometheus/Grafana) production'da çalışıp çalışmadığı
