# SSH Session Termination — Backend + Frontend Production Deploy Plan

**Tarih:** 2026-06-07
**Branch:** `t10/ssh-session-termination` (9 commit, ~750 LOC)
**Baseline:** `docs/SSH_SESSION_TERMINATION_DESIGN.md` (PR #7) + `docs/SSH_SESSION_TERMINATION_IMPL_PLAN.md` (PR #15)
**Deploy izni:** **AYRI GO BEKLENİYOR** — bu doküman plandır.

W1-F **frontend-only paterni UYGULANAMAZ** (yeni backend endpoint var). Bu deploy **backend + frontend birlikte rolling** paternidir.

---

## 1) Özet — tek sayfada karar

| Soru | Cevap |
|---|---|
| Bu deploy frontend-only mu? | **Hayır** — backend rebuild zorunlu (yeni endpoint + WS listener task) |
| DB migration? | **Hayır** — `f9aeportpol` korunur, sıfır yeni kolon |
| Postgres/Redis/Celery dokunulacak mı? | **Hayır** — sadece backend + frontend container recreate |
| Rolling sırası | **1) Backend rebuild + recreate** (yeni endpoint live olur) → **2) Frontend rebuild + recreate** (terminate button live olur). 404 race bu sırayla önlenir. |
| Rollback tag adedi | **2** (backend + frontend) |
| Toplam kesinti | Backend ~10-20sn, Frontend ~7sn (recreate); DB / cache 0sn |

---

## 2) Sprint kapanış özeti — değişen dosyalar

### Backend (9 dosya değişti, 1 dosya yeni)

| Dosya | Açıklama | Δ LOC |
|---|---|---:|
| `backend/app/services/agent_manager.py` | `open_shell_session(*, override_session_id=None)` (BC) | +6 |
| `backend/app/api/v1/endpoints/ws.py` | `_ssh_terminate_listener` module-level + 2 call site + 4 finally cancel + tz coerce | ~75 |
| `backend/app/models/user.py` | SYSTEM_ROLE_PERMISSIONS — terminal_sessions:terminate (org_admin + location_admin) | +5 |
| `backend/app/models/shared/permission_set.py` | DEFAULT_PERMISSIONS.modules.terminal_sessions | +3 |
| `backend/app/services/audit_service.py` | `organization_id_override` kw-only (BC) | +12 |
| `backend/app/api/v1/endpoints/terminal_sessions.py` | POST /terminate endpoint + Pydantic schemas + tz coerce | +180 |
| `backend/tests/test_ssh_session_terminate.py` | 21 pytest (RBAC + audit + endpoint) | +599 (yeni) |
| `backend/tests/test_ssh_terminate_ws_listener.py` | 6 pytest (WS listener integration) | +240 (yeni) |

### Frontend (3 dosya değişti)

| Dosya | Açıklama | Δ LOC |
|---|---|---:|
| `frontend/src/api/terminalSessions.ts` | `terminate(session_id, reason?)` API method | +15 |
| `frontend/src/pages/TerminalSessions/index.tsx` | canTerminate + terminateMut + aksiyon kolonu + force_closed color | +75 |
| `frontend/src/i18n/locales/{tr,en,de,ru}.json` | terminal_sessions.terminate.* + status.force_closed + col.actions | +40 (10 key × 4 dil) |

**Toplam:** ~1 250 LOC (kod ~410 + test ~840).

---

## 3) Commit listesi (9 commit, ardışık)

| # | SHA | Konu | Test sonu |
|---|---|---|---|
| 1 | `b0afa97` | `refactor(backend): unify TerminalSessionLogger and agent shell session_id` | compile ✅ |
| 2 | `0da5e30` | `feat(backend): RBAC verb terminal_sessions:terminate + permission_set module` | compile ✅ |
| 3 | `8c6697a` | `feat(backend): audit_service.log_action organization_id_override` | compile ✅ |
| 4 | `45ecdb7` | `feat(backend): POST /terminal-sessions/{id}/terminate endpoint` | compile ✅ |
| 5 | `7c89077` | `feat(backend): SSH WS terminate_listener + force_closed exit_reason` | compile ✅ |
| 6 | `8b911ea` | `feat(frontend): TerminalSessions terminate button + Popconfirm + mutation` | tsc ✅ |
| 7 | `a6e0840` | `i18n(frontend): terminal_sessions.terminate.* × 4 dil` | parity widening = 0 ✅ |
| 8 | `895f457` | `test(backend): SSH Session Termination — RBAC + audit + endpoint suite` | 21/21 PASS |
| 9 | `cb1d83f` | `test(backend): SSH WS terminate_listener integration test (6 pytest)` | 6/6 PASS |

---

## 4) Test sonuçları

### Backend (`pytest`)

| Suite | Test sayısı | Sonuç |
|---|---:|---|
| `test_ssh_session_terminate.py` (RBAC 6 + audit 4 + endpoint 8 + schema 3) | 21 | ✅ **21/21 PASS** |
| `test_ssh_terminate_ws_listener.py` (WS pub/sub listener integration) | 6 | ✅ **6/6 PASS** |
| **Toplam yeni** | **27** | ✅ **27/27 PASS** |
| Lokal full-suite (pre-existing failures incl.) | — | Mevcut 45 fail tamamen pre-existing baseline (pyotp / t8.3.1 ordering / qf7 — origin/main'de de düşüyor). PR regresyon getirmedi. |

### RBAC testleri (6/6)

- super_admin '*' wildcard → terminate ✅
- org_admin grant → terminate ✅
- location_admin grant → terminate ✅
- viewer DENY ✅
- member DENY ✅
- SYSTEM_ROLE_PERMISSIONS registry kontrolü ✅

### Audit log testleri (4/4)

- Default org=user.organization_id (BC) ✅
- Cross-org override session.org'a stamp ✅
- override=None eski davranış ✅
- override=0 falsy değil, explicit kabul ✅

### Endpoint testleri (8/8)

- Happy path 200 + ended_at + force_closed + duration_ms ✅
- Already closed → 410 'session_already_closed' ✅
- Not found → 404 ✅
- Default reason 'force_terminated_by_admin' (body=None) ✅
- Audit details 16 alan snapshot + before/after_state ✅
- Cross-org super_admin → audit org=session.org ✅
- Redis down → DB UPDATE bloklanmaz ✅
- Race guard rowcount=0 → 410 'session_already_closed_during_race' ✅

### Pydantic schema testleri (3/3)

- Short reason kabul ✅
- reason >256 → ValidationError ✅
- reason=None / no-body → None ✅

### WS terminate publish → close akışı (6/6)

- Match: session_id eşleşmesi → banner + close(4000) + evt.set() + unsubscribe ✅
- Non-matching ignored (multi-worker broadcast filter) ✅
- Malformed JSON ignored, sonraki match normal işlenir ✅
- Cancellation → finally unsubscribe + aclose (leak yok) ✅
- Redis subscribe fail → sessizce dön (tasarım §10.7) ✅
- 'subscribe' handshake type yoksayılır, gerçek match işlenir ✅

### Frontend

| Pipeline | Sonuç |
|---|---|
| `tsc --noEmit` | ✅ 0 hata |
| `vitest run` | ✅ 232/232 PASS |
| `vite build` | ✅ built in 7.61s |
| `npm run i18n:check` | ✅ 201 eksik = SIRF W3 scope, widening = 0 |

### Locale parity

| Dil | W1-F deploy sonu | SSH Termination sonu | Δ |
|---|---:|---:|---:|
| tr (baseline) | 2 286 | **2 296** | +10 |
| en | 2 243 | **2 253** | +10 |
| de | 2 207 | **2 217** | +10 |
| ru | 2 207 | **2 217** | +10 |

Yeni 10 key × 4 dil = 40 toplam çeviri (col.actions + status.force_closed + 8 terminate keys).

---

## 5) Manual smoke adımları (deploy sonrası kullanıcı doğrulaması)

### Scenario 1: Happy path force-close

1. **Setup:** İki ayrı tarayıcı oturumu
   - Window A: org_admin login → DeviceDetail → Terminal sekmesi → "Canlı SSH" toggle → switch'e bağlan
   - Window B: org_admin login → TerminalSessions ekranı (yeni satır görünmeli, status "Devam ediyor")
2. **Aksiyon:** Window B → kırmızı StopOutlined ikonu → Popconfirm "Bu SSH oturumunu kapatmak istiyor musunuz?" → Evet
3. **Beklenen:**
   - Window B toast "Oturum sonlandırıldı"
   - Window B satır status: "Yönetici tarafından kapatıldı" (kırmızı)
   - Window A xterm'de ANSI kırmızı banner: "═════ This terminal session was terminated by an administrator. ═════"
   - Window A WS close code 4000 (browser xterm fallback)
4. **DB:** `SELECT exit_reason, ended_at FROM terminal_session_logs WHERE session_id='X'` → `'force_closed', <now>`
5. **Audit:** `SELECT details FROM audit_logs WHERE action='terminal_sessions.terminate' AND resource_id='X'` → 16 alanlı JSON

### Scenario 2: Idempotent 410

1. **Setup:** TerminalSessions ekranında zaten kapanmış (örn. user_closed) bir satır
2. **Aksiyon:** Backend'e direkt cURL → `POST /api/v1/terminal-sessions/X/terminate`
3. **Beklenen:** 410 `{"detail":{"code":"session_already_closed","ended_at":"...","exit_reason":"user_closed"}}`

### Scenario 3: viewer 403

1. **Setup:** Window A: viewer rolü ile login → TerminalSessions sayfası
2. **Beklenen:** Aksiyon kolonu HİÇ render edilmez (canTerminate=false → kolon spread skipped)
3. Backend assert (cURL): `POST /terminate` → 403 "terminal_sessions:terminate izni yok"

### Scenario 4: Cross-org super_admin

1. **Setup:** Window A: super_admin → TerminalSessions (org A'da değil — multi-tenant test)
2. **Aksiyon:** Org B'deki bir aktif session'ı terminate et
3. **Beklenen:**
   - 200 + WS close (Org B kullanıcısının ekranında banner)
   - `audit_logs.organization_id = <org B id>` (terminator'un org'u değil, session'ın org'u)

### Scenario 5: Redis down resilience

1. **Setup:** `docker stop netmanager-redis-1`
2. **Aksiyon:** Terminate aksiyonu
3. **Beklenen:** 200 + DB UPDATE (force_closed). WS hattı 30sn revalidate ile kapanır (banner görünmez ama oturum doğru kapanır).
4. **Cleanup:** `docker start netmanager-redis-1`

### Scenario 6: 4 dil i18n smoke

- TerminalSessions sayfası TR/EN/DE/RU:
  - col.actions: Eylem / Action / Aktion / Действие
  - status.force_closed: "Yönetici tarafından kapatıldı" / "Closed by administrator" / "Vom Administrator geschlossen" / "Закрыто администратором"
  - Popconfirm titles + button labels uygun çevirili

---

## 6) Deploy planı

### Pre-deploy gereksinimler

| Kontrol | Beklenen |
|---|---|
| PR review + merge | (kullanıcı onayı) |
| Lokal smoke pipeline | ✅ (27/27 backend + tsc/vitest/build/i18n FE) |
| VPS state | git=e65440a, frontend=dbe6adff, backend=68729bb4 (W1-F state) |
| alembic | `f9aeportpol` (değişmez) |
| docker-compose env değişikliği | YOK |

### P0 — Anchor + 2 rollback tag

```bash
ssh root@93.180.133.88
cd /opt/netmanager

echo '--- pre-deploy anchor ---'
git rev-parse HEAD                                     # e65440a (W1-F state)
docker compose images frontend                         # dbe6adff060d
docker compose images backend                          # 68729bb4d50a

# 2 rollback tag (backend + frontend)
TS=$(date +%Y%m%d_%H%M)
ROLLBACK_FE="netmanager-frontend:rollback-pre-ssh-term-$TS"
ROLLBACK_BE="netmanager-backend:rollback-pre-ssh-term-$TS"

docker tag dbe6adff060d "$ROLLBACK_FE"
docker tag 68729bb4d50a "$ROLLBACK_BE"

docker images netmanager-frontend | grep rollback-pre-ssh-term
docker images netmanager-backend  | grep rollback-pre-ssh-term

echo '--- 11 servis durumu ---'
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'

echo '--- alembic ---'
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -tAc 'SELECT version_num FROM alembic_version;'    # f9aeportpol
```

### P1 — Git pull (ff-only)

```bash
git fetch origin main
echo '--- gelen commitler ---'
git log --oneline HEAD..origin/main

echo '--- alembic delta (sıfır olmalı) ---'
git diff --name-only HEAD..origin/main | grep -E '^alembic/' || echo "✓ sıfır"

echo '--- backend dosya delta ---'
git diff --name-only HEAD..origin/main | grep -E '^backend/' | wc -l

echo '--- frontend dosya delta ---'
git diff --name-only HEAD..origin/main | grep -E '^frontend/' | wc -l

git merge --ff-only origin/main
git rev-parse HEAD          # <yeni SSH Termination merge SHA>
```

### P2 — Backend rebuild ÖNCE

> **Rolling sırası kritik:** Backend önce, çünkü yeni endpoint olmadan frontend butonu 404 alır. Backend live → frontend henüz eski (terminate UI'sı yok) → kullanıcı henüz buton görmüyor. Sonra frontend recreate → buton live, endpoint zaten hazır.

```bash
echo '--- backend build ---'
date
docker compose build backend 2>&1 | tail -25
docker compose images backend | head -3
```

### P3 — Backend recreate (`--no-deps`)

```bash
docker compose up -d --no-deps backend
sleep 8
docker compose ps backend                              # Up X seconds (yeni image)
docker compose logs --tail=20 backend | grep -i "uvicorn running\|application startup"

# Yeni endpoint live test:
curl -ks http://localhost/api/v1/terminal-sessions/test/terminate -X POST -H "Authorization: Bearer DUMMY"
# beklenen: 401 (token DUMMY), endpoint erişilebilir
```

### P4 — Frontend build + recreate

```bash
echo '--- frontend build ---'
docker compose build frontend 2>&1 | tail -25
docker compose images frontend

echo '--- frontend recreate ---'
docker compose up -d --no-deps frontend
sleep 5
docker compose ps frontend                             # Up X seconds (yeni image)

# Curl smoke:
for path in / /login /devices /users /settings /terminal-sessions; do
  printf "%-22s " "$path"
  curl -ksI "http://localhost$path" | head -1
done

curl -ks http://localhost/health/ready                 # db/redis/timescaledb ok
curl -ks http://localhost/login | grep -oE '/assets/[A-Za-z0-9_-]+\.(js|css)' | sort -u
```

### P5 — Servis matrisi + log + assert

```bash
echo '--- 11 servis (post-deploy) ---'
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
# Backend recreate edilmiş olmalı (Up X seconds)
# Frontend recreate edilmiş olmalı (Up X seconds)
# Diğerleri (celery×3, beat, event_consumer, flower, nginx, postgres, redis) DOKUNULMAZ

echo '--- backend log son 30 satır ---'
docker compose logs --tail=30 backend | grep -v 'level=warning'

echo '--- celery worker uptime UNCHANGED assert ---'
docker compose ps celery_default_worker celery_worker celery_agent_worker | grep Up
```

### P6 — Deploy log dokümanı

`docs/SSH_SESSION_TERMINATION_DEPLOY_LOG_2026-06-XX.md` — W1F_DEPLOY_LOG paterniyle:
- Pre/post anchor (git + alembic + backend + frontend image hash)
- 2 rollback tag (backend + frontend)
- Build süreleri + recreate timestamp
- 11 servis state matrisi
- Curl smoke output
- Bundle hash karşılaştırma
- Manual smoke 6-scenario checklist

---

## 7) Rollback planı

### Senaryo: Backend endpoint çöküyor / WS listener leak / smoke 500

```bash
ssh root@93.180.133.88
cd /opt/netmanager

# Backend rollback (önce — terminate endpoint kaldırılır)
docker tag netmanager-backend:rollback-pre-ssh-term-<TS> netmanager-backend:latest
docker compose up -d --no-deps backend
sleep 5

# Frontend rollback (sonra — terminate button kaldırılır)
docker tag netmanager-frontend:rollback-pre-ssh-term-<TS> netmanager-frontend:latest
docker compose up -d --no-deps frontend
sleep 5

# Git tarafında geri al
git reset --hard e65440a                              # W1-F deploy state
git rev-parse HEAD                                     # e65440a

# Smoke
curl -ks http://localhost/health/ready                 # 200
docker compose ps                                      # 11 servis Up
```

**Rollback süresi:** Backend ~10sn + Frontend ~7sn ≈ **20-30sn**. Aktif SSH oturumları backend recreate sırasında kopabilir (xterm browser tarafından reconnect denenir).

### Rollback eşikleri

- POST /terminate 500 spike (>5/dk)
- WS terminate_listener task leak (memory growth)
- Active SSH oturumlarında banner görünmesinden sonra WS kapanmıyor
- Audit log entry yazılmıyor (commit hatası)
- Frontend xterm beklenmedik şekilde kapanıyor (4000 dışı kod)

---

## 8) Risk değerlendirmesi

| # | Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|---|
| 1 | Backend recreate sırasında aktif SSH oturumları koparılır | ORTA | DÜŞÜK | Browser xterm reconnect mantığı zaten var; kullanıcı 5-10sn'de yeniden bağlanır. Deploy bilinçli zamanlanır (mesai dışı tercih) |
| 2 | WS listener task leak (multi-worker × N session) | DÜŞÜK | ORTA | 6 test cancellation cleanup'ı doğruladı; finally unsubscribe + aclose |
| 3 | Race: terminate endpoint çağrısı + stale_cleanup beat aynı anda | DÜŞÜK | DÜŞÜK | WHERE ended_at IS NULL + rowcount=0 → 410 race guard testle doğrulandı |
| 4 | Cross-org audit organization_id yanlış stamp | DÜŞÜK | YÜKSEK | `organization_id_override` testlerle doğrulandı (None vs 0 vs explicit) |
| 5 | Frontend buton race (eski FE + yeni BE arası 30sn): viewer 403 mı 404 mü görür? | DÜŞÜK | DÜŞÜK | Rolling sırası "backend önce" → eski FE'de buton yok, viewer hiç tıklayamaz. Yeni endpoint sadece role check yapar, eski FE etkisiz |
| 6 | Audit log organization_id_override eski testleri bozar | DÜŞÜK | DÜŞÜK | 4 BC test default davranışı koruduğunu kanıtlıyor; mevcut log_action callers etkilenmez |
| 7 | Redis publish başarısız → kullanıcı banner görmez | ORTA | DÜŞÜK | DB UPDATE tamamlanır; WS 30sn revalidate ile kapanır; tasarım §10.7 fallback testlerle doğrulandı |

**Toplam risk:** **DÜŞÜK**. Tüm yüksek-etki riskler test coverage'ıyla kapsanmış.

---

## 9) Onay matrisi

| Aşama | Onay |
|---|---|
| PR oku + review | ⏳ |
| **Merge GO** | ⏳ (kullanıcı explicit) |
| **Deploy GO** | ⏳ (kullanıcı explicit, merge sonrası) |
| P0..P6 yürütme | (deploy GO sonrası) |
| Manuel smoke 6 scenario | (yürütme sonrası, kullanıcı doğrular) |
| Deploy log doc | (smoke sonrası) |

Plan tek başına deploy etmez. Kullanıcı explicit "deploy GO" demediği sürece bu doküman referans niteliğindedir.

---

## 10) Deploy sonrası sıradaki adımlar

1. **W2 sprint planlaması** — Agents 185 + Monitor 166 + Topology 130 + Playbooks 105 + BackupCenter 101 + Reports 99 = 786 finding (en büyük 6 sayfa)
2. **Audit Log UI v2** (memory'de planlı) — `terminal_sessions.terminate` action chip'i, details JSON before/after diff render
3. **stale_cleanup eşik configurable** — admin force_closed daha sık olursa stale_min varsayılanı düşürmek istenebilir
