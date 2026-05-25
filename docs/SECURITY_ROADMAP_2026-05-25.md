# NetManager / Charon — Güvenlik Düzeltme Yol Haritası

**Kaynak rapor:** CyberStrike penetrasyon raporu (`reports/netmanager_systrack_unauth_pentest_report_2026-05-25.md`)
**Hedef:** netmanager.systrack.app / VPS deploy + lokal kod tabanı
**Tarih:** 2026-05-25
**Durum:** 9 bulgu (3 High / 3 Medium / 3 Low), 3 fazlı plan

---

## 1. Bulguların kod-tarafı kök neden doğrulaması

| # | Sev | Bulgu | Kök neden (kod konumu) |
|---|---|---|---|
| 1 | **HIGH** | Vite/dev kaynak ifşası (`/@vite/client`, `/src/*`, `/__open-in-editor`, `/@fs/*`) | [`docker-compose.yml:298`](docker-compose.yml#L298) → `target: development`. [`frontend/Dockerfile:1-12`](frontend/Dockerfile#L1) dev stage `npm run dev` (vite). Production stage (`nginx + dist`) hiç kullanılmıyor. |
| 2 | **HIGH** | Agent installer komut enjeksiyonu (`server_url`) | [`backend/app/api/v1/endpoints/agents.py:529-530`](backend/app/api/v1/endpoints/agents.py#L529) — `server_url` query'si validation/escape olmadan `base_url`'e atanıyor, sonra `_linux_installer` shell script içinde `BACKEND_URL="${base_url}"` interpolasyonuyla gömülüyor. |
| 3 | **HIGH** | Broken Access Control — `/tasks/`, `/tasks/audit-log` (rapor diyor) | [`backend/app/api/v1/endpoints/tasks.py:22-48`](backend/app/api/v1/endpoints/tasks.py#L22) — `list_tasks` permission check YOK (`_: CurrentUser` sadece auth). `audit-log:130` `audit:view` check VAR — rapor buna `tasks.view=false ama erişiyor` demiş; bu **`audit:view` ≠ `audit_logs:view`** key mismatch'i. |
| 4 | MEDIUM | HTTP → HTTPS redirect + HSTS yok | [`nginx/nginx.conf:7`](nginx/nginx.conf#L7) `listen 80` only, redirect yok, HSTS header yok. Cloudflare edge HTTPS termination yapıyor ama origin nginx + edge config zayıf. |
| 5 | MEDIUM | `agent_key` URL query'de (loglara sızar) | [`agents.py:511`](backend/app/api/v1/endpoints/agents.py#L511) — `agent_key: str = Query(...)`. Frontend caller'ları da query oluşturuyor. |
| 6 | MEDIUM | Authorization mismatch — `list_locations` | [`locations.py:65-89`](backend/app/api/v1/endpoints/locations.py#L65) — role-based RLS scope var ama `locations:view` permission check YOK. |
| 7 | LOW | Permissive CORS | [`backend/app/main.py:1115-1117`](backend/app/main.py#L1115) CORSMiddleware. [`config.py:26`](backend/app/core/config.py#L26) `ALLOWED_ORIGINS: str = "http://localhost:3000"`. Prod env'de `ALLOWED_ORIGINS` yanlış set'lenmiş (rapor `evil.example` reflect olmasını test etti — büyük olasılıkla `*` veya regex). |
| 8 | LOW | `/__open-in-editor` debug helper | Vite plugin'i; Faz 1 ile (vite kapanınca) otomatik kapanır. |
| 9 | LOW | Anonim agent runtime script (`/agents/download/script`) | [`agents.py:557-579`](backend/app/api/v1/endpoints/agents.py#L557) — `X-Agent-ID`/`X-Agent-Key` header yoksa hiçbir check yapılmıyor, script anonim döner. |

---

## 2. Sıralı Yol Haritası

### FAZ 1 — P0 KRİTİK (tek deploy turu, ~45 dk)

> **Risk:** Saldırgan source code'u görüp tüm authz logic'i, endpoint envanteri ve secret kullanımını çıkarıyor. Bu açık kapatılmadan diğer fix'ler etkisini yarı yarıya azaltır.

#### F1.1 Frontend Production Build Mode'una Geç

**Dosya:** `docker-compose.yml`
```diff
-      target: development
+      target: production
```
Container artık nginx + `dist` derlemesi serve eder. `/@vite/client`, `/src/*`, `/@fs/*`, `/__open-in-editor` → tamamı 404.

> **Side effect:** HMR çalışmaz (zaten dev için). Production'da problem değil. Local development için `docker-compose.override.yml` ile dev mode (gitignore) opsiyonu eklenmeli.

**Doğrulama:**
```bash
curl -sS https://netmanager.systrack.app/@vite/client          # 404 beklenen
curl -sS https://netmanager.systrack.app/src/main.tsx          # 404
curl -sS https://netmanager.systrack.app/__open-in-editor      # 404
curl -sS https://netmanager.systrack.app/@fs/app/package.json  # 404
```

#### F1.2 nginx Hardening — Dev Path Block + Security Headers

**Dosya:** `nginx/nginx.conf`
- Production stage'inde zaten nginx kullanılıyor (F1.1 sonrası). Bu config'i revize et:
  - `/src`, `/@vite/`, `/@fs/`, `/__open-in-editor`, `/node_modules` → 404 (defansif; ileride yanlışlıkla geri dönerse koruma)
  - `add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always`
  - `add_header X-Content-Type-Options "nosniff"`
  - `add_header X-Frame-Options "SAMEORIGIN"`
  - `add_header Referrer-Policy "strict-origin-when-cross-origin"`
  - `add_header Content-Security-Policy "default-src 'self'; ..."` (sıkı CSP — JS/CSS allowlist)
- **HTTP → HTTPS redirect:** Cloudflare edge'inde "Always Use HTTPS" zaten on olmalı (bunu CF panelden açacaksın). Nginx tarafında bunun karşılığı: `if ($scheme = http) { return 308 https://$host$request_uri; }` ya da `X-Forwarded-Proto` kontrol et.

> **Cloudflare proxy:** TLS termination edge'de. Origin'de (Docker nginx) HTTPS yok; gerek de yok (private LAN). Asıl korumayı **Cloudflare panel** ayarları yapacak:
> - SSL/TLS Mode = **Full (strict)**
> - Always Use HTTPS = ON
> - HSTS = ON (max-age 1y+, includeSubDomains)
> - Automatic HTTPS Rewrites = ON

#### F1.3 Agent Installer Command Injection Fix

**Dosya:** `backend/app/api/v1/endpoints/agents.py:511-532`

Strateji: `server_url` query parametresinden vazgeçme **veya** strict whitelist.

**Önerilen (whitelist):**
```python
ALLOWED_INSTALLER_HOSTS = {
    # Sırf bu liste; settings'ten env-driven gelir
    *(settings.ALLOWED_ORIGINS.split(",") if settings.ALLOWED_ORIGINS else []),
    settings.AGENT_WS_URL,
}

if server_url:
    # Strict parse + whitelist
    from urllib.parse import urlparse
    try:
        parsed = urlparse(server_url)
    except Exception:
        raise HTTPException(400, "Geçersiz server_url")
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(400, "server_url scheme http/https olmalı")
    if not parsed.netloc or any(c in parsed.netloc for c in '"\';|`$&\\\n\r'):
        raise HTTPException(400, "server_url geçersiz karakter içeriyor")
    base = f"{parsed.scheme}://{parsed.netloc}"
    if base not in {origin.rstrip("/") for origin in ALLOWED_INSTALLER_HOSTS if origin}:
        raise HTTPException(400, "server_url izin verilen liste dışı")
    base_url = base
```

**Alternatif (basit):** `server_url` query'sini tamamen kaldır; her zaman `settings.AGENT_WS_URL` veya `X-Forwarded-Host` kullan.

Ek defansif: `_linux_installer` içindeki shell interpolation'ı **shlex.quote** ile sarmala (string concat yerine):
```python
import shlex
script = f'BACKEND_URL={shlex.quote(base_url)}\n...'
```

---

### FAZ 2 — P1 YÜKSEK (1-2 saat)

> **Risk:** Authenticated saldırgan (viewer rolü) admin verileri görüyor — yatay yetki bypass.

#### F2.1 Tasks Endpoint Authorization

**Dosya:** `backend/app/api/v1/endpoints/tasks.py`

Yeni permission key: `monitoring:view` (mevcut RBAC modülünde) veya yeni `tasks:view`. Tasks zaten "monitoring" katalogunun parçası — `monitoring:view` daha doğal.

```python
@router.get("/", response_model=dict)
async def list_tasks(..., current_user: CurrentUser):
    if not current_user.has_permission("monitoring:view"):
        raise HTTPException(403, "Insufficient permissions")
    ...

@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(...):
    if not current_user.has_permission("monitoring:view"):
        raise HTTPException(403, "Insufficient permissions")
    ...

@router.get("/audit-log", ...)
# 130. satırdaki `audit:view` `audit_logs:view`'a düzelt (rapor "audit_logs.view=false"
# fakat backend `audit:view` arıyor → permission engine'de yanlış key match):
if not current_user.has_permission("audit_logs:view"):
    raise HTTPException(403, "Insufficient permissions")
```

#### F2.2 Locations Endpoint Authorization

**Dosya:** `backend/app/api/v1/endpoints/locations.py:65`
```python
if not current_user.has_permission("locations:view"):
    raise HTTPException(403, "Insufficient permissions")
```
(RLS scope mevcut filtrelemeyi sağlıyor, ama permission key kapısı eksik.)

#### F2.3 CORS Strict Allowlist

**Dosya:** `backend/app/core/config.py` + production `.env`

Mevcut `allowed_origins_list` "split by comma" — env'de `*` veya boş gelirse permissive. Production env'i:
```env
ALLOWED_ORIGINS=https://netmanager.systrack.app,https://www.netmanager.systrack.app
```

Defansif olarak `main.py` CORSMiddleware'de wildcard reject:
```python
origins = [o for o in settings.allowed_origins_list if o and o != "*"]
if not origins:
    raise RuntimeError("ALLOWED_ORIGINS env değişkeni production'da boş/wildcard olamaz")
```

#### F2.4 RBAC Permission Engine Audit

Permission key tutarlılığı:
- Frontend `/auth/me/permissions` → `audit_logs.view`, `tasks.view`, `locations.view` (dot notation, modül.action)
- Backend `current_user.has_permission(...)` çağrıları → `audit:view`, `task:create` (kolon notation, **modül kısaltılmış**)

Bu mismatch → backend kontrolü "audit:view" ararken permission set'te "audit_logs:view" var → check her zaman `false` döner → `task:create` mevcut çalışıyor sadece çünkü permission set'te de "task:create" key var.

**Action:** Permission key naming convention belgesi + tüm backend `has_permission()` çağrılarını dolaş + key align et. `services/rbac/engine.py` + `models/permission_set.py`'de DEFAULT_PERMISSIONS'a bak.

---

### FAZ 3 — P2 ORTA (2-4 saat)

#### F3.1 agent_key Header'a Taşı

**Backend** `agents.py:511`:
```python
@router.get("/{agent_id}/download/{platform}")
async def download_installer(
    agent_id: str,
    platform: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    agent_key: str = Header(..., alias="X-Agent-Key", description="..."),
    server_url: str = Query(None, ...),  # whitelist'li
):
```

**Frontend** `pages/Agents/index.tsx` veya nerede çağrılıyorsa:
- "İndir" linki yerine `<button onClick={download}>` → fetch + Header → Blob download.

#### F3.2 /agents/download/script Auth Gate

**Dosya:** `agents.py:557`
```python
@router.get("/download/script")
async def download_agent_script(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    agent_id = request.headers.get("X-Agent-ID")
    agent_key = request.headers.get("X-Agent-Key")
    if not (agent_id and agent_key):
        raise HTTPException(401, "X-Agent-ID + X-Agent-Key header'ları gerekli")
    agent = await db.get(Agent, agent_id)
    if not agent or not verify_password(agent_key, agent.agent_key_hash):
        raise HTTPException(403, "Geçersiz agent kimlik bilgileri")
    ...
```

#### F3.3 `/__open-in-editor` ve `/@fs/*` Defansif Block

F1.1 ile zaten kapanır (vite yok artık). F1.2 nginx block'u defansif ikinci katman.

---

## 3. Test Senaryoları (her faz sonrası)

```bash
# F1 sonrası
curl -sI https://netmanager.systrack.app/@vite/client      # → 404
curl -sI https://netmanager.systrack.app/src/main.tsx      # → 404
curl -sI https://netmanager.systrack.app/__open-in-editor  # → 404
curl -sI http://netmanager.systrack.app/                   # → 308 → https
curl -sI https://netmanager.systrack.app/ | grep -i strict-transport-security
# → header present

# Agent installer injection
curl 'https://netmanager.systrack.app/api/v1/agents/{id}/download/linux?agent_key=X&server_url=https%3A%2F%2Fevil.com%22%3Becho%20RCE%3B%23' \
  → 400 Bad Request (whitelist)

# F2 sonrası — viewer token ile
curl -H "Authorization: Bearer <viewer-token>" https://netmanager.systrack.app/api/v1/tasks/
# → 403 Insufficient permissions
curl -H "Authorization: Bearer <viewer-token>" https://netmanager.systrack.app/api/v1/locations/
# → 403

# CORS strict
curl -i -X OPTIONS https://netmanager.systrack.app/api/v1/auth/login \
  -H "Origin: https://evil.com" -H "Access-Control-Request-Method: POST"
# → Access-Control-Allow-Origin attacker origin'i içermemeli
```

---

## 4. Zaman + Risk Matrisi

| Faz | Süre | Downtime | Risk azaltma |
|---|---|---|---|
| F1 (P0) | ~45 dk | ~2 dk (frontend rebuild) | %80 — saldırı zincirinin temelini keser |
| F2 (P1) | ~2 saat | <30 sn (backend hot reload) | %15 — yatay yetki bypass kapatır |
| F3 (P2) | ~3 saat | <30 sn | %5 — hardening + defense-in-depth |

---

## 5. Önerilen sıra

1. **Bugün:** F1 (P0) → tek deploy, hemen yap. Cloudflare ayarları da paralel.
2. **Yarın:** F2 (P1) → permission key align + endpoint authz check'leri. PR ile review.
3. **Bu hafta:** F3 (P2) → agent_key header migration (frontend cooperation gerek).

---

## 6. Onaylanmış uygulama planı

Aşağıdaki başlıklardan onayladığını "evet/devam" diyene kadar uygulamıyorum. F1 önerim olarak başlayalım çünkü dev exposure tek başına en büyük risk.
