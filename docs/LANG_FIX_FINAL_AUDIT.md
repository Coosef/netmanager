# LANG-FIX FINAL AUDIT — Pre-Deploy Report

**Tarih:** 2026-06-05
**Branch:** `t10/lang-fix-final-audit` (W1-E üzerine, kod değiştirilmedi — sadece bu rapor eklendi)
**Baseline:** W1-A → W1-E (commits `772810d` → `b467a3d`)

Bu rapor `LANG-FIX W1-A..W1-E` paketinin production deploy edilmeden önce gerçek görünür UI yüzeyinde
kalan boşlukları ölçer. Heuristic literal sayımı + yapısal locale parser + dead-code teyit ile yapıldı.

Audit script: `/tmp/lang_audit_scan.mjs` (yapısal — `frontend/src/pages` + `frontend/src/components` taranır, t() içindeki
literal'ler dışlanır, teknik/CSS/enum sözlüğü filtrelenir).

---

## ÖZET — deploy kararı için tek sayfada

| Soru | Cevap |
|---|---|
| W1 kapsamındaki sayfalarda canlı kodda çevrilmemiş gerçek UI metni var mı? | **Hayır.** Dashboard / Devices listesi / DeviceForm / OnboardingWizard / Modallar / Racks / DeviceDetailPage / 10 detail tab / 4 drawer → görünür metin kapsamı **fiilen %100**. |
| 4 dil parity W1 sırasında bozuldu mu? | **Hayır.** TR 1716 / EN 1673 / DE 1630 / RU 1630. Toplam 215 eksik key tamamen `help.faq_*` (W3 scope) + 7 pre-existing `topology.*` / `devices.bulk_fetch_info*` gap. W1-A..E sıfır widening. |
| Production deploy edilebilir mi? | **W1 kapsamındaki sayfalar için EVET**. Ancak demo yolunda **W1 dışında kalan sayfalar tamamen Türkçe**: Settings, Topology, Agents, Monitor, Playbooks, BackupCenter, Reports, Users, AuditLog, TerminalSessions vd. → 3200+ hardcoded literal. Demo "Charon UI EN'de gösterilir" beklentisi ile uyuşmaz. **Karar noktası bu.** |
| Müşteri demo'sunda dil seçici çalışıyor mu? | **Kısmen.** EN/DE/RU seçilince W1 alan TR'den EN'e geçer, W1 dışı alan TR'de kalır → **karışık UI**. |

**Tavsiye:** Aşağıdaki üç seçenek arasından seçim:

1. **W2 sprint planla, deploy bekle.** Müşteriye tam EN/DE/RU vaat ediliyorsa W1-F → W1-N planlanmalı (~3243 literal × 4 dil ≈ büyük iş, ~3-5 sprint).
2. **W1'i kısmi deploy, demo'yu sadece W1 sayfalarıyla yap.** Müşteri demo akışı Dashboard → Devices → DeviceDetail → Racks ile sınırlandırılırsa W1 yeter; Settings/Topology/Monitor demo'da gösterilmez.
3. **W1 + locale fallback strict mode kapat.** Şu an `fallbackLng: 'tr'` → eksik key TR döner. EN seçen müşteri W1-dışı ekranda TR görür. Bu kabul edilemezse strict + key-not-found banner ile demo öncesi koruma konulabilir (ayrı iş).

---

## AUDIT-1 — Visible UI String Audit

### Toplam ham sayım (frontend/src/pages + components, .tsx)

| Kategori | Sayı |
|---|---:|
| Form label (`label="..."` + `rule.label`) | 1066 |
| JSX child text (`<span>foo</span>` vb.) | 1050 |
| Title / Tooltip title | 629 |
| Placeholder | 221 |
| Toast / Notification | 155 |
| Alert / Validation message | 97 |
| Confirm button (`okText`/`cancelText`) | 82 |
| Alert description | 61 |
| Modal title | 23 |
| Tooltip | 15 |
| Form extra hint | 14 |
| Input addon | 4 |
| Drawer title | 1 |
| **TOPLAM** | **3 418** |

### Page/component dağılımı (canlı kod — DeviceDetail.tsx dead code hariç)

| Dosya alanı | Hardcoded | W1 statü |
|---|---:|---|
| src/pages/Settings | 379 | ❌ W1 DIŞI |
| src/pages/Agents | 185 | ❌ W1 DIŞI |
| src/pages/Monitor | 166 | ❌ W1 DIŞI |
| src/pages/Topology | 130 | ❌ W1 DIŞI |
| src/pages/Playbooks | 105 | ❌ W1 DIŞI |
| src/pages/BackupCenter | 101 | ❌ W1 DIŞI |
| src/pages/Reports | 99 | ❌ W1 DIŞI |
| src/pages/Permissions | 89 | ❌ W1 DIŞI |
| src/pages/AlertRules | 87 | ❌ W1 DIŞI |
| src/pages/SuperAdmin | 86 | ❌ W1 DIŞI |
| src/pages/Incidents | 84 | ❌ W1 DIŞI |
| src/pages/Firmware | 83 | ❌ W1 DIŞI |
| src/pages/DriverTemplates | 79 | ❌ W1 DIŞI (Sürücü Şablonları — bilinçli atlandı) |
| src/pages/Ipam | 75 | ❌ W1 DIŞI |
| src/pages/MacArp | 73 | ❌ W1 DIŞI |
| src/pages/AssetLifecycle | 72 | ❌ W1 DIŞI |
| src/pages/TopologyV2 | 63 | ❌ W1 DIŞI |
| src/pages/ChangeManagement | 62 | ❌ W1 DIŞI |
| src/pages/ConfigTemplates | 61 | ❌ W1 DIŞI |
| src/pages/BandwidthMonitor | 58 | ❌ W1 DIŞI |
| src/pages/Users | 58 | ❌ W1 DIŞI |
| src/pages/VlanManagement | 56 | ❌ W1 DIŞI |
| src/pages/AIAssistant | 53 | ❌ W1 DIŞI |
| src/pages/SyntheticProbes | 52 | ❌ W1 DIŞI |
| src/components | 51 | ❌ W1 DIŞI (Sidebar/TopNav haricileri) |
| src/pages/Services | 48 | ❌ W1 DIŞI |
| src/pages/Approvals | 47 | ❌ W1 DIŞI |
| src/pages/ComplianceCheck | 47 | ❌ W1 DIŞI |
| src/pages/Diagnostics | 47 | ❌ W1 DIŞI |
| src/pages/ConfigBuilder | 46 | ❌ W1 DIŞI |
| src/pages/Locations | 45 | ❌ W1 DIŞI |
| src/pages/AuditLog | 43 | ❌ W1 DIŞI |
| src/pages/Login | 43 | ❌ W1 DIŞI |
| src/pages/EscalationRules | 42 | ❌ W1 DIŞI |
| src/pages/OrgAdmin | 41 | ❌ W1 DIŞI |
| src/pages/PoeDashboard | 38 | ❌ W1 DIŞI |
| src/pages/Profile | 35 | ❌ W1 DIŞI |
| src/pages/TerminalSessions | 35 | ❌ W1 DIŞI |
| src/pages/ConfigDrift | 34 | ❌ W1 DIŞI |
| src/pages/TopologyTwin | 34 | ❌ W1 DIŞI |
| src/pages/Devices | 32 | ✅ W1-D/E (false-positive analiz aşağıda) |
| src/pages/SecurityPolicies | 31 | ❌ W1 DIŞI |
| src/pages/SecurityAudit | 27 | ❌ W1 DIŞI |
| src/pages/FloorPlan | 26 | ❌ W1 DIŞI |
| src/pages/LiveMonitor | 23 | ❌ W1 DIŞI |
| src/pages/SlaReport | 19 | ❌ W1 DIŞI |
| src/pages/Intelligence | 17 | ❌ W1 DIŞI |
| src/pages/InviteAccept | 16 | ❌ W1 DIŞI |
| src/pages/LldpInventory | 13 | ❌ W1 DIŞI |
| src/pages/Tasks | 3 | ❌ W1 DIŞI |
| src/pages/Dashboard | 2 | ✅ W1-C (her ikisi de false-positive) |
| src/pages/SshTerminalPage | 2 | ❌ W1 DIŞI |
| src/pages/Racks | 0 | ✅ W1-B clean |

> **DeviceDetail.tsx (1868 satır legacy)** — taramada **~175 finding** raporlandı ama bu dosya **dead code**:
> `import` araması canlı koddan referans bulamadı (`grep -rn "import.*DeviceDetail" --exclude DeviceDetailPage`)
> sıfır sonuç verdi. T10 C7.B'den beri DeviceDetailPage + detail/* tab yapısı kullanılıyor. W2-temizlik
> sprintinde silinmeli; LANG-FIX kapsamı dışı.

### W1 kapsamı residual analizi (deliberate keepers — gerçek defect değil)

**Devices (32 finding) — hepsi KURAL-uyumlu:**

| Literal | Konum | Sebep |
|---|---|---|
| `Catalyst 2960`, `Catalyst 2960, Aruba 2530…` | DeviceForm + Wizard placeholder | Vendor model örneği (KURAL-5: vendor adı) |
| `core,vlan10,building-a` | DeviceForm + Wizard placeholder | Tag list teknik örnek (W1-D belirtti) |
| `SNMP` | Divider başlığı | Teknik akronim |
| `Hash`, `MAC`, `VLAN`, `PoE`, `CPU`, `RAM`, `Agent`, `VLAN ID` | Tablo kolon başlıkları | Teknik akronim (uluslararası standart) |
| `Allowed VLANs` | Bulk VLAN drawer + Modal label | Cisco/network terminology — kod sözlüğü |
| `Cisco`, `Aruba`, `Ruijie`, `Fortinet`, `Palo Alto`, `MikroTik`, `Juniper`, `Ubiquiti`, `H3C / HPE`, `APC` | Vendor filter dropdown | KURAL-5: vendor adı çevrilmez (W1-D ayrıca rapor edildi) |
| `err-disabled / notconnect` | Stat caption | Backend status raw enum |
| `VLAN-CCTV` | Create VLAN modal placeholder | Adlandırma örneği |

**Dashboard (2 finding) — her ikisi de false-positive:**
- `NocDashboard.tsx:461 "kritik"` — scanner bağlamı yanlış aldı; t() kullanılıyor.
- `NocDashboard.tsx:770 "Math.abs(q.x - a.x)"` — JSX expression `<text>{Math.abs(...)}</text>`'i metin sandı.

**Racks (0):** Tam temiz.

**SONUÇ:** W1 kapsamındaki canlı kodda **kapatılması gereken gerçek defect yok**.

---

## AUDIT-2 — Locale Coverage Report (namespace bazlı)

| Namespace | TR baseline | EN eksik | DE eksik | RU eksik | Statü |
|---|---:|---:|---:|---:|---|
| __meta | 3 | 0 | 0 | 0 | ✅ |
| lang | 4 | 0 | 0 | 0 | ✅ |
| nav | 32 | 0 | 0 | 0 | ✅ |
| nav_group | 4 | 0 | 0 | 0 | ✅ |
| sidebar | 5 | 0 | 0 | 0 | ✅ |
| mobile_nav | 5 | 0 | 0 | 0 | ✅ |
| header | 34 | 0 | 0 | 0 | ✅ W1-A |
| common | 48 | 0 | 0 | 0 | ✅ |
| login | 7 | 0 | 0 | 0 | ✅ |
| error_boundary | 2 | 0 | 0 | 0 | ✅ W1-A |
| location_gate | 3 | 0 | 0 | 0 | ✅ W1-A |
| location_selector | 4 | 0 | 0 | 0 | ✅ W1-A |
| noc_wall | 5 | 0 | 0 | 0 | ✅ W1-A |
| search | 16 | 0 | 0 | 0 | ✅ W1-A |
| command | 48 | 0 | 0 | 0 | ✅ W1-A |
| customize | 60 | 0 | 0 | 0 | ✅ W1-A |
| dashboard | 200 | 0 | 0 | 0 | ✅ W1-C |
| racks | 113 | 0 | 0 | 0 | ✅ W1-B |
| devices | 740 | 0 | **3** | **3** | ⚠️ pre-existing |
| topology | 51 | 0 | **4** | **4** | ⚠️ pre-existing |
| discovery | 13 | 0 | 0 | 0 | ✅ |
| monitor | 28 | 0 | 0 | 0 | ✅ |
| tasks | 32 | 0 | 0 | 0 | ✅ |
| reports | 19 | 0 | 0 | 0 | ✅ |
| agents | 48 | 0 | 0 | 0 | ✅ |
| users | 34 | 0 | 0 | 0 | ✅ |
| audit | 9 | 0 | 0 | 0 | ✅ |
| settings | 11 | 0 | 0 | 0 | ✅ |
| help | 141 | **43** | **79** | **79** | ⚠️ W3 scope (FAQ) |

**Eksik key detayı:**

```
de missing: devices.bulk_fetch_info
de missing: devices.bulk_fetch_info_confirm
de missing: devices.bulk_fetch_info_success
ru missing: devices.bulk_fetch_info
ru missing: devices.bulk_fetch_info_confirm
ru missing: devices.bulk_fetch_info_success
de missing topo: topology.filter_layer
de missing topo: topology.blast_radius
de missing topo: topology.blast_critical
de missing topo: topology.blast_safe
ru missing topo: topology.filter_layer
ru missing topo: topology.blast_radius
ru missing topo: topology.blast_critical
ru missing topo: topology.blast_safe
```

Bu 7 key (3 devices.bulk_fetch_info_* + 4 topology.blast_*) **LANG-INFRA baseline'ından önce de eksik**.
W1 sprintleri bu boşluğu **büyütmedi**. Düzeltmek küçük iş (8 string × 2 dil = 16 satır çeviri); ister W1
tail'ine eklenir, ister W3 (locale parity completion) sprintinde toplu yapılır.

> **help.* (43/79/79):** FAQ namespace baştan eksikti, LANG-FIX-W3 scope'a alındı; bu rapor scope dışı.

---

## AUDIT-3 — Demo Path Audit (7 ekran TR residual)

Demo akışında kullanılan ekranlar için EN/DE/RU seçilince TR olarak kalacak alan sayısı (dead code hariç):

| Demo ekranı | W1 statü | Hardcoded (gerçek) | Hardcoded (false-positive teknik) | Demo karar |
|---|---|---:|---:|---|
| Dashboard | ✅ W1-C | 0 | 2 | **DEMO HAZIR** |
| Devices | ✅ W1-D | 0 | 32 (vendor adı + teknik) | **DEMO HAZIR** |
| DeviceDetail | ✅ W1-E | 0 | 16 (MAC/CPU/RAM/PoE/Hash) | **DEMO HAZIR** |
| Racks | ✅ W1-B | 0 | 0 | **DEMO HAZIR** |
| Settings | ❌ W1 DIŞI | **379** | — | ❌ **DEMO'DA TÜMÜYLE TR** |
| Users | ❌ W1 DIŞI | **58** | — | ❌ **DEMO'DA TÜMÜYLE TR** |
| TerminalSessions | ❌ W1 DIŞI | **35** | — | ❌ **DEMO'DA TÜMÜYLE TR** |

### Demo karar matrisi

| Senaryo | Sonuç |
|---|---|
| Demo akışı **sadece Dashboard → Devices → DeviceDetail → Racks** içeriyorsa | ✅ **DEPLOY GO** — müşteri tam EN/DE/RU UI görür |
| Demo akışı **Settings / Users / TerminalSessions** içeriyorsa | ❌ **DEPLOY HAYIR** — bu 3 ekran sıfırdan i18n alımına ihtiyaç duyar (~470 literal × 4 dil) |
| Demo akışı **Topology / Monitor / Agents / Playbooks / BackupCenter / Reports / IPAM / ...** içeriyorsa | ❌ **DEPLOY HAYIR** — W1 dışı sayfaların tamamı TR (~2700 literal) |

---

## AUDIT-4 — Common Key Konsolidasyonu

### Synonym grupları (aynı anlam, farklı key)

| Grup | TR değer | Key sayısı | Öneri |
|---|---|---:|---|
| refresh | "Yenile" | 3 | `common.refresh` zaten var — `dashboard.refresh` + `devices.detail.actions.refresh_btn` kullanmıyor; bunlar bağlam-spesifik kalabilir, **aksiyon gerekmez** |
| close | "Kapat" | 3 | `common.close` + `devices.detail.ports.row.poe_off_ok` ("Kapat" PoE off butonu) — anlam farklı, kalsın; `command.foot.close` lowercase ayrı |
| apply | "Uygula" | 2 | `common.apply` + `devices.bulk_lifecycle.apply` — ikincisi `common.apply` reuse edebilir, **küçük temizlik** |
| update | "Güncelle" | 3 | `devices.form.submit_update` + `devices.detail.actions_tab.update_ok` + `users.updated` — ilk ikisi `common.update` adına konsolide edilebilir (`common.update` yok); **yeni `common.update` ekle önerisi** |
| cancel (give_up) | "Vazgeç" | 2 | `common.give_up` + `devices.detail.ports.row.poe_cancel` — PoE Popconfirm `common.cancel` ("İptal") kullanmalı; **küçük düzeltme** |
| success | "Başarılı" | 3 | `common.success` + `tasks.status_success` + `devices.bulk_fetch.done` — `tasks.status_*` bağlam-spesifik kalsın |
| failed | "Başarısız" / "Hata" | 5 | `tasks.status_failed` + `tasks.devices_failed` + `common.error` + `devices.csv.result_errors` + `users.create_error` — `common.error` zaten reuse edilebilir, `tasks.*` bağlam-spesifik kalmalı |

### Exact value duplicates — 171 toplam

Çoğunluğu **architectural duplicate** (nav.* + command.nav.* + search.pages.* + help.feat_*_title) →
aynı TR değer farklı bağlamlarda gerek. Konsolide etmek yerine **birbirleriyle senkron tutulması**
gerekir. Örnek (kasıtlı duplicate):
- `nav.reports` = `command.nav.reports` = `search.pages.report` = "Raporlar"
- `nav.dashboard` = `command.nav.dashboard` = "Dashboard"

**Aksiyon önerisi:** 171 duplicate'in **9'u gerçek konsolidasyon adayı**:

```
1. devices.bulk_lifecycle.apply           → common.apply
2. devices.detail.ports.row.poe_cancel    → common.cancel (Vazgeç → İptal)
3. devices.form.submit_update             → common.update (yeni)
4. devices.detail.actions_tab.update_ok   → common.update (yeni)
5. devices.delete_error / users.update_error → common.update_failed (yeni)
6. dashboard.refresh                       → common.refresh
7. devices.detail.actions.refresh_btn     → common.refresh
8. devices.detail.actions_tab.btn_refresh_page → common.refresh
9. devices.csv.result_errors              → common.error (sadece "Hata" başlığı)
```

**Tahmini tasarruf:** 9 key × 4 dil = 36 satır JSON. Küçük iş, refactor riski düşük (tüm kullanım
noktaları grep edilip değiştirilmeli, tsc + vitest doğrular). Deploy bloklayıcısı **değil**.

---

## SSH SESSION TERMINATION BACKLOG

LANG-FIX kapsamı dışı. Memory'de `project_ssh_session_termination_backlog.md` olarak kayıtlı.
P1 öncelik; W1 deploy'undan **sonra** ayrı PR olarak işlenecek. Özellikle:

- `POST /terminal-sessions/{id}/terminate` backend endpoint
- Yeni RBAC verb: `terminal_sessions:terminate` (audit_logs.edit'ten **bağımsız**)
- Audit: session_id, device_id, terminated_by_*, started_at/terminated_at/duration_seconds
- WS close mesajı: "This terminal session was terminated by an administrator."

---

## MERGE / DEPLOY KARAR ÖNERİSİ

### Önerilen sıra

```
[ ] 1. Bu rapor + isteğe bağlı küçük temizlikler (7 missing topo/devices key + 9 synonym konsolide)
       — tahmini 1-2 saat
[ ] 2. W1-A → W1-E branch'leri main'e ardışık merge
       (her biri standalone test-yeşil; conflict beklenmiyor)
[ ] 3. Final smoke: main üzerinde tsc + vitest + vite build
[ ] 4. **Deploy KARARI** — aşağıdaki seçimden biri:
        (A) Tam deploy: müşteri demo'su Dashboard/Devices/DeviceDetail/Racks ile sınırlı kalacak;
            Settings/Topology/Monitor gibi ekranlar UI demo yolundan çıkarılacak. ✅ W1 yeter.
        (B) Tam deploy + EN/DE/RU dil seçici **gizlenecek** (geçici); ileride W1-F → W1-N
            tamamlanınca açılır. ✅ Demo yine TR'de güvenli.
        (C) Deploy ertelensin: W1-F (Settings + Users + TerminalSessions) tamamlanana kadar
            bekle. Müşteri tüm demo yolunu EN'de görmek istiyorsa zorunlu.
```

### Test pipeline tekrar (audit branch'inde)

```
$ cd frontend
$ ./node_modules/.bin/tsc --noEmit            # 0 hata
$ ./node_modules/.bin/vitest run              # 232/232 PASS
$ ./node_modules/.bin/vite build              # ✓ built in 7.54s
$ npm run i18n:check                          # 215 eksik (W3 scope), W1 widening yok
```

---

## EK — Audit araç ve veriler

- **Scanner:** `/tmp/lang_audit_scan.mjs` (Node 22+, plain regex + JSON parser, t() içerikleri dışlanır)
- **Ham bulgular:** `/tmp/audit_findings.json` (3418 finding + 30 namespace coverage + 7 ekran path bucket + synonym groups)
- **W1 baseline:** main HEAD `804434a` (LANG-INFRA merge)
- **W1-E end:** `b467a3d` (DeviceDetail)
- **Audit branch:** `t10/lang-fix-final-audit` (sadece bu rapor + scanner çıktıları, kod değişikliği yok)

Audit script'i `tools/` veya `scripts/` altına taşımak gelecekteki W1-F+ sprintlerde de işe yarar
(her sprint sonunda `node scripts/i18n-audit.mjs` çalıştırılarak baseline takip edilir).
