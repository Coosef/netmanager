# T10 Faz C — Security Policy Engine: Uygulama Planı

> Durum: **PLAN (taslak)** — kodla başlamadan önce gözden geçirilecek.
> Kaynak: `Switch-Port Policies.docx` (Sancak / NestJS + Next.js + PG init.sql) → bizim
> **FastAPI + SQLAlchemy + PostgreSQL + RLS (Faz 7/8) + Celery + agent-relay** modeline port.
> Mevcut alembic head: **`f9aafirmware`** → Faz C migration'ları `f9ab`'den başlar.
> Önkoşul: A1 feature gate (security_policy zaten FEATURES registry'de, router/gate yok).

---

## 0. docx → bizim mimariye eşleme (özet)

| docx (Sancak/single-tenant) | Bizde (multi-tenant + RLS) |
|---|---|
| `network_switch_security_policies` (~30 alan) | `switch_security_policies` — **+`organization_id` (RLS FORCE)** |
| `network_port_security_policies` (~18 alan) | `port_security_policies` — **+`organization_id` (RLS FORCE)** |
| `network_switches.security_policy_id FK` | `devices.security_policy_id FK` (nullable) |
| `network_ports.security_policy_id FK` | **`devices.port_security_policy_id FK`** (cihaz-geneli varsayılan port policy) — bkz. aşağı |

> ⚠️ **PLAN DÜZELTMESİ (2026-05-29, C1):** `interfaces.security_policy_id` varsayımı **GEÇERSİZ** —
> bu kod tabanında **kalıcı interfaces/ports tablosu YOK** (arayüzler canlı SSH/SNMP ile çekilir,
> satır olarak saklanmaz). Bu yüzden:
> - **v1 port policy granularity = device-level default:** `devices.port_security_policy_id` →
>   switch'in TÜM portları için varsayılan port policy. docx port presetleri (default/uplink/pc/…)
>   ilk aşamada cihaz-geneli default olarak kullanılır.
> - **v2 per-port override = ayrı tablo** (`port_policy_assignment(device_id, port_name, policy_id)`)
>   veya canonical interface modeli (C7/v2). C1'de YENİ tablo açılmaz (scope büyütmez).
> - Resolver `resolve_port_policy(device, port_name)` zinciri ileride per-port override eklemeye açık:
>   (1) gelecekte per-port override → (2) `device.port_security_policy_id` → (3) org default port
>   policy → (4) hardcoded fallback. NULL semantic bozulmaz.
| `is_default=true` UNIQUE | **org bazlı** partial unique: `UNIQUE(organization_id) WHERE is_default` |
| `network_alerts` + `anomaly.service.ts` | mevcut `NetworkEvent`/`_save_event` + `correlation_engine` + `snmp/monitor/poe/mac_arp` task'ları |
| Cron vs event tetikleyici | mevcut Celery beat (cron) + agent push / poll (event) |
| `port_control` shutdown | `port_control_service.port_admin_commands(os_type, iface, enable=False)` |

**Tek-tenant → multi-tenant farkı:** her policy satırı bir org'a ait; resolver org scope içinde
çalışır; presetler **org bazlı** seed'lenir; `is_default` org başına tek.

---

## 1. Migration scope (Faz 7 RLS pattern, `f9ab`→)

3 küçük revision:

- **`f9ab` — schema:** `switch_security_policies` (~30 alan) + `port_security_policies` (~18 alan).
  Her tablo: `id`, `organization_id` (NOT NULL, FK→organizations CASCADE), `name`, `description`,
  `is_default` (bool), tüm eşik/severity alanları **nullable** (NULL semantic), `created_at/updated_at`.
  Partial unique: `CREATE UNIQUE INDEX ... ON switch_security_policies(organization_id) WHERE is_default`.
  Severity alanları `VARCHAR(16)` (`info|warning|critical`), eşikler `INTEGER/FLOAT`, `allowed_vlans`/
  `allowed_management_source_ips` `TEXT` (CSV), `config_change_policy` `VARCHAR(16)`.
- **`f9ac` — FK + grant:** `devices.security_policy_id` (nullable FK→switch_security_policies SET NULL) +
  `devices.port_security_policy_id` (nullable FK→port_security_policies SET NULL — cihaz-geneli
  varsayılan port policy; per-port override v2). `ix_*` indexleri. (interfaces FK YOK — tablo yok.)
  netmgr_app grant: f7a5 `ALTER DEFAULT PRIVILEGES` yeni tabloları kapsamalı — **doğrulanacak**;
  kapsamıyorsa explicit `GRANT SELECT,INSERT,UPDATE,DELETE ON switch/port_security_policies TO netmgr_app`.
- **`f9ad` — RLS + seed:** her iki tabloya `ENABLE` + `FORCE ROW LEVEL SECURITY` + `org_isolation`
  policy (Faz 7 deseni: `organization_id = current_setting('app.current_org_id')::int OR is_super_admin`).
  Ardından **org bazlı preset seed** (§3).

**Risk:** orta. `devices`/`interfaces`'e nullable FK eklemek additive (mevcut satırlar NULL → default'a düşer).
Migration'lar `env.py` super-admin GUC ile RLS-bypass koşar (mevcut Faz 7 deseni).

---

## 2. NULL semantic (docx'in kritik kararı — birebir korunur)

- Policy alanlarının ÇOĞU nullable. **NULL = "bu kontrolü yapma, sessiz ol".**
- Vendor heterojenliği (Ruijie/Cisco/Mikrotik): desteklenmeyen kontrol (örn. eski Ruijie BPDU) →
  ilgili `*_severity = NULL` → trap işlenmez, alarm yok.
- Cihaz çeşitliliği (CCTV/Office/Backbone): aynı kod, farklı DB konfig.
- Resolver/anomaly: `if pol.cpu_critical is None: skip`. **Sahte "0"/sentinel YOK** — açıkça None kontrolü.

---

## 3. Preset strategy (factory defaults — org bazlı)

docx'teki presetler **org bazlı** seed'lenir (multi-tenant):
- **Switch (3):** `Default` (CPU 70/85, mem 80/90, temp 55/70, ssh=info/telnet=critical, L2 trap'leri
  critical/warning, PoE 80/95), `CCTV-IoT` (toleranslı 80/95, cve_check off, config_change=auto_ack,
  PoE NULL, dot1x NULL), `Backbone` (sıkı 60/75, snapshot sık, firmware_drift on, mgmt IP whitelist,
  PoE 70/90, NTP 60/300).
- **Port (7):** `default` (mac_flood 5/10, vlan/new_mac on, bw 90, optic NULL), `uplink` (mac_flood NULL,
  bw 95, optic -22/-28dBm 70/80°C, new_mac off), `pc` (2/5, new_mac on), `printer` (1/2, link_up on),
  `kamera` (1/2, link_up on), `ap` (50/200, bw 80, new_mac off), `pos` (1/2, link_up on,
  **auto_quarantine_on_nth_flap=3**).
- **Seed nasıl:** `f9ad` migration mevcut org'lar için + yeni org yaratımında (`_ensure_default_org`
  yanında bir `_seed_security_presets(org_id)` hook). Her org'da bir switch + bir port preset `is_default=true`.
- **KARAR GEREKLİ:** presetler (a) her org'a kopyalanır mı, yoksa (b) global şablon + org override mı?
  **Önerim (a):** org bazlı kopya — RLS temiz, org kendi presetini düzenleyebilir, izolasyon net.

---

## 4. Policy resolver (`backend/app/services/security_policy_service.py` — yeni)

- `resolve_switch_policy(db, device) -> SwitchPolicy`:
  `device.security_policy_id` → yoksa org'un `is_default=true` switch policy → yoksa **hardcoded fallback**
  (kod sabiti, en güvenli baseline). 30s process-cache (system_settings_service deseni) opsiyonel.
- `resolve_port_policy(db, device, port_name=None) -> PortPolicy`: zincir (gelecekte per-port override →
  `device.port_security_policy_id` → org `is_default` port policy → hardcoded fallback). v1'de port_name
  henüz kullanılmaz (device-level default); imzada bırakılır ki v2 per-port override eklenebilsin.
- Org scope: resolver RLS-scoped session'da çalışır (org dışı policy görünmez). Fleet-wide task'larda
  `superadmin_context` + explicit org filtre (context.py `_device_counts` deseni).
- Çıktı: alarm üretiminde her mesaj **`[policy=<name>]`** ile etiketlenir (docx birebir).

---

## 5. Feature gate: `security_policy`

- `security_policy` zaten FEATURES registry'de (A1). Faz C router'ı (`/api/v1/security-policies`)
  `dependencies=_feat("security_policy")` ile gate'lenir → org planında kapalıysa 403.
- Anomaly/alarm entegrasyonu (task'lar) feature kapalıysa **policy çözmeyi atlar** (mevcut sabit
  davranışa düşer) — task'larda `org_feature_states`/`feature_enabled` kontrolü. Super-admin bypass.
- Frontend nav'da `security_policy` kapalı org'da gizli (A1 useNavGroups deseni — zaten hazır).

---

## 6. Anomaly / alarm integration (mevcut motora bağla)

> **C3 VERİ-KAYNAĞI DENETİMİ (2026-05-29) — kapsam revize edildi.** Olmayan metrikler C3'e
> zorlanmadı. **C3 MVP = CPU + Memory threshold + Offline policy-label.** Gerekçe ve erteleme aşağıda.

Yeni motor YAZMIYORUZ — mevcut tetik noktalarına policy-okuma ekliyoruz:
- ✅ **CPU + Memory** (C3): `snmp_service.get_cpu_ram()` VAR ama yalnız on-demand. C3 yeni periyodik
  `poll_device_health` task'ı (+ beat) → `resolve_switch_policy` → `cpu_warning/critical` +
  `memory_warning/critical` eşik → `_save_event` (`[policy=<name>]`). NULL eşik → skip. Feature kapalı → çalışmaz.
- ✅ **Offline** (C3): mevcut `monitor_tasks` `device_offline` event'ine **yalnız `[policy=<name>]` etiketi**
  (davranış DEĞİŞMEZ). `offline_timeout_min` tuning'i → **later** (ayrı küçük adım; mevcut offline detection stabil kalır).
- ⏸️ **Temperature → v2:** veri kaynağı YOK (vendor-specific entity-sensor OID). Trap/optic ile birlikte.
- ⏸️ **PoE budget % → v2:** switch toplam PoE bütçesi (payda) kayıtlı değil; per-port `max_mw` switch
  budget'ı değil. Ayrı migration + cihaz envanter alanı (`devices.poe_total_budget_mw`) gerektirir.
- **MAC flood / flap** → C4 (mevcut `mac_arp` verisi).
- **L2 trap / optic DOM** → v2 (agent UDP trap receiver + vendor OID heterojenliği).
- **Optic DOM** (event): vendor-specific SFP OID keşfi (Cisco/Ruijie) → `optic_rx/temp` eşiği. Keşif gerektirir.
- Cron-based vs event-based ayrımı docx'teki gibi korunur.

---

## 7. Frontend CRUD

- Policy CRUD sayfaları (switch + port) — antd, mevcut Settings/管理 deseni.
- Cihaz/port'a policy atama UI (devices/interfaces detayında dropdown).
- Alarm listesinde `[policy=X]` etiketi + "hangi policy" filtresi.
- `is_default` değiştirilince eski default flag'i otomatik kalkar (FE + backend partial-unique guard).
- Feature kapalı org'da sayfa gizli (A1).

---

## 8. Auto-quarantine RISK GUARD (en kritik güvenlik kararı)

Port policy `auto_quarantine_on_nth_flap=N` → N flap'te otomatik port shutdown (`port_control_service`).
**Yanlış shutdown = üretim kesintisi.** Bu yüzden çok katmanlı guard:
- **Varsayılan KAPALI:** `auto_quarantine_on_nth_flap = NULL` (yalnız `pos` presetinde 3). Opt-in.
- **Global kill-switch:** `system_settings` `security.auto_quarantine_enabled` (A2 deseni, default false)
  — feature açık olsa bile global kapalıysa hiçbir otomatik shutdown olmaz (yalnız alarm).
- **Uplink koruması:** `uplink` port policy / `is_default` uplink portları **asla** auto-quarantine olmaz.
- **Rate-limit:** aynı org/switch'te birim zamanda max N otomatik shutdown (kaskad kesinti engeli).
- **Dry-run mode:** ilk aşamada "quarantine olurdu" alarmı üret, gerçek shutdown yapma (A3 dry-run deseni);
  operatör güveni gelince enable.
- **Manuel release + audit:** her auto-quarantine `audit_logs` + `category=security` log (B4) +
  manuel "release" endpoint'i (otomatik geri açma YOK).
- **Onay zinciri (opsiyonel, #8):** mevcut playbook+approval reuse — shutdown öncesi onay.

---

## 9. Sıra & küçük commitler (öneri)

1. **C1** migration f9ab/f9ac/f9ad (schema+FK+RLS+seed) + model'ler — canlı: RLS izolasyon testi.
2. **C2** resolver service + feature gate + CRUD API (router `_feat("security_policy")`) + testler.
3. **C3** anomaly entegrasyonu — CPU/mem/temp + offline + PoE budget (en düz, trap'siz). `[policy=]` etiketi.
4. **C4** MAC flood/flap tespiti (mevcut mac_arp verisi).
5. **C5** auto-quarantine — **dry-run önce**, guard'lar, kill-switch, audit. (Riskli → izole adım.)
6. **C6** frontend CRUD + atama UI + alarm policy filtresi.
7. **C7** (opsiyonel/v2) L2 trap receiver (agent UDP), optic DOM (vendor OID), playbook onay zinciri.

Her adım: migration varsa staging dry-run + RLS test; anomaly adımlarında policy NULL→skip testi;
auto-quarantine'de dry-run + guard testi. **Production deploy YOK** (Faz B deseni).

---

## 10. Risk review
- **Migration (orta):** additive nullable FK; RLS FORCE yeni tablolara — Faz 7 deseni, staging dry-run.
- **netmgr_app grant:** yeni tablolara grant gerekli (f7a5 default-priv kapsamı doğrulanacak; B2a audit scripti yeni tabloları da kontrol etsin).
- **Auto-quarantine (YÜKSEK):** yanlış shutdown riski → §8 çok katmanlı guard + dry-run; en son adım.
- **SNMP trap / optic (orta-yüksek):** agent altyapı değişikliği + vendor OID heterojenliği → v2'ye ertelenebilir.
- **Performans:** resolver her event'te policy okur → cache (30s) + org-scope; alarm hacmi suppression window (docx) ile.
- **Feature gate:** kapalı org'da tüm motor sessiz (mevcut sabit davranış korunur).

## 11. v2'ye ertelenen (docx "yapamadıklarımız")
- Time-based policy (gece/gündüz farklı eşik).
- Hierarchical inheritance (org-default → switch-override).
- Policy versioning/rollback (şimdilik audit log'a düşer, eski versiyon saklanmaz).

---

## Kararlar (KİLİTLENDİ — 2026-05-29)
1. **Preset:** ✅ **org bazlı kopya** (her org kendi switch/port preset kayıtları; RLS + lisans temiz).
2. **Auto-quarantine:** ✅ **default-OFF + global kill-switch + dry-run-first**. İlk sürümde HİÇBİR port
   otomatik kapanmaz — yalnız alarm + önerilen aksiyon + dry-run audit. Auto-shutdown sonra manuel onay /
   playbook approval ile açılır.
3. **L2 trap receiver + optic DOM:** ✅ **Faz C v2'ye ertelendi** (agent değişikliği + vendor OID
   heterojenliği: Ruijie/Cisco/Mikrotik farklı davranır; MVP'yi büyütür).
4. **Migration:** ✅ **3 revision** (f9ab schema · f9ac FK+grant · f9ad RLS+seed) — rollback/review temiz.
5. **İlk teslim:** ✅ **C1 → C2 → C3** (schema+model · resolver+feature gate+CRUD · basic anomaly:
   CPU/memory/temp/offline/PoE). Sonra **C4** MAC flood/flap, **C5** dry-run quarantine recommendation,
   **C6** frontend, **C7** trap/optic = v2.

**Faz C v1 kapsamı:** switch policy + port policy + resolver + CPU/mem/temp/offline/PoE threshold +
MAC flood/flap detection + **dry-run quarantine recommendation** (gerçek shutdown YOK). Frontend dahil.

**Bağlayıcı kurallar (her adımda):** feature flag ile kapatılabilir (kapalı org → API 403, task'ta
policy check çalışmaz) · NULL = kontrol kapalı (birebir) · default policy yoksa hardcoded fallback ·
tüm alarm mesajlarında `[policy=<name>]` · RLS + FORCE RLS kesin · org isolation testleri · **production deploy YOK**.
