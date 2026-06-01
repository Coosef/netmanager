# T10 C7 Wave 2 #2 — Device Detail UI Refresh: Integration Plan

> **STATUS: PLAN** — Kullanıcı 2026-06-01 talimatı: "NetManager klasöründeki eski Switch ekranı + mockup tasarımlarını tara. Yeni DeviceDetailPage'e SIFIRDAN tasarım üretme. Eski tasarımdaki başarılı bileşenleri taşı." Kod YAZILMADI — plan onayı bekleniyor.

## Context

Wave 1 + Wave 1.1 sonrası DeviceDetailPage fonksiyonel olarak parity'de ama görsel olarak "düz tablo gibi duruyor" (kullanıcı sözü). Wave 2 #2 ile mockup tasarımı entegre edilecek. Hedef: **LibreNMS + PRTG + Unifi Controller seviyesinde kurumsal görünüm.**

### Sabit kurallar (kullanıcı dedi)

- ⛔ **SIFIRDAN tasarım YOK** — sadece mockup'taki MEVCUT bileşenler taşınır
- ⛔ **Uydurma YOK** — mockup'ta görmediğim şeyi eklemem
- ⛔ **Wave 1 fonksiyonu BOZULMAZ** — sadece görsel refactor
- ⛔ **Backend değişmez · API değişmez · Routing değişmez**
- ⛔ **Tam UI refactor** olsun, scope creep yok

### Doğrulama özeti (bu plan başlamadan önce yapıldı)

| Alan | Durum |
|---|---|
| `noc.css` Charon'a entegre | ✅ Aktif kullanımda (`CustomizePanel.tsx` zaten `nm-btn` kullanıyor) |
| Mockup CSS class'ları | ✅ `nm-page-hd` · `nm-page-title` · `nm-page-actions` · `nm-statbar` · `nm-stat-val` · `nm-status-dot` · `nm-donut` · `nm-gauge` · `nm-pill` · `nm-risk-pill` · `nm-btn` — hepsi `frontend/src/styles/noc.css`'te tanımlı |
| Backend health/SLA endpoint'leri | ✅ `snmpApi.getHealth(deviceId)`, `snmpApi.getCpuRam(deviceId)`, `devicesApi.getAvailability(id, days=30)`, `monitorApi.getEvents({device_id, hours, severity})` — hepsi mevcut |
| Risk konsepti | ✅ `nm-risk-pill` CSS hazır; backend `getHealthScores()` mevcut |

**Sonuç:** Bu Wave 2 #2 alt-işi büyük ölçüde "AntD komponentleri → `nm-*` class'larla replace + KPI render" — backend dokunma SIFIR.

---

## 10 bileşen × kaynak × hedef matrisi

| # | Bileşen | Mockup kaynağı | Mevcut prod konum | Hedef değişiklik | LOC | Öncelik | Faz |
|---|---|---|---|---|---|---|---|
| 1 | **Device Header** | `Netmanager/pages-devices.jsx:328-345` | `DeviceDetailPage.tsx:99-114` (AntD Badge+hostname+code+span) | AntD elementleri `nm-page-hd > .title-block + .nm-page-actions` ile değiştir; breadcrumb "Cihazlar › hostname" + status dot + risk pill | 15-20 | 🟢 H | F1 |
| 2 | **Status Cards** (KPI) | `Netmanager/pages-switch.jsx:173-181` + `pages-devices.jsx:113-145` | `OverviewTab.tsx` (şu an düz Descriptions) | OverviewTab üstüne yeni `<div class="nm-statbar">` 6 kart: Aktif Port / Err / PoE / Toplam Güç / VLAN / Bekleyen Değişiklik | 25-30 | 🟢 H | F2 |
| 3 | **Health Summary** | `Netmanager/pages-devices.jsx:462-511` | yeni | OverviewTab içinde "Sistem Sağlığı (SNMP)" subsection — CPU/RAM sparkline (2-col `.nm-stat`) + Top 5 Interface utilization gauge listesi | 35-45 | 🟡 M | F3 |
| 4 | **Vendor Badge** | `styles.css:1382-1391` (mockup'taki orijinal) + `pages-devices.jsx:412` | `DeviceDetailPage.tsx:109` (düz `{device.vendor}`) | `<span class="nm-vendor cisco">CISCO</span>` — vendor → CSS class mapping. CSS sadece mockup'ta, prod'a kopyalanması gerek (`noc.css`'te yok) | 5-10 | 🟢 H | F1 |
| 5 | **Availability Badge** | `pages-devices.jsx:547-576` | yeni | OverviewTab veya yeni "SLA" subsection — donut chart (`.nm-donut`) + uptime 7g/30g + SLA hedef. `devicesApi.getAvailability(id, 30)` | 30-40 | 🟡 M | F4 |
| 6 | **Last Backup Badge** | `pages-devices.jsx:435-460` | `BackupTab.tsx` (mevcut tarihçe) + OverviewTab'de "Son Backup" yok | OverviewTab Status Cards satırı içinde "Son Backup" pill (yaş + altın ⭐ varsa) + BackupTab header'a drift warning box (zaten Wave 1'de var, sadece görsel iyileştirme) | 15-20 | 🟡 M | F2/F4 |
| 7 | **Port Statistics** | `pages-switch.jsx:173-181` | `PortsTab.tsx` (640 satır, üstte düz Text strong "Port listesi") | PortsTab üstüne yeni `<div class="nm-statbar">` 5 kart: Aktif (`up`) / Err-disabled / PoE Port / Toplam Güç / VLAN sayısı | 20-25 | 🟢 H | F2 |
| 8 | **VLAN Statistics** | `pages-switch.jsx:179` | `VlanTab.tsx` (mevcut "X kayıt" Text) | VlanTab üstüne küçük statbar (3 kart: Toplam / Aktif / Trunk-only) | 10-15 | 🔵 L | F4 |
| 9 | **Event Statistics** | `pages-devices.jsx:513-545` + `dashboard.jsx:81-101` | `EventsTab.tsx` (chip filter mevcut) + OverviewTab | OverviewTab'de mini KPI "24sa Olay" satırı (toplam + kritik/uyarı/bilgi count) + EventsTab başlığında aynı özet | 20-30 | 🟡 M | F3 |
| 10 | **Quick Actions** | `pages-devices.jsx:347-351` + `pages-switch.jsx:148-153` | `DeviceDetailPage.tsx` header'da AntD `<Button icon={ArrowLeft}>Cihazlar</Button>` yalnız | Header sağında `.nm-page-actions` button tray: "Yedek Al" / "SSH Aç" / "Yenile" — Aksiyonlar tab'ına alternatif hızlı erişim | 10-15 | 🟢 H | F1 |

**Toplam tahmin:** ~180-250 LOC eklenir, ~50-80 LOC mevcut AntD elementleri silinir.

---

## Faz sıralaması — 4 commit zinciri

### F1 — Header + Vendor Badge + Quick Actions (~50 LOC, 1 commit)

**Dosya:** `DeviceDetailPage.tsx:99-114`

Mevcut AntD header'ı `.nm-page-hd` ile değiştir:
- `.title-block` içinde: `nm-crumbs` (Cihazlar › hostname) · `<h1 class="nm-page-title">` hostname + `nm-risk-pill` (varsa) · alt satırda `.nm-status-dot` + status etiket + IP/vendor/os mono + lastSeen relative
- `<span class="nm-vendor {vendor}">{VENDOR}</span>` — küçük renkli pill (cisco mavi/aruba yeşil/ruijie turuncu)
- Sağda `.nm-page-actions` tray: "Yedek Al" (BackupTab'a → tetik) · "SSH Aç" (TerminalTab'a → tab=terminal&mode=ssh) · "Yenile" (queryClient.invalidateQueries)
- **Geri butonu** korunur ama "Cihazlar" breadcrumb içinde

**CSS not:** `.nm-vendor` ve alt class'ları (`nm-vendor.cisco/.aruba/.ruijie`) `noc.css`'te YOK — bu commit'te `noc.css`'in sonuna ekle (~12 satır), `styles.css` mockup'tan kopyala.

**Risk:** AntD theme token'ları ile `.nm-*` class'ları çakışabilir. Header'ın etrafına AntD `<Tabs>` kalır (Wave 1 işlevi); class'ların AntD ile sahnede beraber yaşaması test edilmeli.

**Test:** vitest mevcut DeviceDetailPage import smoke geçer; tarayıcı: header render + vendor pill renk doğru + 3 action buton çalışıyor.

### F2 — OverviewTab Status Cards + PortsTab Port Statistics + Last Backup pill (~80 LOC, 1 commit)

**Dosyalar:** `OverviewTab.tsx`, `PortsTab.tsx`

OverviewTab:
- Üstte yeni `<div class="nm-statbar">` 6 kart (Aktif Port / Err / PoE / Toplam Güç / VLAN / Son Backup) — verileri sırasıyla `devicesApi.getInterfaces(id)`, `snmpApi.getCpuRam(id)`, `devicesApi.getVlans(id)`, `devicesApi.getBackups(id)` (last entry) çağrılarından useQuery ile çek. Tüm query'ler 60s stale, paralel.
- Altına mevcut Descriptions tablosu korunur (cihaz meta detayı için).

PortsTab:
- Tablo üstüne yeni `<div class="nm-statbar">` 5 kart — mevcut `ifaceQ.data.interfaces` üzerinden aggregate (filter+count).
- Mevcut "Port listesi" başlığı + "canlı/cache" badge + Yenile button korunur, statbar onun üstüne.

**Risk:** OverviewTab'de yeni 4 paralel query API request yoğunluğunu artırır. queryKey'ler farklı, race yok. Stale 60s ile rate-limit OK.

**Test:** vitest import smoke + helper unit (eğer aggregate fonksiyon helper'a çıkarılırsa); tarayıcı: stat değerleri tabloyla tutarlı, renkler `.ok/.warn/.crit` doğru sınıflandırılmış.

### F3 — Health Summary + Event Statistics (~60 LOC, 1 commit)

**Dosyalar:** `OverviewTab.tsx`, `EventsTab.tsx`

OverviewTab:
- Status Cards altına "Sistem Sağlığı" subsection — `snmpApi.getCpuRam(id)` polling (60s), CPU/RAM iki `.nm-stat` kart + sparkline (son 20 polling buffer client-side).
- Sparkline için **yeni helper component**: `_sparkline.tsx` — saf SVG (recharts overkill için 30 satır ufak path), `widgets.jsx:70-86`'dan port edilir.
- Altına "24sa Olay Özeti" — `monitorApi.getEvents({device_id, hours: 24})` count by severity → 3 kart (crit/warn/info).

EventsTab:
- Mevcut chip filter korunur, üstüne aynı 3 sayıyı pill olarak göster (`.nm-pill.crit / .warn / .info`) hızlı görsel özet.

**Risk:** Sparkline buffer client-side; sayfa yenilenince sıfırlanır (kabul edilebilir, mockup da öyle). Backend polling yükü artmaz (60s stale).

**Test:** sparkline helper için unit test (SVG path matematik); vitest import smoke; tarayıcı: CPU% renk eşik doğru, sparkline 5dk içinde dolar.

### F4 — Availability Badge + VLAN Statistics + Backup drift visual iyileştirme (~50 LOC, 1 commit)

**Dosyalar:** `OverviewTab.tsx`, `VlanTab.tsx`, `BackupTab.tsx`

OverviewTab:
- Sağda yeni "SLA" subsection — `devicesApi.getAvailability(id, days: 30)` → `.nm-donut` (110x110, conic-gradient ile yeşil/turuncu/kırmızı) + `.nm-deflist` (7g uptime / 30g uptime / SLA hedef).
- `.nm-donut` CSS mevcut, custom donut component'i widgets.jsx'den port et (~25 satır).

VlanTab:
- Mevcut "X kayıt" Text yanına 3 küçük `.nm-pill`: Toplam (mevcut sayı) · Aktif (`status='up'` filter) · Trunk-only (port-level analiz; cache eksikse "—").

BackupTab:
- Drift alert (Wave 1'de zaten var) görsel iyileştirme: `var(--warn-soft)` background ile mockup'taki "⚠ Drift tespit edildi" box pattern'ı.

**Risk:** Donut conic-gradient eski tarayıcılarda (Safari < 14) düşmesi mümkün; fallback Tag verilir.

**Test:** vitest import smoke; tarayıcı: donut renk doğru eşiklerde + sayı readable.

---

## Faz sonrası — DeviceDetailPage iskeleti (özetle)

```
<div class="nm-page-hd">                      ← F1
  <div class="title-block">
    <div class="nm-crumbs">Cihazlar › VILLA_31_SW31</div>
    <h1 class="nm-page-title">
      VILLA_31_SW31
      <span class="nm-risk-pill ok">SAĞLIKLI</span>
    </h1>
    <div>
      <span class="nm-status-dot ok"></span>
      Online · <span class="mono">10.24.90.31</span>
      · <span class="nm-vendor ruijie">RUIJIE</span>
      · <span class="mono">ruijie_os</span>
      · 4 dk önce
    </div>
  </div>
  <div class="nm-page-actions">
    <button class="nm-btn ghost">Yedek Al</button>
    <button class="nm-btn ghost">SSH Aç</button>
    <button class="nm-btn">Yenile</button>
  </div>
</div>

<AntD Tabs>                                    ← Wave 1 KORUNUR
  Genel | Portlar | Güvenlik | VLAN | MAC | PoE | Olaylar | Config Backup | Aksiyonlar | Terminal

  Tab=Genel (OverviewTab):
    <div class="nm-statbar">                   ← F2
      6 kart: Aktif Port / Err / PoE / Güç / VLAN / Son Backup
    </div>

    <div class="nm-drawer-section">            ← F3
      Sistem Sağlığı (SNMP)
      [CPU% + sparkline] [RAM% + sparkline]
    </div>

    <div class="nm-drawer-section">            ← F4
      SLA / Availability
      [Donut 110x110] + nm-deflist
    </div>

    <div class="nm-drawer-section">            ← F3
      24sa Olay Özeti
      [crit pill] [warn pill] [info pill]
    </div>

    <Descriptions>                              ← KORUNUR (mevcut)
      hostname, IP, vendor, model, ... (detay)
    </Descriptions>

  Tab=Portlar (PortsTab):
    <div class="nm-statbar">                   ← F2
      5 kart: Aktif / Err / PoE / Güç / VLAN
    </div>
    <Table>                                     ← Wave 1 KORUNUR (interfaces tablosu)

  Tab=VLAN (VlanTab):
    [Toplam pill] [Aktif pill] [Trunk-only pill] ← F4
    <Table>                                     ← Wave 1 KORUNUR

  Tab=Olaylar (EventsTab):
    [crit pill] [warn pill] [info pill]        ← F3
    [severity chip filter]                      ← Wave 1 KORUNUR

  Tab=Config Backup (BackupTab):
    Drift box (görsel iyileştirme)             ← F4
    [Canlı / Yedekler alt-tab]                  ← Wave 1 KORUNUR
```

## Critical files

- `frontend/src/pages/Devices/DeviceDetailPage.tsx` (F1)
- `frontend/src/pages/Devices/detail/OverviewTab.tsx` (F2, F3, F4 — en çok değişen)
- `frontend/src/pages/Devices/detail/PortsTab.tsx` (F2)
- `frontend/src/pages/Devices/detail/VlanTab.tsx` (F4)
- `frontend/src/pages/Devices/detail/EventsTab.tsx` (F3)
- `frontend/src/pages/Devices/detail/BackupTab.tsx` (F4 — minor)
- `frontend/src/styles/noc.css` (F1 — `.nm-vendor` class'larını mockup'tan kopyala)
- yeni `frontend/src/pages/Devices/detail/_sparkline.tsx` (F3 — ~30 satır SVG sparkline)
- yeni `frontend/src/pages/Devices/detail/_donut.tsx` (F4 — ~25 satır conic-gradient donut)

## Reuse

- `noc.css` `.nm-*` class'ları (zaten Charon'da entegre, sadece `.nm-vendor` ek gerekli)
- `widgets.jsx:70-125` Sparkline + Donut + KPI pattern'larını React+TS'e port (saf SVG, mockup babel-runtime JSX'i değil)
- `snmpApi.getHealth(id)` · `snmpApi.getCpuRam(id)` · `devicesApi.getAvailability(id, 30)` · `monitorApi.getEvents({device_id, hours})` · `devicesApi.getInterfaces(id)` · `devicesApi.getBackups(id)` — hepsi mevcut
- React Query `useQuery` paralel pattern (Wave 1'de zaten yoğun kullanıldı)

## Risks

1. **CSS çakışması (AntD ile)** — AntD theme token'ları (`colorBgContainer`, `colorBorderSecondary`) ile `.nm-*` class'larının renk'leri çakışabilir. AntD Tabs hala kullanılacak (Wave 1 koruması). Önce F1'de küçük bir alanda test → sonra yayılım.
2. **Sparkline performans** — OverviewTab açıkken her 60s `getCpuRam` poll, son 20 değer client buffer. Sekme kapanınca query disable. Risk düşük.
3. **Donut tarayıcı uyumu** — `conic-gradient` Safari < 14'te düşer. Fallback: basit `<Progress type="circle">` AntD komponenti.
4. **`nm-vendor` CSS yok** — mockup `styles.css:1382-1391`'den kopyalanmalı; oklch token'ları zaten Charon'da var.
5. **Bundle boyutu** — yeni helper'lar ~60 satır ham SVG; recharts'a dokunulmaz. Delta < +5KB.

## Test stratejisi (Wave 1 pattern korunur)

| Test | Tip | Hedef |
|---|---|---|
| `_sparkline.test.ts` (yeni) | Unit | SVG path matematik (saf fonksiyon) |
| `_donut.test.ts` (yeni) | Unit | Conic-gradient style string + renk eşik mantığı |
| `OverviewTab.test.ts` | Import smoke (mevcut güncellenir) | Çoklu useQuery + yeni subsection import |
| `PortsTab.test.ts` (yeni gerekirse) | Import smoke | Statbar aggregate helper |
| `DeviceDetailPage.test.ts` (mevcut) | Import smoke (değişmez) | Header refactor sonrası halen import edilebilir |

DOM render testi yok (Wave 1 patern'ine sadık — tarayıcı smoke kullanıcı tarafı).

## Verification

### Lokal (CI)
1. `tsc --noEmit` → 0 hata
2. `vitest run` → 219 → ~223 PASS (+2-4 yeni helper test)
3. `vite build` → bundle delta < +10KB (sparkline + donut ham SVG)

### Prod mini-deploy (frontend-only — backend dokunulmuyor)
1. P0 anchor + P1 ingress check
2. P2 git ff-only
3. P3 `docker compose build frontend`
4. P4 `docker compose up -d --no-deps frontend` (~30sn blip)
5. P5 smoke: SPA routes 200 + bundle hash değişti + kullanıcı tarayıcı turunda her 4 faz GREEN:
   - F1: header `.nm-page-hd` + vendor pill renk + 3 quick action
   - F2: Status Cards (OverviewTab + PortsTab), sayılar tutarlı
   - F3: Health Summary CPU/RAM sparkline + Event özeti
   - F4: SLA donut + VLAN stat + drift box görsel

## Out of scope (bu plan'a DAHİL DEĞİL)

- **RJ45 visual port faceplate** (mockup'taki port grid) — Wave 2 #6 ayrı başlık
- **Yeni "Sağlık" sekme** — Health Summary OverviewTab'in altına subsection olarak girer (sekme sayısı 10 sabit kalır, scope creep yok)
- **Yeni "SLA" sekme** — Availability OverviewTab subsection (aynı kural)
- **Toplu Cihaz Listesi (Devices page) refactor** — bu plan SADECE DeviceDetailPage; Devices/index.tsx dokunulmaz
- **Mockup'taki "Rollback countdown" pattern** — Wave 2 #2 değil, ayrı uzun vadeli özellik
- **Wave 1.1 dışı diğer mutation noktalarına notification** — bu plan UI refresh, mutation feedback değil

## Kapanış kriteri

Wave 2 #2 tamamlanmış kabul edilir:
- 4 faz commit'i + tek branch'a merge edildi (önerilen `t10/c7-wave2-ui-refresh`)
- tsc + vitest + vite build GREEN
- Prod frontend-only mini deploy GREEN
- Tarayıcı smoke: 4 faz görsel doğrulama GREEN
- Backend dokunma sıfır kanıt: backend image değişmedi, `docker compose ps` backend uptime korunuyor

---

## Onay bekleyen 3 karar

Plan başlamadan önce sizin tarafınızdan netleşmesi gereken küçük UX kararları:

1. **Risk pill kaynağı** — `nm-risk-pill` CSS mevcut ama prod'da "risk" konsepti henüz tanımlı değil. F1'de:
   - (a) Pill'i şimdilik göstermeyelim (Wave 2 sonra risk modeli kurulunca eklenir)
   - (b) Backend `devicesApi.getHealthScores()` zaten var → device'ın health score'unu kullan, 80+ "SAĞLIKLI", 50-80 "İZLENMELİ", <50 "KRİTİK"
   - (c) Status'a göre basit eşle: online=ok, offline=crit, unreachable=warn (mockup'taki davranış)

2. **Quick Actions buton seti** — F1'de hangi 3 buton?
   - Yedek Al (BackupTab.tsx takeMut tetikle) · SSH Aç (`/devices/:id?tab=terminal` + mode=ssh deep link) · Yenile (`queryClient.invalidateQueries`) — **önerilen**
   - Veya 4 buton: + "Düzenle" (yeni 11. action — mevcut Aksiyonlar tab'ında zaten edit yok, scope creep riski)

3. **OverviewTab sıralama** — Status Cards · Health · SLA · Events · Descriptions hepsi alt alta uzun bir sayfa olur. Tek scroll uzunluğu OK mi yoksa 2-col grid mi?
   - (a) Tek kolon (mockup'a yakın, scroll) — **önerilen**
   - (b) 2-col grid (Status Cards full-width üst + 2-col: Health | SLA + Events full-width alt)

Bu 3 onay sonrası **F1 commit'i ile başlarım** (`t10/c7-wave2-ui-refresh` branch).
