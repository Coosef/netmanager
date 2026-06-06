# W1-F (LANG-FIX F1+F2+F3+Cleanup) — Frontend-Only Production Deploy Plan

**Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
**Hazırlandı:** 2026-06-07
**Branch:** `main` (W1-F1 + W1-F2 + W1-F3 + Final Audit + Cleanup — 5 PR merged)
**Kapsam:** Sadece **frontend** container yeniden inşa + restart. Backend / postgres / redis / celery / nginx / event_consumer / beat / flower **DOKUNULMAZ**.
**Deploy izni:** **AYRI GO BEKLENİYOR** — bu doküman plandır, deploy değil.

---

## Pre-deploy state (rollback anchor)

| | Değer |
|---|---|
| Son deploy | W1 (LANG-FIX A→E), 2026-06-05 |
| Prod git HEAD | `b32abe73cfdb4bf80b21585f351cff6544618be7` (b32abe7) |
| alembic current | `f9aeportpol` (DB migration **YOK**, korunacak) |
| Frontend image (mevcut) | `0095541547b5` (74.3 MB, 27 saat önce) |
| Backend image (untouched) | `68729bb4d50a` (425 MB, 2 gün önce, Up 2 days healthy) |
| Mevcut bundle hash | `/assets/index-eeQsrXWe.js` + `/assets/index-uWsjMl-2.css` |
| Tüm 11 servis | Up + healthy |
| Disk | 36 GB used / 8.8 GB free / 81% |

## Hedef state (post-deploy)

| | Değer |
|---|---|
| Yeni git HEAD | `888d94bec3b1d72179a5457bedaf8234d4911676` (888d94b) |
| alembic current | `f9aeportpol` (**değişmez**) |
| Backend image | aynı (dokunulmaz) |
| Frontend image (yeni) | Build sırasında belirlenecek |
| Beklenen yeni JS bundle | `index-CsqJTcFl.js` (lokal build doğrulandı) |
| Beklenen yeni CSS | `index-uWsjMl-2.css` (lokal build CSS hash değişmedi — locale-only PR'ları beklenen) |

---

## Delta analiz — `b32abe7..888d94b`

**7 commit, 16 dosya değişikliği. Tamamı frontend + docs.**

| Kapsam | Dosya sayısı | Toplam delta |
|---|---:|---|
| `frontend/src/i18n/locales/*.json` | 4 | 4 dil locale güncellemeleri |
| `frontend/src/pages/*` (TSX) | 11 | TerminalSessions + 5 Settings + Users + 4 Devices (synonym konsolidasyon) |
| `docs/` | 2 | W1 deploy log + W1-F final audit |
| `backend/` `alembic/` `agent/` `scripts/` | **0** ✅ | **Sıfır backend delta** |

Commit zinciri:
```
888d94b  W1-F cleanup (residual toasts + locale gaps + synonym)
3e48ef6  W1-F Final Audit (docs)
57c4ee4  W1-F3 Users
2921e7e  W1-F2 Settings
446ae4f  W1-F1 TerminalSessions
6e8d176  W1 deploy log merge (W1 deploy paketinden)
aa8440c  W1 deploy log doc (W1 deploy paketinden)
```

> **Kritik:** Backend container bu deploy ile dokunulmaz. Backend code disk'te güncellenmez (zaten frontend-only commits). W1 deploy'undaki "37 backend HF kaçık" benzeri sürpriz **bu deploy'da yok**.

---

## Smoke pipeline — lokal final state

```
$ ./node_modules/.bin/tsc --noEmit              → 0 hata ✅
$ ./node_modules/.bin/vitest run                → 232/232 PASS (25 dosya, 1.82s) ✅
$ ./node_modules/.bin/vite build                → ✓ built in 7.65s ✅
$ npm run i18n:check                            → 201 eksik (sırf W3 scope, widening yok) ✅
```

### Final locale durumu

| Dil | Key sayısı | Eksik | Açıklama |
|---|---:|---:|---|
| **tr (baseline)** | **2 286** | 0 | — |
| **en** | **2 243** | **43** | `help.faq_*` (W3 scope) |
| **de** | **2 207** | **79** | `help.faq_*` (W3 scope) |
| **ru** | **2 207** | **79** | `help.faq_*` (W3 scope) |
| **Toplam** | — | **201** | **sırf W3 scope** |

W1-F cleanup ile 14 pre-existing DE/RU gap kapatıldı (devices.bulk_fetch_info_* + topology.blast_*). Kalan 201 deploy bloklayıcısı değil (yardım sayfası FAQ W3 sprint scope'unda).

### Build artefaktları (`dist/assets/`)

```
index-CsqJTcFl.js          ← YENİ (W1 prod: index-eeQsrXWe.js)
index-uWsjMl-2.css         ← AYNI (CSS değişmedi — locale-only update)
```

---

## Deploy Adımları (W1 deploy paterniyle)

> ⚠️ Her adımı **kullanıcı explicit Deploy GO** sonrasında yürütüyorum. Bu plan referans niteliğinde.

### P0 — Anchor (read-only)

```bash
ssh root@93.180.133.88
cd /opt/netmanager

# Mevcut state kaydet
echo '--- pre-deploy anchor ---'
git rev-parse HEAD                                     # bekleniyor: b32abe7
docker compose images frontend                         # bekleniyor: 0095541547b5
docker compose images backend                          # backend untouched assert

# Rollback tag oluştur
ROLLBACK_TAG="netmanager-frontend:rollback-pre-w1f-$(date +%Y%m%d_%H%M)"
docker tag 0095541547b5 "$ROLLBACK_TAG"
echo "Rollback tag: $ROLLBACK_TAG"
docker images netmanager-frontend | head -5

# Disk + servisler
df -h / | tail -1
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'

# Mevcut bundle hash (curl localhost)
curl -ks http://localhost/login | grep -oE '/assets/[A-Za-z0-9_-]+\.(js|css)' | sort -u
```

### P1 — Git pull (ff-only)

```bash
git fetch origin main
# delta önizleme
echo '--- gelen commit'ler ---'
git log --oneline HEAD..origin/main
echo '--- backend/alembic delta (sıfır olmalı) ---'
git diff --name-only HEAD..origin/main | grep -E '^(backend|alembic|agent|scripts)/' || echo "✓ Hiç backend dosyası dokunulmamış"
echo '--- frontend delta ---'
git diff --shortstat HEAD..origin/main -- frontend/

# ff-merge
git merge --ff-only origin/main
echo '--- new HEAD ---'
git rev-parse HEAD          # bekleniyor: 888d94b
git log --oneline -1
```

### P2 — Frontend build (sadece)

```bash
# SSH disconnect koruması — nohup veya tmux önerilir (W1 deploy notları)
# Build ~3-5dk; dockerd arka planda devam eder, SSH koptu mu önemli değil
docker compose build frontend 2>&1 | tail -25

# Build sonu yeni image
docker compose images frontend
docker images netmanager-frontend | head -5
```

### P3 — Frontend recreate (`--no-deps` ZORUNLU)

```bash
# KRITIK: --no-deps backend/celery/redis/postgres/nginx'a dokunmama garantisi
docker compose up -d --no-deps frontend

sleep 5

# Doğrulama
docker compose ps frontend                             # frontend: Up X seconds
docker compose ps backend                              # backend: Up 2+ days (UNCHANGED)
docker compose ps celery_default_worker celery_worker celery_agent_worker celery_beat event_consumer postgres redis nginx
```

### P4 — Curl smoke

```bash
echo '=== HEALTH ==='
curl -ks http://localhost/health/ready

echo
echo '=== ROUTES ==='
for path in / /login /devices /users /settings /terminal-sessions; do
  printf "%-22s " "$path"
  curl -ksI "http://localhost$path" | head -1
done

echo
echo '=== NEW BUNDLE HASH ==='
curl -ks http://localhost/login | grep -oE '/assets/[A-Za-z0-9_-]+\.(js|css)' | sort -u
# Beklenen: index-CsqJTcFl.js (yeni) + index-uWsjMl-2.css (CSS değişmedi)
```

### P5 — Container log + backend untouched assert

```bash
echo '=== FRONTEND CONTAINER LOG (son 25 satır) ==='
docker compose logs --tail=25 frontend | grep -v 'level=warning'

echo
echo '=== BACKEND UNTOUCHED ASSERT ==='
docker compose ps backend --format '{{.Service}}: {{.Status}}'
docker compose images backend | tail -2
# image ID = 68729bb4d50a (W1 deploy'dan beri aynı) olmalı
```

### P6 — Post-deploy artefakt

Deploy log dokümanı: `docs/W1F_DEPLOY_LOG_2026-06-07.md` (W1_DEPLOY_LOG_2026-06-05 paterniyle).

---

## Rollback procedure

### Senaryo: Frontend bundle bozuk / browser smoke fail / 5xx spike

```bash
cd /opt/netmanager
# Pre-deploy image ID
PREVIOUS_IMAGE=0095541547b5
docker tag $PREVIOUS_IMAGE netmanager-frontend:latest
docker compose up -d --no-deps frontend
# Doğrula:
docker compose ps frontend                             # eski image aktif
# git tarafında geri al:
git reset --hard b32abe7
git rev-parse HEAD                                     # b32abe7 olmalı
```

**Rollback süresi:** ~30-60sn (image swap + container restart).

### Rollback eşikleri

- `/health/ready` 200 değil
- `/login` / `/users` / `/settings` / `/terminal-sessions` 5xx
- Browser smoke matrisinde **2+ ekran-dil hücresi** fail
- Console error: i18n missing keys 1+ canlı sayfada

---

## Browser smoke matrisi (kullanıcı tarafında)

7 ekran × 4 dil = **28 hücre**:

| Ekran | TR | EN | DE | RU |
|---|---|---|---|---|
| Dashboard (regresyon) | ☐ | ☐ | ☐ | ☐ |
| Devices listesi (regresyon) | ☐ | ☐ | ☐ | ☐ |
| DeviceDetail 10 tab (regresyon) | ☐ | ☐ | ☐ | ☐ |
| Racks (regresyon) | ☐ | ☐ | ☐ | ☐ |
| **TerminalSessions** (W1-F1 yeni) | ☐ | ☐ | ☐ | ☐ |
| **Settings** (12 tab — W1-F2 yeni) | ☐ | ☐ | ☐ | ☐ |
| **Users** (W1-F3 yeni) | ☐ | ☐ | ☐ | ☐ |

**Her hücrede kontrol edilecek:**
- ✅ Header / Sidebar / breadcrumb tam çevrili
- ✅ Tablo kolon başlıkları çevrili
- ✅ Buton metinleri (Save / Cancel / Refresh / Apply / Delete / Update / Create)
- ✅ Modal/Drawer title + form label + placeholder + validation message
- ✅ Toast (en az 1 aksiyon → örn. invite revoke → "Davet iptal edilemedi" / `Invite could not be revoked`)
- ✅ Tarih formatı locale uyumlu (dayjs + AntD ConfigProvider)
- ❌ Türkçe fragment görünmemeli (KURAL keepers hariç: vendor adı, MAC/CPU/PoE akronimleri, "Catalyst 2960" placeholder vd.)
- ❌ Konsol "missing-key" warning yok

---

## Sonraki adımlar (deploy GO sonrası)

| Sıra | İş |
|---|---|
| 1 | `docs/W1F_DEPLOY_LOG_2026-06-07.md` deploy log dokümanı yaz |
| 2 | Browser smoke matrisi 28 hücre kullanıcı doğrulaması |
| 3 | W1-F resmi kapanış (memory + reference) |
| 4 | **SSH Session Termination implementation** (PR #7 tasarım baseline) |
| 5 | SSH Session Termination deploy (backend + frontend birlikte; backend image rebuild gerekli) |
| 6 | **LANG-FIX-W2** sprint planlaması (Agents 185 / Monitor 166 / Topology 130 / Playbooks 105 / BackupCenter 101 / Reports 99 — en büyük 6 sayfa ~786 finding) |

---

## Onay matrisi

| Aşama | Onay |
|---|---|
| Deploy planı oku + onay | ⏳ |
| **Deploy GO** | ⏳ (kullanıcı explicit) |
| P0..P6 yürütme | (GO sonrası) |
| Browser smoke 28/28 PASS | (yürütme sonrası) |
| Post-deploy LOG yazılması | (smoke sonrası) |

**Plan tek başına deploy etmez.** Kullanıcı explicit "deploy GO" demediği sürece bu doküman referans niteliğindedir.
