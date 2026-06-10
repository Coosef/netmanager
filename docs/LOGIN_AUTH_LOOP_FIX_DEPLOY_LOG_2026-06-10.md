# P0 Login Auth Loop Fix — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only RootRedirect + /dashboard explicit route fix. Login sonrası `/` route'u page-reload döngüsünü çözüyor.
> Backend / postgres / redis / celery / edge nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
- **Önceki HEAD** `9acae4c` (PR #66 backend Windows installer fix) → cherry-pick PR #68 → **`3256a20`**
- **Kapsam:** PR #68 — RootRedirect component + /dashboard explicit route + Login redirect target /dashboard + Sidebar/TopNav brand /dashboard
- **Backend image:** `0bd08b79f779` UNCHANGED ✅
- **Frontend image:** `2d5e1b76d2c6` → **`0967ee30939b`**
- **Alembic:** `f9aeportpol` UNCHANGED ✅
- **PR #57/#58 + PR #62 + Sprint 2A + Audit PR4 + Agent UI PR #67** prod ağacında YOK ✅

## A-R — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #68 merge** | `15208c9359f463107639be4ac061b2f6b2f4ec32` ✅ (kod `e1c4692`) |
| **B. VPS HEAD** | **`3256a20`** (PR 3 + SW Kill-Switch + nginx root redirect + Login auth loop fix) |
| **C. Main HEAD (GitHub)** | `15208c9` (PR #68 merged) |
| **D. Sadece PR #68 alındı** | ✅ `git diff 9acae4c..HEAD --name-only -- frontend/` = 7 dosya (RootRedirect.tsx + 2 test + App.tsx + Login + Sidebar + TopNav) |
| **E. PR #62 YOK** | ✅ `git log \| grep '3bf11f8\|97de09b'` → 0 |
| **F. Sprint2A/PR4/PR57/58 YOK** | ✅ `git log \| grep '49e9ae6\|31b3f2c\|d8af73b'` → 0 |
| **G. Agent UI PR #67 YOK** | ✅ `git diff 9acae4c..HEAD --name-only -- frontend/src/pages/Agents/` = 0 dosya |
| **H. Önceki frontend image** | `2d5e1b76d2c6` (PR #64 nginx root redirect fix image) |
| **I. Yeni frontend image** | **`sha256:0967ee30939b25570b00925ea5c1779d1ff8cd4def91d839198b6ce56b634b31`** |
| **J. Frontend rollback tag** | `netmanager-frontend:rollback-pre-login-auth-loop-fix-20260610_1447` → `2d5e1b76d2c6` |
| **K. Backend UNCHANGED** | `0bd08b79f779` ✅ |
| **L. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **M. 11/11 health** | ✅ |
| **N. SPA routes smoke** | ✅ Tümü 200 (`/`, `/login`, `/dashboard`, `/audit-log`, `/welcome/`, `/devices`) |
| **O. /sw.js kill-switch** | ✅ no-store + 3 kill-switch pattern; Edge: DYNAMIC + no-store |
| **P. Nginx log infinite loop kesildi mi** | ✅ Son 5 dk Mac/Chrome GET / = **4** (önceki "1 sn'de 6" döngüsü artık YOK) |
| **Q. Deploy log PR** | bu dosya (`docs/LOGIN_AUTH_LOOP_FIX_DEPLOY_LOG_2026-06-10.md`) — ayrı PR olarak açıldı |
| **R. Kullanıcı manuel smoke hazır mı** | ✅ Tüm server doğrulamalar PASS, kullanıcı browser testi için hazır |

## Edge (Cloudflare) doğrulama özeti

```
GET https://netmanager.systrack.app/
→ HTTP/2 200 + cache-control: no-store + cf-cache-status: DYNAMIC

GET https://netmanager.systrack.app/login
→ HTTP/2 200 + no-store + DYNAMIC

GET https://netmanager.systrack.app/dashboard
→ HTTP/2 200 + no-store + DYNAMIC  ← YENİ ROUTE

GET https://netmanager.systrack.app/welcome/
→ HTTP/2 200 + no-store + DYNAMIC (PR #64 ile korundu)

GET https://netmanager.systrack.app/sw.js
→ HTTP/2 200 + no-store + max-age=0 + DYNAMIC (Cloudflare Faz 0 korundu)

HSTS: max-age=63072000; includeSubDomains; preload (2 yıl + preload korundu)
```

## Bundle değişikliği

- Önceki bundle hash: `index-BGO3YPjH.js` (PR #64 sonrası)
- Yeni bundle hash: **`index-BnB7L82L.js`**
- CSS: `index-uWsjMl-2.css` aynı (CSS değişmedi)
- RootRedirect kod aktif: bundle'da `root-redirect-loading` + `/dashboard` replace pattern match ✅

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up About an hour (healthy)   ← UNCHANGED (0bd08b79f779)
celery_agent_worker     running   Up 32 hours (healthy)
celery_beat             running   Up 32 hours (healthy)
celery_default_worker   running   Up 32 hours (healthy)
celery_worker           running   Up 32 hours (healthy)
event_consumer          running   Up 32 hours (healthy)
flower                  running   Up 32 hours
frontend                running   Up 43 seconds                ← RECREATED (0967ee30939b)
nginx                   running   Up 32 hours (healthy)        ← edge UNCHANGED
postgres                running   Up 32 hours (healthy)
redis                   running   Up 32 hours (healthy)
```

**10 servis UNCHANGED**; sadece `frontend` recreate. **Edge nginx (host) DOKUNULMADI**.

## VPS git zinciri (yeni)

```
3256a20 fix(routing): P0 login auth loop — RootRedirect + /dashboard explicit route  ← YENİ
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
| 13 | `9acae4c` | #66 | Windows installer PS 5.1 compat (backend, image `0bd08b79f779`) |
| 14 | **`3256a20`** | **#68** | **P0 Login Auth Loop Fix (RootRedirect + /dashboard)** ⭐ |

**Sprint 2A + PR 4 + PR #58 + PR #57 + PR #62 + Agent UI PR #67 ağaçta YOK** ✅

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend image build/deploy | ✅ |
| 2-7. Backend/DB/migration/restart/compose/edge_nginx yok | ✅ |
| 8. PR #62 redeploy YOK | ✅ |
| 9. PR #63 işlem YOK | ✅ |
| 10. Sprint 2A YOK | ✅ |
| 11. Audit Log PR4 YOK | ✅ |
| 12. PR #57/#58 prod'a alınmadı | ✅ |
| 13. Agent UI PR #67 dahil edilmedi | ✅ (agents_ui delta 0) |
| 14. SW Kill-Switch korundu | ✅ (no-store + 3 pattern + DYNAMIC) |
| 15. Nginx Root Redirect Fix korundu | ✅ (`/` → SPA index.html) |
| 16. /welcome/ direkt erişilebilir | ✅ (200 OK) |
| 17. Backend Windows installer PR #66 korundu | ✅ (image `0bd08b79f779`) |
| 18. SSH Termination KAPALI | ✅ |

## Davranış değişiklikleri (UI/UX)

### Önceki davranış (loop tetikleyici)
- `/` → React Router index route → DashboardPage doğrudan render
- Login success → `setAuth` + `setTimeout(navigate('/'), 800)` + useEffect `navigate('/', replace)`
- Sidebar/TopNav brand click → `navigate('/')`
- **Sonuç:** login akışı `/` route'unu sürekli yeniden tetikliyor → page-reload döngüsü

### Yeni davranış (PR #68 sonrası)
- `/` → **RootRedirect** component (auth+hidrasyona göre güvenli redirect)
  - !hydrated → minimal `<Spin>` (blank screen YOK)
  - hydrated + token → `<Navigate to="/dashboard" replace />`
  - hydrated + !token → `<Navigate to="/login" replace />`
- `/dashboard` → AppLayout + DashboardPage (yeni explicit route)
- Login success → `navigate('/dashboard', { replace: true })` (her iki yerde: useEffect + setTimeout)
- Sidebar/TopNav brand click → `navigate('/dashboard')`
- **Sonuç:** `/` üzerinden geçen yol kalmadı → page-reload riski YOK

## Kullanıcıdan beklenen manuel smoke (11 senaryo)

1. Normal Chrome / gizli sekme `/login` aç → login ekranı
2. Admin login → **/dashboard direkt gelir**, siyah ekran YOK, infinite döngü YOK
3. Çıkış yap
4. Coosef login → /dashboard veya yetkili default ekran; "Unassigned — atg-hotels" location selector'da
5. `/` authenticated → `/dashboard` (RootRedirect)
6. `/` unauthenticated → `/login` (RootRedirect)
7. `/dashboard` unauthenticated → `/login` (ProtectedRoute)
8. `/welcome/` direkt → tanıtım sayfası
9. Console critical error YOK
10. Network 500/502 YOK
11. Nginx log'da infinite GET / döngüsü YOK (önceki 1 sn 6 istek → şu an 5 dk 4 istek)

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `9acae4c` (PR #66 backend installer fix hali, login auth loop fix ÖNCESİ) |
| alembic | `f9aeportpol` |
| Frontend image | `2d5e1b76d2c6` → tag `netmanager-frontend:rollback-pre-login-auth-loop-fix-20260610_1447` |
| Backend image | `0bd08b79f779` (UNCHANGED) |

### Rollback komutu

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-login-auth-loop-fix-20260610_1447 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 9acae4c
```

~30 sn. Backend `0bd08b79f779` UNCHANGED, alembic `f9aeportpol` UNCHANGED.

**Rollback notu:** Eski `<Route index element={<DashboardPage />}>` + `navigate('/')` çağrıları geri gelir → login akışı `/` üzerinden geçer → page-reload döngüsü tekrar tetiklenebilir.

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | **Manuel browser smoke** (admin + coosef + /welcome direkt) — kullanıcı |
| 2 | Smoke PASS olursa → Agent UI PR #67 yeniden gündeme alınabilir (ayrı frontend deploy) |
| 3 | LocationGate / SiteContext eğer hâlâ sorun varsa ayrı RCA |
| 4 | PR #62 controlled redeploy (ayrı maintenance window, planı dosyada) |
