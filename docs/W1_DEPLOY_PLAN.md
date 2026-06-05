# W1 (LANG-FIX A→E) — Frontend-Only Production Deploy Plan

**Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
**Tarih:** 2026-06-05 (deploy planlanıyor)
**Branch:** `main` (W1 PR #4 rebase-merge sonrası)
**Kapsam:** Sadece **frontend** container yeniden inşa + restart. Backend / postgres / redis / celery / nginx / event_consumer / beat / flower **DOKUNULMAZ**.
**Deploy izni:** **AYRI GO BEKLENİYOR** — bu doküman plandır, deploy değil.

---

## Pre-deploy state (rollback anchor)

| | Değer |
|---|---|
| Son deploy | Wave 3.1 (2026-06-01) |
| Prod git HEAD | `c26c1f4` (Wave 3.1 follow-up merge) |
| alembic current | `f9aeportpol` (DB migration **YOK**, korunacak) |
| Backend image | son W3.1 build (dokunulmaz) |
| Frontend image | son W2.2 build (yenilecek) |

## Hedef state (post-deploy)

| | Değer |
|---|---|
| Yeni git HEAD | `ec678f0` (W1-E `i18n(frontend): LANG-FIX-W1-E …`) |
| alembic current | `f9aeportpol` (**değişmez**) |
| Backend image | aynı (dokunulmaz) |
| Frontend image | yeni build |
| Bundle hash | yeni `index-*.js` + `index-*.css` |

## ⚠️ Kritik uyarı — unreleased backend changes git'e dahil

`c26c1f4..ec678f0` arasında **43 commit** var. Frontend dosyalarına dokunan sadece **6'sı** (LANG-INFRA + W1-A..E). **37 backend / agent / driver / worker commit'i prod'da KAÇIK** (bu deploy ile aktive edilmiyor):

| Eksik backend paketi | Commit aralığı | Kapsamı |
|---|---|---|
| HF#1..#13 incident hotfix'leri | 0ba87ce → 99f72b6 | DeviceForm validation, agent installer router, credential resolve, agent WS race, test endpoint state, monitor_tasks RLS, Aruba PoE parser, vault payload, topology RLS stamp |
| QF-2 / QF-5 | baf8a75 | Agent pool per-conn lock + timeout audit |
| QF-7 | 30ef259 | Super-admin assign modal'da agent+device lokasyon transferi |
| W3.3 PoE backend | 6fc363c, 6812d0f | PoE single/bulk/restart + rollback |

Bu commit'ler `git pull` ile dosyaya iner ama backend container **rebuild edilmediği** sürece çalışmaz. **Sonraki backend deploy'unda hepsi birden aktif olur** — ayrı plan + smoke gerektirecek.

> **Bu durum bilinen ve kabul edilen bir trade-off:** Wave 1 (2026-06-01) ve Wave 2 (2026-06-01) deploy'ları da aynı paterni izlemişti. Bu hotfix'lerin ayrı bir "backend catch-up" sprint'iyle deploy edilmesi gerekir; W1-F sonrası planlanmalı.

---

## Cherry-pick alternative (DEĞERLENDİRME)

Eğer bu trade-off kabul edilmek istenmiyorsa, **alternatif Path B**: prod baseline'dan (`c26c1f4`) cherry-pick branch'i:

```bash
# yerel
git checkout -b deploy/w1-frontend-only c26c1f4
git cherry-pick 9aa5ac4..804434a  # LANG-INFRA (2 commit)
git cherry-pick 4e5e362^..ec678f0 # W1-A..E (5 commit, lineer)
git push origin deploy/w1-frontend-only
# VPS'te: git fetch origin && git checkout deploy/w1-frontend-only
```

**Avantaj:** Backend kodu prod'da kalır; gelecek backend rebuild "kaçık" HF setini aktive etmez.
**Dezavantaj:** Branch ayrı kalır; main'le tekrar senkron olmak için reset/merge gerekir; HF'ler hâlâ deploy beklemekte.

**Öneri:** **Path A (main pull + frontend-only build)** ile devam edilsin (proven pattern, Wave 2/3 deploy'larında doğrulandı). Path B ancak kullanıcı HF'lerin geleceğini bilinçli olarak iletmek istemiyorsa.

---

## Deploy Adımları (Path A — proven pattern)

### P0 — Rollback anchor (read-only)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
# Mevcut state kaydet
git rev-parse HEAD                                     # bekleniyor: c26c1f4...
docker images | grep "netmanager-frontend" > /tmp/w1-pre-deploy-frontend-image.txt
docker compose exec -T postgres psql -U netmanager -d netmanager -c "SELECT version_num FROM alembic_version;"
# alembic: bekleniyor `f9aeportpol`
df -h /opt/netmanager                                  # disk durumu
```

**Beklenen anchor:**
- git HEAD: `c26c1f4` (Wave 3.1)
- alembic: `f9aeportpol`
- mevcut frontend image ID: tag olarak `latest` + digest

### P1 — Pre-deploy validation (read-only)

```bash
# Servis sağlığı
docker compose ps                                      # 11/11 healthy bekleniyor
curl -s -o /dev/null -w "%{http_code}\n" https://netmanager.charon-defense.com/health/ready
# 200 bekleniyor
# Aktif kullanıcı sayısı (deploy timing için)
curl -sH "Authorization: Bearer $TOKEN" https://.../api/v1/terminal-sessions/active | jq 'length'
```

**Stop kriteri:** Servis healthy değilse / aktif terminal session varsa, deploy ertelenir.

### P2 — Code pull

```bash
cd /opt/netmanager
git fetch origin main
# Önceden ne geliyor?
git log --oneline HEAD..origin/main | head -50         # 43 commit (bilgi)
git diff --stat HEAD..origin/main -- 'backend/' 'alembic/'  # backend delta görüntüle (referans)
git diff --stat HEAD..origin/main -- 'frontend/'       # frontend delta görüntüle
# Sadece frontend rebuild edileceği için backend delta diske inecek, çalışmayacak.
git merge --ff-only origin/main                        # → HEAD ec678f0
git log -1                                             # commit "LANG-FIX-W1-E" doğrula
```

### P3 — Frontend container rebuild (sadece)

```bash
# Sadece frontend build et — backend görüntü dokunulmaz
docker compose build frontend
# Build sonu yeni image digest:
docker images | grep "netmanager-frontend" | head -2
```

**Beklenen süre:** ~3-5dk (npm install + vite build + nginx static export).

### P4 — Frontend container restart (sadece)

```bash
# CRITICAL: --no-deps zorunlu. Backend + diğer servislere DOKUNMA.
docker compose up -d --no-deps frontend
# Doğrula:
docker compose ps frontend                             # status: Up (healthy)
docker compose ps backend                              # status: aynı uptime korundu
docker compose exec backend echo "backend untouched"   # uptime sıfırlanmamış
```

**Beklenen kesinti:** Frontend `<1sn` (nginx static reload, blue-green pattern).
**Backend kesinti:** **0sn** (--no-deps koruması; backend container'a kontrol komutu gitmiyor).

### P5 — Smoke gate (manuel browser + curl)

#### 5.1 Curl smoke

```bash
# Frontend cache buster
curl -s -o /dev/null -w "HTTP %{http_code} bundle: %{url_effective}\n" https://netmanager.charon-defense.com/
# 200 bekleniyor
# Bundle hash farklı olmalı
curl -s https://netmanager.charon-defense.com/ | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1
# yeni hash (önceki ile karşılaştır)
# Backend hâlâ ayakta:
curl -s https://netmanager.charon-defense.com/health/ready
# {"status": "ok", ...}
```

#### 5.2 Browser smoke (manuel — demo scope dahili)

**4 demo ekranı × 4 dil = 16 manuel test** (test matrisi):

| Ekran | TR | EN | DE | RU |
|---|---|---|---|---|
| Dashboard (`/dashboard`) | ☐ | ☐ | ☐ | ☐ |
| Devices listesi (`/devices`) | ☐ | ☐ | ☐ | ☐ |
| DeviceDetail (`/devices/1` — 10 tab) | ☐ | ☐ | ☐ | ☐ |
| Racks (`/racks`) | ☐ | ☐ | ☐ | ☐ |

**Her hücrede kontrol edilecek:**
- ✅ Header / Sidebar / breadcrumb tam çevrili
- ✅ Tablo kolon başlıkları çevrili
- ✅ Buton metinleri çevrili (Save / Cancel / Refresh / Apply / Delete)
- ✅ Modal/Drawer title + form label + placeholder + validation message
- ✅ Toast (en az 1 aksiyon — örn. Refresh) çevrili görünür
- ✅ Tarih formatı doğru locale (dayjs + AntD ConfigProvider)
- ❌ TR fragmanı görünmemeli (KURAL-E1..E5 keepers hariç: vendor adı, MAC/CPU/PoE, "Catalyst 2960" placeholder, CLI çıktısı)

**Konsol:** Yeni uygulama-kaynaklı error veya `missing-key` warning yok.

#### 5.3 Demo dışı sayfa uyarısı

Demo akışı **sadece 4 ekranla sınırlı**. Müşteriye gösterilmeyecek sayfalar:
- ❌ Settings, Users, TerminalSessions (W1-F kuyruğunda)
- ❌ Topology, Monitor, Agents, Playbooks, IPAM, BackupCenter, Reports vb. (W1-G+ kuyruğunda)

EN/DE/RU seçen müşteri bu sayfalara gitmemeli — TR ile karışık görünür.

### P6 — Post-deploy artefakt

```bash
# Post-deploy anchor kaydet:
docker images | grep "netmanager-frontend" > /tmp/w1-post-deploy-frontend-image.txt
git rev-parse HEAD > /tmp/w1-post-deploy-git.txt
# Deploy log doc oluştur: docs/W1_DEPLOY_LOG_2026-06-05.md (pattern: T10_C7_DEPLOY_LOG)
```

---

## Rollback procedure

### Senaryo: Frontend bundle bozuk / browser smoke fail

```bash
cd /opt/netmanager
# Pre-deploy image ID'yi /tmp/w1-pre-deploy-frontend-image.txt'den oku
PREVIOUS_FRONTEND_IMAGE=<digest>
docker tag $PREVIOUS_FRONTEND_IMAGE netmanager-frontend:latest
docker compose up -d --no-deps frontend
# git tarafında geri al:
git reset --hard c26c1f4
# Doğrula:
docker compose ps frontend                             # eski image aktif
git rev-parse HEAD                                     # c26c1f4
```

**Rollback süresi:** ~30-60sn (image swap + container restart).

### Senaryo: Build sırasında hata (P3)

```bash
git reset --hard c26c1f4
# Hiçbir şey değişmedi; build başlamadığı için container restart gerekmez.
```

### Rollback eşikleri

Aşağıdaki durumlarda otomatik rollback:
- Smoke gate sonrası 5dk içinde herhangi bir HTTP 500 spike (`/health/ready` 200 dönmüyor)
- Frontend bundle 5xx (nginx config corruption)
- Console error: i18n missing keys çoğu sayfada
- Browser smoke matrisinde **2+ ekran-dil hücresi** fail

---

## Sonraki adımlar (deploy GO sonrası)

| Sıra | İş | Plan/Tasarım |
|---|---|---|
| 1 | W1 deploy LOG: `docs/W1_DEPLOY_LOG_2026-06-05.md` | T10_C7 deploy log paterniyle |
| 2 | **LANG-FIX W1-F** — TerminalSessions → Settings → Users | `project_lang_fix_w1f_roadmap.md` memory |
| 3 | SSH Session Termination tasarım dokümanı | `docs/SSH_SESSION_TERMINATION_DESIGN.md` (W1 deploy'a bağlı değil, paralel) |
| 4 | **Backend HF catch-up deploy** — 13 HF + QF + W3.3 + W3 PoE | Ayrı plan; bu PR DIŞI; W1-F sırasında veya hemen sonrasında |
| 5 | 7 locale gap + 9 synonym konsolidasyon | `project_lang_fix_locale_gaps_p3.md`; W1-F sonu |
| 6 | LANG-FIX W2 — Topology / Monitor / Agents / Playbooks ... | W1-F sonrası, kapsam ayrı planlanır |
| 7 | RCA-F / HF#14..#24 worker/RLS audit | `project_worker_rls_regression_audit.md` paralel |

---

## Onay matrisi

| Aşama | Onay |
|---|---|
| Deploy planı oku + onay | ⏳ |
| **Deploy GO** | ⏳ (kullanıcı explicit) |
| P0..P6 yürütme | (GO sonrası) |
| Browser smoke 16/16 PASS | (yürütme sonrası) |
| Post-deploy LOG yazılması | (smoke sonrası) |

**Plan tek başına deploy etmez.** Kullanıcı explicit "deploy GO" demediği sürece bu doküman referans niteliğindedir.
