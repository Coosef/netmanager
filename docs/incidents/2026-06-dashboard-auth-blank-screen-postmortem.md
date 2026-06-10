# Incident Postmortem — Dashboard/Auth Blank Screen (June 2026)

> **Status:** RESOLVED / VERIFIED IN PRODUCTION
> **Resolution date:** 2026-06-10
> **Final fix:** PR #73 — token-first auth guard

## Etkilenen alanlar

- Login akışı
- `/` root route
- `/dashboard` route
- `ProtectedRoute` component (auth guard)
- Zustand persist hydration (`useHasHydrated` hook)
- `SiteContext` / `/api/v1/context/current` fetch
- `LocationGate` component
- Service Worker / Workbox cache
- Cloudflare edge cache
- Frontend nginx (SPA + welcome static)
- Yeni organizasyonların location bootstrap akışı
- Backend recreate sırasında geçici 502 penceresi (PR #62 deploy denemesi)

## Kullanıcı tarafından görülen belirtiler

1. Login başarılı olduğu halde siyah/boş ekran
2. "Geçiş onaylandı / Yönlendiriliyor…" ekranında stuck
3. URL `/dashboard` olduğu halde dashboard'un görünmemesi
4. `#root` içinde yalnız global `<style>` bulunması (rootText="", rootLength ≈ 1765)
5. Normal profilde siyah ekran, gizli sekmede zaman zaman çalışması
6. Backend deploy sırasında kısa süreli 502 Bad Gateway
7. Yeni org_admin kullanıcısında boş location listesi (Coosef / ATG Hotels)
8. Service Worker'ın eski bundle hash'lerini istemesi
9. Login sonrasında `/` isteğinin `/welcome/` sayfasına yönlenmesi

## Incident zaman çizelgesi

### Tarihsel hotfix katmanları (sorunu kısmi çözdü)

| PR | Amaç | Çözdüğü semptom | Çözmediği ana problem | Production | Rollback |
|---|---|---|---|---|---|
| PR #39 | Auth refresh hydrate guard | Dashboard refresh sonrası login ekranına atma | ProtectedRoute null pattern bozulmamış | merged | yok |
| PR #41 | Dashboard hotfix | 401 paralel race | Hydration race açık | merged | yok |
| PR #43 | PWA cache hotfix | Workbox cache lekesi | api-cache + index.html cache rules eksik | merged | yok |
| PR #45 | Login redirect hotfix | authenticated kullanıcı /login'de stuck | `/` hedefi page-reload riskliydi | merged | yok |
| PR #47 | Auth persist hydration (`useHasHydrated`) | Persist race penceresi daraltıldı | Hidrasyon kalıcı false senaryosu açık | merged | yok |

### Bu incident'taki PR zinciri (2026-06-10 yoğun gün)

| PR | Amaç | Çözdüğü semptom | Çözmediği ana problem | Production | Rollback |
|---|---|---|---|---|---|
| PR #60 | SW Kill-Switch + VitePWA disable | Stale workbox-precache + api-cache | Backend recreate 502 penceresi + nginx root redirect | merged + deployed | yok |
| Cloudflare Faz 0 | `/sw.js` bypass + manual purge + TLS 1.2 min | Edge cache stale sw.js | Aynı (server-side yapısal bug'lar) | applied | n/a |
| PR #64 | nginx `/` → `/welcome/` redirect kaldırıldı | "/" login sonrası tanıtım sayfasına saptırma | Client-side blank screen alt katmanları | merged + deployed | yok |
| Data fix | Org 6 (ATG Hotels) için `Unassigned — atg-hotels` location | Coosef location selector boş | Frontend empty-state UX kalıcı eksik | DB INSERT | yok |
| PR #66 | Windows installer PS 5.1 compat (backend) | Windows agent installer `?.Source` syntax error | Dashboard/Auth ile alakasız | merged + deployed | yok |
| PR #68 | RootRedirect + explicit /dashboard route | `/` page-reload döngüsü, login redirect race | Dashboard initialization state stuck | merged + deployed | yok |
| PR #70 | SiteContext hydrated guard + retry, Login setTimeout race | `context/current` ilk 401 race, ghost timer | ProtectedRoute null pattern halen aktif | merged + deployed | yok |
| PR #72 | finalizeSession direct navigate, LocationGate visible fallback | Login useEffect'e tek başına güvenmeme + ctx undefined blank | **ProtectedRoute null pattern halen aktif** | merged + **deploy FAILED + rolled back** | ✅ rolled back |
| **PR #73** | **Token-first ProtectedRoute + RootRedirect** | **`if (!hydrated) return null` antipattern kaldırıldı** | **— (gerçek kalıcı çözüm)** | **merged + deployed** | korunmuş tag |
| PR #74 | PR #73 deploy log | Doğru kapanış kaydı | — | merged (postmortem ile) | n/a |

## Ayrı kök nedenler

Bu incident **tek kök nedenden** oluşmadı. Aşağıdaki katmanlar **birbirinden ayrıdır** ve her birinin ayrı bir çözümü vardır.

### RC-1 — Service Worker API ve bundle cache'i

**Eski davranış:**
- Workbox `/api/*` GET cevaplarını cache'liyordu
- Eski service worker eski bundle hash'lerine bağlı kalabiliyordu
- `/sw.js` yanlışlıkla uzun süreli `immutable` cache header alıyordu

**Çözüm (PR #60 + Cloudflare Faz 0):**
- VitePWA kapatıldı
- Kill-switch `sw.js` eklendi (1490 byte, executable workbox YOK)
- `skipWaiting` + `caches.delete` + `registration.unregister` + `clients.matchAll().navigate(url)`
- Cache Storage temizlendi
- SW unregister edildi
- Fetch handler kaldırıldı
- `frontend/nginx.conf:57-63` `location = /sw.js` exact-match no-store
- Cloudflare `/sw.js` cache bypass kuralı oluşturuldu
- `/sw.js` purge edildi
- Origin: `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`
- Edge: `cf-cache-status: DYNAMIC`
- TLS Minimum Version: 1.2

### RC-2 — Nginx root redirect

**Problemli config (`frontend/nginx.conf:81-83` T8.5 zamanından):**
```nginx
location = / {
    return 301 /welcome/;
}
```

Login sonrası `navigate('/')` veya `window.location='/'` çağrısı yapan tüm kod path'leri kullanıcıyı **uygulama yerine Charon tanıtım sayfasına yönlendiriyordu**. Önceki forensic'te `/welcome/dashboard.jsx`, `/welcome/widgets.jsx` 404 dönüyordu — tanıtım sayfası içeriği eksikti → "blank screen" algısı.

**Çözüm (PR #64):**
- Exact root redirect kaldırıldı
- `/` SPA fallback üzerinden React Router'a bırakıldı (`location /` `try_files $uri /index.html`)
- `/welcome/` doğrudan URL olarak korunmaya devam etti (`location ^~ /welcome/`)

### RC-3 — Login redirect yarış koşulları

**Problemler:**
- Login success sonrası `/` hedefi kullanılması (page-reload tetikleyici)
- Birden fazla navigate mekanizması (useEffect + setTimeout)
- `setTimeout(() => navigate('/'), 800)` ghost timer — cleanup yok, component unmount sonrası bile fire
- Store update ile useEffect redirect arasında yarış

**Çözüm (PR #68 + PR #70 + PR #72):**
- Hedef `/dashboard` yapıldı
- Explicit `/dashboard` route eklendi (`<Route path="dashboard" element={<DashboardPage />}>`)
- Ghost setTimeout kaldırıldı (PR #70)
- finalizeSession içinde doğrudan `navigate('/dashboard', { replace: true })` eklendi (PR #72)
- Sidebar/TopNav brand click `/` → `/dashboard`
- RootRedirect index route handler eklendi (PR #68)

### RC-4 — SiteContext ilk 401 / hydration yarışı

**Problem:**
- `useQuery({queryKey: ['context', 'current', activeLocationId], queryFn: () => contextApi.current(), enabled: !!token})` sorgusu **token hydration tamamlanmadan** başlayabiliyordu
- API client interceptor `useAuthStore.getState().token` race ile yarım state okuyabilir → `Authorization: Bearer null` → 401
- `staleTime: 60_000` + retry yok → ilk fail sonsuz stuck → ctx undefined
- LocationGate defansif `hasLocationAccess: ?? true` ile children render AMA `features: {}` → bazı widget'lar gizli

**Çözüm (PR #70 + PR #72):**
- `enabled: !!token && hydrated` (hidrasyon guard)
- `retry: 1` + `retryDelay: 500` (transient 401 recovery)
- LocationGate'te `hasContextFailure` birleşik flag (`sitesError || (!sitesLoading && !ctx && !!token && hydrated)`)
- Hata durumunda görünür `<Result status="warning">` + Yenile butonu
- Boş/null ekran yerine açık recovery UI (i18n keys 4 dilde paralel)

### RC-5 — Asıl kalıcı blank screen kök nedeni (RC-1..RC-4'ün arkasındaki gerçek bug)

**Problemli kod (`App.tsx` eski ProtectedRoute):**
```tsx
if (!hydrated) return null
return token ? <>{children}</> : <Navigate to="/login" replace />
```

ProtectedRoute, **token store'da mevcut olsa bile** hydration flag false olduğunda `null` dönüyordu.

**Production sonucu:**
- URL `/dashboard` ✓
- Token mevcut (localStorage'da) ✓
- Yeni bundle yüklü ✓
- SW yok ✓
- React root mount edilmiş ✓
- **AMA AppLayout ve Dashboard MOUNT EDİLMİYORDU**
- Root içinde yalnız global style/provider kabuğu kalıyordu

**Canlı browser kanıtı (2026-06-10):**
```
location: /dashboard
rootText: ""
rootLength: 1765
dashboardVisible: false
swCount: 0
```

**Kalıcı çözüm (PR #73) — token-first karar matrisi:**
```tsx
if (token) return <>{children}</>             // hydrated bağımsız ⭐
if (!hydrated) return <ProtectedRouteLoading />
return <Navigate to="/login" replace />
```

| token | hydrated | render |
|---|---|---|
| **var** | **false** | **children** ⭐ (eskiden null → blank) |
| var | true | children |
| null | false | görünür `<Spin>` (eskiden null → blank) |
| null | true | `/login` |

**Temel kural:** Token store'da mevcutken auth guard kullanıcıyı bloklamaz. Store gerçeği authoritative.

Aynı matris `RootRedirect`'e de uygulandı (App.tsx index route).

**Final production kanıtı (manuel browser smoke admin PASS):**
- Sidebar görünür
- Header görünür
- Dashboard kartları görünür
- Widget API'leri 200 (monitor/stats, sla, intelligence/risk, anomalies, services/impact, devices, tasks, backup-schedules, approvals, agents)
- Kalıcı 4xx/5xx yok
- Backend error/CRITICAL yok

### RC-6 — Yeni organizasyonda location bulunmaması

**Problem:** Backend `create_org` akışı yeni organizasyon oluştururken otomatik default location oluşturmuyordu. Org 6 (ATG Hotels) için locations tablosu boştu. Sprint 1C "no-op verified" kararı bu senaryoyu kaçırmıştı.

**Geçici data fix (2026-06-10):**
```sql
INSERT INTO locations (organization_id, name, description, address, color, city, country, timezone, created_at)
SELECT 6, 'Unassigned — atg-hotels', '', '', '', '', '', '', NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM locations
  WHERE organization_id = 6 AND name = 'Unassigned — atg-hotels'
);
```

Sonuç: `Unassigned — atg-hotels` (id=11) location oluşturuldu. Coosef location selector artık dolu.

**Bu ana blank screen kök nedeni değildi**, ancak gerçek bir veri/bootstrap problemiydi (Sprint 1C kapanış kararı revize edildi).

**Kalıcı backlog:**
- Yeni organizasyon oluşturulduğunda otomatik `Unassigned — {slug}` location oluştur (backend `create_org` akışında transaction içinde)
- Frontend'de boş location listesi için anlamlı empty-state göster ("Henüz lokasyon yok — admin'den ekleyin" + CTA)

### RC-7 — Backend recreate sırasında geçici 502 (PR #62 deploy denemesi)

**Problem (2026-06-10 PR #62 ilk deploy):**
- Backend recreate sırasında upstream kısa süre hazır değildi (~5-10 sn healthcheck "starting")
- Nginx bu sürede 502 döndü
- Smoke test backend healthy olmadan başladı (`sleep 8`)
- Cloudflare/browser sticky 5xx cache kullanıcıya kalıcı 502 gösterdi

**Çözüm (operational pattern):**
- Health-gated deploy loop (`until curl -fs http://localhost/health/ready; do sleep 1; done`)
- Smoke test yalnız backend healthy olduktan sonra
- Rollback image tag'i (her deploy öncesi alındı)
- Düşük trafik maintenance window
- Cloudflare 5xx bypass cache rule (planlanan, Faz 1 redeploy stratejisi)

**Bu durum PR #62 kod hatası değildi; deployment availability problemiydi.** PR #62 kodu (must_change_password enforcement) hala valid; controlled redeploy backlog'unda.

## Yanlış teşhisler ve öğrenilen dersler

1. **API çağrılarının 200 olması, kullanıcıya dashboard'un görünür olduğu anlamına gelmez.**
2. **Server healthy olması, React ağacının render edildiğini kanıtlamaz.**
3. **URL'nin `/dashboard` olması, AppLayout/Dashboard mount olduğunu kanıtlamaz.**
4. **`#root` boş değilse uygulama görünür sanılmamalı; yalnız `<style>` tag bulunabilir.** (rootLength=1765 sadece global CSS injection idi)
5. **Normal profil/gizli sekme farkı her zaman cache problemi değildir.** Gizli sekmede de bug üretilebilir; "gizli sekmede çalışıyor" yanıltıcı sinyal.
6. **Yeni org'da locations boş olması gerçek bir bug'dı fakat ana siyah ekran sebebi değildi.** İki ayrı problem birleştirilmemeli.
7. **Nginx root redirect gerçek bir problemdi fakat tek başına tam çözüm değildi.** Server-side fix client-side bug'ı maskelemeli değil.
8. **Login redirect düzeltmesi doğruydu fakat ProtectedRoute null döndürmeye devam ediyordu.** Üst katman fix'i alt katman bug'ını saklamaz.
9. **Mock testlerde sürekli `hydrated=true` kullanmak production race condition'ını gizledi.** Kritik senaryoda `token + hydrated=false` test edilmeli.
10. **Source grep testleri gerçek kullanıcı akışının yerini tutmaz.** MemoryRouter + DOM render testi gerek.
11. **Deploy sırasında range cherry-pick kullanmak ilgisiz commit sızdırma riski oluşturur.** Tek SHA cherry-pick disiplin.
12. **"Build/deploy success" ile "feature verified" aynı şey değildir.** Manuel browser smoke + DOM kanıtı şart.

## Hatalı ifade düzeltmesi

Önceki kapanış metinlerinde geçen **"5 yıllık Dashboard/Auth sorunu"** ifadesi hatalıdır. Tarihsel olarak gerçekten beş yıl sürdüğüne dair kanıt yoktur.

Doğru ifade: **"Birden fazla hotfix boyunca devam eden Dashboard/Auth sorunu"** veya **"Uzun süredir tekrarlayan Dashboard/Auth blank-screen incident'ı"**.

Bu postmortem, deploy log ve memory entry'lerinde düzeltildi (bkz. değişiklik kaydı).

## Başarılı final state

```
VPS HEAD:          cb9762f
Frontend image:    7cd1337f313c
Frontend bundle:   index-BEaYgLQm.js
Backend image:     0bd08b79f779 (UNCHANGED)
Alembic:           f9aeportpol (UNCHANGED)
Services:          11/11 healthy
Cherry-pick:       2 tek SHA (914b38a + 69631cb)
```

**Rollback tag (korunmuş):**
```
netmanager-frontend:rollback-pre-auth-guard-fix-20260610_2014 → e93b6707fb77
```

## Sızma kontrol kanıtı (production'a alınmayan PR'lar)

| Commit | PR/Açıklama | Production ağacında |
|---|---|---|
| `49e9ae6` | Sprint 2A | ❌ YOK |
| `31b3f2c` | PR 4 (audit-filter-bar) | ❌ YOK |
| `d8af73b` | PR #58 (tsc hotfix) | ❌ YOK |
| `3bf11f8` / `97de09b` | PR #62 (must_change_password) | ❌ YOK |
| `frontend/src/pages/Agents/installCmd.ts` (PR #67) | Agent UI Windows command fix | ❌ YOK |

## İlgili dokümanlar

- Troubleshooting Runbook: [`docs/runbooks/frontend-login-dashboard-blank-screen.md`](../runbooks/frontend-login-dashboard-blank-screen.md)
- PR #73 Deploy Log: [`docs/AUTH_GUARD_TOKEN_FIRST_DEPLOY_LOG_2026-06-10.md`](../AUTH_GUARD_TOKEN_FIRST_DEPLOY_LOG_2026-06-10.md)
- PR #64 (nginx) Deploy Log: [`docs/NGINX_ROOT_REDIRECT_FIX_DEPLOY_LOG_2026-06-10.md`](../NGINX_ROOT_REDIRECT_FIX_DEPLOY_LOG_2026-06-10.md)
- SW Kill-Switch (PR #60) Deploy Log: [`docs/SW_KILLSWITCH_DEPLOY_LOG_2026-06-09.md`](../SW_KILLSWITCH_DEPLOY_LOG_2026-06-09.md)
