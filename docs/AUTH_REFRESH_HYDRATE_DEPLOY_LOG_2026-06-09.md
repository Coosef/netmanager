# AUTH-REFRESH-HYDRATE-GUARD — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only deploy. Sprint 2A kodu prod'a İNMEDİ (cherry-pick stratejisi).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `1ba5550` (MFA login UI hotfix) → **`fa56968`** (auth refresh hydrate guard, cherry-pick)
- **Kapsam:** PR #39 — Zustand v5 async rehydrate race fix, ProtectedRoute hydration guard
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-CcKnrnkB.js` → **`index-MlcKsVU3.js`**
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅ (Sprint 1A başından beri 9 deploy boyunca dokunulmadı)
- **Sprint 2A kodu prod'a girmedi** ✅ (cherry-pick ile `49e9ae6` bypass edildi)
- **Kesinti:** Frontend ~8 sn nginx static recreate; backend / db / cache **0 sn**

## Final state

| | Değer |
|---|---|
| **PR #39 merge** | `ba98802ab660831e4de26d7289b327effe3ee0e5` ✅ (main üzerinde merge commit) |
| **Auth hotfix commit (main)** | `e01e37f fix(auth): wait for persisted auth hydration before route redirect` |
| **VPS HEAD** | **`fa56968`** (cherry-pick'lenmiş auth hotfix; Sprint 2A YOK) |
| **Main HEAD (GitHub)** | `ba98802` (merge commit, içinde `e01e37f` + Sprint 2A `49e9ae6` mevcut) |
| **alembic current** | `f9aeportpol` (UNCHANGED ✅) |
| **Önceki frontend image** | `ae17a44da747` (74.4 MB, ~1 saat önce — MFA login UI rollback build) |
| **Yeni frontend image** | **`sha256:c8406a31a2d019cc80830dd51238c3f1e3b8a1a4bb26cd6d6edb9846ae90d1e5`** (74.4 MB) |
| **Backend image (untouched)** | `25fc5d7218a5` (425 MB, UNCHANGED — Sprint 1A başından 9 deploy) |
| **Frontend rollback tag** | `netmanager-frontend:rollback-pre-auth-refresh-hotfix-20260608_2119` → `ae17a44da747` |
| **Önceki JS bundle** | `index-CcKnrnkB.js` |
| **Yeni JS bundle** | **`index-MlcKsVU3.js`** ✅ |
| **CSS bundle** | `index-uWsjMl-2.css` (UNCHANGED — JSX değişimi, CSS bundle dokunmadı) |
| **Bundle içinde `_hasHydrated`** | ✅ TRUE |
| **Bundle içinde `setHasHydrated`** | ✅ TRUE |
| **Bundle içinde `netmgr-auth`** | ✅ TRUE |
| **Frontend recreate timestamp** | `2026-06-08T21:25:25Z` |
| **Backend StartedAt** | `2026-06-08T18:21:32Z` (auth hotfix öncesi; image ID 25fc5d7218a5 AYNI) |
| **11/11 servis** | Up/healthy ✅ |

### Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 3 hours (healthy)        ← image UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 7 days (healthy)         ← UNCHANGED
celery_beat             running   Up 7 days (healthy)         ← UNCHANGED
celery_default_worker   running   Up 7 days (healthy)         ← UNCHANGED
celery_worker           running   Up 7 days (healthy)         ← UNCHANGED
event_consumer          running   Up 7 days (healthy)         ← UNCHANGED
flower                  running   Up 8 days                   ← UNCHANGED
frontend                running   Up 33 seconds               ← RECREATED (c8406a31a2d0)
nginx                   running   Up 10 days (healthy)        ← UNCHANGED
postgres                running   Up 10 days (healthy)        ← UNCHANGED
redis                   running   Up 10 days (healthy)        ← UNCHANGED
```

**10 servis uptime korundu**; sadece `frontend` recreate edildi (`--no-deps` koruması başarılı).

## Sprint 2A bypass stratejisi (cherry-pick)

main HEAD'inde `ba98802` (merge commit) içinde HEM `e01e37f` (auth hotfix) HEM `49e9ae6` (Sprint 2A OverviewTab) mevcut. **Cherry-pick** ile yalnız auth hotfix prod'a alındı:

```bash
# VPS:
git fetch origin main                       # 49e9ae6..ba98802
git cherry-pick e01e37f                     # SADECE auth hotfix
# Sonuç: VPS HEAD = fa56968 (1ba5550 + e01e37f cherry-pick)
# Sprint 2A 49e9ae6 prod ağacında YOK
```

VPS git log doğrulaması:
```
fa56968 fix(auth): wait for persisted auth hydration before route redirect    ← yeni
1ba5550 fix(login): prevent MFA OTP grid overflow on challenge step
c63034d docs(deploy): Sprint 1A-fix2 Platform Mgmt super_admin-only deploy log
```

`grep -c '49e9ae6'` → **0** (Sprint 2A YOK) ✅

## Faz çıktıları

### P0 — Anchor
- git HEAD: `1ba5550` (MFA login UI hotfix)
- alembic: `f9aeportpol`
- Frontend image: `ae17a44da747`
- Backend image: `25fc5d7218a5` (untouched)
- Bundle (önceki): `index-CcKnrnkB.js` + `index-uWsjMl-2.css`
- **Rollback tag:** `netmanager-frontend:rollback-pre-auth-refresh-hotfix-20260608_2119` ✅

### P1 — git fetch + cherry-pick (Sprint 2A bypass)
```
fetch:           49e9ae6..ba98802 (Sprint 2A kod + auth hotfix + merge commit)
cherry-pick:     e01e37f (sadece auth hotfix)
backend delta:   0 ✅
alembic delta:   0 ✅
docker-compose:  0 ✅
frontend delta:  3 dosya (auth.ts + App.tsx + auth.test.ts)
new HEAD:        fa56968 (cherry-pick commit)
Sprint 2A 49e9ae6 prod ağacında: YOK ✅
```

### P2 — Frontend build
```
docker compose build frontend
build: ~5 dk (vite + PWA + workbox)
yeni image: c8406a31a2d0 (74.4 MB)
sha256: c8406a31a2d019cc80830dd51238c3f1e3b8a1a4bb26cd6d6edb9846ae90d1e5
```

### P3 — Frontend recreate (`--no-deps`)
```
docker compose up -d --no-deps frontend
→ frontend Up 8 sn
→ backend image UNCHANGED (25fc5d7218a5)
→ Diğer 9 servis UNCHANGED
```

### P4 — Smoke

**Health endpoint:**
```
GET /health/ready → 200 OK
{"status":"ok","checks":{"db":"ok","redis":"ok","timescaledb":"ok","hypertable_count":5}}
```

**HTTP routes:**
```
/                   HTTP/1.1 301 Moved Permanently
/login              HTTP/1.1 200 OK     ✅
/devices            HTTP/1.1 200 OK     ✅
```

**Yeni bundle:**
```
/assets/index-MlcKsVU3.js          ← YENİ (önceki index-CcKnrnkB.js)
/assets/index-uWsjMl-2.css         ← AYNI (auth hotfix JSX/store değişimi, CSS bundle dokunmadı)
```

**Bundle hotfix kodu doğrulaması:**
```
grep _hasHydrated index-MlcKsVU3.js  → TRUE  ✅
grep setHasHydrated index-MlcKsVU3.js → TRUE  ✅
grep netmgr-auth index-MlcKsVU3.js    → TRUE  ✅
```

**Alembic UNCHANGED:** `f9aeportpol` ✅

### P5 — Backend untouched assert

| Kriter | Durum |
|---|---|
| Image ID `25fc5d7218a5` AYNI | ✅ |
| Container running healthy | ✅ |
| Backend delta 0 (cherry-pick yalnız frontend dosyaları) | ✅ |
| Postgres/Redis/Celery/Nginx uptime korundu | ✅ |
| Sprint 2A kodu prod'a INMEDI | ✅ |

---

## Yeni bundle delta

| Asset | MFA login UI rollback (önce) | Auth refresh hydrate (sonra) | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `ae17a44da747` | **`c8406a31a2d0`** | ✅ Yeni hash |
| JS bundle | `index-CcKnrnkB.js` | **`index-MlcKsVU3.js`** | ✅ Yeni hash |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ Aynı |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `1ba5550` (MFA login UI hotfix) |
| alembic | `f9aeportpol` |
| Frontend image | `ae17a44da747` → tag `netmanager-frontend:rollback-pre-auth-refresh-hotfix-20260608_2119` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-auth-refresh-hotfix-20260608_2119 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 1ba5550
# ~30-60 sn; backend / db / cache dokunulmaz
```

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. PR #39 merge edildi | ✅ ba98802 |
| 2. Deploy sadece PR #39 hotfix'i içeriyor (Sprint 2A YOK) | ✅ cherry-pick stratejisi |
| 3. Sprint 2A kodu prod'a tekrar alınmadı | ✅ `49e9ae6` prod ağacında YOK |
| 4. PR #38 merge edilmedi | ✅ Açık |
| 5. Backend dokunulmadı | ✅ image AYNI |
| 6. DB dokunulmadı | ✅ alembic UNCHANGED |
| 7. Migration YOK | ✅ |
| 8. Backend restart YOK | ✅ Up 3 hours korundu |
| 9. `--no-deps` zorunlu | ✅ |
| 10. SSH Session Termination KAPALI | ✅ |

## Kullanıcıdan beklenen kritik manuel smoke (10 senaryo)

1. Normal login → Dashboard açılmalı
2. **F5 refresh × 5 → kullanıcı logout olmamalı** ⭐ (kritik kanıt)
3. Dashboard'da kalmalı
4. Menü ve üst bar görünmeli
5. Location context takılmamalı
6. MFA login → Dashboard açılmalı
7. MFA login sonrası F5 refresh × 3 → logout olmamalı
8. Logout butonu → /login dönmeli
9. Login sonrası localStorage'da `netmgr-auth` kalmalı
10. Console'da uygulama kaynaklı yeni critical error olmamalı

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke 10 senaryo — kullanıcı doğrular (özellikle F5 × 5) |
| 2 | Auth hotfix resmi kapanış (memory entry) |
| 3 | Sprint 2A PR #37 / PR #38 için karar (yeniden deploy mu, kapatma mı) |
| 4 | Sıradaki backlog (Sprint 2 P1 — Patch Panel + LLDP Cabling, vb.) |
