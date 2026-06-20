# PWA-CACHE-HOTFIX — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only, cherry-pick stratejisi devam (Sprint 2A YOK).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `62e36d7` (Dashboard hotfix) → **`d719d8a`** (PWA cache hotfix cherry-pick)
- **Kapsam:** PR #43 — workbox config: navigateFallback null + runtimeCaching boş + HTML precache dışı
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend src/**: KOD DEĞİŞİMİ YOK (sadece build config)
- **JS bundle:** `index-DniO4XgC.js` **AYNI** (src değişmedi)
- **sw.js:** Yeni hash `ad769e6f5c2f` ✅ (NavigationRoute + api-cache YOK)
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅
- **Sprint 2A kodu prod'a girmedi** ✅ (cherry-pick bypass devam)

## A-S — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #43 merge** | `06834ee13bd9f485d58f789a3e759a5dbc53ff0d` ✅ |
| PWA hotfix commit (main) | `55eecac fix(pwa): disable navigation fallback + api runtime cache` |
| **B. VPS HEAD** | **`d719d8a`** (cherry-pick'lenmiş PWA hotfix) |
| **C. Main HEAD (GitHub)** | `06834ee` (merge commit, içinde Sprint 2A `49e9ae6` mevcut — VPS'e cherry-pick ile sadece PWA hotfix) |
| **D. Sprint 2A prod ağacında YOK kanıtı** | `git log \| grep '49e9ae6'` → **0 satır** ✅ |
| **E. Önceki frontend image** | `d5b38f28d7e6` (Dashboard hotfix build) |
| **F. Yeni frontend image** | **`sha256:5bbce9c87477b6206bcdc7d8ed1f8a6e3b5c1b8c77d8d8b9bc11d55c5b04c41a`** (74.4 MB) |
| **G. Rollback tag** | `netmanager-frontend:rollback-pre-pwa-cache-hotfix-20260609_1132` → `d5b38f28d7e6` |
| **H. JS bundle** | `index-DniO4XgC.js` **AYNI** (src/ kod değişmedi) |
| **H. CSS bundle** | `index-uWsjMl-2.css` **AYNI** |
| **I. Yeni sw.js sha-12** | **`ad769e6f5c2f`** ✅ (değişti) |
| **J. sw.js api-cache YOK** | ✅ (önceki: VAR) |
| **K. sw.js NetworkFirst YOK** | ✅ (önceki: VAR) |
| **L. sw.js NavigationRoute YOK** | ✅ (önceki: VAR) |
| **M. sw.js index.html precache YOK** | ✅ (önceki: navigateFallback ile index.html) |
| **cleanupOutdatedCaches AKTİF** | ✅ |
| **N. Backend image UNCHANGED** | `25fc5d7218a5` ✅ |
| **O. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **P. Backend/alembic/compose delta** | **0/0/0** + i18n **0** ✅ |
| **Q. 11/11 servis health** | ✅ |
| **R. /login** | `HTTP/1.1 200 OK` ✅ |
| **S. /health/ready** | `200 OK` — db/redis/timescaledb ok ✅ |

## Yeni sw.js içeriği (özet)

```js
define(["./workbox-<hash>"], function(e) {
  "use strict";
  self.skipWaiting();
  e.clientsClaim();
  e.precacheAndRoute([
    { url:"icon-192.svg",      revision:"217e1e4314ce34573c52bb9d0516d910" },
    { url:"icon-512.svg",      revision:"08a732cd854a939fb134f5e9a56c0a60" },
    { url:"manifest.webmanifest", revision:"643bc04582c940e38892ac4ce80d2540" }
  ]);
  e.cleanupOutdatedCaches();
  // NavigationRoute YOK
  // registerRoute /^\/api\// YOK
  // NetworkFirst YOK
  // api-cache YOK
});
```

**Önceki sw.js'e karşı çıkanlar:**
- ❌ `e.registerRoute(new e.NavigationRoute(e.createHandlerBoundToURL("index.html")))` KALDIRILDI
- ❌ `e.registerRoute(/^\/api\//, new e.NetworkFirst({cacheName:"api-cache",...}))` KALDIRILDI

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 4 hours (healthy)        ← image UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 4 hours (healthy)        ← UNCHANGED
celery_beat             running   Up 4 hours (healthy)        ← UNCHANGED
celery_default_worker   running   Up 4 hours (healthy)        ← UNCHANGED
celery_worker           running   Up 4 hours (healthy)        ← UNCHANGED
event_consumer          running   Up 4 hours (healthy)        ← UNCHANGED
flower                  running   Up 4 hours                  ← UNCHANGED
frontend                running   Up 45 seconds               ← RECREATED (5bbce9c87477)
nginx                   running   Up 4 hours (healthy)        ← UNCHANGED
postgres                running   Up 4 hours (healthy)        ← UNCHANGED
redis                   running   Up 4 hours (healthy)        ← UNCHANGED
```

**10 servis Up 4 hours**; sadece `frontend` recreate edildi (`--no-deps`).

## Sprint 2A bypass kanıtı (devam)

```
VPS git log son 4:
d719d8a fix(pwa): disable navigation fallback + api runtime cache       ← YENİ
62e36d7 fix(dashboard): selector consistency + WS guard + 401 debounce
fa56968 fix(auth): wait for persisted auth hydration before route redirect
1ba5550 fix(login): prevent MFA OTP grid overflow on challenge step

VPS git log | grep '49e9ae6' → 0  (Sprint 2A YOK) ✅
```

## Faz çıktıları

### P0 — Anchor
- git HEAD: `62e36d7` (Dashboard hotfix)
- alembic: `f9aeportpol`
- Frontend image: `d5b38f28d7e6`
- Backend: `25fc5d7218a5` UNCHANGED
- Bundle (önceki): `index-DniO4XgC.js` + `index-uWsjMl-2.css`
- **Pre-deploy sw.js NavigationRoute+NetworkFirst+api-cache HÂLÂ AKTİF** ⚠ (bu yüzden PR #41 fix kullanıcı tarayıcısında çalışmıyordu)
- **Rollback tag:** `netmanager-frontend:rollback-pre-pwa-cache-hotfix-20260609_1132` ✅

### P1 — git fetch + cherry-pick
```
fetch:           a67a98a..06834ee (PR #43 merge)
cherry-pick:     55eecac (PWA cache hotfix)
backend delta:   0 ✅
alembic delta:   0 ✅
compose delta:   0 ✅
i18n delta:      0 ✅
frontend delta:  1 dosya (vite.config.ts)
new HEAD:        d719d8a (cherry-pick commit)
Sprint 2A 49e9ae6 prod ağacında: YOK ✅
```

### P2 — Build
```
docker compose build frontend
yeni image: 5bbce9c87477 (74.4 MB)
sha256: 5bbce9c87477b6206bcdc7d8ed1f8a6e3b5c1b8c77d8d8b9bc11d55c5b04c41a
```

### P3 — Recreate (`--no-deps`)
```
docker compose up -d --no-deps frontend
→ frontend Up 8 sn
→ backend image UNCHANGED
→ Diğer 9 servis UNCHANGED
```

### P4 — Smoke
- `/health/ready` 200 ✅
- `/login` 200, `/devices` 200 ✅
- Bundle: `index-DniO4XgC.js` AYNI (vite.config sadece build config, src değişmedi)
- **sw.js sha-12: ad769e6f5c2f** (YENİ)

### P4.A — sw.js artifact doğrulama (per kullanıcı isteği)

| Kontrol | Sonuç |
|---|---|
| **J. api-cache YOK** | ✅ |
| **K. NetworkFirst YOK** | ✅ |
| **L. NavigationRoute YOK** | ✅ |
| **M. index.html precache'te YOK** | ✅ |
| cleanupOutdatedCaches AKTİF | ✅ |
| precache yalnız 3 entry (icon × 2 + manifest) | ✅ |

### P5 — Backend untouched assert
| Kriter | Durum |
|---|---|
| Image ID `25fc5d7218a5` AYNI | ✅ |
| Container running healthy | ✅ |
| Backend delta 0 | ✅ |
| Postgres/Redis/Celery/Nginx 4+ saat uptime | ✅ |
| Sprint 2A kodu prod'a INMEDI | ✅ |

---

## Bundle delta

| Asset | Dashboard hotfix (önce) | PWA hotfix (sonra) | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `d5b38f28d7e6` | **`5bbce9c87477`** | ✅ (sw.js + workbox changed) |
| JS bundle | `index-DniO4XgC.js` | `index-DniO4XgC.js` | ❌ AYNI (src kod değişmedi) |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ AYNI |
| **sw.js** | NavigationRoute+api-cache **VAR** | NavigationRoute+api-cache **YOK** ✅ | ✅ Yeni hash |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `62e36d7` (Dashboard hotfix) |
| alembic | `f9aeportpol` |
| Frontend image | `d5b38f28d7e6` → tag `netmanager-frontend:rollback-pre-pwa-cache-hotfix-20260609_1132` |

### Rollback komutu (gerekirse)
```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-pwa-cache-hotfix-20260609_1132 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 62e36d7
# ~30-60 sn; backend / db / cache dokunulmaz
```

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build/deploy | ✅ |
| 2-7. Backend / DB / migration / restart / compose / i18n yok | ✅ |
| 8. Sprint 2A prod'a alınmadı | ✅ git log grep '49e9ae6' = 0 |
| 9. Cherry-pick stratejisi | ✅ |
| 10-12. PR #38 / #40 / #42 merge edilmedi | ✅ |
| 13. SSH Termination KAPALI | ✅ |

## Kullanıcıdan beklenen manuel smoke

**ÖNEMLİ:** Eski SW tarayıcıda **kalmış olabilir**. Yeni davranış için:

1. **Hard refresh:** Cmd+Shift+R (Mac) veya Ctrl+F5 (Win)
2. **Veya** DevTools → Application → Service Workers → **Update** veya **Unregister**
3. **Veya** Application → Storage → **Clear site data** → reload

Sonra test:

1. Admin login → Dashboard açılmalı
2. **Dashboard F5 × 5 → logout olmamalı** ⭐ (kritik kanıt)
3. /devices F5 × 5 → regresyon yok
4. Console runtime error yok
5. Network 401/403/500 yok

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke (Cmd+Shift+R sonrası F5 × 5) — kullanıcı doğrular |
| 2 | Tüm hotfix serisi (PR #39 + #41 + #43) için tek birleşik kapanış memory entry — smoke 5/5 PASS sonrası |
| 3 | Sprint 2A PR #37 / PR #38 / PR #40 / PR #42 için karar |
| 4 | Sıradaki backlog (Sprint 2 P1 — Patch Panel + LLDP Cabling, vb.) |
