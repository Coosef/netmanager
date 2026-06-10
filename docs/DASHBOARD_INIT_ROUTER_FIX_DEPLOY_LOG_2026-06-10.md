# P0 Dashboard Init / Router State Fix — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only SiteContext hydrated guard + Login setTimeout race fix.
> Backend / postgres / redis / celery / edge nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
- **Önceki HEAD** `3256a20` (PR #68 login auth loop fix) → cherry-pick `958ca70` → **`54ce921`**
- **Kapsam:** PR #70 — Login `setTimeout(navigate, 800)` kaldırıldı + SiteContext `useHasHydrated` guard + `retry: 1` + `retryDelay: 500`
- **Backend image:** `0bd08b79f779` UNCHANGED ✅
- **Frontend image:** `0967ee30939b` → **`e93b6707fb77`**
- **Alembic:** `f9aeportpol` UNCHANGED ✅
- **PR #57/#58 + PR #62 + Sprint 2A + Audit PR4 + Agent UI PR #67** prod ağacında YOK ✅

## A-T — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #70 merge** | `c0edd3d1aba0325a5b7618d6a9b0bd1827b6fef3` ✅ (kod `958ca70`) |
| **B. VPS HEAD** | **`54ce921`** (PR 3 + SW + nginx root + Login loop + Dashboard init) |
| **C. Main HEAD (GitHub)** | `c0edd3d` (PR #70 merged) |
| **D. Sadece PR #70 alındı** | ✅ `git diff 3256a20..HEAD --name-only -- frontend/` = 4 dosya (Login + SiteContext + 2 test) |
| **E. PR #62 YOK** | ✅ `git log \| grep '3bf11f8\|97de09b'` → 0 |
| **F. Sprint2A/PR4/PR57/58 YOK** | ✅ `git log \| grep '49e9ae6\|31b3f2c\|d8af73b'` → 0 |
| **G. Agent UI PR #67 YOK** | ✅ `git diff 3256a20..HEAD --name-only -- frontend/src/pages/Agents/` = 0 dosya |
| **H. Önceki frontend image** | `0967ee30939b` (PR #68 login auth loop fix image) |
| **I. Yeni frontend image** | **`sha256:e93b6707fb771d85e883645c35335a102ba720de2cb6a02f980926993b2e4a5d`** |
| **J. Frontend rollback tag** | `netmanager-frontend:rollback-pre-dashboard-init-fix-20260610_1605` → `0967ee30939b` |
| **K. Backend UNCHANGED** | `0bd08b79f779` ✅ |
| **L. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **M. 11/11 health** | ✅ |
| **N. SPA routes smoke** | ✅ `/`, `/login`, `/dashboard`, `/audit-log`, `/welcome/`, `/devices` hepsi 200 |
| **O. /sw.js kill-switch** | ✅ Origin: no-store + 3 kill-switch pattern; Edge: DYNAMIC + no-store + max-age=0 |
| **P. Dashboard widget API çağrıları** | ✅ **AKTİF** (son 5 dk: monitor/stats=20, sla=5, services/impact=6, intel/risk=4, anomalies=6, context=7) |
| **Q. İlk context/current 401 retry/recovery** | ✅ **401 YOK** (son 5 dk: 7 istek, hepsi 200) — hydrated guard + retry sayesinde transient 401 çıkmadı |
| **R. Infinite GET / loop kesildi mi** | ✅ Son 5 dk Mac/Chrome GET / = **2** (normal navigation) |
| **S. Deploy log PR** | bu dosya (`docs/DASHBOARD_INIT_ROUTER_FIX_DEPLOY_LOG_2026-06-10.md`) — ayrı PR olarak açıldı |
| **T. Kullanıcı manuel smoke hazır mı** | ✅ Tüm server doğrulamalar PASS, kullanıcı browser testi için hazır |

## Edge (Cloudflare) doğrulama özeti

```
GET https://netmanager.systrack.app/             → HTTP/2 200 + DYNAMIC + no-store
GET https://netmanager.systrack.app/login        → HTTP/2 200 + DYNAMIC + no-store
GET https://netmanager.systrack.app/dashboard    → HTTP/2 200 + DYNAMIC + no-store
GET https://netmanager.systrack.app/welcome/     → HTTP/2 200 + DYNAMIC + no-store
GET https://netmanager.systrack.app/sw.js        → HTTP/2 200 + DYNAMIC + no-store + max-age=0
GET https://netmanager.systrack.app/assets/index-G4h5JIeT.js  → HTTP/2 200 + MISS

HSTS: max-age=63072000; includeSubDomains; preload (2 yıl + preload korundu)
```

## Bundle değişikliği

- Önceki bundle hash: `index-BnB7L82L.js` (PR #68)
- Yeni bundle hash: **`index-G4h5JIeT.js`**
- CSS: `index-uWsjMl-2.css` aynı (CSS değişmedi)
- **DASHBOARD-INIT-FIX bundle aktif kanıtı:** `retryDelay` + `useHasHydrated` 2 match ✅

## Dashboard widget API forensic (Q+P)

Son 5 dakika nginx log:

| Endpoint | Çağrı sayısı | Durum |
|---|---:|---|
| `/api/v1/context/current` | **7** | **Hepsi 200** ⭐ (401 YOK — hydrated guard çalışıyor) |
| `/api/v1/monitor/stats` | 20 | aktif |
| `/api/v1/services/fleet/impact-summary` | 6 | aktif |
| `/api/v1/sla/fleet-summary` | 5 | aktif |
| `/api/v1/intelligence/fleet/risk` | 4 | aktif |
| `/api/v1/intelligence/anomalies` | 6 | aktif |
| Mac/Chrome `GET /` | 2 | **döngü YOK** |

**Yorum:** Dashboard widget API'leri **GERÇEKTE ÇAĞRILIYOR** — Dashboard mount oluyor ve render ediliyor. Önceki "ctx undefined → widget'lar render edemiyor" durumu çözüldü.

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 2 hours (healthy)         ← UNCHANGED (0bd08b79f779)
celery_agent_worker     running   Up 33 hours (healthy)
celery_beat             running   Up 33 hours (healthy)
celery_default_worker   running   Up 33 hours (healthy)
celery_worker           running   Up 33 hours (healthy)
event_consumer          running   Up 33 hours (healthy)
flower                  running   Up 33 hours
frontend                running   Up 32 seconds                ← RECREATED (e93b6707fb77)
nginx                   running   Up 33 hours (healthy)        ← edge UNCHANGED
postgres                running   Up 33 hours (healthy)
redis                   running   Up 33 hours (healthy)
```

**10 servis UNCHANGED**; sadece `frontend` recreate.

## VPS git zinciri (yeni)

```
54ce921 fix(dashboard-init): P0 — SiteContext hydrated guard + Login setTimeout race  ← YENİ
3256a20 fix(routing): P0 login auth loop — RootRedirect + /dashboard explicit route
9acae4c fix(agents): Windows installer PowerShell 5.1 compatibility
d054b0a fix(nginx): remove root → /welcome/ redirect (P0 blank screen)
d53e81d fix(pwa): service worker kill-switch + disable VitePWA
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
| 1-10 | önceki zinciri | #39-#55 | MFA + auth + W1-G + Audit Log v2 PR 1+2+3 |
| 11 | `d53e81d` | #60 | SW Kill-Switch + PWA Disable |
| 12 | `d054b0a` | #64 | P0 Frontend Nginx Root Redirect Fix |
| 13 | `9acae4c` | #66 | Windows installer PS 5.1 compat (backend) |
| 14 | `3256a20` | #68 | P0 Login Auth Loop Fix (RootRedirect + /dashboard) |
| 15 | **`54ce921`** | **#70** | **P0 Dashboard Init / Router State Fix** ⭐ |

**Sprint 2A + PR 4 + PR #58 + PR #57 + PR #62 + Agent UI PR #67 ağaçta YOK** ✅

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend image build/deploy | ✅ |
| 2-7. Backend/DB/migration/restart/compose/edge_nginx yok | ✅ |
| 8-11. PR #62 / #63 / Sprint 2A / Audit PR4 YOK | ✅ |
| 12. PR #57/#58 prod'a alınmadı | ✅ |
| 13. **Agent UI PR #67 dahil edilmedi** | ✅ (agents_ui delta 0) |
| 14. SW Kill-Switch korundu | ✅ |
| 15. Nginx Root Redirect Fix korundu | ✅ |
| 16. **Login Auth Loop Fix PR #68 korundu** | ✅ |
| 17. Backend Windows installer PR #66 korundu | ✅ (`0bd08b79f779`) |
| 18. /welcome/ direkt erişilebilir | ✅ |
| 19. SSH Termination KAPALI | ✅ |

## Davranış değişiklikleri (UI/UX)

### Önceki davranış (race kaynakları)
- `Login/index.tsx:856` — `setTimeout(navigate('/dashboard'), 800)` cleanup yok → ghost timer fire
- `SiteContext.tsx:106-111` — `enabled: !!token` → hidrasyon penceresinde 401 race
- staleTime: 60_000 + retry yok → ilk fail sonsuz stuck

### Yeni davranış (PR #70 sonrası)
- Login `setTimeout(navigate, 800)` **KALDIRILDI** — useEffect ZATEN navigate yapıyor, redündan
- `SiteContext useQuery` artık `enabled: !!token && hydrated` — hidrasyon tamamlanmadan fetch yok
- `retry: 1` + `retryDelay: 500` — transient 401 olursa 500ms sonra otomatik retry → recovery

## Kullanıcıdan beklenen manuel smoke (11 senaryo)

1. Normal Chrome tamamen kapatıp yeniden aç
2. Gizli sekmede `/login` aç
3. Admin login → **/dashboard + widget'lar görünür**, siyah ekran YOK
4. Çıkış yap
5. Coosef login → /dashboard veya yetkili default ekran; "Unassigned — atg-hotels" location selector'da
6. `/` authenticated → `/dashboard`
7. `/` unauthenticated → `/login`
8. `/welcome/` direkt → tanıtım sayfası
9. Console critical error YOK
10. Network 401 recovery dışında kalıcı 401/403/500/502 YOK
11. Dashboard API'leri gerçekten çağrılmalı (monitor/stats, sla, intel)

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `3256a20` (PR #68 hali, Dashboard init fix ÖNCESİ) |
| alembic | `f9aeportpol` |
| Frontend image | `0967ee30939b` → tag `netmanager-frontend:rollback-pre-dashboard-init-fix-20260610_1605` |
| Backend image | `0bd08b79f779` (UNCHANGED) |

### Rollback komutu

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-dashboard-init-fix-20260610_1605 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 3256a20
```

~30 sn. Backend `0bd08b79f779` UNCHANGED, alembic UNCHANGED.

**Rollback notu:** Eski setTimeout + SiteContext race geri gelir → Dashboard init bug tekrar olabilir.

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | **Manuel browser smoke** (admin + coosef + /welcome direkt + widget'lar görünür) — kullanıcı |
| 2 | Smoke PASS olursa: PR #69 + PR #71 (bu deploy log) birlikte merge |
| 3 | Memory entry: dashboard-refresh-auth-backlog "RESOLVED by PR #64 + PR #68 + PR #70" güncellemesi |
| 4 | Agent UI PR #67 yeniden gündeme alınabilir |
| 5 | PR #62 controlled redeploy (ayrı maintenance window) |
