# Sprint 1A — Org Admin RBAC Hotfix — Production Deploy Log — 2026-06-08

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only deploy (W1-F + Charon Menu Restructure paterni).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `c0d4051` (Charon menu hotfix) → **`9d0a391`** (Sprint 1A RBAC hotfix)
- **Kapsam:** PR #30 — App.tsx ROLE_ORDER kaldırıldı, RoleRoute hasPermission tabanlı, 18 literal canonical, /org-admin excludeRoles, 6 menü tab gate, auth.ts defansif guard, 16 yeni test
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-BhjtvSSz.js` → **`index-CAtRWoiO.js`** + `index-uWsjMl-2.css` (CSS aynı)
- **Backend:** Container **dokunulmadı** — image `25fc5d7218a5`, Up 14 hours healthy
- **Kesinti:** Frontend ~7 sn nginx static recreate; backend / db / cache **0 sn**

## Final state (POST-DEPLOY ANCHOR)

| | Değer |
|---|---|
| **VPS HEAD** | **`9d0a391bd5fd844468fbe5be67d9914b200c20ef`** (9d0a391, main) |
| **alembic current** | `f9aeportpol` (DB migration yok, **UNCHANGED** ✅) |
| **Önceki frontend image** | `918af213065a` (74.4 MB, 2 saat önce — Charon menu hotfix deploy) |
| **Yeni frontend image** | **`sha256:ea83e12ce054545679d07fae100e494a295177cc328593a0328a5a53511c2f06`** (74.4 MB) |
| **Backend image (untouched)** | `25fc5d7218a5` (425 MB, **UNCHANGED**) |
| **Frontend rollback tag** | `netmanager-frontend:rollback-pre-rbac-hotfix-20260608_1123` → `918af213065a` |
| **Önceki JS bundle** | `index-BhjtvSSz.js` |
| **Yeni JS bundle** | **`index-CAtRWoiO.js`** ✅ |
| **CSS bundle** | `index-uWsjMl-2.css` (W1-F'den beri stabil — hotfix CSS dokunmadı) |
| **Frontend recreate timestamp** | `2026-06-08T11:29:17Z` |
| **Backend recreate timestamp** | `2026-06-07T21:40:38Z` (revert deploy zamanı — **UNCHANGED**) |
| **11/11 servis** | Up/healthy |

### Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 14 hours (healthy)    ← UNCHANGED
celery_agent_worker     running   Up 6 days (healthy)       ← UNCHANGED
celery_beat             running   Up 6 days (healthy)       ← UNCHANGED
celery_default_worker   running   Up 6 days (healthy)       ← UNCHANGED
celery_worker           running   Up 6 days (healthy)       ← UNCHANGED
event_consumer          running   Up 6 days (healthy)       ← UNCHANGED
flower                  running   Up 8 days                 ← UNCHANGED
frontend                running   Up 39 seconds             ← RECREATED (ea83e12ce054)
nginx                   running   Up 9 days (healthy)       ← UNCHANGED
postgres                running   Up 9 days (healthy)       ← UNCHANGED
redis                   running   Up 9 days (healthy)       ← UNCHANGED
```

**10 servis uptime korundu**; sadece `frontend` recreate edildi (`--no-deps` koruması başarılı).

## Faz çıktıları

### P0 — Anchor
- git HEAD: `c0d4051` (Charon menu hotfix)
- alembic: `f9aeportpol`
- Frontend image: `918af213065a` / Backend: `25fc5d7218a5` (untouched)
- Bundle (önceki): `index-BhjtvSSz.js` + `index-uWsjMl-2.css`
- **Rollback tag:** `netmanager-frontend:rollback-pre-rbac-hotfix-20260608_1123` ✅

### P1 — git fetch + ff-merge
```
fetch: c0d4051..9d0a391 (2 commit incoming)
backend delta: 0 ✅
alembic delta: 0 ✅
frontend delta: 7 dosya
docs delta: 1 dosya
ff-merge: success
new HEAD: 9d0a391
```

### P2 — Frontend build
```
docker compose build frontend
build süresi: ~4 dk (vite + PWA + workbox)
yeni image: ea83e12ce054 (74.4 MB)
sha256: ea83e12ce054545679d07fae100e494a295177cc328593a0328a5a53511c2f06
```

### P3 — Frontend recreate (`--no-deps`)
```
docker compose up -d --no-deps frontend
→ frontend Up 7 sn
→ backend Up 14 hours (UNCHANGED)
→ Diğer 9 servis UNCHANGED
```

### P4 — Smoke + bundle hash + alembic

**Health endpoint:**
```
GET /health/ready → 200 OK
{"status":"ok","checks":{"db":"ok","redis":"ok","timescaledb":"ok","hypertable_count":5}}
```

**Kullanıcı talebi 17 sayfa:**
```
/discovery             HTTP/1.1 200 OK     ✅
/racks                 HTTP/1.1 200 OK     ✅
/floor-plan            HTTP/1.1 200 OK     ✅
/alert-rules           HTTP/1.1 200 OK     ✅
/permissions           HTTP/1.1 200 OK     ✅
/vlan                  HTTP/1.1 200 OK     ✅
/poe                   HTTP/1.1 200 OK     ✅
/sla                   HTTP/1.1 200 OK     ✅
/config-drift          HTTP/1.1 200 OK     ✅
/diagnostics           HTTP/1.1 200 OK     ✅
/approvals             HTTP/1.1 200 OK     ✅
/superadmin            HTTP/1.1 200 OK     ✅
/org-admin             HTTP/1.1 200 OK     ✅
/escalation-rules      HTTP/1.1 200 OK     ✅
/ai-assistant          HTTP/1.1 200 OK     ✅
/compliance            HTTP/1.1 200 OK     ✅
/change-management     HTTP/1.1 200 OK     ✅
```

> **Not:** Tüm route'lar nginx tarafından SPA fallback ile 200 döner; gerçek RBAC kararı React tarafında `RoleRoute hasPermission()` çalışmasıyla runtime'da verilir. Smoke yalnız bundle teslim doğrular; davranışı kullanıcı manuel browser smoke ile teyit eder (17 senaryo).

**Auth gate routes:**
```
/                      HTTP/1.1 301 Moved Permanently
/login                 HTTP/1.1 200 OK
/devices               HTTP/1.1 200 OK
/topology              HTTP/1.1 200 OK
```

**Yeni bundle hash:**
```
/assets/index-CAtRWoiO.js          ← YENİ (önceki index-BhjtvSSz.js)
/assets/index-uWsjMl-2.css         ← AYNI (CSS dokunmadı)
```

**Alembic UNCHANGED assert:**
```
alembic_version.version_num = f9aeportpol  ✅
```

### P5 — Servis matrisi + backend untouched

**Backend untouched assert:**
```
SERVICE   STATE     STATUS
backend   running   Up 14 hours (healthy)

IMAGE ID            SIZE      CREATED
25fc5d7218a5        425MB     14 hours ago    ← P0 anchor ile aynı
```

Image ID `25fc5d7218a5` = P0 anchor ile birebir. Backend container recreate edilmedi.

**Frontend log özet:**
- nginx başarıyla başladı
- 17 smoke route + 4 auth gate route 200/301 ile yanıtlandı
- Uygulama-kaynaklı error yok

### P6 — Bu doküman
`docs/SPRINT_1A_RBAC_DEPLOY_LOG_2026-06-08.md`

---

## Yeni bundle delta (önce → sonra)

| Asset | Charon menu hotfix (önce) | Sprint 1A RBAC (sonra) | Değişti mi |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `918af213065a` | **`ea83e12ce054`** | ✅ Yeni hash |
| JavaScript bundle | `index-BhjtvSSz.js` | **`index-CAtRWoiO.js`** | ✅ Yeni hash |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ Aynı (hotfix CSS dokunmadı) |

---

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `c0d4051c166f3b2e1916ceaa9d93ba91414b064b` (Charon menu hotfix) |
| alembic | `f9aeportpol` (aynı) |
| Frontend image | `918af213065a` → tag `netmanager-frontend:rollback-pre-rbac-hotfix-20260608_1123` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-rbac-hotfix-20260608_1123 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard c0d4051
# ~30-60 sn; backend / db / cache dokunulmaz
```

---

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build | ✅ |
| 2. Sadece frontend recreate | ✅ (backend UNCHANGED Up 14h) |
| 3. Backend rebuild/restart yok | ✅ |
| 4. DB migration yok | ✅ `f9aeportpol` UNCHANGED |
| 5. Postgres/Redis/Celery/Nginx restart yok | ✅ 9 servis Up 6-9 gün |
| 6. `--no-deps` zorunlu uygulandı | ✅ |
| 7. Frontend rollback tag alındı | ✅ |
| 8. Deploy log dokümanı | ✅ Bu doküman |

## Kullanıcıdan beklenen manuel browser smoke (17 senaryo)

| # | Senaryo | Beklenen |
|---|---|---|
| 1 | org_admin → `/discovery` | Açılır ✅ |
| 2 | org_admin → `/racks` | Açılır ✅ |
| 3 | org_admin → `/floor-plan` | Açılır ✅ |
| 4 | org_admin → `/alert-rules` | Açılır ✅ |
| 5 | org_admin → `/permissions` | Açılır ✅ |
| 6 | org_admin → `/vlan` | Açılır ✅ |
| 7 | org_admin → `/poe` | Açılır ✅ |
| 8 | org_admin → `/sla` | Açılır ✅ |
| 9 | org_admin → `/config-drift` | Açılır ✅ |
| 10 | org_admin → `/org-admin` | Açılır ✅ |
| 11 | org_admin → `/superadmin` | **Dashboard'a yönlenir** ✅ (regresyon yok) |
| 12 | super_admin → `/superadmin` | Açılır ✅ |
| 13 | super_admin → `/org-admin` | **Dashboard'a yönlenir** ✅ (excludeRoles) |
| 14 | viewer → `/diagnostics` | Açılır ✅ (operator→viewer fix) |
| 15 | viewer → `/vlan` | **Dashboard'a yönlenir** ✅ (escalation yok) |
| 16 | location_admin → `/approvals` | Açılır ✅ |
| 17 | Menüde görünen sayfa route guard'da blok | YOK (menü ↔ route hizalı) ✅ |

### Eğer sayfa açılır ama içeride API 403 görürsek

Bu **Sprint 1A kapsam dışı** — Backend ORG_ADMIN permission surface alignment **Sprint 1B**'de ele alınacak. Sprint 1A route-level + menu-level hotfix olarak kapanır.

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke 17 senaryo — kullanıcı doğrular |
| 2 | Sprint 1A resmi kapanış (memory entry) |
| 3 | Sprint 1B — Backend ORG_ADMIN permission surface alignment (kullanıcıdan GO bekler) |
| 4 | Sprint 1C — Yeni org bootstrap default Location/UserLocation (kullanıcıdan GO bekler) |
| 5 | Master rapor sonrası MFA Bug paketi (Sprint 1 ikinci kalemi) |
