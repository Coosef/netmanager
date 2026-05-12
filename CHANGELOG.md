# Changelog

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
