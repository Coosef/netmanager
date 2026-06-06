# SSH Session Termination — Implementation Sprint Plan

**Tarih:** 2026-06-07
**Baseline:** `docs/SSH_SESSION_TERMINATION_DESIGN.md` (PR #7 — design doc, 1077 satır)
**Onay gerekli:** Bu plan onaylanmadan kod yazılmaz, endpoint impl başlatılmaz, frontend buton eklenmez.

Tasarım dokümanı (PR #7) **mimari WHY**; bu plan **kod WHERE/HOW + sprint ROADMAP**.

---

## 1. Mevcut Terminal Session backend akış analizi

### 1.1 Aktör + dosya envanteri

| Bileşen | Dosya | LOC | Açıklama |
|---|---|---:|---|
| WebSocket entry point | `backend/app/api/v1/endpoints/ws.py:336-665` | ~330 | `@router.websocket("/ssh/{device_id}")` — interaktif SSH terminal WS |
| Session audit logger | `backend/app/services/terminal_session_logger.py` | 290 | TerminalSessionLog tablo yazımı (per-WS) |
| Agent shell relay | `backend/app/services/agent_manager.py:1605-1719` | ~115 | `open_shell_session`/`close_shell_session`/`send_shell_input`/`send_shell_resize` |
| Stale cleanup task | `backend/app/workers/tasks/terminal_session_tasks.py` | 90 | Hourly Celery beat (30dk eşiği) |
| List/detail/stats/summarize endpoints | `backend/app/api/v1/endpoints/terminal_sessions.py` | 252 | Mevcut read-only API (router prefix `/terminal-sessions`) |
| Storage model | `backend/app/models/terminal_session_log.py` | 52 | TerminalSessionLog tablosu |
| FE TerminalSessions ekranı | `frontend/src/pages/TerminalSessions/index.tsx` | 470 | W1-F1 ile i18n hazır — `terminal_sessions.*` namespace mevcut |

### 1.2 WS handler iki yollu akış

```
Browser → /api/v1/ws/ssh/{device_id}?token=...&location=...&cols=...&rows=...
   │
   ├─ Auth + WsScope.resolve() (token + location)
   ├─ RBAC gate: scope.has_permission("device:connect")  (line 371-373)
   ├─ Device RLS lookup (org+loc scope)
   ├─ TerminalSessionLogger.create() → TerminalSessionLog INSERT
   │       session_id = uuid.hex (logger tarafında üretilir)
   │       ai_summary_status='pending', ended_at=NULL
   │
   ├─ use_agent = device.agent_id && agent_manager.is_online(agent_id)
   │
   ├─ ─── Path A: AGENT RELAY ───────────────────────
   │     ├─ session_id_agent = agent_manager.open_shell_session()  # **YENI UUID**
   │     │     (agent_manager._shell_sessions[session_id_agent] kayıt)
   │     ├─ closed_evt = asyncio.Event()
   │     ├─ on_output / on_close callback'leri
   │     ├─ WS read/write loop (line 448-541)
   │     └─ finally: agent_manager.close_shell_session(session_id_agent)
   │                 + _term_logger.close(exit_reason="user_closed")
   │
   ├─ ─── Path B: DIRECT PARAMIKO ──────────────────
   │     ├─ paramiko.SSHClient + invoke_shell (line 547-588)
   │     ├─ stop_event = asyncio.Event()
   │     ├─ read_from_ssh + read_from_ws task'leri
   │     └─ finally: channel.close() + ssh_client.close()
   │                 + _term_logger.close(exit_reason="user_closed")
   │
   └─ revalidator task (Faz 8 Phase E — 30sn scope re-check)
```

### 1.3 **KRİTİK BULGU — Session ID mismatch**

Mevcut yapıda **iki ayrı UUID** üretiliyor:

| Üretim noktası | Field | Kullanım |
|---|---|---|
| `TerminalSessionLogger.create()` line 116 | `_term_logger.session_id` (audit DB key) | List/detail endpoints, frontend görüntüleme |
| `agent_manager.open_shell_session()` line 1625 | `session_id_agent` (registry key) | Agent WS sinyali (close, input, resize) |

**Etki:** Terminate endpoint `_term_logger.session_id`'yi alır (URL parametresi). Agent relay yolunda agent registry'sinde **başka** bir UUID var. Bunları **birleştirmek** veya **mapping** tutmak gerekiyor.

**Çözüm (önerilen):** Single-source-of-truth — `TerminalSessionLogger.create()` `session_id`'yi `open_shell_session()` çağrısına override olarak geçir. Mevcut signature destekliyor: `open_shell_session(*, override_session_id=None)` parametresi eklenir veya logger UUID'si agent registry key olur. **(Tek satır refactor.)**

### 1.4 stale_cleanup ile çakışma riski

Hourly Celery beat:
```python
# terminal_session_tasks.cleanup_stale_sessions:
threshold = now - 30min  # configurable system_settings
# WHERE ended_at IS NULL AND started_at < threshold
# UPDATE SET ended_at=now, exit_reason='stale_cleanup'
```

**Çakışma senaryosu:** Admin terminate eder (`exit_reason='force_closed'`); aynı saatte stale_cleanup beat çalışır.
- Race: Force-close UPDATE'i yapıldı (`ended_at NOT NULL`); stale_cleanup WHERE filter'ı (`ended_at IS NULL`) hiç eşleşmez → no-op. ✅ İzole.

**Aksine:** Stale_cleanup önce çalıştı → `exit_reason='stale_cleanup'`. Sonra admin terminate denerse → 410 (zaten kapalı). ✅ İzole.

**Sonuç:** Stale_cleanup ile force_closed mekanizması ortogonal; race koşulu DB UPDATE seviyesinde çözülür. Ek koordinasyon gerekmez.

---

## 2. Redis pub/sub entegrasyon noktaları

### 2.1 Mevcut Redis altyapısı

`backend/app/core/redis_client.py` — single global `aioredis.Redis` instance, exponential backoff retry, socket keepalive 60s/10s/3 retry, health_check 30s. Helper `publish(channel, message)` (JSON serialize) zaten mevcut.

**Mevcut pub/sub kullanıcıları:**
- `app/core/event_publish.py:102` — event broadcast (`channel:org:N`)
- `app/api/v1/endpoints/agent_stream.py:29` — `cmd_stream:{request_id}` (per-request command stream)
- `app/api/v1/endpoints/ws.py:225,261,307` — task/anomaly/event WS subscribers

**Patern net:** Subscriber-side `r.pubsub() + await pubsub.subscribe(channel) + async for msg in pubsub.listen()`. Bu patern SSH WS terminate listener için 1:1 uygulanır.

### 2.2 Yeni kanal: `terminal:terminate`

**Publisher (HTTP endpoint):**
```python
# backend/app/api/v1/endpoints/terminal_sessions.py — yeni terminate handler
from app.core.redis_client import publish
await publish("terminal:terminate", {
    "session_id": session_id,
    "reason": body.reason or "force_terminated_by_admin",
    "terminated_by_user_id": current_user.id,
    "terminated_by_username": current_user.username,
    "at": datetime.now(timezone.utc).isoformat(),
})
```

**Subscriber (WS handler):**
```python
# backend/app/api/v1/endpoints/ws.py — ssh_terminal_ws içine ek task
terminate_event = asyncio.Event()
terminate_task = asyncio.create_task(_terminate_listener(
    _term_logger.session_id, websocket, terminate_event,
))

async def _terminate_listener(my_session_id, websocket, evt):
    r = get_redis()
    pubsub = r.pubsub()
    await pubsub.subscribe("terminal:terminate")
    try:
        async for msg in pubsub.listen():
            if msg["type"] != "message": continue
            try:
                payload = json.loads(msg["data"])
            except Exception:
                continue
            if payload.get("session_id") == my_session_id:
                evt.set()
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
                return
    finally:
        try: await pubsub.unsubscribe("terminal:terminate")
        except Exception: pass
```

### 2.3 Latency profili

| Adım | Tahmini |
|---|---:|
| Publisher → Redis | <50ms (Redis socket keepalive) |
| Redis → subscriber broadcast | <100ms (`pubsub.listen()` event loop tetikler) |
| Subscriber → stop_event.set() + WS close | <100ms |
| **Total round-trip** | **<300ms** (tasarım hedefi <2sn) |

### 2.4 Multi-worker güvenlik

Production ASGI worker count > 1. Pub/sub doğal olarak **broadcast** — tüm worker'lar mesajı alır. Yalnız `payload.session_id == my_session_id` koşuluyla **doğru worker** filtreler. ✅ Multi-worker safe.

### 2.5 Fallback (Redis down)

Tasarım dokümanında §10.7 belirtildi: pub/sub publish exception → log warning + DB UPDATE devam et. WS handler 30sn revalidate ile kendisini kapatacak. Implementation aynı şekilde:

```python
try:
    await publish("terminal:terminate", payload)
except Exception as exc:
    log.warning("terminal:terminate publish hata (continuing): %r", exc)
    # DB UPDATE + audit ile devam et
```

---

## 3. WebSocket registry yapısı

### 3.1 Mevcut durum: REGISTRY YOK

WS handler her bağlantı için kendi local değişkenlerini tutar (stop_event, closed_evt, revalidator, _term_logger). Multi-worker arası **shared registry yok**.

### 3.2 Tasarım kararı: Redis pub/sub = de-facto distributed registry

Tasarım dokümanında § 8.1 değerlendirildi:
- **In-process registry** ❌ (multi-worker yetersiz)
- **DB polling** ⚠️ (yavaş, N saniye latency)
- **Redis SET + TTL polling** ⚠️ (polling overhead)
- **Redis pub/sub** ✅ (push-based, multi-worker safe, low-latency)

**Karar:** Ayrı registry yapısı **kurulmuyor**. Her WS handler kendi listener task'ını subscribe eder, kendi `session_id` ile filtreler. Pub/sub "broadcast + filter" deseni distributed registry'yi simüle eder.

### 3.3 AgentManager._shell_sessions zaten lokal registry

Agent relay yolunda `agent_manager._shell_sessions[session_id_agent]` zaten in-process dict. Force-close akışında `close_shell_session(session_id_agent)` çağrılır → agent'a `ssh_shell_close` mesajı gönderilir → agent kendi tarafında SSH transport'u keser.

**Önemli:** session_id_agent ≠ _term_logger.session_id (§1.3 mismatch). Terminate akışında **logger session_id**'yi alıp agent registry'sinde lookup gerekiyor. **Refactor önerisi (P1 commit'inde):** `_term_logger.session_id` = `session_id_agent` (override).

### 3.4 Direct paramiko yolu

Bu yolda agent registry yok; sadece local `channel` + `ssh_client` + `stop_event`. Pub/sub listener `stop_event.set()` + WS close yapar → finally bloğunda `channel.close()` + `ssh_client.close()` zaten çalışır. Ek refactor gerekmez.

---

## 4. RBAC entegrasyon planı

### 4.1 Mevcut verb yapısı

`backend/app/models/user.py:31-68` — `SYSTEM_ROLE_PERMISSIONS: dict[str, list[str]]`:
- `SUPER_ADMIN`: `["*"]` (wildcard)
- `ORG_ADMIN`: 18 verb (`device:view`, `device:edit`, ..., `audit:view`, `monitor:view`, ...)
- `LOCATION_ADMIN`: 11 verb (org_admin'in alt-küme)
- `VIEWER`: 4 verb (minimal)
- `MEMBER`: 4 verb

`has_permission(self, permission: str) -> bool` — wildcard veya exact match.

### 4.2 Yeni verb: `terminal_sessions:terminate`

**Add to maps:**
```python
SYSTEM_ROLE_PERMISSIONS = {
    SystemRole.SUPER_ADMIN: ["*"],  # zaten cover
    SystemRole.ORG_ADMIN: [
        ...,
        "terminal_sessions:terminate",  # YENI
    ],
    SystemRole.LOCATION_ADMIN: [
        ...,
        "terminal_sessions:terminate",  # YENI
    ],
    # VIEWER + MEMBER — vermez
}
```

### 4.3 Permission set modüler yapı

`backend/app/models/shared/permission_set.py:9-28` — `DEFAULT_PERMISSIONS.modules`:

```python
"modules": {
    ...
    "terminal_sessions": {       # YENI MODÜL
        "view":      False,      # liste/detay görme (geri-uyumluluk için flagged)
        "terminate": False,      # yeni terminate verb
    },
}
```

> **Geri uyumluluk:** Mevcut permission_set kayıtlarında `terminal_sessions` modülü olmayacak — `has_permission()` default `False` döner (deny-by-default). org_admin'ler için bootstrap migration veya runtime `SYSTEM_ROLE_PERMISSIONS` defaultu yeterli (frontend permission_set ekranı W2 / W3 işi).

### 4.4 Endpoint gate

```python
@router.post("/{session_id}/terminate")
async def terminate_session(
    session_id: str,
    body: TerminateSessionRequest | None = None,
    request: Request = ...,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not current_user.has_permission("terminal_sessions:terminate"):
        raise HTTPException(403, detail="terminal_sessions:terminate izni yok")
    ...
```

### 4.5 Scope (RLS) koruması

`TerminalSessionLog` modeli `organization_id NOT NULL`. Mevcut list/detail endpoint'leri RLS otomatik filtreliyor (`db_session` Faz 7 org context'iyle). `terminate_session` aynı `db` session'ı kullanır → session başka org'da ise `SELECT ... WHERE session_id=X` `NULL` döner → `404` raise.

**Cross-org terminate (super_admin only):** super_admin'in `*` permission'ı geçirir; ayrıca `superadmin_context()` ile RLS bypass'i mevcut. Endpoint'te super_admin için RLS bypass akışı eklenir:

```python
from app.core.org_context import superadmin_context

if current_user.system_role == "super_admin":
    with superadmin_context():
        row = (await db.execute(select(TerminalSessionLog).where(...))).scalar_one_or_none()
else:
    row = (await db.execute(select(TerminalSessionLog).where(...))).scalar_one_or_none()  # RLS auto
```

---

## 5. Audit log entegrasyon planı

### 5.1 Mevcut audit helper

`backend/app/services/audit_service.py:20-130` — `log_action(db, user, action, resource_type=, resource_id=, resource_name=, details=, status=, request=, before_state=, after_state=, duration_ms=)`.

- Org stamping: `organization_id = user.organization_id if user else None` (terminator's org)
- Raw `text(INSERT)` — `RETURNING` ile RLS çakışma sorunu çözülmüş
- Fire-and-forget pattern (commit yapılır, exception swallow edilmez ama detayda hata audit'i bozmaz)

### 5.2 Cross-org sorunu

Tasarım §7.4 belirtti: **Super admin başka org'un session'ını sonlandırırsa**, audit row session'ın org'unda olsun (post-mortem zinciri için).

Mevcut `log_action()` `user.organization_id`'yi alır. Süper admin için: `user.organization_id` NULL veya kendi org'u. **Çözüm:** `log_action()`'a `organization_id_override: Optional[int] = None` parametresi ekle (backward-compatible, eski çağrılar etkilenmez).

### 5.3 Terminate aksiyonu için çağrı

```python
await audit_service.log_action(
    db,
    user=current_user,
    action="terminal_sessions.terminate",
    resource_type="terminal_session",
    resource_id=session_id,
    resource_name=device.hostname if device else None,
    details={
        "device_id": row.device_id,
        "device_name": device.hostname if device else None,
        "target_ip": device.ip_address if device else None,
        "session_user_id": row.user_id,
        "session_username": session_user.username if session_user else None,
        "terminated_by_user_id": current_user.id,
        "terminated_by_username": current_user.username,
        "termination_reason": (body.reason if body else None) or "force_terminated_by_admin",
        "started_at": row.started_at.isoformat(),
        "terminated_at": ended_at.isoformat(),
        "duration_seconds": duration_ms // 1000,
        "agent_id": row.agent_id,
        "connection_path": row.connection_path,
        "commands_count_at_terminate": row.commands_count or 0,
        "input_bytes_at_terminate": row.input_bytes or 0,
        "output_bytes_at_terminate": row.output_bytes or 0,
    },
    before_state={"ended_at": None, "exit_reason": None, "status": "active"},
    after_state={
        "ended_at": ended_at.isoformat(),
        "exit_reason": "force_closed",
        "duration_ms": duration_ms,
        "status": "closed",
    },
    request=request,
    organization_id_override=row.organization_id,  # YENI param — cross-org için
)
```

### 5.4 Frontend audit log UI etkisi

`docs/SSH_SESSION_TERMINATION_DESIGN.md §7.5` — `audit.action.terminal_sessions_terminate` i18n key 4 dilde eklenir (TR/EN/DE/RU). Mevcut audit log UI (W2 scope) action chip'i otomatik renderler.

---

## 6. Endpoint sözleşmesi

### 6.1 Endpoint signature

```
POST /api/v1/terminal-sessions/{session_id}/terminate
Content-Type: application/json
Authorization: Bearer <token>
X-Location-Id: <location_id>  (opsiyonel)

Body (opsiyonel):
{
  "reason": "Suspended user; investigating credential leak"   // max 256 char
}
```

### 6.2 Success response (200)

```json
{
  "session_id": "a3f8c9e21b4d",
  "status": "terminated",
  "ended_at": "2026-06-07T18:42:31.124Z",
  "duration_seconds": 1834,
  "websocket_close_pending": true,
  "audit_log_id": null
}
```

> **Not:** `audit_log_id` `audit_service.log_action()` `RETURNING` kullanmadığı için yakalanamıyor. Design dokümanındaki bu alan **`null` olarak döner** (frontend "Audit Log'da gör" link açıklaması için `details.resource_id = session_id` üzerinden bulur). Bu pratik bir scope-out: ileride `RETURNING id` eklenirse doldurulur.

### 6.3 Error responses

| Kod | Senaryo | Body |
|---|---|---|
| 400 | reason > 256 char | `{"detail": "reason çok uzun (max 256)"}` |
| 401 | Token yok / geçersiz | Default FastAPI 401 |
| 403 | `terminal_sessions:terminate` yetkisi yok | `{"detail": "terminal_sessions:terminate izni yok"}` |
| 404 | session_id DB'de yok **veya** RLS scope dışı | `{"detail": "Session bulunamadı"}` |
| 410 | Session zaten kapalı (idempotent) | `{"detail": {"code":"session_already_closed", "ended_at":"...", "exit_reason":"user_closed"}}` |
| 500 | DB UPDATE / audit commit hatası | Default FastAPI 500 |

### 6.4 Pydantic schemas

`backend/app/schemas/terminal_session.py` (yeni dosya — şu an `Schemas` ayrı dosyada değil, models'tan dict döner; bu PR'da tek dosya açılır):

```python
from typing import Literal, Optional
from datetime import datetime
from pydantic import BaseModel, Field

class TerminateSessionRequest(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=256)

class TerminateSessionResponse(BaseModel):
    session_id: str
    status: Literal["terminated"]
    ended_at: datetime
    duration_seconds: int
    websocket_close_pending: bool
    audit_log_id: Optional[int] = None
```

### 6.5 Race condition handling (concurrent terminate)

Tasarım §10.6 senaryo C:

```python
result = await db.execute(
    update(TerminalSessionLog).where(
        TerminalSessionLog.session_id == session_id,
        TerminalSessionLog.ended_at.is_(None),  # race guard
    ).values(
        ended_at=ended_at,
        exit_reason="force_closed",
        duration_ms=duration_ms,
    )
)
if result.rowcount == 0:
    # Başka biri ya da stale_cleanup race'inde önce çalıştı
    raise HTTPException(410, detail="Session az önce kapatıldı")
```

`WHERE ended_at IS NULL` race guard'ı + `rowcount == 0` kontrolü çift terminate / stale race'i izole eder. Audit log iki kez yazılmaz (rowcount=0 → exception → audit insert atlanır).

---

## 7. DB değişikliği son teyit

### 7.1 Mevcut TerminalSessionLog modeli yeterli mi?

`backend/app/models/terminal_session_log.py` alanları:
- `session_id` (PK), `user_id`, `device_id`, `agent_id`
- `organization_id`, `location_id`
- `client_ip`, `user_agent`, `connection_path`
- `started_at`, `ended_at`, `duration_ms`, `exit_reason` (**String(32)**)
- `input_bytes`, `output_bytes`, `commands_extracted`, `commands_count`, `output_excerpt`
- `ai_summary`, `ai_summary_status`

### 7.2 Yeni gerekli alanlar

**HİÇBİRİ.** Tasarım §9.4 belirtti:

| İhtiyaç | Mevcut field | Migration gerekli mi |
|---|---|---|
| `exit_reason = 'force_closed'` | `exit_reason String(32)` — constraint yok | ❌ Uygulama-seviyesi enum |
| `terminated_by_user_id` audit | `audit_logs.details.terminated_by_user_id` | ❌ Audit JSON'da |
| `termination_reason` audit | `audit_logs.details.termination_reason` | ❌ Audit JSON'da |

**TerminalSessionLog tablosu DOKUNULMAZ.**

### 7.3 audit_logs tablosu

Tasarım §7.1 — mevcut `audit_logs` tablosu (organization_id, user_id, username, action, resource_type, resource_id, resource_name, details JSON, before_state, after_state, ...) **yeterli**. Hiçbir yeni kolon gerekmiyor.

### 7.4 alembic_version

**`f9aeportpol` korunacak.** Bu sprint DB migration **YOK**. Yeni alembic revision **yazılmayacak**.

### 7.5 Olası takılabilir noktalar

| Risk | Mitigation |
|---|---|
| `exit_reason String(32)` `'force_closed'` 12 karakter — sığar | ✅ |
| `audit_logs.action` String(128) `'terminal_sessions.terminate'` 27 karakter — sığar | ✅ |
| `audit_logs.resource_type` String(64) `'terminal_session'` 16 karakter — sığar | ✅ |
| Tasarım dokümanındaki `details` JSON şeması (8 alan) PostgreSQL JSONB'de — boyut sorun yok | ✅ |

**DB değişikliği son teyidi: SIFIR migration, SIFIR yeni kolon. Mevcut schema yeterli.**

---

## Sprint Roadmap

### Commit zinciri (5 commit, atomik)

| # | Commit | Kapsam | LOC (yaklaşık) |
|---|---|---|---:|
| 1 | `refactor(backend): unify TerminalSessionLogger and agent shell session_id` | AgentManager.open_shell_session() `override_session_id` parametresi; ws.py call site önce logger oluşturup logger.session_id'yi agent'a geçirir | ~30 |
| 2 | `feat(backend): RBAC verb terminal_sessions:terminate + permission_set module` | `SYSTEM_ROLE_PERMISSIONS` org_admin/location_admin grant; `DEFAULT_PERMISSIONS.modules.terminal_sessions` | ~15 |
| 3 | `feat(backend): audit_service.log_action organization_id_override` | `log_action()` opsiyonel `organization_id_override` parametresi (backward-compatible); cross-org audit destekler | ~10 |
| 4 | `feat(backend): POST /terminal-sessions/{id}/terminate endpoint + Pydantic schemas + Redis pub/sub publish` | Endpoint implementation (validate + publish + DB UPDATE + audit insert + race guard); schemas dosyası | ~150 |
| 5 | `feat(backend): SSH WS terminate_listener task (Redis subscribe) + force_closed exit reason` | ws.py içine listener task ekle, finally bloğunda exit_reason override; 4000 close code | ~50 |
| 6 | `feat(frontend): TerminalSessions terminate button + RBAC + Popconfirm + mutation` | `TerminalSessions/index.tsx` row aksiyon kolonu; `useAuthStore.has_permission`; `apiClient.terminate(session_id, reason)`; toast | ~80 |
| 7 | `i18n(frontend): terminal_sessions.terminate.* keys (4 dil)` | `terminal_sessions.terminate.{btn, confirm_title, confirm_desc, ok, toast.{success_title, success_desc, already_closed, failed}}` + `terminal_sessions.status.force_closed` + 4 dil parity | ~40 (locale + UI test) |
| 8 | `test(backend): test_terminal_session_terminate.py — 14 backend test` | Pytest: happy path, idempotency, RBAC (viewer/member 403), RLS (cross-org 404), super_admin cross-org 200, race concurrent, audit details complete, before/after_state, status field in list | ~250 |
| 9 | (opsiyonel) `test(frontend): TerminalSessions terminate button test` | Vitest: button render with canTerminate, Popconfirm, mutation call, 410 toast, 500 toast | ~60 |

**Toplam ~685 LOC** (backend ~255 + frontend ~120 + locale ~40 + test ~270).

### Test stratejisi

**Backend (pytest):**
- `backend/app/tests/test_terminal_session_terminate.py` — 14 test (tasarım §12.1)
- `backend/app/tests/test_audit_service_org_override.py` — 3 test (`organization_id_override` parameter)
- WS integration testi (asgi TestClient WebSocket) **opsiyonel** — şu an WS suite zaten dar; manuel browser smoke yeterli

**Frontend (vitest):**
- `pages/TerminalSessions/__tests__/Terminate.test.tsx` (eğer mevcut test paterni desteklerse) — opsiyonel

**Manuel smoke (deploy sonrası):**
- 2 tarayıcı oturum, biri SSH terminal açar (operator role), diğeri TerminalSessions ekranı (org_admin)
- "Sonlandır" tıkla → Popconfirm onayla → SSH terminal "terminated by admin" mesajı + WS close kod 4000 + status "force_closed"
- Audit log ekranında `terminal_sessions.terminate` action chip + details görünür
- Tekrar terminate → 410 toast "Bu oturum zaten kapatılmış"
- viewer rolü ile login → "Sonlandır" butonu gizli

### Test pipeline (her commit veya commit zinciri sonu)

```
$ cd backend && pytest app/tests/test_terminal_session_terminate.py -v
$ cd backend && pytest app/tests/test_audit_service_org_override.py -v
$ cd frontend && ./node_modules/.bin/tsc --noEmit
$ cd frontend && ./node_modules/.bin/vitest run
$ cd frontend && ./node_modules/.bin/vite build
$ cd frontend && npm run i18n:check  (widening = 0 garanti)
```

### Branch + PR stratejisi

| Aşama | Branch | PR |
|---|---|---|
| Implementation | `t10/ssh-session-termination` | 1 PR (8-9 commit) |
| Plan onayı (sizden) | bu doküman PR'ı | Onay sonrası kod başlatılır |

### Deploy stratejisi (W1-F'den farklı!)

> ⚠️ **Backend + frontend birlikte deploy** — frontend-only paterni **uygulanamaz**.

| Servis | Aksiyon |
|---|---|
| Frontend container | Rebuild + recreate (`--no-deps`) |
| **Backend container** | **Rebuild + recreate (`--no-deps`)** — YENI endpoint için zorunlu |
| Postgres / Redis / Celery / Nginx | Dokunulmaz |

**Pre-deploy kontroller:**
- `git diff --name-only HEAD..origin/main -- 'alembic/'` → boş (zero migration assert)
- Backend image rebuild süresi ~5-10dk (vs. frontend ~4dk)
- Rollback için **iki** tag: `netmanager-frontend:rollback-pre-ssh-term-X` + `netmanager-backend:rollback-pre-ssh-term-X`

**Rolling deploy sırası:**
1. Backend önce (frontend hâlâ eski; yeni endpoint live, eski frontend'in çağıracağı yok)
2. Frontend sonra (terminate button live)

Bu sıra `frontend new + backend old` race'i önler (404 endpoint).

### Smoke gate (deploy sonrası)

- Curl: `POST /api/v1/terminal-sessions/test/terminate` → 401 (token yok) — endpoint erişilebilir doğrulaması
- Aktif SSH session aç → terminate → WS close 4000 + audit log entry
- viewer rolü ile terminate denemesi → 403
- org_admin cross-org session terminate denemesi → 404 (RLS)

---

## Risk analizi

| # | Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|---|
| 1 | **Session ID mismatch refactor** AgentManager API'sini değiştirir | DÜŞÜK | DÜŞÜK | `override_session_id=None` default — eski çağrı yerleri etkilenmez |
| 2 | `audit_service.log_action()` `organization_id_override` parametresi yeni — eski testler etkilenebilir | DÜŞÜK | DÜŞÜK | Default `None`; eski davranış (`user.organization_id`) korunur |
| 3 | Pub/sub listener task lifecycle (WS revalidator + terminate_listener + read_from_ssh + read_from_ws → 4 task) — leak riski | ORTA | DÜŞÜK | Mevcut `finally:` bloğu zaten `revalidator.cancel()` yapıyor; `terminate_task.cancel()` ekle |
| 4 | Direct paramiko + agent relay iki ayrı close path | DÜŞÜK | DÜŞÜK | Pub/sub mesajı ikisinde de aynı şekilde alınır; finally `exit_reason="force_closed" if evt.is_set() else "user_closed"` koşulu |
| 5 | Redis down → publish fail | ORTA | DÜŞÜK | Tasarım §10.7 — log warning + DB UPDATE devam et; WS 30sn revalidate ile kapanır |
| 6 | Backend image rebuild → SSH session deploy sırasında kopabilir | DÜŞÜK | ORTA | Backend recreate 5-10sn API blackout; mevcut SSH oturumları yeniden bağlanır (frontend xterm bunu zaten handle eder) |
| 7 | Cross-org audit log → super_admin'ın aksiyonu başka org'a yazılır → telemetry incelemesi karışabilir | DÜŞÜK | DÜŞÜK | Audit log `terminated_by_username` alanı user kimliğini saklar; tasarım kararı (§5.2) bilinçli |

**Toplam risk:** **DÜŞÜK-ORTA**. Refactor #1 ve audit #2 minimal genişletme; pub/sub deseni mevcut altyapıda 5 yerde kullanılıyor.

---

## Onay matrisi

| Aşama | Onay |
|---|---|
| Bu implementation plan dokümanı review + onay | ⏳ |
| Implementation başlatma GO | ⏳ (kullanıcı explicit) |
| 8-9 commit zinciri (PR oluştur) | (GO sonrası) |
| Test pipeline yeşil | (her commit sonu) |
| PR review + merge onayı | (test yeşil sonrası) |
| Backend + frontend deploy planı yaz | (merge sonrası) |
| Deploy GO | (deploy plan onayı sonrası) |
| Manuel smoke (2 tarayıcı oturum) | (deploy sonrası) |

**Plan tek başına kod yazmaz.** Kullanıcı explicit "implementation başla" demediği sürece bu doküman referans niteliğindedir.

---

## Açık karar noktaları (sizden onay bekler)

1. **Reason zorunlu mu?** Tasarım §0 — opsiyonel önerildi (default `"force_terminated_by_admin"`). Onayınızı bekler.
2. **audit_log_id response field**: `audit_service.log_action()` `RETURNING` kullanmıyor → bu PR'da `null` döner. İleride `RETURNING` eklenirse doldurulur. Kabul edilebilir mi?
3. **session_id refactor (commit 1)**: AgentManager `open_shell_session(*, override_session_id=None)` — bu refactor mevcut WS handler'ı tek satır değiştirecek; başka çağrı yeri yok. Onaylanır mı?
4. **Cross-org audit stamping**: super_admin cross-org terminate ettiğinde audit row session'ın org'unda olsun (`organization_id_override`). Onaylanır mı?
5. **WS integration test**: backend WS test paterni dar — manuel browser smoke yeterli mi yoksa ek WS test yazılsın mı?

---

## Sonraki adım

Yukarıdaki 5 karar noktasına yanıt verdikten sonra:
1. PR oluştur (`t10/ssh-session-termination`)
2. 8-9 commit zinciri (sırayla, her commit test-yeşil)
3. PR review + merge
4. Deploy plan dokümanı (backend + frontend birlikte deploy paterni)
5. Deploy GO + smoke + log doc
6. W2 sprint planlaması başlatma
