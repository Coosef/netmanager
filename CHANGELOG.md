# Changelog

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
| KL-1 | Açık | `create_all` tablo yönetimi — Alembic yok, yeni kolon için `main.py` ALTER TABLE gerekli |
| KL-2 | Açık | `sources`/`timeline` JSON vs JSONB — şu an sorunsuz |
| KL-3 | ✅ Faz 2A | RECOVERING sweep task eklendi |
| KL-4 | Açık | `queued_events` flush sırasında yeniden bağlantı — teorik duplicate, dedup ile karşılanıyor |
| KL-5 | ✅ Faz 2A | Multi-hop BFS suppression |
| KL-6 | ✅ Faz 3A | `_merge_intervals` ile çakışan downtime çift sayımı düzeltildi |
| KL-7 | ✅ Faz 4A | `_ab_peer_latency_loop` FastAPI bg task — gerçek A→B agent-to-agent latency ölçümü |
| KL-8 | Açık | `SyntheticProbe.runNow` `agent_id` gerektiriyor — agentsiz probe çalıştırılamaz |
| KL-9 | ✅ Faz 4B | 5 hypertable (TimescaleDB) — `device_availability_snapshots` + 4 diğer tablo dönüştürüldü |
| KL-10 | Açık | `EscalationRule.webhook_headers` düz metin JSON — şifreleme Faz 5 kapsamında (credential vault ile) |
| KL-11 | Açık | Escalation evaluator minimum tepki süresi 5 dk — çok kritik olaylar için azaltılabilir (Faz 5) |

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
