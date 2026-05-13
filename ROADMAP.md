# NetManager — Ürün Yol Haritası

> Son güncelleme: 2026-05-13  
> Platform: FastAPI · React · Celery · Redis · PostgreSQL · Docker  
> Hedef: Multi-vendor ağ görünürlüğü, yapılandırma kontrolü, topoloji zekâsı ve güvenli otomasyon platformu

---

## Durum Etiketleri

| Etiket | Anlam |
|---|---|
| ✅ Tamamlandı | Üretimde, kullanıma hazır |
| 🔄 Kısmi | Temel işlevler var, geliştirilecek |
| 🔵 Planlandı | Kesinleşmiş, sıradaki sprint |
| 🟡 Değerlendiriliyor | Fayda/maliyet analizi devam ediyor |
| ⚪ İleri Faz | 6+ ay, önce altyapı hazırlanmalı |

---

## TAMAMLANAN ÖZELLİKLER ✅

### Temel Platform
- ✅ Multi-vendor cihaz yönetimi (Cisco / Aruba / Ruijie / Generic)
- ✅ SSH bağlantı testi & durum takibi
- ✅ Sayfalanmış cihaz listesi — arama, vendor, durum, tag, alias filtresi
- ✅ Cihaz ekleme / düzenleme / silme (toplu dahil)
- ✅ Toplu yedek alma & task progress takibi
- ✅ Toplu credential güncelleme (kaynak cihazdan kopyalama veya manuel)
- ✅ SSH'tan hostname, model, firmware, seri no otomatik çekme
- ✅ Tag & alias yönetimi — tabloda tıklanabilir filtre
- ✅ Cihaz grupları

### Proxy Agent Sistemi
- ✅ Python WebSocket agent (macOS launchd / Linux systemd / Windows Service)
- ✅ Agent online/offline heartbeat takibi
- ✅ Installer script — OS tespiti, pip fallback zinciri, one-liner kurulum
- ✅ Cihaz başına agent atama (tekli & toplu)
- ✅ Agent durum göstergesi cihaz detayında

### Config Intelligence
- ✅ Canlı config görüntüleme (SSH ile)
- ✅ Otomatik config yedekleme (değişiklik tespiti — hash ile)
- ✅ Yedek içeriği görüntüleme & indirme
- ✅ Config diff görüntüleyici — iki yedek arası fark (+ / - renk kodlamalı)
- ✅ Güvenlik politika tarayıcı — telnet/SNMP/NTP/AAA/syslog kuralları, 0-100 puan

### Topoloji
- ✅ LLDP/CDP ile otomatik topoloji keşfi
- ✅ Çift yönlü bağlantı haritası (D3.js graf)
- ✅ Ghost node tespiti (keşfedilen ama sisteme eklenmemiş cihazlar)
- ✅ Minimap
- ✅ Cihaz tipi ikonu (switch/router/AP/server)

### İzleme & Uyarı
- ✅ Periyodik SSH polling (online/offline tespiti)
- ✅ Olay akışı — port up/down, STP anomaly, loop detection, LLDP değişimi
- ✅ Event deduplication (Redis TTL ile)
- ✅ Flapping tespiti (saatte ≥4 durum değişimi)
- ✅ Korelasyon — aynı anda ≥3 cihaz offline → root cause analizi
- ✅ Gerçek zamanlı WebSocket event akışı (dashboard)

### Dashboard Intelligence
- ✅ En sorunlu cihazlar (7 günlük olay sayısına göre)
- ✅ Yedek uyumluluk grafiği (güncel / bayat / hiç yok)
- ✅ Flapping cihaz listesi
- ✅ Agent sağlık paneli (heartbeat yaşı, atanmış cihaz sayısı)
- ✅ Firmware posture (versiyon bazlı cihaz dağılımı)
- ✅ Lokasyon & vendor risk haritası (offline + yedeksiz oranından skor)
- ✅ Son 24 saatte değişiklik özeti
- ✅ "Hiç görülmemiş" / uzun süredir offline cihazlar

### Raporlama & Audit
- ✅ Cihaz raporu (CSV/PDF export)
- ✅ Audit log (kim, ne zaman, ne yaptı)
- ✅ Audit log sayfa filtresi (kullanıcı, aksiyon, kaynak tipi)

### SSH Terminal
- ✅ Cihaz başına güvenli show komutu çalıştırma
- ✅ Terminal geçmişi
- ✅ VLAN oluşturma / silme / atama
- ✅ Interface shutdown / no-shutdown

### Kullanıcı Yönetimi
- ✅ RBAC (super_admin / admin / operator / viewer)
- ✅ İzin tabanlı endpoint koruması
- ✅ JWT auth

---

## SPRINT 1 — Topoloji Network Intelligence Katmanı ✅

### 4A. Katman Bazlı Görünüm ✅
- ✅ `layer` alanı (core/distribution/access/edge/wireless) — cihaz formunda seçim
- ✅ Topoloji filtre panelinde katman renk kodlaması & filtre

### 4B. Site / Bina / Kat Filtresi ✅
- ✅ `site > building > floor` hiyerarşisi cihaz modeli ve formunda
- ✅ Topolojide kademeli site/bina/kat filtresi (cascading)

### 4C. Bağlantı Kalitesi Gösterimi ✅
- ✅ Port adı (local↔neighbor), protokol (LLDP/CDP), last seen
- ✅ Utilization rengi (≥80% kırmızı, ≥60% turuncu, <60% yeşil)
- ✅ Bağlantı hızı (SNMP speed_mbps → edge kalınlığı & renk rozeti; 10G/1G/100M)
- ✅ Ghost edge'lerde kesikli çizgi + amber rengi
- ✅ duplex, trunk/access, VLAN, PoE — LLDP extended parse: `show interfaces` + `show interfaces switchport` + `show power inline`; topology_links'e 5 yeni kolon; edge tooltip'te FDX/HDX/TRUNK/ACCESS/VLAN/PoE rozet gösterimi

### 4D. Görsel Problem İşaretleme ✅
- ✅ Stale topoloji (48h+ → turuncu)
- ✅ Utilization bazlı renk + ghost edge görünürlüğü
- ✅ Node hover → bağlı kenarlar parlar, diğerleri solar

### 4E. Blast Radius Analizi ✅
- ✅ Graph traversal ile etkilenen cihaz listesi
- ✅ Critical/non-critical tespiti, etkilenen vendor/layer tablosu

### 4F. L2 Anomaly Detection ✅
- ✅ Çift hostname, asimetrik bağlantı, eski bağlantı tespiti
- ✅ warning/info seviyeli anomali raporu

---

## SPRINT 2 — Cihaz Detay Operasyon Merkezi ✅

### 5A. Yeni Sekmeler ✅
- ✅ Syslog, Değişiklik Zaman Çizelgesi, Komşular, Health (SNMP) sekmeleri

### 5B. Güvenli CLI ✅
- ✅ Denylist (config/reload/erase vb. engellendi)
- ✅ Tehlikeli komut onay dialogu
- ✅ Komut çıktısı AuditLog'a kaydediliyor
- ✅ is_readonly / approval_required toggle

### 5C. Hızlı Aksiyonlar ✅
- ✅ Yedek Al, Diff Görüntüle, Komşuları Tara, SSH Test, Uyumluluk Tara

---

## SPRINT 3 — Otomasyon & Playbook Sistemi ✅

> Tahmini süre: 3-4 hafta | Öncelik: Çok Yüksek — Bu modül ürünü NMS'ten platform'a taşır

### Temel Playbook Motoru ✅
- ✅ `Playbook` modeli: isim, adımlar, tetikleyici tipi, dry-run desteği
- ✅ Adım tipleri: `ssh_command`, `backup`, `compliance_check`, `notify`, `wait`
- ✅ Çalışma kaydı: çıktı, diff, hata

### Hazır Playbook Şablonları ✅ (Sprint 9'da tamamlandı)
- ✅ Offline cihaz yeniden kontrol
- ✅ Config yedek yenile + uyumluluk
- ✅ Interface hata taraması
- ✅ NTP/Syslog standart push
- ✅ VLAN rollout (çoklu cihaz)
- ✅ Uyumluluk ihlali düzeltme

### Tetikleyiciler ✅
- ✅ Manuel (kullanıcı başlatır)
- ✅ Zamanlanmış (Celery Beat ile)
- ✅ Olay bazlı (belirli event_type gelince)

### Güvenlik Modeli ✅
- ✅ Dry-run modu (değişiklik yapmadan simülasyon)
- ✅ Blast radius uyarısı (etkilenecek cihaz sayısı)
- ✅ Rollback noktası (playbook öncesi yedek)

---

## SPRINT 4 — Onay Akışı & Kurumsal Güvenlik ✅

### 8. Approval Workflow ✅
- ✅ CLI komutları risk seviyesi (low/medium/high)
- ✅ High/medium → ApprovalRequest oluşturma (approval_required=true cihazlarda)
- ✅ 4-göz prensibi: operator talep eder, admin /approvals üzerinden onaylar
- ✅ Approval sayfa + API endpoint'leri

---

## SPRINT 5 — Raporlama & Bildirim Entegrasyonu ✅

### 10. Gelişmiş Raporlar ✅
- ✅ Cihaz uptime trend grafiği (7/14/30 günlük)
- ✅ En sorunlu cihazlar raporu (event sayısına göre)
- ✅ Firmware uyumluluk raporu
- ✅ Yedeksiz cihaz raporu
- ✅ Agent sağlık raporu
- ✅ PDF executive summary (tarayıcı yazdır/PDF ile)
- ✅ Haftalık email digest (Celery Beat)

### 15. Bildirim Entegrasyonları ✅
- ✅ Email (SMTP)
- ✅ Slack webhook
- ✅ Microsoft Teams webhook
- ✅ Telegram bot
- ✅ Generic webhook (JSON payload)
- ✅ Jira ticket — `_send_jira` servisi (Jira REST API v3, Basic auth, ADF description, priority mapping); Settings → Kanal Ekle → "Jira (Ticket)"; config: URL + email + API token + proje anahtarı + issue türü

---

## SPRINT 6 — Akıllı Keşif & Onboarding ✅

> Tahmini süre: 2 hafta | Öncelik: Orta-Yüksek

### 6A. Smart Discovery Pipeline ✅
- Ghost node keşif flow'u (mevcut hop-discover) ✅
- Vendor tahmini, device class detection ✅
- "Onboard Et" tek tıklama (ghost switch üzerinden) ✅

### 6B. Bulk CSV Import ✅ (yeni eklendi)
- `POST /devices/import-csv` — CSV ile toplu cihaz ekleme/güncelleme
- `GET /devices/import-template` — şablon CSV
- Frontend: sürükle-bırak upload, sonuç kartları (oluşturulan/güncellenen/hata)
- Upsert: aynı ip_address → güncelle, yeni → ekle

### 6B-orig. Onboarding Wizard (Çok Adımlı Form) ✅
- ✅ 5 adımlı Modal wizard: Temel Bilgiler → Cihaz Profili → SSH & Kimlik → SNMP → Özet & Test
- ✅ Her adımda sadece o adımın alanları validate edilir (`form.validateFields(stepFields)`)
- ✅ Tüm adımlarda tek `Form` instance — adım değişimde state korunur
- ✅ Son adım: Descriptions özet, "Cihaz Oluştur & SSH Test Et" butonu, test sonucu Alert
- ✅ Başarılı oluşturma sonrası "Cihaz Bilgilerini Çek" butonu (hostname/model/firmware otomatik)
- ✅ Devices sayfasına "Sihirbaz" butonu eklendi (mevcut form korundu)

### 6C. Otomatik Gruplama ✅
- ✅ `GET /devices/group-suggestions` — site/building/floor, katman ve topoloji kümesine göre grup önerileri
- ✅ `POST /devices/apply-group-suggestions` — seçilen önerileri grup olarak uygula, cihazları ata
- ✅ `AutoGroupingModal` bileşeni — öneri kartları (tip ikonu, cihaz listesi), toplu seç/uygula
- ✅ Devices sayfasına "Otomatik Grupla" butonu eklendi

---

## SPRINT 7 — Agent Gözlemlenebilirlik & Lifecycle ✅

> Tahmini süre: 2 hafta | Öncelik: Orta-Yüksek

### 7A. Agent Observability ✅
- Versiyon, OS detayları ✅
- CPU/RAM kullanımı (psutil ile, agent v1.1+) ✅
- Komut başarı/başarısızlık oranı + ortalama gecikme ✅
- Canlı metrik endpoint (`/agents/{id}/live-metrics`) ✅
- Frontend: CPU/RAM progress bar, komut istatistikleri ✅

### 7B. Agent Lifecycle ✅
- Uzaktan yeniden başlatma (`POST /agents/{id}/restart`) ✅
- Agent script v1.1: psutil opsiyonel, restart handler ✅

### 7C. Agent Routing Intelligence ✅
- ✅ `fallback_agent_ids` JSON kolonu Device modelinde
- ✅ SSH Manager `_via_agent()` — primary agent + fallback_agent_ids sırayla denenir
- ✅ DeviceForm → "Yedek Agent'lar" multi-select alanı
- ✅ Gecikme bazlı otomatik route seçimi — `AgentDeviceLatency` modeli; her SSH komutunda EMA latency ölçümü + DB persist; `_via_agent()` online agent'ları latency'ye göre sıralar; `/agents/latency-map` + `/agents/{id}/probe-devices` endpoint'leri; Agent sayfasında "Gecikme Haritası" + Probe butonu

---

## SPRINT 11 — Agent v1.3 Gelişmiş Özellikler ✅

> Commit: `544b8dc` + `6b16fd7` + `6c3606d` | Tamamlandı: 2026-05-03

### 11A. SSH & Ağ Altyapısı ✅
- ✅ **SSH Connection Pool** — agent SSH bağlantıları 5dk boyunca havuzda tutulur (Paramiko channel yeniden kullanımı, pool stats heartbeat'te)
- ✅ **Proaktif Cihaz Sağlık İzleme** — agent cihazları TCP port 22 ile 60s aralıkla test eder, status değişimini backend'e bildirir

### 11B. Offline Command Queue ✅
- ✅ Agent bağlantısı koptuğunda komut sonuçları `_result_queue` (deque) içinde tutulur
- ✅ Bağlantı yeniden kurulunca kuyruk otomatik flush edilir
- ✅ `queue_size` heartbeat metrics'ine eklendi (psutil ile birlikte raporlanır)
- ✅ Agent detay modalı Status sekmesinde çevrimdışı kuyruk uyarı kartı (≥1 komut varsa gösterilir)

### 11C. SNMP via Agent ✅
- ✅ Agent üzerinde `puresnmp` ile SNMP GET / WALK (NAT arkası cihazlara erişim)
- ✅ Backend REST: `POST /agents/{id}/snmp-get`, `POST /agents/{id}/snmp-walk`
- ✅ `AgentManager.execute_snmp_get` / `execute_snmp_walk` — WebSocket mesajlaşması ile agent'a yönlendirme
- ✅ Frontend SNMP sekmesi — mode toggle (GET/WALK), 8 OID preset butonu, cihaz ID + OID girişi, sonuç tablosu

### 11D. Otomatik Cihaz Keşfi ✅
- ✅ Agent üzerinde subnet tarama + SSH banner grab (`POST /agents/{id}/discover`)
- ✅ Keşif geçmişi (`GET /agents/{id}/discover/history`) — durum, tarih, bulunan host sayısı
- ✅ `DiscoveryResult` modeli (DB persist)
- ✅ Frontend Keşif sekmesi — subnet girişi, sonuç tablosu (IP, açık portlar, banner, yanıt süresi)
- ✅ **Envanter Entegrasyonu** — keşfedilen host'a "+ Ekle" butonu ile device oluşturma modal'ı (hostname, vendor, os_type, SSH kullanıcı)

### 11E. Syslog Toplayıcı ✅
- ✅ Agent UDP 514 dinleyici — gelen syslog mesajlarını DB'ye kaydeder
- ✅ `SyslogEvent` modeli (source_ip, facility, severity, message, received_at)
- ✅ `POST /agents/{id}/syslog-config` — agent syslog dinleyiciyi uzaktan aç/kapat
- ✅ `GET /agents/{id}/syslog-events` — sayfalanmış log listesi, `severity_max` filtresi
- ✅ Frontend Syslog sekmesi — tablo, severity renk rozeti, **severity dropdown filtresi** (Emergency → Debug/Tümü)

### 11F. Komut Akışı (SSE Streaming) ✅
- ✅ `POST /agents/{id}/stream-command` — request_id + stream_url döner
- ✅ `GET /stream/{request_id}` — SSE endpoint, SSH çıktısı canlı akar
- ✅ Frontend Akış sekmesi — device seçimi, komut girişi, canlı çıktı textarea
- ✅ **Komut geçmişi localStorage'da** (anahtar: `nm_stream_history_{agentId}`, max 20 öğe, AutoComplete ile öneri)

### 11G. Güvenli Credential Vault ✅
- ✅ `AgentCredentialBundle` modeli — AES-256-GCM ile şifreli credential bundle
- ✅ `POST /agents/{id}/refresh-vault` — güncel credential'ları agent'a push eder
- ✅ Agent tarafında `~/.netmanager-agent/vault.enc` şifreli dosya (bellek içi decrypt)
- ✅ Frontend Vault sekmesi — vault durumu, credential sayısı, "Vault'u Yenile" butonu

---

## SPRINT 8 — Gelişmiş Playbook Adım Tipleri & Olay Tetikleyiciler ✅

### 8A. Gelişmiş Adım Tipleri ✅
- ✅ `ssh_command` — mevcut (SSH komutu çalıştır)
- ✅ `backup` — cihazın config yedeğini Celery task olarak tetikler
- ✅ `compliance_check` — güvenlik uyumluluk taraması çalıştırır, skor ve pass/fail kaydeder
- ✅ `notify` — seçilen bildirim kanalına mesaj gönderir (`{hostname}` / `{ip}` değişkenli)
- ✅ `wait` — adımlar arası N saniye bekler (max 300s)
- ✅ `pre_run_backup` — playbook çalışmadan önce rollback noktası yedeği alır (opsiyonel toggle)

### 8B. Olay Bazlı Tetikleyiciler ✅
- ✅ `trigger_type` alanı: `manual | scheduled | event`
- ✅ `trigger_event_type`: hangi olay tipinde tetiklenecek (device_offline, critical_event, vb.)
- ✅ `trigger_event_playbooks` Celery task — `_save_event()` her olay kaydında event tipini kontrol eder
- ✅ Olay → eşleşen playbook → ilgili cihazda otomatik çalışma (tek cihaz veya grup filtreli)

### 8C. Frontend Güncellemeleri ✅
- ✅ Playbook formu — tetikleyici tipi seçici (Manuel/Zamanlanmış/Olay Bazlı)
- ✅ Zamanlanmış seçilince sıklık alanı, Olay seçilince olay tipi dropdown
- ✅ Adım tipi seçici (SSH Komutu / Config Yedeği / Uyumluluk Tarama / Bildirim / Bekle)
- ✅ `notify` adımında kanal + konu + mesaj alanları
- ✅ `wait` adımında saniye girişi
- ✅ Tablo kolonu: tetikleyici tipi (Manuel/Zamanlanmış/Olay ikonu ile)
- ✅ Run detay modalı: adım tipi rozeti + çıktı/hata gösterimi

---

## SPRINT 9 — Hazır Playbook Şablonları & Config Drift Detection ✅

### 9A. Hazır Playbook Şablonları ✅
- ✅ `backup_tasks.py` — `backup_device_task` (tek cihaz, playbook adımlarında kullanılır) + `check_config_drift` günlük Celery task
- ✅ 6 yerleşik şablon: Offline Yeniden Kontrol, Config Yedek + Uyumluluk, Interface Hata Taraması, NTP/Syslog Push, VLAN Rollout, Uyumluluk İhlali Düzeltme
- ✅ `GET /playbooks/templates` — şablon listesi (statik, DB gerektirmez)
- ✅ `POST /playbooks/from-template` — seçili şablondan playbook oluştur (hedef grup/cihaz atanabilir)

### 9B. Config Drift Detection ✅
- ✅ `ConfigBackup.is_golden` + `golden_set_at` alanları (migration dahil)
- ✅ `POST /devices/{id}/backups/{bid}/set-golden` — bir yedeği altın baseline olarak işaretle (önceki baseline otomatik temizlenir)
- ✅ `GET /devices/{id}/backups/drift` — son yedek ile altın baseline'ı karşılaştır, unified diff + satır delta döner
- ✅ `check_config_drift` Celery Beat günlük task — fark varsa `config_drift` NetworkEvent oluşturur
- ✅ Dashboard analytics — `config_drift` özeti (baseline'ı olan cihaz sayısı, kaçında sapma var, liste)

### 9C. Frontend ✅
- ✅ Playbooks — "Şablonlar" butonu → sunucu şablon galerisi modal (6 kart: tetikleyici tipi, adım sayısı, rollback rozeti)
- ✅ Şablon seçince "Oluştur" mini formu (ad + hedef grup) — `createFromTemplate` API çağrısı
- ✅ "Formu Doldur" seçeneği — drawer'ı şablon adım/ayarlarıyla açar, düzenlenerek kaydedilir
- ✅ Device detail Yedekler sekmesi — her yedeğe ⭐ "Altın" butonu; baseline varsa drift alert banner'ı (yeşil/turuncu)
- ✅ Dashboard — "Config Drift Tespiti" widget'ı (baseline sayısı, sapma count, sapma yaşayan cihaz tag'leri)

---

## SPRINT 10 — SLA & Uptime Analitik ✅

### 10A. Backend ✅
- ✅ `SlaPolicy` modeli: hedef uptime %, ölçüm penceresi, cihaz/grup kapsamı, ihlal bildirimi
- ✅ `GET /sla/policies` + `POST/PUT/DELETE` — CRUD endpoint'leri
- ✅ `GET /sla/fleet-summary` — filo geneli uptime özeti (≥99 / 95–99 / <95 dağılımı, en kötü 5 cihaz)
- ✅ `GET /sla/report` — tüm aktif cihazlar için uptime % (pencere parametreli, vendor/konum dahil)
- ✅ `GET /sla/compliance` — hangi politika altında hangi cihazlar ihlal ediyor
- ✅ `GET /sla/device/{id}` — tekil cihaz uptime % + günlük breakdown
- ✅ Uptime hesaplama: NetworkEvent'ten online/offline geçiş sürelerini geriye dönük hesaplar

### 10B. Frontend ✅
- ✅ `frontend/src/api/sla.ts` — tam TypeScript tip tanımları + API client metodları
- ✅ `Settings → SLA Politikaları` sekmesi — CRUD modal (hedef %, pencere, cihaz kapsamı seçimi)
- ✅ `Dashboard` — "Uptime Analizi" widget'ı (filo ort. %, dağılım sayaçları, en düşük 5 cihaz tag)
- ✅ `/sla` rotası — dedicated SLA Rapor sayfası (cihaz tablosu, Progress bar, downtime dakika)
- ✅ Sidebar'a "SLA & Uptime" menü öğesi eklendi

### 10C. Syntax Fix ✅
- ✅ `asset_lifecycle.py`, `interfaces.py`, `playbooks.py`, `monitor.py` — `CurrentUser` parametresine `= None` varsayılanı eklendi (Python syntax hatası; backend başlayamıyordu)

---

---

## FAZ 3 — Observability Foundation ✅

> Tamamlandı: 2026-05-13 | 174/174 test | 0 TypeScript hatası

### 3A — Interval Union Logic + Snapshot History ✅
- ✅ KL-6 kapatıldı: `_merge_intervals` pure helper — çakışan downtime çift sayımı giderildi
- ✅ `DeviceAvailabilitySnapshot` modeli + daily snapshot insert + 90 gün retention
- ✅ `GET /devices/{id}/availability?days=N` endpoint — current fields + history array

### 3B — Synthetic Probe Modülü ✅
- ✅ `SyntheticProbe` + `SyntheticProbeResult` modelleri (icmp/tcp/http/dns)
- ✅ Agent protokol uzantısı: `synthetic_probe` / `synthetic_probe_result` mesaj tipleri
- ✅ `AgentManager.execute_synthetic_probe()` WebSocket dispatch
- ✅ `run_synthetic_probes` Celery task (60s beat) + correlation engine entegrasyonu
- ✅ CRUD + runNow + results REST API

### 3C — Agent Peer Latency ✅
- ✅ `AgentPeerLatency` modeli + `_measure_latency` pure helper (subprocess ICMP, RTT regex)
- ✅ `measure_agent_peer_latency` Celery task (900s beat, `agent_from="backend"`)
- ✅ `GET /agents/peer-latency-matrix` + `GET /agents/{id}/peer-latency` API

### 3D — Dashboard Wiring & Observability UI ✅
- ✅ Fleet aggregates (`fleet_experience_score`, `fleet_availability_24h`) `/monitor/stats`'a eklendi
- ✅ Dashboard 2 StatCard: Fleet Availability + Experience Score
- ✅ Dashboard incident timeline: severity sol çizgi, hostname tag, animasyon
- ✅ DeviceDetail "Availability" sekmesi: 4 stat + 30 günlük AreaChart
- ✅ Synthetic Probes sayfası: CRUD, severity satır rengi, expandable sonuçlar
- ✅ Agents peer latency matrix: gecikme renkleri, expandable LineChart, Yenile butonu

---

## FAZ 4 — Advanced Observability & Intelligence ✅

> Tamamlandı: 2026-05-13 | 236/236 test | 0 TypeScript hatası

### 4A — Gerçek Agent-to-Agent Latency ✅
- ✅ KL-7 kapatıldı: `_ab_peer_latency_loop` FastAPI lifespan bg task (900s)
- ✅ Agent A → Agent B `ping_check` — `agent_from = agent_a_id` olarak kaydedilir
- ✅ Matrix'te gerçek ağ arası gecikme görünür (önceki: `agent_from="backend"` sabit değerdi)
- ✅ +9 test (toplam 183)

### 4B — TimescaleDB Hypertable ✅
- ✅ KL-9 kapatıldı: 5 hypertable (`device_availability_snapshots`, `snmp_poll_results`, `agent_peer_latencies`, `synthetic_probe_results`, `syslog_events`)
- ✅ `docker-compose.yml` → `timescaledb/timescaledb:latest-pg16`
- ✅ `add_retention_policy` (90 gün) — Celery retention task devre dışı
- ✅ +8 test (toplam 191)

### 4C — Advanced Synthetic SLA Thresholds ✅
- ✅ `SlaPolicy.probe_id` FK — probe başarı oranı SLA compliance'a dahil
- ✅ Ardışık başarısız probe → `threshold_violated` event; latency SLA: `latency_ms > threshold_ms`
- ✅ `/sla/compliance` probe SLA ihlallerini içeriyor
- ✅ SyntheticProbes sayfasında "SLA: %98.2 (son 7g)" rozeti
- ✅ +13 test (toplam 204)

### 4D — Incident RCA Ekranı ✅
- ✅ `Incident` + `IncidentTimeline` modelleri — OPEN/DEGRADED/RECOVERING/CLOSED state makinesi
- ✅ `process_event()` servisi — state geçişleri timeline'a kaydedilir
- ✅ `GET /incidents`, `GET /incidents/{id}`, `PATCH /incidents/{id}/state` API
- ✅ `/incidents` sayfası — filtreli tablo, timeline modal, RCA detayı
- ✅ +12 test (toplam 216)

### 4E — Escalation Rule Engine ✅
- ✅ `EscalationRule` modeli: severity/event_type/source/state/duration matcher'lar + cooldown
- ✅ Webhook desteği: Slack (attachment), Jira (priority/labels), Generic (düz JSON)
- ✅ `evaluate_escalation_rules` Celery task (300s beat) — cooldown/dedup korumalı
- ✅ `webhook_headers` maskeleme — API yanıtında yalnızca anahtar adları döner (KL-10)
- ✅ Dry-run test endpoint + bildirim audit log
- ✅ `/escalation-rules` sayfası — CRUD drawer, log sekmesi, inline dry-run Alert
- ✅ SSH Terminal bağımsız sekme + toolbar (connection status, Clear, Disconnect)
- ✅ +20 test (toplam 236)

### Faz 4 KL Özeti

| ID | Durum | Notlar |
|----|-------|--------|
| KL-7 | ✅ Faz 4A | Gerçek A→B agent-to-agent latency |
| KL-9 | ✅ Faz 4B | 5 TimescaleDB hypertable |
| KL-10 | Açık → Faz 5 | `webhook_headers` plaintext — credential vault şifrelemesi |
| KL-11 | Açık → Faz 5 | Escalation minimum tepki süresi 5 dk — kritik olaylar için düşürülebilir |

---

## FAZ 5 — Production Hardening & Platform Reliability 🔵

> Öncelik: Çok Yüksek — Faz 4 sonrası production-ready olmak için kritik altyapı adımları

### 5A — Alembic Migration (KL-1 Kapatma)

**Hedef:** `create_all` + `ALTER TABLE` pattern'ından çıkmak; tüm şema değişiklikleri versiyonlanmış migration dosyaları ile yönetilmeli.

**Kapsam:**
- `alembic init` + `env.py` ayarı (async engine)
- Mevcut şema için başlangıç migration (baseline revision)
- `main.py` lifespan'dan `ALTER TABLE` bloklarını kaldır → Alembic revision'larına taşı
- CI: her PR'da `alembic upgrade head` çalışmalı; downgrade test edilmeli
- Rollback: `alembic downgrade -1` smoke test

### 5B — Backup & Restore Otomasyonu

**Hedef:** Veritabanı ve konfigürasyon yedeklerinin güvenilir, test edilmiş prosedürleri.

**Kapsam:**
- PostgreSQL/TimescaleDB `pg_dump` — cronjob (günlük, 3 kopya rotasyonu)
- Backup doğrulama: `pg_restore --list` ile kontrol, boş dosya uyarısı
- S3/SFTP remote kopya (opsiyonel, yapılandırma ile)
- Restore smoke test script — yeni container'da restore + bağlantı testi
- `docker-compose.prod.yml` — backup volume mount + cronjob servisi

### 5C — Structured Logging & Metrics

**Hedef:** Container log'larından ölçülebilir observability'ye geçiş.

**Kapsam:**
- `structlog` — JSON çıktısı (level, timestamp, request_id, duration_ms, user_id)
- `/api/v1/health` genişletme: DB bağlantısı, Redis, Celery worker sayısı, TimescaleDB versiyon
- `/api/v1/metrics` — Prometheus format (istekler/sn, hata oranı, DB pool kullanımı)
- Celery task başarı/başarısız/süre metrikleri (Flower veya custom endpoint)
- Frontend: Agents sayfasına Celery task queue durumu widget

### 5D — Secret Encryption (KL-10 Kapatma)

**Hedef:** `EscalationRule.webhook_headers` ve diğer hassas webhook konfigürasyonlarını şifreli saklamak.

**Kapsam:**
- Mevcut `AgentCredentialBundle` AES-256-GCM şifrelemesini (Sprint 11G) `webhook_headers` için yeniden kullan
- `EncryptedJSON` SQLAlchemy TypeDecorator — `store/load` otomatik şifrele/çöz
- Mevcut düz metin değerleri tek seferlik migration ile şifrele
- Key rotation: yeni key ile re-encrypt (vault key versiyonlama)

### 5E — High Availability & Rollback Plan

**Hedef:** Deploy sırasında kesinti olmadan güncelleme; hatalı deploy'dan hızlı geri dönüş.

**Kapsam:**
- Blue/green container deploy: yeni image → sağlık kontrolü → traffic kesme → eski container dur
- Rollback script: önceki image tag + son başarılı migration revision'ına `alembic downgrade`
- `DEPLOY.md` — adım adım production deploy + rollback prosedürü
- Health check endpoint'i Nginx/traefik ile entegre (unhealthy → eski versiyona yönlendir)

### Faz 5 Uygulama Sırası

```
5A → Alembic (bağımsız, her şeyden önce)
5B → Backup otomasyon (5A tamamlandıktan sonra schema stable)
5C → Logging/metrics (5A ile paralel yürütülebilir)
5D → Secret encryption (5A tamamlandıktan sonra, migration güvenli)
5E → HA/rollback (5A + 5B tamamlandıktan sonra)
```

### Faz 5 Başarı Kriterleri

| Kriter | Ölçüm |
|--------|-------|
| Sıfır `ALTER TABLE` `main.py`'de | Tüm şema `alembic revision`'larında |
| Günlük backup + doğrulama | Cronjob log + alert |
| Tüm sensitif config şifreli | `webhook_headers`, credential fields → `EncryptedJSON` |
| `/health` endpoint production'da 200 | DB + Redis + Celery hepsi yeşil |
| Rollback < 5 dk | Script ile test edildi |

---

## İLERİ FAZ ⚪

### 12. Credential Vault ✅
- ✅ `CredentialProfile` modeli: SSH + SNMP (v1/v2c/v3) — Fernet şifreli parola alanları
- ✅ CRUD API (`/credential-profiles`) — şifreler API yanıtında asla döndürülmez
- ✅ `Device.credential_profile_id` — opsiyonel FK; profil atanmış cihaz bağlantıda profili kullanır
- ✅ SSH Manager: profil varsa önce profil credential'ı, yoksa cihaz alanları
- ✅ SNMP poller: profil varsa SNMP credential'ı profilden alır
- ✅ Settings → Kimlik Profilleri sekmesi (şifre durumu göstergesi, SSH/SNMP detayları)
- ✅ Cihaz formu → Kimlik Profili dropdown (profil seçilince bilgi banner'ı)
- ✅ Secret rotation (otomatik zamanlı değişim)
  - ✅ `RotationPolicy` modeli — profil başına interval, status, last/next rotate, last_result JSON
  - ✅ Celery Beat günlük `check_rotation_policies` → due policy'leri `rotate_profile` task'ına iletir
  - ✅ Vendor-aware SSH şifre değişimi (Cisco IOS/IOS-XE, Ruijie); tüm cihazlar başarılı olunca profil güncellenir
  - ✅ CRUD API: GET/POST/PATCH/DELETE `/credential-profiles/{id}/rotation-policy` + `POST /rotate-now`
  - ✅ Settings → "Şifre Rotasyonu" sekmesi: politika tablosu, "Şimdi Döndür", cihaz bazlı sonuç modal
- ✅ Group-level profile assignment — `POST /devices/groups/{id}/assign-credential-profile`; "Gruba Profil Ata" modal (GroupProfileModal)

### 16. Interface Utilization Threshold Alerting ✅ (yeni)
- ✅ `AlertRule` modeli: cihaz filtresi, interface pattern (fnmatch), metrik, eşik, ardışık poll sayısı, severity, cooldown
- ✅ CRUD API (`/alert-rules`)
- ✅ Celery SNMP poll sonrası otomatik kural kontrolü (Redis ile consecutive tracking + cooldown)
- ✅ Notification channel entegrasyonu (`threshold_alert` kanalı)
- ✅ Settings → Uyarı Kuralları sekmesi (tüm cihazlar veya tek cihaz, interface wildcard)

### 13. SNMP & Telemetri İzleme ✅
- ✅ SNMP v1/v2c desteği (puresnmp ile, asyncio-native)
- ✅ Per-device SNMP credentials (snmp_community, snmp_version, snmp_port)
- ✅ Device detail "Health" sekmesi: sysUpTime, sysDescr, sysName, sysLocation
- ✅ Interface tablosu: oper status, hız, in/out octets (64-bit HC), hata sayaçları
- ✅ SNMP polling periyodik görev (Celery Beat 5dk, snmp_poll_results tablosu)
- ✅ Interface utilization % (iki snapshot arası delta / bant genişliği, Progress bar ile)
- ✅ /snmp/{id}/utilization-history endpoint (grafik/sparkline için)
- ✅ Topology link rengi utilization'a göre (≥80% kırmızı, ≥60% turuncu, <60% yeşil; tooltip'te ↓in/↑out %)
- ✅ SNMP v3 (USM — noAuthNoPriv / authNoPriv / authPriv, MD5+SHA1 auth, DES+AES-128 priv)
- ✅ Vendor-specific CPU/RAM OID'leri (Cisco + HOST-RESOURCES-MIB fallback, Health sekmesinde daire göstergesi)

### 14. Değişiklik Yönetimi (Change Management) ✅ (kısmi — bakım pencereleri tamamlandı)
- ✅ Planlı bakım penceresi (başlangıç/bitiş tarihi, seçili cihazlar veya tüm cihazlar)
- ✅ Aktif bakım pencerelerinde SNMP threshold uyarıları otomatik susturulur
- ✅ Settings → Bakım Pencereleri sekmesi (tarih-saat aralığı + cihaz çoklu seçim)
- ✅ Değişiklik onay akışı + rollout + diff kayıt + rollback — `ChangeRollout` modeli; draft→pending_approval→approved→running→done/partial/failed/rolled_back akışı; Celery task (cihaz başına yedek al → uygula → diff kaydet); rollback task (yedekten geri yükle); `/change-rollouts` CRUD + submit/approve/reject/start/rollback API; `/change-management` sayfası (sidebar menü, Drawer detay, per-device diff görüntüleyici)

### 9. Gelişmiş Forensics Audit ✅
- ✅ `request_id` (UUID) — her API isteğine middleware tarafından atanır, `X-Request-ID` header'ında döner
- ✅ `duration_ms` — CLI komut süreleri ve genel request süresi audit'e kaydedilir
- ✅ `before_state` / `after_state` — device_updated aksiyonunda hangi alan ne'den ne'ye değişti JSON olarak kaydedilir
- ✅ `client_ip`, `user_agent` — zaten mevcut, API yanıtına eklendi
- ✅ Audit log API — `date_from/date_to`, `status`, `request_id` filtreleri eklendi
- ✅ Frontend AuditLog sayfası — Before/After diff tablosu (renk kodlu), süre kolonu, tarih aralığı filtresi, detay modal
- ⚪ Session replay — yüksek maliyet, AuditLog + komut arşivi yeterli (ertelendi)

### SSO / SAML / OIDC
- Kurumsal identity provider entegrasyonu
- MFA
- IP allowlist
- Just-in-time privilege escalation

### Bant Genişliği Monitörü ✅
- ✅ `/snmp/top-interfaces` endpoint — en yüksek utilization'a göre sıralı interface listesi (subquery ile tek satır/cihaz+interface)
- ✅ Frontend `/bandwidth` sayfası — threshold slider, auto-refresh, limit seçimi, arama
- ✅ Kritik/uyarı badge sayaçları, utilization progress bar (renk kodlu)
- ✅ Sidebar'a "Bant Genişliği" menü öğesi eklendi

### Uyumluluk Trend Analizi ✅
- ✅ `/security-audit/fleet-trend` endpoint — günlük ortalama/min/max skor zaman serisi
- ✅ Haftalık otomatik uyumluluk taraması (Celery Beat — tüm aktif cihazlar)
- ✅ `snmp_tasks` Celery include listesine eklendi (task keşif hata düzeltmesi)
- ✅ SecurityAudit sayfasında "Filo Uyumluluk Trendi" recharts AreaChart — gün bazlı ortalama skor, min/max band, referans çizgileri (A/B/C eşikleri)
- ✅ Dönem seçimi: 7/14/30/60/90 gün, delta göstergesi (▲▼ kaç puan değişti)

### SNMP Interface Hata Dashboard ✅
- ✅ `/snmp/error-interfaces` endpoint — CTE + ROW_NUMBER ile son iki poll arası in/out error delta, errors/dk hesaplama
- ✅ `/snmp/{device_id}/error-history` endpoint — interface başına son N poll'un hata geçmişi (delta hesaplamalı)
- ✅ `ErrorInterface` / `ErrorHistoryPoint` TypeScript tipleri, `getErrorInterfaces` / `getErrorHistory` API metodları
- ✅ BandwidthMonitor sayfası sekmeli yapıya dönüştürüldü: "Bant Genişliği" + "Interface Hataları"
- ✅ Hata sekmesi: istatistik kartları (hatalı interface sayısı, toplam delta, en yüksek oran), filtreli tablo, expandable satırda son 24 poll BarChart

### Config Şablon Push ✅
- ✅ `ConfigTemplate` modeli — şablon metni `{değişken}` sözdizimi ile, değişken tanımları JSON'da
- ✅ CRUD API (`/config-templates`) — şablon oluştur/düzenle/sil
- ✅ Push endpoint — birden fazla cihaza eş zamanlı push, dry-run desteği
- ✅ Preview endpoint — değişkenler doldurulmuş şablon önizlemesi
- ✅ Frontend: şablon listesi, değişken editörü, push modal (device seçimi + değişken formu + dry-run)
- ✅ 4 hazır şablon (NTP, Syslog, Banner MOTD, AAA kullanıcı)

### EOL / Lifecycle Yönetimi ✅
- ✅ AssetLifecycle modeli — satın alma, garanti, EOL, EOS tarihleri (önceki sprint)
- ✅ `/asset-lifecycle/stats` endpoint — warranty/EOL/EOS yaklaşan tarihleri tek listede
- ✅ Dashboard widget — 90 gün içindeki garanti/EOL/EOS bitişleri tablo olarak (renk kodlu kalan gün)
- ✅ Celery Beat daily task — 7/30/90 gün eşiklerinde notification channel'larına uyarı gönderir
- ✅ SNMP Interface Utilization Charts — DeviceDetail Health sekmesinde her interface satırı expandable; son 48 poll verisi AreaChart olarak gösterilir (recharts)
- ✅ Otomatik EOL lookup — `eol_lookup.py` statik veritabanı (Cisco/Aruba/Ruijie/Fortinet 120+ model); `POST /asset-lifecycle/eol-lookup`; AssetLifecycle sayfasında "EOL Otomatik Ara" butonu + sonuç modal

### Bekleyen Deploy & Test Görevleri ✅
- ✅ **VPS deploy** — tamamlandı (2026-05-04)
- ✅ **Yerel agent servisi yeniden başlat** — tamamlandı (2026-05-04, PID 2802)
- ✅ **Sprint 12 VPS deploy** — tamamlandı (2026-05-04)
- 🔵 **Sprint 11 + 12 özelliklerini test et** — SNMP GET/WALK, risk skoru, MTTR/MTBF, zaman çizelgesi

### SNMP Trap Receiver ⚪
- ⚪ Pasif trap dinleme (UDP 162) — şu an sadece GET/WALK (aktif sorgulama) var
- Önce syslog toplayıcı kullanım verisi toplanmalı, talep varsa eklenir

### Multi-Tenant ⚪
- Müşteri bazlı tenant izolasyonu
- Tenant scoped RBAC & reporting
- MSP/SaaS hazır mimari

### AI Destekli Öneriler ⚪ (Uzun Vade)
- "Bu cihaz neden offline olabilir?"
- "Son config değişikliği ile olay arasında ilişki var mı?"
- "Bu topolojide single point of failure var mı?"
- Önce güçlü veri modeli şart — altyapı hazırlanmadan anlamsız

---

## SPRINT 12 — Intelligence Fundamentals ✅

> Kaynak: `yenifikir.md` analizi | Tamamlandı: 2026-05-04

### 12A. Cihaz Risk Skoru ✅
- ✅ Mevcut sinyalleri birleştirerek cihaz başına **0–100 risk puanı**: compliance (25%) + uptime 7g (30%) + flapping (20%) + yedek tazeliği (25%)
- ✅ `GET /intelligence/devices/{id}/risk-score` — breakdown dahil
- ✅ `GET /intelligence/fleet/risk` — filo özeti + en riskli N cihaz
- ✅ Dashboard "Cihaz Risk Analizi" widget'ı — kritik/yüksek/orta/düşük dağılım + liste
- ✅ Device detail "Risk & SLA" sekmesi — skor dairesi, Descriptions breakdown

### 12B. MTTR & MTBF Analizi ✅
- ✅ `GET /intelligence/devices/{id}/mttr-mtbf` — pencere parametreli
- ✅ `device_offline` → `device_online` çiftlerinden MTTR; ardışık online sürelerden MTBF
- ✅ Device detail "Risk & SLA" sekmesinde arıza istatistikleri kartı

### 12C. Config/Olay Zaman Çizelgesi ✅
- ✅ `GET /intelligence/devices/{id}/timeline` — config backup + network_events + audit_log birleşik
- ✅ Config değişikliği → 10dk içinde olay varsa `correlated_backup: true` + ipucu etiketi
- ✅ Device detail yeni "Zaman Çizelgesi" sekmesi — ikon, severity rengi, korelasyon badge

### 12D. Topoloji Farkındalıklı Uyarı Bastırma ✅
- ✅ `_correlate_offline_events` gerçek topoloji BFS ile yeniden yazıldı (`topology_links` tablosu)
- ✅ Cascade child cihazları tespit edilir; tek bir `correlation_incident` root cause event yazılır
- ✅ Etkilenen cihaz sayısı ve adları event details'te kaydedilir

---

## SPRINT 13 — Advanced Intelligence Layer ✅

> Kaynak: `yenifikir.md` | Tamamlandı: 2026-05-04

### 13A. Root Cause Engine v2 ✅
- ✅ `GET /intelligence/root-cause-incidents` — son N saatin correlation_incident olayları (hours, limit param)
- ✅ Dashboard "Kök Neden Tespitleri" widget'ı — root cihaz, etkilenen sayısı, bastırılan uyarı sayısı
- ✅ Topology BFS zaten Sprint 12D'de yazıldı (monitor_tasks.py); bu sprint API + UI katmanı eklendi

### 13B. Koşullu Otomasyon Motoru ✅
- ✅ `condition_check` adım tipi — `evaluate_condition()` ile güvenli AST değerlendirme
- ✅ Whitelist kontrolü: sadece Compare, BoolOp, Attribute, Name, Constant düğümleri
- ✅ `on_true: continue` / `on_false: skip | abort` — skip=başarılı sayılır, abort=stop_on_error devreye girer
- ✅ Dry-run'da koşul sonucu ve explanation string döndürülür
- ✅ Playbook editor UI'a "Koşul Kontrolü" adım tipi + koşul ifadesi + on_false seçici eklendi
- ✅ `device.offline_duration_min`, `time.is_business_hours`, `time.hour`, `time.weekday` context alanları

### 13C. Servis Etki Haritalama ✅
- ✅ `Service` modeli (`services` tablosu) — name, priority, description, business_owner, device_ids[], vlan_ids[]
- ✅ `GET /services` · `POST /services` · `PATCH /services/{id}` · `DELETE /services/{id}` — tam CRUD
- ✅ `GET /services/fleet/impact-summary` — tüm aktif servisler için toplu etki özeti
- ✅ `GET /services/{id}/impact` — offline cihaz listesi, etki yüzdesi, impact_level hesaplama
- ✅ `/services` sayfası — tablo, oluşturma/düzenleme drawer (Transfer ile cihaz seçimi), etki modal
- ✅ Dashboard "Aktif Servis Kesintileri" widget'ı — sadece etkilenen servisler gösterilir
- ✅ DeviceDetail Risk & SLA sekmesinde "Bu Cihazın Dahil Olduğu Servisler" rozetleri

---

## SPRINT 14 — Network Analytics & Digital Twin ✅

> Kaynak: `yenifikir.md` | Tamamlandı: 2026-05-04

### 14A. Ağ Davranış Analitiği ✅
- ✅ `NetworkBaseline` modeli — cihaz başına EMA rolling baseline (mac_count, traffic_in_pct, traffic_out_pct, vlan_count)
- ✅ `update_baselines` Celery task (günlük) — MAC/trafik/VLAN için 7 günlük EMA güncelleme
- ✅ `detect_anomalies` Celery task (30 dakikada bir) — baseline 2× aşımı tespiti
- ✅ Anomali tipleri: `mac_anomaly`, `traffic_spike`, `vlan_anomaly`, `mac_loop_suspicion`
- ✅ `GET /intelligence/anomalies` endpoint — tip bazlı sayaç + olay listesi
- ✅ Dashboard "Anormal Davranışlar" widget'ı — 4 sayaç kartı + son anomaliler listesi

### 14B. Network Digital Twin ✅
- ✅ `TopologySnapshot` modeli — topoloji anlık görüntüsü (links JSONB)
- ✅ CRUD API (`/topology-twin/snapshots`) — oluştur/listele/sil
- ✅ `POST /topology-twin/snapshots/{id}/set-golden` — altın baseline atama
- ✅ `GET /topology-twin/diff` — actual vs expected karşılaştırması (added/removed/unchanged)
- ✅ `check_topology_drift` Celery task (6 saatte bir) — `topology_drift` event'i
- ✅ `/topology-twin` sayfası — anlık görüntü tablosu + diff analizi (Tabs), sidebar menü

### 14C. Agent Edge Intelligence ✅
- ✅ Agent sliding window SSH error rate tracker (`_ssh_window` deque, son 20 komut)
- ✅ SNMP EMA latency tracker — `_record_snmp_latency_ms()` + EMA hesaplama
- ✅ `_edge_anomaly_check()` coroutine — 5 dakikada bir SSH hata oranı + SNMP latency kontrol
- ✅ `_maybe_send_anomaly()` — 30 dk cooldown'lu `local_anomaly` WebSocket mesajı
- ✅ `agent_manager._handle_local_anomaly()` — NetworkEvent persist + Redis publish
- ✅ Disconnect tekrar sayacı — ≥3 ardışık kesinti loglanır

---

## TARTIŞMAYA AÇIK — Benim Görüşlerim

### Yapmamalı veya Ertelemeli

| Fikir | Neden |
|---|---|
| Wireless AP haritası | Çok vendor-specific (Cisco WLC vs Aruba vs Ruckus), ilk fazda kapsam dışı |
| PoE detay sekmesi | Sadece PoE switch kullananlar için değerli, düşük öncelik |
| Capacity planning | 6+ ay veri gerektirir, şimdi anlamsız |
| Session replay (terminal) | Yüksek geliştirme maliyeti, limited değer. AuditLog + komut arşivi yeterli |
| **Platform mikro-servisler** | Monolith sorun değil, bölünme 2-3 aylık iş, öncelikli değil |
| **Template/Parser Engine (tam)** | Netmiko zaten vendor abstraction yapıyor; full abstraction = yüksek maliyet, düşük kazanç |
| **AI/ML runtime inference** | Kural tabanlı risk score + root cause yeterli; gerçek ML için 12+ ay veri şart |

### Zaten Yapıyoruz (Ekstra İş Gerekmez)

| Fikir (yenifikir.md) | Mevcut Karşılığı |
|---|---|
| Alert deduplication | ✅ Redis TTL bazlı dedup (monitor_tasks.py) |
| Maintenance window suppression | ✅ AlertRule + bakım penceresi (Sprint 14) |
| Config drift detection | ✅ Golden baseline + daily Celery task (Sprint 9) |
| Blast radius analizi | ✅ Topology BFS graph traversal (Sprint 1) |
| Flapping detection | ✅ Saatte ≥4 değişim → flapping event |
| Agent offline queue | ✅ Sprint 11 F3 |
| Temel event correlation | ✅ ≥3 cihaz offline → upstream heuristic |

### En Kritik Sonraki Adımlar (Öneri)

**Sprint 12 → Anında başlanabilir (mevcut veri yeterli):**
1. **Risk Skoru** — en somut, dashboard'a doğrudan eklenir, satış değeri yüksek
2. **Topoloji farkındalıklı uyarı bastırma** — operasyonel acı noktası (alert flood)
3. **MTTR/MTBF** — SLA raporlarına kritik katkı, 2 günlük iş

**Sprint 13 → Sonra:**
4. **Root Cause Engine v2** — mevcut heuristic'i gerçek topoloji traversal'a yükselt
5. **Config/Olay Timeline** — "config değişikliği olayı tetikledi mi?" sorusu her zaman geliyor

**Daha sonra değerlendir:**
6. Koşullu Otomasyon, Servis Etki, Digital Twin, Davranış Analitiği

---

## Teknik Borçlar & İyileştirmeler

- ✅ WatchFiles reload loop — `--reload-delay 3` eklendi
- ✅ bcrypt passlib uyarısı — `bcrypt==4.0.1` pinlendi
- ✅ Audit log route sıralaması düzeltildi
- ✅ Dashboard analytics `_: CurrentUser = None` → açık auth zorunlu hale getirildi (monitor, asset_lifecycle, interfaces)
- ✅ Frontend TypeScript `import.meta.env` tip hatası — `vite-env.d.ts` eklendi
- ✅ IPAM VLAN bazlı tarama — MacAddressEntry cross-ref (VLAN 2460 için)
