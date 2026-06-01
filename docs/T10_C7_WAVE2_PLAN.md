# T10 C7 Wave 2 — Epik Plan

> **STATUS: PLAN** — Wave 1 + Wave 1.1 prod canlısı GREEN sonrası açıldı (2026-06-01). Bu doküman 7 başlığı önceliklendirir, her başlık için kapsam + tahmini iş + bağımlılıkları sıralar. Implementasyon ayrı PR'larda yapılır.

## Bağlam

Wave 1 (8 commit + deploy log) + Wave 1.1 (VlanTab feedback) prod'a deploy edildi:
- git `2d1b4be` · alembic `f9aeportpol` · backend `199f1579` · frontend `bb31982d` · bundle `index-Cx4ql4t5.js`
- Modal→sayfa parity'sinin 7 kritik özelliği geri kazanıldı; backup snapshot offline policy check eklendi (backend genişlemesi); VlanTab feedback iyileştirildi (notification API).
- Wave 1 deploy log: [`docs/T10_C7_DEPLOY_LOG_2026-06-01.md`](T10_C7_DEPLOY_LOG_2026-06-01.md).
- Wave 1 parity matrisi: [`docs/T10_C7_FEATURE_PARITY.md`](T10_C7_FEATURE_PARITY.md).

Wave 1 kapsam-dışı bırakılanlar + Wave 1 sonrası ortaya çıkan ihtiyaçlar Wave 2'de toplandı.

## 7 başlık — öncelik sırası

| # | Başlık | Tahmin | Backend? | Mockup ref? |
|---|---|---|---|---|
| **1** | Audit Log UI v2 | M | ⚪ minimum | yok |
| **2** | Device Detail UI Refresh (mockup entegrasyon) | L | ⚪ yok | ✅ `/Netmanager/` |
| **3** | SSH Terminal Performance | L | 🟢 evet (agent stack) | yok |
| **4** | LLDP/CDP Neighbors | S | ⚪ yok (endpoint mevcut) | yok |
| **5** | CPU/RAM Health (SNMP chart) | S | ⚪ yok (endpoint mevcut) | yok |
| **6** | Visual Port Map | M | ⚪ yok | ✅ `/Netmanager/` ilham |
| **7** | Advanced Trunk VLAN Management (add/remove) | M | 🟢 evet (operation param) | yok |

Boyutlar: **S** = <1 gün · **M** = 2-3 gün · **L** = 4-7 gün.

---

## 1. Audit Log UI v2 (M, frontend-only)

**Kullanıcı şartnamesi (2026-06-01):** Audit log satırında her değişiklik için **6 alan** net görünmeli — kurumsal müşteri kritik talep.

| Alan | Backend kaynağı | Frontend tarafı |
|---|---|---|
| 1) **Kim yaptı** | `audit_logs.user_id` + join `users.username` + `system_role` | rol badge'i renkli (super_admin altın, org_admin mavi, viewer gri) |
| 2) **Ne yaptı** | `action` enum (`vlan_created`, `device_deleted`, vs.) | action → human-readable mapper ("VLAN 4090 oluşturdu", "Cihazı sildi"); chip renklendirme kategori bazlı (mavi=VLAN, kırmızı=destructive, yeşil=policy) |
| 3) **Hangi cihazda** | `resource_type` + `resource_id` + `resource_name` | tıklanabilir link `/devices/:id`; cihaz değilse "—" |
| 4) **Ne zaman** | `created_at` (UTC) | relative time ("2 saat önce") + tooltip absolute (`2026-06-01 12:23:27 GMT+3`) |
| 5) **Eski değer** | `before_state` JSONB | human-readable diff renderer (örn. `lifecycle: production → archived`) — JSON ham toggle ile opsiyonel |
| 6) **Yeni değer** | `after_state` JSONB | aynı renderer (yeşil eklenen, kırmızı silinen field'lar) |

**Backend dokunma:** minimum. DB'de tüm field zaten var (`audit_logs.before_state`, `after_state`, `user_id`, `resource_*`). Belki yalnız `GET /audit-logs` response'una user join detayı eklemek gerek (frontend join yapmasın diye).

**Frontend dosyaları:**
- `frontend/src/pages/AuditLog/index.tsx` — tablo + filter
- yeni `frontend/src/pages/AuditLog/AuditDetailDrawer.tsx` (modal yerine drawer önerisi) — 6-alan layout
- yeni `frontend/src/pages/AuditLog/_actionMapper.ts` — action enum → human label mapping (tüm Wave 1 action'ları dahil: `vlan_created`, `port_policy_assigned`, `config_policy_check`, `device_moved`, vs.)
- yeni `frontend/src/pages/AuditLog/StateDiff.tsx` — before/after JSONB diff renderer

**Filter UX iyileştirmesi (opsiyonel, M boyutunun parçası):**
- Sticky toolbar
- Tarih range quick presets (24sa/7gün/30gün)
- Action kategorisi multi-select
- Kullanıcı autocomplete
- "Sadece destructive" toggle

**Sözleşme:** Yeni mutation eklerken aynı 6-alan ile uyumlu audit log yazma (Wave 1 mutation'larının tümü uyumlu).

---

## 2. Device Detail UI Refresh — NetManager mockup entegrasyon (L, frontend-only)

**Kullanıcı kuralı (2026-06-01):** Yeni tasarım sıfırdan oluşturulmasın. `/Netmanager/` klasöründeki mevcut Switch mockup'ı referans alınarak **parça parça entegre** edilsin. Fonksiyonelliği bozma.

**Mockup kaynağı:**
- `Netmanager/pages-switch.jsx` (~407 satır — switch detay tasarım)
- `Netmanager/NetManager Switch.html` (40 satır shell)
- `Netmanager/styles.css` — NOC paleti (Charon ile aynı oklch token'ları)
- `Netmanager/Charon.html` (gerekirse ilgili kısımları)

**Entegrasyon hedefleri:**
- **Header yapısı** — Mockup'ta breadcrumb "Envanter > Switch" + title + "X PORT" pill + (PoE varsa) PoE pill + action button tray (Yenile / SSH Aç / Config Yedekle). Mevcut `DeviceDetailPage.tsx:99-116` yeniden tasarlanır.
- **Stat kartları** — Mockup'ta 6 stat card horizontal (Aktif Port / Err / PoE Port / Toplam Güç / VLAN / Bekleyen). DeviceDetailPage header altına eklenir; mevcut tab katalogundan önce.
- **Bilgi blokları** — Overview tab'ı tablo değil, mockup'taki gibi 2-kolon kart layout.
- **Renk kodlamaları** — Mockup oklch token'ları (`--ok`, `--warn`, `--crit`, `--accent`) zaten Charon CSS'inde tanımlı; status badge'leri/Tag'ler bu palet ile yeknesaklaştır.
- **Durum göstergeleri** — Online/offline/unreachable için LED pulse animasyonu (mockup'ta var, Charon'da `nm-status-dot pulse` class). Header'a + port listesine.

**Sınır:**
- Mockup'ın RJ45 visual faceplate'i (port grid) bu başlığa DAHİL DEĞİL — başlık #6 (Visual Port Map) ayrı iş.
- Mockup'ta görmediğim şey eklemem — uydurma yok.

**Risk:** AntD theme token'ları (`DARK_TOKENS`/`LIGHT_TOKENS` App.tsx) ile mockup'ın oklch palette'i arasında uyumsuzluk olabilir. Önce küçük bir component'te (header'da port pill) test, sonra yayılım.

---

## 3. SSH Terminal Performance (L, backend + frontend)

**Sorun (Wave 1 deploy 2026-06-01 sonrası prod log kanıtı):**
- Agent `txu3be48zqwl` her 1-2 dakikada disconnect/reconnect döngüsünde
- `/internal/agent-relay` POST'ları 1.8sn — 34.7sn arasında
- 3-hop network: browser → backend → agent (WAN) → cihaz SSH
- TerminalTab "Canlı SSH" yazılamayacak kadar yavaş

**5 alt-konu (Wave 2 plan'ı):**

| Alt-konu | Tahmini iş | Backend dokunma? |
|---|---|---|
| 3a. **WebSocket stabilitesi** — agent ↔ backend WS keepalive (ping/pong heartbeat); Cloudflare edge 100s timeout vs. uygulama ping frekansı | M | ✅ `backend/app/services/agent_manager.py` |
| 3b. **Reconnect davranışı** — agent disconnect olduğunda UI'da "yeniden bağlanılıyor" feedback + session queue + otomatik reconnect | S | ✅ frontend SshTerminal.tsx + backend WS handler |
| 3c. **Session timeout** — agent → cihaz SSH persistent vs. per-komut yeniden açma; session pooling | M | ✅ `backend/app/services/ssh_manager.py:_relay_ssh` |
| 3d. **xterm.js render performansı** — keystroke + 1KB+ output burst'lerinde render throttle; FastWrite addon | S | ⚪ frontend-only |
| 3e. **Scrollback + pagination** — `show running-config` 6000+ satır output için scrollback 2000→8000+ (SshTerminal.tsx:35); search addon | S | ⚪ frontend-only |

**Sırayla yaklaşım:** önce 3a (kararlılık) — disconnect döngüsü düzelmeden diğerleri marjinal kazanç. Sonra 3c (session pooling) — performansın büyük kazancı burada. 3b/3d/3e cosmetic + paralel.

---

## 4. LLDP/CDP Neighbors (S, frontend-only)

**Wave 1 parity matrisinden:** Eski `DeviceDetail` modal'da "Komşular" sekmesi vardı; yeni sayfada yok.

**Kapsam:**
- Yeni "Komşular" sekme (11. sekme) veya Overview tab'ında alt-card.
- API mevcut: `devicesApi.getNeighbors(deviceId)` + `topologyApi.discoverSingle(deviceId)` (manuel scan).
- Tablo: local_port, neighbor_hostname, neighbor_ip, neighbor_port, neighbor_platform, son görülme, envanterde var mı badge.
- "Yeniden Tara" butonu — `discoverSingle` mutation.

**Dosyalar:**
- yeni `frontend/src/pages/Devices/detail/NeighborsTab.tsx` (~150 satır)
- `_tabs.ts` → 11. eleman `'neighbors'`
- `DeviceDetailPage.tsx` dispatch dalı

---

## 5. CPU/RAM Health (S, frontend-only)

**Wave 1 parity matrisinden:** Eski "Sağlık" sekmesi; yeni sayfada yok.

**Kapsam:**
- Yeni "Sağlık" sekme veya Overview tab'ında alt-card (kapsam kararı).
- API mevcut: `snmpApi.getHealth(deviceId)` + `snmpApi.getInterfaces(deviceId)`.
- Recharts AreaChart: CPU% + Memory% 48 saatlik geçmiş.
- Header'da current değerler (örn. "CPU 45% · RAM 78%") — durum eşiklerine göre renk.
- Cihazın `snmp_enabled` false ise friendly empty.

**Dosyalar:**
- yeni `frontend/src/pages/Devices/detail/HealthTab.tsx` (~180 satır)
- `_tabs.ts` → 12. eleman `'health'`
- `DeviceDetailPage.tsx` dispatch dalı

---

## 6. Visual Port Map (M, frontend-only)

**Kullanıcı kuralı:** Mockup'ın RJ45 faceplate'inden ilham, **1:1 değil** — high-density switch'lerde scale problemi. Opsiyonel buton olarak Portlar sekmesinde sunulur.

**Kapsam:**
- PortsTab'a "Tablo" ↔ "Görsel" toggle (mevcut tablo default kalır).
- Visual mode: grid layout (2-row RJ45 jack simulation), port status renk (online/offline/error), PoE badge, VLAN renklendirme.
- Bulk select aynı toolbar (Policy ata / VLAN ata).
- Side panel: seçili portun detayı (mockup pattern'ı).

**Risk:** 48+ portlu switch'lerde grid scroll, mobil/dar ekranda kayan layout. Performans testi şart (Wave 1'in Playwright perf harness'ı kullanılabilir).

---

## 7. Advanced Trunk VLAN Management — add/remove allowed (M, backend + frontend)

**Kullanıcı raporu (2026-06-01):** Cisco, Aruba ve Ruijie cihazlarında günlük operasyonlarda `allowed vlan add/remove` yoğun kullanılıyor; mevcut Wave 1 yalnız replace semantiği destekliyor.

**Mevcut backend (`backend/app/api/v1/endpoints/interfaces.py:832-905`):**
```
# Cisco/Ruijie trunk (REPLACE):
switchport mode trunk
switchport trunk allowed vlan <comma-list>
switchport trunk native vlan <native>
```

**Wave 2 eklenecek (add/remove):**

| Operation | Cisco/Ruijie | Aruba OSSwitch/HP | Aruba AOS-CX |
|---|---|---|---|
| `add` | `switchport trunk allowed vlan add <list>` | `tagged vlan <v>` (per VLAN) | `vlan trunk allowed <v>` (per VLAN, no `no` öncesi) |
| `remove` | `switchport trunk allowed vlan remove <list>` | `no tagged vlan <v>` (per VLAN) | `no vlan trunk allowed <v>` (per VLAN) |

**Backend genişleme:**
- `POST /devices/{id}/interfaces/{name}/vlan` body'sine yeni `operation: 'replace' | 'add' | 'remove'` parametresi (default `'replace'` → backward-compatible)
- Trunk mode + add/remove için yeni command builder dalları
- Frontend `devicesApi.assignVlan(id, port, vlan_id, mode, native_vlan_id?, operation?)` imza genişlemesi

**Frontend UI:**
- PortsTab tek-port modal: Trunk mode'da Mod altına `Segmented` "Replace / Add / Remove" toggle
- BulkVlanAssignDrawer: aynı toggle
- Allowed VLANs parser zaten mevcut (`_vlanHelper.parseVlanList`) — reuse

**Test:**
- vitest: `assignVlan` mock'lu testler + `_vlanHelper` zaten 26 test
- Backend pytest: `test_assign_vlan_trunk_add_remove.py` (Cisco/Aruba/Ruijie örnek command builder testleri)

---

## Bağımlılıklar + sıralama önerisi

1. **Önce #1 Audit Log UI v2** — frontend-only, backend dokunma minimum, hızlı kazanç, kurumsal müşteri kritik talep. **2-3 gün.**
2. **Sonra #7 Advanced Trunk VLAN** — backend dokunma minimum (1 parametre), operasyonel value high. **2-3 gün.**
3. **Paralel #4 + #5 Neighbors + Health** — frontend-only, S boyutunda, tek dalga olarak deploy edilebilir. **3-4 gün toplam.**
4. **Sonra #2 Device Detail UI Refresh** — mockup entegrasyonu, sıra önemli (önce yapısal sekmeler kuruldu, sonra görsel cilalama). **4-7 gün.**
5. **#6 Visual Port Map** — #2 sonrası, mockup ilhamı sonrası, performansla beraber test. **2-3 gün.**
6. **#3 SSH Terminal Performance** — en uzun, en karmaşık, backend + agent stack inceleme gerekli. **4-7 gün.** Diğerlerinden bağımsız paralel ele alınabilir.

## Out of scope (Wave 2 dışı, ayrı follow-up)

- **Cloudflare `/poe` banner soruşturması** — operasyonel investigation, kod değil. Ayrı.
- **`DeviceDetail.tsx` dead code temizliği** — opsiyonel cleanup, Wave 2'nin parçası DEĞİL; Wave 2 #2 (UI Refresh) tamamlanınca silinebilir.
- **SNMP Configure modal, Trap Forwarding** — Wave 1 P4 maddeleri; kullanıcı kararı bekleniyor (kasıtlı silinmiş mi?).
- **Mockup'taki Rollback countdown pattern (mockup öneri #1)** — uzun vadeli config safety özelliği, ayrı epik.

## Kapanış kriteri

Wave 2 epik tamamlanmış kabul edilir:
- 7 başlığın tamamı prod'a deploy edilmiş + smoke GREEN
- Wave 2 deploy log dokümante edilmiş
- Audit log v2 + Device Detail Refresh kurumsal demo'sunda gösterilebilir hale gelmiş
- SSH terminal yazılabilir hızda (subjektif — kullanıcı testi)
