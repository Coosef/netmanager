# T10 Roadmap — Lisanslama · Güvenlik Sertleştirme · Security Policy Engine

> Durum: **PLAN** (kod yazılmadı, üzerine konuşulacak)
> Kaynak: kullanıcı 22 fikir + `Switch-Port Policies.docx` (Sancak/NestJS tasarımı → FastAPI port)
> Mevcut alembic head: `f9aafirmware` · yeni migration'lar `f9ab`'den başlar
> Sıra (kullanıcı tercihi): **Faz A (Lisanslama) → Faz B (Hardening) → Faz C (Policy Engine)** — kolaydan zora

---

## Faz A — Lisanslama + Parametrik Config  (#7, #20, #21, #19)

**Amaç:** Ticari model. Hangi org hangi modülü kullanabilir + hardcoded değerleri operatöre aç + müşteri-bazlı retention.

### Mevcut
- `Plan` modeli: `max_devices/users/locations/agents` + `features` JSON (`{"topology": true, ...}`) — VAR
- `org_management.enforce_org_can_create()` — quota check VAR
- `system_settings` (org-bazlı key-value JSONB) — VAR ama dar kapsam
- **Eksik:** `features` JSON hiçbir yerde **enforce edilmiyor** (sadece org_admin'de gösteriliyor)

### A1. Feature Registry + Enforcement
- `backend/app/core/features.py` (**yeni**): merkezi modül listesi
  ```
  FEATURES = {
    "monitoring", "topology", "ipam", "config_backup", "firmware",
    "poe", "config_builder", "security_policy", "ai_assistant",
    "synthetic_probes", "sla", "api_tokens", "agents", ...
  }
  ```
- `deps.py`'a `require_feature("topology")` dependency — org'un plan.features'ında kapalıysa **403 + "plan upgrade gerekli"**
- ~45 endpoint'e ilgili `require_feature` ekle (router seviyesi grup grup)
- Frontend: `useAuthStore`'a org feature listesi (token claim veya `/context/current`); nav menüde kapalı modülleri gizle / "kilit" rozeti
- **Risk:** düşük (additive). Test: feature kapalı org → 403; açık org → 200.

### A2. Parametrik Config Genişletme (#21)
- Hardcoded değerleri envantere al (örn: poll interval 300s, retention günleri, session timeout, SNMP timeout, alarm dedup window, PoE/MW beat cadence)
- `system_settings`'e taşı; her okuma noktasında `system_settings_service.get(key, fallback)`
- Settings UI'da kategori sekmeleri (Tarama / Retention / Güvenlik / Bildirim)
- **Karar gerekli:** hangileri org-override edilebilir, hangileri sadece super_admin global?

### A3. Müşteri-bazlı Retention (#19)
- `plans` veya org `system_settings`'e `retention_days` (events, snapshots, syslog, terminal_sessions ayrı ayrı)
- `retention_tasks.cleanup_old_data` bu değeri org bazlı okusun (şu an global sabit)
- **Risk:** orta (yanlış retention = veri kaybı; alt sınır guard)

**Faz A tahmini:** 3-4 tur. Migration: 1-2 (plans seed + system_settings yeni anahtarlar).

---

## Faz B — Güvenlik Sertleştirme  (#12, #15, #13, #2)

**Amaç:** Saldırı yüzeyini azalt, disaster senaryolarına hazırlık.

### Mevcut
- Container'lar ayrı (backend/frontend/postgres/redis/4×celery) — VAR
- DB user yarı-ayrım: `netmgr` (super) + `netmgr_app` (non-super) — VAR
- Fernet `MultiFernet` key rotation overlay — VAR
- **Eksik:** explicit network yok, `postgres:5432` + `redis:6379` **dışa açık**, DR runbook yok

### B1. Network Segmentation (#12, #15)
- `docker-compose.yml`'a iki network: `edge` (nginx ↔ dış) + `internal` (backend ↔ db/redis)
- `postgres` / `redis` `ports:` kaldır → sadece `internal` network (dışarıdan erişilemez)
- `expose:` kullan (container-arası), `ports:` sadece nginx'te
- Frontend de internal'a, dışarı sadece nginx 443
- **Risk:** orta — yanlış network = servisler birbirini bulamaz. Staging'de test, rollback kolay (compose revert).

### B2. DB Fine-Grained Permission (#2)
- `netmgr_app`'in grant'larını audit: sadece DML (SELECT/INSERT/UPDATE/DELETE), DDL super'da
- RLS zaten FORCE; app user superuser değil ✓
- Migration user (super) sadece deploy sırasında, runtime app user

### B3. Log Ayrımı (#15)
- API access log ↔ DB query log ↔ audit log ayrı stream/volume
- Structured logging zaten var (`netmanager.http` logger) — ayrıştırma + retention

### B4. Disaster / Key Recovery (#13)
- **DR Runbook** (`docs/DR_RUNBOOK.md`): backup restore adımları, key kaybı senaryosu
- **Key escrow:** Fernet key'lerin offline/secret-manager yedeği prosedürü
- "Key kaybı = ne kurtulur?" matrisi: credentials (decrypt edilemez → kayıp), config/topology/metrics (kurtulur)
- Backup restore **testi** (otomatik veya manuel checklist)
- **Not:** #14 (web/api cloud DR) — kullanıcı "cloud halleder" dedi, kapsamda değil

**Faz B tahmini:** 2-3 tur. Çoğu infra/compose + dokümantasyon, az kod.

---

## Faz C — Security Policy Engine  (docx #5+#6, #8)

> **DURUM (2026-05-29) — Faz C MVP TAMAMLANDI ✅ — main @ `f8f162c`.**
> **Teslim edilen:**
> - **C1** Schema (`f9ab`/`f9ac`/`f9ad`, alembic head=`f9adsecrls`) + Faz 7 RLS (FORCE, org-izole) + org bazlı seed (3 switch: Default/CCTV-IoT/Backbone, 7 port preset). NULL=kontrol kapalı.
> - **C2** Resolver: atanan policy → org `is_default` → hardcoded fallback (switch + port). `[policy=<ad>]` etiketi.
> - **C3** Anomaly: CPU + Memory eşik değerlendirmesi (`poll_device_health`, 5dk beat) + offline `[policy=]` label. *(sıcaklık + PoE budget → veri-kaynağı yok → v2)*
> - **C4** MAC flood (**C4a**, opt-in `security.mac_flood_enabled` default-OFF + uplink heuristik skip) + MAC flap (**C4b**, collection-capture, Redis sayaç). Flap → **DRY-RUN** alarm (`dry_run=true`, `suggested_action=quarantine_port`) — **gerçek shutdown YOK**.
> - **C6** Frontend: **C6a** CRUD sayfası (switch/port tab, NULL UI, feature gate, viewer salt-okunur) · **C6b** cihaz formu atama (switch + cihaz-geneli port; cross-org doğrulama) · **C6c** olay listesinde `[policy]` etiketi + DRY-RUN öneri rozeti + `policy_only` filtre + CSV.
>
> **Ertelendi (v2 / sonraki):** **C5** gerçek auto-quarantine (port shutdown operasyonel risk → kill-switch + approval ile gelecek, kullanıcı kararıyla başlatılmadı) · C4 L2 trap parse · C6 optic DOM · C7 PoE budget alarmı · sıcaklık eşiği · C9 config_change · C12 playbook tetik · C13 false-positive hide · **per-port override** (v1 = cihaz-geneli default port policy).
>
> **Backlog:** TD-2 — WS auth `OAuth2PasswordBearer` 5xx (pre-existing, C6 değil; `docs/TECH_DEBT_BACKLOG.md`).
> **Deploy:** Production deploy YOK · VPS deploy hazard geçerli.

**Amaç:** Per-switch + per-port atanabilir güvenlik politikaları. **En büyük modül** — docx'in tam karşılığı, birçok küçük gap'i (port security, L2 trap, optic, MAC flap) tek çatıda toplar.

### Mevcut
- `alert_rules` (device_id FK nullable, metric threshold, severity) — KISMEN (per-device ama port değil, CPU/temp yok)
- SNMP poll (`snmp_tasks`, `snmp_metric`) — VAR
- PoE snapshot (`poe_port_snapshots`) — VAR (Tur 6B)
- mac_arp (MacAddressEntry) — VAR ama flood threshold/quarantine yok
- Incident "snmp_trap" source — KISMEN (trap forward var, L2 trap parse yok)
- **Eksik:** policy tablosu, NULL semantic, L2 trap severity, optic DOM, auto-quarantine, PoE budget alarmı

### C1. Schema (Migration f9ab, f9ac)
- `switch_security_policies` (~30 alan): cpu/mem/temp warning+critical, snapshot interval/retention, anomaly toggles, login severity'leri (console/ssh/web/telnet), L2 trap severity'leri (bpdu/loop/dhcp/arp/port_sec/dot1x/storm), poe_budget_warning/critical_pct, ntp_drift, config_change_policy, `is_default` (UNIQUE WHERE true)
- `port_security_policies` (~18 alan): mac_flood warning/critical, mac_flap (window/transitions/quiet/auto_quarantine), vlan_change + allowed_vlans, new_mac_alert, link_up_alert, bandwidth_pct, if_error/discard PPM, optic rx_dbm + temp
- `devices.security_policy_id` + `interfaces.security_policy_id` FK (nullable → default fallback)
- Faz 7 RLS pattern (org isolation, FORCE)
- **NULL = kontrol kapalı/sessiz** semantiği

### C2. Policy Resolver (`backend/app/services/security_policy_service.py` **yeni**)
- `resolve_switch_policy(id)` → NULL ise `is_default=true`, o da yoksa hardcoded fallback
- `resolve_port_policy(id)` aynı
- Anomaly check'lerde: `if val > pol.cpu_critical → alarm`; `if pol.x is None → skip`
- Alarm message'a `[policy=<name>]` etiketi

### C3. Anomaly Engine Entegrasyonu
- Mevcut `monitor_tasks` / `snmp_tasks` CPU/mem/temp → policy threshold'dan oku
- Cron-based (offline, config age, NTP) vs event-based (CPU/flap/flood) ayrımı (docx'teki gibi)

### C4. L2 Trap İşleme
- SNMP trap receiver (agent UDP 1620 → backend) — **altyapı genişletme**
- Trap tipi parse: BPDU guard, loop, DHCP snooping, ARP inspection, port-security, dot1x, storm-control
- Her tip policy severity'sinden → alarm (NULL ise yok say)

### C5. MAC Flap Auto-Quarantine
- mac_arp verisinden flap tespiti (X dk içinde Y port değişimi)
- Policy `auto_quarantine_on_nth_flap` → otomatik port shutdown (port_control_service ile)
- Manuel release; audit log

### C6. Optic DOM Monitoring
- SNMP SFP OID'leri (rx power dBm, temp °C) — vendor-specific (Cisco/Ruijie keşfi gerekli)
- `snmp_metric`'e optic alanları veya yeni `optic_dom_snapshots`
- Policy threshold ile alarm

### C7. PoE Budget Alarmı
- Mevcut `poe_port_snapshots` topla → switch toplam PoE bütçesi %
- Policy `poe_budget_warning/critical_pct`

### C8. Port Security (MAC flood / new MAC / link-up)
- mac_arp port başına MAC sayısı → policy threshold
- Yeni MAC / boş porttan link-up event'i

### C9. config_change_policy (info/require_ack/auto_ack)
- Config drift tespitinde policy davranışı

### C10. Seed Presetler
- Switch: Default / CCTV-IoT / Backbone (docx'teki değerlerle)
- Port: default/uplink/pc/printer/kamera/ap/pos (7 preset)

### C11. Frontend
- Policy CRUD sayfaları (switch + port)
- Cihaz/port'a policy atama UI
- Alarm listesinde `[policy=X]` etiketi + "hangi policy" filtresi

### C12. Playbook Entegrasyonu (#8)
- Policy ihlali → opsiyonel playbook tetikle + onay zinciri (mevcut playbook + approval reuse)

### C13. False-Positive Hide (#22 — bu fazda mantıklı)
- Interface/MAC seviyesinde "yok say" (policy NULL + record-level ignore flag)

**Faz C tahmini:** 8-12 tur (en büyük). Migration: 2-3.
**Riskler:** SNMP trap altyapısı (agent değişikliği), vendor heterojenliği (optic OID'leri), auto-quarantine (yanlış shutdown riski → dikkatli test).
**v2'ye ertelenebilir:** time-based policy, hierarchical inheritance (hotel→switch→port), policy versioning/rollback.

---

## Kapsam dışı / ayrı plan
- **#1 Entra / conditional access** — opsiyonel SSO, ayrı epik (OAuth2/SAML provider). Faz A-C sonrası.
- **#16 Tenable / vuln scan** — kullanıcı kendisi yapacak; bizim taraf sadece sonuç ingest endpoint'i olabilir.
- **#17 AI runtime sec-review + #18 denial audit** — passive AI security modu var; runtime davranış analizi ayrı küçük epik (Faz B'ye eklenebilir).
- **#9 tek merkezden sec-conf UI** — Faz C frontend'iyle birlikte doğal çözülür.
- **#10 cihaz isimlendirme** — bağımsız UI/UX, herhangi bir turda.

---

## Bağımlılık & sıra notu
- Faz A ve Faz B **bağımsız**, paralel gidebilir.
- Faz C, Faz A'nın feature-gate'ine ihtiyaç duyar (security_policy bir lisans modülü olacak).
- Önerilen: **A1 (feature enforcement) → B1 (network) + B4 (DR) → C** sırası.
