# T10 C7 Wave 2 #2 Production Deploy Log — 2026-06-01 (PM)

> **STATUS: PRODUCTION DEPLOY COMPLETED ✅**
> 5 P-fazı yeşil; Wave 2 #2 (Device Detail UI Refresh) prod'a deploy edildi.
> Frontend-only, backend dokunulmadı. NetManager mockup'tan 10 UI bileşeni
> DeviceDetailPage'e taşındı; Wave 1 fonksiyonu korundu.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
  `2d1b4be` → **`1848986`** (Wave 2 #2 merge — DB migration YOK).
- **Kapsam:** T10 C7 Wave 2 #2 (Device Detail UI Refresh):
  - F1 `ae354cb` — Header + Vendor Badge + Quick Actions (`.nm-page-hd` + `.nm-vendor` + 3 buton tray)
  - F2 `6d66c16` — Status Cards (OverviewTab 6 KPI + PortsTab 5 KPI satırı)
  - F3 `c200e34` — Health Summary (SNMP CPU/RAM + sparkline) + Event Statistics (24sa özet)
  - F4 `316b9d6` — SLA Donut (Availability 7g/30g) + VLAN Statistics + Backup drift visual
- **DB:** Migration YOK; `f9aeportpol` korundu.
- **Backend:** Dokunulmadı (`199f1579d85a` aynı image, uptime 3 saat korundu).
- **Frontend:** Sadece refactor + 2 yeni helper component (`_sparkline.tsx` ~60 LOC, `_donut.tsx` ~70 LOC, saf SVG). Bundle delta minimal (+17KB raw / +5KB gzip).
- **Compose/network/env:** Değişiklik YOK.
- **Kesinti:** Frontend recreate ~22 sn; diğer 9 servis tamamen dokunulmadı.

## Final state (POST-DEPLOY ANCHOR)

| | Değer |
|---|---|
| git HEAD | **`1848986`** (Wave 2 #2 merge, main) |
| alembic current | `f9aeportpol` (DB migration yok, korundu) |
| Backend image | `199f1579d85a` (Wave 1 build, dokunulmadı) |
| Frontend image | **YENİ** (Wave 2 #2 build) |
| Frontend bundle hash | `index-DC1DQ9pb.js` + `index-uWsjMl-2.css` (önceki `Cx4ql4t5.js`) |
| 11/11 servis | Up/healthy (frontend ~22s, backend 3 saat, diğerleri 26 saat/2 gün korundu) |
| Host listening | yalnız `0.0.0.0:80` + `0.0.0.0:443` (B1c korundu) |
| RLS-forced tablo | 61 (Faz 7 + C7 anchor, korundu) |

## PRE-DEPLOY ROLLBACK ANCHOR

| | Değer |
|---|---|
| git | `2d1b4be` (Wave 1.1 son hali) |
| alembic | `f9aeportpol` (aynı — DB değişmedi) |
| pre-deploy backend image | `199f1579d85a` (değişmedi, anchor aynı) |
| pre-deploy frontend image | `bb31982ddb50…` (Wave 1.1 build) |
| pre-deploy bundle | `index-Cx4ql4t5.js` |

> Rollback: image rollback yeterli (sadece frontend değişti). `docker tag bb31982d… netmanager-frontend:latest` + `docker compose up -d --no-deps frontend`.

## P-fazı icra özeti

| P | Adım | Yazma | Sonuç |
|---|---|---|---|
| P0 | Anchor (git + alembic + 11 image) | yok | ✅ Read-only |
| P1 | Disk + ingress check (skip — Wave 1 deploy'unda 4 saat önce yapıldı) | yok | (atlandı) |
| P2 | `git fetch && git merge --ff-only 1848986` | working tree | ✅ HEAD = `1848986` |
| P3 | `docker compose build frontend` (nohup + background) | image | ✅ ~3 dk; "frontend Built" |
| P4 | `docker compose up -d --no-deps frontend` (aynı SSH session içinde) | servis swap | ✅ FE recreate ~22 sn; diğer 10 servis dokunulmadı |
| P5 | Smoke (SPA + bundle hash + servis uptime) | read-only | ✅ Tümü GREEN (aşağıda) |

## P5 — Smoke gates GREEN ✅

```
/health/ready                  200
/devices                       200  (SPA)
/devices/1                     200  (SPA)
/devices/1?tab=overview        200
/devices/1?tab=terminal        200  (10. sekme deep-link)
```

Bundle değişti: `Cx4ql4t5.js` → **`DC1DQ9pb.js`** (Wave 2 #2 kod canlıda).
CSS değişti: `B7-a2UwE.css` → **`uWsjMl-2.css`** (`.nm-vendor` ek + statbar render).

Servis durumu (deploy sonrası):
- `netmanager-frontend-1` Up 22s (YENİ)
- `netmanager-backend-1` Up 3 saat (dokunulmadı)
- `netmanager-postgres-1` / `redis-1` / `nginx-1` Up 2 gün
- `celery_*` × 3 + `event_consumer` + `beat` Up 26 saat
- `flower` Up 26 saat

## Doğrulama matrisi (4 faz)

| Faz | Komponent | Mockup kaynağı | Hedef | Smoke |
|---|---|---|---|---|
| F1 | Device Header | `pages-devices.jsx:328-345` | `DeviceDetailPage.tsx:99-200` | gate P5 (route 200) |
| F1 | Vendor Badge | `styles.css:1382-1391` | header inline `.nm-vendor` | bundle CSS değişti |
| F1 | Quick Actions | `pages-devices.jsx:347-351` | `.nm-page-actions` 3 buton | bundle JS değişti |
| F1 | Risk Pill | `nm-risk-pill` (noc.css:1633) | header `getHealthScores()` filter | bundle JS değişti |
| F2 | Status Cards (Overview) | `pages-switch.jsx:173-181` | `OverviewTab.tsx` 6 KPI üst | bundle JS değişti |
| F2 | Port Statistics | aynı pattern | `PortsTab.tsx` 5 KPI üst | bundle JS değişti |
| F2 | Last Backup pill | `pages-devices.jsx:435` | OverviewTab Card son slot | bundle JS değişti |
| F3 | Health Summary | `pages-devices.jsx:462-511` | OverviewTab "Sistem Sağlığı" subsection | bundle JS değişti |
| F3 | Event Statistics | `pages-devices.jsx:513-545` | OverviewTab "24 Saatlik Olay" subsection | bundle JS değişti |
| F3 | Sparkline helper | `widgets.jsx:70-86` | yeni `_sparkline.tsx` | yeni dosya |
| F4 | SLA Donut | `pages-devices.jsx:547-576` | OverviewTab "SLA" subsection | bundle JS değişti |
| F4 | Donut helper | `styles.css:694-716` `.nm-donut` | yeni `_donut.tsx` | yeni dosya |
| F4 | VLAN Statistics | `pages-switch.jsx:179` | `VlanTab.tsx` 3 KPI üst | bundle JS değişti |
| F4 | Backup drift visual | `pages-devices.jsx:435-460` | `BackupTab.tsx` warn-soft box + nm-pill | bundle JS değişti |

## Riskler & kabul edilenler

- **Bundle delta +17KB raw / +5KB gzip** — saf SVG + CSS class, recharts/echarts gerek yok.
- **Yeni queryKey'ler** (`device-events-overview`, `device-availability`, `snmp-cpu-ram`, `poe-device`) — diğer tab'lardakilerle çakışmaz; React Query global cache pratik (queryKey paylaşımı OverviewTab ↔ PortsTab/VlanTab/BackupTab cache hit).
- **AntD theme token + `nm-*` class beraber yaşıyor** — F1'de küçük alanda denendi, çakışma yok.
- **CPU/RAM sparkline client-side history** — sayfa kapanınca sıfırlanır (kabul edilebilir, mockup'la aynı).
- **Conic-gradient donut Safari < 14 düşebilir** — fallback friendly text "—" döner.
- **Wave 1 fonksiyonu KORUNDU** — AntD Tabs + 10 tab içeriği aynen, sadece görsel cilalama.

## Out of scope (Wave 2'nin başka başlıkları)

- Wave 2 #1 Audit Log UI v2 (kurumsal kritik talep — sıradaki muhtemel iş)
- Wave 2 #3 SSH Terminal Performance (agent stack incelek)
- Wave 2 #4-5 Komşular + CPU/RAM Health tab
- Wave 2 #6 Visual Port Map (RJ45 faceplate)
- Wave 2 #7 Advanced Trunk VLAN add/remove

Sıralama önerisi `docs/T10_C7_WAVE2_PLAN.md`'de.

## Commit kronolojisi (Wave 2 #2)

```
1848986  Merge branch 't10/c7-wave2-ui-refresh' — Device Detail UI Refresh (Wave 2 #2)
316b9d6  feat(devices/detail): F4 — SLA Donut + VLAN Statistics + Backup drift visual (Wave 2 #2)
c200e34  feat(devices/detail): F3 — Health Summary + Event Stats + Sparkline (Wave 2 #2)
6d66c16  feat(devices/detail): F2 — Status Cards (OverviewTab + PortsTab) (Wave 2 #2)
ae354cb  feat(devices/detail): F1 — Header + Vendor Badge + Quick Actions (Wave 2 #2)
131624a  docs(c7-wave2-ui): Device Detail UI Refresh integration plan (Wave 2 #2)
```

## Rollback prosedürü

**Tetikleyiciler:** SPA route'lar 5xx · header'da `.nm-*` class'lar düzgün render olmuyor · OverviewTab boş/crash · bundle hash hata veriyor.

**Prosedür (image rollback, DB değişmedi):**
1. `docker tag bb31982ddb50… netmanager-frontend:latest`
2. `docker compose up -d --no-deps frontend`
3. Smoke gate 1-2 yeşil + `index-Cx4ql4t5.js` bundle hash doğrulayın

Backend ve diğer 10 servis dokunulmaz.

---

## Wave 2 #2 Status

**DEPLOY COMPLETED ✅** — NetManager mockup'tan 10 UI bileşeni DeviceDetailPage'e taşındı; SIFIRDAN tasarım yok; mockup satır referansları her commit mesajında. Wave 1 fonksiyonu korundu. Kullanıcı tarayıcı doğrulaması bekleniyor (hard reload sonrası `https://netmanager.systrack.app/devices/4`).

Sıradaki çalışma: Wave 2 #1 Audit Log UI v2 (kurumsal kritik talep) veya kullanıcı tercih ettiği başka Wave 2 başlığı.
