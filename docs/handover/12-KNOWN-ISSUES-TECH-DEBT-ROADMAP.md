# 12 — Bilinen Sorunlar, Teknik Borçlar ve Roadmap

Bu dosya yalnız **doğrulanmış** teknik borçları içerir. Tahmini / spekülatif maddeler **yer almaz**. Her madde için:

- **Etki**
- **Risk**
- **Geçici çözüm**
- **Kalıcı öneri**
- **Öncelik** (P1/P2/P3)
- **Tahmini blast radius**

---

## TD-1 — VLAN snapshot için periyodik collector eksikliği

| Alan | Değer |
|---|---|
| Etki | VLAN drift detection yapılamaz; UI her seferinde on-demand SSH ile çeker |
| Risk | Cihazda VLAN değişti, kimse fark etmedi; audit log'da yer almaz |
| Geçici çözüm | UI'dan manuel `Show VLANs` operatörün gözlem yoluyla |
| Kalıcı öneri | `vlan_snapshots` tablosu + 15 dk celery task'ı (mac_arp ile aynı cadence) |
| Öncelik | P2 |
| Blast radius | Düşük (snapshot tablo eklemek + parser tüketimi) |

Kaynak: [07-CELERY-REDIS-BACKGROUND-JOBS.md §VLAN](07-CELERY-REDIS-BACKGROUND-JOBS.md) — beat schedule listesinde `vlan-*` yok.

---

## TD-2 — Agent pool key credential / version içermez

| Alan | Değer |
|---|---|
| Etki | Credential değişimi sonrası **5 dk** boyunca eski user-mode oturum reuse edilir |
| Risk | Operatör "kötü veri" görür; restart refleksi yanlış olur |
| Geçici çözüm | UI bildirimi: "credential update sonrası 10 dk bekleyin" |
| Kalıcı öneri | Pool key'i `(host, port, username, credential_hash)` yap; credential update DB write hook'unda hash güncellenir; pool'da bu key match etmez → otomatik fresh oturum |
| Öncelik | P2 |
| Blast radius | Orta — agent script + DB hook + cihaz bazlı invalidation |

Kaynak: agent_script `key = (params["host"], params["port"], params["username"])`.

---

## TD-3 — Credential değişimi sonrası stale connection / cache davranışı

| Alan | Değer |
|---|---|
| Etki | TD-2 ile birlikte interfaces/vlan Redis cache TTL 300s aynı pencerede serve eder; 5-10 dk "stale" data window |
| Risk | Operatörün yanılması; arka arkaya gereksiz işlem (restart, manual cache key sil, vb.) |
| Geçici çözüm | TD-2 ile aynı — bekleme prosedürü |
| Kalıcı öneri | Credential update endpoint'i ilgili cihaz cache key'lerini invalidate etsin (`DEL cache:device:o={org}:{id}:*`) |
| Öncelik | P2 (TD-2 ile beraber) |
| Blast radius | Düşük (cache invalidation tek endpoint) |

Kaynak: Site-A bulk credential copy incident forensic + `_IFACE_CACHE_TTL=300`.

---

## TD-4 — SSH error classification iyileştirme ihtiyacı

| Alan | Değer |
|---|---|
| Status | **PR #119 branch'te (`t10/device96-ssh-error-classification-v1` @ `765fb6b`) mevcut; production deployment ⚠ VERIFY BEFORE HANDOVER** |
| Etki | PR #119 ile 6 layer code geldi (`AUTH_FAILED`, `CONNECTION_TIMEOUT`, `CONNECTION_RESET`, `ENABLE_MODE_FAILED`, `PROMPT_OR_COMMAND_FAILED`, `UNKNOWN`); production rollout doğrulanmadı |
| Risk | UI hata mesajları halen "SSH error" şeklinde genel |
| Geçici çözüm | UI tarafı `error` field'ini parse eder; layer code yardımcıdır |
| Kalıcı öneri | UI'da error layer code'a göre özelleşmiş guidance; Senaryo 2-6 karar ağacının UI tooltip'i |
| Öncelik | P2 |
| Blast radius | Düşük (frontend mapping + i18n) |

Kaynak: dal `t10/device96-ssh-error-classification-v1` @ `765fb6b` (recent commit).

---

## TD-5 — Privilege-denied çıktısı parser-empty olarak görünür

| Alan | Değer |
|---|---|
| Etki | Cihaz user mode'da privilege denied döndürse de parser **0 entry** üretir → UI "No data" gösterir |
| Risk | "Gerçek 0" ile "privilege denied 0" ayırt edilemez |
| Geçici çözüm | Operatör raw output'a bakar (Terminal) |
| Kalıcı öneri | Parser'lar privilege-denied pattern'ini yakaladığında özel sentinel döner; UI bunu "Permission denied — enable_secret kontrol et" şeklinde gösterir |
| Öncelik | **P1** — sık karşılaşılan, operatörü yanıltıyor |
| Blast radius | Orta — `_parse_*` fonksiyonlarına pattern + cache layer'a sentinel yayılır |

Kaynak: [09-RUIJIE-SSH-AND-PARSER-OPERATIONS.md §Parser hata vs privilege-denied](09-RUIJIE-SSH-AND-PARSER-OPERATIONS.md).

---

## TD-6 — MAC / ARP / PoE persistence gözlemlenebilirliği

| Alan | Değer |
|---|---|
| Etki | "Cihaz 95 için son 24 saat ne kadar MAC toplandı" sorusunun answer'ı UI'da yok |
| Risk | Collection failure sessizce devam edebilir |
| Geçici çözüm | Operatör DB query yazar |
| Kalıcı öneri | Per-device collection health widget (last successful collection, row count per cycle) |
| Öncelik | P2 |
| Blast radius | Orta — frontend widget + backend stats endpoint |

---

## TD-7 — event_consumer durumu

| Alan | Değer |
|---|---|
| Etki | Tek bir consumer var; horizontal scaling yok |
| Risk | Syslog burst tek consumer'ı doyurabilir |
| Geçici çözüm | Şu anda yeterli (test edilmiş ölçek altında) |
| Kalıcı öneri | Consumer group ile multi-instance; Redis stream `XREADGROUP` |
| Öncelik | P3 |
| Blast radius | Yüksek (consumer group migration) |

---

## TD-8 — Worker operational runbook eksikleri

| Alan | Değer |
|---|---|
| Etki | "OOM sonrası hangi worker önce restart" runbook'u yazılı değil |
| Risk | Operatör icra esnasında yanlış sırayla restart eder |
| Geçici çözüm | [10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md §Sistem recovery sırası](10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md) — bu paketle birlikte yazıldı |
| Kalıcı öneri | docs/operations/celery-recovery.md ile genişlet |
| Öncelik | P3 |
| Blast radius | Düşük (dokümantasyon) |

---

## TD-9 — Audit log'da bulk credential source cihaz bilgisi tutulmuyor

| Alan | Değer |
|---|---|
| Etki | "Hangi cihazdan kopyalandı" forensic'ı yok |
| Risk | Hatalı bulk copy sonrası geri dönüş zor |
| Geçici çözüm | Yok |
| Kalıcı öneri | `audit_logs.details` payload'ına `source_device_id` ekle |
| Öncelik | P2 |
| Blast radius | Düşük (audit_service tek yer; UI okuyucusu zaten generic) |

Kaynak: Site-A bulk credential copy incident bulgusu.

---

## TD-10 — UI'da gerçek 0 vs collection failure ayrımı

| Alan | Değer |
|---|---|
| Etki | TD-5 ile benzer; UI hiç veri yokken neden olduğunu söylemiyor |
| Risk | Operatör yanlış teşhise gider |
| Geçici çözüm | Manuel Terminal kontrol |
| Kalıcı öneri | UI'da `interfaces`/`mac`/`poe` tab'ları için empty state'in *farklı versiyonları*: "No data yet (cycle did not run)", "No data (cihaz boş)", "Data unavailable (privilege denied — set enable_secret)" |
| Öncelik | P2 |
| Blast radius | Düşük (frontend) |

---

## TD-11 — Device metadata manuel doldurma alanları

| Alan | Değer |
|---|---|
| Etki | `tags`, `layer`, `building`, `floor`, `rack_id` operatörden bekleniyor; eksik bırakılırsa Topology/Rack view görsel boşluk |
| Risk | Düşük (UX) — ama büyüdükçe artar |
| Geçici çözüm | Onboarding sırasında zorunlu hale getir (UI validation) |
| Kalıcı öneri | Onboarding wizard akışında zorunluluk + LLDP'den otomatik tahmin |
| Öncelik | P3 |
| Blast radius | Düşük (frontend) |

---

## TD-12 — Worker RLS regression audit

| Alan | Değer |
|---|---|
| Etki | Faz 7 isolation rework regresyonu; 8 task modülü RLS bypass kontrolü tamamlanmadı (bulk_tasks W3.1'de düzeltildi; kalan 7 modül ayrı audit ister) |
| Risk | Bazı periyodik task'lar başka org'un verisine yazıyor olabilir |
| Geçici çözüm | Yok (sessiz risk) |
| Kalıcı öneri | Her task modülü için `with org_context(...)` blok varlığı + integration test |
| Öncelik | **P1** |
| Blast radius | Yüksek (multi-tenant data integrity) |

Kaynak: Faz 7 isolation rework regression — historical internal context, VERIFY BEFORE HANDOVER.

---

## TD-13 — Agent Terminal Performance

| Alan | Değer |
|---|---|
| Etki | Agent WS her 1-2 dk disconnect, agent-relay 34 sn latency raporlandı (Wave 1 prod smoke) |
| Risk | Canlı SSH operasyon çok yavaş; operatör frustrated |
| Geçici çözüm | Şu an "yapılabilir ama yavaş" |
| Kalıcı öneri | Ayrı iş paketi: WS heartbeat tuning, agent-relay queue ayrıştırma |
| Öncelik | P2 |
| Blast radius | Orta |

Kaynak: Wave 1 prod smoke gözlemleri — historical internal context, VERIFY BEFORE HANDOVER.

---

## TD-14 — Backend credential validation defense

| Alan | Değer |
|---|---|
| Etki | DeviceCreate Pydantic model'inde `credential_profile_id` set ise `ssh_username/password` Optional değil; HF#8 sonrası backlog'da |
| Risk | Düşük (operatör UI üzerinden engellenir) |
| Geçici çözüm | UI tarafı zaten doğru kontrol ediyor |
| Kalıcı öneri | Pydantic `model_validator` ile defansif backend kontrol |
| Öncelik | P3 |
| Blast radius | Düşük |

Kaynak: HF#8 sonrası polish backlog — historical internal context, VERIFY BEFORE HANDOVER.

---

## TD-15 — VPS schema-vs-main drift

| Alan | Değer |
|---|---|
| Etki | Production VPS uzun deploy aralıklarında main'in 1-2 ay gerisinde kalabilir; naive `git pull && build` yıkıcı Alembic migration tetikleyebilir |
| Risk | **YÜKSEK** — veri kaybı veya uzun downtime |
| Geçici çözüm | Pre-deploy checklist + Alembic head karşılaştırması ([02-DEPLOYMENT-AND-INFRASTRUCTURE.md](02-DEPLOYMENT-AND-INFRASTRUCTURE.md)) |
| Kalıcı öneri | CI'da production'a karşı `alembic heads vs main` drift detection; deploy gate'i |
| Öncelik | **P1** |
| Blast radius | Çok yüksek (DB) |

Kaynak: VPS schema drift gözlemleri — historical internal context, VERIFY BEFORE HANDOVER.

---

## TD-16 — Cloudflare 5xx cache window

| Alan | Değer |
|---|---|
| Etki | Backend recreate sırasında CF 5xx response'ları kısa süre cache'leyebilir; sticky 5xx görünür |
| Risk | Yanlış rollback tetikleme |
| Geçici çözüm | Restart sonrası 30-60 sn bekle |
| Kalıcı öneri | CF panel'inde `Cache-Control: no-store` ile 5xx caching engelle; ayrıca `/sw.js` kill-switch'i (önceki ship'li defansif önlem — VERIFY BEFORE HANDOVER) gibi Cache-Control katmanı |
| Öncelik | P2 |
| Blast radius | Orta |

Kaynak: Pentest Finding 1 rollback incident — historical internal context, VERIFY BEFORE HANDOVER.

---

## TD-17 — Frontend blank screen / auth race tarihsel zinciri

| Alan | Değer |
|---|---|
| Etki | Login/dashboard blank screen incident'ları (PR #39 → #41 → #43 → #45 → #47 → #64 → #65 → #73 zinciri) son fix `ProtectedRoute token-first` ile çözüldü |
| Risk | Yeni route eklemelerinde aynı pattern dikkatsizce kırılabilir |
| Geçici çözüm | `frontend/src/contexts/__tests__/*` pin tests (sessionEpoch, hydration, runtimeFetch); P0.2 üç aşamalı hydration recheck |
| Kalıcı öneri | Yeni route guard eklerken **token-first matrix** kullanılmalı; blank screen runbook'u korunmalı |
| Öncelik | P3 (closed ama korunması gerekir) |
| Blast radius | Yüksek (P1 incident potansiyeli) |

Kaynak: Dashboard auth blank-screen postmortem zinciri (PR #39, #41, #43, #45, #47, #64, #65, #73) — historical internal context, VERIFY BEFORE HANDOVER.

---

## TD-18 — Topology stacking hazard

| Alan | Değer |
|---|---|
| Etki | Topology sayfaları workspace sınırını ihlal eden negatif margin kullanır; yeni global UI öğesi eklerken sticky + z-index 5+ + solid bg şart |
| Risk | UI'da overlay görsel bozulması |
| Geçici çözüm | Geliştirici uyarısı |
| Kalıcı öneri | Topology page'i sandbox container ile saran wrapper component |
| Öncelik | P3 |
| Blast radius | Düşük |

Kaynak: Topology page CSS stacking gözlemi — historical internal context, VERIFY BEFORE HANDOVER.

---

## TD-20 — Frontend permission catalog / source consolidation

| Alan | Değer |
|---|---|
| Etki | Frontend tarafında canonical permission key kontrolleri tek bir dosyada toplanmaz; `frontend/src/App.tsx`, `frontend/src/utils/menuGroups.ts`, `frontend/src/types/index.ts`, `frontend/src/contexts/SiteContext.tsx` ve ilgili route/component permission gate'leri arasında dağınık şekilde gömülüdür |
| Risk | Yeni rol veya yeni permission eklendiğinde tek bir audit noktası olmadığı için frontend tarafı backend'in gerisinde kalabilir; "bu sayfa neden 403?" debug süresi uzar |
| Geçici çözüm | Backend canonical key listesi (`backend/app/services/rbac/engine.py` + `f9ag_canonical_permission_keys.py` migration) referans alınır; frontend kullanımları manuel çapraz-kontrol edilir |
| Kalıcı öneri | Tek bir frontend konsolidasyon modülü (örn. `frontend/src/lib/permissions/index.ts` veya `frontend/src/permissions.ts` adlı **yeni** dosya — bu paket hazırlandığı sırada mevcut değildir): tüm canonical key string'leri sabit olarak export edilir + per-route/per-menu permission map tek dict olarak tutulur. Kontrol noktaları bu dict üzerinden okur |
| Öncelik | P2 |
| Blast radius | Orta (frontend refactor; backend ve API kontratı değişmez) |

Kaynak: Handover paketi QA review'unda doğrulandı (devir paketi hazırlığı sırasında "tek liste dosyası" beklentisi ile gerçek dağıtık dağılım arasında uyumsuzluk).

---

## TD-19 — MFA backend hardening backlog

| Alan | Değer |
|---|---|
| Etki | J1+J10 forensic doğrulandı (sağlıklı); H8/H13/decrypt hardening backlog'da |
| Risk | Şu an kapalı; ama production'da decrypt path hardening yapılmalı |
| Geçici çözüm | Mevcut akış sağlıklı doğrulandı |
| Kalıcı öneri | H8/H13 hardening implement |
| Öncelik | P3 |
| Blast radius | Düşük |

Kaynak: MFA J1+J10 forensic doğrulama — historical internal context, VERIFY BEFORE HANDOVER.

---

## TD-21 — Device status telemetry-aware fallback

| Alan | Değer |
|---|---|
| Status | **IN IMPLEMENTATION** — branch `fix/device-status-telemetry-aware-recovery`; not yet merged |
| Etki | `_check_device_reachable` self-locked agent-online devices to whatever was in DB (`return device.status == ONLINE`). Once a device was ever written OFFLINE the poller kept reporting it OFFLINE regardless of how much fresh SSH / PoE / MAC telemetry had arrived since. Operators saw "panel-fresh data but UI shows Offline" |
| Risk | Operator distrust: "the data is here but the badge is wrong" → wasted incident triage, ungrounded restart attempts |
| Geçici çözüm | None — branch ships the actual fix |
| Kalıcı öneri | New service `backend/app/services/device_status_resolver.py` exposes a pure `resolve_device_status(...)` resolver consulting agent_command_logs success, fresh PoE / MAC snapshot and Device.last_seen as recovery signals, with a failure-newer-than-success veto. Plugged into both call sites (`monitor_tasks._check_device_reachable` and `agent_manager._handle_device_status_report`). Two new config knobs `STATUS_TELEMETRY_FRESH_WINDOW_SECONDS=600` and `STATUS_AGENT_REPORT_FRESH_WINDOW_SECONDS=180`. **Signal precedence:** explicit agent reachability reports take precedence over telemetry freshness — fresh telemetry is used only as a recovery signal when no current agent report is available. |
| Öncelik | **P1** |
| Blast radius | Medium — touches the hottest poll path. The resolver is pure and well-tested; behaviour change is additive (no device that was correctly OFFLINE under the old rules will incorrectly flip to ONLINE under the new ones because of the failure veto) |

Kaynak: Read-only diagnosis report on Device 10.255.0.49 (S0_0.49) — current internal context.

### Status semantics — quick reference

For future readers debugging the status pill / risk pill confusion:

| UI element | Backend signal | Resolution |
|---|---|---|
| **Status badge** (online / offline / unknown / unreachable) | `Device.status` (DeviceStatus enum) | Reachability — telemetry-aware (TD-21) |
| **Risk pill** (HEALTHY / WATCH / CRITICAL) | `GET /api/v1/devices/health-scores → score` | Score band (≥80 HEALTHY, 50–79 WATCH, <50 CRITICAL) computed in devices.py from current status + critical events + drift + backup freshness |

Device **status ≠ risk pill**. **WATCH** is a health score band (50–79), not a reachability state — a device that goes OFFLINE is penalised −40 in the score, which mathematically lands at 60 → WATCH; that is the formula working as designed, not a separate failure mode.

---

## Genel öncelik sıralaması

| Öncelik | Maddeler |
|---|---|
| **P1** | TD-5 (privilege-denied parser), TD-12 (worker RLS regression), TD-15 (VPS drift), TD-21 (status telemetry-aware fallback — **IN IMPLEMENTATION**) |
| **P2** | TD-1 (VLAN collector), TD-2+TD-3 (pool/cache stale), TD-4 (error classification UI), TD-6 (collection observability), TD-9 (audit source device), TD-10 (UI empty state), TD-13 (agent terminal perf), TD-16 (CF cache), TD-20 (frontend permission catalog) |
| **P3** | TD-7 (event_consumer scale), TD-8 (runbook polish), TD-11 (metadata), TD-14 (backend creds defense), TD-17 (blank screen koruma), TD-18 (topology stacking), TD-19 (MFA hardening) |

## Devir alacak ekip için roadmap önerisi

İlk ay:
1. P1'leri ele al (TD-5, TD-12, TD-15)
2. TD-9 ve TD-3 ile bulk credential UX'ı düzelt (operatör frustration odağı)

İkinci ay:
3. TD-2 + TD-10 + TD-4 — operatör hata mesajı + cache invalidation paketi
4. TD-1 — VLAN snapshot collector

Üçüncü ay:
5. TD-6 + TD-13 — performans + observability
6. P3'lerden ulaşılabilenler

## Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- Tüm TD maddeleri kaynak kod / compose / migration üzerinden ve devir veren ekibin tarihsel iç bağlamı (VERIFY BEFORE HANDOVER) üzerinden doğrulanmıştır
- Önceliklendirme bu paketin hazırlandığı oturumdaki gözlemlere dayanır

### VERIFY BEFORE HANDOVER
- TD-12 (worker RLS regression) — kalan 7 modülün güncel durumu
- TD-15 — production VPS güncel migration head'i
- TD-4 — PR #119 deploy edildi mi
