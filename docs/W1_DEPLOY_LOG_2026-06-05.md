# W1 (LANG-FIX A→E) Production Deploy Log — 2026-06-05

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only deploy; backend / postgres / redis / celery / nginx / event_consumer / beat / flower **DOKUNULMADI**. Local smoke matrisi temiz. Browser manuel smoke kullanıcıda.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `804434a` → **`b32abe7`** (PR #4 + PR #5 merge; W1-A..E + deploy plan dokümanı)
- **Kapsam:** **LANG-FIX W1-A → W1-E** — i18n shared components + Racks + Dashboard + Devices + DeviceDetail (10 tab + 4 drawer); 4 dil (tr/en/de/ru).
- **DB:** Migration **YOK** — `f9aeportpol` korundu.
- **Compose/network/env:** Değişiklik **YOK**.
- **Frontend:** Bundle `index-Bim1OQHK.js` (W2.2) → **`index-eeQsrXWe.js`** + `index-uWsjMl-2.css`.
- **Backend:** Container **dokunulmadı** — image `68729bb4d50a` aynı, Up 29 saat.
- **Kesinti:** Frontend ~6sn recreate (nginx static); backend / db / cache **0sn**.

## Final state (POST-DEPLOY ANCHOR)

| | Değer |
|---|---|
| **git HEAD** | **`b32abe73cfdb4bf80b21585f351cff6544618be7`** (b32abe7, main) |
| **alembic current** | `f9aeportpol` (DB migration yok, korundu ✅) |
| **Backend image** | `68729bb4d50a` (425 MB, 29 saat önce, **UNTOUCHED**) |
| **Frontend image (yeni)** | **`0095541547b5`** (74.3 MB, 9 dakika önce — W1 build) |
| **Frontend image (eski / rollback)** | `01d9b7ee824b` → tag `netmanager-frontend:rollback-pre-w1-20260605_1838` |
| **Yeni bundle hash** | `/assets/index-eeQsrXWe.js` + `/assets/index-uWsjMl-2.css` |
| **Frontend recreate** | `2026-06-05T18:59:17Z` |
| **11/11 servis** | Up/healthy |
| **Disk** | 36 GB used / 9 GB free / 80% (deploy öncesi ile aynı) |

### Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 29 hours (healthy)        ← UNCHANGED
celery_agent_worker     running   Up 4 days (healthy)          ← UNCHANGED
celery_beat             running   Up 4 days (healthy)          ← UNCHANGED
celery_default_worker   running   Up 4 days (healthy)          ← UNCHANGED
celery_worker           running   Up 4 days (healthy)          ← UNCHANGED
event_consumer          running   Up 4 days (healthy)          ← UNCHANGED
flower                  running   Up 5 days                    ← UNCHANGED
frontend                running   Up About a minute            ← RECREATED
nginx                   running   Up 6 days (healthy)          ← UNCHANGED
postgres                running   Up 6 days (healthy)          ← UNCHANGED
redis                   running   Up 6 days (healthy)          ← UNCHANGED
```

10 servisin uptime'ı korundu; sadece `frontend` recreate edildi (`--no-deps` koruması doğru çalıştı).

## PRE-DEPLOY ROLLBACK ANCHOR (geri-dönüş için saklı)

| | Değer |
|---|---|
| git | `804434adf399b0961f9e8a1a0693dcb9677f8d7d` (LANG-INFRA merge — W1 baseline) |
| alembic | `f9aeportpol` (aynı — DB migration yok) |
| Frontend image | `01d9b7ee824b` → tag `netmanager-frontend:rollback-pre-w1-20260605_1838` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-w1-20260605_1838 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 804434a
# ~30-60sn; backend / db dokunulmaz
```

---

## Faz çıktıları

### P0 — Anchor (pre-deploy)

```
git HEAD: 804434a (LANG-INFRA merge)
alembic: f9aeportpol
frontend image: 01d9b7ee824b (74 MB, 11 saat önce — LANG-INFRA build)
backend image: 68729bb4d50a (425 MB, 29 saat önce)
11/11 services Up + healthy
Disk: 36G / 9G free / 80%
```

Rollback tag: `netmanager-frontend:rollback-pre-w1-20260605_1838` ✅

### P1 — git fetch + ff-merge

```
fetch: 804434a..b32abe7 (12 commit incoming)
backend/agent/scripts/alembic delta: SIFIR ✅
frontend delta: 38 files, 6757 insertions(+), 1360 deletions(-)
ff-merge: success
new HEAD: b32abe7
```

> **Önemli düzeltme:** Deploy planında yazılan "37 backend HF kaçık" uyarısı yanlıştı. VPS zaten `804434a` (LANG-INFRA merge)'inde idi; HF#8..#13 + QF + W3 hepsi ancestor olarak prod'da. Gerçek delta: **saf W1-A..E + deploy plan docs**.

### P2 — Frontend build

```
docker compose build frontend
(SSH client disconnect ~120sn → dockerd build foreground'da devam etti)
sonuc: latest tag yeni image'a kaydi: 0095541547b5 (74.3 MB)
```

> **Not:** Sonraki deploy'larda `ssh -o ServerAliveInterval=30` ya da `nohup ... &` ile build başlatılması önerilir; sleep block (>120sn) keepalive olmadan SSH'i düşürdü.

### P3 — Frontend recreate (--no-deps)

```
docker compose up -d --no-deps frontend
→ Container netmanager-frontend-1  Recreated + Started
→ frontend Up 6 saniye
→ backend, celery×3, beat, event_consumer, flower, nginx, postgres, redis
  TÜMÜ uptime korundu (29h–6d arası)
```

`--no-deps` koruması başarılı — diğer servislere kontrol komutu gitmedi.

### P4 — Curl smoke (localhost)

`netmanager.charon-defense.com` DNS çözmedi (deploy planında yanlış domain referansı — eski log'lardan kopyalanmış; gerçek prod URL'sini ben bilmiyorum). VPS localhost test'i alındı:

```
http://localhost/                  HTTP/1.1 301 Moved Permanently   (→ /login)
http://localhost/login             HTTP/1.1 200 OK                  ✅
http://localhost/devices           HTTP/1.1 200 OK                  ✅
http://localhost/health/ready      HTTP/1.1 200 OK (GET)            ✅

/health/ready body:
{"status":"ok","checks":{"db":{"status":"ok"},"redis":{"status":"ok"},"timescaledb":{"status":"ok","hypertable_count":5}}}
```

### P5 — Bundle hash + log

```
Yeni bundle refs (index.html'de):
  /assets/index-eeQsrXWe.js
  /assets/index-uWsjMl-2.css
  /registerSW.js  (service worker, değişmedi)

Frontend container log (son 30 satır):
  nginx 1.31.1 başarıyla başladı
  4 worker process aktif
  uygulama-kaynaklı error yok

Backend container log (son 5 satır — untouched assert):
  Normal HTTP istek akışı devam ediyor (agent-relay 200, WS rejected 403 normal)
  Backend recreate edilmedi — uptime: 29 hours korundu
```

### P6 — Post-deploy artefakt

Bu dokuman: `docs/W1_DEPLOY_LOG_2026-06-05.md` (T10_C7_DEPLOY_LOG paterniyle).

---

## Kullanıcıdan beklenen browser smoke matrisi

`docs/W1_DEPLOY_PLAN.md`'de tanımlı 4 demo ekran × 4 dil = 16 hücre. VPS local smoke yeşil; tarayıcıda manuel doğrulanması bekleniyor:

| Ekran | TR | EN | DE | RU |
|---|---|---|---|---|
| Dashboard (`/dashboard`) | ☐ | ☐ | ☐ | ☐ |
| Devices listesi (`/devices`) | ☐ | ☐ | ☐ | ☐ |
| DeviceDetail (`/devices/<id>` — 10 tab) | ☐ | ☐ | ☐ | ☐ |
| Racks (`/racks`) | ☐ | ☐ | ☐ | ☐ |

**Demo dışı ekranlar** (Settings / Users / TerminalSessions / Topology / Monitor / Agents vb.) müşteriye **gösterilmeyecek** — W1-F / W1-G+ kuyruğunda.

---

## Sonraki adımlar

| Sıra | İş | Plan |
|---|---|---|
| 1 | Browser smoke 16/16 onayı | Kullanıcı manuel |
| 2 | **LANG-FIX W1-F** | `project_lang_fix_w1f_roadmap.md` — TerminalSessions → Settings → Users |
| 3 | SSH Session Termination tasarım dokümanı | `docs/SSH_SESSION_TERMINATION_DESIGN.md` (W1-F paraleli) |
| 4 | 7 locale gap + 9 synonym konsolidasyon | `project_lang_fix_locale_gaps_p3.md` |
| 5 | LANG-FIX W2 — Topology/Monitor/Agents/Playbooks vd. | W1-F sonu |
| 6 | RCA-F / HF#14..#24 worker/RLS audit | Paralel iş paketi |

---

## Smoke fail / rollback eşikleri (referans)

- 5xx spike (frontend bundle bozuk / nginx config corruption)
- `/health/ready` 200 dönmüyor (backend etkilenmiş — şu anki state'te değil)
- Console error: 2+ ekran-dil hücresi missing-key

**Rollback komutu** (rollback tag mevcut):

```bash
docker tag netmanager-frontend:rollback-pre-w1-20260605_1838 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 804434a
```

Süre: ~30-60sn. Backend / db / cache dokunulmaz.
