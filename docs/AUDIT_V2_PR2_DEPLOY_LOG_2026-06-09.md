# Audit Log v2 PR 2 — AuditDetailDrawer + Human-readable + Diff — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only, cherry-pick stratejisi devam (Sprint 2A YOK).
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `f541b9f` (Audit v2 PR 1) → **`3c4e28f`** (Audit v2 PR 2 cherry-pick)
- **Kapsam:** PR #53 — Modal → Drawer + 12 action human-readable formatter + field-level diff viewer + sensitive masking (4 katman)
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-SaJQaqTX.js` → **`index-D8oaxz4p.js`**
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅ (Sprint 1A'dan beri **16 deploy**)
- **Sprint 2A kodu prod'a girmedi** ✅ (cherry-pick bypass 9 deploy boyunca devam)
- **PR #43 PWA fixleri korundu** ✅
- **PR 1 AuditActionChip korundu** ✅ (Drawer header'da kullanılıyor)

## A-S — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #53 merge** | `00facd48d6e92a5af90017cdb72910e1abe254e7` ✅ |
| Audit v2 PR 2 commit (main) | `20cca8f feat(audit-log): drawer + human-readable details + diff viewer (Audit v2 PR 2)` |
| **B. VPS HEAD** | **`3c4e28f`** (cherry-pick'lenmiş Audit v2 PR 2) |
| **C. Main HEAD (GitHub)** | `00facd4` (merge commit, Sprint 2A `49e9ae6` içeride AMA cherry-pick ile sadece PR 2) |
| **D. Sprint 2A prod ağacında YOK kanıtı** | `git log \| grep '49e9ae6'` → **0 satır** ✅ |
| **E. Önceki frontend image** | `ac719e8f9067` (Audit v2 PR 1 build) |
| **F. Yeni frontend image** | **`sha256:bad42c496730f948420deeb8a9f4502d156c57061e9d356db3abb00b357b9871`** (74.4 MB) |
| **G. Rollback tag** | `netmanager-frontend:rollback-pre-audit-v2-pr2-20260609_1839` → `ac719e8f9067` |
| **H. Yeni JS bundle** | `/assets/index-D8oaxz4p.js` (önceki `index-SaJQaqTX.js`) |
| **H. CSS bundle** | `/assets/index-uWsjMl-2.css` (AYNI) |
| **I. AuditDetailDrawer bundle'da** | ✅ `audit-detail-drawer` data-testid PRESENT |
| **J. AuditDiffViewer bundle'da** | ✅ `audit-diff-viewer` + `audit-diff-empty` + `audit-diff-no-change` PRESENT + `audit-action-chip` (PR 1 korundu) |
| **K. auditFormatters bundle'da** | ✅ i18n key'leri: `audit.summary.login`, `audit.summary.device_updated`, `audit.summary.category.neutral`, `audit.diff.no_change`, `audit.detail.summary_title`, `mfa_totp_secret` (sensitive field name) PRESENT |
| **L. Eklenen i18n key** | **39 nested key × 4 dil = 156 toplam** (audit.detail/diff/summary.*) |
| **M. i18n widening = 0 kanıtı** | tr 2427 / en 2384 / de 2348 / ru 2348 — eksik 201 → **201** (Δ paralel ekleme tam) ✅ |
| **N. Backend image UNCHANGED** | `25fc5d7218a5` ✅ |
| **O. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **P. Backend/alembic/compose delta** | **0/0/0** ✅ |
| **Q. 11/11 servis health** | ✅ |
| **R. /audit-log** | `HTTP/1.1 200 OK` ✅ |
| **S. /health/ready** | `200 OK` — db/redis/timescaledb ok ✅ |

## Bundle locale değer doğrulaması (4 dil)

Yeni bundle `index-D8oaxz4p.js` içinde locale "Sadece değişenler" kontrolü:

| Değer | Dil | Durum |
|---|---|---|
| `Sadece değişenler` | TR | ✅ PRESENT |
| `Only changed` | EN | ✅ PRESENT |
| `Nur geänderte` | DE | ✅ PRESENT |
| `Только изменённые` | RU | ✅ PRESENT |

## sw.js — PR #43 PWA cache fixleri KORUNDU

| String | Durum |
|---|---|
| `NavigationRoute` | **YOK** ✅ |
| `api-cache` | **YOK** ✅ |
| `NetworkFirst` | **YOK** ✅ |

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
frontend                running   Up 51 seconds                ← RECREATED (bad42c496730)
nginx                   running   Up 11 hours (healthy)        ← UNCHANGED
postgres                running   Up 11 hours (healthy)        ← UNCHANGED
redis                   running   Up 11 hours (healthy)        ← UNCHANGED
```

**10 servis Up 11 hours**; sadece `frontend` recreate edildi.

## Sprint 2A bypass kanıtı (9 deploy boyunca devam)

```
VPS git log son 4:
3c4e28f feat(audit-log): drawer + human-readable details + diff viewer (Audit v2 PR 2)  ← YENİ
f541b9f feat(audit-log): action category + chip (Audit Log v2 PR 1)
305e4be feat(login): i18n cleanup — extract hardcoded TR strings to locales (W1-G)
3e727e1 fix(auth): use zustand persist api for hydration (kill setter chain)

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
| 9 | **`3c4e28f` ← `20cca8f`** | **#53** | **Audit Log v2 PR 2 — Drawer + Details + Diff** ⭐ |

## Bundle delta

| Asset | Audit v2 PR 1 | Audit v2 PR 2 | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `ac719e8f9067` | **`bad42c496730`** | ✅ |
| JS bundle | `index-SaJQaqTX.js` | **`index-D8oaxz4p.js`** | ✅ |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ AYNI |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `f541b9f` (Audit v2 PR 1) |
| alembic | `f9aeportpol` |
| Frontend image | `ac719e8f9067` → tag `netmanager-frontend:rollback-pre-audit-v2-pr2-20260609_1839` |

### Rollback komutu

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-audit-v2-pr2-20260609_1839 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard f541b9f
```

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| 1. Sadece frontend build/deploy | ✅ |
| 2-6. Backend / DB / migration / restart / compose yok | ✅ |
| 7. Dashboard refresh/auth backlog'una dokunulmadı | ✅ |
| 8. Sprint 2A prod'a alınmadı | ✅ |
| 9. SSH Termination KAPALI | ✅ |
| 10. PR 1 AuditActionChip korundu | ✅ Drawer header'da kullanılıyor |
| 11. W1-G Login i18n'e dokunulmadı | ✅ |
| 12. Auth hotfix zincirine dokunulmadı | ✅ PR #39+#41+#43+#45+#47 korundu |
| 13. Resource link PR 3 scope | ✅ |
| 14. FilterBar / Empty State PR 4 scope | ✅ |

## Kullanıcıdan beklenen manuel smoke (15 senaryo)

1. `/audit-log` sayfası açılır
2. Satıra tıklayınca **eski modal yerine Drawer açılır**
3. Drawer header'da **AuditActionChip + tarih**
4. **Descriptions:** Kullanıcı/Tarih/IP/Süre/Status/Request ID/Browser
5. **ÖZET** alanı human-readable
6. before/after olan kayıtta **Diff Viewer**
7. **Added/changed/removed sayaçları** doğru
8. **"Sadece değişenleri göster" toggle** çalışır
9. **Raw JSON** "Gelişmiş / Raw Data" Collapse altında
10. **Hassas alanlar maskelenir** (summary/diff/raw — 4 katman)
11. Filtreler bozulmadı
12. CSV export bozulmadı
13. Pagination/statbar bozulmadı
14. Console runtime error yok
15. Network 401/403/500 yok

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke — kullanıcı doğrular |
| 2 | Audit Log v2 PR 2 kapanış memory entry |
| 3 | Audit Log v2 PR 3 başlangıcı (AuditResourceLink — resource_type → route map) |
| 4 | Alternatif: Sprint 1C UX backlog / MFA hardening / Sprint 2A yeniden planlama |
