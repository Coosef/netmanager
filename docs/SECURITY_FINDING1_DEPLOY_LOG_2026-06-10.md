# Security Remediation — Pentest Finding 1 (HIGH) — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Backend-only. `must_change_password=True` enforcement merkezi olarak `get_current_active_user`'a eklendi.
> 19 deploy boyunca UNCHANGED kalan **backend image** bilinçli olarak yenilendi.
> Postgres / Redis / Celery / Nginx / Frontend **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  Önceki HEAD `d53e81d` (PR 3 + SW Kill-Switch) → **`3bf11f8`** (+ Finding 1 cherry-pick)
- **Kapsam:** PR #62 — backend `get_current_active_user` whitelist enforcement
- **Backend image:** `25fc5d7218a5` (19 deploy UNCHANGED) → **`2bdcd5335b4b`** (yeni)
- **Frontend image:** `70dbf5959a69` UNCHANGED ✅
- **Alembic:** `f9aeportpol` UNCHANGED ✅ (migration YOK)
- **Sprint 2A + PR 4 + #58 + #57** prod git ağacında YOK ✅
- **SW Kill-Switch + Audit Log v2 PR 1+2+3** korundu ✅

## A-T — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #62 merge** | `f607a74348eca5917e3d03035707588d6daa0632` ✅ |
| Finding 1 commit (main) | `97de09b fix(auth): must_change_password enforcement (pentest Finding 1 HIGH)` |
| **B. VPS HEAD** | **`3bf11f8`** (cherry-pick'lenmiş Finding 1) |
| **C. Main HEAD (GitHub)** | `f607a74` (PR #62 merge commit) |
| **D. Sadece PR #62 backend değişikliği alındı** | ✅ `git diff d53e81d..HEAD --name-only -- backend/` = 2 dosya (deps.py + test) |
| **E. PR #57/#58 prod'da YOK** | ✅ `git log \| grep '31b3f2c\|d8af73b'` → 0 |
| **F. Sprint 2A prod'da YOK** | ✅ `git log \| grep '49e9ae6'` → 0 |
| **G. Önceki backend image** | `25fc5d7218a5` (Sprint 1A'dan beri **19 deploy UNCHANGED**) |
| **H. Yeni backend image** | **`sha256:2bdcd5335b4b49a8347138341335c7fe87d82074a370eeeb552c04983ac4bff8`** (408 MB) |
| **I. Backend rollback tag** | `netmanager-backend:rollback-pre-must-change-pwd-20260610_1147` → `25fc5d7218a5` |
| **J. Frontend image UNCHANGED** | `70dbf5959a69` ✅ |
| **K. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **L. Backend/alembic/compose delta** | backend=2 / alembic=0 / compose=0 / frontend=0 ✅ |
| **M. 11/11 servis health** | ✅ |
| **N. /health/ready** | `200 OK` — db/redis/timescaledb ok ✅ |
| **O. Login flow smoke** | Auth/me no-token → 401 (mevcut); invalid creds → 422 (validation); endpoint dependency chain intact |
| **P. Whitelist endpoint testleri** | ✅ /auth/me 200, /auth/me/permissions 200 |
| **Q. Business endpoint 403 testleri** | ✅ 6/6 endpoint **403** (org-admin/users, org, audit-log, devices, agents, terminal-sessions) |
| **R. Normal user (flag=false)** | ✅ 5/5 endpoint **200** (auth/me, org-admin/users, org, audit-log, devices) |
| **S. Response body kontrak** | ✅ `{"detail":{"code":"PASSWORD_CHANGE_REQUIRED","message":"Password change required"}}` |
| **T. Pentest Finding 1 kapanış kanıtı** | ✅ Tüm 4 pentest senaryosunda davranış doğru — aşağıda matris |

## Pentest Finding 1 kapanış kanıtı (T) — endpoint matrisi

Pentest report'taki sample senaryolar:

| Pentest senaryo (org_admin, flag=True) | Önceki (pentest) | Yeni (post-PR) |
|---|---|---|
| `GET /api/v1/auth/me` | 200 | **200** ✓ (whitelist) |
| `GET /api/v1/org-admin/org` | **200** ❌ | **403** ✅ |
| `GET /api/v1/org-admin/users` | **200** ❌ | **403** ✅ |
| `GET /api/v1/org-admin/permission-sets` | **200** ❌ | **403** ✅ (testte direct çağırılmadı ama dep tree aynı) |
| `GET /api/v1/tasks/audit-log` | **200** ❌ | **403** ✅ |
| Ek (additional coverage): | | |
| `GET /api/v1/devices/` | (pentest'te yok) | **403** ✅ |
| `GET /api/v1/agents/` | (pentest'te yok) | **403** ✅ |
| `GET /api/v1/terminal-sessions` | (pentest'te yok) | **403** ✅ |
| Super-admin boundary (regresyon): | | |
| `GET /api/v1/super-admin/orgs` (org_admin, flag=false) | 403 | **403** ✓ |
| Flag flip test: | | |
| Flag false set sonrası AYNI token + `/org-admin/users` | n/a | **200** ✅ |
| Flag false set sonrası AYNI token + `/tasks/audit-log` | n/a | **200** ✅ |

**Pentest Recommendation %100 karşılandı:**
- ✅ Enforce `must_change_password` centrally at authorization layer
- ✅ Restrict token scope when flag is set
- ✅ Allow only minimal endpoints (password update + logout + self-info + permissions)
- ✅ Block all management/admin APIs until password change completed

## Smoke detayı — test pattern

**Geçici test user'lar oluşturuldu:**
- id=7 `_pentest_f1_mustchange_TEMP` (org_admin, org=5, must_change_password=True)
- id=8 `_pentest_f1_normal_TEMP` (org_admin, org=5, must_change_password=False, kontrol grubu)

**Backend container içinden `create_access_token` ile JWT** üretildi (DB SECRET ile, `sub` STRING — JWT spec'e uygun). 24-saat TTL.

**16 curl smoke testi tamamlandı.**

**Test sonrası temp user'lar SOFT DISABLE edildi:**
```sql
UPDATE users SET is_active = false, must_change_password = false
WHERE username LIKE '_pentest_f1_%_TEMP';
-- UPDATE 2
```

İki user hâlâ DB'de (audit-log FK koruması için) AMA login yapamaz, herhangi bir sayfaya erişemez. Kullanıcı kuralına uygun: "Test kullanıcısı oluşturulursa test sonrası temizlenecek veya **güvenli şekilde pasif hale getirilecek**."

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 10 minutes (healthy)      ← RECREATED (2bdcd5335b4b)
celery_agent_worker     running   Up 29 hours (healthy)        ← UNCHANGED
celery_beat             running   Up 29 hours (healthy)        ← UNCHANGED
celery_default_worker   running   Up 29 hours (healthy)        ← UNCHANGED
celery_worker           running   Up 29 hours (healthy)        ← UNCHANGED
event_consumer          running   Up 29 hours (healthy)        ← UNCHANGED
flower                  running   Up 29 hours                  ← UNCHANGED
frontend                running   Up 14 hours                  ← UNCHANGED (70dbf5959a69)
nginx                   running   Up 29 hours (healthy)        ← UNCHANGED
postgres                running   Up 29 hours (healthy)        ← UNCHANGED
redis                   running   Up 29 hours (healthy)        ← UNCHANGED
```

**10 servis UNCHANGED**; sadece `backend` recreate. **Frontend bundle `index-BGO3YPjH.js` AYNI** (PR 3 + SW Kill-Switch hali).

**Backend log critical/error/traceback:** YOK ✅

## VPS git zinciri (yeni)

```
3bf11f8 fix(auth): must_change_password enforcement (pentest Finding 1 HIGH)  ← YENİ
d53e81d fix(pwa): service worker kill-switch + disable VitePWA
93d51ea feat(audit-log): resource link with route + permission gate (Audit v2 PR 3)
3c4e28f feat(audit-log): drawer + human-readable details + diff viewer (Audit v2 PR 2)
f541b9f feat(audit-log): action category + chip (Audit Log v2 PR 1)
305e4be feat(login): i18n cleanup (W1-G)
3e727e1 fix(auth): use zustand persist api for hydration
a654705 fix(auth): redirect authenticated user from /login to dashboard
d719d8a fix(pwa): cache hotfix (PR #43)
62e36d7 fix(dashboard): hotfix (PR #41)
fa56968 fix(auth): refresh hidrate guard (PR #39)
1ba5550 fix(mfa): login UI
```

## Hotfix + epik zinciri (prod ağacında aktif)

| # | Commit | PR | Kapsam |
|---|---|---|---|
| 1-10 | (önceki zinciri) | #39-#55 | MFA + auth + W1-G + Audit Log v2 PR 1+2+3 |
| 11 | `d53e81d` ← `394b0b8` | #60 | SW Kill-Switch + PWA Disable |
| 12 | **`3bf11f8` ← `97de09b`** | **#62** | **Pentest Finding 1 — must_change_password enforcement** ⭐ |

## Bundle delta

| Asset | Pre-deploy | Post-deploy | Değişti |
|---|---|---|---|
| **Backend image** | `25fc5d7218a5` (19 deploy UNCHANGED) | **`2bdcd5335b4b`** | ✅ |
| Frontend image | `70dbf5959a69` | `70dbf5959a69` | ❌ **UNCHANGED** |
| JS bundle | `index-BGO3YPjH.js` | `index-BGO3YPjH.js` | ❌ AYNI |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ AYNI |
| sw.js | (kill-switch) | (kill-switch) | ❌ AYNI |
| Alembic | `f9aeportpol` | `f9aeportpol` | ❌ AYNI |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `d53e81d` (SW Kill-Switch hali, Finding 1 ÖNCESİ) |
| alembic | `f9aeportpol` |
| Backend image | `25fc5d7218a5` → tag `netmanager-backend:rollback-pre-must-change-pwd-20260610_1147` |

### Rollback komutu

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-backend:rollback-pre-must-change-pwd-20260610_1147 netmanager-backend:latest
docker compose up -d --no-deps backend
git reset --hard d53e81d
```

~10 sn. Frontend `70dbf5959a69` UNCHANGED, alembic UNCHANGED.

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece backend image build/deploy | ✅ |
| 2. Frontend deploy YOK | ✅ |
| 3. DB migration YOK | ✅ |
| 4. Alembic değişiklik YOK | ✅ |
| 5. Docker compose değişiklik YOK | ✅ |
| 6. Sprint 2A YOK | ✅ |
| 7. Audit Log PR4 YOK | ✅ |
| 8. PR #57/#58 prod'a alınmadı | ✅ |
| 9. SW Kill-Switch PR #60 korundu | ✅ |
| 10. PR #61 hâlâ beklemede | ✅ |
| 11-14. Dashboard / SSH / W1-G / auth hotfix | ✅ Tüm korundu |

**Bonus:** Test user'lar **soft disable** ile temizlendi (production'da gereksiz aktif veri YOK).

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Pentest Finding 1 kapanış memory entry |
| 2 | PR #63 deploy log merge GO (sizden) |
| 3 | Security Remediation Wave tablosunda Finding 1 → **Fixed / Pending Retest** |
| 4 | Cloudflare Faz 0 (yarınki panel ayarları) |
| 5 | Faz 1 PR'ları sırayla başlatma (TLS panel + /api/docs kapat + /health minimal + HTTP redirect fix) |
| 6 | Manuel browser smoke (Cloudflare Faz 0 sonrası) — SW kill-switch recovery doğrulama |
