# T10 C7 — Device Detail Page & Per-Port Policy Assignment (PLAN)

> **DURUM: PLAN (taslak, kod YOK).** Kullanıcı kararları onaylandı; bu doküman C7.A kod fazından önce
> referans. Kod fazına ayrı GO ile başlanır. C5 (gerçek auto-quarantine) C7'den BAĞIMSIZ — bu planda
> yalnız UI placeholder (disabled).
>
> İlgili: T10 Faz C MVP kapanışı (`docs/T10_DEPLOY_LOG_2026-05-29.md`), Faz C plan (`docs/T10_FAZ_C_PLAN.md`).

## Motivasyon
C6b cihaz Drawer'ı canlıda çalışıyor ama mimari yetersiz:
- Düzenleme Drawer'ı küçük, **derinlemesine cihaz analizi** için uygun değil.
- C6b "Port Politikası (cihaz geneli)" yalnız tek bir cihaz-default veriyor; **port-bazlı override yok** (v2 planlı).
- Cihaz hakkında dağınık bilgiler (ports, VLAN, MAC, PoE, events, config backup) ayrı sayfalarda/modallarda.

C7 = bunları tek bir **kalıcı, sekmeli Device Detail Page**'de toplar + per-port policy override'ı getirir.

---

## Kararlar (onaylandı)
1. **Route:** **`/devices/:deviceId`** → yeni `DeviceDetailPage`. Cihaz listesinde adına click → bu sayfaya navigate.
2. **Drawer:** kalır (**hızlı düzenle** + **yeni cihaz ekleme**). Güvenlik politikası bölümü (C6b) **çıkarılır** — yeri Detail'in ilgili sekmesi.
3. **Switch policy:** **cihaz seviyesinde** kalır (DB kolonu `devices.security_policy_id` aynı). UI: **Detail > Security Policies sekmesi**.
4. **Port policy (cihaz-geneli default):** UI: **Detail > Security Policies sekmesi**. DB kolonu `devices.port_security_policy_id` aynı. Drawer'dan çıkarılır.
5. **Port policy (per-port override) — C7'nin asıl yeniliği:** UI: **Detail > Ports/Interfaces sekmesi**. Yeni tablo `port_policy_assignments`.
6. **`/devices/:deviceId/ports` eski route'u:** **redirect → `/devices/:id?tab=ports`**. Eski bookmark kırılmaz.
7. **Shutdown/quarantine:** UI'da placeholder **disabled**; tooltip "C5 (approval + kill-switch) ile gelecek". Gerçek aksiyon YOK.
8. **port_name normalizasyonu:** v1'de **exact-match + raw string**. Vendor çeşitliliği (Cisco `Gi1/0/1` vs Aruba `1/1/1` vs Ruijie) → vendor-alias/normalization **bilinen risk** (aşağıda risk bölümü).

### v2.1 değerlendirmesi (C7 scope dışı, gelecek)
Yalnız dar `port_policy_assignments` tablosu yerine **canonical `device_ports` tablosu** (interface metadata + status snapshot
+ policy assignment + history) ayrı değerlendirilecek. Tetikleyici: per-port metadata büyürse (VLAN tags, ifindex, descr,
operstatus, last-seen, manuel notlar). Bu C7 v1'de **açılmaz** (scope büyütür); risk paragrafına işlenir.

---

## Backend mimari

### Migration `f9ae` — yeni tablo
```
CREATE TABLE port_policy_assignments (
  id                        SERIAL PRIMARY KEY,
  device_id                 INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  port_name                 TEXT NOT NULL,
  port_security_policy_id   INTEGER NOT NULL REFERENCES port_security_policies(id) ON DELETE RESTRICT,
  organization_id           INTEGER NOT NULL,         -- RLS pinned
  assigned_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                TIMESTAMPTZ,
  UNIQUE (device_id, port_name)                       -- bir port = bir override
);
CREATE INDEX ix_ppa_device ON port_policy_assignments(device_id);
CREATE INDEX ix_ppa_org    ON port_policy_assignments(organization_id);
-- RLS: ENABLE + FORCE; org_isolation policy (Faz 7 pattern, f9ad ile aynı şablon).
-- netmgr_app grant: SELECT/INSERT/UPDATE/DELETE.
```

### Resolver güncelleme (`security_policy_service.py`)
`resolve_port_policy(db, device, port_name)` zinciri:
```
1) port_policy_assignments lookup (device_id+port_name+deleted_at IS NULL)   ← YENİ aktif
2) device.port_security_policy_id                                              (C6b — değişmedi)
3) org'un is_default=true port_security_policy                                 (C2 — değişmedi)
4) hardcoded fallback                                                          (C2 — değişmedi)
```
`port_name=None` çağrılarda 1. adım atlanır (geriye uyumlu). C2'deki zincir kancası burada açılır.

### Yeni endpoint'ler
Prefix: `/api/v1/devices/{device_id}/port-policy-assignments` (router: `security_policies.py` veya yeni `port_policy_assignments.py`)

| Method | Path | Açıklama | Yetki |
|---|---|---|---|
| `GET` | `/` | cihazın port→policy haritası (port_name list) | viewer+ |
| `POST` | `/` | toplu atama `[{port_name, port_security_policy_id}, …]` | org_admin+ |
| `PATCH` | `/{port_name}` | tek port policy değişikliği | org_admin+ |
| `DELETE` | `/{port_name}` | override kaldır (resolver org default'a düşer) | org_admin+ |

Feature gate: `_feat("security_policy")` (mevcut). RLS otomatik — endpoint'ler `ScopedDb` kullanır.

### Audit
`audit_logs` → `port_policy_assigned`, `port_policy_removed`, `port_policy_changed`. before/after policy_id + port_name. Mevcut `audit_service.log_action` reuse.

### Port verisi (sekmenin diğer kolonları için — YENİ tablo değil)
Mevcut snapshot tabloları + canlı SSH/SNMP federasyonu:
- **VLAN:** `device_vlan_snapshots` (f8a9).
- **PoE:** `poe_port_snapshots` (f9a8).
- **MAC count:** `mac_address_entries` (port başına group/count).
- **Status/description:** canlı SSH/SNMP fetch (interfaces endpoint — mevcut `interfaces.router` reuse).
- **Policy:** resolver'dan effective + override flag (üst kaynak: per-port mı device-default mı org mı).

Yeni endpoint: `GET /api/v1/devices/{id}/ports/aggregate` — yukarıdaki snapshot + canlı verileri tek payload'da birleştirir.
Snapshot tablosu açmıyoruz (v2.1 değerlendirmesi).

---

## Frontend mimari

### Routing
- `App.tsx` ekle: `<Route path="devices/:deviceId" element={<RoleRoute minRole="viewer"><DeviceDetailPage/></RoleRoute>} />`.
- `App.tsx` mevcut: `<Route path="devices/:deviceId/ports" element={<DevicePortsPage/>} />` → **kaldır + redirect kuralı**:
  `<Route path="devices/:deviceId/ports" element={<Navigate to="/devices/:deviceId?tab=ports" replace />} />`.
- `Devices/index.tsx`: cihaz adı/satır click → `navigate('/devices/' + id)`. Drawer "Düzenle" butonu kalır (hızlı düzenleme için).

### Yeni component'ler
| Dosya | Görev |
|---|---|
| `pages/Devices/DeviceDetailPage.tsx` (yeni) | Sekmeli ana sayfa (URL `?tab=` ile sync) |
| `pages/Devices/detail/OverviewTab.tsx` | Cihaz meta + status + son events özet |
| `pages/Devices/detail/SecurityPoliciesTab.tsx` | switch policy + cihaz-geneli port policy atama + effective resolver görünüm |
| `pages/Devices/detail/PortsTab.tsx` | **Asıl C7 yeniliği** — port listesi, toplu seçim, toplu policy ata Drawer, dry-run flap pill |
| `pages/Devices/detail/VlanTab.tsx` / `MacTab.tsx` / `PoeTab.tsx` / `EventsTab.tsx` / `ConfigBackupTab.tsx` / `ActionsTab.tsx` | Mevcut sayfa/bileşenleri sekme içine embed (rewrite yok) |
| `api/portPolicyAssignments.ts` | list/bulkSet/patch/remove |
| `api/devicePortsAggregate.ts` | aggregate endpoint client |

### DeviceForm modal sadeleştirme
`DeviceForm.tsx`'ten C6b bölümünü (`{secPolEnabled && (…)}` blok + ilgili state/queries) **kaldır**. `useSite`/`securityPoliciesApi`
import'ları sadeleşir. `secPolEnabled`/`switchPolicies`/`portPolicies` state/queries silinir. Payload normalizasyonundaki
`security_policy_id`/`port_security_policy_id` null-coerce satırları kaldırılır (Drawer artık bu alanları göndermez).

### Sekme tasarımı
- antd `Tabs`, `destroyInactiveTabPane={false}` (sekme değişiminde state korunur).
- URL: `?tab=overview|ports|security|vlan|mac|poe|events|backup|actions`. `useSearchParams` ile.
- Default tab: `overview` (?tab yoksa).

### Ports sekmesi UX
- antd `Table`, server-side aggregate endpoint'inden veri (refresh + react-query).
- Kolonlar: port_name (mono) · description · status (pill ●up/●down) · vlan · mac count · poe (watts/—) · **policy (effective + override badge)** · dry-run flap pill (varsa, mac_flap event'ten).
- Toplu seçim: checkbox + sticky toolbar "seçili N → [policy ata ▾] [override kaldır] [toplu shutdown 🔒 (disabled)]".
- Toplu atama Drawer: org'un port policy listesi (`securityPoliciesApi.list('port')`) + Uygula.
- Policy kolonu badge:
  - **● override** (per-port assignment var) — yeşil
  - cihaz-default — gri
  - org-default — gri
  - fallback — kırmızı uyarı (hardcoded fallback aktif, org default yok)

### Security Policies sekmesi UX
- "Switch Politikası" — mevcut C6b dropdown'ı (taşındı).
- "Tüm portlar için default" — mevcut C6b "Port Politikası (cihaz geneli)" dropdown'ı (taşındı). Yanına bilgi: "tek tek override → Ports sekmesi".
- "Aktif resolver zinciri (cihazın görüş açısı)" özeti (read-only):
  - Switch: `[policy adı] ([kaynak])`
  - Ports: per-port override / cihaz-default / org-default zinciri.
- "Atama geçmişi (audit)" — son N port policy değişikliği.

### UX wireframe (özet)
```
┌ Device Detail Page ─────────────────────────────────────────────────────┐
│ ← Devices    sw-core-01 (192.168.1.10) ●online [agent: mac-agent1]      │
│                                                                          │
│ [Overview] [Ports] [Security] [VLAN] [MAC] [PoE] [Events] [Backup] [..] │
│ ────────────────────────────────────────────────────────────────────── │
│ (aktif sekme içeriği)                                                  │
└────────────────────────────────────────────────────────────────────────┘

Ports sekmesi:
☐ Port      Açıkl.      Status VLAN MAC PoE   Policy           Flap
☑ Gi1/0/2   Reception   ●up    10   1   2.5W  default          —
☐ Gi1/0/3   CCTV-1      ●up    20   1   14W   kamera ● override —
[seçili 1] → [policy ata ▾] [override kaldır] [🔒 shutdown (C5)]
```

(Daha detaylı wireframe: önerideki ASCII — bkz. sohbet kararı.)

---

## Faz planlaması (öneri — küçük commit'ler, GO-gate'li)
| Faz | İçerik | Çıktı |
|---|---|---|
| **C7.A** | Backend: migration `f9ae` + resolver güncelleme + endpoint'ler + 6-8 birim/integration test. Mevcut C2/C6 pattern'i. | DB tarafı tam çalışır; UI yok |
| **C7.B** | Frontend iskelet: route + `DeviceDetailPage` + sekme çatısı + **Overview + Security Policies** sekmeleri. DeviceForm modal'dan C6b bölümünü çıkar. | Cihaz Detail açılır; switch + cihaz-default port policy yeni yerden atanabilir |
| **C7.C** | **Ports/Interfaces sekmesi** — port listesi (aggregate endpoint) + per-port policy kolonu + toplu seçim/atama Drawer + dry-run flap pill. **Asıl C7 değeri.** | Per-port override canlı; dry-run alarm bağlamı görünür |
| **C7.D** | Diğer sekmeler (VLAN/MAC/PoE/Events/Config Backup/Actions) — mevcut sayfa/bileşenleri **embed**. `/devices/:id/ports` → `?tab=ports` redirect. | Detail Page tam fonksiyon; mevcut sayfalardan navigation buraya |

Her faz: parse-check + test + canlı smoke (local + staging) + kullanıcı GO + merge. Production deploy AYRI iş (mini deploy zinciri — pre-deploy dump + 1 additive migration).

---

## Riskler

1. **port_name normalizasyonu (vendor çeşitliliği) — orta risk.**
   - v1 exact-match: Cisco `GigabitEthernet1/0/1` Aruba'nın `1/1/1`'ine eşleşmez.
   - Çoğu org tek vendor → v1 yeterli; çok-vendor org'larda override'lar her vendor'a tek tek yapılır.
   - Azaltma: aggregate endpoint'te port_name'i AYNEN snapshot'tan alır (cihazın kendi format'ı); resolver'da da aynı string aranır → tutarlı. Vendor-alias tablosu C7.B/C scope dışı, gelecek.

2. **Aggregate endpoint performansı (büyük port sayılı cihaz).**
   - 48-port cihaz × federasyon (4 snapshot + canlı SSH) → ilk yükleme sn cinsinden.
   - Azaltma: snapshot only fast-path + canlı SSH "Yenile" butonuyla on-demand (default kapalı). React-query 30s cache.

3. **C5 disabled placeholder yanılgısı.**
   - "Shutdown" butonu görünüp tooltip ile disabled → kullanıcı C5'i devrede sanabilir.
   - Azaltma: net etiket "C5 (approval) ile gelecek", gri ikon, tıklanmaz; release-notes'ta açıkça.

4. **v2.1 (canonical device_ports tablosu) tetikleyicisi.**
   - C7 v1 dar `port_policy_assignments` ile başlar. Eğer ileride per-port metadata (descr, ifindex, last-seen, notlar) eklenirse → canonical tablo gerekir.
   - Karar tetikleyici: per-port metadata ihtiyacı + override sayısı > N + vendor-alias normalization talebi.

5. **Detail Page derinliği — UI scope.**
   - 9 sekme tek tek küçük ama toplam büyük. C7.D'de mevcut sayfaları **embed** stratejisi ile yeniden yazma maliyeti yok.

---

## Test stratejisi
- **Backend (C7.A):**
  - Migration up/down (test DB).
  - Resolver: per-port override > device-default > org-default > fallback zinciri (her dal için ayrı test).
  - Endpoint: bulk set, idempotency (aynı port tekrar atama = upsert), org-isolation (cross-org INSERT WITH CHECK reddi).
- **Frontend (C7.B/C/D):**
  - Routing: `/devices/:id` SPA route, `?tab=` derin link, eski `?tab=` yoksa overview, redirect /ports→?tab=ports.
  - DeviceDetailPage smoke (mock device + tab geçişleri).
  - Ports tab: aggregate parse, toplu atama mutation, override badge mantığı.
  - Vitest + tsc + vite build clean (mevcut C6 pattern).
- **Staging (her faz sonu):** local Docker'da staging postgres + new code, real fixtures.

---

## Onay tetikleyici / başlama notu
Kod fazlarına başlamak için **ayrı GO** gerekir. C7.A'dan başlama önerisi:
1. Bu doc commit + push (üst seviye plan kalıcı).
2. C7.A için kısa "go/no-go" + tahmini iş yükü (3-5 commit, ~yarım gün migration + endpoint).
3. C7.A merge → C7.B GO → vb.

C5 ile karışmasın: C7 boyunca **gerçek port shutdown başlatılmaz**. Dry-run + disabled placeholder + audit yeterli.
