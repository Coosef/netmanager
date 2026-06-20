# Sprint 2A — Device CPU/RAM Render — Production Deploy Log — 2026-06-08

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only deploy (W1-F + Sprint 1A paterni).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `1ba5550` (MFA login UI hotfix) → **`49e9ae6`** (Sprint 2A CPU/RAM render)
- **Kapsam:** PR #37 — OverviewTab.tsx tek dosya (+63/-52), CPU/RAM widget koşullu render
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-CcKnrnkB.js` → **`index-CZRpZfv_.js`** + `index-uWsjMl-2.css` (CSS aynı — inline `<style>` yok, sadece JSX değişti)
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅
- **Kesinti:** Frontend ~8 sn nginx static recreate; backend / db / cache **0 sn**

## Final state

| | Değer |
|---|---|
| **PR #37 merge** | `49e9ae6e3f8dddb9f87dc3957819fc8b827f52b0` ✅ |
| **VPS HEAD** | **`49e9ae6e3f8dddb9f87dc3957819fc8b827f52b0`** (49e9ae6, main) |
| **Main HEAD** | `49e9ae6` (kod commit'i; sonraki commit deploy log doc olacak) |
| **alembic current** | `f9aeportpol` (UNCHANGED ✅) |
| **Önceki frontend image** | `ae17a44da747` (74.4 MB, 5 saat önce — MFA login UI build) |
| **Yeni frontend image** | **`sha256:9ae91857b8ce564a907d725fc5648b43bed865d6d000ee635c9e9b5904263930`** (74.4 MB) |
| **Backend image (untouched)** | `25fc5d7218a5` (425 MB, UNCHANGED — Sprint 1A başından beri 8 deploy) |
| **Frontend rollback tag** | `netmanager-frontend:rollback-pre-sprint-2a-20260608_1918` → `ae17a44da747` |
| **Önceki JS bundle** | `index-CcKnrnkB.js` |
| **Yeni JS bundle** | **`index-CZRpZfv_.js`** ✅ |
| **CSS bundle** | `index-uWsjMl-2.css` (UNCHANGED — Sprint 2A inline CSS değil JSX değişimi) |
| **Frontend recreate timestamp** | `2026-06-08T19:26:49Z` |
| **Backend StartedAt** | `2026-06-08T18:21:32Z` (P0 öncesi health-check restart; image ID 25fc5d7218a5 AYNI) |
| **11/11 servis** | Up/healthy |

### Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up About an hour (healthy)    ← image UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 7 days (healthy)            ← UNCHANGED
celery_beat             running   Up 7 days (healthy)            ← UNCHANGED
celery_default_worker   running   Up 7 days (healthy)            ← UNCHANGED
celery_worker           running   Up 7 days (healthy)            ← UNCHANGED
event_consumer          running   Up 7 days (healthy)            ← UNCHANGED
flower                  running   Up 8 days                      ← UNCHANGED
frontend                running   Up 35 seconds                  ← RECREATED (9ae91857b8ce)
nginx                   running   Up 10 days (healthy)           ← UNCHANGED
postgres                running   Up 10 days (healthy)           ← UNCHANGED
redis                   running   Up 10 days (healthy)           ← UNCHANGED
```

**10 servis uptime korundu**; sadece `frontend` recreate edildi (`--no-deps` koruması başarılı).

> **Not — Backend StartedAt değişimi:** Deploy öncesinde backend health-check restart döngüsü gözlemlendi (Up 56 minutes → Up About an hour); ancak **backend image ID `25fc5d7218a5` AYNI** ve Sprint 2A kod değişikliği backend'e dokunmadı (delta=0 assert). Image untouched assert geçerli; container restart deploy ile ilişkisiz, kullanım takibi için ileride incelenebilir.

## Faz çıktıları

### P0 — Anchor
- git HEAD: `1ba5550` (MFA login UI hotfix)
- alembic: `f9aeportpol`
- Frontend image: `ae17a44da747`
- Backend: `25fc5d7218a5` (untouched)
- Bundle (önceki): `index-CcKnrnkB.js` + `index-uWsjMl-2.css`
- **Rollback tag:** `netmanager-frontend:rollback-pre-sprint-2a-20260608_1918` ✅

### P1 — git fetch + ff-merge
```
fetch:           1ba5550..49e9ae6 (2 commit: kod + MFA deploy log)
backend delta:   0 ✅
alembic delta:   0 ✅
frontend delta:  1 dosya (OverviewTab.tsx)
docker-compose:  0 ✅
ff-merge:        success
new HEAD:        49e9ae6
```

### P2 — Frontend build
```
docker compose build frontend
build: ~8 dk (vite + PWA + workbox)
yeni image: 9ae91857b8ce (74.4 MB)
sha256: 9ae91857b8ce564a907d725fc5648b43bed865d6d000ee635c9e9b5904263930
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
/devices/4          HTTP/1.1 200 OK     ✅ (Device Detail route — Sprint 2A render hedefi)
```

**Yeni bundle:**
```
/assets/index-CZRpZfv_.js          ← YENİ (önceki index-CcKnrnkB.js)
/assets/index-uWsjMl-2.css         ← AYNI (Sprint 2A JSX değişimi, CSS bundle dokunmadı)
```

**Alembic UNCHANGED:** `f9aeportpol` ✅

### P5 — Backend untouched assert

| Kriter | Durum |
|---|---|
| Image ID `25fc5d7218a5` AYNI | ✅ |
| Container running healthy | ✅ |
| Sprint 2A frontend delta 1 dosya, backend delta 0 | ✅ |
| Postgres/Redis/Celery/Nginx uptime korundu | ✅ |

---

## Yeni bundle delta

| Asset | MFA login UI (önce) | Sprint 2A (sonra) | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `ae17a44da747` | **`9ae91857b8ce`** | ✅ Yeni hash |
| JS bundle | `index-CcKnrnkB.js` | **`index-CZRpZfv_.js`** | ✅ Yeni hash |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ Aynı |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `1ba5550` (MFA login UI hotfix) |
| alembic | `f9aeportpol` |
| Frontend image | `ae17a44da747` → tag `netmanager-frontend:rollback-pre-sprint-2a-20260608_1918` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-sprint-2a-20260608_1918 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 1ba5550
# ~30-60 sn; backend / db / cache dokunulmaz
```

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build | ✅ |
| 2. Sadece frontend recreate | ✅ |
| 3. Backend build/restart yok (deploy kaynaklı) | ✅ image ID AYNI |
| 4. DB migration yok | ✅ `f9aeportpol` UNCHANGED |
| 5. Postgres/Redis/Celery/Nginx restart yok | ✅ 9 servis Up 7-10 gün |
| 6. `--no-deps` zorunlu | ✅ |
| 7. Frontend rollback tag | ✅ |
| 8. Deploy log dokümanı | ✅ Bu doküman |

## Kullanıcıdan beklenen manuel smoke (10 senaryo)

1. SNMP enabled + CPU/RAM dönen cihazda Sistem Sağlığı kartı görünür
2. CPU ve RAM yüzde olarak düzgün görünür
3. CPU/RAM `0%` değerleri varsa empty sayılmaz (0 geçerli)
4. Sadece CPU dönen cihazda sadece CPU widget görünür
5. Sadece RAM dönen cihazda sadece RAM widget görünür
6. RAM yüzde var ama used/total MB yoksa MB satırı gizli
7. CPU/RAM dönmeyen cihazda kart tamamen gizli
8. `snmp_enabled=false` cihazda kart mount edilmez
9. Device Detail Overview genel tasarımı bozulmamış
10. Konsolda frontend error yok

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke 10 senaryo — kullanıcı doğrular |
| 2 | Sprint 2A resmi kapanış (memory entry) |
| 3 | Sıradaki backlog (Sprint 2 P1 — Patch Panel + LLDP Cabling, Sprint 3 P2, vd.) |
