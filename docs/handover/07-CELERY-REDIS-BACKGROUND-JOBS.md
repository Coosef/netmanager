# 07 — Celery, Redis ve Background Job'lar

## 1. Üst düzey görünüm

| Servis | Görev | Queue | Concurrency | mem_limit |
|---|---|---|---|---|
| `celery_beat` | Scheduler (33 task) | — | — | 512m |
| `celery_worker` | Monitor + topology + analytics + mac_arp + SNMP | `monitor` | 16 | 3g |
| `celery_agent_worker` | Synthetic probes, agent peer latency | `agent_cmd` | 8 | 1g |
| `celery_default_worker` | Backup, correlation, bulk SSH/config | `default`, `bulk` | 8 | 2g |
| `event_consumer` | Redis stream drain (ingest:syslog) | — (worker değil) | — | 512m |
| `flower` | Celery UI (basic auth) | — | — | — |

Kaynak: [docker-compose.yml](../../docker-compose.yml) + [backend/app/workers/celery_app.py](../../backend/app/workers/celery_app.py).

## 2. Queue routing politikası

`celery_app.py task_routes`:

| Modül | Queue |
|---|---|
| `bulk_tasks.*` | `bulk` |
| `monitor_tasks.*`, `topology_tasks.*`, `playbook_tasks.*`, `notification_tasks.*`, `mac_arp_tasks.*`, `security_audit_tasks.*`, `lifecycle_tasks.*`, `snmp_tasks.*`, `rotation_tasks.*`, `rollout_tasks.*`, `behavior_analytics_tasks.*` | `monitor` |
| `synthetic_tasks.*`, `agent_peer_tasks.*` | `agent_cmd` |
| Diğer hepsi | `default` |

`celery_worker` yalnız `monitor` dinler; `celery_agent_worker` yalnız `agent_cmd`; `celery_default_worker` `default,bulk` dinler.

## 3. Beat — periyodik task'lar (33 schedule)

| Task | Periyot | Queue |
|---|---|---|
| `monitor_tasks.poll_device_status` | 5 dk | monitor |
| `correlation_tasks.confirm_stale_recovering` | 5 dk | default |
| `bulk_tasks.scheduled_backup` | 24 saat | bulk |
| `bulk_tasks.check_backup_schedules` | 1 dk | bulk |
| `topology_tasks.scheduled_topology_discovery` | 6 saat | monitor |
| `playbook_tasks.run_scheduled_playbooks` | 1 dk | monitor |
| `notification_tasks.process_notifications` | 5 dk | monitor |
| `notification_tasks.send_weekly_digest` | 7 gün | monitor |
| `mac_arp_tasks.collect_mac_arp_all` | 15 dk | monitor |
| `monitor_tasks.cleanup_stale_tasks` | 30 dk | monitor |
| `snmp_tasks.poll_snmp_all` | 5 dk | monitor |
| `lifecycle_tasks.check_lifecycle_expirations` | 24 saat | monitor |
| `security_audit_tasks.scheduled_compliance_scan` | 7 gün | monitor |
| `rotation_tasks.check_rotation_policies` | 24 saat | monitor |
| `backup_tasks.check_config_drift` | 24 saat | default |
| `behavior_analytics_tasks.update_baselines` | 24 saat | monitor |
| `behavior_analytics_tasks.detect_anomalies` | 30 dk | monitor |
| `behavior_analytics_tasks.check_topology_drift` | 6 saat | monitor |
| `retention_tasks.cleanup_old_data` | 24 saat | default |
| `sla_tasks.check_sla_breaches` | 24 saat | default |
| `availability_tasks.compute_availability_scores` | 24 saat | default |
| `synthetic_tasks.run_synthetic_probes` | 1 dk | agent_cmd |
| `agent_peer_tasks.measure_agent_peer_latency` | 15 dk | agent_cmd |
| `escalation_tasks.evaluate_escalation_rules` | 5 dk | default |
| `metrics_tasks.collect_infrastructure_metrics` | 1 dk | default |
| `cache_warmer_tasks.warm_aggregation_cache` | 60 sn | default |
| `maintenance_tasks.spawn_cyclic_maintenance_windows` | 1 saat | default |
| `poe_tasks.snapshot_poe_status` | 15 dk | default |
| `security_policy_tasks.poll_device_health` | 5 dk | default |
| `security_policy_tasks.poll_mac_anomalies` | 15 dk | default |
| `ipam_tasks.sync_arp_to_ipam` | 15 dk | default |
| `ipam_tasks.check_subnet_utilization` | 1 saat | default |
| `terminal_session_tasks.cleanup_stale_sessions` | 1 saat | default |

Kaynak: [backend/app/workers/celery_app.py](../../backend/app/workers/celery_app.py).

## 4. MAC / ARP / PoE / VLAN collection davranışları

### MAC + ARP
- Task: `mac_arp_tasks.collect_mac_arp_all`
- Cycle: **15 dk**
- Hedef cihazlar: `Device.is_active==True AND Device.status=='online'` (kaynak: ilgili task modülü)
- Cihaz başına: agent-relay SSH → cihaz tipine göre `show mac-address-table` / `show arp` → parser → `mac_address_entries` / `arp_entries` tablolarına INSERT

### PoE
- Task: `poe_tasks.snapshot_poe_status`
- Cycle: **15 dk**
- SNMP-first, başarısızsa SSH fallback (`with org_context(device.organization_id, device.location_id)` zorunlu)
- Tablo: `poe_port_snapshots`

### VLAN
- ⚠ **Şu an periyodik bir VLAN collector YOK**. UI'da VLAN bilgisi cihaz başına on-demand SSH ile alınır (`devices/{id}/vlans` endpoint'i + Redis cache).
- Bu boşluk [12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) içinde işaretli.

## 5. Worker health kontrolleri

| Komut | Risk | Beklenen çıktı |
|---|---|---|
| `docker compose ps` | READ ONLY | Tüm celery_* satırlarda `healthy` |
| `docker compose exec celery_worker celery -A app.workers.celery_app inspect ping --timeout=5` | READ ONLY | `pong` |
| `docker compose exec celery_worker celery -A app.workers.celery_app inspect active` | READ ONLY | Aktif task listesi |
| `docker compose exec celery_worker celery -A app.workers.celery_app inspect stats` | READ ONLY | Pool stats |
| `docker compose exec celery_worker celery -A app.workers.celery_app inspect reserved` | READ ONLY | Queue prefetch listesi |
| Flower UI | READ ONLY | http://localhost:5555 (dev overlay sonrası); basic auth |

Healthcheck (compose):
- Worker: `inspect ping --destination=<name>@$HOSTNAME`
- Beat: `grep -aq beat /proc/1/cmdline` (beat scheduler `inspect ping`'e cevap vermez)
- Backend: `python3 -c "import urllib.request; ..."` /health/live
- event_consumer: Redis'te `event_consumer:alive` key'i var mı (TTL 30s)

## 6. Exit 137 / graceful stop / OOM farkı

Docker container exit kodları:

| Kod | Anlam |
|---|---|
| `0` | Graceful shutdown (planlı stop) |
| `137` | SIGKILL — genellikle OOM Killer (mem_limit aşımı) veya `docker kill` |
| `143` | SIGTERM — Compose'un graceful stop deadline'ı aştığında düşürdüğü sinyal |
| `1` veya değişken | Uygulama içi exception ile çıkmış |

**Önemli ayrım:**
- `137` her zaman OOM değildir; manuel `docker kill` da 137 verir.
- OOM'u doğrulamak için: `dmesg | grep -i oom` veya `docker inspect <container> --format='{{.State.OOMKilled}}'`.

İncident sprint 2026-06'da `prom_multiproc` tmpfs saturation sonrası celery worker'ların SIGBUS aldığı kayda geçmiştir; bunun fix'i `docker-compose.yml` içinde tmpfs boyutunu 64m→256m yapmak + `app/workers/signals.py mark_process_dead` hook'u olmuştur (docker-compose.yml yorumlarında detay).

## 7. Recovery prosedürü (`SAFE RESTART`)

Bir worker exit etmişse:

1. `[READ ONLY]` Son 100 satır log: `docker compose logs --tail=100 celery_worker`
2. `[READ ONLY]` OOM mı? `docker inspect <id> --format='{{.State.OOMKilled}}'`
3. Eğer OOM: ilgili cihazlar/task'lar son bir saatte değişti mi? (yüksek-RAM yük üreten task)
4. `[SAFE RESTART]` `docker compose restart celery_worker` (veya hangi worker ise)
5. `[READ ONLY]` Restart sonrası `inspect ping` cevap veriyor mu

Genel kural: **önce log, sonra restart**. Body kaybeden bir task varsa `task_acks_late=True` ile yeniden teslim edilir.

## 8. Queue purge yasağı ve riskleri

Aşağıdaki komutlar **DO NOT RUN CASUALLY**:

```bash
# DO NOT RUN CASUALLY
docker compose exec celery_worker celery -A app.workers.celery_app purge -f
# DO NOT RUN CASUALLY
docker compose exec redis redis-cli -n 0 FLUSHDB
# DO NOT RUN CASUALLY
docker compose exec redis redis-cli DEL celery
```

Riskler:
- Pending backup task'ları silinir → backup penceresi kaçırılır.
- Periyodik task ledger'ı silinir → beat memory'sinde tutmadığı state kaybolur.
- Schedule-based stop key'leri silinir → terminal session cleanup kaybolur.
- "Orphaned 'celery' queue" benzeri tarihsel temizlik bir defaya mahsus, kontrollü yapıldı (historical internal context — VERIFY BEFORE HANDOVER) — her zaman böyle yapılmaz.

**Eğer queue'da gerçekten yığılma varsa:**
1. Önce **why**: hangi task yığılıyor (`inspect active` + `inspect reserved`)?
2. Yığılan task uzun süredir asılı (~saat) mı yoksa task'lar hızlı tüketiliyor mu?
3. Saat süredir asılı bir task varsa: o cihaz/kaynak unreachable olabilir; cihaz tarafı düzelmeden purge çözüm değil.
4. Geçici olarak: yeni task üretimini durdur (`celery_beat stop`) → tüketim azalır.
5. Asla `purge` ilk başvuru değil.

## 9. VLAN snapshot için mevcut tasarım boşluğu

- `vlan_snapshots` (varsa) tablosu için **periyodik bir Celery task'ı yok**.
- `behavior_analytics_tasks.check_topology_drift` 6 saatte bir çalışıyor ama VLAN spesifik snapshot çıkartmıyor.
- `mac_arp_tasks` MAC tablosunu cihazın user/privileged mode başarısına bağlı çekiyor; VLAN ekrana on-demand geliyor.

**Sonuç:** VLAN değişikliği audit'i ve drift detection için bir gap var. [12](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) içinde TD-VLAN-COLLECTOR olarak işaretli.

## 10. event_consumer kapsamı

- Bağımsız Python servisi (`python -m app.services.event_consumer`)
- Redis stream `ingest:syslog`'u drain eder
- Database'e `events` veya `syslog_events` (⚠ VERIFY) tablosuna batch INSERT
- Backend (control plane) DB pool'unun syslog burst'larıyla yorulmaması için ayrılmıştır (Faz 6C — KI-4)
- Healthcheck: Redis'te `event_consumer:alive` key var mı (TTL 30s heartbeat)

Syslog kaynağı:
- Cihazlar agent'a syslog gönderir (varsa) veya backend'in `/api/v1/syslog/ingest` endpoint'ine HTTP POST
- Agent buffered olarak Redis stream'e push eder
- event_consumer pull eder + DB'ye yazar

> ⚠ **VERIFY BEFORE HANDOVER**: Üretimdeki syslog akışı; agent path mi backend HTTP path mi yoksa her ikisi de mi?

## 11. Operational runbook eksikleri

- "OOM sonrası hangi worker'ı önce restart?" sırasının yazılı runbook'u yok.
- "Beat schedule'u test sırasında geçici devre dışı bırakma" pattern'i yok (çözüm: `celery_beat` servisi stop edilir, ama tek tek schedule kapatma yok).
- Flower'ı production'da expose etmek yasak — debug için `docker-compose.dev.yml` overlay'i gerekiyor; bu prosedür her ekipte tekrar değil.

## 12. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- 3 worker queue ayrımı + concurrency (compose + `celery_app.py task_routes`)
- 33 beat schedule listesi (`celery_app.py beat_schedule`)
- Task soft/hard time limit (`task_soft_time_limit=1200`, `task_time_limit=1500`)
- `worker_max_memory_per_child=524288` (512 MB recycle)
- Healthcheck patternları (compose)

### VERIFY BEFORE HANDOVER
- Üretimdeki tipik queue depth (boş mu, dolu mu)
- En son OOM olayı ne zaman, hangi worker'da
- event_consumer'ın hangi syslog volüm'ünü drain ettiği
- `retention_tasks.cleanup_old_data` her gece neyi siliyor (audit_logs > 90 gün mü, vb.)
- `vlan_snapshots` tablosu üretimde mevcut mu (varsa kim besliyor)
