# Charon Menu Restructure — Production Deploy Log — 2026-06-08

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only deploy (W1-F paterni). Backend / postgres / redis / celery / nginx **DOKUNULMADI**.
> Sidebar 54 düz öğeden 12 ana gruba indirildi; sayfa içi yatay tab strip (MenuGroupNav) live.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `7c65764` (SSH Term revert deploy) → **`7f0c601`** (menu restructure Faz 2 + Faz 3)
- **Kapsam:** Charon menu restructure Faz 2 + Faz 3
  - Faz 2: `utils/menuGroups.ts` helper + 60 i18n key × 4 dil
  - Faz 3: useNavGroups/Sidebar/TopNav refactor + yeni MenuGroupNav + AppLayout CSS
  - 12 dosya frontend değişimi (6 modified + 4 new + 2 i18n) — backend 0 dosya
- **DB:** Migration **YOK** — `f9aeportpol` korundu.
- **Compose/network/env:** Değişiklik **YOK**.
- **Frontend:** Bundle `index-CsqJTcFl.js` (revert state) → **`index-J3daMLb0.js`** + `index-uWsjMl-2.css` (CSS aynı)
- **Backend:** Container **dokunulmadı** — image `25fc5d7218a5` aynı, Up 10 hours healthy.
- **Kesinti:** Frontend ~8sn nginx static recreate; backend / db / cache **0sn**.

## Final state (POST-DEPLOY ANCHOR)

| | Değer |
|---|---|
| **VPS HEAD** | **`7f0c601f740ae7bb77075384a2b07863fdb1e64f`** (7f0c601, main) |
| **alembic current** | `f9aeportpol` (DB migration yok, **UNCHANGED** ✅) |
| **Önceki frontend image** | `dbe6adff060d` (74.4 MB, 10 saat önce — SSH Term revert build) |
| **Yeni frontend image** | **`sha256:d6bf660c5e1b77acb6fa0e4e3c44af00e262ea3f9b911e576887d3d5a0bf810f`** (74.4 MB, build 234s) |
| **Backend image (untouched)** | `25fc5d7218a5` (425 MB, **UNCHANGED**) |
| **Frontend rollback tag** | `netmanager-frontend:rollback-pre-menu-restructure-20260608_0750` → `dbe6adff060d` |
| **Önceki JS bundle** | `index-CsqJTcFl.js` (SSH Term revert = W1-F bundle birebir) |
| **Yeni JS bundle** | **`index-J3daMLb0.js`** ✅ |
| **CSS bundle** | `index-uWsjMl-2.css` (W1-F'den beri aynı — refactor component-level, stil değişmedi) |
| **Frontend recreate timestamp** | `2026-06-08T07:56:03Z` |
| **Backend recreate timestamp** | `2026-06-07T21:40:38Z` (revert deploy zamanı — **UNCHANGED**) |
| **11/11 servis** | Up/healthy |
| **Disk** | 36 GB used / 8.7 GB free / 81% |

### Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 10 hours (healthy)     ← UNCHANGED
celery_agent_worker     running   Up 6 days (healthy)        ← UNCHANGED
celery_beat             running   Up 6 days (healthy)        ← UNCHANGED
celery_default_worker   running   Up 6 days (healthy)        ← UNCHANGED
celery_worker           running   Up 6 days (healthy)        ← UNCHANGED
event_consumer          running   Up 6 days (healthy)        ← UNCHANGED
flower                  running   Up 7 days                  ← UNCHANGED
frontend                running   Up 54 seconds              ← RECREATED (yeni image d6bf660c5e1b)
nginx                   running   Up 9 days (healthy)        ← UNCHANGED
postgres                running   Up 9 days (healthy)        ← UNCHANGED
redis                   running   Up 9 days (healthy)        ← UNCHANGED
```

**10 servis uptime korundu**; sadece `frontend` recreate edildi (`--no-deps` koruması başarılı).

## PRE-DEPLOY ROLLBACK ANCHOR (geri-dönüş için saklı)

| | Değer |
|---|---|
| git | `7c6576404eac4e5fbd63e6306faab87bbdc81fe0` (SSH Term revert state) |
| alembic | `f9aeportpol` (aynı — DB migration yok) |
| Frontend image | `dbe6adff060d` → tag `netmanager-frontend:rollback-pre-menu-restructure-20260608_0750` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-menu-restructure-20260608_0750 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 7c65764
# ~30-60sn; backend / db / cache dokunulmaz
```

---

## Faz çıktıları

### P0 — Anchor (pre-deploy)

```
git HEAD:        7c65764 (SSH Term revert deploy)
alembic:         f9aeportpol
Frontend image:  dbe6adff060d (74.4 MB, 10 saat önce)
Backend image:   25fc5d7218a5 (425 MB, 10 saat önce — untouched)
Bundle (önceki): index-CsqJTcFl.js + index-uWsjMl-2.css
11/11 services Up + healthy
Disk: 36G / 8.7G free / 81%
```

Rollback tag: `netmanager-frontend:rollback-pre-menu-restructure-20260608_0750` ✅

### P1 — git fetch + ff-merge

```
fetch:           7c65764..7f0c601 (4 commit incoming)
backend delta:   0 dosya ✅
alembic delta:   0 dosya ✅
frontend delta:  12 dosya
docs delta:      2 dosya
ff-merge:        success
new HEAD:        7f0c601
```

Commit zinciri:
```
7f0c601  feat(menu): Charon menu restructure Faz 3 — Sidebar 12 grup + MenuGroupNav
5e37c1d  feat(menu): Charon menu restructure Faz 2 — helper + i18n + test
1ac4d95  docs(plan): Charon menu restructure — analysis + implementation plan
a3f1749  docs(deploy): SSH Termination revert production deploy log (2026-06-07)
```

### P2 — Frontend build

```
docker compose build frontend
build süresi: 234.0s (~4 dakika — vite + PWA + workbox)
yeni image:   d6bf660c5e1b (74.4 MB)
sha256:       d6bf660c5e1b77acb6fa0e4e3c44af00e262ea3f9b911e576887d3d5a0bf810f
```

### P3 — Frontend recreate (`--no-deps`)

```
docker compose up -d --no-deps frontend
→ Container netmanager-frontend-1  Recreated + Started
→ frontend Up 8 saniye (yeni image d6bf660c5e1b)
→ backend Up 10 hours (UNCHANGED)
→ Diğer servisler (celery×3, beat, event_consumer, flower, nginx,
  postgres, redis) TÜMÜ uptime korundu (6-9 gün arası)
```

`--no-deps` koruması başarılı.

### P4 — Smoke + bundle hash + alembic

**Health endpoint:**
```
GET /health/ready
{"status":"ok","checks":{"db":"ok","redis":"ok","timescaledb":"ok","hypertable_count":5}}
```

**HTTP routes (kullanıcı talebi):**
```
/                          HTTP/1.1 301 Moved Permanently
/login                     HTTP/1.1 200 OK     ✅
/devices                   HTTP/1.1 200 OK     ✅
/settings                  HTTP/1.1 200 OK     ✅
/users                     HTTP/1.1 200 OK     ✅
/terminal-sessions         HTTP/1.1 200 OK     ✅
/audit-log                 HTTP/1.1 200 OK     ✅
```

**Yeni bundle hash:**
```
/assets/index-J3daMLb0.js          ← YENİ (önceki index-CsqJTcFl.js)
/assets/index-uWsjMl-2.css         ← AYNI (W1-F'den beri — refactor stil değişimi yapmadı)
```

**Alembic UNCHANGED assert:**
```
alembic_version.version_num = f9aeportpol
(beklenen: f9aeportpol — DEĞIŞMEDİ) ✅
```

### P5 — Servis matrisi + backend untouched

**11 servis matrisi:** Yukarıda final state tablosu (10 UNCHANGED + 1 RECREATED).

**Backend untouched assert:**
```
SERVICE   STATE     STATUS
backend   running   Up 10 hours (healthy)

CONTAINER              IMAGE ID            SIZE     CREATED
netmanager-backend-1   25fc5d7218a5        425MB    10 hours ago
```

Image ID `25fc5d7218a5` = P0 anchor ile birebir aynı. Backend container recreate edilmedi.

**Frontend log özet:**
- nginx 1.31.1 başarıyla başladı (4 worker process)
- 7 smoke route 200/301 ile yanıtlandı
- Uygulama-kaynaklı error yok

**Backend log özet:**
- Sadece agent WS bağlantı denemeleri (403 forbidden — beklenmedik agent client'lardan, normal)
- Yeni endpoint çağrısı yok (frontend menü refactor backend'i etkilemedi)
- Uygulama-kaynaklı error yok

### P6 — Post-deploy artefakt

Bu doküman: `docs/CHARON_MENU_RESTRUCTURE_DEPLOY_LOG_2026-06-08.md`.

---

## Yeni bundle delta (önce → sonra)

| Asset | SSH Term revert (önce) | Menu restructure (sonra) | Değişti mi |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `dbe6adff060d` | **`d6bf660c5e1b`** | ✅ Yeni hash |
| JavaScript bundle | `index-CsqJTcFl.js` | **`index-J3daMLb0.js`** | ✅ Yeni hash |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ Aynı (W1-F'den beri stabil) |
| Service Worker | `registerSW.js` | `registerSW.js` | (auto-versioned) |

**JS bundle yeni** çünkü 4 component refactor + yeni MenuGroupNav + i18n key dağıtımı. **CSS aynı** çünkü AppLayout'a eklenen `.nm-mg-nav` + `.nm-mg-tab` CSS inline `<style>` içinde (LAYOUT_CSS string'ine eklenmişti), ayrı CSS dosyasında değil — vite bundle'a embed.

---

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build edildi | ✅ |
| 2. Sadece frontend container recreate | ✅ (backend UNCHANGED) |
| 3. Backend build/restart yok | ✅ |
| 4. DB migration yok | ✅ `f9aeportpol` UNCHANGED |
| 5. Postgres / Redis / Celery / Nginx restart edilmedi | ✅ 10 servis Up 6+ days |
| 6. `--no-deps` zorunlu uygulandı | ✅ |
| 7. Rollback tag alındı | ✅ P0'da |
| 8. Deploy log dokümanı | ✅ Bu doküman |

---

## Kullanıcıdan beklenen manuel browser smoke

| # | Senaryo | Beklenen |
|---|---|---|
| 1 | Sidebar 12 ana grup görünüyor mu? | ✅ Dashboard + 11 ana grup |
| 2 | Dashboard aktif mi? | ✅ `/` rotası, active highlight |
| 3 | Ağ Envanteri tabları (8) doğru mu? | ✅ Switch, Topoloji, Keşif, IPAM, VLAN, Kabinler, Harita, LLDP Envanteri |
| 4 | İzleme & Analitik tabları (6) doğru mu? | ✅ Uyarılar, Canlı İzleme, Ağ Analitik, Bant Genişliği, Port Intelligence, Synthetic Probes |
| 5 | Uyarı & Olay Yönetimi tabları (4) doğru mu? | ✅ Uyarı Kuralları, Escalation, Incident / RCA, Servis Etki Haritası |
| 6 | Konfigürasyon Yönetimi tabları (6) doğru mu? | ✅ Config Drift, Config Şablonları, Config Builder, Yedekleme Merkezi, Firmware, Sürücü Şablonları |
| 7 | Operasyon Araçları IP Scanner gösteriyor mu? | ❌ **HAYIR (2 tab: Ağ Tanılama, AI Ağ Asistanı)** |
| 8 | LldpInventory Ağ Envanteri altında mı? | ✅ inventory.lldp tab |
| 9 | OrgAdmin sadece org_admin için Platform Yönetimi altında mı? | ✅ super_admin görmez (excludeSuperAdmin) |
| 10 | TerminalSessions read-only Denetim & Kayıtlar altında mı? | ✅ admin_audit.ssh tab |
| 11 | Yetkisiz tablar gizleniyor mu? | ✅ canSeeTab cascade (4 rol × 12 grup) |
| 12 | Route/bookmark/deep linkler kırılmamış mı? | ✅ Tüm 57 route aynen (URL korundu) |

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke (12 senaryo) — kullanıcı doğrular |
| 2 | Charon menu restructure resmi kapanış (memory entry) |
| 3 | Sonraki UI değişikliği (kullanıcı yeni plan paylaşacak) |

---

## Smoke fail / rollback eşikleri (referans)

- Sidebar 12 grup render fail
- MenuGroupNav crash
- Permission filter bug (yetkisi olmayan tab görünür)
- Browser refresh sonrası aktif grup kayboluyor
- Console "missing-key" warning (i18n nav.group.*)
- Yeni JS bundle yüklenmiyor (404)

**Rollback komutu** (1 rollback tag mevcut):

```bash
docker tag netmanager-frontend:rollback-pre-menu-restructure-20260608_0750 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 7c65764
```

Süre: ~30-60sn. Backend / db / cache / celery / nginx dokunulmaz.
