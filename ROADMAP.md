# NetManager — Ürün Yol Haritası

> Son güncelleme: 2026-04-23  
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

## SPRINT 6 — Akıllı Keşif & Onboarding 🔄

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

### 13. SNMP & Telemetri İzleme 🔄
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

### Multi-Tenant
- Müşteri bazlı tenant izolasyonu
- Tenant scoped RBAC & reporting
- MSP/SaaS hazır mimari

### AI Destekli Öneriler (Uzun Vade)
- "Bu cihaz neden offline olabilir?"
- "Son config değişikliği ile olay arasında ilişki var mı?"
- "Bu topolojide single point of failure var mı?"
- Önce güçlü veri modeli şart — altyapı hazırlanmadan anlamsız

---

## TARTIŞMAYA AÇIK — Benim Görüşlerim

### Yapmamalı veya Ertelemeli

| Fikir | Neden Ertelenir |
|---|---|
| Wireless AP haritası | Çok vendor-specific (Cisco WLC vs Aruba vs Ruckus), ilk fazda kapsam dışı |
| PoE detay sekmesi | Sadece PoE switch kullananlar için değerli, düşük öncelik |
| Capacity planning | 6+ ay veri gerektirir, şimdi anlamsız |
| Session replay (terminal) | Yüksek geliştirme maliyeti, limited değer. AuditLog + komut arşivi yeterli |

### Zaten Yapıyoruz (Ekstra İş Gerekmez)

| Kullanıcı İsteği | Mevcut Karşılığı |
|---|---|
| "Config diff" | ✅ Tamamlandı (bu oturumda) |
| "Config compliance" | ✅ Tamamlandı (bu oturumda) |
| "Flapping detection" | ✅ Tamamlandı (önceki oturum) |
| "Event correlation" | ✅ Tamamlandı (önceki oturum) |
| "Agent health dashboard" | ✅ Dashboard Intelligence içinde |
| "Backup compliance widget" | ✅ Dashboard Intelligence içinde |
| "Ghost node tespiti" | ✅ Topoloji keşfinde var |

### En Kritik 5 Sonraki Adım (Benim Önerim)

1. **Topoloji Blast Radius** — tek bir görsel özellik, çok güçlü satış argümanı
2. **Automation/Playbooks** — ürünü "yönetim paneli"nden "otomasyon platformu"na taşır
3. **Güvenli CLI (denylist + approval)** — üretimde kullanım için zorunlu
4. **PDF Rapor + Email Digest** — C-level'e gösterilecek çıktı
5. **Slack/Teams/webhook bildirimleri** — kullanıcı iş akışına entegrasyon

---

## Teknik Borçlar & İyileştirmeler

- ✅ WatchFiles reload loop — `--reload-delay 3` eklendi
- ✅ bcrypt passlib uyarısı — `bcrypt==4.0.1` pinlendi
- ✅ Audit log route sıralaması düzeltildi
- ✅ Dashboard analytics `_: CurrentUser = None` → açık auth zorunlu hale getirildi (monitor, asset_lifecycle, interfaces)
- ✅ Frontend TypeScript `import.meta.env` tip hatası — `vite-env.d.ts` eklendi
- ✅ IPAM VLAN bazlı tarama — MacAddressEntry cross-ref (VLAN 2460 için)
