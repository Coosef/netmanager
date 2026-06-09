# W1-G — Login i18n Cleanup — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only, cherry-pick stratejisi devam (Sprint 2A YOK).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `3e727e1` (auth persist hidrasyon) → **`305e4be`** (W1-G i18n cleanup cherry-pick)
- **Kapsam:** PR #49 — Login hardcoded TR string'ler 4 dilde paralel locale'e taşındı (36 yeni nested key, 5 alt-namespace)
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-BNwKfP05.js` → **`index-C5hbUZ7Y.js`**
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅ (Sprint 1A'dan beri **14 deploy**)
- **Sprint 2A kodu prod'a girmedi** ✅ (cherry-pick bypass devam)
- **PR #43 PWA fixleri korundu** ✅
- **PR #39/#41/#45/#47 auth hotfix zinciri korundu** ✅

## A-P — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #49 merge** | `ecd3e98f9fef53ca3c9adc55296e88dc153d44f0` ✅ |
| W1-G commit (main) | `b66f630 feat(login): i18n cleanup — extract hardcoded TR strings to locales` |
| **B. VPS HEAD** | **`305e4be`** (cherry-pick'lenmiş W1-G i18n cleanup) |
| **C. Main HEAD (GitHub)** | `ecd3e98` (Sprint 2A `49e9ae6` içeride AMA cherry-pick ile sadece W1-G) |
| **D. Sprint 2A prod ağacında YOK kanıtı** | `git log \| grep '49e9ae6'` → **0 satır** ✅ |
| **E. Önceki frontend image** | `723db19a8003` (auth persist hidrasyon hotfix build) |
| **F. Yeni frontend image** | **`sha256:8bd10e589fc727600f03d4fc532f00b13b566d42f66bcbec1ead4c912afda477`** (74.4 MB) |
| **G. Rollback tag** | `netmanager-frontend:rollback-pre-w1g-i18n-20260609_1436` → `723db19a8003` |
| **H. Önceki JS bundle** | `index-BNwKfP05.js` |
| **H. Yeni JS bundle** | **`index-C5hbUZ7Y.js`** ✅ |
| **H. CSS bundle** | `index-uWsjMl-2.css` (AYNI — string değişimi JSX, CSS dokunmadı) |
| **I. Eklenen i18n key sayısı** | **36 nested key × 4 dil = 144 toplam satır** (login.step1/step2/method/step3/err.*) |
| **J. i18n widening = 0 kanıtı** | tr 2381 / en 2338 / de 2302 / ru 2302 — eksik 201 → 201, **paralel ekleme tam ✅** |
| **K. Backend image UNCHANGED** | `25fc5d7218a5` ✅ |
| **L. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **M. Backend/alembic/compose delta** | **0/0/0** ✅ |
| **N. 11/11 servis health** | ✅ |
| **O. /login** | `HTTP/1.1 200 OK` ✅ |
| **P. /health/ready** | `200 OK` — db/redis/timescaledb ok ✅ |

## Bundle i18n key doğrulaması

Yeni bundle `index-C5hbUZ7Y.js` içinde 6 örnek key:

| Key | Durum |
|---|---|
| `login.step1.badge` | ✅ PRESENT |
| `login.step2.hint_totp` | ✅ PRESENT |
| `login.method.totp_label` | ✅ PRESENT |
| `login.step3.title` | ✅ PRESENT |
| `login.err.invalid_code` | ✅ PRESENT |
| `login.step2.send_email` | ✅ PRESENT |

Locale içeriği örnekleri (4 dilde):

| Değer | Dil | Durum |
|---|---|---|
| `Authenticator` | TR/EN/DE method.totp_label | ✅ PRESENT |
| `Anmeldung` | DE step1.submitting | ✅ PRESENT |
| `Войти` | RU step1.* | ✅ PRESENT |

## sw.js — PR #43 PWA cache fixleri KORUNDU

| String | Durum |
|---|---|
| `NavigationRoute` | **YOK** ✅ |
| `api-cache` | **YOK** ✅ |
| `NetworkFirst` | **YOK** ✅ |
| `cleanupOutdatedCaches` | **VAR** ✅ |

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 7 hours (healthy)        ← image UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 7 hours (healthy)        ← UNCHANGED
celery_beat             running   Up 7 hours (healthy)        ← UNCHANGED
celery_default_worker   running   Up 7 hours (healthy)        ← UNCHANGED
celery_worker           running   Up 7 hours (healthy)        ← UNCHANGED
event_consumer          running   Up 7 hours (healthy)        ← UNCHANGED
flower                  running   Up 7 hours                  ← UNCHANGED
frontend                running   Up 45 seconds               ← RECREATED (8bd10e589fc7)
nginx                   running   Up 7 hours (healthy)        ← UNCHANGED
postgres                running   Up 7 hours (healthy)        ← UNCHANGED
redis                   running   Up 7 hours (healthy)        ← UNCHANGED
```

**10 servis Up 7 hours**; sadece `frontend` recreate edildi.

## Sprint 2A bypass kanıtı (devam)

```
VPS git log son 3:
305e4be feat(login): i18n cleanup — extract hardcoded TR strings to locales (W1-G)  ← YENİ
3e727e1 fix(auth): use zustand persist api for hydration (kill setter chain)
a654705 fix(auth): redirect authenticated user from /login to dashboard

VPS git log | grep '49e9ae6' → 0  (Sprint 2A YOK) ✅
```

## Hotfix + epik zinciri (prod ağacında aktif)

| # | Commit | PR | Kapsam |
|---|---|---|---|
| 1 | `1ba5550` | — | MFA login UI OTP grid taşma |
| 2 | `fa56968` ← `e01e37f` | #39 | Auth refresh hydrate guard |
| 3 | `62e36d7` ← `0ce1e1a` | #41 | Dashboard hotfix |
| 4 | `d719d8a` ← `55eecac` | #43 | PWA cache hotfix |
| 5 | `a654705` ← `948808e` | #45 | Login redirect hotfix |
| 6 | `3e727e1` ← `b5055c1` | #47 | Auth persist hidrasyon hotfix |
| 7 | **`305e4be` ← `b66f630`** | **#49** | **W1-G — Login i18n cleanup** ⭐ |

## Bundle delta

| Asset | Auth persist hidrasyon | W1-G i18n | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `723db19a8003` | **`8bd10e589fc7`** | ✅ |
| JS bundle | `index-BNwKfP05.js` | **`index-C5hbUZ7Y.js`** | ✅ |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ AYNI |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `3e727e1` (auth persist hidrasyon hotfix) |
| alembic | `f9aeportpol` |
| Frontend image | `723db19a8003` → tag `netmanager-frontend:rollback-pre-w1g-i18n-20260609_1436` |

### Rollback komutu (gerekirse)

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-w1g-i18n-20260609_1436 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 3e727e1
```

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build/deploy | ✅ |
| 2-6. Backend / DB / migration / restart / compose yok | ✅ |
| 7. Sprint 2A prod'a alınmadı | ✅ |
| 8. Dashboard refresh/auth backlog'una dokunulmadı | ✅ |
| 9. SSH Termination KAPALI | ✅ |
| 10. Auth hotfix zincirine dokunulmadı | ✅ PR #39+#41+#43+#45+#47 korundu |

## Kullanıcıdan beklenen manuel smoke (8 senaryo)

1. Login ekranı **TR** açılır
2. Dil **EN** yapılır → tüm Step 1 metinleri İngilizce
3. Dil **DE** yapılır → tüm Step 1 metinleri Almanca
4. Dil **RU** yapılır → tüm Step 1 metinleri Rusça
5. MFA ekranı açılırsa başlık/hint/buton metinleri çevrilir (3 hint variant, 3 method tab, send_email button, resend, email_sent_to)
6. Login akışı bozulmamış (form submit, validation, MFA verify)
7. Console runtime error yok
8. Network 401/403/500 yok

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke 4 dil — kullanıcı doğrular |
| 2 | W1-G memory entry (kapanış) |
| 3 | Sıradaki backlog: Audit Log UI v2 (Wave 2) veya Sprint 1C UX backlog (Unassigned location seed) veya MFA backend hardening (H8 + H13) |
| 4 | Dashboard refresh/auth bug ileride mimari karar (AuthBootGate + PublicOnlyRoute pattern) — backlog'da bekler |
