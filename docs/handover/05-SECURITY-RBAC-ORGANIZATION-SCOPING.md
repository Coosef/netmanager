# 05 — Güvenlik, RBAC ve Organizasyon Scope'u

## 1. Yetki katmanları (özet)

```
Browser/API client
        │
        ▼ JWT Bearer (Cloudflare üzerinden)
Cloudflare WAF / rate (varsa)
        │
        ▼
Nginx (security headers + dev path 404 + WS proxy)
        │
        ▼
Backend AuthMiddleware (JWT verify → user)
        │
        ▼
OrgContextMiddleware (organization_id + location_id set)
        │
        ▼
require_permission("<canonical_key>") gate
        │
        ▼
DB session: SET LOCAL app.current_organization_id = ... (RLS bite)
        │
        ▼
SQL execution → RLS policy organization_id eşitlemesi yapar
```

## 2. Canonical roller (Sprint 1A)

4 rol kanonik:
| Rol | Kapsam |
|---|---|
| `super_admin` | Platform yönetimi. Tüm organizasyonlara erişim. "Platform Mgmt" menüsü yalnız bu role açık. `ROLE_ORDER` kaldırıldı (Sprint 1A) |
| `org_admin` | Bir organizasyonun tüm lokasyonlarına erişim. `PermissionEngine.resolve` global short-circuit'le tüm `<organization_id>` scope'lu permission'ları döner |
| `engineer` | Atandığı lokasyonlarda cihaz operasyonu (terminal, config, port, backup) |
| `viewer` | Salt okuma |

> ⚠ **VERIFY BEFORE HANDOVER**: `backend/app/services/rbac/engine.py` içindeki `PermissionEngine.resolve()` fonksiyonu canonical rol short-circuit'larını içerir. Önceki bir incident'ta (2026-06-10, çok-lokasyonlu örnek organizasyon) **kullanıcının hiç lokasyonu yoksa org_admin bile boş ekrana düşebilir** sorunu gözlemlendi; düzeltme zinciri operatörde — VERIFY BEFORE HANDOVER (historical internal context). Devir alacak ekip bu davranışı manuel test etmeli.

## 3. Canonical permission keys

Permission key'leri **dot-separated** ve **resource.action** desenine sahiptir:

| Kategori | Örnek anahtarlar |
|---|---|
| Cihaz | `devices.read`, `devices.write`, `devices.delete`, `devices.fetch_info` |
| Cihaz interface | `devices.interfaces.read`, `devices.interfaces.refresh` |
| Port kontrol | `port_control.toggle`, `port_control.poe_toggle` |
| Backup / config | `backup.read`, `backup.create`, `backup.restore`, `config.read`, `config.write` |
| Terminal | `terminal_sessions.read`, `terminal_sessions.open`, `terminal_sessions.terminate` |
| Audit log | `audit_logs.read`, `audit_logs.export` |
| Org yönetimi | `organizations.read`, `organizations.write`, `users.invite`, `users.manage` |
| Platform | `platform_mgmt.*` (super_admin only) |
| Topology | `topology.read`, `topology.discover` |
| IPAM, SLA, Synthetic | İlgili modüllerin `<module>.read/write` |
| Security policies | `security_policies.read`, `security_policies.assign` |

> ⚠ **VERIFY BEFORE HANDOVER**: Backend canonical key listesi `backend/alembic/versions/f9ag_canonical_permission_keys.py` üzerindedir. Frontend tarafında **tek bir liste dosyası yoktur**; key kontrolleri `frontend/src/App.tsx`, `frontend/src/utils/menuGroups.ts`, `frontend/src/types/index.ts`, `frontend/src/contexts/SiteContext.tsx` ve ilgili route/component permission gate'lerine dağınık şekilde gömülüdür. Devir alacak ekip backend listeyi referans alıp frontend dağıtık noktalardaki kullanımları çapraz-kontrol etmeli. Konsolidasyon teknik borcu [12](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) TD-20 olarak listelidir.

## 4. Cihaz ve config backup yetkileri

| İşlem | Permission |
|---|---|
| Cihaz listesi görüntüleme | `devices.read` |
| Cihaz detay | `devices.read` |
| Yeni cihaz ekleme | `devices.write` |
| Cihaz silme (soft) | `devices.delete` |
| Bulk credential update | `devices.bulk_update_credentials` *(canonical key — VERIFY)* |
| Backup oluştur | `backup.create` |
| Backup restore | `backup.restore` |
| Config diff izleme | `config.read` |
| Config template uygulama | `config.write` |
| Port aç/kapat | `port_control.toggle` |
| PoE on/off | `port_control.poe_toggle` |
| Terminal aç | `terminal_sessions.open` |
| Terminal terminate | `terminal_sessions.terminate` (Backlog-P1 — özellik cancel edildi) |

## 5. Agent scope sınırları

| Mekanizma | Açıklama |
|---|---|
| `X-Agent-Key` | Her agent enroll edildiğinde unique key alır; hash'i DB'de tutulur, plaintext yalnız enroll anında karşı tarafa gösterilir |
| Agent → backend WS auth | `Sec-WebSocket-Protocol` veya header üzerinden `X-Agent-Key` |
| Agent organization scope | Agent kaydı bir `organization_id` + `location_id` taşır; agent'ın yürüttüğü komutlar yalnız o scope'taki cihazlar için meşru |
| `/api/v1/internal/agent-relay` | `X-Internal-Key` header'ı ile auth; backend container'ları kendi aralarında konuşur; dış dünyaya kapalı (`internal` network) |

> ⚠ **VERIFY BEFORE HANDOVER**: Agent key rotation prosedürü `06-AGENT-INSTALLATION-AND-OPERATIONS.md` içinde özetlenmiştir; production'da ne sıklıkta rotate edildiği ayrı doğrulanmalı.

## 6. Credential encryption yaklaşımı

| Alan | Saklama |
|---|---|
| Cihaz SSH password | Fernet ile şifreli, `devices.ssh_password_enc` |
| Cihaz enable secret | Fernet ile şifreli, `devices.enable_secret_enc` |
| Cihaz SNMP community | Fernet ile şifreli |
| Kullanıcı password | bcrypt hash (`users.password_hash`) |
| MFA TOTP secret | Fernet ile şifreli, `users.mfa_secret_enc` |
| Cloudflare/Stripe/3p token (varsa) | `.env` ortam değişkeni; **uygulama içine asla yazılmaz** |
| Agent key | sha256 (veya benzeri) hash; plaintext yalnız enroll yanıtında bir kez |

Fernet key tek bir env değişkeninden gelir: `CREDENTIAL_ENCRYPTION_KEY` (32 byte URL-safe base64). **Bu key kaybedilirse şifrelenmiş tüm credentials geri alınamaz.**

## 7. Secret rotation prensipleri

| Secret | Rotation periyodu (önerilen) | Adımlar |
|---|---|---|
| JWT_SECRET | 6 ay veya incident sonrası | Yeni secret üret → tüm aktif token'lar invalidate olur → kullanıcılar yeniden login |
| CREDENTIAL_ENCRYPTION_KEY | **Yapılmamalı** rutin olarak | Kaybedilirse tüm cihaz credential'ları yeniden onboard gerekir; sadece compromise durumunda re-encrypt prosedürü ile yapılır |
| Agent key | Agent host değişikliği veya şüphe durumunda | UI'dan agent re-enroll; yeni key yeni key hash ile DB'ye yazılır |
| Cihaz SSH/enable secret | Cihaz politikasına göre | UI'dan bulk credential update → 5-10 dk içinde cache+pool turnover ile devreye girer (bkz. [08](08-DEVICE-ONBOARDING-AND-CREDENTIALS.md)) |
| Postgres password | Yıllık veya incident sonrası | `.env` güncelle → backend + worker'lar restart |
| Redis password (varsa) | Yıllık | `.env` + recreate |
| Cloudflare API token | Sahibinin verdiği periyot | CF panel üzerinden re-issue |

## 8. Audit log beklentileri

Aşağıdaki olayların **mutlaka** `audit_logs`'a düşmesi beklenir:
- Login / logout / MFA başarı/başarısızlık
- Cihaz create / update / delete / bulk credential update
- Backup create / restore
- Port toggle / PoE toggle
- User create / role change / role remove
- Permission grant / revoke
- Approval workflow (varsa) — request / approve / reject
- Maintenance window create / activate / close
- Terminal session açma (open/close); **komut bazlı audit `agent_command_logs`'a**

UI tarafı: Audit Log v2 sprint'i ile `AuditActionChip`, `AuditDetailDrawer`, `AuditDiffViewer`, `AuditResourceLink`, `AuditFilterBar` bileşenleri eklendi (PR #51–#58); backend schema değişmedi.

> ⚠ **VERIFY BEFORE HANDOVER**: "Bulk credential update" audit kaydında **kaynak cihaz id'si tutulmuyor** (yalnız hedef listesi). Bu boşluk [12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) içinde işaretli.

## 9. RLS / org context

### 9.1 Postgres seviyesi
- App role'üne `BYPASSRLS` verilmemiş.
- Her tenant-aware tabloda `organization_id` policy:
  ```sql
  CREATE POLICY tenant_isolation ON <table>
    USING (organization_id = current_setting('app.current_organization_id', true)::int);
  ```
- Çoğu tabloda ek olarak `location_id` scope'lu ikinci policy bulunur (Faz 8).

### 9.2 Uygulama seviyesi
- HTTP request: AuthMiddleware kullanıcıyı çıkardıktan sonra OrgContextMiddleware:
  ```python
  await session.execute(text("SET LOCAL app.current_organization_id = :oid"), {"oid": user.organization_id})
  ```
- Celery task: `with org_context(device.organization_id, device.location_id): ...` blok zorunlu.

### 9.3 Bilinen tuzaklar
- `bulk_tasks` modülü Faz 7 isolation rework regresyonu sırasında RLS bypass'sız çalışıyordu (W3.1'de düzeltildi). Kalan 7 task modülü hala ayrı audit ister (historical internal context — VERIFY BEFORE HANDOVER).
- `topology_service.save_links` INSERT org/loc stamp eksik kalmıştı (HF#13 ile fix edildi).
- Worker context'i `org_context` bloğu olmadan DB'ye yazarsa RLS reject döner ve task hata mesajıyla biter.

## 10. Güvenli erişim ve minimum yetki modeli

| Erişim | Önerilen yetki |
|---|---|
| NOC / saha personeli | `engineer` rolü + sadece çalıştığı lokasyonlar |
| Yardım masası | `viewer` rolü |
| BT yöneticisi (kurum) | `org_admin` |
| Platform sahibi | `super_admin` (mümkün olduğunca az sayıda kullanıcı) |
| Servis hesabı (CI/monitoring) | Ayrı `system` kullanıcı; sadece read; ⚠ VERIFY production'da var mı |

**Prensipler:**
- En az bir, mümkünse iki `super_admin` (single-key compromise riski için).
- Kullanıcı offboard'ta önce `is_active=False`, MFA secret invalidate; sonra audit log dökümü; ardından `deleted_at` (soft).
- Servis hesapları MFA muaf olabilir; ama login-from-IP whitelist veya client cert ile sınırlanır — ⚠ **VERIFY BEFORE HANDOVER**.

## 11. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- 4 kanonik rol (Sprint 1A ship'i)
- RLS aktif, app role'ü BYPASSRLS yok (compose Faz 7 yorumu + migration setup)
- Audit log v2 frontend bileşenleri ship'li (PR #51–#58)
- Bulk credential audit'inde kaynak device_id tutulmuyor (Site-A bulk credential copy incident forensic'inde gözlendi)

### VERIFY BEFORE HANDOVER
- Tam canonical permission key listesi
- "Kullanıcının hiç lokasyonu yoksa boş ekran" (çok-lokasyonlu örnek organizasyonda gözlenen incident) backend/frontend fix'i merge edilmiş mi
- MFA enrollment durumu prod'da (yüzde kaç user enrolled?)
- Secret rotation envanteri (hangi secret en son ne zaman rotate edildi?)
- Servis hesapları varsa nasıl izole edildiği
