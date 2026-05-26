# T9 Roadmap — Switch Network Manager Genişletme

> **Bağlam:** Kullanıcı 15 yeni fikir önerdi. Mevcut sistem audit edildi (durum tespit raporu), karşılıklı mutabık kalındı, 8 tur halinde yol haritası onaylandı. **Tur 1** ile başlanıyor.
>
> **Onay tarihi:** 2026-05-26 (mutabakat oturumunda)
> **Hedef bitiş aralığı:** ~3-4 hafta (yarı zamanlı, paralel iş yok varsayımı)
>
> **İlke:** Önce hızlı kazanım & temel altyapı → güvenlik → audit → cihaz yönetimi → konfigürasyon → monitoring → IPAM → firmware (en büyük modül sonda).

---

## 📋 Karar Tablosu (15 madde + benim önerdiklerim)

| ID | Konu | Mevcut Durum | Karar | Kapsam |
|---|---|---|---|---|
| **#1** | Tarama süresi UI | YOK | YENİ | system_settings + UI |
| **#2** | MFA | TOTP tam var | **SMS/Email kanalı ekle** | Twilio + SMTP |
| **#3** | Password policy | Yarım | YENİ | model + UI + auth check |
| **#4** | Per-user IP allowlist | YOK | **Per-user opsiyonel** | User.allowed_ips + auth filter |
| **#5** | Firmware update | YOK | YENİ (sona) | vendor wrapper + push + safety |
| **#6** | SSH session audit | API loglu, terminal değil | **Keystroke log + AI özet ikisi de** | yeni tablo + WS hook + Claude API |
| **#7** | Switch lifecycle state | is_active+soft delete | **Production/Passive/Stock/Archived** | enum + state machine + audit |
| **#8** | Port toggle + PoE | YOK | YENİ + E2 safety | vendor wrapper + 5dk rollback timer |
| **#9** | IPAM | Modeller var, UI yok | **Sıfırdan tam sayfa** | subnet+IP grid+reservation+conflict |
| **#10** | SSH/SNMP envanteri | Tam var | **Dokümante et** | docs/COLLECTION_INVENTORY.md |
| **#11** | Easy config builder | Temel var | Geliştir | schema-driven form + preview |
| **#12** | Config rollback | Backend var, UI eksik | **UI button + diff** | "bu yedeğe dön" + diff viewer |
| **#13** | Hardware health + PoE + Power | OID'ler var, dashboard yok | **4 alt-özellik** | anlık W + kWh + TL maliyet + budget alarm |
| **#14** | Switch arşiv | Soft delete var | **Lifecycle ile birleştir** | Archived state (#7 ile) |
| **#15** | Firmware repo | YOK | YENİ (sona) | binary storage + metadata + compatibility matrix |
| **E1** | Bulk operations | (Claude'un önerisi) | OPSIYONEL | toplu port/config/firmware |
| **E2** | Safety nets | (Claude'un önerisi) | EVET | 5dk rollback timer |
| **E3** | Config diff/compare | (Claude'un önerisi) | EVET (#12 ile) | 2 yedek arası fark |
| **E4** | Maintenance window | (Claude'un önerisi) | EVET (#1 ile) | belirli saatlerde frekans düşür |
| **E5** | Energy report | (Claude'un önerisi) | EVET (#13 ile) | kWh + maliyet — kullanıcı zaten istedi |
| **E6** | AI session summary | (Claude'un önerisi) | EVET (#6 ile) | kullanıcı "her ikisi de" dedi |
| **E7** | PoE schedule | (Claude'un önerisi) | OPSIYONEL | port bazlı saat tablosu |

---

## 🗺️ 8 Tur Sıralaması

### **Tur 1 — Hızlı Kazanım & Temel** ⏱ ~1-2 gün
**Hedef:** Altyapı çıkışı + dokümantasyon. Sonraki tur'lara temel oluştur.

- [ ] **#10** — `docs/COLLECTION_INVENTORY.md` (envanter dokümanı: SSH'tan ne, SNMP'ten ne, agent ile ne)
- [ ] **#1 + E4** — Sistem Ayarları UI
  - Yeni `system_settings` tablosu (key/value + scope)
  - Beat schedule dinamik (deploy edilen ayarları okur)
  - `Settings → System` tab'ı (tarama süreleri + maintenance window)
  - Per-task min/max guardrail (SNMP < 60s = uyarı)

### **Tur 2 — Güvenlik Sertleştirme** ⏱ ~2-3 gün
**Hedef:** Pentest sonrası güvenlik tasarımını tamamla.

- [ ] **#3** — Password policy
  - `password_policy` tablosu (org bazlı): min_length, complexity flags, history_count, expiry_days, force_change_on_first_login
  - Login + password change'de validation
  - UI: complexity meter + policy hint
- [ ] **#4** — Per-user IP allowlist
  - `User.allowed_ips` (comma-sep CIDR)
  - Login endpoint'inde IP check (deny + audit)
  - Profile UI'da self-management
- [ ] **#2b** — MFA SMS/Email kanal eklemesi
  - Twilio integration (config opsiyonel — env'den)
  - SMTP-based email OTP (mevcut SMTP setup)
  - `mfa_methods` CSV güncelle (`totp,sms,email`)
  - Login challenge'da method seçim UI

### **Tur 3 — SSH Session Audit (büyük tek iş)** ⏱ ~3-4 gün
**Hedef:** Forensik düzey görünürlük. Pentest sonrası enterprise gereksinim.

- [ ] **#6 + E6** — Terminal session log + AI özet
  - Yeni `terminal_session_logs` tablosu
    - session_id, user_id, device_id, started_at, ended_at, exit_reason
    - keystrokes (jsonb veya text — buffer'lı)
    - commands_extracted (jsonb — heuristic ile çıkarılan)
    - ai_summary (text — Claude API yanıtı)
    - duration_ms, byte_count
  - WS handler hook: input/output her event log'a yaz (asenkron, perf etkilemesin)
  - Session bitince: AI özet job (Celery task → Claude API → write back)
  - UI: `/sessions` sayfası — liste + detay viewer (komut + çıktı oynatıcı)

### **Tur 4 — Envanter & Cihaz Yönetimi** ⏱ ~2-3 gün
**Hedef:** Cihaz yaşam döngüsü + güvenli port operasyonları.

- [ ] **#7 + #14** — Lifecycle states
  - `Device.lifecycle_status` enum: `production | passive | stock | archived`
  - State machine: izinli geçişler tablosu (örn. archived → production direkt değil, önce stock'tan geçmeli)
  - State-aware action gating (archived'a SSH komut atılamaz)
  - Audit log her geçişi kaydeder (#6 entegrasyon yok ama audit_logs'a yazar)
  - UI: cihaz detay sayfasında state dropdown + "Arşive Al" butonu
- [ ] **#8 + E2** — Port toggle + PoE control
  - Vendor wrapper: Cisco/Aruba/Ruijie için shutdown/no-shutdown ve power-inline never/auto
  - Safety: "5 dakika içinde geri al" mekanizması
    - Backend timer (Celery countdown task) → istek geri alma butonu basılmazsa otomatik geri yükle
  - UI: cihaz detay → port listesi → her port için toggle + PoE button + safety countdown
  - Tüm toggle'lar audit'lenir

### **Tur 5 — Konfigürasyon** ⏱ ~3-4 gün
**Hedef:** Kullanıcı CLI bilmeden config yapabilsin.

- [ ] **#11** — Easy config builder (geliştirme)
  - DriverTemplate'a JSON Schema desteği ekle (input alanları)
  - UI: form üretici (schema → React form) + canlı CLI preview
  - 3 aksiyon: indir / panoya kopyala / "Bu cihaza uygula"
- [ ] **#12 + E3** — Config rollback UI + diff
  - Backup sayfasına "Bu yedeğe dön" butonu (mevcut endpoint çağrılır)
  - 2 yedek arası diff viewer (monaco diff component)
  - Çalışan config vs son yedek diff
- [ ] **E1 (OPSİYONEL)** — Bulk operations
  - Cihaz listesinde checkbox + toplu aksiyonlar: config push, port shutdown, agent restart

### **Tur 6 — Monitoring & Enerji** ⏱ ~2-3 gün
**Hedef:** PoE/güç görünürlüğü + maliyet.

- [ ] **#13 + E5** — Hardware health + PoE + Energy
  - POWER-ETHERNET-MIB OID'leri: pethPsePortPowerSupportedSwitchPoEPlus, pethMainPseConsumptionPower, vs
  - ENTITY-SENSOR-MIB OID'leri: temperature, fan, PSU status
  - SNMP poller'a yeni OID'ler + `poe_power_snapshots` tablosu (time-series)
  - 4 alt-özellik UI:
    1. Anlık PoE güç (switch + port bazı, gauge)
    2. Aylık kWh tüketim grafiği (zaman serisi)
    3. TL/$ maliyet hesap (org settings'te kWh tarifesi → çarp)
    4. PoE budget alarm (kapasitenin %X üstüne çıkınca → network_event)
- [ ] **E7 (OPSİYONEL)** — PoE schedule
  - Port bazlı haftalık zaman tablosu (örn. Pazartesi 19:00 - 07:00 kapat)
  - Celery cron task → power-inline never/auto

### **Tur 7 — IPAM Sıfırdan** ⏱ ~3-4 gün
**Hedef:** Tam IPAM modülü.

- [ ] **#9** — IPAM page
  - Subnet listesi sayfası: utilization %, free count, VLAN, gateway
  - IP grid: subnet detayı → IP'ler tablo (static/dynamic/reserved/free, atanmış cihaz)
  - Reservation: "Bu IP rezerve, kimseye verme" + neden + tarih
  - Conflict detection: aynı IP iki cihazda → alarm
  - DHCP lease tracking (opsiyonel — sadece DHCP server'a SSH/SNMP erişim varsa)

### **Tur 8 — Firmware Management** ⏱ ~5-7 gün
**Hedef:** En büyük ve en riskli modül. Sona bıraktık.

- [ ] **#5 + #15** — Firmware update + repository
  - **Vendor seçimi** — açık soru, başlamadan önce kararlaştırılacak
  - Backend: `firmware_images` tablosu (vendor, model, version, file_path, sha256, release_notes)
  - Storage: local FS veya S3/MinIO (env yapılandırılabilir)
  - Upload endpoint: dosya + metadata
  - Compatibility matrix: model → desteklenen versiyon aralığı
  - Push protokolü: TFTP / SCP / HTTP (vendor-aware)
  - Pre-check: disk alanı, uptime, link
  - Staged rollout: 1 cihaza dene → success → toplu
  - Safety: rollback (mevcut firmware backup)
  - Maintenance window check
  - UI: `Firmware` sayfası — depo + cihaz match + push wizard

---

## 🔗 Bağımlılıklar

```
Tur 1 (system_settings tablosu) ──┬─→ Tur 6 (PoE schedule)
                                  └─→ Tur 8 (maintenance window check)

Tur 3 (audit_logs hook) ──→ Tur 4 (state change audit), Tur 4 (port toggle audit)

Tur 5 (#11 template) ──→ Tur 5 (#12 rollback aynı UI)

Tur 7 (IPAM) ──┬─→ Tur 4 (cihaz IP'leri IPAM'den çekilebilir)
               └─→ #13 (subnet bazlı enerji rapor)
```

---

## ✅ Karar Günlüğü

| Tarih | Konu | Karar |
|---|---|---|
| 2026-05-26 | #2 MFA | SMS/Email kanal ekle (TOTP'a ek) |
| 2026-05-26 | #4 IP allowlist | Per-user opsiyonel |
| 2026-05-26 | #6 Session audit | Keystroke log + AI özet ikisi de |
| 2026-05-26 | #5/#15 Firmware vendor | Sonra ele alacağız |
| 2026-05-26 | #7+#14 Lifecycle | 4 state: Production/Passive/Stock/Archived |
| 2026-05-26 | #13 Energy report | 4 alt-özellik (anlık W + kWh + TL + alarm) |
| 2026-05-26 | #9 IPAM | Sıfırdan tam sayfa |
| 2026-05-26 | Yol haritası | Onaylı, Tur 1 ile başlandı |

---

## 📝 Not / Açık Sorular

- **Tur 3 AI özet:** Claude API key kim sağlayacak? (Org settings'te tanımlı bir field mı, env mi?)
- **Tur 6 SNMP OID'leri:** Hedef cihazlar (Ruijie/Aruba) hangi MIB'leri destekliyor? Önce 1 cihaza SNMP walk yap, gerçek OID listesini çıkar.
- **Tur 8 Firmware vendor:** Cisco / Aruba / Ruijie arasından hangisi öncelikli? Müşteri filosunda hangisi dominant?
- **Tur 7 DHCP lease:** Müşteri DHCP server'ları nerede? (Switch'in kendi DHCP'si mi, ayrı server mı?)

---

*Bu doküman roadmap'in canlı versiyonudur. Her tur tamamlandığında ilgili `[ ]` checkbox'lar `[x]` yapılır + karar günlüğü güncellenir.*
