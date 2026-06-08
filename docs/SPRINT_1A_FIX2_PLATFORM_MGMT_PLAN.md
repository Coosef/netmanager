# Sprint 1A-fix-2 — Platform Management super_admin-only Hotfix Plan

> **Trigger:** Sprint 1A manuel smoke (2026-06-08) sonrası kullanıcı tespiti.
> **Branch (planlı):** `t10/sprint-1a-fix2-platform-only-sa`
> **Scope:** Frontend-only. Backend / DB / migration **dokunulmaz**. SSH Termination kapsam dışı (kapalı). Charon Menu Restructure (c0d4051) baseline korunur.
> **Status:** **PLAN — GO BEKLER**, kod yazılmadı.

---

## A. Kök neden

`utils/menuGroups.ts:213-222` admin_platform grubu 4 tab içerir; **2 tab kullanıcı rollerine erişebilir durumda**, bu yüzden grubun kendisi de sidebar'da görünür kalır.

`canSeeGroup` mantığı (menuGroups.ts:299-303): "Dashboard her zaman; diğerleri **en az 1 görünür tab şartı**". admin_platform 4 tab değerlendirir:

| Tab | route | mevcut gate | super_admin | org_admin | location_admin | viewer |
|---|---|---|---|---|---|---|
| **platform** | `/superadmin` | `minRole: 'super_admin'` | ✅ | ❌ | ❌ | ❌ |
| **organization** | `/org-admin` | `minRole: 'org_admin' + excludeSuperAdmin` | ❌ | ✅ | ❌ | ❌ |
| **settings** | `/settings` | `module: ['settings', 'view']` | ✅ (can()=true) | ✅ (can()=true) | ✅ (can()=true) | ✅ (action='view' default true) |
| **help** | `/help` | **gate yok** | ✅ | ✅ | ✅ | ✅ |

**Sonuç:**
- super_admin grubu görür → platform + settings + help (3 tab)
- org_admin grubu görür → organization + settings + help (3 tab)
- location_admin grubu görür → settings + help (2 tab)
- viewer grubu görür → settings + help (2 tab)

**Tüm roller "Platform Yönetimi" sidebar grubunu görüyor.** Kullanıcı istemediği bu davranış.

App.tsx'te ek olarak:
- `/settings` `PermRoute module="settings" action="view"` (App.tsx:291) → can('settings','view') hangi role true dönerse açar → org_admin/super_admin için true (auth.ts:127 kısa devre)
- `/help` (App.tsx:321) **route guard yok** → herkes açar

### Kullanıcının listesinde olan ama sistemde olmayan route'lar

| Listede | App.tsx'te | Açıklama |
|---|---|---|
| `/system-settings` | ❌ **YOK** | Sistemde tanımlı değil |
| `/organizations` | ❌ **YOK** | Sistemde tanımlı değil |
| `/users` | ✅ var | admin_users grubunda (Platform Mgmt değil) |
| `/permissions` | ✅ var | admin_users grubunda (Platform Mgmt değil) |
| `/locations` | ✅ var | admin_users grubunda (Platform Mgmt değil) |

**Bu hotfix kapsamı yalnız admin_platform grubu.** `/users`, `/permissions`, `/locations` admin_users (Kullanıcı & Erişim Yönetimi) grubunda — dokunulmayacak.

---

## B. Platform Management mevcut tab/route listesi (özet)

```ts
// menuGroups.ts:213-222 — admin_platform grup tanımı
{
  key: 'admin_platform',
  i18nKey: 'nav.group.admin_platform',
  tabs: [
    { key: 'platform',     route: '/superadmin', i18nKey: '...', minRole: 'super_admin' },
    { key: 'organization', route: '/org-admin',  i18nKey: '...', minRole: 'org_admin', excludeSuperAdmin: true },
    { key: 'settings',     route: '/settings',   i18nKey: '...', module: ['settings', 'view'] },
    { key: 'help',         route: '/help',       i18nKey: '...' },
  ],
}
```

```tsx
// App.tsx Platform Management route'ları
<Route path="settings" element={<PermRoute module="settings" action="view"><SettingsPage /></PermRoute>} />  // L291
<Route path="help" element={<HelpPage />} />                                                                 // L321 — guard yok
<Route path="superadmin" element={<RoleRoute minRole="super_admin"><SuperAdminPage /></RoleRoute>} />        // L325 — zaten OK
<Route path="org-admin" element={<RoleRoute minRole="org_admin" excludeRoles={['super_admin']}><OrgAdminPage /></RoleRoute>} />  // L328
```

---

## C. Hangi route'lar super_admin-only yapılacak

| Route | Mevcut guard | Yeni guard | Notlar |
|---|---|---|---|
| `/superadmin` | `RoleRoute minRole="super_admin"` | ✅ aynı | Değişiklik yok |
| `/org-admin` | `RoleRoute minRole="org_admin" excludeRoles={['super_admin']}` | `RoleRoute minRole="super_admin"` | org_admin'e kapanır; super_admin debug için erişebilir; **menüden silindiği için pratikte yalnız URL ile** |
| `/settings` | `PermRoute module="settings" action="view"` | `RoleRoute minRole="super_admin"` | org_admin/location_admin/viewer kapanır; ileride **ayrı "Ayarlar" menüsü tasarlanırsa kullanıcı-yönelik bölümler oraya** |
| `/help` | (yok) | `RoleRoute minRole="super_admin"` | **UX uyarısı:** Yardım sayfası kullanıcılardan tamamen kapanır. Bilinçli karar — ileride "Ayarlar" menüsünde geri açılacak. Şimdilik kullanıcılar AppHeader yardım butonu (yoksa) veya doğrudan dokümantasyon kullanır |

### UX uyarısı — /help kullanıcılardan kapanır

Şu an `/help`'e tek erişim noktası **Platform Management → Yardım tab'ı**. Sidebar grubu super_admin-only olduğunda + route guard super_admin-only olduğunda, **org_admin/location_admin/viewer hiçbir şekilde Yardım sayfasına erişemez** (URL'i bilseler bile).

Kullanıcı bu sprintte bunu **kabul** ediyor: "Daha sonra kullanıcıları ilgilendiren ayarlar için ayrı 'Ayarlar' menüsü/sayfası tasarlanacak." → o sprintte help bu yeni menüye taşınabilir.

**Alternatif (önermiyorum):** Help'i admin_platform'dan çıkarıp ayrı bir gruba taşımak — ama kullanıcının "Platform Management tamamen super_admin-only" talimatına birebir uymak için bunu tercih etmiyorum.

---

## D. Değişecek dosyalar (atomik PR)

### D.1 `frontend/src/App.tsx` — 3 route guard değişimi

| Satır | Mevcut | Yeni |
|---|---|---|
| 291 | `<Route path="settings" element={<PermRoute module="settings" action="view"><SettingsPage /></PermRoute>} />` | `<Route path="settings" element={<RoleRoute minRole="super_admin"><SettingsPage /></RoleRoute>} />` |
| 321 | `<Route path="help" element={<HelpPage />} />` | `<Route path="help" element={<RoleRoute minRole="super_admin"><HelpPage /></RoleRoute>} />` |
| 328 | `<Route path="org-admin" element={<RoleRoute minRole="org_admin" excludeRoles={['super_admin']}><OrgAdminPage /></RoleRoute>} />` | `<Route path="org-admin" element={<RoleRoute minRole="super_admin"><OrgAdminPage /></RoleRoute>} />` (`excludeRoles` kaldırılır) |

Net delta: ~5 satır.

### D.2 `frontend/src/utils/menuGroups.ts` — admin_platform tab refactor

```ts
{
  key: 'admin_platform',
  i18nKey: 'nav.group.admin_platform',
  tabs: [
    { key: 'platform', route: '/superadmin', i18nKey: 'nav.tab.admin_platform.platform', minRole: 'super_admin' },
    // organization tab SİLİNDİ (org_admin için ayrı menü ileride)
    { key: 'settings', route: '/settings',   i18nKey: 'nav.tab.admin_platform.settings', minRole: 'super_admin' },
    { key: 'help',     route: '/help',       i18nKey: 'nav.tab.admin_platform.help',     minRole: 'super_admin' },
  ],
}
```

Değişiklikler:
- `organization` tab **SİL** (1 satır + yorum)
- `settings` tab → `module` kaldır, `minRole: 'super_admin'` ekle
- `help` tab → `minRole: 'super_admin'` ekle

Net delta: ~5 satır.

### D.3 Test dosyaları — guardrail güncellemesi

**`frontend/src/utils/__tests__/menuGroups.test.ts`:**
- `admin_platform.tabs` count 4 → **3**
- Karar 5 testi (Organizasyon Paneli excludeSuperAdmin): **organization tab silindi** → test güncellenir veya silinir
- viewer için Settings ilk tab beklentisi: artık viewer admin_platform göremez → güncellenir

**`frontend/src/components/Layout/__tests__/MenuGroupNav.test.tsx`:**
- `getActiveGroup('/help')` test'i admin_platform'a hala döner (route var, tab yine var)
- 12 grup × 4 rol matrisi: admin_platform için org_admin/location_admin/viewer artık görmez → matris güncellenir
- "admin_platform — org_admin için Organizasyon Paneli" testi **SİL veya yeniden yorumla**
- "admin_platform — viewer için Settings ilk gelir" testi → "viewer admin_platform göremez" olarak değiştir

Net delta: ~10-15 satır test güncelleme.

### Toplam

**4 dosya, ~25 satır net delta.** 1 atomik commit.

### DOKUNULMAYANLAR

- ❌ Backend / DB / migration
- ❌ SSH Termination
- ❌ DriverTemplates
- ❌ Charon Menu Restructure 12 ana grup yapısı (sadece admin_platform içeriği değişir)
- ❌ Diğer 11 grup (dashboard, inventory, monitoring, alerts, config, automation, security, reports, tools, admin_users, admin_audit)
- ❌ HelpPage / SettingsPage / OrgAdminPage / SuperAdminPage component'leri
- ❌ admin_users grubundaki /users, /permissions, /locations, /agents
- ❌ i18n locale dosyaları (label'lar aynı; sadece visibility değişir; widening = 0)

---

## E. Test planı

### E.1 Yeni testler (menuGroups.test.ts + MenuGroupNav.test.tsx)

| # | Test | Beklenti |
|---|---|---|
| 1 | `admin_platform.tabs.length === 3` | platform + settings + help |
| 2 | `canSeeGroup(admin_platform, super_admin_ctx)` | **true** (3 tab görünür) |
| 3 | `canSeeGroup(admin_platform, org_admin_ctx)` | **false** (hiç görünür tab yok) |
| 4 | `canSeeGroup(admin_platform, location_admin_ctx)` | **false** |
| 5 | `canSeeGroup(admin_platform, viewer_ctx)` | **false** |
| 6 | `getFirstVisibleTab(admin_platform, super_admin)` → `platform` | platform ilk yetkili |
| 7 | `getVisibleGroups(super_admin).map(g=>g.key)` 12 grup içermeli | admin_platform dahil |
| 8 | `getVisibleGroups(org_admin).map(g=>g.key)` admin_platform içermez | 11 grup (admin_platform hariç) |
| 9 | `ROUTE_TO_GROUP['/org-admin']` hala 'admin_platform' (tab silindi ama route hala admin_platform'a haritalı değil — silindi) | **undefined** veya admin_platform yapacağız? |
| 10 | (Aşağıdaki not 9 için netleştirme) | bkz. not |

**Not 9:** `/org-admin` tab silinince `ROUTE_TO_GROUP` lookup'tan da düşer. Sidebar tıklama davranışı: `getActiveGroup('/org-admin')` → `null`. MenuGroupNav `/org-admin` URL'inde render etmez (super_admin OrgAdminPage'i debug için açar; tab strip görünmez). Bu **kabul edilebilir** — admin_platform tab'larıyla ilgisi yok.

### E.2 Mevcut test güncellemeleri

- `karar 5 testi` (organization tab + excludeSuperAdmin) **REMOVE veya REWRITE**
- "Platform Yönetimi — viewer için Settings (view-only) ilk gelir" testi **REWRITE**: viewer admin_platform göremez
- "Platform Yönetimi — super_admin için Platform Paneli" testi: UNCHANGED
- "Platform Yönetimi — org_admin için Organizasyon Paneli" testi **REMOVE veya REWRITE**

### E.3 Pipeline gate

| Pipeline | Beklenti |
|---|---|
| `tsc --noEmit` | 0 hata |
| `vitest run` | 335 → ~333-336 PASS (organization testi sil + 3-5 yeni test ekle) |
| `vite build` | OK |
| `npm run i18n:check` | **widening = 0** (label değişikliği yok, sadece visibility) |

### E.4 Manuel smoke (deploy sonrası)

| # | Senaryo | Beklenen |
|---|---|---|
| 1 | super_admin sidebar | "Platform Yönetimi" görünür |
| 2 | super_admin Platform Yönetimi tıkla | platform tab seçili (`/superadmin`) |
| 3 | super_admin tab strip | platform + settings + help (3 tab) |
| 4 | org_admin sidebar | "Platform Yönetimi" **GÖRÜNMEZ** |
| 5 | location_admin sidebar | görünmez |
| 6 | viewer sidebar | görünmez |
| 7 | org_admin `/superadmin` URL | Dashboard'a yönlenir |
| 8 | org_admin `/settings` URL | Dashboard'a yönlenir |
| 9 | org_admin `/help` URL | Dashboard'a yönlenir |
| 10 | org_admin `/org-admin` URL | Dashboard'a yönlenir |
| 11 | super_admin `/settings` URL | açılır |
| 12 | super_admin `/help` URL | açılır |
| 13 | super_admin `/org-admin` URL | açılır (debug erişimi) |
| 14 | Sprint 1A senaryoları (Discovery/Racks/VLAN/...) regresyon | UNCHANGED |
| 15 | Sidebar 11 grup görünür (org_admin için) | admin_platform hariç hepsi |

---

## F. Deploy planı

### F.1 Karakter
- **Frontend-only** (W1-F + Charon Menu + Sprint 1A paterni)
- Backend touch: **YOK**
- DB / migration: **YOK**
- 1 atomik PR + 1 commit

### F.2 Rollback hazırlığı
- Tag: `netmanager-frontend:rollback-pre-sprint-1a-fix2-<TS>`
- Mevcut prod image: `ea83e12ce054` (Sprint 1A deploy sonrası)

### F.3 6 faz (Sprint 1A paterni)

| Faz | Aksiyon |
|---|---|
| P0 | Anchor + rollback tag |
| P1 | git fetch + ff-merge (backend/alembic delta 0 assert) |
| P2 | docker compose build frontend (~4 dk) |
| P3 | docker compose up -d --no-deps frontend (~7 sn) |
| P4 | Smoke: yeni JS bundle + alembic UNCHANGED |
| P5 | Servis matrisi (10 servis UNCHANGED) |
| P6 | Deploy log dokümanı |

---

## Atomik PR / commit özeti

- **Branch:** `t10/sprint-1a-fix2-platform-only-sa`
- **Commit sayısı:** 1
- **Dosya sayısı:** 4 (App.tsx + menuGroups.ts + 2 test)
- **LOC:** ~25 satır

**Commit message draft:**
```
fix(rbac): SPRINT-1A-fix2 — Platform Management super_admin-only

Sprint 1A manuel smoke (2026-06-08) sonrası kullanıcı tespiti:
"Platform Yönetimi" sidebar grubu org_admin/location_admin/viewer
için de görünüyordu. Beklenen: yalnız super_admin.

Kök neden: admin_platform grubunun 4 tab'ından 2'si (settings,
help) kullanıcı rollerine açık → canSeeGroup 1+ visible tab şartı
sağlanıyor → grup tüm rollerde görünür.

Düzeltme (frontend-only):

menuGroups.ts admin_platform grup:
  · organization tab SİLİNDİ (org_admin için ayrı menü ileride)
  · settings tab: module ['settings','view'] → minRole 'super_admin'
  · help tab: gate yoktu → minRole 'super_admin'
  · platform tab: değişmez (zaten super_admin)

App.tsx route guards:
  · /settings: PermRoute settings:view → RoleRoute super_admin
  · /help: guard yoktu → RoleRoute super_admin
  · /org-admin: org_admin + excludeRoles → minRole super_admin
    (excludeRoles kaldırıldı — RoleRoute API zaten genel)

Sonuç:
  · super_admin: sidebar'da Platform Yönetimi + 3 tab (platform/
    settings/help)
  · org_admin/location_admin/viewer: sidebar'da Platform Yönetimi
    GÖRÜNMEZ; direct URL Dashboard'a yönlendirir

UX trade-off: /help kullanıcılardan kapanır (önceden tek erişim
noktası Platform Mgmt). Bilinçli karar — ileride ayrı "Ayarlar"
menüsü tasarlanırsa kullanıcı-yönelik bölümler oraya taşınır.

DOKUNULMAYAN:
  · Backend / DB / migration / docker-compose
  · SSH Session Termination (kapalı)
  · DriverTemplates içeriği
  · Charon Menu Restructure 12 ana grup yapısı
  · Diğer 11 grup + admin_users (/users, /permissions, /locations)
  · HelpPage, SettingsPage, OrgAdminPage, SuperAdminPage component
  · i18n locale dosyaları (label aynı; widening = 0)
```

**PR title:** `fix(rbac): SPRINT-1A-fix2 — Platform Management super_admin-only`

---

## Scope dışı (ayrı paket önerilir)

| # | İş | Sebep |
|---|---|---|
| S-OUT-1 | `/help` kullanıcılara açma | İleride ayrı "Ayarlar" menüsü tasarımı sırasında |
| S-OUT-2 | Kullanıcı-yönelik settings page | İleride ayrı menü/sayfa olarak yeniden tasarım |
| S-OUT-3 | Org admin için yeni Organization paneli ihtiyacı | Kullanıcı talebi geldiğinde ayrı tasarım |
| S-OUT-4 | Backend ORG_ADMIN permission surface | Sprint 1B |
| S-OUT-5 | Yeni org bootstrap default Location | Sprint 1C |
| S-OUT-6 | MFA Bug | Master rapor B.1 paketi |

---

## Risk analizi

| # | Risk | Sev | Olasılık | Mitigation |
|---|---|---|---|---|
| R1 | /help kullanıcılardan tamamen kapanır → kullanıcı şikayet edebilir | MEDIUM | Yüksek | UX uyarısı C bölümünde açık; kullanıcı kabul etti; ileride ayrı menüde geri açılacak |
| R2 | org_admin için /settings'te yapılandırma erişimi varsa kapanır → operasyonel etki | LOW | Düşük | Master rapor backend org_admin için settings:* yetkisi olmadığını gösteriyor; pratikte sayfa boş veya 403 dönüyor olabilir; kapatmak temiz |
| R3 | super_admin /org-admin debug erişimi kullanıcı tarafından farkedilebilir | LOW | Düşük | Menüden gizli, sadece URL ile erişilebilir; super_admin için OK |
| R4 | Mevcut Sprint 1A senaryoları regresyon | LOW | Çok düşük | admin_platform dışındaki grupları değiştirmiyoruz; 17 senaryo regresyon yok |
| R5 | i18n widening | LOW | Çok düşük | Sadece visibility değişiyor, label'lar dokunulmuyor |
| R6 | Mevcut Karar 5 testleri (organization tab + excludeSuperAdmin) fail | DÜŞÜK | Yüksek | Test güncellemesi planda; pipeline gate yakalar |

---

**Plan onayı bekleniyor.** Onay sonrası branch açılır, F dosyaları sırayla uygulanır, testler güncellenir, tek commit + PR oluşturulur.
