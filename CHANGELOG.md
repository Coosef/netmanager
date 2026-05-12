# Changelog

## [Unreleased] — Faz 1 MVP: Reliable Agent Core + Stateful Incident Correlation

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

#### KL-3: Celery Worker Kapalıyken Incident Lifecycle Davranışı
- **Problem path:** Celery down → `open_incident_after_wait` zamanlanamaz → `group_wait` key temizlenir → sonraki event yeniden dener. Incident açılmaz, kayıp yok.
- **Recovery path:** Celery down → `confirm_recovery` zamanlanamaz → incident `RECOVERING` state'inde kalır, kapanmaz. **Faz 2'de periyodik bir sweep task** (`confirm_stale_recovering`) eklenerek bu durum kapatılacak: X dakikadan uzun süre `RECOVERING` kalan incidentlar otomatik `CLOSED` yapılacak.
- Celery broker tamamen down olduğunda mevcut `DEGRADED` incidentlar state değiştirmez — bu kabul edilebilir; yeni eventler geldiğinde state machine devam eder.

#### KL-4: `queued_events` Flush Sırasında Tekrar Bağlantı Kesilmesi
Reconnect sonrası flush sırasında bağlantı yeniden kopsa, `ack` yapılmamış batch bir sonraki reconnect'te tekrar gönderilir (idempotent). `process_event` içindeki `group_wait` key dedup sayesinde duplicate incident üretilmez. Ancak son batch'in kısmen işlenip kısmen işlenmeme durumu (server-side `create_task` çağrıldı, ack gelmedi) teorik olarak mümkün; bu durumda aynı event iki kez işlenebilir. `NetworkEvent` dedup Redis key'i (mevcut altyapı) bu tekrarları zaten filtreler.

#### KL-5: Upstream Suppression Tek Hop
`check_upstream_suppression` yalnızca **tek hop** upstream kontrol eder (doğrudan `TopologyLink` komşular). Çok katmanlı topolojilerde (access → distribution → core) bir distribution switch down olduğunda, core'a bağlı access switch'lerin incidentları suppress edilmeyebilir. Faz 2'de BFS tabanlı multi-hop upstream traversal eklenecek — mevcut `monitor_tasks.py`'deki BFS altyapısı yeniden kullanılabilir.

---

*Önceki değişiklikler için git log'a bakın: `git log --oneline`*
