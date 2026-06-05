# SSH Session Termination — Design Document

**Status:** Design only (no code, no implementation). Pre-implementation gate per W1-E memory entry.
**Created:** 2026-06-05
**Author:** Charon team (Claude design pass)
**Approval gate:** Bu doküman onaylanmadan backend endpoint / RBAC verb / frontend buton **YAZILMAYACAK**.
**Scope:** Operatörün aktif SSH oturumlarını manuel olarak sonlandırmasına imkan veren backend endpoint + RBAC verb + audit modeli + frontend buton entegrasyonu.

---

## 1. Problem Tanımı

Charon NOC operatörü mevcut akışta:
- **Görüyor:** `/terminal-sessions` ekranında aktif (ended_at NULL) ve kapalı oturumları listeliyor; satır detayında komut geçmişi ve AI özet okuyabiliyor.
- **Göremiyor:** Aktif görünen ama tarayıcı sekmesi kapanmış / proxy zaman aşımına uğramış / WS yarı-açık kalmış oturumları **manuel sonlandıramıyor**.

Bu boşluk üç somut operasyonel sıkıntıya yol açıyor:

1. **Stale göstergesi gerçek state'i yansıtmıyor.** Hourly `cleanup_stale_sessions` Celery task'ı 30dk eşiği ile çalışıyor (yapılandırılabilir `session.terminal_stale_min`). Bu süre boyunca dashboard, `_stats` ve `/terminal-sessions?status=active` listesi **yanlış** sayıyor — operatör "kim hangi cihaza bağlı" sorusuna güvenle cevap veremiyor.
2. **Güvenlik müdahalesi yapılamıyor.** Bir kullanıcının yetkisi anlık olarak kaldırıldığında (suspended user, agent-WS revoke, lokasyon değişikliği) aktif oturum hâlâ canlı; operatörün **anında kesme** yolu yok. Faz 8 Phase E `_REVALIDATE_INTERVAL_S=30` revalidasyonu yetkisiz oturumu **30sn içinde** kesiyor (token bazlı) ama kullanıcı hâlâ token sahibi + scope geçerli iken (örn. yanlışlıkla bağlanmış komşunun cihazına) operatörün bir tek seçeneği var: **kullanıcıyı suspend etmek + 30sn beklemek.**
3. **Operasyonel hijyen.** İncident sonrası post-mortem yazılırken "kullanıcı X cihaz Y'ye T anına kadar bağlıydı" çıkarımı için manuel kapatma noktası gerekiyor. Audit log'da `exit_reason='force_closed'` ve `terminated_by` zincirin tamamlanması bekleniyor.

**Bu özelliğin sunduğu çözüm:**
Org admin veya super admin yetkisindeki operatör, `/terminal-sessions` ekranında satır üzerindeki **"Sonlandır"** butonu ile aktif bir oturumu **<2sn içinde** kesebilir. Sunucu hem WebSocket bağlantısını kapatır hem `TerminalSessionLog.ended_at` + `exit_reason='force_closed'` günceller hem `audit_logs` tablosuna **ayrı bir audit entry** atar (kim sonlandırdı, neden, ne kadar sürmüş).

---

## 2. Mevcut Durum

### 2.1 TerminalSessionLog modeli (T9 Tur 3A, mevcut)

`backend/app/models/terminal_session_log.py` — tek tablo, org+loc scope'lu:

```python
class TerminalSessionLog(Base):
    __tablename__ = "terminal_session_logs"
    id, session_id (uuid hex), user_id, device_id, agent_id,
    organization_id, location_id,
    client_ip, user_agent, connection_path,  # 'agent_relay' | 'direct_paramiko'
    started_at, ended_at, duration_ms, exit_reason,
    input_bytes, output_bytes,
    commands_extracted, commands_count, output_excerpt,
    ai_summary, ai_summary_status,
```

Mevcut `exit_reason` değerleri (gözlemlenen):
- `'user_closed'` — kullanıcı tarayıcı sekmesini kapatınca (WS disconnect)
- `'stale_cleanup'` — hourly Celery beat yarı-açık kalan oturumları temizler
- *(Hata yolları: agent SSH connection refused vb. → exit_reason null kalabilir + ai_summary'e hata yazılır)*

### 2.2 Mevcut endpoint'ler

`backend/app/api/v1/endpoints/terminal_sessions.py`:

| Endpoint | Method | Amaç |
|---|---|---|
| `/api/v1/terminal-sessions` | GET | Sayfalı liste; `status=active\|closed`, `user_id`, `device_id`, `search` filtreleri |
| `/api/v1/terminal-sessions/_stats` | GET | KPI (sessions_24h, commands_24h, avg_duration_ms, active_now) |
| `/api/v1/terminal-sessions/{session_id}` | GET | Detay (komutlar + excerpt + AI özet) |
| `/api/v1/terminal-sessions/{session_id}/summarize` | POST | AI ile manuel özet trigger |

**Yetki:** Org RLS otomatik filtreliyor. Açık permission kontrolü `device:connect` veya benzeri yok — sadece **görüntüleme** akışı (`viewer+` de görür).

### 2.3 SSH WebSocket akışı

`backend/app/api/v1/endpoints/ws.py:336` `@router.websocket("/ssh/{device_id}")`:

1. **Auth:** Token → `WsScope` (org+loc+role).
2. **RBAC gate:** `scope.has_permission("device:connect")` zorunlu — `SystemRole.VIEWER` reddedilir (close 4003).
3. **Scope check:** Device RLS sorgusu → cihaz görünmüyorsa close 4004.
4. **Logger oluştur:** `TerminalSessionLogger.create(...)` → `TerminalSessionLog` satırı INSERT (ai_summary_status='pending', ended_at=NULL).
5. **Iki path:**
   - **Agent relay:** `agent_manager.open_shell_session(...)` → AgentManager içinde `_shell_sessions[session_id] = {agent_id, on_output, on_close}` registry (in-process). Cihaz traffic'i agent WebSocket üzerinden tunnel'lanır.
   - **Direct paramiko:** Paramiko `SSHClient + invoke_shell + channel`; thread executor; **kayıt registry'si yok**, sadece local `channel`, `ssh_client`, `stop_event`, `revalidator` task değişkenleri.
6. **WS read/write loop** + revalidator (30sn'de bir scope check, RLS değiştiyse close).
7. **Close path:** `finally` bloğunda `revalidator.cancel()` + `close_shell_session(session_id)` (agent yolunda) + `websocket.close()` + `await _term_logger.close(_AsyncSessionLocal, exit_reason="user_closed")`.

### 2.4 Stale cleanup task'ı

`backend/app/workers/tasks/terminal_session_tasks.py` — Celery beat hourly:
- Org context = super_admin (bypass RLS).
- `WHERE ended_at IS NULL AND started_at < now() - INTERVAL '{stale_min}min'`.
- `UPDATE SET ended_at = now(), exit_reason = 'stale_cleanup'`.
- Komut/output buffer'ları **flush edilmez** (in-process buffer kayıp; satır metrikleri sıfır kalır).

### 2.5 Live WS registry — **YOK**

Bu kritik gerçek: backend'de **sürekli bakım altında tutulan canlı WS bağlantı listesi yok**.
- `AgentManager._shell_sessions` agent-relay session_id'lerini tutar; **ama tek ASGI worker'ı içindedir** (in-process Python dict).
- Direct paramiko yolunda ek registry yok; her WS handler kendi local değişkenlerini yönetir.
- Multi-worker ASGI deployment'larında bir worker'da açılan WS'i başka worker'dan **doğrudan** kapatamayız → coordination needed (Redis pub/sub veya DB-flag-polling).

**Bu, mevcut tasarımın temel kısıtıdır ve aşağıdaki §8 WS kapatma akışını şekillendirir.**

### 2.6 Manuel terminate endpoint — **YOK**

Aranan endpoint mevcut değil; bu doküman onun tasarımıdır.

---

## 3. Hedef Davranış

Operatör (org_admin+ rolünde) `/terminal-sessions` ekranında aktif bir oturum için **"Sonlandır"** butonuna tıklar →

| Adım | Sonuç |
|---|---|
| 1. Frontend `Popconfirm` ile onay alır | Yanlış-tık riski azaltılır |
| 2. `POST /terminal-sessions/{session_id}/terminate` çağrılır (opsiyonel `reason` body) | Backend kontrolü başlar |
| 3. Backend validate eder: session var, aktif, kullanıcı yetkili (`terminal_sessions:terminate`) | 404 / 410 / 403 dönebilir |
| 4. Backend Redis pub/sub ile **terminate sinyali** yayınlar; aynı org'daki canlı WS handler'lar sinyali alır; ilgili session_id'yi gören handler **kendi stop_event'ini** tetikler ve WS'i kapatır | Multi-worker safe |
| 5. Backend DB UPDATE: `ended_at=now()`, `exit_reason='force_closed'`, `duration_ms=...` (force_closed-specific kapatma — logger'ın normal close() akışından farklı; cmd/output buffer'lar zaten WS process'inde yandı, yine de mevcutsa flush et) | TerminalSessionLog audit korunur |
| 6. Backend **AyriCa** `audit_logs` tablosuna entry atar (action='terminal_sessions.terminate', resource_type='terminal_session', details=kim/neden/süre) | Compliance/forensics audit |
| 7. WebSocket istemci tarafı 4xxx close kodu alır + final mesaj görür ("This terminal session was terminated by an administrator.") | Kullanıcı net bilgi alır |
| 8. Frontend response başarılıysa session listesini refresh eder (optimistic UI **yok**) | UI kesin gerçeği yansıtır |

**SLA hedefi:**
- WS close <2sn (Redis pub/sub round-trip + handler reaction).
- DB UPDATE + audit log atomik (aynı transaction içinde).
- Idempotent: aynı session_id'ye 2 kez terminate gönderilirse ikincisi `410 Gone` döner.

---

## 4. Backend Endpoint Tasarımı

### 4.1 Endpoint imzası

```python
@router.post("/{session_id}/terminate", status_code=200)
async def terminate_session(
    session_id: str,
    body: TerminateSessionRequest | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: CurrentUser = Depends(get_current_user),
    request: Request = ...,
) -> TerminateSessionResponse:
    ...
```

Konum: `backend/app/api/v1/endpoints/terminal_sessions.py` — mevcut router içinde `_stats` ve `/{session_id}/summarize` yanına eklenir; ayrı bir module açılmaz (cohesion).

### 4.2 İmplementasyon akışı (pseudo-code)

```python
# 1. RBAC gate
if not current_user.has_permission("terminal_sessions:terminate"):
    raise HTTPException(403, detail="terminal_sessions:terminate izni yok")

# 2. Session lookup (RLS otomatik)
row = (await db.execute(
    select(TerminalSessionLog).where(
        TerminalSessionLog.session_id == session_id
    )
)).scalar_one_or_none()
if row is None:
    raise HTTPException(404, detail="Session bulunamadı")

# 3. Idempotency: zaten kapalı
if row.ended_at is not None:
    raise HTTPException(410, detail={
        "code": "session_already_closed",
        "ended_at": row.ended_at.isoformat(),
        "exit_reason": row.exit_reason,
    })

# 4. Redis pub/sub terminate sinyali
import json
from app.core.redis import get_redis  # mevcut helper
r = await get_redis()
await r.publish(
    "terminal:terminate",
    json.dumps({
        "session_id": session_id,
        "reason": (body.reason if body else None) or "force_terminated_by_admin",
        "terminated_by_user_id": current_user.id,
        "terminated_by_username": current_user.username,
        "at": datetime.now(timezone.utc).isoformat(),
    })
)
# NOT: best-effort; WS handler 1-2sn içinde signal'i alır ve close()'a düşer.
# DB update'i WS close'a bağımlı YAPMA — yarı-açık kalanlar için fallback.

# 5. DB UPDATE (force_closed kaydı)
ended_at = datetime.now(timezone.utc)
duration_ms = int((ended_at - row.started_at).total_seconds() * 1000)
before_state = {
    "ended_at": None,
    "exit_reason": None,
    "duration_ms": None,
    "status": "active",
}
after_state = {
    "ended_at": ended_at.isoformat(),
    "exit_reason": "force_closed",
    "duration_ms": duration_ms,
    "status": "closed",
}
await db.execute(
    update(TerminalSessionLog).where(
        TerminalSessionLog.session_id == session_id,
        TerminalSessionLog.ended_at.is_(None),  # race guard
    ).values(
        ended_at=ended_at,
        exit_reason="force_closed",
        duration_ms=duration_ms,
    )
)

# 6. Audit log entry
device = ...  # row.device_id ile lookup (opsiyonel; UI için hostname)
audit = AuditLog(
    organization_id=row.organization_id,
    user_id=current_user.id,
    username=current_user.username,
    action="terminal_sessions.terminate",
    resource_type="terminal_session",
    resource_id=session_id,
    resource_name=device.hostname if device else None,
    details={
        "device_id": row.device_id,
        "target_ip": device.ip_address if device else None,
        "session_user_id": row.user_id,
        "termination_reason": (body.reason if body else None) or "force_terminated_by_admin",
        "started_at": row.started_at.isoformat(),
        "terminated_at": ended_at.isoformat(),
        "duration_seconds": duration_ms // 1000,
        "agent_id": row.agent_id,
        "connection_path": row.connection_path,
    },
    client_ip=request.client.host if request.client else None,
    user_agent=request.headers.get("user-agent", "")[:512],
    status="success",
    before_state=before_state,
    after_state=after_state,
    request_id=getattr(request.state, "request_id", None),
)
db.add(audit)
await db.commit()

# 7. Response
return TerminateSessionResponse(
    session_id=session_id,
    status="terminated",
    ended_at=ended_at,
    duration_seconds=duration_ms // 1000,
    websocket_close_pending=True,  # frontend için bilgi
)
```

### 4.3 Atomicity & sıralama

**Pub/sub ÖNCE, DB UPDATE SONRA — sebep:**
- Pub/sub publish DB ile aynı transaction'da değil; arada exception olursa hem WS açık kalır hem DB UPDATE'lenmemiş olur → operatör "neden çalışmadı" sorgular.
- Bu sırada publish'i ÖNCE yaparsak: signal worker'a gider, worker kendi `close()` yolundan DB'yi `'user_closed'` ile günceller, sonra bizim endpoint DB UPDATE'i no-op olur (ended_at IS NULL race guard).
- DB UPDATE ÖNCE + publish SONRA: UPDATE başarılı + publish başarısız → WS yarı-açık kalır + DB "closed" der. UI tutarsızlığa düşer.

**Tercih edilen: publish → DB UPDATE → audit, tek transaction.** Worker pub/sub mesajını alıp `close()`'a düştüğünde, kendi UPDATE'i `WHERE ended_at IS NULL` race guard'ı ile no-op olur. Audit logger'ın `close(exit_reason="user_closed")` çağrısı boşa düşer; yine de force_closed kaydı zaten endpoint tarafında atılmış.

### 4.4 Direct paramiko vs agent relay farkı

Pub/sub mesajı **aynı**. WS handler ikisinde de subscribe olur (§8.2'de detay). Fark:
- Direct paramiko: handler `stop_event.set()` + `channel.close()` + `ssh_client.close()`.
- Agent relay: handler `closed_evt.set()` + `agent_manager.close_shell_session(session_id)` (agent'a ssh_shell_close mesajı yollar).

Her iki yolda da WebSocket'i 4xxx kodu ile kapatır (§8.3).

---

## 5. Request / Response Sözleşmesi

### 5.1 Request

`POST /api/v1/terminal-sessions/{session_id}/terminate`

```http
POST /api/v1/terminal-sessions/a3f8c9e21b4d/terminate HTTP/1.1
Authorization: Bearer <token>
X-Location-Id: 7
Content-Type: application/json

{
  "reason": "Suspended user; investigating credential leak"
}
```

**Body schema** (`TerminateSessionRequest`, opsiyonel):

| Alan | Tip | Zorunlu | Açıklama |
|---|---|---|---|
| `reason` | string (≤ 256) | Hayır | Audit log'a yazılır; boş ise `"force_terminated_by_admin"` default |

`Content-Type` boş veya body yok → `reason=null` (default reason kullanılır).

### 5.2 Success response (200)

`TerminateSessionResponse`:

```json
{
  "session_id": "a3f8c9e21b4d",
  "status": "terminated",
  "ended_at": "2026-06-05T18:42:31.124Z",
  "duration_seconds": 1834,
  "websocket_close_pending": true,
  "audit_log_id": 88421
}
```

**Alan açıklamaları:**

| Alan | Açıklama |
|---|---|
| `status` | Her zaman `"terminated"` (idempotent için ileride `"already_closed"` eklenebilir) |
| `ended_at` | ISO-8601 UTC (Z suffix) |
| `duration_seconds` | started_at → terminated_at süresi (saniye) |
| `websocket_close_pending` | `true` = pub/sub yayınlandı, WS handler kapatma sırasında; frontend kullanıcıya "kapanıyor" bilgisi gösterebilir |
| `audit_log_id` | Forensics zinciri için audit_logs.id; frontend "Audit Log'da gör" linki yapabilir |

### 5.3 Error responses

| Kod | Senaryo | Body |
|---|---|---|
| **400** | reason > 256 char | `{"detail": "reason çok uzun (max 256)"}` |
| **401** | Token yok / geçersiz | Default FastAPI 401 |
| **403** | `terminal_sessions:terminate` izni yok | `{"detail": "terminal_sessions:terminate izni yok"}` |
| **404** | session_id DB'de yok **veya** RLS scope dışı | `{"detail": "Session bulunamadı"}` |
| **410** | Session zaten kapalı | `{"detail": {"code":"session_already_closed","ended_at":"...","exit_reason":"user_closed"}}` |
| **500** | DB UPDATE veya audit insert hatası | Default FastAPI 500 |

**410 Gone'un anlamı:** Idempotent; aynı session iki kez terminate edilirse ikincisi "zaten kapalı" döner, error değil "bilgi". Frontend `410` → toast "Bu session zaten kapatılmış" + listeyi refresh et.

### 5.4 Pydantic schemas

`backend/app/schemas/terminal_session.py` (yeni dosya veya mevcut dosyaya ek):

```python
class TerminateSessionRequest(BaseModel):
    reason: Optional[constr(max_length=256)] = None

class TerminateSessionResponse(BaseModel):
    session_id: str
    status: Literal["terminated"]
    ended_at: datetime
    duration_seconds: int
    websocket_close_pending: bool
    audit_log_id: Optional[int]
```

---

## 6. RBAC Modeli

### 6.1 Yeni permission verb

**Verb:** `terminal_sessions:terminate`

**Neden ayrı:** Mevcut sistem `device:connect` (SSH başlatma), `audit:view` (audit log okuma), `device:edit` (cihaz düzenleme) gibi verb'ler tanımlı. **`audit_logs.edit` kullanılmayacak** çünkü:
- Audit görüntüleme yetkisi (`audit:view`) ≠ aktif kullanıcı oturumu sonlandırma yetkisi.
- Bir audit log düzeltmesi (silme/değiştirme) ile başka bir kullanıcının canlı işini kesme operasyonel olarak farklı bir trust modeli gerektirir.
- Ayrı verb, RBAC matrisinde net bir audit trail bırakır: "kim bu yetkiye sahip" sorusu tek lookup ile cevaplanabilir.

### 6.2 Role-default permission map (önerilen)

`backend/app/models/user.py` `SYSTEM_ROLE_PERMISSIONS` dict'ine ek:

| Rol | `terminal_sessions:terminate` | Gerekçe |
|---|---|---|
| `SUPER_ADMIN` | ✅ (zaten `"*"` ile cover) | Override hakkı |
| `ORG_ADMIN` | ✅ ekle | Org içi operasyonel sorumluluk |
| `LOCATION_ADMIN` | ✅ ekle (yalnız kendi lokasyon scope'unda) | Lokasyon operasyonu |
| `VIEWER` | ❌ | Sadece okuma |
| `MEMBER` | ❌ | Sadece kendi cihaz görünümü |

**Lokasyon scope kontrolü:** RLS otomatik. `LOCATION_ADMIN` kullanıcısı `location_id ≠ user's allowed locations` olan session_id'yi sorgulayınca **404** alır (RLS satırı görmez). Ek scope kontrolü endpoint'te gerekmez.

### 6.3 Permission set (UI-bazlı sistem)

`backend/app/models/shared/permission_set.py` `DEFAULT_PERMISSIONS` dict'inde modüler yapı var:

```python
"modules": {
    "devices": {"view":..., "edit":..., "ssh":...},
    ...
}
```

**Ek modül:**

```python
"modules": {
    ...
    "terminal_sessions": {
        "view": False,        # liste / detay görme (mevcut akışın resmi gating'i)
        "terminate": False,   # yeni verb
    },
}
```

**Migration uyumluluğu:** Mevcut permission_set kayıtları için bu key'ler **eksik** olacak; `has_permission()` çözücüsünde key yoksa `False` döner (default-deny). Yeni org_admin permission_set'leri için boostrap script'i `terminate: True` set eder.

**Frontend permission görünümü:** `frontend/src/pages/Permissions/index.tsx` modül listesine ek satır; ekran metni: "SSH Terminal Sessions — Sonlandırma (force_closed)" (i18n'a alınmalı — W1-F TerminalSessions sprint'inde birlikte).

### 6.4 Super admin override

Super admin `"*"` permission'a sahip → `terminal_sessions:terminate` otomatik allow.
- Org RLS'i super admin için `superadmin_context()` ile bypass ediliyor → cross-org session sonlandırma mümkün.
- Audit log'a normal kaydedilir; super admin'in cross-org aksiyonları RLS-forced `audit_logs` tablosunda kendi organization_id'siyle stamp'lenir (Faz 7 davranışı). Endpoint'te `audit.organization_id = current_user.organization_id` set edilmeli (org kontekst için).

### 6.5 RBAC test gereksinimi

| Test case | Beklenen |
|---|---|
| viewer kullanıcı terminate çağırır | 403 |
| org_admin **kendi org'undaki** session'ı terminate eder | 200 + audit kaydı |
| org_admin **başka org'un** session'ını terminate etmeye çalışır | 404 (RLS gizler) |
| location_admin **kendi loc'undaki** session'ı terminate eder | 200 + audit |
| location_admin **org içi başka loc'taki** session'ı terminate eder | 404 (RLS) |
| super_admin cross-org terminate | 200 + audit (audit row super_admin org'unda) |

---

## 7. Audit Log Modeli

### 7.1 AuditLog tablosu (mevcut, değişmeden kullanılacak)

`backend/app/models/audit_log.py` — alanları:

```python
AuditLog:
    organization_id, user_id, username,
    action, resource_type, resource_id, resource_name,
    details (JSON), client_ip, user_agent,
    status, request_id, duration_ms, before_state, after_state, created_at
```

### 7.2 Terminate aksiyonu için alan map'i

| AuditLog alanı | Değer |
|---|---|
| `organization_id` | `row.organization_id` (terminated session'ın org'u) |
| `user_id` | `current_user.id` (terminate eden kişi) |
| `username` | `current_user.username` |
| `action` | `"terminal_sessions.terminate"` (snake_case, mevcut paterne uyumlu) |
| `resource_type` | `"terminal_session"` |
| `resource_id` | `session_id` (string, varchar(64) — uuid hex) |
| `resource_name` | `device.hostname` (varsa) |
| `details` | JSON, aşağıda detay |
| `client_ip` | `request.client.host` |
| `user_agent` | `request.headers["user-agent"][:512]` |
| `status` | `"success"` (failure case için DB rollback olur, audit row yazılmaz) |
| `request_id` | `request.state.request_id` (FastAPI middleware mevcutsa) |
| `duration_ms` | Endpoint kendi süresi (terminate işlemi); session süresi `details.duration_seconds` |
| `before_state` | `{"ended_at": null, "exit_reason": null, "status": "active"}` |
| `after_state` | `{"ended_at": "<iso>", "exit_reason": "force_closed", "duration_ms": N, "status": "closed"}` |
| `created_at` | Default (UTC now) |

### 7.3 `details` JSON şeması

```json
{
  "session_id": "a3f8c9e21b4d",
  "device_id": 42,
  "device_name": "sw-core-01",
  "target_ip": "10.1.0.10",
  "session_user_id": 7,
  "session_username": "alice",
  "terminated_by_user_id": 12,
  "terminated_by_username": "bob_orgadmin",
  "termination_reason": "Suspended user; investigating credential leak",
  "started_at": "2026-06-05T17:11:57Z",
  "terminated_at": "2026-06-05T18:42:31Z",
  "duration_seconds": 1834,
  "agent_id": "ag_xyz123",
  "connection_path": "agent_relay",
  "commands_count_at_terminate": 47,
  "input_bytes_at_terminate": 1284,
  "output_bytes_at_terminate": 89421
}
```

> Kullanıcının §0'da listelediği alanlar bu şemada **mevcut** (terminated_by_user_id, terminated_by_username, termination_reason, started_at, terminated_at, duration_seconds, session_id, device_id, device_name, target_ip).

### 7.4 RLS davranışı

`audit_logs` tablosu Faz 7 RLS-forced. `_scoping` `before_insert` hook'u `organization_id`'yi `current_user.organization_id` ile damgalar — bu nedenle bu endpoint'te `organization_id` set ederken **session'ın org'unu** (not user's org) kullanmak için **explicit set** gerekiyor. Super admin cross-org terminate ettiğinde audit row'u session'ın org'unda olsun → o org'un audit log ekranında görünür (post-mortem zincirinin doğru yere düşmesi için).

```python
# Hook bypass: explicit organization_id set ediliyor.
# Faz 7 _scoping hook: yalnız organization_id NULL ise damgalar.
audit = AuditLog(
    organization_id=row.organization_id,  # session's org, not user's
    ...
)
```

**Doğrulama:** _scoping hook'u super_admin context'inde organization_id'yi override etmiyor; yalnız NULL ise damgalıyor (mevcut davranış). Bu varsayım §12.1 test'lerinde doğrulanacak.

### 7.5 Audit log UI etkisi

Mevcut audit log UI (Wave 2 #2 redesign, `project_audit_log_ui_v2.md` memory) `action_chip` paterniyle gösterir:
- Action chip: `"Terminal Session Force-Closed"` (i18n: `audit.action.terminal_sessions_terminate`)
- Resource: `<deviceHostname>` (`resource_name`) + session_id kısa hash (clickable → terminal session detayına gider)
- Details: `details.termination_reason` + duration + terminated_by username
- Severity: `warning` (operasyonel müdahale)

**W1-F TerminalSessions sprint'inde** bu UI metinleri TR/EN/DE/RU dört dilde eklenecek.

---

## 8. WebSocket Kapatma Akışı

### 8.1 Neden Redis pub/sub (DB polling değil)

| Yöntem | Latency | Multi-worker | Karmaşıklık | Karar |
|---|---|---|---|---|
| **In-process registry** | <100ms | ❌ Hayır (worker-bound) | Düşük | Yetersiz |
| **DB polling** (WS her N sn DB check) | N sn (1-5sn typical) | ✅ Evet | Düşük | Geçer ama yavaş |
| **Redis pub/sub** | <500ms | ✅ Evet | Orta (Redis dep zaten var) | **Tercih edilen** |
| **Per-session Redis SET + TTL** | N sn (polling) | ✅ Evet | Düşük | Pub/sub'a tercih edilmez |

Redis pub/sub: Charon'un mevcut Redis altyapısını kullanır (`backend/app/core/redis.py` `get_redis()`); ek bağımlılık yok; düşük latency.

### 8.2 Handler-side subscribe

`ws.py` SSH handler `ssh_terminal_ws` içine eklenecek (mevcut `revalidator` task'ı yanına):

```python
# Mevcut session_id'yi yarat (TerminalSessionLogger ile aynı UUID hex)
# Önemli: agent yolunda `session_id` zaten `_ag.open_shell_session()`'dan
# dönüyor; direct paramiko yolunda `_term_logger.session_id` aynı UUID.
# İkisi de aynı session_id (audit log'da tutarlılık).

terminate_event = asyncio.Event()

async def _terminate_listener():
    """Redis pub/sub subscribe: 'terminal:terminate' kanalı.
    Bu session_id için mesaj gelirse stop_event tetiklenir."""
    r = await get_redis()
    pubsub = r.pubsub()
    await pubsub.subscribe("terminal:terminate")
    try:
        async for msg in pubsub.listen():
            if msg["type"] != "message":
                continue
            try:
                payload = json.loads(msg["data"])
            except Exception:
                continue
            if payload.get("session_id") == _term_logger.session_id:
                # Bana mahsus; close()'a düşeceğiz.
                terminate_event.set()
                # WS'e final mesajı yolla
                try:
                    await websocket.send_text(
                        "\r\n\x1b[31m"
                        "═══════════════════════════════════════════\r\n"
                        "  This terminal session was terminated by\r\n"
                        "  an administrator.\r\n"
                        "═══════════════════════════════════════════"
                        "\x1b[0m\r\n"
                    )
                except Exception:
                    pass
                break
    finally:
        await pubsub.unsubscribe("terminal:terminate")

terminate_task = asyncio.create_task(_terminate_listener())
```

**Mevcut loop'lara entegrasyon:**

- Direct paramiko `stop_event = asyncio.Event()` zaten var → `if terminate_event.is_set(): stop_event.set()` döngü başında kontrol.
- Agent relay `closed_evt = asyncio.Event()` zaten var → aynı pattern.

**Race koşulları:**
- `terminate_event` set olduğunda zaten WS kapanma yolundaysa (user_closed) — sorun yok; final flush'ı kim yaparsa idempotent.
- Pub/sub mesajı handler'a ulaşmadan endpoint DB UPDATE'i bitti — handler kendi `close(exit_reason="user_closed")` çağırınca `WHERE ended_at IS NULL` guard'ı UPDATE'i no-op yapar; force_closed kaydı korunur.

### 8.3 WebSocket close kodu

Standart WS close kodları kullanılacak:
- **4000 — Force terminated by administrator** (custom, application-level).
- Frontend xterm bileşeni close event'inde `code === 4000` görürse "Bu oturum yönetici tarafından sonlandırıldı." mesajı gösterir.

```python
# Handler close path:
if terminate_event.is_set():
    await websocket.close(code=4000, reason="terminated_by_admin")
else:
    await websocket.close()  # 1000 normal
```

### 8.4 Cleanup sırası

WS handler `finally` bloğu (mevcut, küçük ek):

```python
finally:
    revalidator.cancel()
    terminate_task.cancel()  # YENI
    try:
        # Agent yolunda
        if session_id and use_agent:
            await _ag.close_shell_session(session_id)
    except Exception:
        pass
    try:
        # Direct paramiko yolunda
        channel.close()
        ssh_client.close()
    except Exception:
        pass
    # WS close kodu (terminate_event'e göre)
    try:
        code = 4000 if terminate_event.is_set() else 1000
        await websocket.close(code=code)
    except Exception:
        pass
    # Logger final flush
    exit_reason = "force_closed" if terminate_event.is_set() else "user_closed"
    try:
        await _term_logger.close(_AsyncSessionLocal, exit_reason=exit_reason)
    except Exception:
        pass
```

**Idempotency:** `TerminalSessionLogger.close()` zaten `_closed` flag ile çift çağrı korur; endpoint'in DB UPDATE'i `WHERE ended_at IS NULL` guard'ı çift yazımı engeller.

### 8.5 Agent SSH (cihaz tarafı)

Agent relay yolunda `agent_manager.close_shell_session(session_id)` agent'a `ssh_shell_close` mesajı yollar. Agent kendi yanında SSH transport'unu kapatır.
- Agent offline ise: mesaj kaybı. Cihaz SSH'i ya kendi timeout'unda kapanır ya da TCP yarı-açık kalır. **Bu tasarım scope'u dışı** (agent recovery ayrı iş).
- Agent online ama close mesajı arada kayıp: pub/sub WS handler'ı kapatmıştır; agent stale session'ı `agent_session_timeout` (mevcut) ile temizler.

---

## 9. Session Status Modeli

### 9.1 Mevcut status'lar (gözlemlenen)

- `exit_reason = NULL + ended_at = NULL` → **"active"** (UI label)
- `exit_reason = 'user_closed' + ended_at = NOT NULL` → **"closed"**
- `exit_reason = 'stale_cleanup' + ended_at = NOT NULL` → **"stale_cleanup"** (UI'da "Otomatik kapatıldı")
- *(Hata yolu)* `exit_reason = NULL + ended_at = NOT NULL` → çok nadir; race olarak işaretle

### 9.2 Yeni status

**`exit_reason = 'force_closed'`** (lower_snake_case; mevcut paterne uyumlu)

| UI label (TR / EN / DE / RU) | Renk |
|---|---|
| `Yönetici tarafından sonlandırıldı` / `Force-terminated by admin` / `Vom Admin beendet` / `Принудительно завершено администратором` | `crit` / kırmızı |

### 9.3 Status hesaplama (frontend + backend tutarlılık)

```python
# Backend serialize_list_item helper'ında:
def _compute_status(row: TerminalSessionLog) -> str:
    if row.ended_at is None:
        return "active"
    if row.exit_reason == "user_closed":
        return "closed"
    if row.exit_reason == "stale_cleanup":
        return "stale"
    if row.exit_reason == "force_closed":
        return "force_closed"
    return "closed"  # null/bilinmeyen
```

`_serialize_list_item` çıktısına `"status"` alanı eklenir; frontend `STATUS_MAP` (i18n + renk) bunu okur (KURAL-E1: hook scope'unda useMemo).

### 9.4 Migration gereksinimi

`exit_reason` String(32) — kolon mevcut. Yeni değer eklemek için DB migration **gerekmez**. Constraint yok; uygulama-seviyesi enum.

`alembic` versiyonu **değişmez** → deploy frontend-only stratejisini bozmaz.

---

## 10. Failure Senaryoları

### 10.1 Session yok

`SELECT ... WHERE session_id = X` → null.
**Davranış:** `404 Not Found`, `{"detail": "Session bulunamadı"}`.
**Audit:** **YAZILMAZ** (varolmayan kaynak için audit gürültüsü; permission deny audit ayrı pattern).

### 10.2 Session zaten kapalı

`row.ended_at IS NOT NULL`.
**Davranış:** `410 Gone`, body'de ended_at + exit_reason.
**Audit:** **YAZILMAZ** (idempotent; çift kayıt gürültüsü). Frontend toast: "Bu oturum zaten kapatılmış."

### 10.3 WS registry'de connection yok

Endpoint pub/sub publish yapar; **hiçbir handler dinlemiyor** (worker restart, ya da session WS hiç bağlanmamış ama DB satırı duruyor → exotic race).

**Davranış:** Endpoint başarıyla `200` döner (DB UPDATE + audit). WS handler tarafında close gerçekleşmez **ama önemli değil**: WS zaten yok / dead. DB state "force_closed" yansıtır; cleanup beat task'ı eski "stale" satırları temizlemiş gibi davranır.

**Test:** session_id yarat → DB satırı INSERT et → WS handler hiç açma → terminate çağır → 200 + exit_reason='force_closed' DB'de görülmeli.

### 10.4 DB update başarılı ama WS close başarısız

Senaryo: pub/sub publish çalıştı, DB UPDATE başarılı, audit yazıldı, response 200; ama bir worker'da WS handler exception attı, close() çalışmadı; client hâlâ socket açık görüyor.

**Davranış:** Browser tarafı 30sn revalidate loop ile kendisini kapatır (`_REVALIDATE_INTERVAL_S=30` Faz 8 mekanizması). Veya bir sonraki keystroke'ta sunucu socket'i closed olduğunu fark eder. Gerçek "stuck" durum yok.

**Önlem:** WS handler `finally` bloğu try/except wrap'li; close exception'ı log'a yazılır ama swallow edilir. `terminate_task` cancel'lanır.

### 10.5 Yetkisiz kullanıcı

§6 RBAC gate `403`. Audit yazılmaz (permission denial audit ayrı pattern; istenirse `audit.action='terminal_sessions.terminate_denied'` separate olarak şimdilik scope dışı).

### 10.6 Çoklu tab / aynı session edge-case

**Senaryo A:** Aynı kullanıcı 2 sekme açık, her ikisi de aynı device'a — bu **iki ayrı session_id** üretir (her WS bağlantısı kendi `uuid.uuid4().hex`'ini alır). Bir tab'ı terminate etmek diğerini etkilemez. UI listesinde iki ayrı satır.

**Senaryo B:** Operatör list'i refresh etmiş ama satır eski; terminate'e tıklar; aslında session **az önce** user_closed olmuş. Endpoint `410 Gone` döner; frontend toast "Bu oturum zaten kapanmış" + refresh.

**Senaryo C:** İki operatör aynı session'a aynı anda terminate basar. Pub/sub publish 2 mesaj atar (her ikisi DB UPDATE atar, WHERE ended_at IS NULL guard ile birincisi başarılı, ikincisi no-op → `rowcount=0`). Endpoint kodu bunu `409 Conflict` veya `410 Gone` olarak handle eder:

```python
result = await db.execute(update(...))
if result.rowcount == 0:
    raise HTTPException(410, "Bu oturum az önce kapatıldı (race)")
```

İki audit log entry **yazılır**? Hayır — sadece birinci başarılı transaction `db.add(audit)` yapar; ikinci başarısız UPDATE'ten önce 410 atılır. Net audit: 1 entry.

**Senaryo D:** Aynı kullanıcı 1 sekmede SSH'a bağlı, sonra kendi tarayıcı sekmesini kapatır + aynı anda admin terminate'i atar. İkisi race. Pub/sub publish, sonra DB UPDATE; ama WS handler user_closed yolundan close()'a düşmüştü. Logger `close(exit_reason="user_closed")` çağrıldı, endpoint UPDATE'i `WHERE ended_at IS NULL` no-op. Audit yazıldı mı? **Hayır** — endpoint sırası:

```python
1. SELECT row → ended_at hala NULL (race window)
2. publish (no-op, handler zaten kapanmış)
3. UPDATE WHERE ended_at IS NULL → rowcount=0
4. result.rowcount == 0 → 410 raise
5. audit add ÖNCESİNDE exception
```

Audit yazılmaz. Bu doğru davranış: gerçek kapatma user_closed'di, force_closed değil.

### 10.7 Pub/sub Redis erişim hatası

Redis down → publish exception. Kritik **soru:** continue with DB UPDATE veya abort?

**Karar:** Continue. Sebep: WS handler kendisi 30sn revalidate / TCP keep-alive ile kapanacak; DB state "force_closed" zaten gerçeği yansıtacak. Operatör için "yarı-açık görünüyor" durumu en fazla 30sn sürecek.

```python
try:
    await r.publish("terminal:terminate", payload)
except Exception as exc:
    log.warning("terminal:terminate publish hata (continuing): %r", exc)
    # DB UPDATE + audit ile devam et; WS revalidate çözecek.
```

### 10.8 DB UPDATE hatası

Connection lost / RLS reject / vb. → 500. Audit yazılmaz (transaction rollback). WS handler kendi flow'unda kalır.
**Davranış:** Frontend toast "Sonlandırma başarısız: <error>" + retry seçeneği.

### 10.9 Audit insert hatası (DB UPDATE başarılı sonrası)

`UPDATE` başarılı, `db.add(audit)` insert sırasında IntegrityError (örn. RLS).
**Davranış:** Aynı transaction içinde `audit.add` + `db.commit()`. Commit fail → tüm transaction rollback, UPDATE de geri alınır. 500 döner.

**Kontrol:** `await db.commit()` exception'ı catch et:
```python
try:
    await db.commit()
except IntegrityError as exc:
    await db.rollback()
    log.error("terminate commit hata: %r", exc)
    raise HTTPException(500, detail="DB commit hatası")
```

---

## 11. Frontend Etkisi

### 11.1 TerminalSessions ekranı

`frontend/src/pages/TerminalSessions/index.tsx` (mevcut, W1-F TerminalSessions sprint'inde i18n alınacak).

Mevcut list ekranı satır aksiyon kolonuna **"Sonlandır"** butonu eklenir:

```tsx
{record.status === 'active' && canTerminate && (
  <Popconfirm
    title={t('terminal_sessions.terminate.confirm_title')}
    description={t('terminal_sessions.terminate.confirm_desc', {
      username: record.username,
      device: record.device_hostname,
    })}
    okText={t('terminal_sessions.terminate.confirm_ok')}
    cancelText={t('common.cancel')}
    okButtonProps={{ danger: true, loading: terminateMut.isPending }}
    onConfirm={() => terminateMut.mutate({ session_id: record.session_id })}
  >
    <Button danger size="small" icon={<StopOutlined />}>
      {t('terminal_sessions.terminate.btn')}
    </Button>
  </Popconfirm>
)}
```

`canTerminate` = `useAuthStore(s => s.has_permission('terminal_sessions:terminate'))`.

### 11.2 Mutation + cache invalidation (NO optimistic UI)

```ts
const terminateMut = useMutation({
  mutationFn: ({ session_id, reason }: { session_id: string; reason?: string }) =>
    terminalSessionsApi.terminate(session_id, reason),
  onSuccess: (res) => {
    notification.success({
      message: t('terminal_sessions.terminate.toast.success_title'),
      description: t('terminal_sessions.terminate.toast.success_desc', {
        duration: res.duration_seconds,
      }),
    })
    qc.invalidateQueries({ queryKey: ['terminal-sessions'] })
    qc.invalidateQueries({ queryKey: ['terminal-sessions', '_stats'] })
  },
  onError: (e: any) => {
    if (e?.response?.status === 410) {
      notification.warning({
        message: t('terminal_sessions.terminate.toast.already_closed'),
      })
      qc.invalidateQueries({ queryKey: ['terminal-sessions'] })
    } else {
      notification.error({
        message: t('terminal_sessions.terminate.toast.failed'),
        description: e?.response?.data?.detail || e.message,
      })
    }
  },
})
```

**Optimistic UI yok.** Sebep: kullanıcı "bekliyorum" mesajı görsün; backend kesin sonuç dönmeden listenin "closed" gösterip sonra geri "active"a dönmesini önlüyoruz (rollback kötü UX). Mutation tamamlandıktan sonra invalidate → fresh list.

### 11.3 Status pill genişletmesi

Mevcut `STATUS_MAP` (eğer varsa, KURAL-E1 useMemo) yeni anahtar ekle:

```tsx
const STATUS_LABEL = useMemo(() => ({
  active: t('terminal_sessions.status.active'),
  closed: t('terminal_sessions.status.closed'),
  stale: t('terminal_sessions.status.stale'),
  force_closed: t('terminal_sessions.status.force_closed'),  // YENI
}), [t])

const STATUS_CLS = {  // module-level (CSS class değişmez)
  active: 'nm-pill ok',
  closed: 'nm-pill',
  stale: 'nm-pill warn',
  force_closed: 'nm-pill crit',  // YENI — kırmızı vurgu
}
```

### 11.4 i18n key'leri (W1-F TerminalSessions sprintinde 4 dilde)

```
terminal_sessions.terminate.btn                   "Sonlandır" / "Terminate" / "Beenden" / "Завершить"
terminal_sessions.terminate.confirm_title         "Bu SSH oturumunu sonlandır?"
terminal_sessions.terminate.confirm_desc          "{{username}} kullanıcısının {{device}} cihazına bağlantısı kesilecek. Bu işlem audit log'a yazılır."
terminal_sessions.terminate.confirm_ok            "Sonlandır"
terminal_sessions.terminate.toast.success_title   "Oturum sonlandırıldı"
terminal_sessions.terminate.toast.success_desc    "{{duration}}sn sürmüş oturum kapatıldı."
terminal_sessions.terminate.toast.already_closed  "Bu oturum zaten kapatılmış"
terminal_sessions.terminate.toast.failed          "Sonlandırma başarısız"
terminal_sessions.status.active                   "Aktif"
terminal_sessions.status.closed                   "Kapandı"
terminal_sessions.status.stale                    "Otomatik kapatıldı"
terminal_sessions.status.force_closed             "Yönetici tarafından sonlandırıldı"
```

### 11.5 Aktif kullanıcı bilgilendirme (xterm-side)

Eğer kullanıcı aynı anda terminal ekranında aktifse, SSH WS final mesajı görür:

```
═══════════════════════════════════════════
  This terminal session was terminated by
  an administrator.
═══════════════════════════════════════════
```

xterm bileşeni 4000 close kodu görürse ek "info banner" basabilir (frontend `SshTerminal.tsx` zaten WS close handler içeriyor — kod 4000 case'i eklenir).

---

## 12. Test Stratejisi

### 12.1 Backend tests (`backend/app/tests/test_terminal_session_terminate.py`, yeni dosya)

| Test | Önkoşul | Beklenen |
|---|---|---|
| `test_terminate_happy_path` | active session DB'de; org_admin user | 200, DB exit_reason='force_closed', audit_log entry |
| `test_terminate_already_closed` | session ended_at NOT NULL | 410 + ended_at/exit_reason in body; audit YOK |
| `test_terminate_not_found` | session_id bilinmeyen | 404; audit YOK |
| `test_terminate_rbac_viewer` | viewer user, active session | 403; audit YOK |
| `test_terminate_rbac_member` | member user | 403 |
| `test_terminate_rbac_location_admin_own` | loc_admin, kendi loc'undaki session | 200 + audit |
| `test_terminate_rbac_location_admin_cross` | loc_admin, başka loc'taki session | 404 (RLS) |
| `test_terminate_super_admin_cross_org` | super_admin, başka org session | 200 + audit (audit.organization_id = session's org) |
| `test_terminate_pubsub_publish_called` | redis mock | publish args: channel=terminal:terminate, payload contains session_id |
| `test_terminate_pubsub_failure_continues` | redis raise → publish fail | endpoint hala 200, DB UPDATE + audit yazılır |
| `test_terminate_race_concurrent` | 2 concurrent terminate request | birincisi 200, ikincisi 410 |
| `test_audit_details_complete` | terminate çağrısı | audit.details all required fields (session_id, device_id, target_ip, terminated_by_*, started_at, terminated_at, duration_seconds) |
| `test_audit_before_after_state` | terminate çağrısı | before_state={ended_at:null,...}, after_state={ended_at:<iso>,exit_reason:force_closed} |
| `test_status_field_in_list` | active + force_closed mix | GET /terminal-sessions list response her satırda "status" alanı doğru |

**Mock'lar:**
- `aioredis.publish` mock (pub/sub side effect izole).
- WS handler **test edilmez** (integration scope; ayrı E2E).

### 12.2 WS integration test (`backend/app/tests/test_ssh_ws_terminate.py`)

Mevcut WS test paterni yoksa **opsiyonel**; FastAPI TestClient WebSocket support kısıtlı.

| Test | Önkoşul | Beklenen |
|---|---|---|
| `test_ws_receives_terminate_signal` | WS bağlı + pub/sub publish | WS handler terminate_event set olur, close code=4000 |
| `test_ws_close_idempotent_with_endpoint` | WS user_closed + paralel endpoint terminate | Logger close once; endpoint DB UPDATE no-op; 410 döner |

### 12.3 Frontend tests

`frontend/src/pages/TerminalSessions/__tests__/Terminate.test.tsx` (yeni):

| Test | Beklenen |
|---|---|
| Active session row + canTerminate=true → button render | OK |
| Active session row + canTerminate=false → button gizli | OK |
| Click → Popconfirm açılır | OK |
| Confirm → API çağrı yapılır + invalidateQueries | OK |
| 410 response → warning toast + invalidate | OK |
| 500 response → error toast | OK |

E2E (Playwright): scope dışı; manuel smoke kapsar.

### 12.4 Manual smoke checklist

Deploy sonrası operatör test scenario'ları:

1. ✅ Org admin SSH'a bağlanır (sekme A) → ikinci sekme (B) org_admin TerminalSessions açar.
2. ✅ Sekme B'de aktif session listesinde sekme A görünür → "Sonlandır" tıkla → Popconfirm onayla.
3. ✅ Sekme A xterm'inde "terminated by an administrator" mesajı gör, socket kapanır.
4. ✅ Sekme B listesi refresh: session "force_closed" + kırmızı pill.
5. ✅ Audit Log ekranı (`/audit`) yeni entry: action="Terminal Session Force-Closed", username=operatör, details görünür.
6. ✅ Tekrar "Sonlandır" tıklamaya çalış (cached list satırı) → toast "Bu oturum zaten kapatılmış".
7. ✅ Viewer rolüyle login → TerminalSessions ekranında "Sonlandır" butonu **görünmemeli**.
8. ✅ Location admin: yalnız kendi lokasyonundaki session'lar görünür ve sonlandırılabilir; başka lokasyon görünmez.
9. ✅ Super admin cross-org session sonlandırır → diğer org'un audit log'unda kayıt görülür.

---

## 13. Deploy / Rollback Planı

### 13.1 Tek paket merge stratejisi

Bu özellik **tek PR** olarak teslim edilir:

| Commit | Kapsam |
|---|---|
| 1 | `backend/app/models/user.py` — `SYSTEM_ROLE_PERMISSIONS` ek (org_admin + location_admin için `terminal_sessions:terminate`) |
| 2 | `backend/app/models/shared/permission_set.py` — `DEFAULT_PERMISSIONS.modules.terminal_sessions` ek |
| 3 | `backend/app/api/v1/endpoints/terminal_sessions.py` — `POST /{session_id}/terminate` endpoint |
| 4 | `backend/app/api/v1/endpoints/ws.py` — terminate_listener task ve close path |
| 5 | `backend/app/schemas/terminal_session.py` — TerminateSessionRequest/Response (yeni veya mevcut dosyaya) |
| 6 | `backend/app/tests/test_terminal_session_terminate.py` — backend test suite |
| 7 | `frontend/src/api/terminalSessions.ts` — `terminate(session_id, reason)` method |
| 8 | `frontend/src/pages/TerminalSessions/index.tsx` — buton + Popconfirm + mutation (i18n key'leri ile birlikte) |
| 9 | `frontend/src/i18n/locales/{tr,en,de,ru}.json` — terminal_sessions.terminate.* anahtarlar (W1-F sırasında birlikte alınmış varsayımı) |

### 13.2 DB migration

**YOK.** Mevcut `exit_reason` String(32) yeterli. AuditLog tablosu zaten mevcut. Alembic head **değişmez**.

### 13.3 Deploy stratejisi

| Servis | Aksiyon |
|---|---|
| Frontend container | Rebuild + recreate (`--no-deps`) |
| Backend container | Rebuild + recreate (`--no-deps`) — **YENI endpoint için zorunlu** |
| Postgres / Redis / Celery / Nginx | Dokunulmaz |

Bu özellik backend kod değişikliği içerir → W1 frontend-only paterni **kullanılamaz**. **Backend deploy + frontend deploy birlikte** gerekir.

### 13.4 Smoke gate

| Test | Komut / yöntem |
|---|---|
| Endpoint live | `curl -X POST https://<prod>/api/v1/terminal-sessions/test/terminate` → 401 (token yok) — endpoint erişilebilir doğrulaması |
| Permission verb | `gh terminal_sessions:terminate` org_admin permission_set'inde görünür |
| WS handler subscribe | Bir test session aç → admin sekmesinde terminate at → WS <2sn close |
| Audit log entry | `/audit` ekranı yeni entry'yi gösterir |
| Existing flows unaffected | Mevcut user_closed akışı normal (sekme kapat → exit_reason='user_closed') |
| Stale cleanup unaffected | Hourly beat task yine `exit_reason='stale_cleanup'` ile yarı-açık satırları temizler |

### 13.5 Rollback prosedürü

**Senaryo A — WS handler bug, mevcut session'lar yarı-açık kalıyor:**

```bash
# Pre-deploy backend image tag'i restore et
docker tag netmanager-backend:rollback-pre-ssh-terminate netmanager-backend:latest
docker compose up -d --no-deps backend
git revert <merge-sha>  # endpoint + WS değişikliği geri
```

Süre: ~60-90sn. Existing sessions: pub/sub mesajları dinlenmez, ama mevcut user_closed + stale_cleanup yolları aynı çalışır.

**Senaryo B — RBAC yanlış, viewer terminate edebiliyor:**

Acil: `terminal_sessions:terminate` verb'ünü SYSTEM_ROLE_PERMISSIONS map'inde sadece super_admin'e bırak (hot patch):

```python
# Hot patch
SYSTEM_ROLE_PERMISSIONS[SystemRole.ORG_ADMIN].remove("terminal_sessions:terminate")
SYSTEM_ROLE_PERMISSIONS[SystemRole.LOCATION_ADMIN].remove("terminal_sessions:terminate")
```

Restart backend (--no-deps). Bu permission'a sahip kullanıcılar 403 alır.

**Senaryo C — Audit log'da PII expose:**

Audit log details'tan command/output excerpt çıkarılmıyor (TerminalSessionLog ayrı tabloda, RLS-forced). Bu senaryo düşük olasılık; yine de details JSON şemasını review edip gerekirse alanları redact.

### 13.6 Backwards compatibility

**Frontend eski sürüm + Backend yeni:** Frontend "Sonlandır" butonu yok, kullanıcı yeni endpoint'i çağırmaz. Davranış: hiç yeni özellik yok → no break.

**Frontend yeni + Backend eski:** Buton görünür, kullanıcı tıklar → 404 endpoint not found → error toast. **Beklenmeyen**: deploy sıralaması "backend önce" olmalı (rolling deploy patten).

**Deploy sırası:** backend (endpoint) → frontend (button). Aynı PR'da tek commit zinciri ise rolling deploy: backend container restart (5sn kesinti — `device:connect` action'a yeni endpoint live) → frontend container restart.

### 13.7 Observability

| Metrik | Nereden |
|---|---|
| `terminal_sessions_terminate_total{result=success\|failure}` | Prometheus counter (eğer mevcut altyapı varsa) |
| `terminal_sessions_terminate_duration_seconds` | Endpoint latency histogram |
| Audit log entry sayısı | `audit_logs` tablo `WHERE action='terminal_sessions.terminate'` |
| WS close code=4000 sayısı | Frontend Sentry breadcrumb (opsiyonel) |

**Alert:** `terminate_total{result=failure}` 5dk'da > 5 → operatör interventions sorunu var (DB / Redis / permission misconfig). PagerDuty düşük öncelik.

---

## Açık Sorular / Karar Bekleyenler

1. **Reason gerçekten opsiyonel mi olsun?** Audit ve forensics kalitesi için zorunlu yapılabilir. Karar: opsiyonel — operatör yangın durumunda hızlı kapatma yapsın; reason boşsa default `force_terminated_by_admin` kullanılır. (Frontend Popconfirm'de boş bırakılabilir.)

2. **Bulk terminate?** Çoklu seçim → toplu sonlandır (örn. 10 session). Scope dışı — gerekirse Phase 2 olarak `POST /terminal-sessions/bulk-terminate` ayrı tasarım.

3. **Terminated user'a notification?** Sonlandırılan kullanıcının sonraki login'inde "Son SSH oturumunuz yönetici tarafından kapatıldı (zaman: X, neden: Y)" uyarısı? **Scope dışı**, ileride değerlendir.

4. **Reason için preset dropdown?** Frontend'de "Suspended user / Suspicious activity / Compliance / Other" gibi preset chip'ler? **Scope dışı**, ilk sürüm free-text input ile başlasın.

5. **Self-terminate?** Kullanıcı kendi açık oturumunu UI'dan terminate edebilir mi (`terminal_sessions:terminate_own` ayrı verb)? **Scope dışı**, mevcut tarayıcı sekmesi kapatma yeterli.

---

## Sonraki Adım

Bu doküman onaylandıktan sonra:

1. **W1-F TerminalSessions i18n sprint'i tamamlanır** (öncelik 1 — sıralamayı `project_lang_fix_w1f_roadmap.md` memory belirlemişti).
2. **SSH Session Termination implementation** başlatılır:
   - Branch: `t10/ssh-session-termination` (W1-F TerminalSessions merge sonrası)
   - 9 commit zinciri (§13.1)
   - Backend + frontend tek PR
   - Tasarımda **DEĞİŞİKLİK GEREKİRSE** doküman güncellenir ve **tekrar onay alınır**.

Doküman onayını bekliyor.
