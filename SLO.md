# NetManager — SLO / SLA Hedefleri

> Son güncelleme: 2026-05-14  
> Platform: FastAPI · Celery · Redis · TimescaleDB · Docker

---

## Availability

| Metrik | Hedef | Ölçüm Yöntemi |
|--------|-------|---------------|
| API Availability (aylık) | ≥ 99.5% | `/health/ready` HTTP 200 oranı |
| Planned Downtime (aylık) | ≤ 30 dk | Maintenance window'lar hariç |
| Unplanned Downtime (aylık) | ≤ 3.6 saat | `docker compose ps` uptime log |

---

## Latency

| Metrik | Hedef | Ölçüm Yöntemi |
|--------|-------|---------------|
| API P50 Latency | < 100ms | `http_request_duration_seconds` (Prometheus) |
| API P95 Latency | < 500ms | Prometheus histogram |
| API P99 Latency | < 2s | Prometheus histogram |
| WebSocket event teslim | < 1s (normal koşullar) | `events.pushed_at` → `received_at` |
| SNMP poll gecikme | ≤ 5 dk (hedeflenen interval'den sapma) | Beat schedule vs actual run |

---

## Task Completion

| Görev Tipi | Hedef Tamamlanma | Hard Limit |
|-----------|------------------|------------|
| SSH komut (tekil) | < 30s | 25 dk (global Celery) |
| Bulk backup (50 cihaz) | < 10 dk | 60 dk (per-task override) |
| Rollout/Rollback | < 60 dk | 65 dk (per-task override) |
| Topology discovery | < 5 dk | 12 dk (per-task override) |
| SNMP single poll | < 5s | 25 dk |

---

## Incident Detection & Response

| Metrik | Hedef | Notlar |
|--------|-------|--------|
| Incident detection latency | < 5 dk (event_ts → incident.opened_at) | SNMP 5 dk beat + processing |
| Escalation notification | < 10 dk kritik olaylar için | `evaluate_escalation_rules` her 5 dk |
| Incident auto-close (RECOVERING) | ≤ 15 dk | `confirm_stale_recovering` her 5 dk |
| False positive rate | < 5% (haftalık) | Manuel review ile izlenir |

---

## Resilience Metrikleri

| Metrik | Hedef | Uygulama |
|--------|-------|---------|
| **Redis degraded recovery** | < 60s Redis yeniden başlayınca | `ExponentialBackoff(cap=10, base=0.5)` × 6 retry |
| **WebSocket reconnect** | ≤ 10 deneme, maks ~47s (jitter dahil) | `useReconnectingWebSocket` hook — backoff formula: `min(1000·2^n, 20000) + rand(0,1000)` |
| **Backend startup (DB timeout)** | Başlatma 30s içinde ya da `RuntimeError` | `_asyncio_timeout(30)` startup probe |
| **Celery worker memory recycle** | Worker 512 MB sonrası yeni child | `worker_max_memory_per_child=524288` |
| **Docker restart (healthcheck)** | Container unhealthy → restart | `restart: unless-stopped` + healthcheck |
| **Redis transient outage visibility** | `/health/ready` → HTTP 503 (degraded) anında | `_check_redis()` catch + degraded response |

---

## Recovery Objectives

| Senaryo | RTO | RPO |
|---------|-----|-----|
| Backend yeniden başlatma | < 2 dk | 0 |
| Celery worker yeniden başlatma | < 1 dk | 0 (task yeniden kuyruğa alınır) |
| Redis yeniden başlatma | < 30 sn | 0 (DB state korunur) |
| PostgreSQL restore (pg_dump) | < 30 dk | 24 saat |
| Tam stack yeniden başlatma | < 5 dk | 24 saat |
| Key rotation acil durumu | < 15 dk | 0 |

---

## Monitoring & Alerting

### Mevcut

| Araç | Kullanım |
|------|---------|
| `/health/ready` | Docker healthcheck + CI smoke test |
| `/metrics` | Prometheus scrape endpoint (multiprocess) |
| `scripts/netmanager-verify.sh` | Post-deploy gate (CI/CD) |
| Flower (`:5555`) | Celery task geçmişi ve worker durumu |
| structlog JSON | Container log aggregation |

### Önerilen (İleri Faz)

| Araç | Amaç |
|------|------|
| Grafana | `/metrics` dashboard + alert rules |
| Alertmanager | `http_error_rate > 5%` → bildirim |
| Uptime Kuma | Harici `/health/ready` ping (5 dk) |
| Loki | Container log aggregation + query |

---

## SLO İhlal Prosedürü

1. **Detection** — Prometheus alert veya `netmanager-verify.sh` FAIL
2. **Triage** — `/health/ready` bileşen breakdown → hangi servis etkileniyor?
3. **Müdahale** — `DISASTER_RECOVERY.md` ilgili servis bölümü
4. **Post-mortem** — 24 saat içinde CHANGELOG'a özet not

---

## Test Edilmiş Senaryolar (Faz 5E)

| Senaryo | Sonuç | Tarih |
|---------|-------|-------|
| Redis `pause` → `unpause` | degraded (503) → ok (200), crash yok | 2026-05-14 |
| Backend `restart` sırasında task | Task yeniden kuyruğa alındı | 2026-05-14 |
| Celery memory limit (smoke) | `max_memory_per_child` yapılandırması doğrulandı | 2026-05-14 |
| WS reconnect (birim test) | 10 deneme, `onFailed` callback doğru | 2026-05-14 |
| BG task cancel (shutdown) | `asyncio.CancelledError` yakalandı, orphan yok | 2026-05-14 |
