# AUTH-LOGIN-REDIRECT-HOTFIX — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only, cherry-pick stratejisi devam (Sprint 2A YOK).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `d719d8a` (PWA cache hotfix) → **`a654705`** (Login redirect hotfix cherry-pick)
- **Kapsam:** PR #45 — Login component'inde authenticated-user redirect guard
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-DniO4XgC.js` → **`index-DvaxE7sj.js`**
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅ (Sprint 1A'dan beri **12 deploy**)
- **Sprint 2A kodu prod'a girmedi** ✅ (cherry-pick `49e9ae6` bypass devam)
- **PR #43 sw.js fixleri korundu** (NavigationRoute/api-cache YOK) ✅

## A-P — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #45 merge** | `c8000ec7167e8b6ccd4bdc6d07d21c2055ee57d6` ✅ |
| Login redirect commit (main) | `948808e fix(auth): redirect authenticated user from /login to dashboard` |
| **B. VPS HEAD** | **`a654705`** (cherry-pick'lenmiş Login redirect hotfix) |
| **C. Main HEAD (GitHub)** | `c8000ec` (merge commit, içinde Sprint 2A `49e9ae6` mevcut — VPS'e cherry-pick ile sadece Login redirect hotfix) |
| **D. Sprint 2A prod ağacında YOK kanıtı** | `git log \| grep '49e9ae6'` → **0 satır** ✅ |
| **E. Önceki frontend image** | `5bbce9c87477` (PWA cache hotfix build) |
| **F. Yeni frontend image** | **`sha256:86b0e03f363ee9a9dea26b82919ea8dad4cf7808acac68ad8a10c8dd4f400439`** (74.4 MB) |
| **G. Rollback tag** | `netmanager-frontend:rollback-pre-login-redirect-hotfix-20260609_1226` → `5bbce9c87477` |
| **H. Önceki JS bundle** | `index-DniO4XgC.js` |
| **H. Yeni JS bundle** | **`index-DvaxE7sj.js`** ✅ |
| **H. CSS bundle** | `index-uWsjMl-2.css` (AYNI) |
| **I. Login redirect guard bundle'da kanıtları** | `_hasHydrated` ✅ PRESENT · `netmgr-auth` ✅ PRESENT · `replace:!0` ✅ PRESENT (minified `replace: true` — yeni navigate replace çağrısı) |
| **J. Backend image UNCHANGED** | `25fc5d7218a5` ✅ |
| **K. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **L. Backend/alembic/compose delta** | **0/0/0** ✅ |
| **M. i18n delta** | **0** ✅ (yeni string YOK) |
| **N. 11/11 servis health** | ✅ |
| **O. /login** | `HTTP/1.1 200 OK` ✅ |
| **P. /health/ready** | `200 OK` — db/redis/timescaledb ok ✅ |

## sw.js — PR #43 PWA cache fixleri KORUNDU

| String | Durum | Beklenen |
|---|---|---|
| `NavigationRoute` | **YOK** ✅ | PR #43 ile kaldırıldı, korundu |
| `api-cache` | **YOK** ✅ | PR #43 ile kaldırıldı, korundu |
| `NetworkFirst` | **YOK** ✅ | PR #43 ile kaldırıldı, korundu |
| `cleanupOutdatedCaches` | **VAR** ✅ | PR #43 ile eklendi, korundu |

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 5 hours (healthy)        ← image UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 5 hours (healthy)        ← UNCHANGED
celery_beat             running   Up 5 hours (healthy)        ← UNCHANGED
celery_default_worker   running   Up 5 hours (healthy)        ← UNCHANGED
celery_worker           running   Up 5 hours (healthy)        ← UNCHANGED
event_consumer          running   Up 5 hours (healthy)        ← UNCHANGED
flower                  running   Up 5 hours                  ← UNCHANGED
frontend                running   Up 41 seconds               ← RECREATED (86b0e03f363e)
nginx                   running   Up 5 hours (healthy)        ← UNCHANGED
postgres                running   Up 5 hours (healthy)        ← UNCHANGED
redis                   running   Up 5 hours (healthy)        ← UNCHANGED
```

**10 servis Up 5 hours**; sadece `frontend` recreate edildi.

## Sprint 2A bypass kanıtı (devam)

```
VPS git log son 5:
a654705 fix(auth): redirect authenticated user from /login to dashboard      ← YENİ
d719d8a fix(pwa): disable navigation fallback + api runtime cache
62e36d7 fix(dashboard): selector consistency + WS guard + 401 debounce
fa56968 fix(auth): wait for persisted auth hydration before route redirect
1ba5550 fix(login): prevent MFA OTP grid overflow on challenge step

VPS git log | grep '49e9ae6' → 0  (Sprint 2A YOK) ✅
```

## Hotfix zinciri (prod ağacında aktif)

| # | Commit | PR | Kapsam |
|---|---|---|---|
| 1 | `1ba5550` | (önceki) | MFA login UI OTP grid taşma |
| 2 | `fa56968` ← cherry-pick `e01e37f` | #39 | Auth refresh hydrate guard (`_hasHydrated` flag) |
| 3 | `62e36d7` ← cherry-pick `0ce1e1a` | #41 | Dashboard hotfix (selector consistency + WS guard + 401 debounce) |
| 4 | `d719d8a` ← cherry-pick `55eecac` | #43 | PWA cache hotfix (navigateFallback null + api-cache kaldır) |
| 5 | **`a654705` ← cherry-pick `948808e`** | **#45** | **Login redirect hotfix (authenticated user → Dashboard)** |

## Bundle delta

| Asset | PWA hotfix | Login redirect | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `5bbce9c87477` | **`86b0e03f363e`** | ✅ |
| JS bundle | `index-DniO4XgC.js` | **`index-DvaxE7sj.js`** | ✅ |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ AYNI |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `d719d8a` (PWA cache hotfix) |
| alembic | `f9aeportpol` |
| Frontend image | `5bbce9c87477` → tag `netmanager-frontend:rollback-pre-login-redirect-hotfix-20260609_1226` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-login-redirect-hotfix-20260609_1226 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard d719d8a
```

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build/deploy | ✅ |
| 2-7. Backend / DB / migration / restart / compose / i18n yok | ✅ |
| 8. Sprint 2A prod'a alınmadı | ✅ git log grep '49e9ae6' = 0 |
| 9. Cherry-pick stratejisi | ✅ |
| 10. PR #38 / #40 / #42 / #44 merge edilmedi | ✅ |
| 11. SSH Termination KAPALI | ✅ |

## Kullanıcıdan beklenen manuel smoke (11 senaryo)

1. **Gizli sekme / temiz session** ile site açılır
2. Token yokken `/login` formu görünür
3. Admin ile login → Dashboard açılır
4. **Dashboard'da F5 → login ekranında kalmamalı** ⭐ kritik
5. **Dashboard F5 × 5 → logout olmamalı** ⭐
6. Manuel `/login` URL'sine git → token varsa Dashboard'a geri atmalı
7. `/devices` F5 × 5 → regresyon yok
8. Logout butonu → token temizlenir → `/login`'de kalır
9. Console runtime error yok
10. Network 401/403/500 yok
11. MFA login akışı bozulmadı

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke 11 senaryo — kullanıcı doğrular |
| 2 | Tüm hotfix serisi (PR #39 + #41 + #43 + #45) için birleşik kapanış memory entry |
| 3 | Sprint 2A PR #37 / PR #38 / PR #40 / PR #42 / PR #44 için karar |
| 4 | Sıradaki backlog (Sprint 2 P1) |
