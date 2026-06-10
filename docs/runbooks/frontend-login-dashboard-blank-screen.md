# Runbook — Frontend Login/Dashboard Blank Screen

> **Use this when:** Kullanıcı login oluyor fakat:
> - siyah ekran görüyor,
> - "Yönlendiriliyor…" ekranında kalıyor,
> - `/dashboard` URL'sine geçiyor fakat içerik gelmiyor,
> - veya frontend tamamen boş görünüyor.
>
> Related postmortem: [`docs/incidents/2026-06-dashboard-auth-blank-screen-postmortem.md`](../incidents/2026-06-dashboard-auth-blank-screen-postmortem.md)

## İlk 5 dakikalık kontrol sırası

### 1. Route kontrolü

Browser console:
```javascript
location.href
```

### 2. Bundle kontrolü

Hangi JS bundle yüklendi:
```javascript
performance
  .getEntriesByType("resource")
  .map((entry) => entry.name)
  .filter((name) => name.includes("/assets/index-"))
```

Production `<head>` ile karşılaştır:
```bash
curl -s https://netmanager.systrack.app/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.(js|css)'
```

Eski bundle hash referansı VAR mı?

### 3. Auth store kontrolü

Token'ın tamamını **loglamadan** yalnız boolean kontrol edin:
```javascript
const rawAuth = localStorage.getItem("netmgr-auth");
console.log({
  authPresent: Boolean(rawAuth),
  authLength: rawAuth?.length ?? 0
});
```

> **🔐 Güvenlik notu:**
> - JWT/token'ın **tamamı** ekran görüntüsünde veya loglarda paylaşılmamalı
> - Agent key'leri paylaşıldıysa **rotate edilmelidir** (admin paneli → Agents → Rotate Key)
> - Bu runbook'un örneklerinde sadece varlık/uzunluk kontrolü yap, içerik dump etme

### 4. Görünür DOM kontrolü

Tek-shot Promise ile snapshot:
```javascript
navigator.serviceWorker.getRegistrations().then((registrations) => ({
  location: location.href,
  rootText: document.querySelector("#root")?.innerText?.slice(0, 500),
  rootLength: document.querySelector("#root")?.innerHTML?.length,
  appLayout: !!document.querySelector(
    '[data-testid="app-layout"], .nm-app-shell'
  ),
  dashboardVisible: !!document.querySelector(
    '[data-testid="dashboard-page"]'
  ),
  protectedRouteLoading: !!document.querySelector(
    '[data-testid="protected-route-loading"]'
  ),
  rootRedirectLoading: !!document.querySelector(
    '[data-testid="root-redirect-loading"]'
  ),
  swCount: registrations.length,
  bundle: performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => name.includes("/assets/index-")),
}))
```

### 5. Network kontrolü

DevTools Network tab → Preserve log açık → login submit sonrası beklenen sıra:

```
POST /api/v1/auth/login                           → 200
GET  /api/v1/context/current                      → 200
GET  /api/v1/monitor/stats                        → 200
GET  /api/v1/sla/fleet-summary                    → 200
GET  /api/v1/services/fleet/impact-summary        → 200
GET  /api/v1/intelligence/fleet/risk              → 200
GET  /api/v1/intelligence/anomalies               → 200
GET  /api/v1/devices/?limit=1000                  → 200
GET  /api/v1/tasks/?limit=6                       → 200
GET  /api/v1/approvals/pending-count              → 200
```

**Eksik istekler dashboard'un render edilmediğine işaret eder** (server-side smoke ile karıştırma — API çağrısı görünür DOM kanıtı değildir).

## Tanı matrisi

### Belirti: URL `/login` üzerinde kalıyor

Kontrol et:
- `Login/index.tsx` `finalizeSession` direct navigate var mı?
- Login authenticated redirect useEffect (`existingToken` dependency)
- Sonsuz navigate döngüsü var mı? (nginx access log: 1 sn'de N+ GET / istek)
- POST `/auth/login` response 200 mü?
- `setAuth(token, user, permissions)` çağrıldı mı? (DevTools React DevTools / store inspector)

### Belirti: URL `/dashboard`, `rootText` boş, `appLayout: false`

**🎯 Bu en çok karşılaşılan blank screen pattern'ı.**

Muhtemel kök neden:
- ProtectedRoute hydration gate
- `return null` antipattern
- Token mevcutken hydration flag'in route'u bloklaması

Kontrol:
- Browser console'da `location.href === "/dashboard"` ✓
- `localStorage.getItem("netmgr-auth")` token var ✓
- AMA `document.querySelector('[data-testid="app-layout"]')` null ❌

**Bu durumda uygulama children render etmelidir.** Eğer etmiyorsa:
- `App.tsx:ProtectedRoute` token-first matris uygulanmış mı kontrol et
- Bundle'da `protected-route-loading` marker var mı? (`grep -c "protected-route-loading"`)

Beklenen App.tsx:
```tsx
if (token) return <>{children}</>             // hydrated bağımsız
if (!hydrated) return <ProtectedRouteLoading />
return <Navigate to="/login" replace />
```

Eski (problemli) pattern:
```tsx
if (!hydrated) return null    // ❌ ANTIPATTERN — blank screen üretir
return token ? children : <Navigate to="/login">
```

### Belirti: URL `/dashboard`, `appLayout: true`, `dashboardVisible: false`

Kontrol et:
- `<Outlet />` AppLayout içinde mount edildi mi
- Route nesting doğru mu (`/dashboard` parent layout route içinde mi)
- LocationGate hangi dalı render ediyor? (`.ant-spin`, `[data-testid="location-gate-error"]`, `<NoLocationAccess>`, children)
- SiteContext `ctx` undefined mi? (`features: {}` ile koşullu widget'lar gizli olabilir)
- Feature gating false mı?
- DashboardPage early return var mı?
- ErrorBoundary fallback render edildi mi? (`.ant-result-error`)

### Belirti: `/api/v1/context/current` 401

Kontrol et:
- API client interceptor `useAuthStore.getState().token` race olabilir
- Hydration tamamlanmadan query başlamış olabilir
- `enabled: !!token && hydrated` koşulu eksik mi?
- `retry: 1` + `retryDelay: 500` var mı?
- Token expire mi? (decode → `exp` claim)

### Belirti: `/` → `/welcome/` redirect

Kontrol et `frontend/nginx.conf`:
```nginx
# EĞER VARSA — KALDIR:
location = / {
    return 301 /welcome/;
}
```

Bu kural production SPA root'unda **bulunmamalı**. `/` SPA fallback'e (`try_files $uri /index.html`) düşmeli.

### Belirti: Eski bundle veya Workbox hataları

Kontrol et:
- `/sw.js` Cache-Control `no-store, no-cache, must-revalidate, max-age=0` mı? (`curl -I https://netmanager.systrack.app/sw.js`)
- Edge: `cf-cache-status: DYNAMIC` veya `BYPASS` mı?
- SW registration sayısı: `navigator.serviceWorker.getRegistrations().then(r => r.length)`
- Cache Storage: `await caches.keys()` (Workbox cache prefix'leri var mı?)
- Workbox executable kod bundle'da: `precacheAndRoute`, `NetworkFirst`, `api-cache` patterns

Eğer eski SW yapışmışsa: console'dan
```javascript
navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()))
await caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))))
location.reload()
```

### Belirti: 502 Bad Gateway

Kontrol et:
- Backend recreate zamanı (`docker compose ps backend` Up time)
- Docker health status: `docker compose ps backend --format '{{.Status}}'`
- Nginx upstream log: `docker compose logs nginx --since 5m | grep -E ' 502 '`
- Backend traceback/crash: `docker compose logs backend --since 5m | grep -iE 'ERROR|CRITICAL|Traceback'`
- Health-gated deployment uygulanmış mı? (sleep N yerine `until curl -fs /health/ready`)
- Cloudflare 5xx cache: `curl -I https://.../...` `cf-cache-status` HIT mı?

## Kesinlikle yapılmaması gerekenler

| ❌ Yapma | Sebep |
|---|---|
| API 200 diye UI'ı başarılı kabul etme | Görünür DOM testi şart; widget API'leri 200 dönerken dashboard hala blank olabilir |
| Kullanıcı görmeden deploy logunu merge etme | Manuel browser smoke PASS olmadan deploy log "success" işaretlenmez |
| `return null` ile auth/loading state saklama | DOM'a hiç element basmazsan kullanıcı blank ekran görür |
| `setTimeout(() => setHydrated(true))` kullanma | Hidrasyon gerçekleşmeden zorla true yapmak auth bypass veya yanlış login yönlendirmesi oluşturabilir |
| Token'ı doğrudan loglama | JWT/key güvenlik açığı; var/yok ve uzunluk kontrolü yeter |
| Range cherry-pick kullanma | `git cherry-pick a..b` ilgisiz commit sızdırma riski; tek SHA cherry-pick disiplin |
| Main'i doğrudan production'a merge etme | Production'a alınmaması gereken PR'lar sızabilir |
| Birden fazla bağımsız düzeltmeyi tek deploy'da karıştırma | Smoke fail olursa hangi PR'ın sorumlu olduğu belirsiz; rollback granularitesi kaybolur |
| Manual smoke olmadan memory kaydını "verified" yapma | Server smoke ≠ user-visible success |
| Başarısız deploy logunu "success" olarak bırakma | Tarihsel kayıt yanıltıcı olur; sonraki incident'ta yanlış yön gösterir |

## Zorunlu frontend deploy smoke checklist

Her frontend deploy sonrası, **kullanıcı tarafı** doğrulamadan deploy "complete" işaretlenmez:

- [ ] Yeni bundle hash yüklenmiş (HTML'de yeni `index-*.js`)
- [ ] Eski bundle HTML'de referans **edilmiyor** (eski hash artık yok)
- [ ] `/login` çalışıyor (200 + form input görünür)
- [ ] Login sonrası `/dashboard` (URL değişti)
- [ ] `appLayout: true` (`.nm-app-shell` veya `[data-testid=app-layout]`)
- [ ] `dashboardVisible: true` (`[data-testid=dashboard-page]`)
- [ ] `rootText` boş **değil** (en az 100+ karakter görünür text)
- [ ] `protectedRouteLoading: false` (kalıcı değil, transient olabilir AMA stuck değil)
- [ ] Context API 200 (`/api/v1/context/current`)
- [ ] Dashboard API'leri **başlıyor** (Network tab'da 5+ widget endpoint)
- [ ] Console critical error YOK
- [ ] Kalıcı 401/403/500/502 YOK
- [ ] Admin smoke PASS
- [ ] Org admin smoke PASS (yeni org senaryosu dahil)
- [ ] Rollback tag mevcut (`docker images netmanager-frontend | grep rollback`)

## Güvenli cherry-pick prosedürü

```bash
# 1. PR squash merge SHA al
gh pr view <PR_NUM> --json mergeCommit -q '.mergeCommit.oid'

# 2. Squash commit'in KENDİ delta'sını incele (parent delta'sına göre)
git diff --name-status <SQUASH_SHA>~1 <SQUASH_SHA>

# 3. Beklenmedik dosya var mı kontrol et
git diff --name-only <SQUASH_SHA>~1 <SQUASH_SHA> | grep -vE '^(frontend|docs)/'

# 4. Production'a alınmaması gereken commit'lerin SHA'larını grep ile assert et
for sha in 49e9ae6 31b3f2c d8af73b 3bf11f8 97de09b; do
  git log --oneline | grep -q "$sha" && echo "PROBLEM: $sha" || echo "OK: $sha YOK"
done

# 5. Cherry-pick (tek SHA, range YOK)
git cherry-pick <SQUASH_SHA>

# 6. Sonra
git log --oneline -5
git status --short
```

**❌ ASLA:**
```bash
git cherry-pick A..B          # range — ilgisiz commit sızdırma riski
git merge origin/main          # main'i direkt al — sızma kaçınılmaz
git reset --hard origin/main   # production'da yapılırsa veri kaybı
```

## Rollback prosedürü

### Acil frontend rollback

```bash
# Bilinen rollback tag (her deploy öncesi alınmış olmalı)
docker tag \
  netmanager-frontend:rollback-pre-<deploy-name>-<TS> \
  netmanager-frontend:latest

docker compose up -d --no-deps frontend

# Git rollback (anchor commit'e göre)
git reset --hard <PRE_DEPLOY_HEAD>
```

**Önemli:**
- Sabit SHA kullanmadan önce **mevcut production HEAD'i doğrula** (`git rev-parse HEAD`)
- Backend / DB / alembic / compose **DOKUNMA** (frontend-only)
- Rollback sonrası **bekle** — yeni spekülatif hotfix yazma; önce gerçek DOM + Network + router state kanıtı topla

### Tam zincir rollback referansı (2026-06-10 incident)

```bash
# PR #73 öncesi (eski PR #70 hali)
docker tag netmanager-frontend:rollback-pre-auth-guard-fix-20260610_2014 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 54ce921
```

~30 sn. Backend `0bd08b79f779` UNCHANGED, alembic `f9aeportpol` UNCHANGED.

## İlgili dokümanlar

- Incident Postmortem: [`docs/incidents/2026-06-dashboard-auth-blank-screen-postmortem.md`](../incidents/2026-06-dashboard-auth-blank-screen-postmortem.md)
- Token-first auth guard PR #73 deploy log: [`docs/AUTH_GUARD_TOKEN_FIRST_DEPLOY_LOG_2026-06-10.md`](../AUTH_GUARD_TOKEN_FIRST_DEPLOY_LOG_2026-06-10.md)
- SW Kill-Switch (PR #60): [`docs/SW_KILLSWITCH_DEPLOY_LOG_2026-06-09.md`](../SW_KILLSWITCH_DEPLOY_LOG_2026-06-09.md)
- Nginx root redirect fix (PR #64): [`docs/NGINX_ROOT_REDIRECT_FIX_DEPLOY_LOG_2026-06-10.md`](../NGINX_ROOT_REDIRECT_FIX_DEPLOY_LOG_2026-06-10.md)
