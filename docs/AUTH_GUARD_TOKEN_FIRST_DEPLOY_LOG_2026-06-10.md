# P0 Auth Guard Token-First Fix — Production Deploy Log

> **STATUS: PRODUCTION DEPLOY COMPLETED + MANUEL BROWSER SMOKE PASS ✅**
> Frontend-only token-first ProtectedRoute + RootRedirect kalıcı çözüm.
> Backend / postgres / redis / celery / edge nginx **DOKUNULMADI**.

## Özet

- **Hedef:** VPS prod (`93.180.133.88`, `/opt/netmanager`)
- **Önceki HEAD** `54ce921` (PR #70 hali, PR #72 rollback edilmişti)
- **Cherry-pick zinciri:**
  - `git cherry-pick 914b38a` (PR #72 squash — LocationGate görünür fallback + finalizeSession direct navigate) → VPS commit `1b4bd9f`
  - `git cherry-pick 69631cb` (PR #73 squash — token-first auth guard) → VPS commit `cb9762f`
- **Final VPS HEAD:** `cb9762f`
- **Backend image:** `0bd08b79f779` UNCHANGED ✅
- **Frontend image:** `e93b6707fb77` → **`7cd1337f313c`**
- **Alembic:** `f9aeportpol` UNCHANGED ✅
- **Sprint 2A + PR 4 + PR #58 + PR #57 + PR #62 + Agent UI PR #67** prod git ağacında YOK ✅
- **Manuel browser smoke:** ✅ Admin PASS (login → /dashboard + Sidebar + header + Dashboard kartları görünür)

## A. Gerçek kullanıcı smoke sonucu

Manuel browser test (admin kullanıcı, gizli sekme):

| # | Adım | Sonuç |
|---|---|---|
| 1 | Login ekranı açıldı | ✅ |
| 2 | Giriş başarılı | ✅ |
| 3 | "Yönlendiriliyor…" stuck DEĞIL | ✅ |
| 4 | /dashboard route'una geçti | ✅ |
| 5 | Sidebar görünür | ✅ |
| 6 | Header görünür | ✅ |
| 7 | Dashboard kartları görünür | ✅ |
| 8 | Siyah/boş ekran YOK | ✅ |
| 9 | Uygulama kullanılabilir | ✅ |

## B. Login sonrası request zinciri

Production nginx logs (kullanıcı IP `176.233.31.95`, Safari/Chrome Mac):

```
20:31:06 GET /api/v1/intelligence/fleet/risk    → 200 (referer: /dashboard)
20:31:06 GET /api/v1/tasks/?limit=6              → 200
20:31:06 GET /api/v1/services/fleet/impact-summary → 200
20:31:06 GET /api/v1/devices/?limit=1000         → 200
20:31:06 GET /api/v1/sla/fleet-summary           → 200 (×2)
20:31:06 GET /api/v1/backup-schedules/drift-report → 200
20:31:06 GET /api/v1/approvals/pending-count     → 200
20:31:06 GET /api/v1/intelligence/anomalies      → 200
20:31:06 GET /api/v1/agents/                     → 200 (×3)
20:31:06 GET /api/v1/context/current             → 200
20:31:06 GET /api/v1/monitor/stats               → 200 (×3)
```

**Tüm Dashboard widget API'leri 200 dönüyor, kalıcı 4xx/5xx YOK.**

## C. Frontend/backend image bilgileri

| | Önceki | Yeni |
|---|---|---|
| Frontend image | `e93b6707fb77` | **`7cd1337f313c`** |
| Backend image | `0bd08b79f779` | **`0bd08b79f779`** UNCHANGED ✅ |
| Alembic version | `f9aeportpol` | **`f9aeportpol`** UNCHANGED ✅ |

## D. VPS HEAD ve bundle hash

- **VPS HEAD:** `cb9762f8837013ff1f64ca80d5049b2aee787697`
- **Bundle hash:** **`index-BEaYgLQm.js`**
- **CSS:** `index-uWsjMl-2.css` (aynı, değişmedi)

**Token-first bundle aktif kanıtı:**

| Marker | Bundle'da match |
|---|---|
| `app-layout` | **1** ✅ |
| `dashboard-page` | **3** ✅ (workspace + mission + editorial) |
| `protected-route-loading` | **1** ✅ |

## E. Servis health (11/11)

```
backend                 Up 7 hours (healthy)         ← UNCHANGED
celery_agent_worker     Up 37 hours (healthy)
celery_beat             Up 37 hours (healthy)
celery_default_worker   Up 37 hours (healthy)
celery_worker           Up 37 hours (healthy)
event_consumer          Up 37 hours (healthy)
flower                  Up 37 hours
frontend                Up 12 minutes                ← RECREATED (7cd1337f313c)
nginx                   Up 37 hours (healthy)        ← edge UNCHANGED
postgres                Up 37 hours (healthy)
redis                   Up 37 hours (healthy)
```

## F. PR #69/#71/#72/#73 final durumları

| PR | Final durum |
|---|---|
| **PR #69** (PR #68 deploy log) | ✅ **CLOSED — superseded by PR #73** |
| **PR #71** (PR #70 deploy log) | ✅ **CLOSED — superseded by PR #73** |
| **PR #72** (LocationGate + finalizeSession direct navigate) | ✅ kod merged kalır + ilk deploy denemesi FAILED + rolled back (commenti eklendi). PR #73 onun üzerine kalıcı çözüm. |
| **PR #73** (token-first auth guard) | ✅ **MERGED + DEPLOY PASS + MANUEL SMOKE PASS** ⭐ |
| **Bu PR** (PR #73 deploy log) | YENİ — bu doküman |

## G. Memory entry güncellemesi

Bu PR sonrası memory güncellemeleri:

1. `dashboard-refresh-auth-backlog` → **✅ RESOLVED / VERIFIED IN PRODUCTION** (PR #73 token-first ile)
2. Yeni entry: `auth-guard-token-first-shipped` — kapanış raporu
3. `nginx-root-redirect-fix` — KORUNDU
4. `sw-killswitch-shipped` — KORUNDU
5. MEMORY.md index güncellendi

## H. Dashboard/Auth backlog kapanışı

**Gerçek kök neden (kalıcı belirlenmiştir):**

```tsx
// App.tsx ESKİ ProtectedRoute:
if (!hydrated) return null     // ⭐ BLANK SCREEN KAYNAĞI
return token ? children : <Navigate to="/login">
```

ProtectedRoute, hidrasyon tamamlanmadan token mevcut olsa bile `if (!hydrated) return null` çalıştırıyordu. Sonuç:
- Login başarılıydı
- Token store'a yazılıyordu
- URL `/dashboard` olabiliyordu
- AMA AppLayout ve Dashboard MOUNT EDİLMİYORDU
- `<div id="root">` içinde sadece global style/provider kabuğu kalıyordu (1765 byte)
- Kullanıcı siyah/boş ekran görüyordu

**Kalıcı çözüm — token-first karar matrisi:**

```tsx
// YENİ ProtectedRoute:
if (token) return <>{children}</>             // hydrated bağımsız
if (!hydrated) return <ProtectedRouteLoading />
return <Navigate to="/login" replace />
```

| token | hydrated | render |
|---|---|---|
| var | false | **children** (eskiden null) ⭐ |
| var | true | children |
| null | false | görünür `<Spin>` (eskiden null) |
| null | true | /login |

**Birden fazla hotfix boyunca devam eden bu sorunda (PR #39/#41/#43/#45/#47) ardışık hotfix'ler kök sorunun kısmi semptomlarını çözmüştü; tam çözüm bu PR ile sağlandı.**

### Korunan tamamlayıcı düzeltmeler

- ✅ Nginx `/` → `/welcome/` redirect kaldırıldı (PR #64)
- ✅ `/dashboard` explicit route eklendi (PR #68)
- ✅ Login finalizeSession doğrudan `/dashboard` yönlendirmesi (PR #72)
- ✅ SiteContext hydration guard + retry (PR #70)
- ✅ LocationGate hata halinde görünür fallback + retry (PR #72)
- ✅ SW Kill-Switch ve Cloudflare cache bypass (PR #60 + Faz 0)
- ✅ Yeni org için Unassigned — atg-hotels location data fix (Sprint 1C)

## I. Rollback tag'in korunması

```
netmanager-frontend:rollback-pre-auth-guard-fix-20260610_2014 → e93b6707fb77
```

**Tag korunmuştur.** Acil rollback gerekirse:
```bash
docker tag netmanager-frontend:rollback-pre-auth-guard-fix-20260610_2014 netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard 54ce921
```
~30 sn. Backend `0bd08b79f779` UNCHANGED, alembic `f9aeportpol` UNCHANGED.

## J. Regression test özeti

Kalıcı vitest entegrasyon testleri (`649/649 PASS`):

| Test | Durum |
|---|---|
| token VAR + hydrated FALSE → children (Dashboard) render | ✅ |
| token YOK + hydrated FALSE → ProtectedRouteLoading | ✅ |
| token YOK + hydrated TRUE → /login | ✅ |
| Login submit → setAuth → navigate('/dashboard', replace) | ✅ |
| AppLayout `data-testid="app-layout"` render | ✅ |
| Dashboard `data-testid="dashboard-page"` render | ✅ |
| #root innerHTML > 0 (boş değil) | ✅ |
| Navigate döngü guard (< 10 navigate / 150ms) | ✅ |
| `setTimeout(navigate)` regression YOK | ✅ |
| `window.location.assign` regression YOK | ✅ |
| `setTimeout(setHydrated, N)` auth bypass regression YOK | ✅ |

## Sıradaki iş önerisi

1. **PR #62 must_change_password redeploy** (controlled window, ayrı maintenance)
2. **Agent UI PR #67** (Windows install komut UI fix) — yeniden gündeme alınabilir
3. **Pentest Faz 1-3** (transport hardening, auth security, CSP) — bağımsız sprint
4. Frontend Playwright E2E test harness (data-testid marker'larıyla)

## Kullanıcı kuralları uyumluluğu

| Kural | Durum |
|---|---|
| Frontend-only build/deploy | ✅ |
| Backend / DB / migration / restart / compose / edge nginx YOK | ✅ |
| PR #62 / #63 / Sprint 2A / Audit PR4 YOK | ✅ |
| PR #57/#58 prod'a alınmadı | ✅ |
| Agent UI PR #67 dahil edilmedi | ✅ (agents_ui delta 0) |
| SW Kill-Switch korundu | ✅ |
| Nginx Root Redirect Fix korundu | ✅ |
| /welcome/ direkt erişilebilir | ✅ |
| Backend Windows installer PR #66 korundu | ✅ |
| SSH Termination KAPALI | ✅ |
| Range cherry-pick YOK | ✅ (2 tek SHA cherry-pick: 914b38a + 69631cb) |
| setTimeout / window.location.assign / setTimeout(setHydrated) bypass YOK | ✅ |
