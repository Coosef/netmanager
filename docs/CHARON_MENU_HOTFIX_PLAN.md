# Charon Menu Restructure — Hotfix RCA + Plan

**Tarih:** 2026-06-08
**Trigger:** Production manuel smoke (2026-06-08) — 2 sorun tespit edildi
**Status:** **RCA + PLAN** — kod yazılmadı, kullanıcı GO bekler

---

## Sorun 1 — `/topology` sayfasında MenuGroupNav kayboluyor

### Kök neden (KESIN)

`frontend/src/pages/Topology/index.tsx:1981-1989` — TopologyPage'in en üst wrapper `<div>`'i:

```tsx
return (
  <div style={{
    margin: -24,            // ⚠ AppLayout workspace padding'ini iptal ediyor
    padding: 24,
    minHeight: '100vh',     // ⚠ Viewport tamamını kaplıyor
    background: isDark ? `radial-gradient(...)`  : TV.page,
  }}>
```

**Mekanizma:**
1. `.nm-workspace { padding: 18px; overflow: auto; }` (noc.css:342)
2. AppLayout workspace içine MenuGroupNav (sayfa-içi tab strip) + `<Outlet />` (sayfa içeriği) ardışık render edilir
3. TopologyPage'in **`margin: -24`** workspace padding'ini (18px) iptal eder + 6px daha **yukarı kayar**
4. Üst boşluk (MenuGroupNav'ın oturduğu alan) Topology background gradient ile kapanır
5. `minHeight: 100vh` ile Topology tüm viewport'u kaplar → MenuGroupNav görsel olarak Topology background'unun ALTINDA kalır (DOM'da var, görünmüyor)

**Kanıt: Sadece TopologyPage'de bu pattern var.** Diğer "minHeight: 100vh" kullanan sayfalar (OrgAdmin, TopologyTwin) negatif margin kullanmaz; MenuGroupNav görünür kalır.

### Etkilenen route'lar

- ✅ `/topology` (TopologyPage — feature flag canonical değilse)
- ⚠ `/topology-classic` — aynı sorun (aynı TopologyPage)
- ⚠ `/topology-next` (TopologyV2Page) — kontrol edilmedi ama muhtemelen aynı patern (V2 page benzer wrapper kullanıyor olabilir)

### Diğer sayfa kontrolü (negatif margin)

```
TopologyPage:1982         margin: -24    ← TEK BURADA SORUN
OrgAdmin / TopologyTwin   minHeight only (negatif margin yok) → MenuGroupNav görünür
```

### Çözüm seçenekleri

| Plan | Yaklaşım | Etki | Risk |
|---|---|---|---|
| **A** (önerilen) | MenuGroupNav `position: sticky; top: 0; z-index: 5` + solid background | Tüm sayfalar için MenuGroupNav her zaman üstte; Topology'nin negatif margin'i etkilemez (sticky overlay) | DÜŞÜK — sadece CSS, page component dokunulmaz |
| B | TopologyPage `margin: -24` kaldır | Topology background görünümü değişir (sadece workspace içinde) | ORTA — kullanıcı görsel değişim algılar |
| C | TopologyV2Page'i de inceleyip her ikisini de düzelt | İki sayfa tasarımına dokun | ORTA — TopologyV2 de değişir |
| D | AppLayout'ta z-index hierarchy yeniden tasarla | Karmaşa | YÜKSEK |

**Öneri: Plan A** — minimum müdahale, tüm sayfalar için robust çözüm.

### Plan A detay (CSS değişimi)

`AppLayout.tsx` `LAYOUT_CSS` içindeki `.nm-mg-nav` style'ı:

```css
.nm-mg-nav {
  display: flex;
  ...
  /* HOTFIX 2026-06-08: Topology gibi negatif margin + minHeight:100vh
     kullanan sayfaların MenuGroupNav'ı kaplaması engellenir. */
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg-0);   /* sticky için solid background şart */
}
```

`var(--bg-0)` mevcut Charon NOC palette'i (dark/light mod uyumlu).

---

## Sorun 2 — `/lldp-inventory` beyaz ekran + isim yanlış

### Kök neden (KESIN)

**Bulgu 1:** `App.tsx`'te `/lldp-inventory` route'u **YOK**.

```
$ grep -E "lldp-inventory|LldpInventory" frontend/src/App.tsx
40:  import LldpInventoryPage from '@/pages/LldpInventory'   ← import VAR
269: <Route path="discovery" element={<RoleRoute minRole="admin">
         <LldpInventoryPage />                                ← /discovery → LldpInventoryPage
     </RoleRoute>} />
```

Mevcut sistemde **sadece `/discovery` route var, ve `LldpInventoryPage` component'ini render ediyor**. `/lldp-inventory` URL'i routelist'te tanımlı değil → React Router 404'e düşer veya AppLayout altında boş `<Outlet />` → beyaz ekran.

**Bulgu 2:** Faz 2 helper (`menuGroups.ts`) Plan'da yanlış yorumlanmış — sistemde aslında **TEK SAYFA** var (LldpInventoryPage = Keşif Envanteri), iki ayrı tab açmaya gerek yoktu.

**Bulgu 3:** Kullanıcı zaten isteği netleştirdi: "Keşif Envanteri" görünmeli — tek sayfa, tek tab.

### Çözüm

1. **`menuGroups.ts` inventory grubundan `lldp` tab'ını sil.** Çift kayıt vardı, biri çalışmıyor (404).
2. **`discovery` tab'ının i18n label'ını değiştir:** "Keşif" → "Keşif Envanteri"
3. **4 dil locale güncelle:**
   - tr: "Keşif" → "Keşif Envanteri"
   - en: "Discovery" → "Discovery Inventory"
   - de: "Discovery" → "Discovery-Inventar"
   - ru: "Обнаружение" → "Инвентарь обнаружения"
4. **`nav.tab.inventory.lldp` i18n key'lerini 4 dilden de SIL** (orphan key olmasın).
5. **Test'leri güncelle** — inventory tab sayısı 8 → 7; lldp ile ilgili 2 test sil/güncelle.

### Mevcut `/discovery` route doğrulaması

```
App.tsx:269  <Route path="discovery" element={
                <RoleRoute minRole="admin">
                  <LldpInventoryPage />
                </RoleRoute>} />
```

- ✅ Route var
- ✅ Component yüklü
- ✅ Permission: `minRole="admin"` (legacy notation; gerçek karşılığı `org_admin` 4-rol sistemde)
- ✅ menuGroups.ts'te `discovery` tab'ı zaten `minRole: 'org_admin'` ile uyumlu

**Sonuç:** `/lldp-inventory` route'u tamamen kaldırılır; "Keşif Envanteri" tek tab olarak `/discovery`'ye bağlı kalır.

---

## Değişecek dosyalar — toplam 7 dosya, ~30 satır net delta

| # | Dosya | Tip | Δ | Açıklama |
|---|---|---|---:|---|
| 1 | `frontend/src/components/Layout/AppLayout.tsx` | Modify | +4 satır | `.nm-mg-nav` sticky + z-index + background (Sorun 1) |
| 2 | `frontend/src/utils/menuGroups.ts` | Modify | -1 tab | `lldp` tab'ı sil (Sorun 2) |
| 3 | `frontend/src/i18n/locales/tr.json` | Modify | -1, +mod | "Keşif" → "Keşif Envanteri"; `lldp` key sil |
| 4 | `frontend/src/i18n/locales/en.json` | Modify | -1, +mod | "Discovery" → "Discovery Inventory"; `lldp` key sil |
| 5 | `frontend/src/i18n/locales/de.json` | Modify | -1, +mod | "Discovery" → "Discovery-Inventar"; `lldp` key sil |
| 6 | `frontend/src/i18n/locales/ru.json` | Modify | -1, +mod | "Обнаружение" → "Инвентарь обнаружения"; `lldp` key sil |
| 7 | `frontend/src/utils/__tests__/menuGroups.test.ts` | Modify | ~5 satır | inventory tab sayısı 8 → 7; karar #4 (LLDP) test güncelle/sil |
| 8 | `frontend/src/components/Layout/__tests__/MenuGroupNav.test.tsx` | Modify | ~5 satır | Aynı: inventory tab listesi + LLDP test |

**Net delta:** ~30 satır kod + locale (Faz 2 + Faz 3 toplam ~880 LOC'in %3'ü).

### DOKUNULMAYAN

- ❌ Sidebar.tsx, TopNav.tsx, MenuGroupNav.tsx, useNavGroups.tsx — değişmez
- ❌ `App.tsx` route config — `/lldp-inventory` zaten yoktu, eklenmiyor
- ❌ `/pages/LldpInventory/index.tsx` page component — dokunulmaz
- ❌ `/pages/Topology/index.tsx` page component — **dokunulmaz** (Plan A CSS-only)
- ❌ Backend / DB / migration / docker-compose / env
- ❌ Diğer 11 ana grup ve 41 tab — etkilenmez

---

## Test plan

### Pre-merge pipeline

```bash
cd frontend
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/vite build
npm run i18n:check    # widening = 0 garantili (4 dilden ortak sil + mod)
```

**Beklenti:**
- vitest: 318 → ~316 (2 test silinir; toplam **316/316 PASS**)
- i18n parity widening = 0 (4 dilden 1 key kaldırılır + 1 key değeri değişir)

### Manuel smoke (deploy sonrası)

Kullanıcı talebi 7 route + 1 isim + 1 görsel:

| # | Senaryo | Beklenen |
|---|---|---|
| 1 | `/devices` → Ağ Envanteri tab menüsü görünür | ✅ |
| 2 | `/topology` → **Ağ Envanteri tab menüsü görünür, Topology aktif** | ✅ (sticky overlay) |
| 3 | `/discovery` → Ağ Envanteri tab menüsü görünür | ✅ |
| 4 | `/ipam` → Ağ Envanteri tab menüsü görünür | ✅ |
| 5 | `/vlan` → Ağ Envanteri tab menüsü görünür | ✅ |
| 6 | `/racks` → Ağ Envanteri tab menüsü görünür | ✅ |
| 7 | `/floor-plan` → Ağ Envanteri tab menüsü görünür | ✅ |
| 8 | Tab adı "Keşif Envanteri" (TR) | ✅ |
| 9 | `/discovery` beyaz ekran VERMEZ (mevcut sayfa render) | ✅ |
| 10 | `/lldp-inventory` URL'i bookmark'tan açılırsa → 404 veya boş `<Outlet />` (mevcut davranış, yeni durum yok) | bilinen — route yok |
| 11 | Topology page background gradient hâlâ tam ekran (Plan A CSS-only, Topology dokunulmadı) | ✅ |
| 12 | Tüm 11 grubun MenuGroupNav'ı sticky doğru çalışır | ✅ |

### TopologyV2 ek kontrolü

`TopologyV2Page` da `margin: -24` kullanıyor mu? Plan A CSS sticky tüm sayfalarda çalışacağı için **TopologyV2'ye dokunulmaz**, sticky overlay otomatik çözer. Hotfix sonrası kullanıcı smoke'unda `/topology-next` de doğrulanmalı.

---

## Risk analizi

| # | Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|---|
| 1 | sticky position bazı tarayıcıda buggy | DÜŞÜK | DÜŞÜK | position: sticky CSS standardı, tüm modern tarayıcılarda destekli |
| 2 | sticky background var(--bg-0) dark/light tema yanlış renkte | DÜŞÜK | DÜŞÜK | var(--bg-0) zaten Charon NOC palette, theme-light class ile flip ediyor |
| 3 | sticky scroll-shadow gerekebilir görsel için | DÜŞÜK | DÜŞÜK | İhtiyaca göre `box-shadow: 0 1px 0 var(--border-0)` eklenebilir; mevcut `border-bottom` zaten var |
| 4 | LLDP tab silinmesi kullanıcının beklentisini bozar mı? | DÜŞÜK | DÜŞÜK | Kullanıcı zaten talep etti: "Keşif Envanteri" tek tab |
| 5 | Mevcut bookmark `/lldp-inventory` kırık (404) | DÜŞÜK | DÜŞÜK | Route zaten yoktu — yeni bir kırılma yok |
| 6 | nav.tab.inventory.lldp key'in başka yerde kullanımı | DÜŞÜK | DÜŞÜK | grep ile doğrulanır (sadece menuGroups.ts kullanıyor) |
| 7 | Test güncellemeleri eksik kalır | DÜŞÜK | DÜŞÜK | tsc + vitest pipeline yakalar |

**Toplam risk: DÜŞÜK.**

---

## Deploy stratejisi

**Frontend-only hotfix** (W1-F + son menu deploy paterni).

| Faz | Aksiyon |
|---|---|
| P0 | Anchor + 1 rollback tag (sadece frontend) — `netmanager-frontend:rollback-pre-menu-hotfix-<TS>` |
| P1 | `git fetch + ff-merge` (backend + alembic delta 0 assert) |
| P2 | `docker compose build frontend` (~4dk) |
| P3 | `docker compose up -d --no-deps frontend` (~7sn) |
| P4 | Smoke: `/health/ready` + 7 HTTP route + bundle hash + alembic UNCHANGED |
| P5 | Servis matrisi (10 servis UNCHANGED) |
| P6 | Deploy log dokümanı |

**Backend rebuild GEREKMEZ.** Postgres/Redis/Celery/Nginx DOKUNULMAZ, `--no-deps` zorunlu.

### Rollback

```bash
docker tag netmanager-frontend:rollback-pre-menu-hotfix-<TS> netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 9a5f765   # mevcut menu restructure deploy state
```

Süre: ~30-60sn.

---

## Kapsam dışı (kullanıcı talebi)

- ❌ SSH Session Termination tekrar açılmıyor
- ❌ DriverTemplates içeriğine dokunulmuyor
- ❌ Backend / DB / migration yok
- ❌ Yeni component / yeni route eklenmiyor
- ❌ Diğer 11 ana grup ve 41 tab — etkilenmez

---

## Onay matrisi

| Aşama | Onay |
|---|---|
| **Bu RCA + plan dokümanı review** | ⏳ |
| **Hotfix implementation GO** | ⏳ (kullanıcı explicit) |
| Faz: kod yazımı (1 commit, küçük + kontrollü) | (GO sonrası) |
| Pipeline yeşil | (test sonu) |
| PR review + merge | (test yeşil) |
| Frontend-only deploy GO | (merge sonrası ayrı) |
| Manuel browser smoke (12 senaryo) | (deploy sonrası) |

**Bu plan KOD YAZMAZ.** Kullanıcı explicit "hotfix başla" demediği sürece referans niteliğindedir.

---

## Özet — tek paragraf

İki sorun, iki net kök neden, tek hotfix PR. **Sorun 1:** TopologyPage `margin: -24 + minHeight: 100vh` MenuGroupNav'ı görsel olarak kapatıyor → çözüm `MenuGroupNav'ı sticky + z-index + solid background` (CSS-only, Topology page dokunulmaz, diğer sayfalar etkilenmez). **Sorun 2:** `/lldp-inventory` route sistemde yok, mevcut `/discovery` zaten LldpInventoryPage render ediyor → menuGroups.ts'ten `lldp` tab'ı sil, `discovery` tab'ının i18n label'ını "Keşif Envanteri" yap (4 dil). 7 dosya, ~30 satır net delta. Backend/DB/migration sıfır. Vitest 318 → 316 (2 test sil), i18n widening = 0. Frontend-only deploy, --no-deps zorunlu.
