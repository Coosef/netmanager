# P0 Frontend Nginx Root Redirect Fix — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only nginx config fix. Dashboard refresh/auth backlog'unun asıl kök neden çözümü.
> Backend / postgres / redis / celery / edge nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  Önceki HEAD `3bf11f8` (PR #62 git'te, rollback hali çalışıyor) → reset to `d53e81d` (SW Kill-Switch hali) → cherry-pick PR #64 → **`d054b0a`**
- **Kapsam:** PR #64 — `frontend/nginx.conf` `location = /` redirect kaldırıldı
- **Backend image:** `25fc5d7218a5` UNCHANGED ✅
- **Frontend image:** `70dbf5959a69` → **`2d5e1b76d2c6`**
- **Alembic:** `f9aeportpol` UNCHANGED ✅
- **PR #57/#58 + PR #62 + Sprint 2A** prod git ağacında YOK ✅ (mid-deploy reset ile garantili)
- **SW Kill-Switch + Audit Log v2 PR 1+2+3 + Cloudflare Faz 0 + HSTS** korundu ✅

## A-X — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #64 merge** | `c726685341e0d8eb24a7e65c20ecc717eff554ea` ✅ |
| Fix commit (main) | `11585a1 fix(nginx): remove root → /welcome/ redirect (P0 blank screen)` |
| **B. VPS HEAD** | **`d054b0a`** (PR 3 + SW Kill-Switch + nginx root redirect fix) |
| **C. Main HEAD (GitHub)** | `c726685` (PR #62 + #64 merged AMA VPS sadece #64 cherry-pick) |
| **D. Sadece PR #64 alındı** | ✅ `git diff d53e81d..HEAD --name-only -- frontend/` = 1 dosya (`frontend/nginx.conf`) |
| **E. PR #57/#58 YOK** | ✅ `git log \| grep '31b3f2c\|d8af73b'` → 0 |
| **F. PR #62 YOK** | ✅ `git log \| grep '3bf11f8\|97de09b'` → 0 (mid-deploy reset ile) |
| **G. Sprint 2A YOK** | ✅ `git log \| grep '49e9ae6'` → 0 |
| **H. Önceki frontend image** | `70dbf5959a69` |
| **I. Yeni frontend image** | **`sha256:2d5e1b76d2c6dde2ba63efdfb8fdcb5809e09ea84661e050176d7c2eb266fb68`** |
| **J. Frontend rollback tag** | `netmanager-frontend:rollback-pre-root-redirect-fix-20260610_1313` → `70dbf5959a69` |
| **K. Backend UNCHANGED** | `25fc5d7218a5` ✅ |
| **L. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **M. Backend/alembic/compose/edge_nginx delta** | **0/0/0/0** ✅ (sadece frontend/nginx.conf değişti) |
| **N. 11/11 servis health** | ✅ |
| **O. `/` artık 200 mu, 301 YOK mu?** | ✅ **Origin: 200 + index.html + no-store** (önceki 301 /welcome/ KALDIRILDI) · **Edge: 200** |
| **P. `/welcome/` hâlâ 200?** | ✅ Origin: 200 · Edge: 200 (tanıtım sayfası korundu) |
| **Q. /login 200** | ✅ |
| **R. /dashboard 200 index.html** | ✅ |
| **S. /audit-log 200 index.html** | ✅ |
| **T. /sw.js no-store + kill-switch korunuyor mu?** | ✅ Origin: no-store + 3 kill-switch pattern; Edge: DYNAMIC + no-store |
| **U. /index.html no-store korunuyor mu?** | ✅ `Cache-Control: no-store, no-cache, must-revalidate` |
| **V. /assets/index-*.css 200** | ✅ (JS bundle hash AYNI `index-BGO3YPjH.js`, JS içeriği değişmedi) |
| **W. HSTS korunuyor mu?** | ✅ Edge: `strict-transport-security: max-age=63072000; includeSubDomains; preload` |
| **X. Cloudflare /sw.js DYNAMIC+no-store korunuyor mu?** | ✅ `cf-cache-status: DYNAMIC` + `cache-control: no-store, no-cache, must-revalidate, max-age=0` |

## Edge (Cloudflare) doğrulama özeti

```
GET https://netmanager.systrack.app/
→ HTTP/2 200 (önceki: 301 → /welcome/)
→ cache-control: no-store, no-cache, must-revalidate
→ SPA index.html serve edildi

GET https://netmanager.systrack.app/welcome/
→ HTTP/2 200 (tanıtım sayfası korundu)

GET https://netmanager.systrack.app/dashboard
→ HTTP/2 200 (SPA fallback, React Router ele alacak)

GET https://netmanager.systrack.app/sw.js
→ HTTP/2 200 + cf-cache-status: DYNAMIC + no-store (Cloudflare Faz 0 korundu)
→ Kill-switch content intact

GET https://netmanager.systrack.app/login
→ Strict-Transport-Security: max-age=63072000; includeSubDomains; preload (HSTS korundu)
```

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up About an hour (healthy)   ← UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 30 hours (healthy)        ← UNCHANGED
celery_beat             running   Up 30 hours (healthy)        ← UNCHANGED
celery_default_worker   running   Up 30 hours (healthy)        ← UNCHANGED
celery_worker           running   Up 30 hours (healthy)        ← UNCHANGED
event_consumer          running   Up 30 hours (healthy)        ← UNCHANGED
flower                  running   Up 30 hours                  ← UNCHANGED
frontend                running   Up 56 seconds                ← RECREATED (2d5e1b76d2c6)
nginx                   running   Up 30 hours (healthy)        ← edge nginx UNCHANGED
postgres                running   Up 30 hours (healthy)        ← UNCHANGED
redis                   running   Up 30 hours (healthy)        ← UNCHANGED
```

**10 servis UNCHANGED**; sadece `frontend` recreate. **Edge nginx (host) DOKUNULMADI** (Up 30 hours).

## Mid-deploy reset detayı (PR #62 sızması engellendi)

İlk forensic'te VPS HEAD `3bf11f8` (PR #62 Finding 1 commit'i git ağacında). Kullanıcı kuralı: "PR #62 production'a sızmayacak". Önceki SW Kill-Switch deploy'da kullanılan pattern uygulandı:

1. `git reset --hard d53e81d` (SW Kill-Switch hali — PR #62 öncesi)
2. `git cherry-pick 11585a1` (PR #64 fix — main'den taze)
3. Final HEAD: `d054b0a`

**Sprint 2A + PR 4 + PR #58 + PR #62 hepsi VPS git'inde YOK** ✅.

## VPS git zinciri (yeni)

```
d054b0a fix(nginx): remove root → /welcome/ redirect (P0 blank screen)  ← YENİ
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
| 1-10 | (önceki zinciri) | #39-#55 | MFA + auth + W1-G + Audit Log v2 PR 1+2+3 |
| 11 | `d53e81d` ← `394b0b8` | #60 | SW Kill-Switch + PWA Disable |
| 12 | **`d054b0a` ← `11585a1`** | **#64** | **P0 Frontend Nginx Root Redirect Fix** ⭐ |

**PR #62 git ağacında YOK** (mid-deploy reset ile temizlendi).

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend image build/deploy | ✅ |
| 2-7. Backend/DB/migration/restart/compose/edge_nginx yok | ✅ |
| 8. Sprint 2A YOK | ✅ |
| 9. Audit Log PR4 YOK | ✅ |
| 10. PR #57/#58 prod'a alınmadı | ✅ |
| 11. PR #62 redeploy YOK | ✅ (mid-deploy reset ile garantili) |
| 12. PR #63 işlem YOK | ✅ |
| 13. SW Kill-Switch PR #60 korundu | ✅ |
| 14. Cloudflare Faz 0 ayarları korundu | ✅ (sw.js no-store + DYNAMIC) |
| 15. W1-G Login i18n korundu | ✅ |
| 16. Auth hotfix zinciri korundu | ✅ |
| 17. SSH Termination KAPALI | ✅ |

## Kullanıcıdan beklenen manuel smoke (11 senaryo)

1. Normal Chrome profilinde `/` → uygulama veya login (artık /welcome/ YÖNLENMİYOR)
2. Admin login → dashboard, siyah ekran YOK
3. Coosef login → dashboard veya yetkili default ekran, siyah ekran YOK; location selector'da "Unassigned — atg-hotels" görünür
4. `/dashboard` direkt aç → auth varsa dashboard, yoksa login
5. `/welcome/` direkt aç → tanıtım sayfası (Charon HTML) gelir
6. Console runtime error YOK
7. Network 401/403/500/502 YOK
8. /api/v1/context/current authenticated → 200
9. /api/v1/context/current anonim → 401
10. /audit-log PR 1/2/3 davranışı korundu
11. SW kill-switch bozulmadı

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `d53e81d` (SW Kill-Switch hali, root redirect fix ÖNCESİ) |
| alembic | `f9aeportpol` |
| Frontend image | `70dbf5959a69` → tag `netmanager-frontend:rollback-pre-root-redirect-fix-20260610_1313` |

### Rollback komutu

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-root-redirect-fix-20260610_1313 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard d53e81d
```

~30 sn. Backend `25fc5d7218a5` UNCHANGED, alembic `f9aeportpol` UNCHANGED.

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke (admin + coosef + /welcome direkt) — kullanıcı |
| 2 | Smoke PASS olursa: PR #61 (SW Kill-Switch deploy log) merge edilebilir hale gelir |
| 3 | PR #61 memory entry: "SW fixed, blank screen separate nginx root redirect bug" notu eklenecek |
| 4 | Dashboard refresh/auth backlog memory entry: "resolved by nginx root redirect fix PR #64" güncellemesi |
| 5 | PR #62 redeploy (CF Faz 0 + bu fix sonrası kontrollü window'da) |
| 6 | PR #63 close → yeni deploy log PR (PR #62 redeploy başarılı olursa) |
