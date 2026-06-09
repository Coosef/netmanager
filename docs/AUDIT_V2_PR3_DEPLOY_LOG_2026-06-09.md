# Audit Log v2 PR 3 — AuditResourceLink — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only, cherry-pick stratejisi devam (Sprint 2A YOK).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `3c4e28f` (Audit v2 PR 2) → **`93d51ea`** (Audit v2 PR 3 cherry-pick)
- **Kapsam:** PR #55 — Tablo Kaynak kolonu + Drawer Descriptions Kaynak satırı düz text yerine AuditResourceLink (4 render senaryosu + 12 route + permission gate)
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-D8oaxz4p.js` → **`index-BGO3YPjH.js`**
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅ (Sprint 1A'dan beri **17 deploy**)
- **Sprint 2A kodu prod'a girmedi** ✅ (cherry-pick bypass 10 deploy boyunca devam)
- **PR #43 PWA fixleri korundu** ✅
- **PR 1+2 davranışı korundu** ✅ (AuditActionChip + AuditDetailDrawer body)

## A-R — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #55 merge** | `c788b84ae203c036c6ac3cd355feae0b861566c0` ✅ |
| Audit v2 PR 3 commit (main) | `cd9bb94 feat(audit-log): resource link with route + permission gate (Audit v2 PR 3)` |
| **B. VPS HEAD** | **`93d51ea`** (cherry-pick'lenmiş Audit v2 PR 3) |
| **C. Main HEAD (GitHub)** | `c788b84` (merge commit, Sprint 2A `49e9ae6` içeride AMA cherry-pick ile sadece PR 3) |
| **D. Sprint 2A prod ağacında YOK kanıtı** | `git log \| grep '49e9ae6'` → **0 satır** ✅ |
| **E. Önceki frontend image** | `bad42c496730` (Audit v2 PR 2 build) |
| **F. Yeni frontend image** | **`sha256:5f965ddbc2399e6f157528000e64c42b7fddbaa3b010d12e160c8bda9589e5ac`** (74.4 MB) |
| **G. Rollback tag** | `netmanager-frontend:rollback-pre-audit-v2-pr3-20260609_1918` → `bad42c496730` |
| **H. Yeni JS bundle** | `/assets/index-BGO3YPjH.js` (önceki `index-D8oaxz4p.js`) |
| **H. CSS bundle** | `/assets/index-uWsjMl-2.css` (AYNI) |
| **I. AuditResourceLink bundle'da** | ✅ 4 data-testid PRESENT (`audit-resource-link` + `-empty` + `-noroute` + `-noperm`) |
| **J. auditResourceRoutes bundle'da** | ✅ 4 resource type string PRESENT (security_audit / terminal_session / asset_lifecycle / config_template) + 3 i18n key PRESENT (`audit.resource.no_route` / `audit.resource.no_permission` / `audit.detail.resource`) |
| **K. Eklenen i18n key** | **15 nested key × 4 dil = 60 toplam** (audit.detail.resource + audit.resource.*) |
| **L. i18n widening = 0 kanıtı** | tr 2442 / en 2399 / de 2363 / ru 2363 — eksik 201 → **201** (Δ paralel ekleme tam) ✅ |
| **M. Backend image UNCHANGED** | `25fc5d7218a5` ✅ |
| **N. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **O. Backend/alembic/compose delta** | **0/0/0** ✅ |
| **P. 11/11 servis health** | ✅ |
| **Q. /audit-log** | `HTTP/1.1 200 OK` ✅ |
| **R. /health/ready** | `200 OK` — db/redis/timescaledb ok ✅ |

## Bundle locale değer doğrulaması (4 dil)

Yeni bundle `index-BGO3YPjH.js` içinde resource type isimleri:

| Değer | Dil | Durum |
|---|---|---|
| `Kullanıcı` | TR type_user | ✅ PRESENT |
| `Terminal Session` | EN type_terminal_session | ✅ PRESENT |
| `Sicherheitsprüfung` | DE type_security_audit | ✅ PRESENT |
| `Безопасность` | RU (önceki PR'lardan) | ✅ PRESENT |

## PR 1+2 korundu kanıtı (bundle)

| String | Durum |
|---|---|
| `audit-detail-drawer` (PR 2 testid) | ✅ PRESENT |
| `audit-action-chip` (PR 1 testid) | ✅ PRESENT |

## sw.js — PR #43 PWA cache fixleri KORUNDU

| String | Durum |
|---|---|
| `NavigationRoute` | **YOK** ✅ |
| `api-cache` | **YOK** ✅ |
| `NetworkFirst` | **YOK** ✅ |

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 12 hours (healthy)        ← image UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 12 hours (healthy)        ← UNCHANGED
celery_beat             running   Up 12 hours (healthy)        ← UNCHANGED
celery_default_worker   running   Up 12 hours (healthy)        ← UNCHANGED
celery_worker           running   Up 12 hours (healthy)        ← UNCHANGED
event_consumer          running   Up 12 hours (healthy)        ← UNCHANGED
flower                  running   Up 12 hours                  ← UNCHANGED
frontend                running   Up 51 seconds                ← RECREATED (5f965ddbc239)
nginx                   running   Up 12 hours (healthy)        ← UNCHANGED
postgres                running   Up 12 hours (healthy)        ← UNCHANGED
redis                   running   Up 12 hours (healthy)        ← UNCHANGED
```

**10 servis Up 12 hours**; sadece `frontend` recreate edildi.

## Sprint 2A bypass kanıtı (10 deploy boyunca devam)

```
VPS git log son 4:
93d51ea feat(audit-log): resource link with route + permission gate (Audit v2 PR 3)  ← YENİ
3c4e28f feat(audit-log): drawer + human-readable details + diff viewer (Audit v2 PR 2)
f541b9f feat(audit-log): action category + chip (Audit Log v2 PR 1)
305e4be feat(login): i18n cleanup — extract hardcoded TR strings to locales (W1-G)

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
| 7 | `305e4be` ← `b66f630` | #49 | W1-G Login i18n |
| 8 | `f541b9f` ← `fba75d3` | #51 | Audit Log v2 PR 1 — Action Chip |
| 9 | `3c4e28f` ← `20cca8f` | #53 | Audit Log v2 PR 2 — Drawer + Details + Diff |
| 10 | **`93d51ea` ← `cd9bb94`** | **#55** | **Audit Log v2 PR 3 — Resource Link** ⭐ |

## Bundle delta

| Asset | Audit v2 PR 2 | Audit v2 PR 3 | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `bad42c496730` | **`5f965ddbc239`** | ✅ |
| JS bundle | `index-D8oaxz4p.js` | **`index-BGO3YPjH.js`** | ✅ |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ AYNI |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `3c4e28f` (Audit v2 PR 2) |
| alembic | `f9aeportpol` |
| Frontend image | `bad42c496730` → tag `netmanager-frontend:rollback-pre-audit-v2-pr3-20260609_1918` |

### Rollback komutu

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-audit-v2-pr3-20260609_1918 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 3c4e28f
```

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build/deploy | ✅ |
| 2-6. Backend / DB / migration / restart / compose yok | ✅ |
| 7. Dashboard refresh/auth backlog'una dokunulmadı | ✅ |
| 8. Sprint 2A prod'a alınmadı | ✅ |
| 9. SSH Termination KAPALI | ✅ |
| 10. AuditActionChip korundu | ✅ Bundle'da `audit-action-chip` PRESENT |
| 11. AuditDetailDrawer + AuditDiffViewer korundu | ✅ Bundle'da `audit-detail-drawer` PRESENT |
| 12. FilterBar / Empty State PR 4 scope | ✅ |
| 13. W1-G Login i18n'e dokunulmadı | ✅ |
| 14. Auth hotfix zincirine dokunulmadı | ✅ PR #39+#41+#43+#45+#47 korundu |

## Kullanıcıdan beklenen manuel smoke (13 senaryo)

1. `/audit-log` sayfası açılır
2. Kaynak kolonunda **resource link/chip** görünür
3. Device kaydı → tıklanınca `/devices/:id` route'una gider
4. User/task/agent kayıtlar → **liste route'una** yönlenir
5. **Tenant/group/invite_token** route olmayan resource'lar → düz text + tooltip "Detay sayfası yok"
6. Yetki yoksa link değil → düz text + **"Erişim yetkisi yok" tooltip**
7. **Drawer içinde Kaynak satırı** görünür
8. Drawer içinde aynı link/fallback davranışı
9. Filtreler bozulmadı
10. CSV export bozulmadı
11. Pagination/statbar bozulmadı
12. Console runtime error yok
13. Network 401/403/500 yok

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke — kullanıcı doğrular |
| 2 | Audit Log v2 PR 3 kapanış memory entry |
| 3 | Audit Log v2 PR 4 başlangıcı (AuditFilterBar + quick presets + reset + empty state) |
| 4 | Alternatif: Sprint 1C UX backlog / MFA hardening / Sprint 2A yeniden planlama |
