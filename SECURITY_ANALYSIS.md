# NetManager — Kapsamlı Güvenlik Açığı Analizi v2

> **Tarama araçları:** Snyk + Trivy (container) + Manuel kaynak kod incelemesi  
> **Tarih:** 30 Nisan 2026  
> **Kapsam:** Backend, Celery Worker/Beat, Flower, Redis, TimescaleDB, Frontend container'ları + uygulama kodu

---

## Genel Sayım

| Seviye | Container/Paket | Uygulama Kodu | Toplam |
|--------|-----------------|---------------|--------|
| 🔴 KRİTİK | 7 | 1 | 8 |
| 🟠 YÜKSEK | 14 | 4 | 18 |
| 🟡 ORTA | 18+ (çözüm var) | 5 | 23+ |
| ⛔ Çözümsüz | ~490+ (kernel+OS) | — | ~490 |

---

## BÖLÜM A — UYGULAMA KODU AÇIKLARI

---

### 🔴 A-1: `GET /credential-profiles` — Kimlik Doğrulamasız Erişim

**Dosya:** `backend/app/api/v1/endpoints/credential_profiles.py:80`  
**Etki:** Kritik — authentication bypass + information disclosure

Herhangi biri (giriş yapmadan) tüm credential profil isimlerini, SSH kullanıcı adlarını ve SNMP community string'lerini okuyabilir.

```python
# SORUNLU:
@router.get("")
async def list_profiles(db: AsyncSession = Depends(get_db)):  # auth yok!

# DÜZELTME:
@router.get("")
async def list_profiles(db: AsyncSession = Depends(get_db), _: CurrentUser = None):
```

---

### 🟠 A-2: WebSocket Endpoint'leri — Kimlik Doğrulamasız

**Dosya:** `backend/app/api/v1/endpoints/ws.py`  
**Etki:** Yüksek — Tüm network olayları, görev ilerlemesi ve anomaliler authentication olmadan okunabilir

3 WebSocket endpoint'i de herhangi bir kimlik doğrulaması içermiyor:
- `ws/tasks/{task_id}` — Tüm görev ilerlemesi/çıktısı
- `ws/anomalies` — STP döngüleri, ağ anomalileri  
- `ws/events` — Cihaz offline/online, tüm network olayları

```python
# DÜZELTME — Her endpoint'te token doğrulama ekle:
from fastapi import WebSocket, Query
from app.core.security import decode_access_token
from app.models.user import User
from sqlalchemy import select

async def _ws_auth(websocket: WebSocket, db: AsyncSession, token: str) -> User | None:
    payload = decode_access_token(token)
    if not payload:
        await websocket.close(code=4001, reason="Unauthorized")
        return None
    user = (await db.execute(select(User).where(User.id == int(payload["sub"])))).scalar_one_or_none()
    if not user or not user.is_active:
        await websocket.close(code=4001, reason="Unauthorized")
        return None
    return user

@router.websocket("/events")
async def events_ws(websocket: WebSocket, token: str = Query(...), db: AsyncSession = Depends(get_db)):
    user = await _ws_auth(websocket, db, token)
    if not user:
        return
    await websocket.accept()
    # ... geri kalan kod aynı
```

---

### 🟠 A-3: `DeviceResponse` — SNMP Community String Plaintext Döndürüyor

**Dosya:** `backend/app/schemas/device.py:128`  
**Etki:** Yüksek — Her authenticated kullanıcı tüm cihazların SNMP community string'lerine erişebilir

```python
class DeviceResponse(BaseModel):
    ...
    snmp_community: Optional[str]   # ← plaintext! her list/get isteğinde dönüyor
```

SNMP community string pratikte bir parola. Tüm cihaz listeleme endpoint'lerinde (`GET /api/v1/devices/`) bu alan her authenticated kullanıcıya açık.

```python
# DÜZELTME — schemas/device.py:
class DeviceResponse(BaseModel):
    ...
    snmp_community_set: bool = False    # sadece set olup olmadığını göster
    # snmp_community alanını tamamen kaldır
```

---

### 🟠 A-4: `assign_group_credential_profile` — Yetki Kontrolü Yok

**Dosya:** `backend/app/api/v1/endpoints/devices.py:123`  
**Etki:** Yüksek — Herhangi bir authenticated kullanıcı tüm device gruplarına credential profil atayabilir

```python
# SORUNLU — izin kontrolü yok:
@router.post("/groups/{group_id}/assign-credential-profile")
async def assign_group_credential_profile(
    group_id: int, payload: dict, request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,   # sadece auth, no RBAC
):
    # ...

# DÜZELTME:
async def assign_group_credential_profile(
    group_id: int, payload: dict, request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = None,
):
    if not current_user.has_permission("device:edit"):
        raise HTTPException(403, "Insufficient permissions")
```

---

### 🟠 A-5: Credential CRUD — Admin Rolü Kontrolü Yok

**Dosya:** `backend/app/api/v1/endpoints/credential_profiles.py`  
**Etki:** Yüksek — `operator` veya `viewer` rolündeki kullanıcı credential oluşturabilir/silebilir

`create_profile`, `update_profile`, `delete_profile` endpoint'leri yalnızca "authenticated user" kontrolü yapıyor.

```python
# DÜZELTME — her 3 endpoint'e ekle:
from app.core.deps import require_roles
from app.models.user import UserRole

AdminRequired = Depends(require_roles(UserRole.SUPER_ADMIN, UserRole.ADMIN))

@router.post("")
async def create_profile(payload: dict, _admin: User = AdminRequired, db: ...):
    ...
```

---

### 🟡 A-6: SNMP v3 Parolaları — Device Model ve Credential Profile'da Plaintext

**Dosyalar:**  
- `backend/app/models/device.py:121-124` — `snmp_v3_auth_passphrase`, `snmp_v3_priv_passphrase`  
- `backend/app/api/v1/endpoints/credential_profiles.py:73-76`  
**Etki:** Orta — DB yetkisiz erişimde SNMP v3 kimlik bilgileri okunabilir

SSH parolaları Fernet ile şifrelenirken SNMP v3 parolaları plaintext saklanıyor.

```python
# DÜZELTME — credential_profiles.py _apply_fields():
from app.core.security import encrypt_credential
if "snmp_v3_auth_passphrase" in payload and payload["snmp_v3_auth_passphrase"]:
    p.snmp_v3_auth_passphrase = encrypt_credential(payload["snmp_v3_auth_passphrase"])
if "snmp_v3_priv_passphrase" in payload and payload["snmp_v3_priv_passphrase"]:
    p.snmp_v3_priv_passphrase = encrypt_credential(payload["snmp_v3_priv_passphrase"])
```

> **Not:** Değişiklikten sonra SNMP task'larında `decrypt_credential()` çağrısı da eklenecek.

---

### 🟡 A-7: SNMP Community String — API Response'da Açık (Credential Profile)

**Dosya:** `backend/app/api/v1/endpoints/credential_profiles.py:31`  
**Etki:** Orta — A-3 ile birlikte her iki noktada da SNMP parolası görünür

```python
# SORUNLU:
"snmp_community": p.snmp_community,   # plaintext

# DÜZELTME:
"snmp_community_set": bool(p.snmp_community),
```

---

### 🟡 A-8: `bulk_delete_devices` — Tenant İzolasyon Eksikliği

**Dosya:** `backend/app/api/v1/endpoints/devices.py:721`  
**Etki:** Orta — Tenant A admini, Tenant B cihazlarını silebilir

Tekil `DELETE /{device_id}` için `_get_device_scoped()` ile tenant izolasyonu yapılıyor, ancak bulk delete tenant filtresi uygulamıyor:

```python
# SORUNLU:
result = await db.execute(select(Device).where(Device.id.in_(device_ids)))

# DÜZELTME:
q = select(Device).where(Device.id.in_(device_ids))
if current_user.role != UserRole.SUPER_ADMIN:
    q = q.where(Device.tenant_id == current_user.tenant_id)
result = await db.execute(q)
```

---

### 🟡 A-9: Email STARTTLS — Sertifika Doğrulaması Yok

**Dosya:** `backend/app/services/notification_service.py:120-121`  
**Etki:** Orta — MITM saldırısıyla SMTP kimlik bilgileri çalınabilir

```python
# SORUNLU:
server = smtplib.SMTP(smtp_host, smtp_port, timeout=10)
server.starttls()   # ← sertifika doğrulanmıyor

# DÜZELTME:
import ssl
ctx = ssl.create_default_context()
server = smtplib.SMTP(smtp_host, smtp_port, timeout=10)
server.starttls(context=ctx)   # ← sertifika doğrulama aktif
```

---

### 🟡 A-10: Login Endpoint — Brute-Force Koruması Yok

**Dosya:** `backend/app/api/v1/endpoints/auth.py:18`

```python
# DÜZELTME — requirements.txt'e slowapi>=0.1.9 ekle:
from slowapi import Limiter
from slowapi.util import get_remote_address
limiter = Limiter(key_func=get_remote_address)

@router.post("/login")
@limiter.limit("10/minute")
async def login(request: Request, payload: LoginRequest, ...):
    ...
```

---

## BÖLÜM B — PYTHON PAKET AÇIKLARI (Backend/Flower/Celery)

---

### 🔴 B-1: `python-jose 3.3.0` — CVE-2024-33663 + CVE-2024-33664

**Etkilenen:** backend, celery_worker, celery_beat, flower  
**CVSS:** 9.1 (CRITICAL) + MEDIUM  
**Çözüm:** `python-jose[cryptography]>=3.4.0`

- **CVE-2024-33663:** EC algoritma konfüzyonu → JWT token sahtecilik
- **CVE-2024-33664:** JWT bomb → aşırı büyük JWT ile backend hafıza tükenmesi

---

### 🟠 B-2: `starlette 0.41.3` — CVE-2025-62727 + CVE-2025-54121

**CVSS:** HIGH + MEDIUM  
**Çözüm:** `starlette>=0.49.1`

2 ayrı güvenlik açığı. FastAPI ile birlikte gelir — FastAPI güncellenirse otomatik çözülür.

---

### 🟠 B-3: `python-multipart 0.0.20` — CVE-2026-24486 + CVE-2026-40347

**CVSS:** HIGH + MEDIUM  
**Çözüm:** `python-multipart>=0.0.26`

Form upload parsing güvenlik açıkları.

---

### 🟠 B-4: `cryptography 43.0.3` — CVE-2026-26007

**CVSS:** HIGH  
**Çözüm:** `cryptography>=46.0.5`

Fernet şifreleme ve JWT için kullanılan kütüphanede güvenlik açığı.

---

### 🟡 B-5: `pip 25.0.1` — CVE-2025-8869

**CVSS:** MEDIUM  
**Çözüm:** Container içinde `pip install pip==25.3`  
Dockerfile'a ekle:
```dockerfile
RUN pip install --upgrade pip==25.3
```

---

### 🟡 B-6: `python-dotenv 1.0.1` — CVE-2026-28684

**CVSS:** MEDIUM  
**Çözüm:** `python-dotenv>=1.2.2`

---

### 🟡 B-7: `ecdsa 0.19.2` — CVE-2024-23342 ⚠️ Çözüm Yok

**CVSS:** HIGH  
`python-jose`'nin bağımlılığı. `python-jose>=3.4.0` ile bu bağımlılık azalabilir. Alternatif: `python-jose` yerine `PyJWT` kütüphanesine geçmek.

---

### ⛔ B-8: `ecdsa 0.19.2` sistem kütüphaneleri — Çözüm Yok

`libsystemd0`, `libudev1`, `openssh-client`, `ncurses` — bunlar için Debian'dan patch henüz yok. Risk azaltma: Docker container'ı hiçbir zaman internete doğrudan expose etme.

---

## BÖLÜM C — FRONTEND NPM PAKET AÇIKLARI

---

### 🟠 C-1: `xlsx 0.18.5` — CVE-2023-30533 + CVE-2024-22363 (HIGH)

**Çözüm:** `"xlsx": ">=0.20.2"`

Prototype pollution ve ReDoS. Kötü biçimlendirilmiş Excel dosyası ile tetiklenebilir.

---

### 🟠 C-2: `minimatch 9.0.5` — 3 CVE (HIGH)

**Çözüm:** `"overrides": { "minimatch": ">=9.0.7" }`

---

### 🟠 C-3: `cross-spawn 7.0.3` — CVE-2024-21538 (HIGH)

**Çözüm:** `"overrides": { "cross-spawn": ">=7.0.5" }`

---

### 🟠 C-4: `tar 6.2.1` — 6 CVE (HIGH)

**Çözüm:** `"overrides": { "tar": ">=7.5.11" }`

---

### 🟠 C-5: `glob 10.4.2` — CVE-2025-64756 (HIGH)

**Çözüm:** `"overrides": { "glob": ">=10.5.0" }`

---

### 🟡 C-6: `brace-expansion 2.0.1` — CVE-2026-33750 (MEDIUM)

**Çözüm:** `"overrides": { "brace-expansion": ">=2.0.3" }`

---

## BÖLÜM D — CONTAINER/İMAJ AÇIKLARI

---

### 🔴 D-1: Redis — OpenSSL CRITICAL (CVE-2025-15467 + CVE-2026-31789)

**İmaj:** `redis:7-alpine`  
**CVSS:** 9.8 + 8.1  
**Etkilenen:** `libcrypto3`, `libssl3` @ 3.3.5-r0  
**Çözüm sürüm:** `3.3.7-r0` (en güncel Alpine Redis imajında mevcut)

```yaml
# docker-compose.yml:
redis:
  image: redis:7.4-alpine   # veya en güncel 7.x patch
```

---

### 🔴 D-2: Redis — Go `stdlib v1.18.2` — 4 CRITICAL, 40+ HIGH CVE

Go 1.18.2, Redis imajındaki monitoring tool'undan geliyor. Büyük ölçüde outdated.  
**Çözüm:** Redis imajı güncellemesi ile gelir (D-1 ile aynı fix).

---

### 🔴 D-3: TimescaleDB — `github.com/jackc/pgx/v5 v5.7.2` — CVE-2026-33816 (CRITICAL)

**CVSS:** CRITICAL  
**Çözüm sürüm:** `5.9.0`  
**Çözüm:** `docker compose pull postgres && docker compose up -d postgres`

---

### 🟠 D-4: Backend Dockerfile — `linux-libc-dev` Production Container'da

**Dosya:** `backend/Dockerfile`  
**Etki:** 135 HIGH + 352 MEDIUM CVE (çözümsüz kernel CVE'leri)

`gcc` ve `linux-libc-dev` sadece build time'da gerekli. Bunları production image'da bırakmak gereksiz yüzlerce CVE ekliyor.

```dockerfile
# MEVCUT (SORUNLU):
FROM python:3.12-slim
RUN apt-get install -y gcc libpq-dev openssh-client iputils-ping traceroute bind9-dnsutils

# DÜZELTME — Multi-stage build:
FROM python:3.12-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 openssh-client iputils-ping traceroute bind9-dnsutils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /install /usr/local
COPY . /app
WORKDIR /app
ENV PYTHONPATH=/app PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
```

---

### 🟡 D-5: Redis — `musl 1.2.5-r9` — CVE-2026-40200 (HIGH, CVSS 7.5)

**Çözüm:** Redis imaj güncellemesi ile gelir.

---

### 🟡 D-6: Redis — `zlib 1.3.1-r2` (MEDIUM, fix mevcut)

**Çözüm:** Redis imaj güncellemesi ile gelir.

---

### 🟡 D-7: Redis — `busybox 1.37.0-r13` — CVE-2024-58251 (MEDIUM)

**Çözüm sürüm:** `1.37.0-r14` — Redis imaj güncellemesi ile gelir.

---

### 🟡 D-8: TimescaleDB — `xz 5.8.2-r0` — CVE-2026-34743 (MEDIUM, CVSS 5.3)

**Çözüm:** `5.8.3-r0` — TimescaleDB imaj güncellemesi ile gelir.

---

### 🟡 D-9: Backend/Flower — `libxml2` — CVE-2026-6732 (MEDIUM)

**Çözüm:** Şu an Debian'dan patch yok. Risk minimal (libxml2 doğrudan kullanılmıyor).

---

## BÖLÜM E — TOPLU ÇÖZÜM PLANI

### Adım 1 — Acil: Uygulama Kodu (Aynı Gün)

| Dosya | Değişiklik |
|-------|-----------|
| `credential_profiles.py:80` | `list_profiles` → `_: CurrentUser = None` ekle |
| `credential_profiles.py:31` | `snmp_community` → `snmp_community_set: bool` yap |
| `credential_profiles.py:73-76` | SNMP v3 parolalarını `encrypt_credential()` ile şifrele |
| `credential_profiles.py:85,109,283` | `create/update/delete` → `AdminRequired` dependency ekle |
| `ws.py` | 3 WebSocket endpoint'ine token tabanlı auth ekle |
| `schemas/device.py:128` | `snmp_community` alanını `snmp_community_set: bool` yap |
| `devices.py:123` | `assign_group_credential_profile` → izin kontrolü ekle |
| `devices.py:738` | `bulk_delete` → tenant filtresi ekle |
| `notification_service.py:121` | `starttls()` → `starttls(context=ssl.create_default_context())` |

### Adım 2 — Acil: Python Paketler

`backend/requirements.txt`:
```
python-jose[cryptography]>=3.4.0   # B-1 (KRİTİK)
python-multipart>=0.0.26            # B-3
cryptography>=46.0.5                # B-4
starlette>=0.49.1                   # B-2
python-dotenv>=1.2.2                # B-6
slowapi>=0.1.9                      # A-10 brute-force
```

### Adım 3 — Dockerfile Multi-Stage (Bu Hafta)

Backend Dockerfile'ı yukarıdaki multi-stage versiyona güncelle. Bu tek değişiklik ile:
- `linux-libc-dev` kaldırılır → 487 CVE azalır
- `gcc`, `cpp`, `binutils` kaldırılır
- Final image boyutu ~150MB küçülür

### Adım 4 — Frontend NPM (Bu Hafta)

`frontend/package.json`:
```json
{
  "dependencies": { "xlsx": ">=0.20.2" },
  "overrides": {
    "cross-spawn": ">=7.0.5",
    "minimatch": ">=9.0.7",
    "glob": ">=10.5.0",
    "tar": ">=7.5.11",
    "brace-expansion": ">=2.0.3"
  }
}
```

### Adım 5 — Container Image Güncellemeleri

```bash
docker compose pull redis postgres
docker compose up -d redis postgres
docker compose up --build -d backend celery_worker celery_beat flower
```

---

## BÖLÜM F — KAPSAM DIŞI / RİSKİ KABUL ET

| Paket/Component | Neden Kapsam Dışı |
|-----------------|-------------------|
| `linux-libc-dev` kernel CVE'leri (~487 CVE) | Multi-stage build ile paket tamamen kaldırılacak |
| `ecdsa 0.19.2` | python-jose upgrade ile azalır; aktif saldırı senaryosu düşük |
| `openssh-client` CVE-2026-35385/35414 | Debian'dan patch yok; container network izolasyonu yeterli |
| `libsystemd0` CVE-2026-29111 | Konteyner içinde systemd çalışmıyor; teorik risk |
| Notification webhook SSRF | Admin-only config; mevcut RBAC yeterli |

---

## BÖLÜM G — RİSK ÖNCELİK MATRİSİ

```
                        ETKİ
               Düşük    Orta     Yüksek   Kritik
Yüksek:                           WS     python-jose
Olasılık                  SMTP    creds  openssl
                                  snmp
Orta:         brute-f    tenant  device  ecdsa
                          bulk    snmp3
Düşük:                  dotenv   libxml
```

**En Yüksek Risk Kombinasyonu:**  
Internet'e açık deployment + `GET /credential-profiles` unauthenticated + `DeviceResponse.snmp_community` plaintext  
→ Saldırgan login olmadan SNMP community string'leri ve SSH usernames'lere erişebilir

**İkinci Yüksek Risk:**  
`python-jose` CVE-2024-33663 + JWT token forge  
→ Geçerli token olmadan oturum açılabilir

---

*Analiz: Snyk + Trivy container scan raporları + 15+ kaynak kod dosyası incelemesi*  
*v1 → v2: WebSocket auth eksikliği, DeviceResponse SNMP leak, bulk tenant bypass, SMTP TLS, pip/dotenv CVE'leri eklendi*
