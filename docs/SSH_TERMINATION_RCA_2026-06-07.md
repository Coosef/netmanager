# SSH Session Termination — Root Cause Analysis

**Tarih:** 2026-06-07
**Deploy:** PR #16 (a60d53d) production'da 19:25 UTC
**Bulgu:** Kullanıcı testi (20:08-20:14 UTC) — terminate aksiyonu fonksiyonel olarak çalışmıyor
**Status:** ⚠️ HOTFIX gerekli; mevcut implementation bir kısmı doğru, kritik bölümler yarım kalmış

> **Hotfix yazılmadı.** Sadece kök neden + hotfix planı. Sizden onay sonrası implementation başlar.

---

## A. Kök Neden (özet)

**İki bağımsız bug üst üste binmiş durumda. Birinci bug (KESİN) terminate'in DB sonucunu siler. İkinci bug (KUVVETLE MUHTEMEL) pub/sub mesajının WS handler'ın listener task'ına ulaşmamasıyla ilgili.**

### Bug #1 — TerminalSessionLogger.close() race guard YOK (KESİN)

`backend/app/services/terminal_session_logger.py:263-276` — `close()` metodu DB UPDATE'i koşulsuz yapar:

```python
await db2.execute(
    _sa_update(TerminalSessionLog).where(
        TerminalSessionLog.session_id == self.session_id,   # ❌ ended_at koşulu YOK
    ).values(
        ended_at=ended_at,
        exit_reason=exit_reason,           # 'user_closed' YA DA 'force_closed'
        ...
    )
)
```

**Sonuç:** Admin terminate endpoint'i DB'ye `force_closed` yazar. WS hâlâ açıksa, kullanıcı terminal'i (gönüllü ya da otomatik) kapatınca WS handler'ın `finally` bloğu `_term_logger.close()` çağırır. `_terminate_evt.is_set()` False ise `exit_reason='user_closed'` yazılır → **endpoint'in yazdığı `force_closed` üzerine yazılır**.

**Production kanıt (terminal_session_logs tablosu):**

| session_id (kısa) | started | ended | endpoint yazdı | final DB |
|---|---|---|---|---|
| `97c0c5ee...` | 20:08:57 | 20:09:51 | force_closed @ 20:09:18 | **user_closed** ❌ |
| `2e00a651...` | 20:10:44 | 20:12:46 | force_closed @ 20:11:01 | **user_closed** ❌ |
| `37fa3e19...` | 20:13:00 | 20:13:58 | force_closed @ 20:13:59 | force_closed ✅ |

İlk iki vaka: WS finally tarafından override edildi (terminate ile ended arasında 30-105 saniye, kullanıcı bu sürede normal kullanıma devam ettikten sonra terminal'i kapatmış).

Üçüncü vaka: terminate (20:13:59) ZATEN ended_at (20:13:58) sonrasında geldi — endpoint UPDATE'i WHERE ended_at IS NULL'a takılmasına rağmen audit success yazıldı (race koşulu, audit hâlâ insert ediyor ama UPDATE no-op olabilirdi). Bu vaka için endpoint UPDATE'in başarısı belirsiz.

> Yorumum (ws.py:632): "_term_logger.close() race guard'lı (WHERE ended_at IS NULL) → ikinci yazım no-op olur" — **bu yorum yanlış**, race guard yok.

### Bug #2 — Pub/sub mesajı listener task'a ulaşmıyor (KUVVETLE MUHTEMEL)

**Kanıt: TerminalSessionLogger.close()'da `exit_reason='user_closed'` yazılıyor → `_terminate_evt.is_set()` False kalmış** (ws.py:634-635 koşul).

Ama bütün pub/sub altyapısı izole testlerde çalışıyor:

| Test | Yöntem | Sonuç |
|---|---|---|
| 1. `get_redis()` singleton | doğrudan instantiate | OK |
| 2. `pubsub()` instance | r.pubsub() | OK |
| 3. subscribe + publish + receive (default asyncio) | container içinde | ✅ NUMSUB=1, mesaj alındı |
| 4. `_ssh_terminate_listener` izole çalışırma (default asyncio) | container içinde | ✅ evt.set + send_text + close(4000) |
| 5. **Aynı test uvloop ile** | production policy | ✅ evt.set + send_text + close(4000) |
| 6. `publish()` helper canlı kullanım | endpoint'in çağırdığı kod | OK (audit log proof) |

**Yani altyapı + listener fonksiyonu çalışıyor, ama gerçek WS handler context'inde mesaj alınmıyor.** En olası nedenler:

1. **Listener task subscribe ediyor ama mesaj almıyor.** Listener silent except (`except Exception: return`) bir noktada exception swallow ediyor olabilir; subscribe'dan sonra hiç log yok.
2. **WS handler'ın `_terminate_task = asyncio.create_task(...)` çağrısından sonra task scheduled ediliyor ama event loop priorities yüzünden subscribe'ı tamamlayamadan başka bir await veya WS'in close olması task'ı iptal ediyor olabilir.**
3. **`pubsub.listen()` async iterator redis-py 5.2.1 + uvloop kombinasyonunda canlı SSH session sırasında bir ssub disconnect alıyor olabilir** — silent çıkar.

Production'da PUBSUB CLIENT LIST görüntülenebildiğinde, hiçbir client `sub > 0` göstermedi (test sırasında aktif session yoktu). **Listener'ın gerçekten subscribe ettiğini canlı session sırasında doğrulayamadık** — bu kritik instrumentation eksikliği.

---

## B. Hangi path çalışıyor / hangi path çalışmıyor

| Bileşen | Status | Kanıt |
|---|---|---|
| RBAC verb `terminal_sessions:terminate` | ✅ | audit log status=success, 200 dönüyor |
| Endpoint SELECT (RLS-scoped) | ✅ | row bulundu (404 değil) |
| Endpoint 410 idempotent check | ✅ | session 3 muhtemelen 410 ihtimali var |
| Endpoint UPDATE WHERE ended_at IS NULL | ✅ (kısmen) | force_closed write çalışıyor |
| Endpoint pub/sub publish | ✅ | publish() helper hata vermedi (warning log yok) |
| Endpoint audit log INSERT | ✅ | 3/3 audit row yazıldı |
| Endpoint response 200 | ✅ | http_request log status=200 |
| Frontend mutation success | ✅ | response JSON OK |
| WS Pub/sub subscribe (listener init) | ⚠️ | TEST'te çalışıyor; canlı doğrulama yok |
| WS Pub/sub receive | ❌ | `_terminate_evt` set olmuyor → user_closed yazılıyor |
| WS banner display | ❌ | kullanıcı görmedi (yoksa şikayet etmezdi) |
| WS close code 4000 | ❌ | kullanıcı yazmaya devam etti |
| Agent path `_ag.close_shell_session()` çağrısı | ❌ | endpoint'ten çağrılmıyor, sadece WS finally'sinde (yan etki olarak) |
| `TerminalSessionLogger.close()` race guard | ❌ | mevcut değil, force_closed → user_closed override |

---

## C. Session ID mismatch var mı?

**HAYIR — session_id flow doğru.** Production kodda:

```
1. _term_logger = await TerminalSessionLogger.create(...)
     → DB INSERT terminal_session_logs (session_id = UUID_A)
     → _term_logger.session_id = UUID_A

2. _terminate_task = asyncio.create_task(
       _ssh_terminate_listener(_term_logger.session_id, ...)  # listener gets UUID_A
   )

3. (agent path) session_id = await _ag.open_shell_session(
       ..., override_session_id=_term_logger.session_id    # agent gets UUID_A
   )
     → agent_manager._shell_sessions[UUID_A] = {...}

4. Frontend GET /terminal-sessions → row.session_id = UUID_A
5. Frontend POST /terminal-sessions/UUID_A/terminate
6. Endpoint publish {"session_id": "UUID_A", ...}
7. Listener compares UUID_A == UUID_A → match (eğer mesaj ulaşırsa)
```

`agent_manager.py:1605-1635` doğru `override_session_id` kullanıyor; production deployed code matches local commit.

**Session ID problemi YOK.**

---

## D. Quick Access SSH vs DeviceDetail Terminal path farkı

**FARK YOK** — ikisi de aynı backend WS endpoint'ini kullanıyor:

| Frontend giriş | Component | Backend WS path |
|---|---|---|
| Devices listesi → "Hızlı Erişim" ikonu | `pages/SshTerminalPage/index.tsx` (yeni tab) | `/api/v1/ws/ssh/{deviceId}` |
| DeviceDetail → Terminal sekmesi → "Canlı SSH" | `components/SshTerminal.tsx` (embed) | `/api/v1/ws/ssh/{deviceId}` |

Her ikisi de:
- Aynı backend handler (`ssh_terminal_ws`) çalıştırır
- Aynı `TerminalSessionLogger` instance'ı oluşturur → TerminalSessions listesinde görünür
- Aynı `_ssh_terminate_listener` task'ı oluşturur → pub/sub'a subscribe eder

**Kullanıcının raporu doğrulanır:** her ikisi de terminate ile kapanmıyor çünkü kök neden ortak — listener message receive yapmıyor + close race guard yok.

**ÖNEMLI ANTI-HİPOTEZ:** Kullanıcının "Quick Access SSH popup, TerminalSessions listesine düşmüyor olabilir" hipotezi **YANLIŞ**. Production audit logları ve DB kayıtları her iki path için de TerminalSessionLog entry oluşturulduğunu gösteriyor.

---

## E. Terminate endpoint response — gerçek payload

Backend access log canlı kaydı (3 çağrı):

```
POST /api/v1/terminal-sessions/97c0c5ee60af42a7b388b21b6559923b/terminate
→ HTTP 200, duration 104.7ms
audit_action: terminal_sessions.terminate
status: success
resource_name: CATI_SAG_UST_SW58

POST /api/v1/terminal-sessions/2e00a65137ab456ebb43107866b3f22f/terminate
→ HTTP 200, duration 114.1ms

POST /api/v1/terminal-sessions/37fa3e1944fd43b48aa0c2a71a626e86/terminate
→ HTTP 200, duration 150.9ms
```

**Endpoint başarılı 200 dönüyor.** Frontend tarafına `{"session_id": ..., "status": "terminated", "ended_at": ..., "websocket_close_pending": true, ...}` döner.

---

## F. DB terminal_session_logs before/after

Üç vaka için DB durumu:

| Vaka | t=0 (started_at) | t=N (terminate yazdı) | t=M (WS finally) | Final DB |
|---|---|---|---|---|
| 1 (97c0c5ee) | 20:08:57 | 20:09:18 (`force_closed`) | 20:09:51 (`user_closed`) | **user_closed** |
| 2 (2e00a651) | 20:10:44 | 20:11:01 (`force_closed`) | 20:12:46 (`user_closed`) | **user_closed** |
| 3 (37fa3e19) | 20:13:00 | 20:13:59 (?) | 20:13:58 (`user_closed`?) | **force_closed** |

Vaka 3 anomalisi: WS finally TIME (20:13:58) endpoint zamanı (20:13:59) ÖNCESI. Açıklama: WS finally muhtemelen çalışmamış (browser ana sayfaya navigate etti, WS clean disconnect yok) → endpoint UPDATE force_closed kaldı.

**Bu doğrular ki:** WS finally'sin override yazımı önlenmediği sürece terminate işlemi her zaman "user_closed" oluyor (kullanıcı sonradan kapatınca). 

---

## G. Redis pub/sub publish/subscribe log durumu

**Publish:** Backend log'unda pub/sub publish hatası WARN yok → endpoint başarıyla publish etti.

**Subscribe:** Backend log'unda listener subscribe/unsubscribe için hiç log YOK çünkü kod log yazmıyor. **Canlı subscriber sayısı sadece aktif session sırasında ölçülebilir; şu an PUBSUB NUMSUB=0 (aktif session yok).**

Backend log testleri sırasında (Test 4 + uvloop Test):
- Listener subscribe → NUMSUB = 1 ✅
- Publish via `redis_client.publish` → mesaj subscriber'a ulaştı ✅

**Sonuç:** Pub/sub altyapısı (Redis + redis-py + publish helper + listener fonksiyonu) izole olarak çalışıyor. Canlı WS session context'inde test edemedik çünkü production'da debug instrumentation yok.

**Bu noktada hipotezimiz:** listener task gerçek context'te subscribe etmiş olsa bile, message receive aşamasında bir şey ters gidiyor. Olası nedenler (önem sırasıyla):

1. **redis-py 5.2.1 + uvloop async pubsub.listen() bir noktada SILENT disconnect yapıyor olabilir** — bağımsız vakalar GitHub issue listesinde belirtilmiş.
2. **`pubsub.subscribe(...)` await scheduled olduktan sonra listener'a switch olmadan WS handler bloklayan başka bir await'e geçiyor olabilir.**
3. **Listener task `WeakSet` kaybı (Python garbage collection — `asyncio.create_task` referans tutmazsa GC oluyor)** — `_terminate_task` local variable scope'unda referans var, bu hipotez ZAYIF.

Kesinleştirmek için canlı SSH session sırasında listener task'ına debug log ekleyip behavior gözlemlemek şart.

---

## H. Audit log neden görünmüyor (kullanıcı raporundaki)

Kullanıcı "Audit/log tarafında beklenen terminate kaydı görünmedi" dedi.

**Audit log YAZILMIŞ.** 3 row, organization_id=1, user_id=1 (admin), action='terminal_sessions.terminate', resource_id=session_id.

Kullanıcının görmediği nedenler (UI seviyesinde):

1. **Audit Log UI'ında zaman filtresi** kullanıcının baktığı zaman aralığı dışındaysa
2. **Action chip filtresi** `terminal_sessions.terminate` action'ı henüz UI'da chip olarak render edilmiyor olabilir (Audit Log UI v2 W2 scope)
3. **details JSON görünmüyor** — UI eski format details göstermiyor olabilir
4. **Cache** — Audit Log query React Query cache stale olabilir

**Audit log yazımı doğru çalışıyor.** UI tarafı W2 sprint'inde iyileştirilecek.

---

## I. Önerilen Hotfix Planı (4 fix)

> Aşağıdaki 4 fix bir arada çözüm sağlar. Pub/sub'ı bırakırız (latency için iyi); ama 2 fallback ekleriz ki **bu hipotezler doğru olsa da yanlış olsa da terminate güvenilir çalışsın**.

### Fix #1 (KESİN) — `TerminalSessionLogger.close()` race guard

`backend/app/services/terminal_session_logger.py:263` →
```python
.where(
    TerminalSessionLog.session_id == self.session_id,
    TerminalSessionLog.ended_at.is_(None),   # ← EKLE
)
```

Sonuç: WS finally'sin close() çağrısı eğer ended_at zaten yazılmışsa no-op olur. Force_closed override sorunu çözülür.

### Fix #2 (KESİN) — Endpoint direkt `close_shell_session` çağrısı

`backend/app/api/v1/endpoints/terminal_sessions.py` terminate endpoint'ine ekle:

```python
# Agent path session'ları için: pub/sub'a güvenmeden direkt close çağır.
# pub/sub mesajı listener'a ulaşmasa bile agent registry'den session
# kaldırılır, agent shell transport'u kapanır.
if row.agent_id:
    try:
        from app.services.agent_manager import agent_manager as _ag
        await _ag.close_shell_session(session_id)
    except Exception as exc:
        log.warning("close_shell_session direct call hata: %r", exc)
```

Sonuç: Agent SSH session'ı endpoint'ten direkt kapatılır. Listener mesaj alamasa bile shell kapanır, WS read loop EOF görür, finally çalışır.

### Fix #3 (KUVVETLE TAVSIYE) — WS handler'a DB-poll fallback

`backend/app/api/v1/endpoints/ws.py` listener'a paralel ekstra task ekle:

```python
async def _ssh_termination_db_poll(my_session_id, websocket, evt, interval=5.0):
    """Pub/sub yedek: her N saniyede DB'ye sor — ended_at NOT NULL ise WS'i kapat."""
    while True:
        await asyncio.sleep(interval)
        async with AsyncSessionLocal() as db:
            ended = (await db.execute(
                select(TerminalSessionLog.ended_at, TerminalSessionLog.exit_reason)
                .where(TerminalSessionLog.session_id == my_session_id)
            )).first()
            if ended and ended[0] is not None and ended[1] == 'force_closed':
                evt.set()
                try: await websocket.send_text("\r\n[ADMIN FORCE CLOSE]...\r\n")
                except: pass
                try: await websocket.close(code=4000)
                except: pass
                return
```

Sonuç: Pub/sub fail olsa bile en geç 5 saniyede WS kapanır. Worst-case latency 5sn (tasarım hedefi <2sn ama abuse vakası için kabul edilebilir).

### Fix #4 (DEBUG/HİJYEN) — Listener + publish'e structured log

Listener'a INFO log ekle: subscribe success, message received, session_id match, close called.
Publish helper'a DEBUG log ekle: publish returned (subscriber count).

Sonuç: Gelecek issue debug'lanabilir. Production'da behavior tracking.

---

## J. Değişecek dosyalar

| Dosya | Fix | Tahmini LOC |
|---|---|---:|
| `backend/app/services/terminal_session_logger.py` | #1 race guard | +1 satır |
| `backend/app/api/v1/endpoints/terminal_sessions.py` | #2 direct close + #4 publish log | +15 |
| `backend/app/api/v1/endpoints/ws.py` | #3 db-poll task + #4 listener log + paralel task lifecycle | +50 |
| `backend/app/core/redis_client.py` | #4 publish() log | +3 |
| `backend/tests/test_ssh_session_terminate.py` | #1 race guard test eklenmesi + #2 close_shell_session call test | +60 |
| `backend/tests/test_ssh_terminate_ws_listener.py` | (mevcut) — yeni test yok | 0 |
| `backend/tests/test_ssh_term_db_poll.py` (yeni) | #3 db-poll task test | +120 |

**Toplam ~250 LOC backend** (test ağırlıklı). Frontend dokunulmuyor.

---

## K. Test planı

### Mevcut testlerin güncellenmesi

| Test | Update |
|---|---|
| `test_terminate_happy_path_sets_ended_at_and_force_closed` | Aynı kalır |
| `test_terminate_race_guard_returns_410_when_update_rowcount_zero` | Aynı kalır |
| Yeni: `test_logger_close_no_op_when_ended_at_already_set` | TerminalSessionLogger.close()'ın race guard'lı olduğunu doğrular |
| Yeni: `test_endpoint_calls_agent_close_shell_session_when_agent_id_present` | Mock agent_manager + spy + assert called |
| Yeni: `test_endpoint_skips_agent_close_when_agent_id_none` | direct paramiko path için |

### Yeni testler

| Suite | Test sayısı | Konu |
|---|---:|---|
| `test_ssh_term_db_poll.py` | 5 | DB-poll task: ended_at=None → yine bekler; ended_at NOT NULL force_closed → evt.set + close(4000); ended_at NOT NULL user_closed → evt.set olmaz (sadece force_closed match); cancel cleanup; DB exception silent retry |
| `test_ssh_session_terminate.py` ek | 3 | Logger race guard + agent close çağrısı |

**Toplam yeni test: 8** + 21 mevcut = **29 backend pytest**.

### Manuel smoke (deploy sonrası)

1. **Agent path force-close** — admin terminate → WS xterm'de banner görünür + ~300ms'de close(4000)
2. **DB-poll fallback** — Redis durdur (`docker stop redis`) → admin terminate → 5sn içinde WS kapanır
3. **Logger override prevented** — Test #1 manuel doğrulaması: terminate sonrası user terminal'i kapatırsa final DB durumu `force_closed` kalmalı (`user_closed`'a dönmemeli)
4. **Direct paramiko** — Agent offline cihaz için terminate → pub/sub + close_shell_session no-op + DB-poll → WS kapanır
5. **Quick Access** — Devices listesinden hızlı erişim → terminate → kapanır

---

## L. Deploy / Rollback planı

### Deploy stratejisi

Bu hotfix **backend-only** — frontend dokunulmuyor. Ama backend rebuild + recreate zorunlu.

| Faz | Aksiyon |
|---|---|
| P0 | Anchor + 1 rollback tag (sadece backend) — `netmanager-backend:rollback-pre-ssh-term-hf-<TS>` |
| P1 | `git fetch + ff-merge` |
| P2 | `docker compose build backend` |
| P3 | `docker compose up -d --no-deps backend` |
| P4 | Smoke: /health/ready + /terminate (401) + DB-poll log mesajları |
| P5 | Deploy log dokümanı |

**Frontend recreate gerekmez** — terminate button + i18n zaten W1-F deploy'unda live.

### Rollback

```bash
docker tag netmanager-backend:rollback-pre-ssh-term-hf-<TS> netmanager-backend:latest
docker compose up -d --no-deps backend
git reset --hard a60d53d   # mevcut SSH Termination deploy state
```

Süre: ~10-15sn.

### Pre-deploy önkoşullar

| Kontrol | Beklenen |
|---|---|
| Yeni 8 pytest yeşil | ✅ |
| Mevcut 27 pytest yeşil (regression yok) | ✅ |
| Lokal `tsc/vitest/build/i18n` | ✅ (frontend dokunulmadığı için zaten yeşil) |
| Redis durdurma + DB-poll fallback testi | manuel smoke |

---

## Özet — kullanıcı hipotezlerine doğrulama

### Hipotez 1: "Terminate endpoint doğru DB row'unu kapatıyor ama aktif WS başka session_id ile çalıştığı için pub/sub mesajı match etmiyor."

**KISMEN DOĞRU.** Session_id mismatch YOK (Bölüm C). Ama DB UPDATE'i WS finally tarafından override edildiği için son durum `user_closed` olarak görünüyor. Kullanıcının "DB/audit/WS birbirinden kopuk" gözlemi aslında **DB UPDATE → WS finally override → kullanıcı kapatırken hâlâ açık** pattern'inden geliyor. Pub/sub'ın gerçekten mesaj ulaştırıp ulaştırmadığı **canlı production session'ında doğrulanamadı** — listener log eksikliği — ama izole testler altyapının çalıştığını gösteriyor.

### Hipotez 2: "Quick Access SSH popup, TerminalSessions listesine düşmüyor olabilir."

**YANLIŞ** (Bölüm D). Quick Access (SshTerminalPage) ve DeviceDetail Terminal sekmesi (SshTerminal component) ikisi de aynı backend `/api/v1/ws/ssh/{deviceId}` endpoint'ini kullanır, dolayısıyla aynı `TerminalSessionLogger` instance'ı oluşturur ve TerminalSessions listesinde görünür.

---

## Onay matrisi

| Aşama | Onay |
|---|---|
| RCA review + 4 fix planı onayı | ⏳ |
| **Hotfix implementation GO** | ⏳ (kullanıcı explicit) |
| 4 fix commit zinciri | (GO sonrası) |
| Test (29 pytest) | (her commit) |
| PR review + merge | (test yeşil sonrası) |
| Backend-only deploy | (merge sonrası) |
| Manuel smoke 5 senaryo | (deploy sonrası) |

**Bu doküman kod yazmaz.** Kullanıcı explicit "hotfix başla" demediği sürece referans niteliğindedir.
