# SSH Session Termination — Rollback Plan

**Tarih:** 2026-06-08
**Karar:** Production testlerinde başarısız + mevcut SSH log/terminal akışını bozdu. Özellik **komple iptal**, **geri alınıyor**.
**Hedef:** Production sistemi, SSH Session Termination özelliği eklenmeden önceki stabil duruma (`b32abe7` = W1-F deploy state) **fonksiyonel olarak eşdeğer** duruma dönsün.

> **Kod yazma yok.** Sadece revert planı + dosya/commit envanteri. Kullanıcı onayı sonrası implementation başlar.

---

## A. Revert edilecek commit listesi

### Merged commits (origin/main üzerinde, revert edilecek — 12 commit)

**Kronolojik sıra (eski → yeni). Revert sırası tersine: yeni → eski.**

| # | SHA | Konu | PR |
|---:|---|---|---|
| 1 | `f51313f` | docs(impl-plan): SSH Termination implementation sprint plan | #15 |
| 2 | `c0cbaef` | refactor(backend): unify TerminalSessionLogger and agent shell session_id | #16 |
| 3 | `d42a41e` | feat(backend): RBAC verb terminal_sessions:terminate + permission_set module | #16 |
| 4 | `6b7b34d` | feat(backend): audit_service.log_action organization_id_override | #16 |
| 5 | `10035f5` | feat(backend): POST /terminal-sessions/{id}/terminate endpoint | #16 |
| 6 | `00d1ce6` | feat(backend): SSH WS terminate_listener + force_closed exit_reason | #16 |
| 7 | `63580af` | feat(frontend): TerminalSessions terminate button + Popconfirm + mutation | #16 |
| 8 | `2c75094` | i18n(frontend): terminal_sessions.terminate.* + status.force_closed + col.actions × 4 dil | #16 |
| 9 | `feea51f` | test(backend): SSH Termination — RBAC + audit + endpoint suite | #16 |
| 10 | `fa49e3d` | test(backend): SSH WS terminate_listener integration test (6 pytest) | #16 |
| 11 | `a60d53d` | docs(deploy): SSH Termination — backend+frontend deploy plan | #16 |
| 12 | `1cc0d6e` | docs(rca): SSH Termination — functional test failure RCA | #18 |

### Açık PR'lar (merge edilmedi — kapatılacak)

| PR | Branch | Eylem |
|---|---|---|
| **#7** | `t10/ssh-session-termination-design` | **CLOSE without merge** (design doc origin/main'de değil) |
| **#17** | `t10/ssh-term-deploy-log` | **CLOSE without merge** (deploy log origin/main'de değil) |
| **#19** | `t10/ssh-session-termination-hotfix` | **CLOSE without merge** (5 commit hotfix origin/main'de değil) |

### Tek revert PR

Stratejisi:
- Branch: `t10/revert-ssh-session-termination`
- `git revert --no-commit` ile 12 commit'i ters sırayla revert et
- Hepsini tek atomik commit'te birleştir
- Tek PR, tek atomik geri-alış

Alternatif (Plan B): commit-bazlı 12 ayrı revert commit — daha gürültülü history, lehte bir nedeni yok. **Tek atomik commit** tercih edilir.

---

## B. Revert edilecek dosya listesi

### Backend kod dosyaları (revert)

| Dosya | Hangi commit etkilemişti | Revert sonrası beklenen |
|---|---|---|
| `backend/app/api/v1/endpoints/ws.py` | c0cbaef + 00d1ce6 + fa49e3d | `_ssh_terminate_listener` fonksiyonu silinir, `_terminate_evt`/`_terminate_task` kaldırılır, `_SSH_TERM_BANNER` sabit kaldırılır, finally bloğundaki `exit_reason` override mantığı kaldırılır, `override_session_id=_term_logger.session_id` argümanı kaldırılır → eski `await _ag.open_shell_session(...)` çağrısı geri gelir |
| `backend/app/services/agent_manager.py` | c0cbaef | `override_session_id: str | None = None` keyword-only parametresi kaldırılır, `session_id = uuid.uuid4().hex` (eski sabit) geri gelir |
| `backend/app/models/user.py` | d42a41e | `SYSTEM_ROLE_PERMISSIONS` ORG_ADMIN ve LOCATION_ADMIN listelerinden `"terminal_sessions:terminate"` kaldırılır |
| `backend/app/models/shared/permission_set.py` | d42a41e | `DEFAULT_PERMISSIONS.modules.terminal_sessions = {view, terminate}` modülü kaldırılır |
| `backend/app/services/audit_service.py` | 6b7b34d | `organization_id_override: Optional[int] = None` keyword-only parametresi kaldırılır, docstring kaldırılır, `organization_id = user.organization_id if user else None` (eski tek satır) geri gelir |
| `backend/app/api/v1/endpoints/terminal_sessions.py` | 10035f5 + feea51f | `TerminateSessionRequest`, `TerminateSessionResponse` Pydantic sınıfları silinir, `terminate_session` endpoint silinir, `logging`+`pydantic`+`audit_service` import'ları temizlenir, docstring "POST /terminate" satırı kaldırılır, modüldeki tek log statement reverts |

### Backend test dosyaları (silinecek)

| Dosya | Eylem |
|---|---|
| `backend/tests/test_ssh_session_terminate.py` | **Komple sil** (PR #16 ile eklendi) |
| `backend/tests/test_ssh_terminate_ws_listener.py` | **Komple sil** (PR #16 ile eklendi) |

### Frontend kod dosyaları (revert)

| Dosya | Hangi commit etkilemişti | Revert sonrası beklenen |
|---|---|---|
| `frontend/src/pages/TerminalSessions/index.tsx` | 63580af | `canTerminate`, `terminateMut`, `terminate` import (Popconfirm, Tooltip, StopOutlined), force_closed satır rengi, satır aksiyon kolonu — hepsi kaldırılır |
| `frontend/src/api/terminalSessions.ts` | 63580af | `terminate()` method silinir (~25 satır) |
| `frontend/src/i18n/locales/tr.json` | 2c75094 | `terminal_sessions.col.actions`, `status.force_closed`, `terminate.*` (10 anahtar) silinir |
| `frontend/src/i18n/locales/en.json` | 2c75094 | Aynı 10 anahtar silinir |
| `frontend/src/i18n/locales/de.json` | 2c75094 | Aynı 10 anahtar silinir |
| `frontend/src/i18n/locales/ru.json` | 2c75094 | Aynı 10 anahtar silinir |

### Docs (silinecek — origin/main'de mevcut)

| Dosya | Eylem |
|---|---|
| `docs/SSH_SESSION_TERMINATION_IMPL_PLAN.md` | **Komple sil** (PR #15) |
| `docs/SSH_SESSION_TERMINATION_DEPLOY_PLAN.md` | **Komple sil** (PR #16 a60d53d) |
| `docs/SSH_TERMINATION_RCA_2026-06-07.md` | **Komple sil** (PR #18) |

### Docs (açık PR'larda — origin/main'de değil, sadece branch kapatılır)

| Dosya | Lokasyon | Eylem |
|---|---|---|
| `docs/SSH_SESSION_TERMINATION_DESIGN.md` | PR #7 (open) | PR close — main'e gitmez |
| `docs/SSH_SESSION_TERMINATION_DEPLOY_LOG_2026-06-07.md` | PR #17 (open) | PR close — main'e gitmez |
| `docs/SSH_TERMINATION_ROLLBACK_PLAN.md` (bu doküman) | Yeni branch — kalır mı? | **Bu plan PR merge sonrası KORUNUR** (gelecek incident için referans) |

---

## C. Korunacak değişiklikler

Hiçbir PR #16/18'deki commit ANA özellikten (Termination) bağımsız genişletilebilir bir yan-etki taşımıyor. Aşağıdaki noktaları **bilinçli olarak da kaybediyoruz**:

| Alan | Kaybedilen | Etki değerlendirmesi |
|---|---|---|
| `agent_manager.open_shell_session(override_session_id=...)` | Refactor (BC kw-only) | **Hiçbir başka çağrı yeri yok** — Termination dışında kullanılmıyor. Kaybı sıfır. |
| `audit_service.log_action(organization_id_override=...)` | Backward-compatible genişletme | **Hiçbir başka çağrı yeri yok** — Termination dışında kullanılmıyor. Kaybı sıfır. |
| `permission_set.DEFAULT_PERMISSIONS.modules.terminal_sessions` | RBAC modülü | Frontend permission_set ekranında bu modül **görünmeyecek** — kullanıcı zaten Terminate yapamayacak, view kontrolü mevcut RLS ile sağlanıyor. |
| `SYSTEM_ROLE_PERMISSIONS` `"terminal_sessions:terminate"` verb | RBAC verb | Aynı şekilde — terminate yapılamayacağı için bu verb anlamsız. |
| `terminal_sessions.actions` i18n key | UI label | Aksiyon kolonu da silineceği için label gerekmiyor. |
| `terminal_sessions.status.force_closed` i18n key | Status label | force_closed exit_reason artık yazılmayacak için label da gerekmiyor. |
| `terminal_sessions.terminate.*` 8 i18n key | Mutation/Popconfirm/toast | Buton ve mutation silindi. |
| `_SSH_TERM_BANNER` sabiti | ANSI banner | Banner gönderilmeyecek için sabit gerekmiyor. |

### Açıkça korunan (DOKUNMA listesi)

| Dosya / yapı | Sebep |
|---|---|
| `backend/app/services/terminal_session_logger.py` | **PR #16'da DOKUNULMADI**. Mevcut `close()` davranışı korunuyor. PR #19 hotfix (race guard) merged değil, dolayısıyla rollback bunu da etkilemez. |
| `backend/app/api/v1/endpoints/terminal_sessions.py` mevcut GET/POST | Listing, detay, AI summarize endpoint'leri T9 öncesinde ekleniyordu, KORUNUR. |
| `frontend/src/pages/TerminalSessions/index.tsx` mevcut tablo/kolon yapısı | W1-F1 i18n çevirisi korunur; sadece terminate-spesifik eklemeler kaldırılır. |
| `frontend/src/api/terminalSessions.ts` mevcut methods (list/get/stats/summarize) | KORUNUR. |
| W1-F locale parity (201 W3 gap) | Revert SSH Term anahtarları çıkarınca parity değişmeyecek (TR/EN/DE/RU ortak siliniyor). |
| `terminal_session_logs` tablosu, `terminal_session_logger.py` log akışı | Mevcut SSH log davranışı (input/output buffer, komut çıkarma, AI summary) **OLDUĞU GİBİ KORUNUR**. |
| `agent_manager.close_shell_session()` mevcut implementasyonu | Eski user_closed akışı için zaten var. KORUNUR. |
| Mevcut alembic head `f9aeportpol` | Migration **YOK**, rollback'te de değişmez. |

---

## D. Risk analizi

| # | Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|---|
| 1 | **Revert conflict** — 12 commit arasında bir dosya birden çok kez değişti (`ws.py` 3 kez, `terminal_sessions.py` 2 kez), `--no-commit` ile birikecek değişiklikler conflict yaratabilir | DÜŞÜK | DÜŞÜK | `git revert` her commit için ardışık ters sırayla; conflict olursa elle çözüp commit'le | 
| 2 | **PR #16 sonrası başka PR'larda değişmiş dosyalar** olabilir mi? | DÜŞÜK | DÜŞÜK | PR #17/18 sadece docs ekledi (kod yok). PR #19 merged değil → main'e dokunmadı. Revert temiz olmalı. |
| 3 | **`agent_manager.py` `override_session_id` argümanını kullanan başka çağrı varsa**, kaldırıldığında TypeError | DÜŞÜK | DÜŞÜK | Sadece ws.py'da 1 call site var (revert kapsamında); başka yer yok (`grep -r override_session_id backend/`) |
| 4 | **`audit_service.log_action(organization_id_override=...)` başka yerlerde** kullanılıyor mu? | DÜŞÜK | DÜŞÜK | Sadece terminate endpoint kullanıyor (revert kapsamında). |
| 5 | **i18n parity widening** — eklenen 10 anahtar kaldırılırsa 4 dil farklı olur mu? | DÜŞÜK | DÜŞÜK | 4 dilden de aynı anahtarlar kaldırılacak → parity korunur (tr -10, en -10, de -10, ru -10). |
| 6 | **Frontend bundle değişimi** — TerminalSessions.tsx ve api/terminalSessions.ts revert edildiğinde JS bundle hash yeni olur, browser PWA cache eski hash'i istemeye devam edebilir | DÜŞÜK | DÜŞÜK | Browser hard refresh + service worker auto-update var; W1-F deploy'unda da yaşandı, sorun çıkmadı |
| 7 | **Mevcut çalışan SSH log akışı revert sonrası çalışmalı** — özellik öncesi davranış garantili mi? | DÜŞÜK | YÜKSEK | Logger close() PR #16'da dokunulmadı; ws.py'da listener/db-poll task kaldırılınca eski tek-yol akış (websocket.receive loop + close finally) geri gelir. Manuel smoke ile doğrulanacak. |
| 8 | **Browser PWA service worker** SSH endpoint cache'lemiş olabilir | DÜŞÜK | DÜŞÜK | SW build sırasında precache hash refresh; revert deploy sonrası eski URL'lere POST/GET fail olursa kullanıcı manuel reload yapar. |
| 9 | **Pre-existing 215 W3 locale gap** durumu | DÜŞÜK | DÜŞÜK | Bizim eklediğimiz 10 anahtar W3 dışı; revert sonrası 201 W3 sırf help.faq_* (W1-F deploy state'e dön) |
| 10 | **Hotfix branch'inde yapılan değişiklikler kaybolur** (PR #19 5 commit) | YÜKSEK | DÜŞÜK | İsteğe göre. Kullanıcı kararı: hotfix iptal. Branch silinebilir ya da arşivde kalır (default: kalır, sadece PR close edilir). |

**Toplam risk: DÜŞÜK.** En önemli risk #7 (eski SSH log akışının revert sonrası gerçekten çalıştığının doğrulanması) — manuel smoke testle elimine edilir.

---

## E. Eski SSH logging davranışı doğrulama test planı

### Bu doğrulama YENI test yazımı DEĞIL. Mevcut test paketinin geçtiğini ve manuel davranışın eski haline döndüğünü kontrol.

### E.1 Backend test pipeline

Revert PR'ında çalıştırılacak:

```bash
cd backend
env -i PATH="..." python3 -m pytest tests/ \
  --ignore=tests/test_t10_c7_endpoint.py \
  --ignore=tests/test_td2_ws_auth.py
```

| Beklenti | Doğrulama |
|---|---|
| `test_ssh_session_terminate.py` collected DEĞIL | Dosya silinmiş olmalı |
| `test_ssh_terminate_ws_listener.py` collected DEĞIL | Dosya silinmiş olmalı |
| Mevcut SSH-related testler (T9 Tur 3A logging suite varsa) yeşil | Listed pass count = pre-PR#16 baseline |
| `45 pre-existing fail` aynı kalmalı (pyotp/qf7/t8.3.1) | Revert regression eklemiyor |

### E.2 Frontend test pipeline

```bash
cd frontend
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
./node_modules/.bin/vite build
npm run i18n:check
```

| Beklenti | Doğrulama |
|---|---|
| `tsc --noEmit` | 0 hata (silinen import'lar veya tip refs orphan değil) |
| `vitest run` | 232/232 PASS (W1-F deploy state ile aynı sayı) |
| `vite build` | success |
| `npm run i18n:check` | 201 eksik (sırf W3 scope), parity widening = 0 |

### E.3 Manuel browser smoke (production deploy sonrası — kullanıcı doğrular)

**Goal:** Eski stabil davranışın geri geldiğini doğrula. Yeni test yazma; manuel akış.

| Senaryo | Beklenen davranış |
|---|---|
| 1. Devices listesi → "Hızlı Erişim" SSH → ayrı tab açılır | xterm yüklenir, prompt görünür |
| 2. Switch komutları (`show ver`, `show vlan`) çalışır | Çıktı render olur |
| 3. Manual disconnect button tıklanır | WS kapanır, "[Manually disconnected]" görünür |
| 4. DB kontrol — `SELECT * FROM terminal_session_logs WHERE ...` | Row var, `exit_reason='user_closed'`, `input_bytes>0`, `output_bytes>0`, `commands_count>0` |
| 5. TerminalSessions listesi → row tıklanır → drawer | Komutlar listesi görünür, AI summarize buton çalışır |
| 6. DeviceDetail → Terminal sekmesi → Canlı SSH | Aynı akış, embed terminal |
| 7. Browser tab kapatılır (zorla) | DB row `ended_at=NOW`, `exit_reason='user_closed'` |
| 8. TerminalSessions ekranı aksiyon kolonu | **YOK** (terminate button kaldırıldı) |
| 9. Audit Log ekranı | `terminal_sessions.terminate` aksiyonu **listelenmez** (yeni entry yok; eski 3 entry korunur, history) |
| 10. /api/v1/terminal-sessions/X/terminate POST | **404 Not Found** (endpoint silindi) |

### E.4 cURL smoke (production)

```bash
# Endpoint silindi doğrulaması
curl -X POST http://prod/api/v1/terminal-sessions/test/terminate \
  -H "Authorization: Bearer <token>"
# Beklenen: 404 (önceden 401 dönüyordu, artık endpoint yok)

# Diğer terminal_sessions endpoint'leri çalışmaya devam
curl http://prod/api/v1/terminal-sessions
# Beklenen: 200 (list endpoint, KORUNUR)
```

---

## F. Backend-only mi yoksa frontend+backend mi deploy gerekir?

### **BACKEND + FRONTEND BIRLIKTE deploy gerekir.**

| Tip | Etkilenen | Sebep |
|---|---|---|
| Backend code | ws.py, terminal_sessions.py, user.py, permission_set.py, audit_service.py, agent_manager.py | 6 dosya geri alınır → backend image rebuild zorunlu |
| Frontend code | TerminalSessions/index.tsx, api/terminalSessions.ts | 2 dosya geri alınır → frontend bundle yeniden derlenir |
| Frontend i18n | 4 locale json | Bundle'a embed → JS hash değişir → frontend image rebuild |
| Docs | 3 dosya silinir | Repo state — deploy etkilemez |
| Tests | 2 dosya silinir | CI/test pipeline — deploy etkilemez |

**Rolling sırası (W1-F'den farklı, SSH Term ilk deploy'unun TERS sırası):**

> **Frontend ÖNCE, backend SONRA.** Frontend butonu kaldırılır → kullanıcı POST yapamaz → backend endpoint kaldırılırken hiç çağrı gelmez (404 race önler).

**Alternatif sıra:** Backend önce, frontend sonra → kullanıcı endpoint kaldırılmış halde butona basarsa 404 alır. Bu da zarar değil, sadece bir kez UX. Ama frontend önce daha temiz.

---

## G. Rollback sonrası manuel smoke test adımları

### Pre-deploy doğrulama (lokal merge öncesi)

| Adım | Komut | Beklenen |
|---|---|---|
| 1 | `git diff origin/main HEAD --stat` | 14 dosya değişir (6 backend kod + 2 backend test sil + 2 frontend kod + 4 locale) + 3 docs silinir = **17 dosya** |
| 2 | `git diff origin/main HEAD -- backend/app/services/terminal_session_logger.py` | EMPTY (logger close() dokunulmadı — pre-PR#16 hali korunur) |
| 3 | Backend pytest | Mevcut + yeni-silmiş testler yok; pre-existing 45 fail aynı |
| 4 | Frontend tsc/vitest/build/i18n | Tümü yeşil |
| 5 | Locale parity | 201 W3 sırf help.faq_* — widening yok |

### Production smoke (revert deploy sonrası)

**Backend smoke:**
```bash
curl -ks http://localhost/health/ready
# {"status":"ok"...}

curl -X POST http://localhost/api/v1/terminal-sessions/test/terminate -H "Auth: Bearer x"
# Beklenen: HTTP 404 Not Found  (endpoint silindi)

curl http://localhost/api/v1/terminal-sessions
# Beklenen: HTTP 401 (token yok ama endpoint live — list endpoint korundu)
```

**Frontend smoke:**
- `/terminal-sessions` sayfası açılır, tablo render olur
- Aksiyon kolonu **YOK**
- Audit Log sayfası açılır, mevcut entry'ler görünür
- DeviceDetail → Terminal sekmesi → Canlı SSH bağlanır
- Devices listesi → Hızlı Erişim SSH ayrı tab'da bağlanır

**DB smoke:**
```sql
SELECT exit_reason, COUNT(*) FROM terminal_session_logs
WHERE started_at > NOW() - INTERVAL '1 day'
GROUP BY exit_reason;
-- Beklenen: yeni session'lar 'user_closed' / 'idle_timeout' / 'agent_disconnected'
-- (force_closed yeni eklenmemeli, ama eski 1 entry tarihsel olarak duruyor — sorun değil)
```

---

## H. Deploy / Rollback planı

### H.1 Pre-deploy state

| Kontrol | Beklenen |
|---|---|
| Local main HEAD | `1cc0d6e` (W1-F + SSH Term + docs) |
| Revert branch HEAD | `<revert commit SHA>` |
| Backend image (prod) | `e644ca978e54` (SSH Term deployed) |
| Frontend image (prod) | `71d3c3c5a4cd` (SSH Term deployed) |
| alembic | `f9aeportpol` (DEĞIŞMEZ) |

### H.2 Branch + PR

```
1. git fetch origin main
2. git checkout -B t10/revert-ssh-session-termination origin/main
3. # 12 commit revert (ters sırayla, --no-commit)
   for sha in 1cc0d6e a60d53d fa49e3d feea51f 2c75094 63580af 00d1ce6 10035f5 6b7b34d d42a41e c0cbaef f51313f; do
     git revert --no-commit $sha
   done
4. # Conflict olursa elle çöz (beklenmiyor — ws.py'da overlap olabilir)
5. # Doc dosyaları varsa hâlâ silinmemişse silr (revert temizler):
   rm -f docs/SSH_SESSION_TERMINATION_IMPL_PLAN.md
   rm -f docs/SSH_SESSION_TERMINATION_DEPLOY_PLAN.md
   rm -f docs/SSH_TERMINATION_RCA_2026-06-07.md
   git add -A
6. # Tek atomik commit
   git commit -m "revert: SSH Session Termination feature (cancel + restore pre-feature state)"
7. # Lokal smoke
   cd frontend && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run && ./node_modules/.bin/vite build && npm run i18n:check
   cd backend && env -i PATH="..." python3 -m pytest tests/ --ignore=...
8. # Push + PR
   git push -u origin t10/revert-ssh-session-termination
   gh pr create --base main --title "revert: SSH Session Termination feature (cancel + rollback)" --body "..."
```

### H.3 PR onayı + merge

- Sizden PR review + merge GO
- PR merged → main `<new revert SHA>`

### H.4 Production deploy

**Rolling: FRONTEND ÖNCE → BACKEND SONRA** (terminate button kaldırılır → çağrı kalmaz → backend endpoint silinir)

```bash
ssh root@93.180.133.88
cd /opt/netmanager

# P0 — Anchor + 2 rollback tag (geri-dönüş için her ihtimale karşı)
TS=$(date +%Y%m%d_%H%M)
docker tag 71d3c3c5a4cd "netmanager-frontend:rollback-revert-ssh-term-$TS"
docker tag e644ca978e54 "netmanager-backend:rollback-revert-ssh-term-$TS"

# P1 — git fetch + ff-merge
git fetch origin main
git merge --ff-only origin/main

# P2 — Frontend build ÖNCE
docker compose build frontend

# P3 — Frontend recreate
docker compose up -d --no-deps frontend
sleep 5

# Frontend smoke: terminate button artık görünmez (browser test)

# P4 — Backend build
docker compose build backend

# P5 — Backend recreate
docker compose up -d --no-deps backend
sleep 8

# P6 — Curl smoke
curl -ks http://localhost/health/ready
curl -ks -X POST http://localhost/api/v1/terminal-sessions/test/terminate \
  -H "Authorization: Bearer DUMMY"
# Beklenen: 404 Not Found (endpoint kaldırıldı)

curl -ks http://localhost/api/v1/terminal-sessions
# Beklenen: 401 (token yok; list endpoint live)

curl -ksI http://localhost/login
curl -ksI http://localhost/terminal-sessions
curl -ksI http://localhost/devices

# P7 — Servis matrisi + alembic assert
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
docker compose exec -T postgres psql -U $PG_USER -d $PG_DB -tAc 'SELECT version_num FROM alembic_version;'
# Beklenen: f9aeportpol (DEĞIŞMEDİ)

# P8 — Deploy log doc
# docs/SSH_TERMINATION_REVERT_DEPLOY_LOG_<TS>.md
```

### H.5 Rollback (deploy başarısız olursa)

```bash
# Frontend rollback (önce — yeniden butonu görünür yap)
docker tag netmanager-frontend:rollback-revert-ssh-term-<TS> netmanager-frontend:latest
docker compose up -d --no-deps frontend

# Backend rollback (sonra — endpoint geri gelir)
docker tag netmanager-backend:rollback-revert-ssh-term-<TS> netmanager-backend:latest
docker compose up -d --no-deps backend

# Git
git reset --hard 1cc0d6e   # mevcut SSH Term deploy state
```

Süre: ~30-40sn. **Bu rollback'in rollback'i** — kullanıcı isterse PR #16 state'e dönülür. Pratik: gerekli olmamalı çünkü revert temiz olmalı.

### H.6 PR'ları kapatma

Manuel:
- PR #7 (design doc, open) → `gh pr close 7 --comment "SSH Session Termination feature cancelled; not merging"`
- PR #17 (deploy log, open) → `gh pr close 17 --comment "SSH Session Termination feature cancelled"`
- PR #19 (hotfix, open) → `gh pr close 19 --comment "SSH Session Termination feature cancelled; superseded by revert PR"`

İsteğe bağlı: branch'leri sil (`git push origin --delete t10/ssh-session-termination-hotfix` vs.).

---

## Onay matrisi

| Aşama | Onay |
|---|---|
| **Bu rollback plan dokümanı review + onay** | ⏳ |
| **Revert implementation GO** | ⏳ (kullanıcı explicit) |
| Revert PR oluştur (12 commit revert, 3 doc sil) | (GO sonrası) |
| Lokal pipeline yeşil | (PR oluşturulurken) |
| PR review + merge | (test yeşil sonrası) |
| Production deploy (frontend → backend rolling) | (merge sonrası — ayrı GO) |
| Manuel smoke (10 senaryo) | (deploy sonrası, kullanıcı doğrular) |
| Açık PR'ları kapat (#7 #17 #19) | (deploy sonrası) |

**Bu plan KOD YAZMAZ.** Sadece envanteri ve adımları sabitler. Sizden "revert başla" GO geldiğinde branch'e geçer, 12 commit revert + 3 doc silme atomik commit'i oluşturur, test pipeline çalıştırır, PR açar.

---

## Özet — Tek paragraf

PR #16 (10 commit, implementation), PR #15 (1 commit, impl plan doc), PR #18 (1 commit, RCA doc) = origin/main'de 12 commit. Bunları ters sırayla `git revert --no-commit` ile yığar, tek atomik commit yapar, ayrıca 3 doc dosyasını ekstra siler. Toplam **17 dosya** değişir (6 backend kod + 2 backend test sil + 2 frontend kod + 4 locale + 3 doc sil). PR #7 (design doc, open), PR #17 (deploy log, open), PR #19 (hotfix, open) → kapanır. **Backend + frontend birlikte rolling deploy** (frontend önce → backend sonra). alembic değişmez, Postgres/Redis/Celery/Nginx dokunulmaz. Manuel smoke: terminate button yok, endpoint 404, SSH log akışı çalışıyor.
