# AUTH-PERSIST-HYDRATION-HOTFIX — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only, cherry-pick stratejisi devam (Sprint 2A YOK).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.
>
> **Son ana hotfix denemesi** (kullanıcı kararı).

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `a654705` (Login redirect hotfix) → **`3e727e1`** (Auth persist hydration hotfix cherry-pick)
- **Kapsam:** PR #47 — Zustand persist API kullanarak hidrasyon race'i ortadan kaldır
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-DvaxE7sj.js` → **`index-BNwKfP05.js`**
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅ (Sprint 1A'dan beri **13 deploy**)
- **Sprint 2A kodu prod'a girmedi** ✅ (cherry-pick bypass devam)
- **PR #43 PWA fixleri korundu** (sw.js) ✅

## A-R — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #47 merge** | `46031581636e8846c6b2bccc378093139779259d` ✅ |
| Hotfix commit (main) | `b5055c1 fix(auth): use zustand persist api for hydration (kill setter chain)` |
| **B. VPS HEAD** | **`3e727e1`** (cherry-pick'lenmiş auth persist hydration hotfix) |
| **C. Main HEAD (GitHub)** | `4603158` (merge commit, içinde Sprint 2A `49e9ae6` mevcut — VPS'e cherry-pick ile sadece hotfix) |
| **D. Sprint 2A prod ağacında YOK kanıtı** | `git log \| grep '49e9ae6'` → **0 satır** ✅ |
| **E. Önceki frontend image** | `86b0e03f363e` (Login redirect hotfix build) |
| **F. Yeni frontend image** | **`sha256:723db19a800350bf778eb55180062cb6e493869ed247ef0b8c1cbd9388246fbd`** (74.4 MB) |
| **G. Rollback tag** | `netmanager-frontend:rollback-pre-auth-persist-hotfix-20260609_1324` → `86b0e03f363e` |
| **H. Yeni JS bundle** | **`index-BNwKfP05.js`** ✅ (önceki `index-DvaxE7sj.js`) |
| **H. CSS bundle** | `index-uWsjMl-2.css` (AYNI — JSX değişimi yok) |
| **I. useHasHydrated bundle'da kanıtları** | `hasHydrated` ✅ PRESENT (Zustand persist API) · `onFinishHydration` ✅ PRESENT · `netmgr-auth` ✅ PRESENT |
| **J. `_hasHydrated`/`setHasHydrated` artık kullanılmıyor** | `_hasHydrated` ✅ **YOK** (temizlendi) · `setHasHydrated` ✅ **YOK** (kaldırıldı) |
| **K. PWA cache fixleri korunuyor mu (sw.js)** | bkz. aşağıdaki tablo |
| **L. Backend image UNCHANGED** | `25fc5d7218a5` ✅ |
| **M. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **N. Backend/alembic/compose delta** | **0/0/0** ✅ |
| **O. i18n delta** | **0** ✅ (yeni string YOK) |
| **P. 11/11 servis health** | ✅ |
| **Q. /login** | `HTTP/1.1 200 OK` ✅ |
| **R. /health/ready** | `200 OK` — db/redis/timescaledb ok ✅ |

### K — PWA cache fixleri detay (sw.js)

| String | Durum | Beklenen |
|---|---|---|
| `NavigationRoute` | **YOK** ✅ | PR #43 ile kaldırıldı, korundu |
| `api-cache` | **YOK** ✅ | PR #43 ile kaldırıldı, korundu |
| `NetworkFirst` | **YOK** ✅ | PR #43 ile kaldırıldı, korundu |
| `createHandlerBoundToURL` | **YOK** ✅ | PR #43 ile kaldırıldı, korundu |
| `cleanupOutdatedCaches` | **VAR** ✅ | PR #43 ile eklendi, korundu |
| index.html precache | **YOK** ✅ | PR #43 ile kaldırıldı, korundu |

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 6 hours (healthy)        ← image UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 6 hours (healthy)        ← UNCHANGED
celery_beat             running   Up 6 hours (healthy)        ← UNCHANGED
celery_default_worker   running   Up 6 hours (healthy)        ← UNCHANGED
celery_worker           running   Up 6 hours (healthy)        ← UNCHANGED
event_consumer          running   Up 6 hours (healthy)        ← UNCHANGED
flower                  running   Up 6 hours                  ← UNCHANGED
frontend                running   Up 44 seconds               ← RECREATED (723db19a8003)
nginx                   running   Up 6 hours (healthy)        ← UNCHANGED
postgres                running   Up 6 hours (healthy)        ← UNCHANGED
redis                   running   Up 6 hours (healthy)        ← UNCHANGED
```

**10 servis Up 6 hours**; sadece `frontend` recreate edildi.

## Sprint 2A bypass kanıtı (devam)

```
VPS git log son 6:
3e727e1 fix(auth): use zustand persist api for hydration (kill setter chain)  ← YENİ
a654705 fix(auth): redirect authenticated user from /login to dashboard
d719d8a fix(pwa): disable navigation fallback + api runtime cache
62e36d7 fix(dashboard): selector consistency + WS guard + 401 debounce
fa56968 fix(auth): wait for persisted auth hydration before route redirect
1ba5550 fix(login): prevent MFA OTP grid overflow on challenge step

VPS git log | grep '49e9ae6' → 0  (Sprint 2A YOK) ✅
```

## Hotfix zinciri (prod ağacında aktif)

| # | Commit | PR | Kapsam |
|---|---|---|---|
| 1 | `1ba5550` | — | MFA login UI OTP grid taşma |
| 2 | `fa56968` ← `e01e37f` | #39 | Auth refresh hydrate guard (eski `_hasHydrated`) |
| 3 | `62e36d7` ← `0ce1e1a` | #41 | Dashboard hotfix (selector + WS + 401 debounce) |
| 4 | `d719d8a` ← `55eecac` | #43 | PWA cache hotfix |
| 5 | `a654705` ← `948808e` | #45 | Login redirect hotfix |
| 6 | **`3e727e1` ← `b5055c1`** | **#47** | **Auth persist hydration hotfix — Zustand persist API** ⭐ |

## Bundle delta

| Asset | Login redirect | Auth persist hydration | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `86b0e03f363e` | **`723db19a8003`** | ✅ |
| JS bundle | `index-DvaxE7sj.js` | **`index-BNwKfP05.js`** | ✅ |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ AYNI |
| sw.js | NavigationRoute/api-cache YOK | NavigationRoute/api-cache YOK | ❌ AYNI mantık |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `a654705` (Login redirect hotfix) |
| alembic | `f9aeportpol` |
| Frontend image | `86b0e03f363e` → tag `netmanager-frontend:rollback-pre-auth-persist-hotfix-20260609_1324` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-auth-persist-hotfix-20260609_1324 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard a654705
```

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build/deploy | ✅ |
| 2-7. Backend / DB / migration / restart / compose / i18n yok | ✅ |
| 8. Sprint 2A prod'a alınmadı | ✅ git log grep '49e9ae6' = 0 |
| 9. Cherry-pick stratejisi | ✅ |
| 10. PR #38 / #40 / #42 / #44 / #46 merge edilmedi | ✅ |
| 11. SSH Termination KAPALI | ✅ |

## Kullanıcıdan beklenen kritik manuel smoke (10 senaryo)

⚠ Eski SW kullanıcı tarayıcısında kalmış olabilir → ilk açılışta hard refresh (Cmd+Shift+R) veya Unregister + Clear site data önerilir.

1. Gizli sekme / temiz session ile site açılır
2. Admin ile login → Dashboard açılır
3. **Dashboard F5 yapınca login'e atmamalı** ⭐ kritik
4. **Dashboard F5 × 5 → logout olmamalı** ⭐
5. Manuel `/login` URL'sine git → token varsa Dashboard'a geri atmalı
6. `/devices` F5 × 5 → regresyon yok
7. Logout butonu → token temizlenir → `/login`'de kalır
8. Console runtime error yok
9. Network 401/403/500 yok
10. MFA login akışı bozulmadı

---

## Sonraki adımlar (smoke sonucuna bağlı)

### Eğer smoke PASS olursa:
- Tüm hotfix zinciri (PR #39 + #41 + #43 + #45 + #47) için birleşik kapanış memory entry
- Sprint 2A PR #37 + tüm deploy log PR'ları için karar (yeniden deploy mu, kapatma mı)
- Sıradaki backlog (Sprint 2 P1 — Patch Panel + LLDP Cabling, vd.)

### Eğer smoke FAIL olursa (kullanıcı kararı):
- Dashboard refresh logout konusu **backlog'a alınır**
- Diğer işlere devam edilir
- Kullanıcı tarayıcı tarafında ek forensic (SW unregister + clear data) deneyebilir
