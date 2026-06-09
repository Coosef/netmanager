# Audit Log v2 PR 4 — AuditFilterBar + Empty State — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> Frontend-only, cherry-pick stratejisi devam (Sprint 2A YOK).
> **Build retry gerekti** — VPS `tsc && vite build` script'i `tsc --noEmit`'in
> yakalamadığı `'possibly undefined'` hatasını yakaladı. Hotfix PR #58
> (1 test dosyası, 2 satır) ile çözüldü ve cherry-pick edildi.
> Backend / postgres / redis / celery / nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `93d51ea` (Audit v2 PR 3) → `31b3f2c` (PR 4 cherry-pick) → **`d8af73b`** (hotfix cherry-pick)
- **Kapsam:** PR #57 + PR #58 (tsc hotfix) — AuditFilterBar + AuditEmptyState + auditDatePresets + AuditLog page i18n cleanup
- **DB:** Migration **YOK** — `f9aeportpol` UNCHANGED ✅
- **Frontend:** Bundle `index-BGO3YPjH.js` → **`index-DouWuRp8.js`**
- **Backend:** Image **`25fc5d7218a5` UNCHANGED** ✅ (Sprint 1A'dan beri **18 deploy**)
- **Sprint 2A kodu prod'a girmedi** ✅ (cherry-pick bypass 11 deploy boyunca devam)
- **PR #43 PWA fixleri korundu** ✅
- **PR 1+2+3 davranışı korundu** ✅ (bundle'da tüm testid'leri PRESENT)

## Build retry — neden gerekti

İlk cherry-pick (31b3f2c — PR 4 commit) sonrası `docker compose build frontend` FAIL:

```
src/pages/AuditLog/__tests__/AuditEmptyState.test.tsx(28,5):
  error TS2722: Cannot invoke an object which is possibly 'undefined'.
```

**Sebep:** Lokal `tsc --noEmit` standalone PASS etmişti, AMA VPS `npm run build` script'i `tsc && vite build` — strict null-checks daha sıkı (project tsconfig.json'ın "include" alanı). Test'te `el.props.onReset()` opsiyonel prop, narrow edilmemişti.

**Hotfix (PR #58, 2 satır):**
```ts
// ÖNCE:
el.props.onReset()
// SONRA:
const cb = el.props.onReset
if (cb) cb()
```

Lokal **`npm run build` PASS** + **vitest 585/585 PASS** doğrulandı. Hotfix merge edildi (`30e8395`), VPS'te 2. cherry-pick (`d8af73b`) + build retry **BAŞARILI**.

Eski image `5f965ddbc239` (PR 3 build) container'da kalmıştı — fail safety. Yeni image `0eff66a70620` recreate ile aktif.

## A-T — İstenen alanlar

| Alan | Değer |
|---|---|
| **A. PR #57 merge** | `475c09e8756a712989b90ab6ad70492a84d51eff` ✅ |
| **A2. PR #58 (tsc hotfix) merge** | `30e839521533f7df84298c673552c646ba36dc39` ✅ |
| PR #57 commit (main) | `89e9d2d feat(audit-log): filter bar + quick presets + reset + empty state (Audit v2 PR 4)` |
| PR #58 commit (main) | `cb4057c fix(audit-log): tsc strict — narrow onReset before invoke in test` |
| **B. VPS HEAD** | **`d8af73b`** (PR 4 cherry-pick `31b3f2c` + hotfix cherry-pick `d8af73b`) |
| **C. Main HEAD (GitHub)** | `30e8395` (Sprint 2A `49e9ae6` içeride AMA cherry-pick ile sadece PR 4 + hotfix) |
| **D. Sprint 2A prod ağacında YOK kanıtı** | `git log \| grep '49e9ae6'` → **0 satır** ✅ |
| **E. Önceki frontend image** | `5f965ddbc239` (Audit v2 PR 3 build) |
| **F. Yeni frontend image** | **`sha256:0eff66a706208c27c4989f338936b00c436338e6461642a6911c89ac18141380`** (74.5 MB) |
| **G. Rollback tag** | `netmanager-frontend:rollback-pre-audit-v2-pr4-20260609_2019` → `5f965ddbc239` |
| **H. Yeni JS bundle** | `/assets/index-DouWuRp8.js` (önceki `index-BGO3YPjH.js`) |
| **H. CSS bundle** | `/assets/index-uWsjMl-2.css` (AYNI) |
| **I. AuditFilterBar bundle'da** | ✅ `audit-filter-bar` + `audit-filter-reset` + `audit-filter-active-count` data-testid PRESENT (preset testid'leri template literal minify, AMA i18n key'leri PRESENT) |
| **J. AuditEmptyState bundle'da** | ✅ `audit-empty-state` + `audit-empty-reset-cta` data-testid PRESENT |
| **K. auditDatePresets bundle'da** | ✅ i18n key'leri `audit.filter.preset_1h` PRESENT + locale değerleri 4 dilde PRESENT |
| **L. Eklenen i18n key** | **52 nested key × 4 dil = 208 toplam** (audit.page/stat/column/filter/status/empty/csv) |
| **M. i18n widening = 0 kanıtı** | tr 2494 / en 2451 / de 2415 / ru 2415 — eksik 201 → **201** (Δ paralel ekleme tam) ✅ |
| **N. Backend image UNCHANGED** | `25fc5d7218a5` ✅ |
| **O. Alembic UNCHANGED** | `f9aeportpol` ✅ |
| **P. Backend/alembic/compose delta** | **0/0/0** ✅ |
| **Q. 11/11 servis health** | ✅ |
| **R. /audit-log** | `HTTP/1.1 200 OK` ✅ |
| **S. /health/ready** | `200 OK` — db/redis/timescaledb ok ✅ |
| **T. PR 1+2+3 korundu kanıtı** | ✅ `audit-action-chip` + `audit-detail-drawer` + `audit-diff-viewer` + `audit-resource-link` + `audit-resource-link-noroute` + i18n key `audit.summary.login` + `audit.resource.no_permission` hepsi PRESENT |

## Bundle PR 4 audit kanıtları

### Component data-testid (4)
| String | Durum |
|---|---|
| `audit-filter-bar` | ✅ PRESENT |
| `audit-filter-reset` | ✅ PRESENT |
| `audit-filter-active-count` | ✅ PRESENT |
| `audit-empty-state` | ✅ PRESENT |
| `audit-empty-reset-cta` | ✅ PRESENT |

### i18n key (4 namespace × örnek)
| Key | Durum |
|---|---|
| `audit.filter.preset_1h` | ✅ PRESENT |
| `audit.empty.no_match_title` | ✅ PRESENT |
| `audit.csv.duration_ms` | ✅ PRESENT |
| `audit.stat.unique_users` | ✅ PRESENT |

> **Not:** Preset data-testid'leri `audit-filter-preset-${preset}` template literal — vite minify sırasında inlining'le optimize edildiği için grep ile bundle'da bulunmadı (beklenen davranış). DOM'da render edildiğinde gerçek değer üretilir.

## Bundle locale değer doğrulaması (4 dil)

Yeni bundle `index-DouWuRp8.js` içinde reset butonu + preset metinleri:

| Değer | Dil | Durum |
|---|---|---|
| `Filtreleri Sıfırla` | TR audit.filter.reset | ✅ PRESENT |
| `Reset Filters` | EN audit.filter.reset | ✅ PRESENT |
| `Filter zurücksetzen` | DE audit.filter.reset | ✅ PRESENT |
| `Сбросить` | RU audit.filter.reset (prefix) | ✅ PRESENT |
| `Letzte Stunde` | DE preset_1h | ✅ PRESENT |
| `Last 1 hour` | EN preset_1h | ✅ PRESENT |

## PR 1+2+3 korundu kanıtı (bundle) — Kural #10-12

| Test-ID / i18n key | Kapsam | Durum |
|---|---|---|
| `audit-action-chip` | PR 1 — AuditActionChip | ✅ PRESENT |
| `audit-detail-drawer` | PR 2 — AuditDetailDrawer | ✅ PRESENT |
| `audit-diff-viewer` | PR 2 — AuditDiffViewer | ✅ PRESENT |
| `audit-resource-link` | PR 3 — AuditResourceLink | ✅ PRESENT |
| `audit-resource-link-noroute` | PR 3 — fallback | ✅ PRESENT |
| `audit.summary.login` | PR 2 — formatter | ✅ PRESENT |
| `audit.resource.no_permission` | PR 3 — tooltip | ✅ PRESENT |

## sw.js — PR #43 PWA cache fixleri KORUNDU

| String | Durum |
|---|---|
| `NavigationRoute` | **YOK** ✅ |
| `api-cache` | **YOK** ✅ |
| `NetworkFirst` | **YOK** ✅ |

## Çalışan container statüleri (final)

```
SERVICE                 STATE     STATUS
backend                 running   Up 13 hours (healthy)        ← image UNCHANGED (25fc5d7218a5)
celery_agent_worker     running   Up 13 hours (healthy)        ← UNCHANGED
celery_beat             running   Up 13 hours (healthy)        ← UNCHANGED
celery_default_worker   running   Up 13 hours (healthy)        ← UNCHANGED
celery_worker           running   Up 13 hours (healthy)        ← UNCHANGED
event_consumer          running   Up 13 hours (healthy)        ← UNCHANGED
flower                  running   Up 13 hours                  ← UNCHANGED
frontend                running   Up 59 seconds                ← RECREATED (0eff66a70620)
nginx                   running   Up 13 hours (healthy)        ← UNCHANGED
postgres                running   Up 13 hours (healthy)        ← UNCHANGED
redis                   running   Up 13 hours (healthy)        ← UNCHANGED
```

**10 servis Up 13 hours**; sadece `frontend` recreate edildi.

## Sprint 2A bypass kanıtı (11 deploy boyunca devam)

```
VPS git log son 4:
d8af73b fix(audit-log): tsc strict — narrow onReset before invoke in test  ← YENİ (hotfix)
31b3f2c feat(audit-log): filter bar + quick presets + reset + empty state (Audit v2 PR 4)  ← YENİ (PR 4)
93d51ea feat(audit-log): resource link with route + permission gate (Audit v2 PR 3)
3c4e28f feat(audit-log): drawer + human-readable details + diff viewer (Audit v2 PR 2)

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
| 10 | `93d51ea` ← `cd9bb94` | #55 | Audit Log v2 PR 3 — Resource Link |
| 11 | **`31b3f2c` ← `89e9d2d`** | **#57** | **Audit Log v2 PR 4 — Filter Bar + Empty State** ⭐ |
| 12 | `d8af73b` ← `cb4057c` | #58 | TSC strict hotfix |

## Bundle delta

| Asset | Audit v2 PR 3 | Audit v2 PR 4 | Değişti |
|---|---|---|---|
| Backend image | `25fc5d7218a5` | `25fc5d7218a5` | ❌ **UNCHANGED** |
| Frontend image | `5f965ddbc239` | **`0eff66a70620`** | ✅ |
| JS bundle | `index-BGO3YPjH.js` | **`index-DouWuRp8.js`** | ✅ |
| CSS bundle | `index-uWsjMl-2.css` | `index-uWsjMl-2.css` | ❌ AYNI |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `93d51ea` (Audit v2 PR 3) |
| alembic | `f9aeportpol` |
| Frontend image | `5f965ddbc239` → tag `netmanager-frontend:rollback-pre-audit-v2-pr4-20260609_2019` |

### Rollback komutu

```bash
ssh root@93.180.133.88
cd /opt/netmanager
docker tag netmanager-frontend:rollback-pre-audit-v2-pr4-20260609_2019 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 93d51ea
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
| 11. AuditDetailDrawer + AuditDiffViewer korundu | ✅ Bundle'da `audit-detail-drawer` + `audit-diff-viewer` PRESENT |
| 12. AuditResourceLink korundu | ✅ Bundle'da `audit-resource-link` + `audit-resource-link-noroute` PRESENT |
| 13. API query parametreleri değişmedi | ✅ `tasksApi.getAuditLog` çağrısı aynı 9 param |
| 14. CSV kolon sırası değişmedi | ✅ 11 sütun, sadece header text lokalize |
| 15. Pagination/statbar hesapları | ✅ değişmedi |
| 16. W1-G Login i18n'e dokunulmadı | ✅ |
| 17. Auth hotfix zincirine dokunulmadı | ✅ PR #39+#41+#43+#45+#47 korundu |

## Kullanıcıdan beklenen manuel smoke (17 senaryo)

1. /audit-log açılır
2. **Quick preset "Son 24 saat" tıklanınca** tarih aralığı set edilir
3. **"Son 7 gün" tıklanınca** tarih aralığı değişir
4. Manuel tarih seçilince preset highlight doğru davranır ("Özel")
5. Kullanıcı / Aksiyon / IP filtreleri çalışır
6. Kaynak tipi / Durum filtreleri çalışır
7. **Aktif filtre sayısı görünür** (chip: "3 filtre aktif")
8. **Reset Filters** tüm filtreleri temizler
9. Filtre sonucu boşsa **custom empty state** görünür
10. **Empty state içindeki Reset CTA** çalışır
11. **CSV export** çalışır, header'lar **aktif dile göre** gelir
12. Statbar değerleri bozulmaz
13. Pagination bozulmaz
14. Drawer / ActionChip / ResourceLink bozulmaz
15. **TR/EN/DE/RU i18n** metinleri çalışır
16. Console runtime error yok
17. Network 401/403/500 yok

---

## Sonraki adımlar

| Sıra | İş |
|---|---|
| 1 | Manuel browser smoke — kullanıcı doğrular |
| 2 | **Audit Log v2 PR 4 kapanış memory entry** |
| 3 | **Audit Log v2 4-PR epik kapanış memory entry** (PR 1+2+3+4 toplam özet) |
| 4 | Sonraki iş kararı: Sprint 1C UX backlog / MFA hardening / Sprint 2A yeniden planlama / Sprint 2 P1 / Sprint 3 P2 |
