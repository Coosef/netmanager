# T10 C7 — Device Detail Feature Parity Analizi

> **Amaç:** Eski `DeviceDetail` (modal, 1868 satır) → yeni `DeviceDetailPage` (route `/devices/:deviceId`, 9 sekme) geçişinde her özellik, buton, aksiyon ve veri kaynağını işaretle. Kayıp fonksiyonları öncelik sırasıyla geri ekleme planı çıkar. Tasarım referansı `/Netmanager/` mockup (Charon ile aynı NOC paleti) — fonksiyonel kayıp yok kuralı.

## A. ESKİ MODAL — 10 sekme tam envanteri

Kaynak: [DeviceDetail.tsx](../frontend/src/pages/Devices/DeviceDetail.tsx) (1868 satır, hâlâ diskte ama hiçbir yerden import edilmiyor — dead code).

| Sekme | Bölüm / Butonlar | Veri kaynağı | RBAC | Notlar |
|---|---|---|---|---|
| **1. Bilgiler** (info) | Cihaz meta (Descriptions) · "SSH'tan Bilgi Çek" · "SSH Test Et" · "Komşuları Tara" (auto switch to neighbors) · "SNMP Yapılandır" modal · "SNMP Trap Forwarding" modal | `devicesApi.get` / `fetchInfo` / `testConnection` / `topologyApi.discoverSingle` / `devicesApi.configureSnmp` / `configureTrapForwarding` | viewer read, canConnect SSH actions, org_admin SNMP | Konteyner Page header'da bilgilerle aynı |
| **2. Canlı Config** (config) | "Yenile" · "Kopyala" · "Güvenlik Tarama" (policy check modal) · running-config preview (mono text) | `devicesApi.getConfig` / `checkConfigPolicy` | canConnect | enabled tab=config; cache 5dk |
| **3. Yedekler** (backups) | Liste tablosu · "Yedek Al" · "⭐ Altın işaretle" · "Diff: from→to" 2-way modal · "İndir" · içerik preview panel · Config drift alert | `devicesApi.getBackups` / `getBackupContent` / `takeBackup` / `setGoldenBackup` / `getConfigDiff` / `getConfigDrift` | canBackup yazma, herkes okuma | drift alert sayfa header'ında uyarı |
| **4. Portlar** (interfaces) | Visual SwitchPortPanel ↔ Table toggle · Port satırı: status/VLAN/duplex/speed/util · "Aç/Kapat" (shutdown/no-shutdown) · "VLAN Ata" per port modal · "Yenile" + cache yaşı · per-port UtilizationChart (recharts 48h) | `devicesApi.getInterfaces` / `toggleInterface` / `assignVlan` / `snmpApi.getInterfaces` / `getUtilizationHistory` | canConnect yazma actions | enabled tab=interfaces; force refresh ile re-fetch |
| **5. VLAN** (vlans) | VLAN liste tablosu · "VLAN Oluştur" modal (id+name) · "VLAN Sil" Popconfirm (id=1 hariç) | `devicesApi.getVlans` / `createVlan` / `deleteVlan` | canConnect yazma | enabled tab=vlans |
| **6. Terminal** (terminal) | Komut input + Send · readline history (cmd/output/ok renkli) · "Salt-okunur mod" toggle · "Onay akışı" toggle · destructive cmd → confirm modal · approval_required cmd → "[ONAY GEREKLİ]" mesajı | `devicesApi.runCommand` / `setReadonly` / `update({approval_required})` | canConnect | needs_confirm + needs_approval state machine |
| **7. Komşular** (neighbors) | LLDP/CDP komşu tablosu · "Yeniden Tara" · cihaz envanterinde varmı işareti | `devicesApi.getNeighbors` / `topologyApi.discoverSingle` | viewer+ | enabled tab=neighbors |
| **8. Syslog** (syslog) | Network events tablosu · severity/type/timestamp/ack | `devicesApi.getEvents` | viewer+ | enabled tab=syslog |
| **9. Değişiklikler** (activity) | Audit log tablosu — user actions + approval workflow entries | `devicesApi.getActivity` | viewer+ (audit_logs RBAC) | enabled tab=activity |
| **10. Sağlık** (health) | SNMP CPU/Memory chart · SNMP interfaces status tablosu · UtilizationChart per port | `snmpApi.getHealth` / `getInterfaces` | viewer+ | enabled tab=health AND snmp_enabled |

**Toplam:** 10 sekme · ~34 ayrı buton/aksiyon · 22 ayrı API endpoint · 3 ayrı RBAC kapısı (`canConnect` / `canBackup` / audit RBAC).

## B. YENİ DETAIL PAGE — 9 sekme tam envanteri

Kaynak: [DeviceDetailPage.tsx](../frontend/src/pages/Devices/DeviceDetailPage.tsx) + [detail/*.tsx](../frontend/src/pages/Devices/detail/).

| Sekme | Bölüm / Butonlar | Veri kaynağı | RBAC | C7 fazı |
|---|---|---|---|---|
| **1. Genel** (overview) | Cihaz meta Descriptions (vendor/os/site/agent/lifecycle/timestamps) | `devicesApi.get(id)` | viewer+ | C7.B |
| **2. Portlar** (ports) | Tablo: name/desc/status/VLAN/MAC/policy/⚠flap · checkbox seçim · sticky toolbar (Policy ata drawer / Override kaldır / Shutdown disabled / Seçimi temizle) | `getInterfaces` / `macArpApi.getMacTable` / `portPolicyAssignmentsApi.list+bulkSet+remove` / `securityPoliciesApi.list('port')` / `monitorApi.getEvents` | viewer read, org_admin yazma | C7.C |
| **3. Güvenlik Politikası** (security) | Switch policy dropdown · Port policy dropdown · Save · Effective Resolver Zinciri kartı · per-port override count + Portlar link | `securityPoliciesApi.list('switch'\|'port')` / `devicesApi.update` / `portPolicyAssignmentsApi.list` | viewer read, org_admin yazma | C7.B (C6b'den taşındı) |
| **4. VLAN** (vlan) | VLAN tablo (id/name/status/port count) | `devicesApi.getVlans` | viewer+ | C7.D |
| **5. MAC Tablosu** (mac) | MAC/port/VLAN/type/last_seen · client-side arama | `macArpApi.getMacTable({device_id, limit:500})` | viewer+ | C7.D |
| **6. PoE** (poe) | Statistic kart (total/active/W/mW) · port tablo · 404 → friendly empty | `poeApi.device(id)` | viewer+ | C7.D |
| **7. Olaylar** (events) | severity chip · 🛡 policy_only chip · 24sa/7gün toggle · satır click → Drawer | `monitorApi.getEvents({device_id, severity, hours, policy_only})` | viewer+ | C7.D |
| **8. Config Backup** (backup) | Backup liste · indir · "Şimdi Backup Al" Popconfirm · ⭐ Altın işaretle | `devicesApi.getBackups / downloadBackup / takeBackup / setGoldenBackup` | viewer read, org_admin yazma | C7.D |
| **9. Aksiyonlar** (actions) | 4 kart: Çalıştırma (Bağlantı Testi/Bilgi Çek) · Yaşam Döngüsü (lifecycle dropdown+Uygula+Arşive Al) · Yer-Arşiv (Backup link) · Tehlikeli Bölge (Sil) · Shutdown DISABLED + tooltip | `testConnection / fetchInfo / updateLifecycle / delete` | role-gated | C7.D |

**Toplam:** 9 sekme · ~30 buton/aksiyon (18 canlı + 8 stub/disabled) · 17 API endpoint.

## C. PARITY MATRİSİ — Eski ↔ Yeni mapping

| Eski sekme | Yeni karşılığı | Durum | Kayıp özellikler |
|---|---|---|---|
| **1. Bilgiler** | Overview + Actions | 🟡 **KISMI** | SNMP Configure modal (v2c/v3) · Trap Forwarding modal · "Komşuları Tara" |
| **2. Canlı Config** | ❌ yok | 🔴 **TAM KAYIP** | running-config preview · kopyala · Güvenlik Tarama (policy check) |
| **3. Yedekler** | Backup | 🟡 **KISMI** | Backup içerik preview · 2-way Diff modal · Config Drift visual alert |
| **4. Portlar** | Ports | 🟡 **KISMI** | Port shutdown/no-shutdown (C5 placeholder → ileride) · per-port "VLAN Ata" · Visual SwitchPortPanel · per-port UtilizationChart (recharts 48h) |
| **5. VLAN** | VLAN | 🟡 **KISMI** | "VLAN Oluştur" · "VLAN Sil" |
| **6. Terminal** | ❌ yok (ayrı `/ssh/:deviceId` route var) | 🔴 **TAM KAYIP** (gömülü) | In-app REPL · readonly toggle · approval toggle · confirm/approval modal akışları |
| **7. Komşular** | ❌ yok | 🔴 **TAM KAYIP** | LLDP/CDP komşu tablosu · "Yeniden Tara" |
| **8. Syslog** | Events | 🟢 **PARITY+** (yeni filtreler eklenmiş) | (kayıp yok — gelişmiş) |
| **9. Değişiklikler** | ❌ yok | 🔴 **TAM KAYIP** | Audit log device-scoped görünüm |
| **10. Sağlık** | ❌ yok | 🔴 **TAM KAYIP** | SNMP CPU/Memory chart · SNMP interfaces status |
| — | PoE | ➕ Yeni | (eskide yok) |
| — | Security | ➕ Yeni | (C7 epiği) |
| — | MAC | ➕ Yeni | (C7.D — eski MacArp page'inden alındı) |
| — | Actions | ➕ Yeni | (lifecycle + delete tek yerde) |

**Özet:** 4 sekme tam kayıp (Canlı Config, Terminal, Komşular, Sağlık, Değişiklikler = 5 sekme), 4 sekme kısmi (Bilgiler/Yedekler/Portlar/VLAN), 1 sekme parity+ (Syslog→Events), 4 sekme yeni eklendi (PoE/Security/MAC/Actions).

## D. KAYIP ÖZELLİKLER — Öncelik sırası

### 🔴 P1 — KRİTİK (operasyonel etki yüksek, hemen geri)
1. **Terminal sekmesi** — In-app SSH REPL. Kullanıcılar şu an external SSH client'a düşüyor. **Hedef sekme:** Yeni "Terminal" 10. sekme veya Actions tab'ında alt-tab. **Reuse:** `components/SshTerminal.tsx` (xterm-tabanlı, mevcut) + `/ssh/:deviceId` page logic.
2. **Canlı Config (running-config preview + kopyala + Güvenlik Tarama)** — SSH'tan canlı config çek, göster, policy check. **Hedef sekme:** "Canlı Config" yeni 11. sekme veya Backup tab'ı alt-tab. **Reuse:** `devicesApi.getConfig` + `checkConfigPolicy`.
3. **Config Diff (2-way)** — İki backup karşılaştır. **Hedef:** BackupTab içinde "Diff" satır aksiyonu + side-by-side modal. **Reuse:** `devicesApi.getConfigDiff`.
4. **Backup content preview** — Backup satırına tıkla → içerik panelinde göster. **Hedef:** BackupTab — satır expand veya drawer. **Reuse:** `devicesApi.getBackupContent`.

### 🟡 P2 — YÜKSEK (operasyonel iş akışı için gerekli)
5. **VLAN Create + Delete** — VlanTab'a "VLAN Oluştur" buton + her satıra "Sil" Popconfirm. **Reuse:** `createVlan` / `deleteVlan`.
6. **Per-port VLAN Ata** — PortsTab'a row aksiyonu "VLAN Ata" modal (access/trunk + vlan_id). **Reuse:** `assignVlan`.
7. **Config Drift visual alert** — BackupTab header'ında "Cihaz config drift'te" uyarı. **Reuse:** `getConfigDrift`.

### 🟠 P3 — ORTA (kullanışlı ama acil değil)
8. **Komşular sekmesi** — LLDP/CDP komşu tablosu + Yeniden Tara. **Hedef:** Yeni "Komşular" sekme veya Overview alt-tab. **Reuse:** `getNeighbors` / `discoverSingle`. Alternatif: Topology sayfasına link verilen pattern devam edebilir.
9. **Değişiklikler (Audit) sekmesi** — Cihaz-scoped audit log. **Hedef:** Yeni "Değişiklikler" sekmesi veya genel /audit sayfasına device filter ile link.
10. **Sağlık (SNMP CPU/RAM chart)** — Recharts 48sa SNMP health. **Hedef:** Overview tab'ında alt-kart veya yeni "Sağlık" sekme. **Reuse:** `snmpApi.getHealth`.

### 🔵 P4 — DÜŞÜK (kasıtlı silinmiş olabilir, karar gerek)
11. **SNMP Configure modal (v2c/v3)** — Cihaz başına SNMP setup. **Karar:** Admin Settings'e mi taşındı? Yoksa OnboardingWizard kapsamında mı? Eğer hâlâ ihtiyaç varsa Actions tab → kart.
12. **SNMP Trap Forwarding modal** — Trap collector setup. **Karar:** Aynı: Admin Settings veya Actions.
13. **Per-port UtilizationChart (recharts 48h)** — PortsTab port row expand. **Karar:** Mockup'ta sparkline öneriliyor (Tasarım Öneri #4) — birleştirilebilir.
14. **Visual SwitchPortPanel toggle** — Tablo ↔ jack matrix görünüm modu. **Karar:** Mockup'ta var (RJ45 faceplate) ama high-density switch'lerde scale problemi. Opsiyonel "Visual" buton bırakılabilir.

### 🟢 Kasıtlı stub (kayıp değil, ileride aktif)
- **Port Shutdown** — ActionsTab'da DISABLED + tooltip "C5 ile gelecek" — kasıtlı placeholder (kill-switch + approval gerekiyor).

## E. Mockup tasarım baseline notları

`/Netmanager/` mockup'ı (Charon ile aynı NOC paleti) — fonksiyonelliği bozmadan **görsel iyileştirme adayı** olarak kullanılabilir. Kayıp özellik geri eklenirken mockup'tan ödünç alınabilecek 5 fikir:

1. **Rollback countdown + pending changes pattern** — VLAN ata / port shutdown / Terminal config-değişen komutlar için "300sn auto-rollback safety window". Konfigürasyon güvenliği için altın değer.
2. **Header action tray** — "Config Yedekle" + "SSH Aç" sayfa-level butonlar. Discoverability artar.
3. **3-mode color toggle** (VLAN / PoE / Durum) PortsTab tablosunda — port renklendirme modu seçimi.
4. **Header sparkline** — uptime/health trend. CPU/RAM kaybını telafi edebilir.
5. **Bulk PoE toggle** — BulkPolicyAssignDrawer'a PoE satırı eklenebilir (eski'de yoktu — yeni feature).

**Kural:** Mockup tasarım ilhamı ver ama operasyonel özellik kaybetme. RJ45 visual faceplate'in 1:1 portu yapılmasın (scale problemi); "vurguları kopyala" yaklaşımı tercih edilsin.

## F. Dalga 1 — kapsam önerisi (kritik kayıplar)

Tek branch `t10/c7-feature-restore-wave1`, üç ana iş, ardışık commit:

| Commit | İçerik | Hedef sekme | Risk |
|---|---|---|---|
| 1 | **Terminal sekmesi geri** — yeni 10. sekme; `SshTerminal.tsx` component embed + readonly/approval toggle | Yeni "Terminal" sekmesi | Düşük (component reuse) |
| 2 | **Canlı Config + Güvenlik Tarama** — BackupTab içinde alt-tab veya yeni "Canlı Config" 11. sekme | "Canlı Config" sekmesi | Düşük (getConfig zaten var) |
| 3 | **BackupTab: 2-way Diff + Content preview** — satır aksiyonları + side modal/drawer | BackupTab | Orta (diff render UX kararı) |
| 4 | **VlanTab: Create + Delete** + **PortsTab: per-port VLAN Ata** modal | VlanTab + PortsTab | Düşük (mutation reuse) |
| 5 | **BackupTab: Drift alert** | BackupTab header | Düşük |

**Test:** tsc + vitest (mevcut 189 + yeni smoke testler) + vite build. **Deploy:** frontend-only mini (P5+P7), backend dokunulmaz.

**Bu dalganın dışında:** Komşular / Audit / SNMP Health (P3) → Dalga 2; SNMP Configure / Trap modal'ları (P4) → karar bekleyenler.

---

## Karar noktaları (Dalga 1 başlamadan önce)

1. **Terminal nereye?**
   - (a) Yeni 10. sekme "Terminal" — eski modal pattern, en doğal
   - (b) Actions tab içinde alt-tab — yeni sayfanın "actions-centric" felsefesine uygun
   - (c) Actions tab'tan "SSH Aç" butonu → mevcut `/ssh/:deviceId` route'una git (gömme yok)

2. **Canlı Config nereye?**
   - (a) Yeni "Canlı Config" 11. sekme (toplam 11 olur)
   - (b) BackupTab'da alt-tab "Canlı / Yedekler"
   - (c) Actions kartında "Config Görüntüle" butonu → drawer

3. **Config Diff için UX?**
   - (a) AntD Table satır seçimi + "Diff" buton → side-by-side mod modal (manuel diff render)
   - (b) `react-diff-viewer-continued` npm paketi ekle (~30KB gzip)

4. **Yeni sekme sayısı** — şu an 9, Dalga 1 sonrası **11-12 sekme** olabilir. Aşırı mı? Alternatif: bazı kayıpları alt-tab/drawer ile gizle.

Bu kararlar netleşince Plan modunda implementasyon dökümü çıkarırım.
