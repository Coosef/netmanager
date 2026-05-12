# Changelog

## [Unreleased] — Faz 2A: Multi-Source Correlation Stability

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
