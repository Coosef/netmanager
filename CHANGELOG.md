# Changelog

## [Faz 6B G7] — 2026-05-16 — Production Cleanup & Tuning

> Faz 6C öncesi altyapı temizliği · **440/440 test**
> Merge: `feature/faz6b-g7-cleanup-tuning` → `main`

Faz 6A/6B sırasında biriken 5 production hardening maddesi — büyük feature
değil, event bus'a (Faz 6C) temiz zeminde geçmek için altyapı temizliği.

**G7-1 — DB pool right-sizing**
- `async_engine` + `sync_engine` `pool_size=20/max_overflow=40` (60/engine)
  idi → 6 process × 2 engine = 720 worst-case, `max_connections=200`'e karşı.
- `settings.DB_POOL_SIZE` (5) / `DB_MAX_OVERFLOW` (10) ile configurable →
  6 × 2 × 15 = 180 worst-case. `max_connections=200` hotfix'inin altındaki
  yapısal over-allocation giderildi.

**G7-2 — prom_multiproc per-service subdir**
- Tüm container'lar `/tmp/prom_multiproc`'u paylaşıyordu, hepsi pid=1 →
  aynı `counter_1.db`'ye yazıp birbirini bozuyordu.
- Her servis kendi `/tmp/prom_multiproc/<servis>` subdir'ine yazar; start
  komutu subdir'i boot'ta temizler. `/metrics` artık tüm subdir'leri
  glob+merge eden `_AllServicesMultiprocCollector` kullanıyor.

**G7-3 — Celery healthcheck hostname fix**
- Worker healthcheck'leri `--destination=monitor@$HOSTNAME` (exec-form) →
  compose `$HOSTNAME`'i host'tan boş interpolate ediyordu → kalıcı
  false "unhealthy". `CMD-SHELL` + `$$HOSTNAME` ile container içinde
  runtime'da resolve. celery_beat scheduler olduğu için `inspect ping`
  hiç eşleşmiyordu → pid-1 cmdline kontrolüne çevrildi.

**G7-4 — Fleet version-bump debounce**
- Her device event fleet version'ı INCR ediyordu → cache her event'te
  ölüyordu (hit ratio ~0). `_bump_fleet_version_debounced`: SETNX guard
  ile debounce penceresinde (`AGG_CACHE_INVALIDATION_DEBOUNCE_SECS`, 30s)
  en fazla 1 bump. Per-device DELETE ve device-CRUD invalidation debounce
  edilmez.

**G7-5 — Decommissioned agent cleanup runbook**
- `scripts/agent-cleanup-audit.sh` — backend log'undaki 403 WS handshake
  spam'ini tespit eder, DB ile cross-reference yapar, agent başına çözüm
  önerir. Kod değişikliği yok (403 doğru davranış); operasyonel prosedür.

### Test
- 436 → **440 PASS** (+4 version-bump debounce testi).

---

## [Faz 6B] — 2026-05-16 — Caching Layer + Aggregation Optimization

> KI-1 çözümü · **435/435 test** (344 → 435, +91)
> Merge: `feature/faz6b-cache-aggregation-optimization` → `main`

### KI-1 kapanışı — aggregation endpoint latency

Pilot sırasında `/sla/fleet-summary` ve `/intelligence/fleet/risk` endpoint'leri
~99s gecikme gösteriyordu. Kök neden: her cihaz için ayrı DB sorgusu (N+1).
6B bu endpoint'leri tek/üç bulk SQL'e indirdi ve önüne stale-while-revalidate
cache katmanı koydu.

**G1 — AggregationCache (`app/services/cache.py`)**
- Async Redis cache: iki katmanlı TTL (`fresh_secs` + `stale_secs`), SWR.
- Single-flight SETNX lock → cache stampede koruması.
- Her Redis op'unda 50ms hard timeout (event loop güvenliği).
- Redis erişilemezse compute çalışır, yazma denenmez (fallback).
- X-Cache-Bypass desteği; >5s compute uyarı metriği.
- JSON encoder: datetime / date / Decimal / UUID / set.
- 4 Prometheus metric: AGG_DURATION, CACHE_OPS, CACHE_UNAVAILABLE, CACHE_REDIS_KEYS.

**G2 — `/sla/fleet-summary`: N+1 → 1 sorgu**
- `_calc_uptime_bulk` — N cihaz için tek SQL, device_id+created_at sıralı grouping.
- Orijinal `_calc_uptime` algoritmasıyla birebir parite (parity testleri ile garanti).
- Versioned cache key + X-Cache-Status response header.

**G3 — `/intelligence/fleet/risk`: N+1 → 3 bulk sorgu + async migration**
- `_calc_risk_bulk` — audit (DISTINCT ON), events, flap counts: 3 sorgu.
- Sprint 12A risk formülü birebir korundu (parity testi).
- Sync `redis.from_url()` async cache katmanına taşındı (event loop blocking giderildi).

**G4 — Event-driven cache invalidation (`app/services/cache_invalidation.py`)**
- 3 sync helper: `invalidate_for_event` / `invalidate_device_risk` / `invalidate_all_fleet_caches`.
- 5 hook noktası: correlation_engine, security_audit (×2), backup_tasks, bulk_tasks.
- Versioning modeli (SCAN+DEL yerine version INCR) → fleet-wide invalidation O(1).
- Tüm helper'lar Redis-error-safe; correlation hot path çift try/except korumalı.

**G5 — Cache warmer (`app/workers/tasks/cache_warmer_tasks.py`)**
- Beat task (60s, `default` queue): dirty device/tenant set'lerini consume eder.
- `asyncio.Semaphore(5)` ile DB aggregation concurrency sınırlı.
- Single-runner lock + target dedup + G1 single-flight → duplicate warmup storm yok.
- SREM member-specific drain → crash-safe (kalan marker'lar sonraki cycle'da retry).

### Sprint sırasında yapılan production hotfix'ler

- **fix(prod):** PostgreSQL `max_connections` 50 → 200 + shared_buffers 512MB.
  Faz 6A queue separation (4 → 6 process) `TooManyConnectionsError` yaratıyordu
  (126/saat), agent WS flap'e sebep oluyordu. (commit `843c4da`)
- **fix(prod):** `/metrics` corrupt multiproc dosyalarına dayanıklı hale getirildi
  (try → corrupt file scan/delete → retry). Backend healthcheck `curl` → `python3`
  (image'da curl yok). (commit `2048b9d`, `376cb9e`)

### Test

- 6 yeni test dosyası, +91 test: `test_faz6b_cache` (17), `_sla_bulk` (20),
  `_intelligence_bulk` (16), `_cache_invalidation` (21), `_cache_warmer` (17).
- 344 → **435 PASS**, 0 regression.

### Faz 6B G7 backlog (sonraki sprint)

- SQLAlchemy `pool_size` 20/40 → 5/10 right-sizing (max_connections kalıcı çözüm).
- `prom_multiproc` per-container subdir (pid=1 çakışması kök çözümü).
- Celery worker healthcheck `$HOSTNAME` resolve bug (cosmetic false-unhealthy).

---

## [Faz 6A] — 2026-05-15 — Agent Command Bridge + Queue Separation

> Pilot sonrası ilk feature sprint · **344/344 test** · S1–S8 smoke PASS  
> Merge: `feature/faz6a-agent-command-bridge` → `main`

### KI-3 kapanışı — Celery ↔ WebSocket process isolation çözümü

Celery worker'lar uvicorn process'inden ayrı OS process olduğu için `AgentManager._connections` her zaman boştu. Pilot'ta tüm agent-based synthetic probe'lar "agent offline" döndürüyordu. Bu sprint'te Redis Pub/Sub tabanlı request-response bridge ile kalıcı çözüm geldi.

**Yapı:**

```
Celery (agent_cmd queue) → publish agent:bridge:cmd:{agent_id}
                          ↓
Redis Pub/Sub  ←→  FastAPI AgentBridgeListener (psubscribe agent:bridge:cmd:*)
                          ↓
                  agent_manager.execute_synthetic_probe / ping_check
                          ↓
                  publish agent:bridge:res:{request_id}  +  SETEX fallback (60s TTL)
                          ↓
Celery subscribe-before-publish + listen() + SETEX poll → response or RuntimeError → direct probe fallback
```

### Yapılan değişiklikler

- **feat(bridge):** `app/services/agent_bridge.py` — `AgentBridgeListener` (pattern-subscribe, fire-and-forget dispatch, exception isolation, dedicated pubsub connection)
- **feat(bridge):** `app/services/agent_bridge_client.py` — `send_agent_command()` (subscribe-before-publish invariant, SETEX fallback poll, RuntimeError on full timeout)
- **feat(workers):** 3 ayrı Celery worker pool — `celery_worker` (monitor, conc=16, 3g), `celery_agent_worker` (agent_cmd, conc=8, 1g), `celery_default_worker` (default+bulk, conc=8, 2g)
- **feat(routing):** `synthetic_tasks.*` ve `agent_peer_tasks.*` → `agent_cmd` queue (`task_routes`)
- **feat(synthetic):** `_run_probes()` bridge entegrasyonu — bridge başarılı → sonuç sakla, bridge fail/timeout/exception → `_direct_probe(probe)` fallback (correlation flow ASLA kırılmaz)
- **feat(metrics):** 3 yeni Prometheus metric — `netmanager_agent_bridge_command_duration_seconds` (Histogram), `netmanager_agent_bridge_timeout_total` (Counter), `netmanager_agent_bridge_command_total` (Counter, labels: command_type + result)
- **fix(bridge):** pubsub connection için dedicated `aioredis.from_url()` (paylaşılan client'ın `socket_timeout=5`'i pubsub listen()'i 5s'de düşürüyordu)
- **test:** `test_faz6a_agent_bridge.py` — 16 yeni unit test (client/listener/synthetic_tasks integration); 328 → **344 PASS**

### Smoke test sonuçları (merge öncesi)

| # | Test | Sonuç |
|---|------|-------|
| S1 | Bridge listener startup | ✅ `bridge: listener started, pattern=agent:bridge:cmd:*` |
| S2 | celery_agent_worker ping | ✅ 3 worker node online (`monitor@`, `agent_cmd@`, `default@`) |
| S3 | Bridge dispatches synthetic_probe | ✅ Prometheus `agent_bridge_command_total` counter incrementing |
| S4 | Agent offline → fallback to direct probe | ✅ Direct probe results stored (success=True, latency 63–66ms) |
| S5 | `/metrics` bridge metrics present | ✅ duration histogram + counters export ediliyor |
| S6 | Queue depths zero (no backlog) | ✅ default=0 bulk=0 monitor=0 agent_cmd=0 |
| S7 | Backend restart → bridge re-starts | ✅ lifespan hook çalışıyor, listener restart sonrası tekrar başladı |
| S8 | Full test suite | ✅ 344/344 PASS (1.95s) |

### Faz 6A bileşen kuralları

- Bridge timeout production'da correlation flow'unu **ASLA** kırmaz: her bridge hatası (timeout / agent_offline / Redis down / exception) `_direct_probe` fallback'ine düşer.
- Subscribe-before-publish invariant'ı: Celery `pubsub.subscribe(res_channel)` HER ZAMAN `r.publish(cmd_channel, ...)` öncesinde çalışır → response race'i imkânsız.
- SETEX fallback key (60s TTL): bridge `publish` + `setex` aynı yanıtla → Celery pubsub listen() kaçırırsa `r.get(fb_key)` ile telafi.
- Beat schedule değişmedi (sadece routing eklendi): synthetic + agent_peer task'ları `agent_cmd` queue'sundan çalışır, diğer tüm task'lar mevcut queue'larda kalır.

### KI durumu

- **KI-3 (critical):** ✅ **ÇÖZÜLDÜ** — Agent command bridge production'a alındı. Production gözlem devam ediyor (bridge metric'leri Grafana'da takip edilecek).
- KI-1, KI-2, KI-4: Faz 6B+ backlog'unda kalıyor (değişmedi).

---

## [Pilot] — 2026-05-14 — Pilot Production Sprint — GO ✅

> Baz: `main` (Faz 5E, 312/312 test) · Sprint sonu: **328/328 test**  
> T1–T9 operasyon testlerinin tamamı PASS. Platform gerçek ortamda doğrulandı.

### Sprint sırasında yapılan düzeltmeler

- **fix(correlation):** `group_wait` TTL race condition — `setex` TTL `GROUP_WAIT_SEC` → `GROUP_WAIT_SEC + 15`; task countdown ile TTL eşit olduğunda key sürüyor ve incident açılmıyordu
- **feat(synthetic):** Agent-less probe'lar için direct probe execution (`_direct_probe`); `if not probe.agent_id: continue` → `_direct_probe(probe)` path
- **test:** 16 yeni unit test (`TestSyncIcmp`, `TestSyncTcp`, `TestSyncDns`, `TestSyncHttp`); 312 → 328 PASS

### Pilot Metric Baseline (sprint sonu)

| Metrik | Değer |
|--------|-------|
| Test suite | 328 passed |
| Aktif cihaz | 63 |
| Celery worker RSS (stabil) | ~2.5 GiB |
| Backend RAM | ~167 MiB |
| Redis memory | 3.10 MiB / ~1950 key |
| SNMP poll throughput | ~1250 poll/5dk (54 cihaz) |
| Syslog sequential throughput | 71 insert/s, p99 18ms |

### Known Issues → Faz 6 backlog

- **KI-3 (critical):** Celery ↔ WebSocket process isolation — agent-based synthetic probe'lar "agent offline" dönüyor. Faz 6A: Redis Pub/Sub agent command bridge.
- **KI-1 (medium):** Aggregation endpoint gecikme ~99s. Faz 6B: caching + query optimization.
- **KI-4 (medium):** Concurrent syslog burst'te silent DB pool exhaustion. Faz 6C: async event bus.
- **KI-2 (low):** Eski REST agent endpoint'leri 404. Legacy client cleanup.

---

## [Released] — Faz 5: Production Hardening & Platform Reliability (5A → 5E)

### Merge: `feature/faz5e-ha-rollback-resilience` → `main`

> 5 sprint · **312/312 test** · 0 TypeScript hatası · Vite build temiz  
> Tamamlandı: 2026-05-14

---

### Faz 5A — Alembic Migration (KL-1 Kapatma)

#### `alembic/` — Versiyonlanmış Şema Yönetimi
- `alembic init` + `env.py` async engine bağlantısı (`asyncpg` driver).
- Baseline revision: mevcut şema (`alembic stamp head` ile sıfır-diff başlangıç).
- `main.py` lifespan'dan tüm `ALTER TABLE` blokları kaldırıldı → migration dosyaları.
- `alembic upgrade head` CI adımına eklendi; `alembic downgrade -1` smoke test.
- Migration dosyaları: `alembic/versions/` — her faz için ayrı revision.

#### Test eklemesi
- `test_faz5a_alembic.py` — 8 test eklendi (toplam 244)

---

### Faz 5B — Backup & Restore Otomasyonu

#### `scripts/backup.sh` + `scripts/restore-smoke.sh`
- `pg_dump` günlük cronjob — 3 kopya rotasyonu, ISO timestamp.
- Backup doğrulama: `pg_restore --list` ile boş dosya kontrolü.
- Restore smoke test: geçici container'da restore + `\dt` sanity check.
- `docker-compose.prod.yml`: `backup` servisi + cronjob volume mount.
- Opsiyonel: `S3_BACKUP_BUCKET` + `SFTP_BACKUP_HOST` env değişkenleri ile uzak kopya.

#### Test eklemesi
- `test_faz5b_backup.py` — 8 test eklendi (toplam 252)

---

### Faz 5C — Structured Logging & Metrics (KL-12 Kapatma)

#### `app/core/logging_config.py` — structlog JSON Çıktısı
- `structlog` JSON formatı: `level`, `timestamp`, `request_id`, `duration_ms`, `user_id`, `path`.
- `RequestLoggingMiddleware` — her HTTP isteği için request_id zinciri.
- `LOG_LEVEL` env değişkeni (varsayılan: `INFO`).

#### `app/core/metrics.py` + `/metrics` Endpoint
- Prometheus multiprocess: `prom_multiproc` tmpfs volume → tüm worker metrikleri toplanıyor.
- `http_requests_total`, `http_request_duration_seconds`, `celery_tasks_total`, `db_pool_size`.
- `GET /api/v1/metrics` → Prometheus scrape format.

#### `/health/ready` Genişletme
- DB bağlantı + pool durumu, Redis ping, TimescaleDB `\dx` versiyon bilgisi.
- `status: ok | degraded | error` — bileşen bazlı breakdown.

#### Celery Task Sinyalleri (`app/workers/signals.py`)
- `task_success` / `task_failure` / `task_retry` sinyalleri → Prometheus counter.
- Celery Beat `metrics_tasks.py`: Redis queue depth + TimescaleDB job istatistikleri.

#### Test eklemesi
- `test_faz5c_observability.py` — 20 test eklendi (toplam 272)

---

### Faz 5D — Secret Encryption (KL-10 Kapatma)

#### `EncryptedJSON` TypeDecorator (`app/core/encryption.py`)
- Fernet (AES-128-CBC + HMAC-SHA256) — `CREDENTIAL_ENCRYPTION_KEY` env değişkeni.
- `process_bind_param` / `process_result_value` — DB'ye yazarken şifrele, okurken çöz.
- `_fernet_needs_encryption(token)` idempotency guard — çift şifreleme koruması.
- MultiFernet key rotation: `CREDENTIAL_ENCRYPTION_KEY_OLD` ile geçiş penceresi.

#### `EscalationRule.webhook_headers` → Şifreli
- `webhook_headers` kolonu `EncryptedJSON` TypeDecorator kullanıyor.
- Startup migration (`_encrypt_existing_webhook_headers()`): plaintext → Fernet token, idempotent.
- API maskeleme korunuyor: `webhook_header_keys: list[str]` (değerler asla döndürülmüyor).

#### SNMP v3 Passphrase Genişletme
- `d5e6f7a8b9c0` migrasyonu: `snmp_v3_auth_passphrase` + `snmp_v3_priv_passphrase` — `String(256)` → `Text`.
- Uzun passphrase değerleri için kolon genişletildi.

#### DEPLOY_CHECKLIST.md Bölüm 6 — Key Rotation (6A–6E)
- Dry-run hazırlık → canlı rotation → doğrulama → rollback → MultiFernet geçiş penceresi.
- `CREDENTIAL_ENCRYPTION_KEY` + `CREDENTIAL_ENCRYPTION_KEY_OLD` env değişkenleri belgelendi.

#### Test eklemesi
- `test_faz5d_encryption.py` — 17 test eklendi (toplam 289)

---

### Faz 5E — High Availability & Resilience

#### G1 — Celery Worker Resilience
- Global limitler: `task_soft_time_limit=1200` (20 dk) · `task_time_limit=1500` (25 dk) · `worker_max_memory_per_child=524288` (512 MB).
- `broker_connection_retry_on_startup=True` + `socket_timeout/connect_timeout=5s`.
- Per-task override'lar — uzun görevleri global 25 dk limiti öldürmüyor:

  | Görev | soft_time_limit | time_limit |
  |-------|-----------------|------------|
  | `execute_rollout_task` | 3600s | 3900s |
  | `execute_rollback_task` | 3600s | 3900s |
  | `run_bulk_command` | 3600s | 3900s |
  | `bulk_backup_configs` | 3600s | 3900s |
  | `scheduled_topology_discovery` | 600s | 720s |

#### G2 — Redis Reconnect / Backoff (`app/core/redis_client.py`)
- `ExponentialBackoff(cap=10, base=0.5)` + `Retry(retries=6)`.
- `socket_keepalive=True`, `health_check_interval=30`, `socket_connect_timeout=5`.
- Singleton `get_redis()` imzası değişmedi — geriye dönük uyumlu.

#### G3 — WebSocket Reconnect (`frontend/src/utils/useReconnectingWebSocket.ts`)
- YENİ hook: exponential backoff + jitter (`delay = min(base·2^n, max) + rand(0, base)`).
- Thundering herd koruması: jitter farklı client'ların aynı anda reconnect etmesini önler.
- `onReconnecting(attempt, delayMs)` / `onFailed()` callback'leri.
- `useTaskProgress.ts` bu hook'a migrate edildi; görev tamamlandıktan sonra reconnect bildirimi gönderilmiyor.

#### G4 — Startup Timeout + BG Task Lifecycle (`app/main.py`)
- `_asyncio_timeout(seconds)` compat helper — Python 3.10 / 3.11 uyumlu.
- DB startup probe: 30s timeout → `RuntimeError("Startup: DB bağlantısı kurulamadı")`.
- OUI load: 15s timeout → `WARNING` log, uygulama başlamaya devam eder.
- `ensure_future` → `create_task(name="bg:...")` — tracked, isimlendirilmiş BG task'lar.
- Shutdown: `t.cancel()` + `asyncio.gather(*_bg_tasks, return_exceptions=True)`.

#### G5 — Docker Healthchecks + Memory Limits (`docker-compose.yml`)
- `backend`: `curl -f /health/live` (30s/10s/3×/60s start) · `mem_limit: "2g"`.
- `celery_worker`: `celery inspect ping --timeout=5` (60s/15s/3×/30s start) · `mem_limit: "4g"`.
- `celery_beat`: `mem_limit: "512m"`.

#### G6 — Post-Deploy Verification (`scripts/netmanager-verify.sh`)
- Smoke adımları: `/health/ready` → alembic head → device count → Celery queue depth → `/metrics`.
- `--full` flag: tam pytest suite çalıştırır.
- Exit 0=PASS / 1=FAIL — CI/CD pipeline'a eklenilebilir.

### Known Limitations — Güncel Durum

| ID | Durum | Açıklama |
|----|-------|---------|
| KL-1 | ✅ Faz 5A | Alembic migration yönetimi — tüm şema değişiklikleri versiyonlanmış |
| KL-2 | Açık | `sources`/`timeline` JSON vs JSONB — şu an sorunsuz |
| KL-3 | ✅ Faz 2A | RECOVERING sweep task eklendi |
| KL-4 | Açık | `queued_events` flush sırasında yeniden bağlantı — teorik duplicate, dedup ile karşılanıyor |
| KL-5 | ✅ Faz 2A | Multi-hop BFS suppression |
| KL-6 | ✅ Faz 3A | `_merge_intervals` ile çakışan downtime çift sayımı düzeltildi |
| KL-7 | ✅ Faz 4A | `_ab_peer_latency_loop` FastAPI bg task — gerçek A→B agent-to-agent latency ölçümü |
| KL-8 | Açık | `SyntheticProbe.runNow` `agent_id` gerektiriyor — agentsiz probe çalıştırılamaz |
| KL-9 | ✅ Faz 4B | 5 hypertable (TimescaleDB) — `device_availability_snapshots` + 4 diğer tablo dönüştürüldü |
| KL-10 | ✅ Faz 5D | `EscalationRule.webhook_headers` Fernet şifreli — startup migration tamamlandı |
| KL-11 | Açık | Escalation evaluator minimum tepki süresi 5 dk — çok kritik olaylar için azaltılabilir |

### Test Durumu

**312/312 test geçiyor** (Faz 5 kümülatif):
- `test_faz5a_alembic.py` — 8 test (5A)
- `test_faz5b_backup.py` — 8 test (5B)
- `test_faz5c_observability.py` — 20 test (5C)
- `test_faz5d_encryption.py` — 17 test (5D)
- `test_faz5e_resilience.py` — 23 test (5E)
- Önceki testler: 236 test (Faz 1–4)

---

## [Released] — Faz 4: Advanced Observability & Intelligence (4A → 4E)

### Merge: `feature/faz4e-escalation-rule-engine` → `main`

> 5 sprint · **236/236 test** · 0 TypeScript hatası · Vite build temiz  
> Tamamlandı: 2026-05-13

---

### Faz 4A — Gerçek Agent-to-Agent Latency

#### KL-7 Kapatıldı: FastAPI Background Loop (`agent_peer_tasks.py`)
- `_ab_peer_latency_loop()` — FastAPI lifespan'da `asyncio.create_task` ile 900s aralıklı periyodik görev.
- Her online agent çifti (A, B) için Agent A'ya `ping_check` gönderir; hedef = Agent B'nin `last_ip`.
- `agent_from = agent_a_id` olarak kaydedilir — daha önce sabit `"backend"` idi.
- `AgentPeerLatency` satırları artık gerçek ağ arası gecikmeyi yansıtır.
- Önceki kısıt: Celery worker WebSocket bağlantısı olmadığından yalnızca backend→agent ölçümü yapılıyordu.

#### Test eklemesi
- `test_agent_peer_latency.py` — 9 test eklendi (toplam +9, baz 174 → 183)

---

### Faz 4B — TimescaleDB Hypertable

#### KL-9 Kapatıldı: 5 Hypertable Oluşturuldu
- `docker-compose.yml` → `timescaledb/timescaledb:latest-pg16` servisi (`postgres` yerini aldı).
- `main.py` lifespan'a 5 idempotent `create_hypertable(..., if_not_exists => TRUE)` çağrısı:
  - `device_availability_snapshots` (chunk: 7 gün)
  - `snmp_poll_results` (chunk: 1 gün)
  - `agent_peer_latencies` (chunk: 7 gün)
  - `synthetic_probe_results` (chunk: 1 gün)
  - `syslog_events` (chunk: 1 gün)
- Retention policy: her tablo için `add_retention_policy` (90 gün) — Celery retention task devre dışı.
- Önceki kısıt: 1000+ cihaz × 365 gün = 365k satır; plain PostgreSQL range sorguları yavaşlıyordu.

#### Test eklemesi
- `test_faz4b_timescale.py` — 8 test eklendi (toplam 191)

---

### Faz 4C — Advanced Synthetic SLA Thresholds

#### `SlaPolicy` ↔ `SyntheticProbe` Entegrasyonu
- `SlaPolicy` modeline `probe_id: Optional[int]` FK eklendi.
- `run_synthetic_probes` task: ardışık N başarısız probe → `threshold_violated` event.
- Latency SLA: `latency_ms > threshold_ms` → warning event.
- `/sla/compliance` endpoint'inde probe SLA ihlalleri dahil edildi.
- Frontend: SyntheticProbes sayfasında probe başına "SLA: %98.2 (son 7g)" rozeti.

#### Test eklemesi
- `test_faz4c_sla_probes.py` — 13 test eklendi (toplam 204)

---

### Faz 4D — Incident RCA Ekranı

#### `Incident` Modeli + RCA UI
- `Incident` + `IncidentTimeline` modelleri — OPEN/DEGRADED/RECOVERING/CLOSED state makinesi.
- `opened_at`, `closed_at`, `recovering_at`, `severity`, `event_type`, `component`, `sources` (JSON).
- `process_event()` servisi: yeni veya mevcut incident'a event ekler, state geçişlerini `IncidentTimeline`'a kaydeder.
- CRUD API: `GET /incidents`, `GET /incidents/{id}`, `PATCH /incidents/{id}/state`.
- `/incidents` sayfası — filtreli tablo (state/severity/device), timeline modal, RCA detayı.
- `correlation_incident` olayları dashboard incident feed'inde gösterilir.

#### Düzeltilen test sorunu
- `test_list_incidents_empty`: FastAPI `Query()` nesneleri doğrudan fonksiyon çağrısında çözülmüyor; tüm parametreler açıkça geçildi.

#### Test eklemesi
- `test_faz4d_incidents.py` — 12 test eklendi (toplam 216)

---

### Faz 4E — Escalation Rule Engine

#### `EscalationRule` + `EscalationNotificationLog` Modelleri (`escalation_rule.py`)
- `EscalationRule`: `name`, `enabled`, `match_severity` (JSON), `match_event_types` (JSON), `match_sources` (JSON), `min_duration_secs`, `match_states` (JSON), `webhook_type` (slack/jira/generic), `webhook_url`, `webhook_headers` (JSON), `cooldown_secs` (varsayılan 3600).
- `EscalationNotificationLog`: kural + incident başına gönderim kaydı — `status` (sent/failed/dry_run), `response_code`, `error_msg`, `sent_at`.

#### `escalation_matcher.py` — Pure Matcher Fonksiyonları
- `matches_rule(incident, rule)` — enabled, state, severity, event_type, sources, min_duration_secs filtreleri.
  - `match_states = None` → varsayılan `["OPEN", "DEGRADED"]`
  - Her None matcher = her şeyi eşleştirir.
- `cooldown_cutoff(cooldown_secs, now)` → cutoff datetime.
- Payload builders: `build_slack_payload`, `build_generic_payload`, `build_jira_payload`, `build_payload`.
  - Slack: `attachments` — severity rengi, başlık, cihaz bilgisi.
  - Jira: `summary`, `priority` (Highest/High/Medium), `labels: ["netmanager", severity]`.
  - Generic: düz JSON dict — tüm incident alanları.

#### `escalation_sender.py` — Webhook Teslimat
- `send_webhook(rule, incident, dry_run=False)` — `httpx.AsyncClient` ile asenkron POST.
- `dry_run=True`: HTTP isteği yapılmaz, sadece loglama.
- Timeout: 10 saniye; `status_code < 400` → başarılı.

#### `escalation_tasks.py` — Celery Evaluator
- `evaluate_escalation_rules()` — her 5 dakikada çalışır (beat: 300s).
- Tüm enabled kuralları + OPEN/DEGRADED incident'ları yükler.
- Her (incident, rule) çifti: `matches_rule()` → cooldown DB sorgusu → `send_webhook()` → log insert.
- Cooldown: `EscalationNotificationLog`'da aynı `(rule_id, incident_id)` için `status="sent"` + `sent_at >= cutoff` → atla.

#### REST API (`escalation.py`)
```
GET/POST  /escalation-rules
GET/PUT/DELETE  /escalation-rules/{id}
POST  /escalation-rules/{id}/test?dry_run=true
GET   /escalation-rules/logs?rule_id=&incident_id=&status=&limit=&offset=
```
- `_to_response()`: `webhook_headers` — yalnızca anahtar adları döndürülür (değerler maskelenir), `webhook_header_keys: list[str]`.
- Route: `/escalation-rules` + `RoleRoute(minRole="admin")` + Sidebar kaydı.

#### Frontend (`EscalationRules/index.tsx`)
- `RuleDrawer`: matcher alanları (severity/event_type/source/state multi-select, min_duration), webhook (type/url/headers JSON), cooldown.
- `LogsTab`: bildirim log tablosu — ✓ sent / ✗ failed / beaker dry_run ikonları.
- Inline dry-run sonuç `Alert` (matched/response_code gösterimi).

#### SSH Terminal İyileştirmeleri (Faz 4D kapsamında tamamlandı)
- `SshTerminalPage/index.tsx` — bağımsız full-screen sayfa (AppLayout yok).
- Toolbar: bağlantı durumu badge (connecting/connected/disconnected), Clear + Disconnect butonları.
- Cihaz listesinden SSH butonu yeni sekmede açılır (`window.open`).
- `buildWsUrl` (`ws.ts`): path'de `?` varsa `&token=...` kullanır — çift `?` hatası giderildi.

### Known Limitations — Güncel Durum

| ID | Durum | Açıklama |
|----|-------|---------|
| KL-1 | ✅ Faz 5A | `create_all` kaldırıldı — Alembic migration yönetimi |
| KL-2 | Açık | `sources`/`timeline` JSON vs JSONB — şu an sorunsuz |
| KL-3 | ✅ Faz 2A | RECOVERING sweep task eklendi |
| KL-4 | Açık | `queued_events` flush sırasında yeniden bağlantı — teorik duplicate, dedup ile karşılanıyor |
| KL-5 | ✅ Faz 2A | Multi-hop BFS suppression |
| KL-6 | ✅ Faz 3A | `_merge_intervals` ile çakışan downtime çift sayımı düzeltildi |
| KL-7 | ✅ Faz 4A | `_ab_peer_latency_loop` FastAPI bg task — gerçek A→B agent-to-agent latency ölçümü |
| KL-8 | Açık | `SyntheticProbe.runNow` `agent_id` gerektiriyor — agentsiz probe çalıştırılamaz |
| KL-9 | ✅ Faz 4B | 5 hypertable (TimescaleDB) — `device_availability_snapshots` + 4 diğer tablo dönüştürüldü |
| KL-10 | ✅ Faz 5D | `EscalationRule.webhook_headers` Fernet şifreli — startup migration tamamlandı |
| KL-11 | Açık | Escalation evaluator minimum tepki süresi 5 dk — çok kritik olaylar için azaltılabilir |

### Test Durumu

**236/236 test geçiyor** (Faz 4 kümülatif):
- `test_agent_peer_latency.py` — +9 test (4A)
- `test_faz4b_timescale.py` — 8 test (4B)
- `test_faz4c_sla_probes.py` — 13 test (4C)
- `test_faz4d_incidents.py` — 12 test (4D)
- `test_faz4e_escalation.py` — 20 test (4E)
- Önceki testler: 174 test (Faz 1–3)

---

## [Released] — Faz 3: Observability Foundation (3A → 3D)

### Merge: `feature/faz3d-dashboard-wiring` → `main`

> 34 dosya · +2311 satır · **174/174 test** · 0 TypeScript hatası · Vite build temiz  
> Tamamlandı: 2026-05-13

---

### Faz 3A — Interval Union Logic + Snapshot History

#### KL-6 Kapatıldı: `_merge_intervals` pure helper (`availability_tasks.py`)
- `_merge_intervals(intervals)` — örtüşen/bitişik downtime aralıklarını birleştirir.
- `compute_downtime_secs` güncellendi: tüm incident aralıkları `_merge_intervals` ile toplandıktan sonra hesaplanır; çakışan olaylar artık çift sayılmaz.
- Önceki davranış: port_down + device_unreachable aynı pencerede → downtime iki kez sayılıyor, `availability` hatalı düşüyordu.

#### `DeviceAvailabilitySnapshot` modeli (`device_availability_snapshot.py`)
- Günlük snapshot: `device_id`, `ts`, `availability_24h`, `availability_7d`, `mtbf_hours`, `experience_score`.
- İndeks: `(device_id, ts)` — 30 günlük sorgu için optimize.
- `availability_tasks._run()` her hesaplama döngüsünde snapshot ekler.
- Retention: 90 gün (`retention_tasks.py` mevcut cleanup pattern'ı genişletildi).

#### API: `GET /devices/{id}/availability?days=30`
```json
{
  "current": {"availability_24h": 0.985, "availability_7d": 0.991, "mtbf_hours": 72.3, "experience_score": 0.985},
  "history": [{"ts": "...", "availability_24h": 0.99, "availability_7d": 0.995, "experience_score": 0.98}, ...]
}
```

#### Yeni testler (`test_availability_scoring.py` genişletmesi)
- `test_overlapping_not_double_counted` — 2 çakışan incident → birleşik süre
- `test_fully_nested_incident` — nested incident → dış süre korunur
- `test_adjacent_incidents_merged` — bitişik aralıklar → tek interval
- `test_merge_intervals_unit` — pure helper doğrudan test

---

### Faz 3B — Synthetic Probe Modülü

#### `SyntheticProbe` + `SyntheticProbeResult` modelleri (`synthetic_probe.py`)
- Tip desteği: `icmp | tcp | http | dns`
- Alanlar: `target`, `port`, `http_method`, `expected_status`, `dns_record_type`, `interval_secs`, `timeout_secs`, `enabled`
- Sonuç: `success`, `latency_ms`, `detail`, `measured_at`

#### Agent Protocol Uzantısı (`netmanager_agent.py`)
- `synthetic_probe` mesaj tipi (backend→agent): probe parametrelerini iletir.
- `synthetic_probe_result` mesaj tipi (agent→backend): sonucu döner.
- Dispatcher:
  - `icmp` → subprocess ping (mevcut ping mantığı)
  - `tcp` → `_tcp_probe()` (mevcut)
  - `dns` → `socket.getaddrinfo` executor
  - `http` → `urllib.request.urlopen` executor (stdlib, sıfır bağımlılık)

#### `AgentManager.execute_synthetic_probe()` (`agent_manager.py`)
- WebSocket üzerinden agent'a probe gönderir, `synthetic_probe_result` yanıtını bekler.

#### `run_synthetic_probes` Celery task (`synthetic_tasks.py`)
- Her 60s çalışır (beat schedule).
- `interval_secs` geçmiş probe'ları seçer → agent'a gönderir → `SyntheticProbeResult` insert.
- Başarısız probe → `process_event(source="synthetic", is_problem=True, confidence=0.90)`.
- Önceden fail, şimdi success → recovery event.

#### API (`synthetic.py`)
```
GET/POST  /synthetic-probes
GET/PUT/DELETE  /synthetic-probes/{id}
GET  /synthetic-probes/{id}/results?limit=100
POST /synthetic-probes/{id}/run
```

---

### Faz 3C — Agent Peer Latency

#### `AgentPeerLatency` modeli (`agent_peer_latency.py`)
- `agent_from` (str, "backend" = backend sunucudan ölçüm), `agent_to` (FK → agents.id CASCADE)
- `target_ip`, `latency_ms`, `reachable`, `measured_at`
- İndeks: `(agent_to, measured_at)` + `agent_from`

#### `_measure_latency(ip, timeout)` pure helper (`agent_peer_tasks.py`)
- Subprocess ICMP ping; RTT regex: `time[<=](\d+\.?\d*)\s*ms`
- Fallback: RTT parse edilemezse wall-clock elapsed (ms).
- Tüm exception'lar (TimeoutExpired / FileNotFoundError / PermissionError) → `(False, None)`.

#### `measure_agent_peer_latency` Celery task
- Her 900s çalışır (beat schedule).
- Online + `last_ip` olan agentları DB'den çeker; her birine `_measure_latency` uygular.
- `agent_from="backend"` — gerçek A→B ölçümü FastAPI bg task olarak Faz 4'e ertelendi.

#### API (`agents.py` uzantısı)
```
GET /agents/{agent_id}/peer-latency?limit=50
GET /agents/peer-latency-matrix
→ {"agent_id": {"latency_ms": 0.039, "reachable": true, "target_ip": "...", "measured_at": "..."}}
```

---

### Faz 3D — Dashboard Wiring & Observability UI

#### G1: Fleet Aggregates (`monitor.py` + `Dashboard`)
- `/monitor/stats` yanıtına 2 yeni alan: `fleet_experience_score`, `fleet_availability_24h`
- Dashboard'a 2 StatCard: "Fleet Availability (24h %)" + "Experience Score"
- Early-return path'inde de `None` olarak eklendi.

#### G2: DeviceDetail "Availability" Sekmesi (`DeviceDetail.tsx`)
- 4 stat kutusu: 24h %, 7d %, MTBF (saat), Experience Score
- 30 günlük Recharts `AreaChart` — dual gradient: `experience_score` (mor) + `availability_7d` (yeşil)
- `enabled: activeTab === 'availability'` lazy loading, `refetchInterval: 300_000`
- MTBF null → "Yeterli veri yok" placeholder; history boş → empty state.

#### G3: Synthetic Probes Sayfası (`SyntheticProbes/index.tsx`)
- Probe tablosu: tip tag, enable toggle, "Şimdi Çalıştır", Popconfirm sil.
- Severity satır renklendirme: `icmp/tcp = critical (kırmızı)`, `http/dns = warning (sarı)` — `onRow` left-border + arka plan.
- Expandable satır: son 20 sonuç (`ProbeResultsTable`).
- `ProbeDrawer`: tip bazlı dinamik alanlar (port / http_method / expected_status / dns_record_type).
- Route: `/synthetic-probes` + `PermRoute(module="monitoring", action="view")` + Sidebar kaydı.

#### G4: Agents Peer Latency Matrix (`Agents/index.tsx`)
- `PeerLatencyMatrixCard` bileşeni: `useQuery(getPeerLatencyMatrix, refetchInterval=300s)`.
- Gecikme rengi: <10ms yeşil · <50ms amber · ≥50ms kırmızı.
- Expandable satır: `PeerLatencyHistory` — Recharts `LineChart` (son 50 ölçüm) + mini tablo.
- "Şimdi Yenile" butonu → `invalidateQueries(['peer-latency-matrix'])`.
- Boş state: "Henüz ölçüm yok — ilk ölçüm 15 dakika içinde yapılacak".

#### G5: Dashboard Incident Timeline (`Dashboard/index.tsx`)
- "Recent Alerts" bölümü geliştirildi: sol `3px solid` severity rengi, hostname cyan tag, HH:mm monospace timestamp, `overflowY: hidden`, first-event slide animasyonu.
- Veri kaynağı: mevcut `liveEvents` WebSocket state (yeni query yok).

#### Düzeltilen Hatalar (smoke test sırasında)
- `devices.py` `get_device_availability`: `from datetime import timezone` → `from datetime import datetime, timedelta, timezone` (500 Internal Server Error düzeltildi).

### Known Limitations — Güncel Durum

| ID | Durum | Açıklama |
|----|-------|---------|
| KL-1 | Açık | `create_all` tablo yönetimi — Alembic yok, yeni kolon için `main.py` ALTER TABLE gerekli |
| KL-2 | Açık | `sources`/`timeline` JSON vs JSONB — şu an sorunsuz |
| KL-3 | ✅ Faz 2A | RECOVERING sweep task eklendi |
| KL-4 | Açık | `queued_events` flush sırasında yeniden bağlantı — teorik duplicate, dedup ile karşılanıyor |
| KL-5 | ✅ Faz 2A | Multi-hop BFS suppression |
| KL-6 | ✅ Faz 3A | `_merge_intervals` ile çakışan downtime çift sayımı düzeltildi |
| KL-7 | Açık | `agent_from="backend"` — gerçek A→B agent-to-agent latency ölçümü henüz yok. Faz 4'te FastAPI bg task olarak planlandı |
| KL-8 | Açık | `SyntheticProbe.runNow` `agent_id` gerektiriyor — agentsiz probe çalıştırılamaz; isteğe bağlı local fallback Faz 4'te değerlendirilebilir |
| KL-9 | Açık | `DeviceAvailabilitySnapshot` düz PostgreSQL tablo — 1000+ cihaz × 365 gün sonrasında sorgu yavaşlayabilir. TimescaleDB hypertable Faz 4 kapsamında |

### Test Durumu

**174/174 test geçiyor** (Faz 3 kümülatif):
- `test_availability_scoring.py` — 35 test (KL-6 fix + merge_intervals dahil)
- `test_availability_snapshot.py` — 4 test (snapshot insert + retention)
- `test_synthetic_probes.py` — 27 test (CRUD, agent dispatch, recovery event, result query)
- `test_agent_peer_latency.py` — 12 test (RTT parse, fallback, subprocess exception handling)
- Önceki testler: 96 test (Faz 1–2D)

---

## [Unreleased] — Faz 2D: Availability Scoring

### Merge: `feature/faz2d-availability-scoring` → `main`

---

### Yeni Özellikler

#### G7 — Availability Score Fields (`device.py` + `main.py`)
- `Device` modeline 4 nullable Float alan eklendi:
  - `availability_24h` — son 24 saatin incident-free fraksiyonu (0.0–1.0)
  - `availability_7d` — son 7 günün incident-free fraksiyonu (0.0–1.0)
  - `mtbf_hours` — son 7 gündeki MTBF (saat); veri yetersizse `None`
  - `experience_score` — composite kalite skoru (0.0–1.0)
- `main.py` lifespan bloğuna 4 idempotent `ALTER TABLE devices ADD COLUMN IF NOT EXISTS FLOAT` satırı eklendi.

#### G8 — Experience Score + Daily Celery Task (`availability_tasks.py`)
- Yeni `backend/app/workers/tasks/availability_tasks.py` dosyası.
- **Pure helper fonksiyonlar** (test edilebilir, I/O bağımsız):
  - `compute_downtime_secs(incidents, window_start, window_end)` — SUPPRESSED hariç tüm aktif/kapalı incident sürelerini pencereye clip ederek toplar.
  - `compute_availability(downtime_secs, window_secs)` — `(window - downtime) / window`, `[0.0, 1.0]` clamp.
  - `compute_mtbf_hours(incidents, window_start, window_end)` — `window_hours / closed_count`; veri yoksa `None`.
  - `compute_experience_score(availability_24h, last_severity, last_source)`:
    ```
    = availability_24h * 0.50
    + (1 - SEVERITY_PENALTY[last_severity]) * 0.30
    + SOURCE_CONFIDENCE[last_source] * 0.20
    ```
- **`compute_availability_scores()` Celery task** — aktif tüm cihazları toplu hesaplar, `asyncio.run(_run())` pattern (lifecycle_tasks.py ile aynı).
- Beat schedule: `update-device-availability-scores-daily` → 86400s.

### Known Limitations

#### KL-6: Overlapping Incident Downtime
`compute_downtime_secs` aynı cihazda eş zamanlı açık birden fazla incident'ı bağımsız toplar. Aynı zaman diliminde `port_down` + `device_unreachable` varsa downtime çift sayılabilir ve `availability < 0` sonucu üretebilir (`compute_availability` bunu 0.0'a clip eder ama metrik hatalı kalır). Faz 3'te interval union/merge logic ile düzeltilebilir.

### Testler

- `backend/tests/test_availability_scoring.py` — 27 yeni test:
  - `compute_downtime_secs`: boş liste, tam pencere, yarım pencere, OPEN/DEGRADED/RECOVERING/SUPPRESSED states, pencere başı/sonu clip, çakışan iki incident
  - `compute_availability`: 1.0, 0.0, 0.5, clamp sınırları, sıfır pencere
  - `compute_mtbf_hours`: None durumları, 1 kapalı, 3 kapalı, SUPPRESSED dahil edilmez
  - `compute_experience_score`: perfect score, critical+full outage, formula bileşen doğrulama, clamp korumaları

**Toplam: 121/121 test geçiyor** (9 + 16 + 11 + 42 + 16 + 27).

---

## [Unreleased] — Faz 2B: Syslog Normalization Engine

### Merge: `feature/faz2b-syslog-normalization` → `main`

---

### Yeni Özellikler

#### G4 — Syslog Normalization Engine (syslog_normalizer.py)
- Yeni `NormalizedEvent(event_type, component, is_problem, severity)` dataclass.
- İlk-eşleşme kazanır (`_RULES` listesi, en özelden genele sıralı) regex motoru.
- **Vendor kapsamı:**
  - **Cisco IOS/IOS-XE:** `%LINK UPDOWN`, `%LINEPROTO UPDOWN`, `%OSPF ADJCHG/ADJCHANGE`, `%BGP ADJCHANGE`, `%STP TOPOLOGY_CHANGE`, `BPDUGUARD`, `%SYS RELOAD`, `CONFIG_I`
  - **Aruba OS-CX:** `Port <name> is Down/Up`
  - **Ruijie RG-OS:** `link status changed to down/up`, `is turned down`
- **`AVAILABILITY_EVENT_TYPES`** = `{port_down, device_restart, routing_change, bgp_peer_down}` — yalnızca bu tipler correlation engine'e gönderilir.
- `config_change` ve `stp_event` normalize edilir (gelecekteki audit/notification için) ancak availability incident **açmaz**.
- Severity escalation: syslog `severity_int ≤ 2` (emergency/alert/critical) → `"critical"` override.
- Component extraction: trailing virgül/nokta temizlenir, çoklu boşluk normalize edilir.
- Bilinmeyen mesajlar → `None` (raw SyslogEvent buffer'ında kalır, correlation yok).

#### G5 — Syslog → Correlation Engine Wiring (agent_manager.py)
- `_handle_syslog_event()` güncellendi: raw `SyslogEvent` her zaman önce yazılıyor (ingest akışı değişmedi).
- `db.commit()` sonrası: `normalize()` → `AVAILABILITY_EVENT_TYPES` filtresi → `source_ip` ile `Device` lookup → `process_event(source="syslog")`.
- `device_id = None` (kayıt dışı IP) → correlation atlanır, ingest devam eder.
- `process_event` exception → non-fatal `log.warning`, ingest asla kırılmaz.

### Düzeltilen Hatalar (test sırasında yakalandı)

- **BGP "is now down" phrase:** `bgp.{0,40}neighbor\s+\S+\s+down` paterni `"neighbor X is now down"` formatında başarısız oluyordu — `bgp.{0,60}neighbor.{0,40}\bdown\b` ile genişletildi.
- **IS-IS ADJCHANGE vs ADJCHG:** `ADJCHG` paterni `ADJCHANGE` içeren IS-IS mesajlarını kaçırıyordu — `ADJ(?:CHG|CHANGE)` ile düzeltildi.

### Testler

- `backend/tests/test_syslog_normalizer.py` — 42 yeni test:
  - Per-pattern: Cisco / Aruba / Ruijie her vendor için ayrı test
  - Recovery (is_problem=False) path
  - Component extraction ve normalizasyon
  - config_change → AVAILABILITY_EVENT_TYPES dışı
  - stp_event → AVAILABILITY_EVENT_TYPES dışı
  - Unknown → None
  - Severity escalation (0–2 → critical)
  - Regression: STP mesajında "port" kelimesi port_down olarak eşleşmemeli

**Toplam: 78/78 test geçiyor** (9 + 16 + 11 + 42).

### Pre-Merge Kontrol Sonuçları

| Kontrol | Durum | Detay |
|---|---|---|
| Unknown syslog → sadece raw log | ✅ | `normalize()` None döndürür, correlation çağrısı yapılmaz |
| source_ip eşleşmez → ingest devam | ✅ | `db.commit()` device lookup'tan önce; `if device_id:` guard mevcut |
| config_change → incident açmaz | ✅ | `config_change ∉ AVAILABILITY_EVENT_TYPES`; `is_problem=False` |
| port_down → OPEN path | ✅ | `is_problem=True`, `port_down ∈ AVAILABILITY_EVENT_TYPES` |
| port_up → RECOVERING path | ✅ | `is_problem=False`, aynı fingerprint (port_down) → recovery çalışır |
| BGP/OSPF severity | ✅ | BGP severity=warning; syslog_int≤2 → critical escalation |
| correlation exception → ingest sağlam | ✅ | Inner try/except + outer try/except, debug log only |
| stp_event → no false-positive incident | ✅ | `stp_event ∉ AVAILABILITY_EVENT_TYPES` |
| Aruba / Ruijie vendor coverage | ✅ | Aruba port / Ruijie link-status test geçiyor |
| port_down/up fingerprint tutarlılığı | ✅ | İki event aynı fingerprint → lifecycle doğru çalışır |

---

## Faz 2A: Multi-Source Correlation Stability

### Merge: `feature/faz2a-multisource-stability` → `main`

---

### Yeni Özellikler

#### G1 — SNMP Trap → Correlation Engine (agent_manager.py)
- `linkDown`, `coldStart`, `warmStart` trap'ları correlation engine'e bağlandı → `OPEN` incident tetikler.
- `linkUp` trap'ı recovery path'i tetikler → incident `RECOVERING`'e geçer.
- `authFailure` correlation'a dahil edilmedi (security event, availability etkilemez).
- Raw `NetworkEvent` log akışı değişmedi — correlation failure asla ingest'i kesmez (non-fatal try/except wrapper).
- `SOURCE_CONFIDENCE["snmp_trap"] = 0.85` — agent health check'ten daha yüksek güven.

#### G2 — RECOVERING Sweep Task (correlation_tasks.py + celery_app.py) — **KL-3 kapatıldı**
- Yeni Celery task: `confirm_stale_recovering` — her **5 dakikada** beat ile çalışır.
- Celery broker geçici olarak down olduğunda `confirm_recovery` zamanlanamazsa incident `RECOVERING` state'inde takılı kalırdı (KL-3). Bu sweep task `RECOVERY_CONFIRM_SEC * 2 = 240s` geçmiş tüm `RECOVERING` incidentları otomatik olarak `CLOSED` yapar.
- Sweep noop olduğunda (stale incident yok) commit yapılmaz.

#### G3 — Multi-Hop BFS Upstream Suppression (correlation_engine.py + correlation_tasks.py) — **KL-5 kapatıldı**
- `check_upstream_suppression` tek-hop query yerine tam **BFS traversal** ile değiştirildi.
- Tek sorguda tüm `TopologyLink` satırları çekiliyor; `upstream_of: dict[int, set[int]]` in-memory map oluşturuluyor.
- BFS: `incident.device_id`'den başlayarak maksimum `UPSTREAM_BFS_MAX_DEPTH = 5` hop.
- **Cycle guard:** `visited` set — ring topolojilerde sonsuz döngü önleniyor.
- **Self-suppression fix:** `visited.discard(incident.device_id)` — döngüsel topolojide cihazın kendi incidenti kendini suppress edemez.
- Sync Celery task versiyonu (`_check_upstream_suppression_sync`) da aynı BFS pattern'ına güncellendi.
- Kapsam: access → distribution → core topolojileri (tipik 2–3 hop, maksimum 5).

### Düzeltilen Hatalar

- **BFS self-suppression (cycle topology):** Ring topolojide (A→B→A) BFS, A'yı `visited`'a ekleyip A'nın kendi incidentını upstream suppressor olarak buluyordu. `visited.discard(incident.device_id)` ile düzeltildi.
- **DetachedInstanceError (test fixture):** SQLAlchemy session kapandıktan sonra `instance.id` erişimi `DetachedInstanceError` atıyordu. Session blokları içinde ID'ler capture edildi.

### Testler

- `backend/tests/test_faz2a.py` — 11 yeni test:
  - **G1 (5 test):** linkDown açar, linkUp recovery, coldStart, ikinci kaynak DEGRADED, correlation failure ingest'i kesmez
  - **G2 (2 test):** stale sweep CLOSED yapar / fresh'i dokunmaz, noop (stale yok)
  - **G3 (4 test):** 3-hop BFS suppression, upstream incident yok → suppress edilmez, cycle guard, max depth aşılınca suppress edilmez

**Toplam: 36/36 test geçiyor** (9 agent_queue + 16 correlation_engine + 11 faz2a).

### Pre-Merge Kontrol Sonuçları

| Kontrol | Durum | Detay |
|---|---|---|
| main ile conflict | ✅ Yok | `git merge --no-commit --no-ff` temiz |
| Backend startup | ✅ | settings, Incident model, correlation_engine, correlation_tasks import zinciri sorunsuz |
| Celery beat schedule | ✅ | `confirm-stale-recovering-every-5min` → 300.0s kayıtlı |
| SNMP linkDown → OPEN | ✅ | `_TRAP_CORRELATION["linkDown"]` → `event_type=port_down, is_problem=True` |
| SNMP linkUp → RECOVERING | ✅ | `_TRAP_CORRELATION["linkUp"]` → `event_type=port_down, is_problem=False` |
| Multi-hop BFS 3-hop | ✅ | `test_multihop_bfs_3hop_suppression` PASSED |
| BFS cycle guard | ✅ | `test_multihop_bfs_cycle_guard` PASSED |
| BFS max depth sınırı | ✅ | `test_multihop_beyond_max_depth_not_suppressed` PASSED |

---

## Faz 1 MVP: Reliable Agent Core + Stateful Incident Correlation

### Merge: `feature/faz1-reliable-agent-correlation` → `main`

### Merge: `feature/faz1-reliable-agent-correlation` → `main`

---

### Yeni Özellikler

#### G1 — Agent Reconnect Backoff (netmanager_agent.py)
- WebSocket yeniden bağlanma backoff üst limiti 30s → **300s** olarak artırıldı.
- Uzun süreli kesintilerde rapid-reconnect storm'u önler.

#### G2 — Offline Monitoring Event Queue (agent_queue.py)
- Yeni `AgentEventQueue` sınıfı: SQLite WAL tabanlı, thread-safe, crash-safe offline buffer.
- Kapasite: **500.000 event** (gönderilmemiş); dolunca en eski event drop edilir.
- FIFO sıra garantisi, idempotent ack, 7 günlük otomatik prune.
- Agent bağlantısı kesildiğinde `device_status_report`, `syslog_event`, `snmp_trap` eventleri kuyruklanır.
- Yeniden bağlanmada `queued_events` mesajıyla toplu flush; server tarafında normal handler zinciri üzerinden işlenir.

#### G3 — Stateful Incident Lifecycle (correlation_engine.py + incident.py)
- Yeni `Incident` modeli (cross-database JSON, `Base.metadata.create_all` ile otomatik oluşur — Alembic gerekmez).
- **State machine:** `OPEN → DEGRADED → RECOVERING → CLOSED / SUPPRESSED`
- **Correlation kuralları:**
  - `group_wait` (30s): anlık glitch'leri filtreler — ilk event hemen Incident açmaz.
  - `bounce_guard` (60s): çok hızlı kapanmaları (flip-flop) yoksayar.
  - `flap_guard` (8 event / 300s pencere): event storm'unu suppress eder.
  - `DEGRADED` escalation: 2+ bağımsız kaynak aynı problemi onayladığında.
  - `RECOVERING → CLOSED` konfirmasyonu: 120s boyunca yeni problem gelmezse kapatır.
  - **Upstream suppression:** TopologyLink grafiği üzerinden upstream cihazın da down olduğu tespit edilince downstream incident `SUPPRESSED` olarak işaretlenir.
- Mevcut `NetworkEvent` akışı değiştirilmedi — correlation engine additive katman olarak eklendi.

### Düzeltilen Hatalar

- **Upstream suppression FK yönü:** `check_upstream_suppression` yanlış yönde sorgu yapıyordu (`WHERE neighbor_device_id = X` downstreamları döndürüyordu). `WHERE device_id = X → neighbor_device_id` ile düzeltildi.
- **Celery broker unreachable (problem path):** `open_incident_after_wait.apply_async` hatası yakalanmıyordu. Try/except ile sarıldı; failure'da `group_wait` Redis key'i temizlenerek sonraki event'in yeniden deneyebilmesi sağlandı.
- **Celery broker unreachable (recovery path):** `confirm_recovery.apply_async` da simetrik olarak sarılmadı. Düzeltildi — incident `RECOVERING` state'inde kalır (DB commit zaten yapıldı), broker failure yakalanarak loglanır.

### Testler

- `backend/tests/test_agent_queue.py` — 9 test: push/pop, ack, FIFO, overflow, thread safety, prune
- `backend/tests/test_correlation_engine.py` — 16 test: fingerprint, group_wait dedup, DEGRADED escalation, bounce guard, flap storm, upstream suppression, Celery failure (problem + recovery path), offline duplicate suppression

**Toplam: 25/25 test geçiyor.**

### Smoke Test Sonuçları (Statik Doğrulama)

Docker olmadan statik kod incelemesiyle doğrulanan maddeler:

| Kontrol | Durum | Detay |
|---|---|---|
| `incidents` tablosu otomatik oluşur | ✅ | `main.py:15` → `models/__init__.py:46` → `create_all:23` |
| Offline queue fill (health check) | ✅ | `netmanager_agent.py:1144` — ws.send failure → push |
| Offline queue fill (syslog) | ✅ | `netmanager_agent.py:848` |
| Offline queue fill (SNMP trap) | ✅ | `netmanager_agent.py:1031` |
| Reconnect flush FIFO sırası | ✅ | `pop_batch()` ts order; `test_fifo_order` |
| Celery guard (problem path) | ✅ | try/except + gw_key delete; `test_celery_down_does_not_break_flow` |
| Celery guard (recovery path) | ✅ | try/except, RECOVERING state korunur; `test_celery_down_during_recovery_leaves_recovering` |
| Upstream suppression | ✅ | `check_upstream_suppression` FK yönü düzeltildi; `test_upstream_suppression` |
| Duplicate event → tek incident | ✅ | `corr:gw:{fp}` Redis key dedup; `test_offline_duplicate_does_not_reopen_closed` |
| Correlation engine main flow'u kırmıyor | ✅ | `agent_manager.py:405-427` try/except non-fatal wrapper |

Docker ile yapılması gereken smoke testler:
- [ ] `docker compose up` → `incidents` tablosu `CREATE TABLE IF NOT EXISTS` logu
- [ ] Backend + Redis + Celery entegrasyon testi
- [ ] Agent offline/reconnect manuel senaryosu (`"Monitoring event queue flush: N event"` log satırı)
- [ ] `SELECT state, COUNT(*) FROM incidents GROUP BY state` sorgusu

---

### Known Limitations — Faz 2'ye Taşınan Konular

#### KL-1: `create_all` Tablo Yönetimi
Mevcut projede Alembic kullanılmıyor; tüm tablolar `Base.metadata.create_all` ile startup'ta oluşturuluyor. Bu yaklaşım yeni tablolar için sorunsuz çalışır, ancak **mevcut bir tabloya kolon eklenmesi** gerektiğinde `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` bloğunun `main.py` lifespan'ına manuel eklenmesi gerekir. Faz 2'de `incidents` tablosuna yeni kolon eklenmesi gerekirse bu pattern uygulanacak.

#### KL-2: JSON vs JSONB (sources, timeline kolonları)
`Incident.sources` ve `Incident.timeline` kolonları, cross-database uyumluluğu için `JSONB` yerine `JSON` tipiyle tanımlandı. Küçük array'ler (< 10 eleman) için performans farkı ihmal edilebilir. Ancak gelecekte `sources` üzerinde `jsonb @>` operatörüyle filtreleme yapılması gerekirse (örn. "source='gnmi' olan tüm incidentlar") `JSONB`'ye dönüş ve sütun migration'ı değerlendirilmeli.

#### ~~KL-3: Celery Worker Kapalıyken Incident Lifecycle Davranışı~~ ✅ Faz 2A'da kapatıldı
- **Problem path:** Celery down → `open_incident_after_wait` zamanlanamaz → `group_wait` key temizlenir → sonraki event yeniden dener. Incident açılmaz, kayıp yok.
- **Recovery path:** Celery down → `confirm_recovery` zamanlanamaz → incident `RECOVERING` state'inde kalır, kapanmaz. **Faz 2A'da `confirm_stale_recovering` beat task eklendi** — 240s üzerinde `RECOVERING` kalan incidentlar otomatik `CLOSED` yapılıyor.
- Celery broker tamamen down olduğunda mevcut `DEGRADED` incidentlar state değiştirmez — kabul edilebilir; yeni eventler geldiğinde state machine devam eder.

#### KL-4: `queued_events` Flush Sırasında Tekrar Bağlantı Kesilmesi
Reconnect sonrası flush sırasında bağlantı yeniden kopsa, `ack` yapılmamış batch bir sonraki reconnect'te tekrar gönderilir (idempotent). `process_event` içindeki `group_wait` key dedup sayesinde duplicate incident üretilmez. Ancak son batch'in kısmen işlenip kısmen işlenmeme durumu (server-side `create_task` çağrıldı, ack gelmedi) teorik olarak mümkün; bu durumda aynı event iki kez işlenebilir. `NetworkEvent` dedup Redis key'i (mevcut altyapı) bu tekrarları zaten filtreler.

#### ~~KL-5: Upstream Suppression Tek Hop~~ ✅ Faz 2A'da kapatıldı
~~`check_upstream_suppression` yalnızca **tek hop** upstream kontrol eder.~~ **Faz 2A'da** tam BFS traversal ile değiştirildi: tek sorgu + in-memory map + max 5 hop + visited-set cycle guard. Access → distribution → core topolojileri artık doğru şekilde cascade suppress eder.

---

*Önceki değişiklikler için git log'a bakın: `git log --oneline`*
