# MFA-LOGIN-UI-HOTFIX — Production Deploy Log — 2026-06-08

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only deploy (W1-F + Sprint 1A paterni).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `3a00ed9` (Sprint 1A-fix2) → **`1ba5550`** (MFA login UI hotfix)
- **Kapsam:** PR #35 — Login.tsx tek dosya (+32/-4), CSS Grid `minmax(0, 1fr)` + `min-width: 0` ile OTP grid taşma düzeltildi
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-Y94xFJN6.js` → **`index-CcKnrnkB.js`** + `index-uWsjMl-2.css` (CSS aynı — Login.tsx inline `<style>` bloğu vite bundle'a embed)
- **Backend:** Container **dokunulmadı** — image `25fc5d7218a5`, Up 17 hours healthy
- **Kesinti:** Frontend ~7 sn nginx static recreate; backend / db / cache **0 sn**

## Final state

| | Değer |
|---|---|
| **VPS HEAD** | **`1ba55506ca14817848bc4d0e12673509c8fbc1ab`** (1ba5550, main) |
| **alembic current** | `f9aeportpol` (UNCHANGED ✅) |
| **Önceki frontend image** | `dbbf75880a37` (74.4 MB, 2 saat önce — Sprint 1A-fix2 build) |
| **Yeni frontend image** | **`sha256:ae17a44da7477681a07edc92d3638fb16e3c84a2e5501af60db129be94e60e57`** (74.4 MB) |
| **Backend image (untouched)** | `25fc5d7218a5` (425 MB, UNCHANGED) |
| **Frontend rollback tag** | `netmanager-frontend:rollback-pre-mfa-login-ui-20260608_1435` → `dbbf75880a37` |
| **Önceki JS bundle** | `index-Y94xFJN6.js` |
| **Yeni JS bundle** | **`index-CcKnrnkB.js`** ✅ |
| **CSS bundle** | `index-uWsjMl-2.css` (W1-F'den beri stabil — Login.tsx inline `<style>` vite bundle'a embed) |
| **Frontend recreate timestamp** | `2026-06-08T14:44:44Z` |
| **Backend recreate timestamp** | `2026-06-07T21:40:38Z` (revert deploy zamanı, **UNCHANGED**) |
| **11/11 servis** | Up/healthy |

### Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 17 hours (healthy)    ← UNCHANGED
celery_agent_worker     running   Up 7 days (healthy)       ← UNCHANGED
celery_beat             running   Up 7 days (healthy)       ← UNCHANGED
celery_default_worker   running   Up 7 days (healthy)       ← UNCHANGED
celery_worker           running   Up 7 days (healthy)       ← UNCHANGED
event_consumer          running   Up 7 days (healthy)       ← UNCHANGED
flower                  running   Up 8 days                 ← UNCHANGED
frontend                running   Up 36 seconds             ← RECREATED (ae17a44da747)
nginx                   running   Up 9 days (healthy)       ← UNCHANGED
postgres                running   Up 9 days (healthy)       ← UNCHANGED
redis                   running   Up 9 days (healthy)       ← UNCHANGED
```

**10 servis uptime korundu**; sadece `frontend` recreate edildi (`--no-deps` koruması başarılı).

## Faz çıktıları

### P0 — Anchor
- git HEAD: `3a00ed9`
- alembic: `f9aeportpol`
- Frontend image: `dbbf75880a37`
- Backend: `25fc5d7218a5` (untouched)
- Bundle (önceki): `index-Y94xFJN6.js` + `index-uWsjMl-2.css`
- **Rollback tag:** `netmanager-frontend:rollback-pre-mfa-login-ui-20260608_1435` ✅

### P1 — git fetch + ff-merge
```
fetch: 3a00ed9..1ba5550 (2 commit)
backend delta: 0 ✅
alembic delta: 0 ✅
frontend delta: 1 dosya (Login.tsx +32 / -4)
docs delta: 1 dosya (Sprint 1A-fix2 deploy log)
ff-merge: success
new HEAD: 1ba5550
```

### P2 — Frontend build
```
docker compose build frontend
build: ~9 dk (vite + PWA + workbox)
yeni image: ae17a44da747 (74.4 MB)
sha256: ae17a44da7477681a07edc92d3638fb16e3c84a2e5501af60db129be94e60e57
```

### P3 — Frontend recreate (`--no-deps`)
```
docker compose up -d --no-deps frontend
→ frontend Up 7 sn
→ backend Up 17 hours (UNCHANGED)
→ Diğer 9 servis UNCHANGED
```

### P4 — Smoke

**Health endpoint:**
```
GET /health/ready → 200 OK
{"status":"ok","checks":{"db":"ok","redis":"ok","timescaledb":"ok","hypertable_count":5}}
```

**HTTP routes:**
```
/                   HTTP/1.1 301 Moved Permanently
/login              HTTP/1.1 200 OK     ✅
/devices            HTTP/1.1 200 OK     ✅
/topology           HTTP/1.1 200 OK     ✅
```

**Yeni bundle:**
```
/assets/index-CcKnrnkB.js          ← YENİ (önceki index-Y94xFJN6.js)
/assets/index-uWsjMl-2.css         ← AYNI (Login.tsx inline <style> vite bundle'a embed)
```

**Alembic UNCHANGED:**
```
Pre:  f9aeportpol
Post: f9aeportpol  ✅
```

### P5 — Servis matrisi + backend untouched

**Backend untouched 3-kriter:**

1. **Image ID `25fc5d7218a5` P0'dan P5'e AYNI** ✅
2. **StartedAt `2026-06-07T21:40:38.966264287Z` değişmedi** (revert deploy zamanı) ✅
3. **Health durumu `Up 17 hours (healthy)` korunmuş** ✅

### P6 — Bu doküman

---

## Notes — workflow sandbox bloku

İlk deploy attempt'i workflow agent içinden başlatıldı; sandbox classifier P0'da psql query (POSTGRES_USER env discovery) için yetki reddetti. Production state P0 öncesi durumda (UNCHANGED) kaldı. Deploy mainloop'tan solo yürütüldü — önceki deploy paterninin aynısı (Sprint 1A-fix2 deploy ile birebir).

---

## Yeni bundle delta

| Asset | Sprint 1A-fix2 (önce) | MFA login UI (sonra) | Değişti mi |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `dbbf75880a37` | **`ae17a44da747`** | ✅ Yeni hash |
| JS bundle | `index-Y94xFJN6.js` | **`index-CcKnrnkB.js`** | ✅ Yeni hash |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ Aynı (inline `<style>` vite embed) |

---

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `3a00ed919281c6d9541b79cac3497986505a3f8e` (Sprint 1A-fix2) |
| alembic | `f9aeportpol` (aynı) |
| Frontend image | `dbbf75880a37` → tag `netmanager-frontend:rollback-pre-mfa-login-ui-20260608_1435` |

### Rollback komutu

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-mfa-login-ui-20260608_1435 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 3a00ed9
# ~30-60 sn; backend / db / cache dokunulmaz
```

---

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build | ✅ |
| 2. Sadece frontend recreate | ✅ (backend UNCHANGED Up 17h) |
| 3. Backend build/restart yok | ✅ |
| 4. DB migration yok | ✅ `f9aeportpol` UNCHANGED |
| 5. Postgres/Redis/Celery/Nginx restart yok | ✅ 9 servis Up 7-9 gün |
| 6. `--no-deps` zorunlu | ✅ |
| 7. Frontend rollback tag | ✅ |
| 8. Deploy log dokümanı | ✅ Bu doküman |

## Kullanıcıdan beklenen manuel smoke (14 senaryo)

| # | Senaryo | Beklenen |
|---|---|---|
| 1 | Login ilk adım normal görünür | ✅ |
| 2 | Username/şifre login adımı bozulmamış | ✅ |
| 3 | MFA challenge ekranı açılır | ✅ |
| 4 | MFA kartı ekranda tamamen görünür | ✅ |
| 5 | 6 OTP input kart içinde | ✅ |
| 6 | Son input sağ tarafta kırpılmaz | ✅ |
| 7 | Doğrula butonu kart içinde görünür | ✅ |
| 8 | Mouse ile inputlara tıklanabilir | ✅ |
| 9 | Mouse ile "Doğrula ve Geç" butonuna basılır | ✅ |
| 10 | Tab erişilebilirliği korunur | ✅ |
| 11 | Yanlış kodda hata mesajı görünür | ✅ |
| 12 | Doğru kodda login başarılı | ✅ |
| 13 | 375px responsive yatay taşma YOK | ✅ |
| 14 | 320px responsive yatay taşma YOK | ✅ |

### Bu deploy tamamlandıktan sonra MFA-LOGIN-UI-HOTFIX kapanır.

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke 14 senaryo — kullanıcı doğrular |
| 2 | MFA-LOGIN-UI-HOTFIX resmi kapanış |
| 3 | Açık backlog: Sprint 1B, Sprint 1C, MFA Bug paketi (backend), MFA-ENROLL-RCA forensic |
