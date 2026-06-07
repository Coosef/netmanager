# Charon — Menü Yeniden Yapılandırma Analiz + Uygulama Planı

**Tarih:** 2026-06-08
**Source:** `Charon Menü Düzenlemesi.pdf` (2 sayfa Excel)
**Status:** **ANALİZ + PLAN** — kod yazılmadı. Kullanıcı GO sonrası implementation başlar.

---

## A. Mevcut menü / route envanteri (özet)

### A.1 Sidebar menü tanımı — tek kaynak

| Dosya | Rol |
|---|---|
| `frontend/src/components/Layout/useNavGroups.tsx` (195 satır) | **Tek kaynak**: 4 nav group + 54 öğe + permission/feature filtreleme |
| `frontend/src/components/Layout/Sidebar.tsx` (85 satır) | Sadece render (zaten filtreli liste alır) |
| `frontend/src/components/Layout/AppLayout.tsx` (164 satır) | NocWallProvider + AppHeader + Sidebar layout shell |
| `frontend/src/App.tsx` (343 satır) | Tüm `<Route>` config'i (57 protected + 2 unprotected) |
| `frontend/src/store/auth.ts` | `can(module, action)`, `canMutate`, `hasPermission(minRole)` |

### A.2 Mevcut 4 nav group + 54 öğe

| Grup | Öğe sayısı | İçerik |
|---|---:|---|
| **main** | 4 | Dashboard, Topology (+Gold variant), Devices |
| **discovery** | 8 | Discovery, IPAM, VLAN, Backups, ConfigDrift, Compliance, Racks, FloorPlan |
| **monitoring** | 24 | Monitor, Live, Intelligence, AlertRules, Bandwidth, MacArp, SecurityAudit, SecurityPolicies, AssetLifecycle, Diagnostics, Tasks, Playbooks, ConfigTemplates, ConfigBuilder, ChangeManagement, Approvals, SLA, PoE, Firmware, SyntheticProbes, Incidents, EscalationRules, Services, TopologyTwin, Reports |
| **management** | 12 | SuperAdmin, OrgAdmin, Permissions, AIAssistant, Agents, Users, Locations, Audit, TerminalSessions, DriverTemplates, Help, Settings |

### A.3 Tab pattern — mevcut 2 sayfa

| Sayfa | Tab key URL pattern | Default | Tab sayısı |
|---|---|---|---:|
| `/devices/:deviceId` | `?tab=<key>` | `overview` | 10 (overview/ports/security/vlan/mac/poe/events/backup/actions/terminal) |
| `/settings` | `?tab=<key>` | `general` | 13 (general/system/password-policy/notifications/alert-rules/maintenance/credentials/rotation/sla/snmp/api-tokens/driver-templates/ai) |

**Önemli:** Browser refresh sonrası `?tab=X` korunur, RBAC ile gizli tab'lar zaten filtreleniyor. Bu patern **yeni 12 menü için referans olacak**.

### A.4 i18n menu state

| Tip | Sayı |
|---|---:|
| t() ile çevrili (`nav.*`, `nav_group.*`) | 32 |
| Hardcoded Türkçe | 12 |

Hardcoded: "Topology · Gold", "Canlı İzleme", "Ağ Analitik", "Güvenlik Politikaları", "PoE / Enerji", "Firmware", "Synthetic Probes", "Incident RCA", "Escalation Kuralları", "Servis Etki Haritası", "Network Digital Twin", "⚙ Platform Paneli", "⚙ Organizasyon Paneli", "Yetki Yönetimi", "AI Ağ Asistanı", "SSH Oturum Audit"

### A.5 Permission filtering pattern

- `MODULE_MAP` (16 route): `'/devices' → ['devices', 'view']`, `'/monitor' → ['monitoring', 'view']`, ...
- `FEATURE_MAP` (14 anahtar): `topology`, `ipam`, `racks`, `agents`, `ai_assistant`, ...
- `useAuthStore.can(module, action)` veya `hasPermission(minRole)` her menü öğesinde tekrar değerlendiriliyor
- `useNavGroups()` zaten filtreli liste döner → Sidebar permission kontrolü yapmaz

---

## B. Excel hedef menü yapısı (12 ana menü)

Sayfa 1 (detaylı tab listesi) ve sayfa 2 (özet route + birleştirilen menüler) çapraz okunarak normalize edildi:

| # | Ana Menü (final isim önerisi) | Route | Tab sayısı | Tab'lar |
|---:|---|---|---:|---|
| 1 | **Dashboard** | `/` | — | Tek sayfa |
| 2 | **Ağ Envanteri** | `/inventory` | 7 | Switch, Topoloji, Keşif, IPAM, VLAN, Kabinler, Harita |
| 3 | **İzleme & Analitik** | `/monitoring` | 6 | Uyarılar, Canlı İzleme, Ağ Analitik, Bant Genişliği, Port Intelligence, Synthetic Probes |
| 4 | **Uyarı & Olay Yönetimi** | `/alerts` | 4 | Alert Kuralları, Escalation, Incident / RCA, Servis Etki Haritası |
| 5 | **Konfigürasyon Yönetimi** | `/config` | 6 | Config Drift, Config Şablonları, Config Builder, Yedekleme Merkezi, Firmware, Sürücü Şablonları |
| 6 | **Otomasyon & İş Akışları** | `/automation` | 4 | Görevler, Playbooks, Değişiklik Yönetimi, Onaylar |
| 7 | **Güvenlik & Uyumluluk** | `/security` | 4 | Güvenlik Denetimi, Güvenlik Politikaları, Uyumluluk, Asset Lifecycle |
| 8 | **Performans & Raporlar** | `/reports` | 4 | SLA & Uptime, PoE / Enerji, Raporlar, Network Digital Twin |
| 9 | **Operasyon Araçları** | `/tools` | 2 (veya 3) | Ağ Tanılama, AI Ağ Asistanı, **[opsiyonel: IP Scanner]** |
| 10 | **Kullanıcı & Erişim Yönetimi** | `/admin/users` | 4 | Kullanıcılar, Yetki Yönetimi, Lokasyonlar, Proxy Agents |
| 11 | **Denetim & Kayıtlar** | `/admin/audit` | 2 | Audit Log, SSH Oturum Audit |
| 12 | **Platform Yönetimi** | `/admin/platform` | 3 | Platform Paneli, Ayarlar, Yardım |

**Toplam tab: 46-47.** Excel sayfa 2 özetinde "47 ayrı menü → 12 ana menü, %75 azalma" iddiası **yanıltıcı** — toplam ekran sayısı 46-47 olarak kalıyor; sidebar düz öğe sayısı azalıyor (54 → 12). Doğru özet: **sidebar 54 → 12, içerik sayfa sayısı ~50 stabil**.

---

## C. Excel içi tutarsızlıklar (final isim önerisi ile)

### C.1 Ana menü isim farkları (sayfa 1 vs sayfa 2)

| # | Sayfa 1 | Sayfa 2 | Final öneri | Gerekçe |
|---:|---|---|---|---|
| 2 | Ağ Yönetimi | Ağ Envanteri | **Ağ Envanteri** | Daha kesin/teknik (sayfa 2 daha güncel detay özeti) |
| 3 | İzleme | İzleme & Analitik | **İzleme & Analitik** | Tab'lar arasında "Ağ Analitik" da var, kapsamı doğru yansıtıyor |
| 4 | Olay Yönetimi | Uyarı & Olay Yönetimi | **Uyarı & Olay Yönetimi** | Alert kuralları + Incident karışımı tek isimde |
| 9 | Araçlar | Operasyon Araçları | **Operasyon Araçları** | "Tools" tek başına generic; ops vurgusu net |
| 10 | Kullanıcı & Erişim | Kullanıcı & Erişim Yönetimi | **Kullanıcı & Erişim Yönetimi** | "Yönetimi" sufiksi konsistent (admin menüleriyle birlikte) |

### C.2 Tab adı farkları (sayfa 1 vs sayfa 2)

| Tab | Sayfa 1 | Sayfa 2 | Final öneri | Gerekçe |
|---|---|---|---|---|
| Monitor #5 | Port / MAC-ARP | Port Intelligence | **Port Intelligence** | Mevcut sayfa "MacArp" — semantik tek başına dar; "Port Intelligence" daha kapsamlı |
| Alerts #1 | Uyarı Kuralları | Alert Kuralları | **Uyarı Kuralları** | Türkçe tutarlılık (LANG-FIX kuralı: yabancı kelime → Türkçe) |
| Alerts #4 | Servis Etkisi | Servis Etki Haritası | **Servis Etki Haritası** | "Etkisi" tek başına soyut; "Etki Haritası" net |
| Config #4 | Yedekler | Yedekleme Merkezi | **Yedekleme Merkezi** | Mevcut sayfa adı `BackupCenter` |
| Security #2 | Politikalar | Güvenlik Politikaları | **Güvenlik Politikaları** | "Politikalar" generic; güvenlik bağlamı net |
| Reports #4 | Digital Twin | Network Digital Twin | **Network Digital Twin** | "Network" vurgusu doğru bağlam |
| Tools #2 | AI Asistan | AI Ağ Asistanı | **AI Ağ Asistanı** | Mevcut sayfa hardcoded "AI Ağ Asistanı" |
| Admin #1 (audit) | SSH Oturumları | SSH Oturum Audit | **SSH Oturum Audit** | "Audit" terimi mevcut sayfada da kullanılıyor |
| Admin Users #2 | Yetkiler | Yetki Yönetimi | **Yetki Yönetimi** | Mevcut sidebar zaten "Yetki Yönetimi" hardcoded |

### C.3 Sayı tutarsızlıkları

| Menü | Sayfa 1 | Sayfa 2 | Final | Detay |
|---|---:|---:|---:|---|
| Konfigürasyon Yönetimi | **5** (Config Drift, ?, Config Builder, Yedekler, Firmware — tab #2 atlanmış) | **6** (+Config Şablonları, +Sürücü Şablonları) | **6** | Sayfa 1'de numara atlamış (1, 3, 4, 5); kayıp olan muhtemelen "Config Şablonları". Sayfa 2'de "Sürücü Şablonları" da dahil edilmiş — final 6 tab. |
| Operasyon Araçları | **3** (+IP Scanner) | **2** | **2 + karar bekliyor** | IP Scanner sistemde YOK — yeni component gerekir; veya çıkarılır. **Kullanıcı kararı gerekir.** |

### C.4 Mevcut sistemde olan AMA Excel'de bahsi geçmeyen sayfalar

| Mevcut sayfa | Mevcut route | Önerilen hedef | Karar |
|---|---|---|---|
| LldpInventory | `/lldp-inventory` | Ağ Envanteri → Keşif altı? veya İzleme → ek tab? | ⏳ **Karar bekliyor** |
| Profile | `/profile` | Header dropdown'da kalır (sidebar dışı) | ✅ Sidebar'dan çıkar |
| InviteAccept | `/invite` | Unprotected, sidebar'da yok zaten | ✅ Dokunma |
| SshTerminalPage | `/ssh/:deviceId` | Quick Access ayrı tab → sidebar'da yok | ✅ Dokunma |

### C.5 Excel'de var AMA sistemde olmayan / belirsiz

| Excel öğesi | Sistem durumu | Karar gerekli |
|---|---|---|
| **Harita** (Ağ Envanteri #7) | Sistemde `FloorPlan` = "Kat Planı" var. "Harita" coğrafi mi yoksa kat planı mı? | ⏳ FloorPlan = Harita kabul edilir mi? |
| **IP Scanner** (Operasyon Araçları #3 sayfa 1) | Yok | ⏳ Yeni component yazılacak mı yoksa çıkarılacak mı? |
| **Switch** (Ağ Envanteri #1) | Excel notu "Burdaki yönetim ekranına PoE yönetimi de eklenebilir" — `Devices` sayfası mı? | ✅ Switch = Devices ('Cihazlar') kabul ediliyor (notes ile PoE eklemesi opsiyonel) |

### C.6 Mevcut sistemde olan Topology variantları

- `/topology` (TopologyPage) ve `/topology-next` (TopologyV2Page) feature flag ile swap
- Excel'de tek "Topoloji" — final: tek tab `/inventory?tab=topology`, içeride feature flag aynı kalır (kullanıcı görünür değişiklik yok)

### C.7 SuperAdmin vs OrgAdmin

| Mevcut | Excel | Karar |
|---|---|---|
| `/superadmin` (sadece super_admin görür) | "Platform Paneli" (Platform Yönetimi #1) | ✅ Tab #1 = Platform Paneli; sadece super_admin tarafından görülür |
| `/org-admin` (sadece org_admin görür, super_admin değil) | Yok | ⏳ Platform Yönetimi'ne 4. tab "Organizasyon Paneli" mi, yoksa Kullanıcı & Erişim altına mı? **Karar bekliyor.** |

---

## D. Mevcut vs hedef fark tablosu (master mapping)

> **Durum kodları:** ✅ **Aynen taşı** · 🔀 **Route koru + tab grouping** · 🆕 **Yeni wrapper page** · 🔧 **Component refactor** · ❓ **Karar gerekli** · ⛔ **Eksik (Excel'de var, sistemde yok)** · ➕ **Sistemde var, Excel'de yok**

### D.1 Yeni menü 1 — Dashboard (1 sayfa)

| Eski | Eski route | Component | Permission | Yeni route | Tab | Durum |
|---|---|---|---|---|---|---|
| Dashboard | `/` | DashboardPage | — | `/` | (tek sayfa) | ✅ Aynen taşı |

### D.2 Yeni menü 2 — Ağ Envanteri (7 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | Cihazlar (Switch) | `/devices` | DevicesPage | `devices/view` | `switch` | 🔀 Route koru + tab grouping |
| 2 | Topoloji | `/topology` (+ /topology-next FF) | TopologyPage / TopologyV2Page | feature: topology | `topology` | 🔀 |
| 3 | Keşif | `/discovery` | (Discovery page) | org_admin | `discovery` | 🔀 |
| 4 | IPAM | `/ipam` | IpamPage | `ipam/view` + feature: ipam | `ipam` | 🔀 |
| 5 | VLAN | `/vlan` | VlanManagementPage | viewer | `vlan` | 🔀 |
| 6 | Kabinler | `/racks` | RacksPage | org_admin + feature: racks | `racks` | 🔀 |
| 7 | Harita | `/floor-plan` | FloorPlanPage | org_admin | `map` | 🔀 + isim onayı bekliyor (Harita = FloorPlan?) |
| (— ) | LldpInventory | `/lldp-inventory` | LldpInventoryPage | viewer | — | ❓ Keşif altı 2. seviye mi yoksa ayrı tab mı? |

### D.3 Yeni menü 3 — İzleme & Analitik (6 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | Uyarılar | `/monitor` | MonitorPage | `monitoring/view` | `alerts` | 🔀 |
| 2 | Canlı İzleme | `/live` | LiveMonitorPage | `monitoring/view` | `live` | 🔀 |
| 3 | Ağ Analitik | `/intelligence` | IntelligencePage | viewer | `analytics` | 🔀 |
| 4 | Bant Genişliği | `/bandwidth` | BandwidthMonitorPage | `monitoring/view` | `bandwidth` | 🔀 |
| 5 | Port Intelligence | `/mac-arp` | MacArpPage | `monitoring/view` | `port` | 🔀 |
| 6 | Synthetic Probes | `/synthetic-probes` | SyntheticProbesPage | viewer | `probes` | 🔀 |

### D.4 Yeni menü 4 — Uyarı & Olay Yönetimi (4 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | Uyarı Kuralları | `/alert-rules` | AlertRulesPage | org_admin | `rules` | 🔀 |
| 2 | Escalation | `/escalation-rules` | EscalationRulesPage | org_admin | `escalation` | 🔀 |
| 3 | Incident / RCA | `/incidents` | IncidentsPage | viewer | `incidents` | 🔀 |
| 4 | Servis Etki Haritası | `/services` | ServicesPage | viewer | `services` | 🔀 |

### D.5 Yeni menü 5 — Konfigürasyon Yönetimi (6 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | Config Drift | `/config-drift` | ConfigDriftPage | viewer | `drift` | 🔀 |
| 2 | Config Şablonları | `/config-templates` | ConfigTemplatesPage | `driver_templates/view` | `templates` | 🔀 |
| 3 | Config Builder | `/config-builder` | ConfigBuilderPage | `config_backups/view` | `builder` | 🔀 |
| 4 | Yedekleme Merkezi | `/backups` | BackupCenterPage | location_admin | `backups` | 🔀 |
| 5 | Firmware | `/firmware` | FirmwarePage | org_admin | `firmware` | 🔀 |
| 6 | Sürücü Şablonları | `/driver-templates` | DriverTemplatesPage | `driver_templates/view` | `drivers` | 🔀 + KORUMA: W1-F'de "DriverTemplates dokunulmaz" kuralı uygulanmıştı; **sadece tab grouping olur, içerik dokunulmaz** |

### D.6 Yeni menü 6 — Otomasyon & İş Akışları (4 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | Görevler | `/tasks` | TasksPage | `tasks/view` | `tasks` | 🔀 |
| 2 | Playbooks | `/playbooks` | PlaybooksPage | `playbooks/view` | `playbooks` | 🔀 |
| 3 | Değişiklik Yönetimi | `/change-management` | ChangeManagementPage | location_admin | `change` | 🔀 |
| 4 | Onaylar | `/approvals` | ApprovalsPage | location_manager | `approvals` | 🔀 + Badge (mevcut) korunur |

### D.7 Yeni menü 7 — Güvenlik & Uyumluluk (4 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | Güvenlik Denetimi | `/security-audit` | SecurityAuditPage | viewer | `audit` | 🔀 |
| 2 | Güvenlik Politikaları | `/security-policies` | SecurityPoliciesPage | viewer | `policies` | 🔀 |
| 3 | Uyumluluk | `/compliance` | ComplianceCheckPage | location_admin | `compliance` | 🔀 |
| 4 | Asset Lifecycle | `/asset-lifecycle` | AssetLifecyclePage | viewer | `lifecycle` | 🔀 |

### D.8 Yeni menü 8 — Performans & Raporlar (4 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | SLA & Uptime | `/sla` (+ `/sla-report`) | SlaPage / SlaReportPage | viewer | `sla` | 🔀 + `/sla-report` semantik üst → tek tab |
| 2 | PoE / Enerji | `/poe` | PoeDashboardPage | viewer | `poe` | 🔀 |
| 3 | Raporlar | `/reports` | ReportsPage | `reports/view` | `reports` | 🔀 |
| 4 | Network Digital Twin | `/topology-twin` | TopologyTwinPage | location_admin | `twin` | 🔀 |

### D.9 Yeni menü 9 — Operasyon Araçları (2-3 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | Ağ Tanılama | `/diagnostics` | DiagnosticsPage | viewer | `diagnostics` | 🔀 |
| 2 | AI Ağ Asistanı | `/ai-assistant` | AIAssistantPage | org_admin + feature: ai_assistant | `ai` | 🔀 |
| 3 | IP Scanner | — | — | — | `scanner` | ⛔ **Excel'de var, sistemde yok. Karar gerekli: yeni component yazılacak mı veya çıkarılacak mı?** |

### D.10 Yeni menü 10 — Kullanıcı & Erişim Yönetimi (4 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | Kullanıcılar | `/users` | UsersPage | `users/view` | `users` | 🔀 |
| 2 | Yetki Yönetimi | `/permissions` | PermissionsPage | org_admin | `permissions` | 🔀 |
| 3 | Lokasyonlar | `/locations` | LocationsPage | `locations/view` | `locations` | 🔀 |
| 4 | Proxy Agents | `/agents` | AgentsPage | org_admin + feature: agents | `agents` | 🔀 |

### D.11 Yeni menü 11 — Denetim & Kayıtlar (2 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | Audit Log | `/audit` | AuditLogPage | `audit_logs/view` | `audit` | 🔀 |
| 2 | SSH Oturum Audit | `/terminal-sessions` | TerminalSessionsPage | viewer | `ssh` | 🔀 — **W1-F1 i18n + revert sonrası read-only ekran korundu** |

### D.12 Yeni menü 12 — Platform Yönetimi (3 tab)

| # | Eski | Eski route | Component | Permission | Tab key | Durum |
|---:|---|---|---|---|---|---|
| 1 | Platform Paneli | `/superadmin` | SuperAdminPage | super_admin | `platform` | 🔀 |
| (— ) | Organizasyon Paneli | `/org-admin` | OrgAdminPage | org_admin (sadece, super_admin değil) | — | ❓ **Karar gerekli:** Platform Yönetimi 4. tab mı yoksa Kullanıcı & Erişim Yönetimi'ne mi? |
| 2 | Ayarlar | `/settings` | SettingsPage (13 tab) | `settings/view` | `settings` | 🔀 — **dikkat: nested tabs (ana tab + alt 13 tab)** |
| 3 | Yardım | `/help` | HelpPage | herkese | `help` | 🔀 |

### D.13 Sidebar'dan çıkarılacak (ana akış değişimi)

| Sayfa | Şu an nerede | Yeni durum |
|---|---|---|
| Profile | Header dropdown'da zaten | ✅ Dokunma |
| Login | Unprotected, sidebar'da yok | ✅ Dokunma |
| InviteAccept | Unprotected, sidebar'da yok | ✅ Dokunma |
| SshTerminalPage | Quick Access yeni tab, sidebar'da yok | ✅ Dokunma |
| DeviceDetailPage | `/devices/:id` — DevicesPage'den drill-down, sidebar'da değil | ✅ Dokunma (devices listesinden açılır) |

### D.14 Birinci dalga durumu özeti

| Durum | Sayı |
|---|---:|
| 🔀 Route koru + tab grouping | **45** |
| ✅ Aynen taşı (Dashboard) | 1 |
| ⛔ Excel'de var, sistemde yok (IP Scanner) | 1 |
| ❓ Karar bekliyor (Harita, LldpInventory, OrgAdmin, Ayarlar nested) | 4 |
| ✅ Sidebar'dan çıkar (Profile, Login, vd.) | 5 |

---

## E. Route stratejisi — A vs B karşılaştırma

### E.1 Plan A — Mevcut route'ları koru, sadece sidebar grouping + tab navigation değiştir

**Yaklaşım:**
- Sidebar 12 ana grup gösterir
- Her ana grup tıklanınca **ilk tab'ın eski route'una** gider (`/inventory` → `/devices`)
- Sayfa içinde tab navigation, ama her tab eski route'una bağlı
- URL'de `/inventory` yok; sadece `/devices`, `/topology`, vs.

**Artılar:**
- ✅ **Sıfır URL değişimi** — kullanıcı bookmark'ları, log link'leri, dokümantasyon HEP çalışır
- ✅ **Permission/RBAC mantığı değişmez** — her route'un kendi gate'i var
- ✅ **Deep link backward compat** — `/devices/42?tab=ports` aynen çalışır
- ✅ **Audit log resource_path geçmiş** korunur (path bazlı history)
- ✅ **Test riski minimum** — sadece UI rendering değişir
- ✅ **Rollback kolay** — sidebar import değiştir, eski state geri gelir

**Eksiler:**
- ⚠ Tab navigation için ayrı bir component katmanı gerekir (`<MenuGroupNav active={...}>`)
- ⚠ "Hangi tab aktif?" mantığı pathname tabanlı (route → grup mapping)
- ⚠ Sayfanın kendi içinde başlık değişmez (örn. `/devices` page header "Cihazlar" der, "Ağ Envanteri > Switch" demez)

### E.2 Plan B — Yeni ana route'lar, tab içeride

**Yaklaşım:**
- `/inventory`, `/monitoring`, `/alerts`, `/config`, `/automation`, `/security`, `/reports`, `/tools`, `/admin/users`, `/admin/audit`, `/admin/platform`, `/`
- Her ana route bir wrapper page açar (örn. `InventoryPage`)
- Wrapper tab navigation render eder ve aktif tab'a göre eski component'i render eder
- URL'de `/inventory?tab=switch` veya `/inventory/switch`
- Eski URL'ler (`/devices`, `/topology`, ...) **redirect** edilir

**Artılar:**
- ✅ URL semantik olarak hedef yapıyla aynı (sayfa hiyerarşisi netleşir)
- ✅ Browser tab başlığı doğru menü adını gösterir
- ✅ Tek wrapper sayesinde tab visibility (RBAC ile) merkezi
- ✅ Yeni hierarchy `<breadcrumb>` doğal: "Ağ Envanteri > Switch"

**Eksiler:**
- ❌ **57 route redirect** gerekiyor (`/devices` → `/inventory?tab=switch`)
- ❌ **Bookmark / dokumentasyon backward compat** — kullanıcı eski linkleri açtığında 301 redirect; bazı eski entegrasyon (örn. AI Assistant'ın `/devices/42` döndürdüğü link) hâlâ çalışır ama URL gözünde değişir
- ❌ Audit log resource_path geçmişi nested olur (yeni format)
- ❌ **Deep tabs çakışması:** `/devices/:deviceId?tab=ports` zaten "tab" parametresi kullanıyor — `/inventory?tab=switch&deviceId=42&tab=ports` mı, yoksa `/inventory/switch/devices/42?tab=ports` mi? Karmaşıklık artar
- ❌ Wrapper component her ana grup için 1 dosya = **12 yeni wrapper**
- ❌ **Settings (13 nested tab) wrapper'da** = 12 ana menü + Settings 1 nested = "/admin/platform?tab=settings" sonra alt tab "/admin/platform?tab=settings&sub=general" gibi 2 seviye tab → karmaşık
- ❌ Test yüzeyi büyür: 12 wrapper + 57 redirect testi

### E.3 Karar matrisi

| Kriter | Plan A | Plan B | Kazanan |
|---|---|---|---|
| Backward compatibility (bookmark, links) | ✅ Sıfır kırılma | ⚠ 301 redirect (bazıları kırılabilir) | **A** |
| Permission/RBAC değişimi | ✅ Sıfır | ⚠ Tab visibility merkezi (riskli refactor) | **A** |
| Audit log path history | ✅ Korunur | ⚠ Yeni format | **A** |
| Deep link (`/devices/42?tab=ports`) | ✅ Aynen | ❌ Çakışma riski | **A** |
| Wrapper component sayısı | 1 generic `<MenuGroupNav>` | 12 wrapper page | **A** |
| URL semantik temizlik | ❌ Eski URL'ler kalır | ✅ Hiyerarşi net | **B** |
| Browser tab title doğru menü | ❌ Page title değişmez | ✅ Net | **B** |
| Test yüzeyi | Küçük (sadece sidebar + nav) | Büyük (12 wrapper + 57 redirect) | **A** |
| Rollback süresi | <5dk | ~30dk (route diff) | **A** |
| LLM/AI link üretimi (sistem içi) | Aynı kalır | Yeni URL üretim gerekir | **A** |
| Settings nested tabs (13 alt tab) | ✅ Mevcut yapı korunur | ❌ Karmaşa | **A** |

**KARAR (öneri): Plan A.** Mevcut route'ları koru, sidebar grouping + sayfa içi navigation patern'i değişsin. URL semantik olarak "/admin/platform" kadar temiz değil ama operasyonel risk minimal.

**Hibrit alternatif (orta yol):**
- 12 ana menü için sidebar grup adı + ilk tab'a yönlendir
- Sayfa header'da breadcrumb "Ağ Envanteri > Switch" göster (URL değişmeden)
- İçeride `<MenuGroupNav>` (alt menü/tab navigation) gösterir, her tab eski route'una `<Link>`
- URL temizliği için gelecekte (W3+ aşamasında) Plan B'ye taşınabilir

---

## F. Permission/RBAC etkisi

### F.1 Mevcut katmanlar (Plan A ile değişmez)

1. **App.tsx route guards** — `<ProtectedRoute>`, `<RoleRoute minRole=...>`, `<PermRoute module action>` — her route'un kendi gate'i kalır
2. **useAuthStore.can(module, action)** — page-level + UI-level kontrol
3. **MODULE_MAP** (useNavGroups) — sidebar visibility (artık sidebar düz öğe değil, grup olduğu için MAP yeni grup düzeyinde olur)
4. **FEATURE_MAP** — feature flag visibility (aynen kalır)

### F.2 Plan A için RBAC değişim önerisi

**Mevcut:**
```ts
MODULE_MAP[ '/devices' ] = ['devices', 'view']
MODULE_MAP[ '/users' ]   = ['users', 'view']
```

**Yeni (grup düzeyinde):**
```ts
// Ana grup visibility
GROUP_VISIBILITY = {
  inventory: ['devices:view', 'discovery:view', 'ipam:view', ...]  // herhangi biri varsa grup görünür
  monitoring: ['monitoring:view', ...]
  alerts: ['monitoring:view', 'incidents:view', ...]
  ...
}

// Tab-level RBAC mevcut kalır
TAB_VISIBILITY[ '/inventory' ][ 'switch' ] = ['devices', 'view']
```

**Karar:**
- **Page-level permission korunur** (mevcut route guards aynen)
- **Tab-level visibility** zaten route'a bağlı (kullanıcının izni yoksa zaten route'a giremez)
- **Grup-level visibility** — kullanıcının grupta hiç bir tab izni yoksa grup gizli (sidebar'da görünmez)

**Risk:** Bir kullanıcı bir gruba tıkladığında **ilk tab'ın izni yoksa** boş sayfa veya redirect senaryosu — `<MenuGroupNav>` ilk YETKİLİ tab'ı seçer.

### F.3 Mevcut permission key'leri korunur

Hiçbir backend permission key değişmiyor:
- `devices:view/create/edit/delete/connect/move`
- `monitoring:view`
- `users:view/edit/...`
- `settings:view/edit`
- `audit_logs:view`
- `tasks:view/create/cancel`
- `playbooks:view/run/edit/delete`
- vs.

Frontend'de yalnız **sidebar grup visibility helper** eklenir (yeni function: `canSeeGroup(groupKey)`).

### F.4 Önerilen kural

> **Mevcut page-level permission'lar olduğu gibi korunur.** Yalnız sidebar grupları için yeni `canSeeGroup(groupKey)` helper'ı useNavGroups'a eklenir. Tab içeride zaten route guard çalışır.

---

## G. i18n key planı

### G.1 Yeni i18n key'leri — locale × dil × key sayısı

**Ana menü grup adları (12):**
```
nav.group.dashboard
nav.group.inventory           ("Ağ Envanteri")
nav.group.monitoring           ("İzleme & Analitik")
nav.group.alerts               ("Uyarı & Olay Yönetimi")
nav.group.config               ("Konfigürasyon Yönetimi")
nav.group.automation           ("Otomasyon & İş Akışları")
nav.group.security             ("Güvenlik & Uyumluluk")
nav.group.reports              ("Performans & Raporlar")
nav.group.tools                ("Operasyon Araçları")
nav.group.admin_users          ("Kullanıcı & Erişim Yönetimi")
nav.group.admin_audit          ("Denetim & Kayıtlar")
nav.group.admin_platform       ("Platform Yönetimi")
```

**Tab adları (47 — her grupta hız değişiyor):**
```
nav.tab.inventory.switch
nav.tab.inventory.topology
nav.tab.inventory.discovery
nav.tab.inventory.ipam
nav.tab.inventory.vlan
nav.tab.inventory.racks
nav.tab.inventory.map
nav.tab.monitoring.alerts
nav.tab.monitoring.live
nav.tab.monitoring.analytics
nav.tab.monitoring.bandwidth
nav.tab.monitoring.port_intelligence
nav.tab.monitoring.probes
nav.tab.alerts.rules
nav.tab.alerts.escalation
nav.tab.alerts.incidents
nav.tab.alerts.services
nav.tab.config.drift
nav.tab.config.templates
nav.tab.config.builder
nav.tab.config.backups
nav.tab.config.firmware
nav.tab.config.drivers
nav.tab.automation.tasks
nav.tab.automation.playbooks
nav.tab.automation.change
nav.tab.automation.approvals
nav.tab.security.audit
nav.tab.security.policies
nav.tab.security.compliance
nav.tab.security.lifecycle
nav.tab.reports.sla
nav.tab.reports.poe
nav.tab.reports.reports
nav.tab.reports.twin
nav.tab.tools.diagnostics
nav.tab.tools.ai
[nav.tab.tools.scanner]        # karar bekler
nav.tab.admin_users.users
nav.tab.admin_users.permissions
nav.tab.admin_users.locations
nav.tab.admin_users.agents
nav.tab.admin_audit.logs
nav.tab.admin_audit.ssh
nav.tab.admin_platform.platform
nav.tab.admin_platform.settings
nav.tab.admin_platform.help
[nav.tab.admin_platform.org]    # karar bekler
```

**Toplam yeni key: 12 grup + 47 tab = 59 anahtar × 4 dil = ~236 yeni çeviri satırı.**

### G.2 LANG-FIX W2 ile çakışma

- W2 sprint'te zaten Agents/Monitor/Topology/Playbooks/BackupCenter/Reports sayfa içerikleri çevrilecek
- **Menü grup + tab adları ayrı PR'da olabilir** — daha küçük, deploy bağımsız (sadece i18n + sidebar değişimi)
- Önerilen ordering: önce menü grup + tab i18n (~250 satır), sonra W2 sayfa içeriği

### G.3 Mevcut hardcoded menu adları zaten temizleniyor

12 hardcoded label (Topology · Gold, Canlı İzleme, ... Yetki Yönetimi, ...) bu refactor sırasında t() ile değiştirilecek → **otomatik yan kazanım**: W1-F sonrası menu hardcoded sayısı **0'a inecek**.

### G.4 Parity garantisi

- W1 / W1-F i18n kuralı: tr/en/de/ru aynı PR'da güncellenmeli, **widening = 0**
- LANG-FIX kuralı: backend enum / vendor adı / akronim RAW → tab key'ler (`switch`, `topology`, `vlan`, `racks`) raw kalır, sadece label'lar çevrilir

---

## H. UI/UX tasarım planı

### H.1 Sidebar — yeni yapı

```
┌─────────────────────────────┐
│ 🏠 Dashboard                │   1 ana öğe
├─────────────────────────────┤
│ 📡 Ağ Envanteri             │   Ana menü grup
│ 📊 İzleme & Analitik        │
│ ⚠  Uyarı & Olay Yönetimi    │
│ ⚙  Konfigürasyon Yönetimi   │
│ 🔄 Otomasyon & İş Akışları  │
│ 🔒 Güvenlik & Uyumluluk     │
│ 📈 Performans & Raporlar    │
│ 🛠  Operasyon Araçları       │
│ 👥 Kullanıcı & Erişim Yön.  │
│ 📋 Denetim & Kayıtlar       │
│ 🏗  Platform Yönetimi        │
└─────────────────────────────┘
```

12 sidebar öğesi (mevcut 54 → 12, **%78 azalma**).

### H.2 Sayfa içi navigation — `<MenuGroupNav>` component

Ana menü tıklanınca açılan sayfanın üstünde sekme stripi:

```
┌──────────────────────────────────────────────────────────┐
│ 📡 Ağ Envanteri                                          │
├──────────────────────────────────────────────────────────┤
│ [Switch] [Topoloji] [Keşif] [IPAM] [VLAN] [Kabinler] [Harita] │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ... aktif tab içeriği (DevicesPage / TopologyPage / vs) │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Pattern:** AntD `<Tabs>` ile aynı, ya da custom `<MenuGroupNav>` (mevcut `nm-tabs` CSS class'ı kullanır).

### H.3 URL stratejisi

> Plan A önerildi: **mevcut URL'ler korunur**. Tab "aktif" durumu pathname'den hesaplanır.

| Kullanıcı tıklar | URL | `<MenuGroupNav>` aktif tab |
|---|---|---|
| Sidebar: "Ağ Envanteri" | `/devices` (ilk yetkili tab) | Switch |
| MenuGroupNav: "Topoloji" | `/topology` | Topoloji |
| Tarayıcı refresh | `/topology` aynen kalır | Topoloji |
| Direkt URL `/ipam` | `/ipam` | İzleme & Analitik IPAM aktif... NO, **Ağ Envanteri** aktif (IPAM tab) |

**Sidebar aktif grup hesaplama:**
- `ROUTE_TO_GROUP = { '/devices': 'inventory', '/topology': 'inventory', '/ipam': 'inventory', ... }`
- Sidebar `pathname` → `ROUTE_TO_GROUP[pathname]` → aktif grup highlight

### H.4 Browser refresh + deep link

- `?tab=` parametresi mevcut Settings + DeviceDetail için kullanılıyor; yeni MenuGroupNav için **pathname kullanılır** (URL clean kalır)
- Refresh sonrası kullanıcı son sayfada kalır
- Doğrudan URL açma: `/playbooks` → Otomasyon grubu sidebar'da highlighted, MenuGroupNav'da Playbooks tab aktif

### H.5 Yetkisi olmayan tab gizleme

```
inventory grubu için:
  visibleTabs = [t for t in TABS if can(t.route)]
  
  if visibleTabs.isEmpty:
    hideGroup()    # sidebar'dan grup kaybolur
  else:
    showGroup()
    activeTab = visibleTabs.find(t => t.route === pathname) ?? visibleTabs[0]
```

### H.6 Ana menü tıklanınca davranış

| Senaryo | Davranış |
|---|---|
| Kullanıcı Ağ Envanteri'ne tıklar | `/devices`'a yönlenir (ilk yetkili tab) |
| İlk tab Switch ama izin yok | `/topology`'ye (ikinci yetkili) yönlenir |
| Tüm tab'ların izni yok | Grup zaten sidebar'da yok → bu durumda olamaz |

### H.7 Mobile / dar viewport

- Sidebar collapsed → 12 ikon
- Tab strip horizontal scroll
- Tab name uzun olursa kısaltma (tooltip ile tam ad)

### H.8 Settings nested tabs sorunu

`/settings` zaten kendi içinde 13 tab kullanıyor (`?tab=general` vs.). Plan A'da:
- Sidebar: Platform Yönetimi → Ayarlar tab aktif
- MenuGroupNav stripi: [Platform Paneli] [**Ayarlar**] [Yardım]
- Sayfa içerik: SettingsPage 13 nested tab (sol dikey nav)
- URL: `/settings?tab=general`

Karmaşık değil, sadece **iki seviye tab navigation**:
- Üst (yatay): MenuGroupNav → "Ayarlar" tab aktif
- Sol (dikey): SettingsPage 13 tab → "general" aktif

---

## I. Risk analizi

| # | Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|---|
| 1 | **Audit log resource_path** geçmişi etkilenir | DÜŞÜK (Plan A) | DÜŞÜK | Plan A path değiştirmiyor; sıfır etki |
| 2 | Kullanıcı bookmark'ları kırılır | DÜŞÜK (Plan A) | DÜŞÜK | Plan A path koruyor; ✅ |
| 3 | Sidebar visibility helper bug → yetkili grup gizli | ORTA | YÜKSEK | Unit test her grup için (canSeeGroup); manual smoke (4 rol × 12 grup = 48 hücre) |
| 4 | Browser refresh sonrası aktif tab yanlış | DÜŞÜK | DÜŞÜK | Pathname-based active hesaplama deterministik |
| 5 | i18n key 59 yeni, 4 dil = 236 satır → çeviri kalitesi | ORTA | DÜŞÜK | tr (baseline) + en/de/ru sync yapılır; W1-F deploy paterni |
| 6 | Mevcut hardcoded 12 menu label aynı PR'da temizlenir → scope büyür | DÜŞÜK | DÜŞÜK | Aynı PR'da yapılması daha tutarlı (12 yeni key sayma haricinde net azalma) |
| 7 | DriverTemplates W1-F'de "dokunulmaz" kuralı vardı; tab grouping yeterli mi? | DÜŞÜK | DÜŞÜK | Sadece sidebar grup → DriverTemplates tab'ı; sayfa içeriği DOKUNULMAZ |
| 8 | LldpInventory hangi grupta? | DÜŞÜK | DÜŞÜK | Karar bekliyor: Keşif altı veya İzleme tab ek; varsayılan: Keşif altı 2. seviye (tek ekstra menü yok) |
| 9 | IP Scanner mevcut değil | DÜŞÜK | DÜŞÜK | Karar bekliyor: kullanıcı çıkar/yaz |
| 10 | OrgAdmin (Organizasyon Paneli) konumu | DÜŞÜK | ORTA | Platform Yönetimi 4. tab — sadece org_admin görür; super_admin "Platform Paneli" görür |
| 11 | Topology V1/V2 feature flag swap karmaşası | DÜŞÜK | DÜŞÜK | Mevcut FF mantığı korunur, sadece tab key `topology` ile temsil edilir |
| 12 | SSH Termination revert hatırlatma — TerminalSessions ekranı dokunulmaz | DÜŞÜK | DÜŞÜK | Read-only TerminalSessions ekranı W1-F1 i18n + revert sonrası stabil; sadece tab grouping |
| 13 | Mevcut "menu-top" alternatif layout (kullanıcı tercihi) etkilenir mi? | DÜŞÜK | DÜŞÜK | Sidebar component'inde grup yapısı dönüşür; menu-top için aynı grup mantığı render edilir (custom TopNav) |
| 14 | Feature flag (canonical, V2) ile çakışma | DÜŞÜK | DÜŞÜK | FEATURE_MAP kalır; grup içinde tab'ın FF olması normal |
| 15 | Sidebar yeniden render → mevcut state (lastNocFollowed, vd.) reset olabilir | DÜŞÜK | DÜŞÜK | useNavGroups değişimi sadece data shape değişimi, state yönetimi etkilenmez |

**Toplam risk: DÜŞÜK-ORTA.** En önemli risk #3 (sidebar visibility bug) — kapsamlı test ile elimine edilir.

---

## J. Değişecek dosyalar

### J.1 Plan A (önerilen) — minimum değişiklik

| Dosya | Tip | Tahmini Δ LOC | Açıklama |
|---|---|---:|---|
| `frontend/src/components/Layout/useNavGroups.tsx` | **Refactor** | ~150 (mevcut 195) | 4 nav_group → 12 grup; menu items grup içine yerleşir |
| `frontend/src/components/Layout/Sidebar.tsx` | Küçük | ~10 | Sadece nested item rendering desteği (zaten array bazlı) |
| `frontend/src/components/Layout/MenuGroupNav.tsx` | **YENI** | ~80 | Sayfa içi yatay tab navigation component |
| `frontend/src/components/Layout/AppLayout.tsx` | Küçük | ~15 | Wrapper'ı her sayfada gösterecek (Outlet öncesi) |
| `frontend/src/i18n/locales/tr.json` | Genişletme | +60 satır | 12 grup + 47 tab key (+ silinen 12 hardcoded) |
| `frontend/src/i18n/locales/en.json` | Genişletme | +60 | Aynı |
| `frontend/src/i18n/locales/de.json` | Genişletme | +60 | Aynı |
| `frontend/src/i18n/locales/ru.json` | Genişletme | +60 | Aynı |
| `frontend/src/utils/menuGroups.ts` | **YENI** | ~80 | `ROUTE_TO_GROUP`, `GROUP_DEFINITIONS`, `getActiveGroup(pathname)`, `canSeeGroup(authStore)` helpers |
| `frontend/src/components/Layout/TopNav.tsx` (varsa menu-top layout) | Küçük | ~10 | menu-top için grup adapter |

**Toplam tahmini:** ~500 LOC kod + 240 i18n satır.

### J.2 Plan A için DOKUNULMAYACAK

- `frontend/src/App.tsx` (routes aynen kalır, yalnız Outlet AppLayout'tan geçer)
- Her sayfanın kendi component'i (`DevicesPage`, `IpamPage`, `MonitorPage`, ...) → **dokunulmaz**
- `useAuthStore` permission helpers → mevcut `can`, `canMutate` yeterli
- Backend kod / API / migration → **sıfır değişiklik** (bu pure frontend refactor)
- DeviceDetail'ın 10-tab yapısı → dokunulmaz
- Settings'in 13-tab yapısı → dokunulmaz

### J.3 Test dosyaları

| Dosya | Tip | Adet |
|---|---|---:|
| `Layout/__tests__/useNavGroups.test.tsx` | Yeni | 1 — 12 grup için visibility, 4 rol için group/tab filter |
| `Layout/__tests__/MenuGroupNav.test.tsx` | Yeni | 1 — tab visibility, active state, tıklama → route |
| `utils/__tests__/menuGroups.test.ts` | Yeni | 1 — `ROUTE_TO_GROUP` lookup, `canSeeGroup` |

Tahmini: **3 yeni test dosyası, ~30 test**.

---

## K. Uygulama fazları

### Faz 1 — Karar netleştirme (BU FAZ — kod yok)

| Adım | Çıktı |
|---|---|
| 1.1 Bu plan dokümanı PR'ı | Plan onayı |
| 1.2 Tutarsızlık kararları | 4 açık soru karara bağlanır (D.13 + C.4 + C.5) |
| 1.3 Karar matrisi: Plan A vs B | Plan A onayı (öneri) |

**4 açık karar:**
1. **Harita = FloorPlan kabul ediliyor mu?** (Ağ Envanteri #7)
2. **IP Scanner — yazılacak mı yoksa çıkarılacak mı?** (Operasyon Araçları)
3. **LldpInventory hangi grupta?** (Keşif altı / İzleme tab ek / sidebar dışı)
4. **OrgAdmin (Organizasyon Paneli) — Platform Yönetimi 4. tab mı, sidebar dışı mı?**

### Faz 2 — Helper + i18n (1 PR)

| Adım | Çıktı |
|---|---|
| 2.1 `utils/menuGroups.ts` — GROUP_DEFINITIONS, ROUTE_TO_GROUP, helper'lar | Yeni dosya |
| 2.2 i18n key'ler (60 yeni × 4 dil) | 4 locale güncellenir |
| 2.3 i18n:check widening = 0 doğrula | Pipeline yeşil |
| 2.4 Helper unit test | Test PASS |

**Bu fazda kullanıcı görmez** — sadece kod hazırlık.

### Faz 3 — Sidebar + MenuGroupNav (1 PR)

| Adım | Çıktı |
|---|---|
| 3.1 `useNavGroups.tsx` refactor — 12 grup yapısı | Eski 4 grup mantığı → 12 grup |
| 3.2 Sidebar küçük adapt (nested item gösterme) | Render değişimi |
| 3.3 `MenuGroupNav.tsx` yeni component | Tab strip |
| 3.4 AppLayout'a wrapper enjekte | Her sayfa üstünde tab strip |
| 3.5 Manuel smoke (4 rol × 12 grup) | Visual verification |

### Faz 4 — Test + Deploy

| Adım | Çıktı |
|---|---|
| 4.1 vitest + tsc + build + i18n:check yeşil | Pipeline |
| 4.2 PR review + merge | Main güncelleme |
| 4.3 Frontend-only deploy (W1-F paterni) | Backend dokunmaz |
| 4.4 Browser smoke (kullanıcı manuel) | Production onay |

### Faz 5 — Cleanup (opsiyonel)

- Hardcoded 12 menu label son temizlik (zaten Faz 3'te yapılır)
- Dokumentasyon güncellemesi
- Memory entry

---

## L. Test planı

### L.1 Backend testleri — etkilenen YOK

Bu refactor pure frontend. Backend pytest **dokunulmaz**.

### L.2 Frontend testleri

| Tip | Detay |
|---|---|
| **Unit (vitest)** | `useNavGroups` 12 grup × 4 rol = 48 senaryo (görünür/gizli) |
| **Unit (vitest)** | `canSeeGroup`/`getActiveGroup` helper test |
| **Unit (vitest)** | `MenuGroupNav` aktif state, RBAC filter, tıklama |
| **Component (vitest)** | Sidebar render — 12 öğe + permission filter |
| **TypeScript (tsc)** | 0 hata |
| **Build (vite)** | success |
| **i18n parity (npm run i18n:check)** | 201 sabit, widening = 0 (60 yeni key 4 dile eşit eklenir) |
| **E2E pattern (mevcut yok ama)** | manual browser smoke |

**Hedef:** Mevcut 232 testten **0 regression**, **30 yeni test** ekle = 262 toplam.

### L.3 Manuel smoke (deploy sonrası)

4 rol × 12 grup = **48 hücre** kontrol matrisi:

| Rol | Dashboard | Ağ Env. | İzleme | Uyarı | Config | Otom. | Güvenlik | Raporlar | Araçlar | Kullanıcı | Denetim | Platform |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| super_admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| org_admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | partial |
| location_admin | ✓ | partial | ✓ | partial | partial | partial | ✓ | ✓ | ✓ | hide | ✓ | hide |
| viewer | ✓ | partial | ✓ | hide | partial | hide | ✓ | ✓ | ✓ | hide | partial | hide |

**Her hücrede:**
- Sidebar'da grup görünür mü
- Tıklayınca ilk yetkili tab'a gidiyor mu
- MenuGroupNav'da yalnız yetkili tab'lar görünür mü
- URL pathname doğru group highlight ediyor mu
- Browser refresh sonrası state korunur mu
- 4 dil (tr/en/de/ru) label doğru çevirili mi
- Console "missing-key" warning yok

### L.4 Visual regression (manuel)

- Sidebar collapsed/expanded toggle çalışır mı
- menu-top layout (alternatif) çalışır mı
- Mobile viewport (dar ekran) tab strip overflow scroll
- DeviceDetail 10-tab + Settings 13-tab nested davranış (bozulmamış)

---

## M. Deploy / rollback planı

### M.1 Deploy stratejisi

**Frontend-only deploy** (W1-F paterni ile aynı).

| Faz | Aksiyon |
|---|---|
| P0 | Anchor + 1 rollback tag (sadece frontend) — `netmanager-frontend:rollback-pre-menu-restructure-<TS>` |
| P1 | `git fetch + ff-merge` |
| P2 | `docker compose build frontend` (~4-5dk vite + PWA) |
| P3 | `docker compose up -d --no-deps frontend` (~7sn) |
| P4 | Smoke: `/health/ready` + 7 HTTP route + bundle hash |
| P5 | Servis matrisi (10 servis UNCHANGED) |
| P6 | Deploy log dokümanı |

**Backend rebuild GEREKMEZ.** Postgres/Redis/Celery/Nginx **dokunulmaz**, `--no-deps` zorunlu.

### M.2 Rollback

```bash
docker tag netmanager-frontend:rollback-pre-menu-restructure-<TS> netmanager-frontend:latest
docker compose up -d --no-deps frontend
git reset --hard <pre-merge-SHA>
```

Süre: ~30-60sn.

### M.3 Rollback eşikleri

- Sidebar render fail (grup boş veya tüm öğeler gizli)
- Tab navigation crash
- i18n missing-key console warning (4 dilden birinde)
- Permission gate fail (kullanıcı görmesi gereken grubu görmüyor veya tersi)
- Browser refresh sonrası beyaz ekran

### M.4 Feature flag — gerekli mi?

**Karar: HAYIR, feature flag gerekmez.**

Gerekçe:
- Plan A geri uyumlu — URL'ler aynı, deep link'ler çalışır
- Permission/RBAC değişmiyor
- Risk profili düşük (sidebar visibility bug en kötü senaryo)
- Rollback hızlı (~30sn)
- Feature flag ekleme = 2x kod yolu (eski sidebar + yeni sidebar) → karmaşa artar

**Direkt geçiş + agresif test + browser smoke** = optimal yaklaşım.

### M.5 Staged rollout — gerekli mi?

**Karar: HAYIR.**

Tüm kullanıcılar aynı anda yeni menüye geçer. Çünkü:
- Tek tenant değil — multi-org, staged rollout uygulamak için tenant flag gerekir (yok)
- Risk düşük, hızlı rollback mümkün
- Kullanıcı eğitimi: kısa not + manuel ekran turu yeterli (ana menü adları sezgisel)

### M.6 Kullanıcı eğitim

İsteğe bağlı:
- Settings → Yardım sayfasında "Yeni menü düzeni" bölümü
- Login sonrası tek seferlik tooltip turu (yeni grup yapısını gösterir)
- Bu plan kapsamında: tooltip turu **şimdilik scope dışı** (gelecek opsiyonel iş)

---

## Onay matrisi

| Aşama | Onay |
|---|---|
| **Bu plan dokümanı review + onay** | ⏳ |
| **4 açık karar yanıtı** | ⏳ (Harita / IP Scanner / Lldp / OrgAdmin) |
| **Plan A vs Plan B karar** | ⏳ (öneri: Plan A) |
| **Implementation GO** | ⏳ (explicit) |
| Faz 2 (helper + i18n) PR | (GO sonrası) |
| Faz 3 (Sidebar + MenuGroupNav) PR | (Faz 2 merge sonrası) |
| Faz 4 (test + deploy) | (PR onayı sonrası) |
| Manuel smoke (4 rol × 12 grup = 48 hücre) | (deploy sonrası) |

**Bu plan KOD YAZMAZ.** Kullanıcı explicit "implementation başla" demediği sürece referans niteliğindedir.

---

## Özet — tek paragraf

Charon menü yapısı 54 düz öğeden 12 ana gruba indirilecek (sidebar %78 azalma). **47 sayfa tabanlı içerik korunur**, sadece sidebar grouping + sayfa içi yatay tab strip değişir. **Plan A önerildi:** mevcut URL'ler korunur, route değişmez, sadece UI rendering değişir → bookmark/audit log/permission etkilenmez. Pure frontend refactor — backend / DB / migration **sıfır**. Tahmini ~500 LOC kod + 240 i18n satır. 4 açık karar (Harita, IP Scanner, LldpInventory, OrgAdmin) kullanıcı onayı bekler. Plan B (route restructure) maliyet/risk yüksek → reddedildi. SSH Session Termination konusu komple iptal (kapanmış); bu çalışmaya dahil değil. W1-F1 SSH Audit ekranı + LANG-FIX i18n korundu, sadece grup içine taşınır. Feature flag gerekmez, staged rollout gerekmez, direkt geçiş + rollback tag yeterli.
