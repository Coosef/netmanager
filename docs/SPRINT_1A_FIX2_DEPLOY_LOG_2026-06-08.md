# Sprint 1A-fix2 — Platform Management super_admin-only — Production Deploy Log — 2026-06-08

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only deploy (W1-F + Charon Menu + Sprint 1A paterni).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `9d0a391` (Sprint 1A RBAC hotfix) → **`3a00ed9`** (Sprint 1A-fix2 Platform Mgmt super_admin-only)
- **Kapsam:** PR #33 — admin_platform 4 → 2 tab, /settings + /org-admin super_admin-only, /help dokunulmadı
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-CAtRWoiO.js` → **`index-Y94xFJN6.js`** + `index-uWsjMl-2.css` (CSS aynı)
- **Backend:** Container **dokunulmadı** — image `25fc5d7218a5`, Up 15 hours healthy
- **Kesinti:** Frontend ~7 sn nginx static recreate; backend / db / cache **0 sn**

## Final state (POST-DEPLOY ANCHOR)

| | Değer |
|---|---|
| **VPS HEAD** | **`3a00ed919281c6d9541b79cac3497986505a3f8e`** (3a00ed9, main) |
| **alembic current** | `f9aeportpol` (DB migration yok, **UNCHANGED** ✅) |
| **Önceki frontend image** | `ea83e12ce054` (74.4 MB, ~50 dk önce — Sprint 1A deploy) |
| **Yeni frontend image** | **`sha256:dbbf75880a370c96a71d21743cb7a8e2f0eef7b860348e01cf0ba90a801cdcf6`** (74.4 MB) |
| **Backend image (untouched)** | `25fc5d7218a5` (425 MB, **UNCHANGED**) |
| **Frontend rollback tag** | `netmanager-frontend:rollback-pre-sprint-1a-fix2-20260608_1217` → `ea83e12ce054` |
| **Önceki JS bundle** | `index-CAtRWoiO.js` |
| **Yeni JS bundle** | **`index-Y94xFJN6.js`** ✅ |
| **CSS bundle** | `index-uWsjMl-2.css` (W1-F'den beri stabil — hotfix CSS dokunmadı) |
| **Frontend recreate timestamp** | `2026-06-08T12:24:02Z` |
| **Backend recreate timestamp** | `2026-06-07T21:40:38Z` (revert deploy zamanı — **UNCHANGED**) |
| **11/11 servis** | Up/healthy |

### Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 15 hours (healthy)    ← UNCHANGED
celery_agent_worker     running   Up 6 days (healthy)       ← UNCHANGED
celery_beat             running   Up 6 days (healthy)       ← UNCHANGED
celery_default_worker   running   Up 6 days (healthy)       ← UNCHANGED
celery_worker           running   Up 6 days (healthy)       ← UNCHANGED
event_consumer          running   Up 6 days (healthy)       ← UNCHANGED
flower                  running   Up 8 days                 ← UNCHANGED
frontend                running   Up 36 seconds             ← RECREATED (dbbf75880a37)
nginx                   running   Up 9 days (healthy)       ← UNCHANGED
postgres                running   Up 9 days (healthy)       ← UNCHANGED
redis                   running   Up 9 days (healthy)       ← UNCHANGED
```

**10 servis uptime korundu**; sadece `frontend` recreate edildi (`--no-deps` koruması başarılı).

## Faz çıktıları (saatler UTC)

| Faz | Saat | Süre |
|---|---|---|
| P0 — Anchor + rollback tag | 12:17:47 | <30 sn |
| P1 — git fetch + ff-merge | 12:18:00 | <30 sn |
| **P2 — Frontend build başladı** | **12:18:24** | ~5.5 dk |
| **P3 — Frontend recreate** | **12:23:59** | ~7 sn |
| **P4 — Smoke** | **12:24:24** | <30 sn |
| P5 — Servis matrisi | 12:24:30 | <30 sn |

## P4 Smoke detayları

**Health endpoint:**
```
GET /health/ready → 200 OK
{"status":"ok","checks":{"db":"ok","redis":"ok","timescaledb":"ok","hypertable_count":5}}
```

**Kullanıcı talebi 4 sayfa (Platform Management route'ları):**
```
/superadmin     HTTP/1.1 200 OK     ✅
/settings       HTTP/1.1 200 OK     ✅
/org-admin      HTTP/1.1 200 OK     ✅
/help           HTTP/1.1 200 OK     ✅
```

**Ek smoke (6 route — Sprint 1A regresyon check):**
```
/               HTTP/1.1 301 Moved Permanently
/login          HTTP/1.1 200 OK     ✅
/devices        HTTP/1.1 200 OK     ✅
/discovery      HTTP/1.1 200 OK     ✅
/vlan           HTTP/1.1 200 OK     ✅
/racks          HTTP/1.1 200 OK     ✅
```

> **Not:** Tüm route'lar nginx SPA fallback ile 200 döner; gerçek RBAC kararı runtime React `RoleRoute.hasPermission()` ile verilir. Manuel browser smoke (13 senaryo) RBAC davranışını teyit edecek.

**Yeni bundle hash:**
```
/assets/index-Y94xFJN6.js          ← YENİ (önceki index-CAtRWoiO.js)
/assets/index-uWsjMl-2.css         ← AYNI (CSS dokunmadı)
```

**Alembic UNCHANGED assert:**
```
Pre-deploy:  alembic_version.version_num = f9aeportpol
Post-deploy: alembic_version.version_num = f9aeportpol  ✅
```

## P5 Backend untouched assertions (3-kriter)

1. **Backend image ID `25fc5d7218a5` P0'dan P5'e kadar AYNI kaldı** — recreate olmadı, sadece frontend container yenilendi.
2. **Backend container StartedAt `2026-06-07T21:40:38.966264287Z` değişmedi** — bu revert deploy zamanıdır ve Sprint 1A-fix2 deploy'u sırasında backend'e dokunulmadı.
3. **Backend health durumu `Up 15 hours (healthy)` formatı korunmuş** — healthy state kesilmedi, alembic_version `f9aeportpol` UNCHANGED.

## P6 — Bu doküman

`docs/SPRINT_1A_FIX2_DEPLOY_LOG_2026-06-08.md`

---

## Yeni bundle delta (önce → sonra)

| Asset | Sprint 1A RBAC (önce) | Sprint 1A-fix2 (sonra) | Değişti mi |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `ea83e12ce054` | **`dbbf75880a37`** | ✅ Yeni hash |
| JavaScript bundle | `index-CAtRWoiO.js` | **`index-Y94xFJN6.js`** | ✅ Yeni hash |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ Aynı (hotfix CSS dokunmadı) |

---

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `9d0a391bd5fd844468fbe5be67d9914b200c20ef` (Sprint 1A RBAC) |
| alembic | `f9aeportpol` (aynı) |
| Frontend image | `ea83e12ce054` → tag `netmanager-frontend:rollback-pre-sprint-1a-fix2-20260608_1217` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-sprint-1a-fix2-20260608_1217 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 9d0a391
# ~30-60 sn; backend / db / cache dokunulmaz
```

---

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build | ✅ |
| 2. Sadece frontend recreate | ✅ (backend UNCHANGED Up 15h) |
| 3. Backend build/restart yok | ✅ |
| 4. DB migration yok | ✅ `f9aeportpol` UNCHANGED |
| 5. Postgres/Redis/Celery/Nginx restart yok | ✅ 9 servis Up 6-9 gün |
| 6. `--no-deps` zorunlu | ✅ |
| 7. Frontend rollback tag | ✅ |
| 8. Deploy log dokümanı | ✅ Bu doküman |

## Kullanıcıdan beklenen manuel browser smoke (13 senaryo)

| # | Senaryo | Beklenen |
|---|---|---|
| 1 | super_admin sidebar | Platform Management görür ✅ |
| 2 | super_admin → `/superadmin` | açılır ✅ |
| 3 | super_admin → `/settings` | açılır ✅ |
| 4 | super_admin → `/org-admin` | açılır ✅ |
| 5 | super_admin → `/help` | açılır ✅ |
| 6 | org_admin sidebar | Platform Management **GÖRÜNMEZ** ✅ |
| 7 | org_admin → `/superadmin` | Dashboard'a yönlenir ✅ |
| 8 | org_admin → `/settings` | Dashboard'a yönlenir ✅ |
| 9 | org_admin → `/org-admin` | Dashboard'a yönlenir ✅ |
| 10 | **org_admin → `/help`** | **açılır (mevcut davranış korundu)** ✅ |
| 11 | location_admin sidebar | Platform Management GÖRÜNMEZ ✅ |
| 12 | viewer sidebar | Platform Management GÖRÜNMEZ ✅ |
| 13 | Diğer 11 ana grub etkilenmemiş | UNCHANGED ✅ |

### Bu deploy tamamlandıktan sonra Sprint 1A-fix2 kapanır.

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke 13 senaryo — kullanıcı doğrular |
| 2 | Sprint 1A-fix2 resmi kapanış (memory entry update) |
| 3 | Sprint 1A genel kapanış (Sprint 1A + 1A-fix2 birleşik) |
| 4 | **Sprint 1B** — Backend ORG_ADMIN permission surface (kullanıcı GO) |
| 5 | **Sprint 1C** — Yeni org bootstrap default Location/UserLocation (kullanıcı GO) |
| 6 | **MFA Bug paketi** (master rapor B.1, security HIGH) — kullanıcı GO |
