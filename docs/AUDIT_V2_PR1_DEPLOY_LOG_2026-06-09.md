# Audit Log v2 PR 1 — AuditActionChip — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only, cherry-pick stratejisi devam (Sprint 2A YOK).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `305e4be` (W1-G Login i18n) → **`f541b9f`** (Audit v2 PR 1 cherry-pick)
- **Kapsam:** PR #51 — AuditActionChip + auditActionCategory (action kolonu kategori-bazlı görsel)
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-C5hbUZ7Y.js` → **`index-SaJQaqTX.js`**
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅ (Sprint 1A'dan beri **15 deploy**)
- **Sprint 2A kodu prod'a girmedi** ✅ (cherry-pick bypass devam)
- **PR #43 PWA fixleri korundu** ✅

## A-R — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #51 merge** | `88332cab97f8e41995156b250e17a0f8eef01a83` ✅ |
| Audit v2 PR 1 commit (main) | `fba75d3 feat(audit-log): action category + chip (Audit Log v2 PR 1)` |
| **B. VPS HEAD** | **`f541b9f`** (cherry-pick'lenmiş Audit v2 PR 1) |
| **C. Main HEAD (GitHub)** | `88332ca` (merge commit, Sprint 2A `49e9ae6` içeride AMA cherry-pick ile sadece PR 1) |
| **D. Sprint 2A prod ağacında YOK kanıtı** | `git log \| grep '49e9ae6'` → **0 satır** ✅ |
| **E. Önceki frontend image** | `8bd10e589fc7` (W1-G Login i18n build) |
| **F. Yeni frontend image** | **`sha256:ac719e8f9067a2e133fdad1571b66c2aa9061abefd2c3b8f2163c5505788e907`** (74.4 MB) |
| **G. Rollback tag** | `netmanager-frontend:rollback-pre-audit-v2-pr1-20260609_1744` → `8bd10e589fc7` |
| **H. Yeni JS bundle** | `/assets/index-SaJQaqTX.js` (önceki `index-C5hbUZ7Y.js`) |
| **H. CSS bundle** | `/assets/index-uWsjMl-2.css` (AYNI — JSX değişimi, CSS dokunmadı) |
| **I. AuditActionChip bundle'da kanıtı** | ✅ `audit-action-chip` (data-testid) PRESENT · `login_blocked_ip` (exact map) PRESENT · `permission_denied` (exact map) PRESENT |
| **J. auditActionCategory mapping bundle'da kanıtı** | ✅ Exact map değerleri PRESENT (`login_blocked_ip`, `permission_denied`); helper isim `getAuditActionCategory` minify edildi (local var — normal) |
| **K. Eklenen i18n key sayısı** | **7 key × 4 dil = 28 toplam satır** (`audit.actionCategory.*`) |
| **L. i18n widening = 0 kanıtı** | tr 2388 / en 2345 / de 2309 / ru 2309 — eksik 201 → **201** (Δ paralel ekleme tam) ✅ |
| **M. Backend image UNCHANGED** | `25fc5d7218a5` ✅ |
| **N. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **O. Backend/alembic/compose delta** | **0/0/0** ✅ |
| **P. 11/11 servis health** | ✅ |
| **Q. /audit-log** | `HTTP/1.1 200 OK` ✅ |
| **R. /health/ready** | `200 OK` — db/redis/timescaledb ok ✅ |

## Bundle i18n locale değer doğrulaması (4 dil)

Yeni bundle `index-SaJQaqTX.js` içinde locale değer kontrolü:

| Değer | Dil | Durum |
|---|---|---|
| `Kimlik` | TR auth | ✅ PRESENT |
| `Genehmigung` | DE approve | ✅ PRESENT |
| `Безопасность` | RU security | ✅ PRESENT |
| `Erstellen` | DE create | ✅ PRESENT |

## sw.js — PR #43 PWA cache fixleri KORUNDU

| String | Durum |
|---|---|
| `NavigationRoute` | **YOK** ✅ |
| `api-cache` | **YOK** ✅ |
| `NetworkFirst` | **YOK** ✅ |
| `cleanupOutdatedCaches` | (zaten var, kontrol edilmedi bu raporda) |

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 11 hours (healthy)        ← image UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 11 hours (healthy)        ← UNCHANGED
celery_beat             running   Up 11 hours (healthy)        ← UNCHANGED
celery_default_worker   running   Up 11 hours (healthy)        ← UNCHANGED
celery_worker           running   Up 11 hours (healthy)        ← UNCHANGED
event_consumer          running   Up 11 hours (healthy)        ← UNCHANGED
flower                  running   Up 11 hours                  ← UNCHANGED
frontend                running   Up 45 seconds                ← RECREATED (ac719e8f9067)
nginx                   running   Up 11 hours (healthy)        ← UNCHANGED
postgres                running   Up 11 hours (healthy)        ← UNCHANGED
redis                   running   Up 11 hours (healthy)        ← UNCHANGED
```

**10 servis Up 11 hours**; sadece `frontend` recreate edildi.

## Sprint 2A bypass kanıtı (devam — 8 deploy boyunca)

```
VPS git log son 4:
f541b9f feat(audit-log): action category + chip (Audit Log v2 PR 1)        ← YENİ
305e4be feat(login): i18n cleanup — extract hardcoded TR strings to locales (W1-G)
3e727e1 fix(auth): use zustand persist api for hydration (kill setter chain)
a654705 fix(auth): redirect authenticated user from /login to dashboard

VPS git log | grep '49e9ae6' → 0  (Sprint 2A YOK) ✅
```

## Hotfix + epik zinciri (prod ağacında aktif)

| # | Commit | PR | Kapsam |
|---|---|---|---|
| 1 | `1ba5550` | — | MFA login UI |
| 2 | `fa56968` ← `e01e37f` | #39 | Auth refresh hidrate guard |
| 3 | `62e36d7` ← `0ce1e1a` | #41 | Dashboard hotfix |
| 4 | `d719d8a` ← `55eecac` | #43 | PWA cache hotfix |
| 5 | `a654705` ← `948808e` | #45 | Login redirect hotfix |
| 6 | `3e727e1` ← `b5055c1` | #47 | Auth persist hidrasyon |
| 7 | `305e4be` ← `b66f630` | #49 | W1-G Login i18n cleanup |
| 8 | **`f541b9f` ← `fba75d3`** | **#51** | **Audit Log v2 PR 1 — Action Chip** ⭐ |

## Bundle delta

| Asset | W1-G | Audit v2 PR 1 | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `8bd10e589fc7` | **`ac719e8f9067`** | ✅ |
| JS bundle | `index-C5hbUZ7Y.js` | **`index-SaJQaqTX.js`** | ✅ |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ AYNI |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `305e4be` (W1-G Login i18n) |
| alembic | `f9aeportpol` |
| Frontend image | `8bd10e589fc7` → tag `netmanager-frontend:rollback-pre-audit-v2-pr1-20260609_1744` |

### Rollback komutu

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-audit-v2-pr1-20260609_1744 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 305e4be
```

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build/deploy | ✅ |
| 2-6. Backend / DB / migration / restart / compose yok | ✅ |
| 7. Dashboard refresh/auth backlog'una dokunulmadı | ✅ |
| 8. Sprint 2A prod'a alınmadı | ✅ |
| 9. SSH Termination KAPALI | ✅ |
| 10. W1-G + auth hotfix zincirine dokunulmadı | ✅ PR #39+#41+#43+#45+#47+#49 korundu |
| 11. Sadece PR 1 kapsamı deploy | ✅ |

## Kullanıcıdan beklenen manuel smoke (10 senaryo)

1. `/audit-log` sayfası açılır
2. Action kolonunda yeni chip görünür (ikon + renk + label)
3. Login/logout auth aksiyonları **mavi** kategori
4. Create (device_created vd.) **yeşil** kategori
5. Update (device_updated vd.) **sarı** kategori
6. Delete (device_archived vd.) **kırmızı** kategori
7. Failure status varsa **kırmızı sol border + ✗ rozet** görsel ayrımı
8. Filtreler bozulmadı (Kullanıcı/Aksiyon/IP/Kaynak Tipi/Durum/DateRange)
9. Row click → mevcut modal hâlâ açılır
10. CSV export bozulmadı, Console runtime error yok, Network 401/403/500 yok

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke — kullanıcı doğrular |
| 2 | Audit Log v2 PR 1 kapanış memory entry |
| 3 | Audit Log v2 PR 2 başlangıcı (AuditDetailDrawer + auditFormatters + AuditDiffViewer) |
| 4 | Alternatif: Sprint 1C UX backlog / MFA hardening / Sprint 2A yeniden planlama |
