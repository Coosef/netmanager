# SW Kill-Switch / PWA Disable — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only. SW cache stale state recovery için PWA tamamen kapatıldı.
> **Mid-deploy correction:** İlk build'de VPS HEAD `47638b4` (PR 4 + #58 dahil) üzerinden alındı, PR 4 bundle'a sızdı (kural ihlali). VPS git PR 3 son commit'e reset edildi + kill-switch taze cherry-pick + rebuild yapıldı. Final image PR 4 + #58 + Sprint 2A YOK garantili.
> Backend / postgres / redis / celery / edge nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  Önceki HEAD `d8af73b` (rollback edilmiş PR 4 + #58 git'te) → **`d53e81d`** (PR 3 base + kill-switch)
- **Kapsam:** PR #60 — SW kill-switch + VitePWA disable + nginx `/sw.js` no-store
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-BGO3YPjH.js` (PR 3 + kill-switch, aynı hash — kill-switch JS bundle'a girmiyor, sadece sw.js + nginx config)
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅ (**19 deploy**)
- **Sprint 2A + PR 4 + #58** prod git ağacında YOK ✅
- **PR 1+2+3 bundle'da KORUNDU** ✅

## A-U — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #60 merge** | `718946f385730ef74dd218af8a30a0d97d257ca8` ✅ |
| Kill-switch commit (main) | `394b0b8 fix(pwa): service worker kill-switch + disable VitePWA` |
| **B. VPS HEAD** | **`d53e81d`** (PR 3 son `93d51ea` + kill-switch) |
| **C. Main HEAD (GitHub)** | `718946f` (PR 4 + hotfix + kill-switch dahil; VPS sadece kill-switch cherry-pick) |
| **D. Sprint 2A + PR 4 + #58 YOK kanıtı** | `git log \| grep '49e9ae6\|31b3f2c\|d8af73b'` → **0 satır** ✅ |
| **E. Önceki frontend image** | `5f965ddbc239` (PR 3 build, rollback hali) |
| **F. Yeni frontend image** | **`sha256:70dbf5959a699195906e1fdfe5430460d43ec4422e4efafd572233dd0d227923`** (74.4 MB) |
| **G. Rollback tag** | `netmanager-frontend:rollback-pre-sw-killswitch-20260609_2208` → `5f965ddbc239` |
| **H. Yeni JS bundle** | `/assets/index-BGO3YPjH.js` (PR 3 base aynı hash — kill-switch bundle hash'i etkilemedi) |
| **H. CSS bundle** | `/assets/index-uWsjMl-2.css` (AYNI) |
| **I. /sw.js 200** | `HTTP/1.1 200 OK` ✅ |
| **J. /sw.js Cache-Control no-store** | `Cache-Control: no-store, no-cache, must-revalidate, max-age=0` + `Pragma: no-cache` ✅ |
| **K. /sw.js kill-switch içerik** | ✅ 1490 byte, comment + install + activate event listener |
| **L. dist/sw.js patterns VAR** | skipWaiting ✅ caches.keys ✅ caches.delete ✅ registration.unregister ✅ clients.matchAll ✅ navigate ✅ |
| **M. dist/sw.js patterns YOK** | precacheAndRoute ✅ NetworkFirst ✅ NavigationRoute ✅ api-cache ✅ importScripts ✅ index.html ✅ workbox (executable) ✅ |
| **N. index.html VitePWA register YOK** | registerSW ✅ manifest.webmanifest ✅ navigator.serviceWorker ✅ workbox ✅ |
| **O. Backend image UNCHANGED** | `25fc5d7218a5` ✅ |
| **P. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **Q. Backend/alembic/compose delta** | **0/0/0** ✅ (edge nginx de UNCHANGED) |
| **R. 11/11 servis health** | ✅ |
| **S. /login** | `HTTP/1.1 200 OK` ✅ |
| **T. /audit-log** | `HTTP/1.1 200 OK` ✅ |
| **U. /health/ready** | `200 OK` — db/redis/timescaledb ok ✅ |

## sw.js response (full)

```
HTTP/1.1 200 OK
Content-Type: application/javascript
Content-Length: 1490
Cache-Control: no-store, no-cache, must-revalidate, max-age=0
Pragma: no-cache
```

İçerik: comment block + `install` event (skipWaiting) + `activate` event (3 adım: cache temizle + unregister + reload).

## PR 1+2+3 korundu kanıtı (bundle `index-BGO3YPjH.js`)

| Test-ID / i18n key | Kapsam | Durum |
|---|---|---|
| `audit-action-chip` | PR 1 | ✅ PRESENT |
| `audit-detail-drawer` | PR 2 | ✅ PRESENT |
| `audit-diff-viewer` | PR 2 | ✅ PRESENT |
| `audit-resource-link` | PR 3 | ✅ PRESENT |
| `audit.summary.login` | PR 2 i18n | ✅ PRESENT |
| `audit.resource.no_permission` | PR 3 i18n | ✅ PRESENT |

## PR #57/#58 YOK kanıtı (rollback intact)

| Test-ID / i18n key | Durum |
|---|---|
| `audit-filter-bar` | ❌ **YOK** ✅ |
| `audit-empty-state` | ❌ **YOK** ✅ |
| `audit-filter-reset` | ❌ **YOK** ✅ |
| `audit.filter.preset_1h` | ❌ **YOK** ✅ |
| `audit.empty.no_match_title` | ❌ **YOK** ✅ |
| `auditDatePresets` | ❌ **YOK** ✅ |

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 15 hours (healthy)        ← image UNCHANGED
celery_agent_worker     running   Up 15 hours (healthy)
celery_beat             running   Up 15 hours (healthy)
celery_default_worker   running   Up 15 hours (healthy)
celery_worker           running   Up 15 hours (healthy)
event_consumer          running   Up 15 hours (healthy)
flower                  running   Up 15 hours
frontend                running   Up ~10 seconds               ← RECREATED (70dbf5959a69)
nginx                   running   Up 15 hours (healthy)        ← edge UNCHANGED
postgres                running   Up 15 hours (healthy)
redis                   running   Up 15 hours (healthy)
```

**10 servis Up 15 hours**; sadece `frontend` recreate edildi (yeni image `70dbf5959a69`). **Edge nginx (host) restart edilmedi.**

## VPS git zinciri (yeni, PR 4 + #58 + Sprint 2A YOK)

```
d53e81d fix(pwa): service worker kill-switch + disable VitePWA (stale SW recovery)  ← YENİ
93d51ea feat(audit-log): resource link with route + permission gate (Audit v2 PR 3)
3c4e28f feat(audit-log): drawer + human-readable details + diff viewer (Audit v2 PR 2)
f541b9f feat(audit-log): action category + chip (Audit Log v2 PR 1)
305e4be feat(login): i18n cleanup (W1-G)
3e727e1 fix(auth): use zustand persist api for hydration
a654705 fix(auth): redirect authenticated user from /login to dashboard
d719d8a fix(pwa): cache hotfix (PR #43)
62e36d7 fix(dashboard): hotfix (PR #41)
fa56968 fix(auth): refresh hidrate guard (PR #39)
1ba5550 fix(mfa): login UI
```

## Hotfix + epik zinciri (prod ağacında aktif)

| # | Commit | PR | Kapsam |
|---|---|---|---|
| 1 | `1ba5550` | — | MFA login UI |
| 2 | `fa56968` ← `e01e37f` | #39 | Auth refresh hidrate guard |
| 3 | `62e36d7` ← `0ce1e1a` | #41 | Dashboard hotfix |
| 4 | `d719d8a` ← `55eecac` | #43 | PWA cache hotfix |
| 5 | `a654705` ← `948808e` | #45 | Login redirect hotfix |
| 6 | `3e727e1` ← `b5055c1` | #47 | Auth persist hidrasyon |
| 7 | `305e4be` ← `b66f630` | #49 | W1-G Login i18n |
| 8 | `f541b9f` ← `fba75d3` | #51 | Audit Log v2 PR 1 |
| 9 | `3c4e28f` ← `20cca8f` | #53 | Audit Log v2 PR 2 |
| 10 | `93d51ea` ← `cd9bb94` | #55 | Audit Log v2 PR 3 |
| 11 | **`d53e81d` ← `394b0b8`** | **#60** | **SW Kill-Switch + PWA Disable** ⭐ |

**PR #57/#58 git ağacında YOK** (mid-deploy reset ile temizlendi — kural intact).

## Bundle delta

| Asset | Pre-deploy | Post-deploy | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `5f965ddbc239` (PR 3) | **`70dbf5959a69`** (PR 3 + kill-switch) | ✅ |
| JS bundle | `index-BGO3YPjH.js` | `index-BGO3YPjH.js` (AYNI) | ❌ (kill-switch JS'e girmiyor) |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ AYNI |
| **sw.js** | Eski Workbox precache (920 byte) | **Kill-switch (1490 byte)** | ✅ |
| **sw.js Cache-Control** | `max-age=31536000, immutable` ❌ | **`no-store, no-cache, max-age=0`** ✅ | ✅ |
| **index.html VitePWA register** | Vardı | YOK | ✅ |
| **dist/manifest.webmanifest** | Vardı | YOK | ✅ |

## Mid-deploy düzeltme detayı

**Sorun:** İlk cherry-pick `47638b4` (PR 4 + #58 + kill-switch zinciri) üzerinden yapıldı. Yeni build PR 4 koduyla geldi — bundle'da `audit-filter-bar` PRESENT.

**Kullanıcı kuralı ihlali:** "PR #57/#58 production'da rollback edilmiş durumda kalacak" + "Audit Log PR4 yeniden deploy yok."

**Düzeltme:**
1. `git reset --hard 93d51ea` (PR 3 son commit)
2. `git cherry-pick 394b0b8` (kill-switch — main'den taze)
3. Yeni HEAD: `d53e81d`
4. `docker compose build frontend` (yeni image `70dbf5959a69`)
5. `docker compose up -d --no-deps frontend`
6. Doğrulama: PR 4 testid'leri bundle'da YOK ✅

**Sonuç:** Kural intact, kill-switch aktif, PR 4/Sprint 2A bypass tam.

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `93d51ea` (PR 3 son commit, rollback hali) |
| alembic | `f9aeportpol` |
| Frontend image | `5f965ddbc239` → tag `netmanager-frontend:rollback-pre-sw-killswitch-20260609_2208` |

### Rollback komutu

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-sw-killswitch-20260609_2208 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 93d51ea
```

**Rollback önemli not:** Kill-switch bir kez activate olduktan sonra cache temizlemiş + unregister etmiş kullanıcılar zaten temiz state'te. Rollback bu kullanıcılara zarar VERMEZ — sadece henüz recovery olmayan kullanıcılarda eski siyah ekran döner.

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend image build/deploy | ✅ |
| 2-6. Backend / DB / migration / restart / compose yok | ✅ |
| 7. Sprint 2A YOK | ✅ |
| 8. Audit Log PR4 yeniden deploy YOK | ✅ (mid-deploy reset ile garantili) |
| 9. Dashboard refresh/auth backlog'una dokunulmadı | ✅ |
| 10. SSH Termination KAPALI | ✅ |
| 11. Audit Log PR 1/2/3 korundu | ✅ (bundle'da testid'ler PRESENT) |
| 12. W1-G Login i18n korundu | ✅ |
| 13. Auth hotfix zinciri korundu | ✅ |
| 14. PR #57/#58 production'da YOK | ✅ |

## Kullanıcıdan beklenen manuel smoke (10 senaryo)

1. **Normal Chrome profilinde siteyi aç**
2. Gerekirse 1 kez refresh yap
3. **Login ekranı gelmeli**
4. Login sonrası uygulama ekranı gelmeli
5. **Application → Service Workers altında eski SW unregister olmuş** ya da kontrolü bırakmış olmalı
6. Console'da eski Workbox / precache / non-precached-url hatası kalmamalı
7. Gizli sekme hâlâ çalışmalı
8. **/audit-log PR 1/2/3 davranışları korunmalı** (action chip + drawer + diff + resource link)
9. Backend 11/11 healthy olmalı (zaten doğrulandı)
10. Network 401/403/500 olmamalı

## Otomatik recovery mekanizması

1. Kullanıcı normal profilinde siteye girer
2. Browser eski sw.js cache'ini kontrol eder
   - `updateViaCache: 'imports'` default → sw.js HTTP cache baypaslanır
   - Nginx Cache-Control `no-store` → cache yok, fresh fetch garantili
3. Yeni sw.js (kill-switch, 1490 byte) byte-by-byte eski sw.js'ten (920 byte) FARKLI → install
4. `skipWaiting()` → hemen activate
5. Activate event 3 adım:
   - `caches.keys()` + `caches.delete()` — eski workbox-precache-* dahil tüm cache silinir
   - `self.registration.unregister()` — SW kendini siler
   - `clients.matchAll()` + `client.navigate(client.url)` — açık tablar reload
6. Reload sonrası: index.html'de SW register script YOK + manifest YOK → SW asla yüklenmez → temiz state → React mount → uygulama açılır
7. **Kullanıcı müdahalesi YOK**

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke — kullanıcı doğrular (normal Chrome profil) |
| 2 | SW kill-switch kapanış memory entry |
| 3 | 24-48 saat recovery oranı gözlem |
| 4 | Audit Log v2 PR 4 yeniden deploy (recovery tamamlandıktan sonra) |
| 5 | Sprint 2A yeniden deploy (PR 4 sonrası) |
