# Charon Menu Hotfix — Production Deploy Log — 2026-06-08

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only hotfix deploy. Backend / postgres / redis / celery / nginx **DOKUNULMADI**.
> Sorun 1 (Topology MenuGroupNav sticky) + Sorun 2 (Keşif Envanteri tek tab) düzeltildi.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `7f0c601` (menu restructure Faz 3) → **`c0d4051`** (hotfix)
- **Kapsam:** PR #28 hotfix (8 dosya, +55 / -33)
  - `.nm-mg-nav` sticky + z-index:5 + bg → Topology'de MenuGroupNav görünür
  - `lldp` tab silindi → tek "Keşif Envanteri" tab (4 dil)
- **DB:** Migration **YOK** — `f9aeportpol` korundu.
- **Frontend:** Bundle `index-J3daMLb0.js` → **`index-BhjtvSSz.js`** + `index-uWsjMl-2.css` (CSS aynı)
- **Backend:** Container **dokunulmadı** — image `25fc5d7218a5`, Up 11 hours healthy.
- **Kesinti:** Frontend ~7sn nginx static recreate; backend / db / cache **0sn**.

## Final state (POST-DEPLOY ANCHOR)

| | Değer |
|---|---|
| **VPS HEAD** | **`c0d4051c166f3b2e1916ceaa9d93ba91414b064b`** (c0d4051, main) |
| **alembic current** | `f9aeportpol` (DB migration yok, **UNCHANGED** ✅) |
| **Önceki frontend image** | `d6bf660c5e1b` (74.4 MB, 1 saat önce — menu restructure deploy) |
| **Yeni frontend image** | **`sha256:918af213065afad18ef4c21c934f21b376ca7ec402a56bcdd9b51a7584ae3eb5`** (74.4 MB) |
| **Backend image (untouched)** | `25fc5d7218a5` (425 MB, **UNCHANGED**) |
| **Frontend rollback tag** | `netmanager-frontend:rollback-pre-menu-hotfix-20260608_0900` → `d6bf660c5e1b` |
| **Önceki JS bundle** | `index-J3daMLb0.js` |
| **Yeni JS bundle** | **`index-BhjtvSSz.js`** ✅ |
| **CSS bundle** | `index-uWsjMl-2.css` (W1-F'den beri aynı — hotfix CSS-only, .nm-mg-nav inline style'da) |
| **Frontend recreate timestamp** | `2026-06-08T09:06:10Z` |
| **Backend recreate timestamp** | `2026-06-07T21:40:38Z` (revert deploy zamanı — **UNCHANGED**) |
| **11/11 servis** | Up/healthy |
| **Disk** | 36 GB used / 8.6 GB free / 81% |

### Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 11 hours (healthy)    ← UNCHANGED
celery_agent_worker     running   Up 6 days (healthy)       ← UNCHANGED
celery_beat             running   Up 6 days (healthy)       ← UNCHANGED
celery_default_worker   running   Up 6 days (healthy)       ← UNCHANGED
celery_worker           running   Up 6 days (healthy)       ← UNCHANGED
event_consumer          running   Up 6 days (healthy)       ← UNCHANGED
flower                  running   Up 7 days                 ← UNCHANGED
frontend                running   Up 43 seconds             ← RECREATED (918af213065a)
nginx                   running   Up 9 days (healthy)       ← UNCHANGED
postgres                running   Up 9 days (healthy)       ← UNCHANGED
redis                   running   Up 9 days (healthy)       ← UNCHANGED
```

**10 servis uptime korundu**; sadece `frontend` recreate edildi (`--no-deps` koruması başarılı).

## Faz çıktıları

### P0 — Anchor

```
git HEAD:        7f0c601 (menu restructure Faz 3)
alembic:         f9aeportpol
Frontend image:  d6bf660c5e1b (74.4 MB)
Backend image:   25fc5d7218a5 (untouched)
Bundle (önceki): index-J3daMLb0.js + index-uWsjMl-2.css
```

Rollback tag: `netmanager-frontend:rollback-pre-menu-hotfix-20260608_0900` ✅

### P1 — git fetch + ff-merge

```
fetch:           7f0c601..c0d4051 (3 commit incoming)
backend delta:   0 ✅
alembic delta:   0 ✅
frontend delta:  8 dosya
ff-merge:        success
new HEAD:        c0d4051
```

### P2 — Frontend build

```
docker compose build frontend
build süresi: ~4dk (vite + PWA)
yeni image:   918af213065a (74.4 MB)
sha256:       918af213065afad18ef4c21c934f21b376ca7ec402a56bcdd9b51a7584ae3eb5
```

### P3 — Frontend recreate (`--no-deps`)

```
docker compose up -d --no-deps frontend
→ frontend Up 7sn
→ backend Up 11 hours (UNCHANGED)
→ Diğer 9 servis UNCHANGED
```

### P4 — Smoke + bundle hash + alembic

**Health endpoint:**
```
GET /health/ready → 200 OK
{"status":"ok","checks":{"db":"ok","redis":"ok","timescaledb":"ok","hypertable_count":5}}
```

**Kullanıcı talebi 7 Ağ Envanteri route:**
```
/devices               HTTP/1.1 200 OK     ✅
/topology              HTTP/1.1 200 OK     ✅ (sticky MenuGroupNav görünür)
/discovery             HTTP/1.1 200 OK     ✅ (Keşif Envanteri tab)
/ipam                  HTTP/1.1 200 OK     ✅
/vlan                  HTTP/1.1 200 OK     ✅
/racks                 HTTP/1.1 200 OK     ✅
/floor-plan            HTTP/1.1 200 OK     ✅
```

**Ek smoke routes:**
```
/                      HTTP/1.1 301 Moved Permanently
/login                 HTTP/1.1 200 OK     ✅
/settings              HTTP/1.1 200 OK     ✅
/users                 HTTP/1.1 200 OK     ✅
/terminal-sessions     HTTP/1.1 200 OK     ✅
/audit-log             HTTP/1.1 200 OK     ✅
```

**Yeni bundle hash:**
```
/assets/index-BhjtvSSz.js          ← YENİ (önceki index-J3daMLb0.js)
/assets/index-uWsjMl-2.css         ← AYNI (CSS inline style, vite bundle'a embed)
```

**Alembic UNCHANGED assert:**
```
alembic_version.version_num = f9aeportpol  ✅
```

### P5 — Servis matrisi + backend untouched

**Backend untouched assert:**
```
SERVICE   STATE     STATUS
backend   running   Up 11 hours (healthy)

IMAGE ID            SIZE      CREATED
25fc5d7218a5        425MB     11 hours ago    ← P0 anchor ile aynı
```

Image ID `25fc5d7218a5` = P0 anchor ile birebir. Backend container recreate edilmedi.

**Frontend log özet:**
- nginx başarıyla başladı
- 13 smoke route 200/301 ile yanıtlandı
- Uygulama-kaynaklı error yok

### P6 — Post-deploy artefakt

Bu doküman: `docs/CHARON_MENU_HOTFIX_DEPLOY_LOG_2026-06-08.md`.

---

## Yeni bundle delta (önce → sonra)

| Asset | Menu restructure (önce) | Hotfix (sonra) | Değişti mi |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `d6bf660c5e1b` | **`918af213065a`** | ✅ Yeni hash |
| JavaScript bundle | `index-J3daMLb0.js` | **`index-BhjtvSSz.js`** | ✅ Yeni hash |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ Aynı (CSS inline style'da) |

---

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `7f0c601f740ae7bb77075384a2b07863fdb1e64f` (menu restructure Faz 3) |
| alembic | `f9aeportpol` (aynı) |
| Frontend image | `d6bf660c5e1b` → tag `netmanager-frontend:rollback-pre-menu-hotfix-20260608_0900` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-menu-hotfix-20260608_0900 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 7f0c601
# ~30-60sn; backend / db / cache dokunulmaz
```

---

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build | ✅ |
| 2. Sadece frontend recreate | ✅ (backend UNCHANGED Up 11h) |
| 3. Backend rebuild/restart yok | ✅ |
| 4. DB migration yok | ✅ `f9aeportpol` UNCHANGED |
| 5. Postgres/Redis/Celery/Nginx restart edilmedi | ✅ 9 servis Up 6+ days |
| 6. `--no-deps` zorunlu uygulandı | ✅ |
| 7. Frontend rollback tag alındı | ✅ |
| 8. Deploy log dokümanı | ✅ Bu doküman |

## Kullanıcıdan beklenen manuel browser smoke

| # | Senaryo | Beklenen |
|---|---|---|
| 1 | `/devices` → Ağ Envanteri tab strip görünür | ✅ |
| 2 | `/topology` → Ağ Envanteri tab strip görünür, **Topology aktif** | ✅ (sticky overlay) |
| 3 | `/discovery` → Tab adı **"Keşif Envanteri"** | ✅ |
| 4 | `/discovery` sayfası beyaz ekran VERMEZ | ✅ (LldpInventoryPage render) |
| 5 | `/lldp-inventory` tab artık görünmez | ✅ (menuGroups'ten silindi) |
| 6 | IP Scanner görünmez | ✅ (kapsam dışı, önceki karar) |
| 7 | Sidebar 12 ana grup korunur | ✅ |
| 8 | Yetkisiz tab davranışı bozulmamış olur | ✅ (RBAC helper'lar dokunulmadı) |

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke 8 senaryo — kullanıcı doğrular |
| 2 | Charon menu restructure + hotfix resmi kapanış |
| 3 | Yeni UI değişikliği (kullanıcı yeni plan paylaşacak) |
