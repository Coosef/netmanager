# DASHBOARD-REFRESH-LOGOUT-HOTFIX — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only, cherry-pick stratejisi devam (Sprint 2A YOK).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `fa56968` (auth hidrate guard) → **`62e36d7`** (Dashboard hotfix cherry-pick)
- **Kapsam:** PR #41 — 3 katman: ProtectedRoute selector consistency + useEventStream WS guard + Axios 401 debounce
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-MlcKsVU3.js` → **`index-DniO4XgC.js`**
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅
- **Sprint 2A kodu prod'a girmedi** ✅ (cherry-pick `49e9ae6` bypass devam)
- **Kesinti:** Frontend ~8 sn nginx static recreate

## A-O — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #41 merge** | `a67a98a928bf6cf4f079a8df15722df89353690f` ✅ (main üzerinde merge commit) |
| Dashboard hotfix commit (main) | `0ce1e1a fix(dashboard): selector consistency + WS guard + 401 debounce` |
| **B. VPS HEAD** | **`62e36d7`** (cherry-pick'lenmiş Dashboard hotfix; Sprint 2A YOK) |
| **C. Main HEAD (GitHub)** | `a67a98a` (merge commit, içinde `0ce1e1a` + `e01e37f` + Sprint 2A `49e9ae6` mevcut) |
| **D. Sprint 2A prod ağacında YOK kanıtı** | `git log \| grep '49e9ae6'` → **0 satır** ✅ |
| **E. Önceki frontend image** | `c8406a31a2d0` (auth refresh hydrate build) |
| **F. Yeni frontend image** | **`sha256:d5b38f28d7e6656ef118b639b26e4c038336e42ef3901d3747d6aa2017965011`** (74.4 MB) |
| **G. Rollback tag** | `netmanager-frontend:rollback-pre-dashboard-refresh-hotfix-20260609_1003` → `c8406a31a2d0` |
| **H. Önceki JS bundle** | `index-MlcKsVU3.js` |
| **H. Yeni JS bundle** | **`index-DniO4XgC.js`** ✅ |
| **H. CSS bundle** | `index-uWsjMl-2.css` (UNCHANGED — JSX/store değişimi, CSS bundle dokunmadı) |
| **I. Bundle hotfix kod doğrulaması** | bkz. aşağıdaki tablo |
| **J. Backend image UNCHANGED** | `25fc5d7218a5` ✅ |
| **K. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **L. Backend/alembic/compose delta** | **0/0/0** (cherry-pick yalnız frontend 4 dosya) ✅ |
| **M. 11/11 servis** | Up/healthy ✅ |
| **N. /health/ready** | `200 OK` — db/redis/timescaledb hepsi ok ✅ |
| **O. /login** | `HTTP/1.1 200 OK` ✅ |

### I — Bundle içinde hotfix kod doğrulaması

Bundle string-search (production minify ile bazıları kısaltılır — bu **NORMAL**):

| String | Bundle'da | Açıklama |
|---|---|---|
| `_hasHydrated` | ✅ PRESENT | Zustand store literal — minify edilmez |
| `setHasHydrated` | ✅ PRESENT | Action name literal |
| `netmgr-auth` | ✅ PRESENT | persist key literal |
| `_logoutInFlight` | ⚠ minified | Module-level local — minifier kısaltır |
| `eventStreamEnabled` | ⚠ minified | Local variable — minifier kısaltır |
| `useShallow` | ⚠ minified | Import isim — minifier kısaltır |

**Kuvvetli kanıt: bundle hash değişti** (`index-MlcKsVU3.js` → `index-DniO4XgC.js`) → kod **yeni**. Auth hotfix string'leri (literal'ler) hâlâ PRESENT, store akışı korundu.

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 3 hours (healthy)        ← image UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 3 hours (healthy)         ← UNCHANGED
celery_beat             running   Up 3 hours (healthy)         ← UNCHANGED
celery_default_worker   running   Up 3 hours (healthy)         ← UNCHANGED
celery_worker           running   Up 3 hours (healthy)         ← UNCHANGED
event_consumer          running   Up 3 hours (healthy)         ← UNCHANGED
flower                  running   Up 3 hours                   ← UNCHANGED
frontend                running   Up 44 seconds                ← RECREATED (d5b38f28d7e6)
nginx                   running   Up 3 hours (healthy)         ← UNCHANGED
postgres                running   Up 3 hours (healthy)         ← UNCHANGED
redis                   running   Up 3 hours (healthy)         ← UNCHANGED
```

**10 servis Up 3 hours**; sadece `frontend` recreate edildi (`--no-deps` koruması başarılı).

## Sprint 2A bypass kanıtı (devam)

```
VPS git log son 4:
62e36d7 fix(dashboard): selector consistency + WS guard + 401 debounce  ← YENİ
fa56968 fix(auth): wait for persisted auth hydration before route redirect
1ba5550 fix(login): prevent MFA OTP grid overflow on challenge step
c63034d docs(deploy): Sprint 1A-fix2 Platform Mgmt super_admin-only deploy log

VPS git log | grep '49e9ae6' → 0  (Sprint 2A YOK) ✅
```

## Faz çıktıları

### P0 — Anchor
- git HEAD: `fa56968` (auth hidrate guard)
- alembic: `f9aeportpol`
- Frontend image: `c8406a31a2d0`
- Backend: `25fc5d7218a5` UNCHANGED
- Bundle (önceki): `index-MlcKsVU3.js` + `index-uWsjMl-2.css`
- **Rollback tag:** `netmanager-frontend:rollback-pre-dashboard-refresh-hotfix-20260609_1003` ✅

### P1 — git fetch + cherry-pick (Sprint 2A bypass devam)
```
fetch:           ba98802..a67a98a (PR #41 merge + Sprint 2A)
cherry-pick:     0ce1e1a (Sadece Dashboard hotfix)
backend delta:   0 ✅
alembic delta:   0 ✅
compose delta:   0 ✅
i18n delta:      0 ✅
frontend delta:  4 dosya (App.tsx + NocDashboard.tsx + client.ts + auth.test.ts)
new HEAD:        62e36d7 (cherry-pick commit)
Sprint 2A 49e9ae6 prod ağacında: YOK ✅
```

### P2 — Frontend build
```
docker compose build frontend
build: ~5 dk (vite + PWA + workbox)
yeni image: d5b38f28d7e6 (74.4 MB)
sha256: d5b38f28d7e6656ef118b639b26e4c038336e42ef3901d3747d6aa2017965011
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
/assets/index-DniO4XgC.js          ← YENİ (önceki index-MlcKsVU3.js)
/assets/index-uWsjMl-2.css         ← AYNI
```

**Alembic UNCHANGED:** `f9aeportpol` ✅

### P5 — Backend untouched assert

| Kriter | Durum |
|---|---|
| Image ID `25fc5d7218a5` AYNI | ✅ |
| Container running healthy | ✅ |
| Backend delta 0 (cherry-pick yalnız frontend) | ✅ |
| Postgres/Redis/Celery/Nginx 3+ saat uptime | ✅ |
| Sprint 2A kodu prod'a INMEDI | ✅ |

---

## Yeni bundle delta

| Asset | Auth refresh (önce) | Dashboard hotfix (sonra) | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `c8406a31a2d0` | **`d5b38f28d7e6`** | ✅ Yeni hash |
| JS bundle | `index-MlcKsVU3.js` | **`index-DniO4XgC.js`** | ✅ Yeni hash |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ Aynı |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `fa56968` (auth hidrate guard) |
| alembic | `f9aeportpol` |
| Frontend image | `c8406a31a2d0` → tag `netmanager-frontend:rollback-pre-dashboard-refresh-hotfix-20260609_1003` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-dashboard-refresh-hotfix-20260609_1003 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard fa56968
# ~30-60 sn; backend / db / cache dokunulmaz
```

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend | ✅ |
| 2. Backend yok | ✅ image AYNI |
| 3. DB yok | ✅ alembic UNCHANGED |
| 4. Migration yok | ✅ |
| 5. Backend restart yok | ✅ Up 3 hours |
| 6. Docker compose değişikliği yok | ✅ delta 0 |
| 7. i18n locale değişikliği yok | ✅ delta 0 |
| 8. Sprint 2A prod'a alınmadı | ✅ git log grep '49e9ae6' = 0 |
| 9. Cherry-pick stratejisi | ✅ |
| 10. PR #38 merge edilmedi | ✅ |
| 11. PR #40 merge edilmedi | ✅ |
| 12. SSH Termination KAPALI | ✅ |

## Kullanıcıdan beklenen manuel smoke (10 senaryo)

1. Normal login → Dashboard açılmalı
2. **Dashboard F5 × 5 → logout olmamalı** ⭐ (kritik kanıt)
3. Menü ve üst bar görünür kalmalı
4. Location context takılmamalı
5. /devices F5 × 5 → logout olmamalı (regresyon yok)
6. MFA login → Dashboard açılmalı
7. MFA login sonrası Dashboard F5 × 3 → logout olmamalı
8. Logout butonu → /login dönmeli
9. Network 401/403/500 yok
10. Console critical error yok

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke 10 senaryo — kullanıcı doğrular (özellikle F5 × 5) |
| 2 | Dashboard hotfix resmi kapanış (memory entry) — smoke 5/5 PASS sonrası |
| 3 | Sprint 2A PR #37 / PR #38 / PR #40 için karar (yeniden deploy mu, kapatma mı) |
| 4 | Sıradaki backlog |
