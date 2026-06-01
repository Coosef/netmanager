# T10 C7 Wave 3 — Operasyonel Genişleme + UI Polish: Plan

> **STATUS: PLAN** — Kullanıcı 2026-06-01 talimatı (Wave 2 #2 deploy sonrası prod canlı kullanımdan): 7 madde + öncelik sırası + "kod yazmadan önce plan + BE/FE etki analizi". Bu doküman 7 maddenin tam teknik planı; implementasyon onay sonrası başlar.

## Bağlam

Wave 2 #2 (Device Detail UI Refresh) prod'a deploy edildi (`1282fcd`). Kullanıcı canlı kullanım sırasında 7 operasyonel ihtiyaç tespit etti. Bu Wave 3 epik açılışı — büyük ölçüde **kurumsal operasyonel feature'lar + backup scheduler regression fix + Aksiyonlar tab restructure**.

## Öncelik sırası (kullanıcı belirledi)

| # | Madde | Aciliyet | BE | FE | Tahmin |
|---|---|---|---|---|---|
| 1 | **Backup scheduler regression** root-cause fix | 🔴 KRİTİK (6gün canlıda backup yok) | 🟢 evet | ⚪ yok | S |
| 2 | Port Enable / Disable (single + bulk) | 🟡 yüksek operasyonel | 🟡 minimum | 🟢 evet | S-M |
| 3 | PoE Enable / Disable / Restart (single + bulk) | 🟡 yüksek operasyonel (otel: AP/IP telefon/kamera restart) | 🟢 evet (yeni endpoint) | 🟢 evet | M |
| 4 | Switch Restart vendor-aware | 🟡 yüksek operasyonel | 🟢 evet (yeni endpoint) | 🟢 evet | M |
| 5 | Advanced Trunk VLAN — Native + Allowed VLANs format | 🔵 doğrulama | ⚪ mevcut | ⚪ mevcut + polish | XS |
| 6 | Aksiyonlar tab restructure (3 grup) | 🟡 UX clarity | ⚪ yok | 🟢 evet | S |
| 7 | Device Detail UI polish (mockup re-inceleme) | 🔵 düşük | ⚪ yok | 🟢 evet | M |

Boyut: **XS** <½ gün · **S** <1 gün · **M** 2-3 gün.

---

## #1 — Backup Scheduler Regression — Root Cause + Fix

### Diagnostic özeti (bu doc öncesi tamamlandı)

| Bulgu | Kanıt |
|---|---|
| 70 switch, 0 güncel, 64 stale, 6 hiç backup | Backup Center UI screenshot |
| `BackupSchedule` tablosu tek schedule: `enabled=t · last_run_at=2026-05-25 02:00 · next_run_at=2026-05-26 02:00` | DB query (üstte) |
| **6 gündür `next_run_at <= now` koşulu sağlanıyor ama tetiklenmemiş** | DB state |
| `celery_beat-1` çalışıyor — `check-backup-schedules-every-minute` task her dakika kuyruğa gönderiliyor | celery_beat log |
| `celery_default_worker-1` task'ı her dakika **RECEIVED** ediyor | worker log |
| Hata / exception YOK son 6 saat | worker log error grep |
| `backup_schedules` tablosu **RLS-forced** + `organization_id NOT NULL` | `pg_class.relforcerowsecurity = t` |
| **`bulk_tasks._get_db()` ham `SyncSessionLocal()` — RLS bypass YAPMIYOR** | `bulk_tasks.py:23-24` |

### Kök neden

[`backend/app/workers/tasks/bulk_tasks.py:23-24`](backend/app/workers/tasks/bulk_tasks.py#L23-L24):
```python
def _get_db() -> Session:
    from app.core.database import SyncSessionLocal
    return SyncSessionLocal()
```
- DB session açılır, **`SET app.is_super_admin='on'` YOK**, `current_org_id` set EDİLMEZ
- RLS policy: `USING (app.is_super_admin='on' OR organization_id = app.current_org_id::int)` — ikisi de false
- `SELECT FROM backup_schedules WHERE enabled=true AND next_run_at<=now` → **0 satır döner** (filter)
- `check_backup_schedules` task: `due = []` → for döngüsü çalışmaz → sessizce return

### Bu Faz 7 isolation rework regression'ı

`docs/T10_C7_WAVE2_PLAN.md`'de olmayan bir madde — Faz 7 plan'ında [Phase 3d](backend/app/services/ ile worker_rls_session) listesinde:
> "Fleet-wide bypass (`app.is_super_admin='on'`) for Beat sweeps across all orgs: `snmp_tasks.poll_snmp_all`, `availability_tasks`, `agent_peer_tasks`, `retention_tasks`, `metrics_tasks`, `monitor_tasks`, `sla_tasks`, `cache_warmer_tasks`."

`bulk_tasks.*` ve `backup_tasks.*` o listede YOK — atlanmış. Tüm `SyncSessionLocal` kullanan task'larda potansiyel aynı sorun:
- `bulk_tasks.py` (backup schedule, bulk backup, bulk lifecycle, bulk command, bulk password)
- `backup_tasks.py` (config drift check)
- `correlation_tasks.py` · `topology_tasks.py` · `maintenance_tasks.py` · `security_policy_tasks.py` · `monitor_tasks.py` · `driver_tasks.py`

### Fix planı

**Backend (~50 LOC):**
1. **Yeni helper** `backend/app/core/rls.py` (zaten var) içinde `set_sync_session_super_admin(db: Session)` sync version — `db.execute(text("SET LOCAL app.is_super_admin='on'"))` çağırır
2. `bulk_tasks._get_db()`'i şu şekilde değiştir:
   ```python
   def _get_db() -> Session:
       from app.core.database import SyncSessionLocal
       db = SyncSessionLocal()
       # Faz 7 fleet-wide bypass — Beat sweep'leri tüm org'ları görmeli
       db.execute(text("SET app.is_super_admin = 'on'"))
       return db
   ```
3. Aynı pattern'i diğer **etkilenen task modüllerine** yay (audit'in parçası): `backup_tasks.py`, `correlation_tasks.py`, `topology_tasks.py`, `maintenance_tasks.py`, `security_policy_tasks.py`, `driver_tasks.py`. Her dosyada `_get_db()` veya inline `SyncSessionLocal()` çağrılarını `SET app.is_super_admin='on'` ile sarmal.
4. **Audit log doğruluğu**: Bypass mode'da çalışan task'lar yine `organization_id` doğru kaydetmeli — her INSERT/UPDATE'te device'tan org_id türetilmeli (Faz 7 Phase 3d kuralı: "MUST still write correct `organization_id`/`location_id` on every INSERT").

**Test:**
- Backend pytest: `test_bulk_tasks_rls_bypass.py` — RLS forced tablo (`backup_schedules`) altında `_get_db()` sonra SELECT count > 0 doğrulanır
- Manuel: 1 schedule prod'da `next_run_at = now() - 1min` yapılır, 60 saniye içinde tetiklenmeli
- E2E doğrulama: prod'da `next_run_at` güncellenmeye başlıyor, bulk_backup_configs task'ı kuyruğa giriyor, 70 cihaz için backup denenmeye başlıyor

**Deploy:**
- Backend dokunma → backend rebuild + restart gerek
- Yarım gün iş (audit + fix + pytest + dokümante)
- DB migration YOK

### Risk

- **Audit log organization_id yanlış kaydedilirse:** super_admin bypass'le çalışan task'lar yazma yaparken doğru org_id türetmiyorsa cross-org veri sızıntısı olabilir. Mitigation: her INSERT'te device.organization_id'den türet, pytest fixture'la cover.
- **Diğer task modülleri etkilenmedi:** `monitor_tasks.poll_device_status` zaten çalışıyor (status'lar prod'da güncel), demek ki o yol farklı bir bypass mekanizmasıyla çalışıyor olabilir → her modül için ayrı doğrulama gerek (bu plan'ın "kapsamı genişletir" maddesi).

### Diğer task'ların etkisi — kontrol listesi (Wave 3 #1 doğrulamaları)

| Task | Etkilenir mi? | Kanıt yöntemi |
|---|---|---|
| `bulk_tasks.scheduled_backup` | ✅ Evet (aynı `_get_db`) | sayaç sıfır kalır |
| `bulk_tasks.check_backup_schedules` | ✅ Evet (KANITLI) | DB next_run_at güncellenmemiş |
| `bulk_tasks.bulk_backup_configs` | 🟡 Kullanım anına bağlı (frontend tetiklerse RLS context vardır; Beat tetiklerse yok) | log tail |
| `backup_tasks.check_config_drift` | ✅ Olasılık çok yüksek (drift detection sessiz fail) | drift değerleri eski |
| `topology_tasks.scheduled_topology_discovery` | ✅ Olasılık (LLDP discover 6 saatte 1, sessiz fail) | TopologyLink tablo `last_seen` güncel mi? |
| `correlation_tasks.confirm_stale_recovering` | 🟡 Belirsiz — event tablosu RLS'i nasıl | event recovery oluyor mu? |
| `monitor_tasks.poll_device_status` | ⚪ Çalışıyor (status güncel) — başka bypass yöntemi? | Code audit |

Tüm bunlar Wave 3 #1'in **kapsamı**. İşin büyüklüğü "S" değil "S-M" — audit + fix paketi.

---

## #2 — Port Enable / Disable (Single + Bulk)

### Backend

Endpoint mevcut: [`POST /devices/{id}/interfaces/{name}/toggle`](backend/app/api/v1/endpoints/interfaces.py#L780) ile `action: 'shutdown' | 'no-shutdown'`. Wave 1 audit'inde [`devicesApi.toggleInterface(id, name, action)`](frontend/src/api/devices.ts) zaten var.

Vendor-aware command builder kontrol gerek: Cisco `interface X / shutdown` ↔ `no shutdown` · Aruba `interface X / disable` ↔ `enable` · Ruijie `interface X / shutdown` ↔ `no shutdown`. Mevcut backend bunu kapsıyor mu doğrulayalım.

**Backend kapsamı (minimum):**
- ✅ Endpoint hazır (mevcut)
- ⚪ Bulk endpoint YOK — Wave 1 paterni: frontend `Promise.allSettled` ile per-port çağrı (atomik DEĞİL ama hızlı)
- ✅ Audit log `audit_logs` zaten yazılıyor (mevcut endpoint içinde `log_action`)

### Frontend (~120 LOC)

`PortsTab.tsx`:
1. **Row action** — mevcut "VLAN" link buton yanına "Aç/Kapat" Power icon:
   - Port `status === 'up'` ise → kırmızı PowerOff buton (Popconfirm: "PORT KAPATILACAK — Cihaz bağlantısı kesilebilir")
   - Port `status === 'down/notconnect/err-disabled'` ise → yeşil PowerOn buton
2. **Sticky toolbar bulk action** — "Policy ata / VLAN ata" yanına 2 yeni buton:
   - "Seçili Portları Aç" (Power yeşil)
   - "Seçili Portları Kapat" (Power kırmızı, Popconfirm WAJİP)
3. **Confirmation pattern:**
   - Tek port disable: `Popconfirm` "X portu kapatılacak. Bu porta bağlı cihazlar erişimini kaybedebilir."
   - Bulk disable: `Modal` (Popconfirm yetmez) — listede portları göster + "kapat" yazısını tipe ettirme zorunluluğu
4. **Mutation:**
   - `toggleMutation = useMutation(devicesApi.toggleInterface)`
   - `bulkToggleMutation` — `Promise.allSettled` paterni (mevcut `bulkAssignVlanMut` gibi)
5. **RBAC:** `canConnect` gate (mevcut), super_admin/org_admin için aktif

### Risk

- **Disable bir AP/kamera portu** → otel müşterisi şikayeti. Çift onay + audit log + reversibility tooltip ("Yeniden aç" mevcut bulk).
- **Bulk Promise.allSettled atomik DEĞİL** — sonuç raporu shown: "X port güncellendi, Y başarısız".

---

## #3 — PoE Enable / Disable / Restart (Single + Bulk)

### Backend (yeni endpoint — ~80 LOC)

Mevcut: `poeApi.device(deviceId)` GET (port detayı), `summary` (global özet). **POE action endpoint yok.**

**Yeni endpoint:** `POST /poe/devices/{device_id}/ports/{port_name}/action`
- Body: `{ "action": "enable" | "disable" | "restart" }`
- Vendor-aware command builder:
  - **Cisco IOS:** `interface X / power inline {auto|never}` (restart = never → 3s wait → auto)
  - **Ruijie:** `interface X / poe {enable|disable}` veya `poe reset` (restart için)
  - **Aruba OSSwitch:** `interface X / power-over-ethernet [yes|no]`
  - **Aruba AOS-CX:** `interface X / poe-config [enable|disable]`
- Restart implementasyonu: disable → 3 saniye bekle → enable (single command yok; iki SSH komut)

**Bulk endpoint:** `POST /poe/devices/{device_id}/bulk-action` — body `{ ports: ["Gi0/1", "Gi0/2"], action: "restart" }`. Backend per-port iterate eder, sonuç matrisi döner.

**Audit log:** her aksiyon `poe_port_action` event tipinde + before/after state.

### Frontend (~150 LOC)

`PortsTab.tsx`:
1. **Row action** — PoE kolonu olan portlarda 3 ikon menüsü:
   - Power-On (yeşil) → enable
   - Power-Off (gri) → disable
   - Sync icon → restart (Popconfirm: "PoE 3 saniye kesilecek")
2. **Sticky toolbar bulk action** — Wave 3 #2'nin yanına:
   - "PoE Aç" / "PoE Kapat" / "PoE Restart" (3 buton grubu)
   - Restart için Modal: liste + 3sn ek bekleme uyarısı
3. **Mutation:** `poeActionMutation` + `bulkPoeActionMutation`

### Risk

- **AP/kamera restart business hours içinde** → uyarı: kullanıcı planlı bakım modunu seçsin (Wave 4 maintenance window feature ihtimali)
- **Vendor command farklı** → backend test her vendor için unit test
- **PoE port değil portu restart eden user error** → backend `poe_capable=false` ise 400

---

## #4 — Switch Restart (Vendor-aware Reboot)

### Backend (yeni endpoint — ~60 LOC)

**Yeni endpoint:** `POST /devices/{device_id}/reboot`
- Body: `{ "save_config_first": true, "delay_seconds": 0 }`
- Vendor-aware:
  - **Cisco:** `write memory` → `reload` `\n` confirmation `\n`
  - **Ruijie:** `write memory` → `reload`
  - **Aruba OSSwitch:** `write memory` → `boot system primary`
  - **Aruba AOS-CX:** `copy running-config startup-config` → `boot system`
  - **HP ProCurve:** `write memory` → `reload`
- SSH komutu gönder, response beklemeden close (cihaz restart oluyor)
- Cihaz status'unu `restarting` flag'iyle işaretle (`devices.restart_initiated_at` yeni kolon? veya `Task` tablosuna kayıt)
- **3-5 dk içinde cihaz online'a döner — monitor task otomatik tespit eder**

**Backend genişleme:**
- Yeni endpoint + vendor command builder
- Audit log: `device_rebooted` action
- Opsiyonel: `Task` tablosunda "Reboot pending" satırı (Wave 3 #1 fix'i sonrası RLS bypass'le)

### Frontend (~80 LOC)

`ActionsTab.tsx`:
- **BAKIM** bölümünde yeni "Cihaz Restart" kartı
- Modal ile **çift onay**: "VILLA_31_SW31 (10.24.90.31)" tipe ettirme + "Kaydet ve Yeniden Başlat" buton
- Mutation sonrası: status `restarting` badge'i, "Cihaz 3-5 dakika içinde geri dönmesi bekleniyor" alert
- Status polling 60s — online döndüğünde alert "Cihaz çevrimiçi" (notification)

### Risk

- **Yanlış cihaz restart** → çift onay + hostname tipe ettirme
- **Cihaz geri gelmezse** → manuel müdahale gerek; alert + "manuel müdahale gerek" link

---

## #5 — Advanced Trunk VLAN Format Doğrulama

### Mevcut durum (Wave 1 retry-fix `8218451` ile yapıldı)

[`frontend/src/pages/Devices/detail/_vlanHelper.ts`](frontend/src/pages/Devices/detail/_vlanHelper.ts) — `parseVlanList()` ZATEN destekliyor:
- `"1,10,20,30"` → `[1, 10, 20, 30]`
- `"10-20,30,40"` → `[10, 11, ..., 20, 30, 40]`
- `"1,10-12,2400,2410-2415"` → karışık format
- 26 birim test PASS

Backend: [`interfaces.py:832-905`](backend/app/api/v1/endpoints/interfaces.py#L832) trunk için `vlan_id: int | list[int]` + `native_vlan_id?` destekliyor.

UI: PortsTab tek port modal + BulkVlanAssignDrawer — Trunk mode seçildiğinde "Native VLAN ID (opsiyonel)" + "Allowed VLANs" alanları görünür (Wave 1 retry-fix).

### Aksiyon

✅ **Madde zaten implement edilmiş — sadece kullanıcı doğrulaması gerek.** Wave 3 #5 = no-op (re-doğrula). Eğer Wave 1 retry-fix sonrası kullanıcı görmediyse: hard reload + Portlar sekmesinde Trunk seçim akışı.

**Wave 2 #7 (Advanced Trunk VLAN Management — add/remove)** ayrı: replace semantiği yerine `switchport trunk allowed vlan add/remove` operasyonları. Bu Wave 3'te değil, Wave 2 roadmap'inde — sonraki sprint.

---

## #6 — Aksiyonlar Tab Restructure (3 Grup)

### Mevcut yapı (`ActionsTab.tsx`)

4 grup: **Çalıştırma** (Bağlantı Testi / Bilgi Çek / Backup Sekmesi) · **Yaşam Döngüsü** (lifecycle dropdown + Arşive Al) · **Yer / Arşiv** (Lokasyona Taşı) · **Tehlikeli Bölge** (Port Shutdown disabled / Cihaz Sil / Sayfayı Yenile)

### Hedef yapı (kullanıcı belirledi)

| Grup | İçerik |
|---|---|
| **OPERASYONLAR** | Bilgi Çek · Backup Al (yeni — devicesApi.takeBackup tetik) · SSH Aç (tab=terminal&mode=ssh) |
| **BAKIM** | Cihaz Restart (yeni — Wave 3 #4) · PoE Toplu Reset (yeni — Wave 3 #3 bulk) · Port Yönetimi (yeni — Wave 3 #2 link veya inline) · Yaşam Döngüsü (lifecycle dropdown taşındı) · Lokasyona Taşı |
| **TEHLİKELİ BÖLGE** | Cihaz Sil · Arşive Al · Sayfayı Yenile |

### Frontend (~100 LOC, ActionsTab refactor)

`ActionsTab.tsx`:
- 4 grup → 3 grup yeniden organize
- Card grid layout korunur (mevcut Wave 2 #2 paterni)
- "Backup Al" yeni: `devicesApi.takeBackup` mutation + notification (Wave 1.1 paterni)
- "SSH Aç" yeni: `navigate('?tab=terminal&mode=ssh')` deep link (header'daki Quick Action butonuyla aynı)
- "Cihaz Restart" placeholder — Wave 3 #4 implement edildikten sonra aktif
- "PoE Toplu Reset" placeholder — Wave 3 #3 implement edildikten sonra aktif
- "Port Yönetimi" link buton → `navigate('?tab=ports')` (Wave 3 #2 implement edildikten sonra)

**Sıralama:** Wave 3 #2, #3, #4 sırasıyla implement edilir, sonra #6 restructure (placeholder'lar gerçek aksiyona dönüşür).

### Risk

- Düşük — UI-only refactor, mevcut mutation'lar korunur
- Kullanıcı yeni grupları öğrenirken kısa öğrenme eğrisi → grup başlıklarında küçük açıklama (mockup styles)

---

## #7 — Device Detail UI Polish (Mockup Re-İnceleme)

### Kullanıcı kuralı

> "Yeni bir tasarım üretme. Mevcut Wave 2 #2 tasarımını koru. Sadece eski NetManager mockup'larındaki başarılı bileşenleri taşıyarak daha kurumsal hale getir."

### Strateji

Wave 2 #2 sonrası 10 bileşen taşındı: Device Header / Status Cards / Health Summary / Vendor Badge / Availability Badge / Last Backup Badge / Port Statistics / VLAN Statistics / Event Statistics / Quick Actions. Bunlar **base'ti**. Wave 3 #7 = bu base üzerine mockup'tan **görsel cilalama** + eksik **iconography / spacing / micro-interactions**.

### Mockup re-inceleme alanları

`/Netmanager/` klasöründen Wave 2 #2 dışında bakılması gereken:
- **`Charon.html` 205KB** — ana shell + drawer pattern'ı (Detail Page'in bir drawer olarak nasıl açıldığı, header etkileşimi)
- **`widgets.jsx`** — KPI / Card / Gauge / Donut widget'ları (Wave 2 #2'de Donut + Sparkline aldık; Gauge ve Card pattern'ları eksik olabilir)
- **`pages-switch.jsx:206-340`** — Port grid faceplate (Wave 2 #6 RJ45 Visual Port Map'in parçası, Wave 3 #7'de değil)
- **`styles.css`** — hover effect, animation timing, micro-interactions

### Olası iyileştirmeler (mockup taranınca somutlanacak)

- Status Cards hover efekti (Cards "pop" gibi animasyon)
- Sparkline tooltip (mouseover ile değer göster)
- Quick Actions buton icon'ları (mevcut yalnız text)
- Risk pill icon (SAĞLIKLI ✓ / İZLENMELİ ⚠ / KRİTİK ✕)
- Stat card delta animation (sayı değişiminde fade)
- Loading skeleton (Spinner yerine)

### Aksiyon

Wave 3 #7 implement edilmeden önce **ek mockup tarama** gerek (Wave 2 #2 öncesi tarama Status Cards / Header / Health / SLA / Events'e odaklanmıştı; polish için derin tarama gerek). Yarı saat ek diagnostic + 1-2 gün implement.

---

## Faz sıralaması — Wave 3 implementasyon

| Faz | Madde | Tahmin | Branch |
|---|---|---|---|
| **W3.1** | #1 Backup scheduler RLS regression fix + diğer task'larda audit | 1 gün | `t10/c7-wave3-backup-rls-fix` |
| **W3.2** | #2 Port Enable/Disable (single + bulk) | 1 gün | `t10/c7-wave3-port-toggle` |
| **W3.3** | #3 PoE Enable/Disable/Restart | 2 gün (BE+FE) | `t10/c7-wave3-poe-action` |
| **W3.4** | #4 Switch Restart | 1-2 gün (BE+FE) | `t10/c7-wave3-device-reboot` |
| **W3.5** | #6 Aksiyonlar tab restructure (W3.2-4 sonrası placeholder'lar aktifleşir) | ½ gün | `t10/c7-wave3-actions-restructure` |
| **W3.6** | #5 Advanced Trunk doğrulama | 0 gün (tarayıcı test) | — |
| **W3.7** | #7 Device Detail UI polish (mockup re-tarama + ek dokunuşlar) | 1-2 gün | `t10/c7-wave3-ui-polish` |

**Toplam:** ~7-9 gün iş. Her faz ayrı branch + commit + main merge + prod deploy.

---

## Backend etki özeti

| Madde | Endpoint | Migration | DB değişim |
|---|---|---|---|
| #1 | Yok (kod fix) | YOK | Yok |
| #2 | Mevcut endpoint kullan + opsiyonel bulk endpoint | YOK | Yok |
| #3 | **Yeni 2 endpoint** (single PoE action + bulk) | YOK | Yok |
| #4 | **Yeni 1 endpoint** (reboot) | Opsiyonel kolon `restart_initiated_at` | Opsiyonel |
| #5 | (zaten var) | YOK | Yok |
| #6 | Yok | YOK | Yok |
| #7 | Yok | YOK | Yok |

**DB migration kararı:** #4 için `restart_initiated_at` kolonu opsiyonel — Task tablosuna pending task olarak yazılır, ek kolona gerek yok (alt-iş).

## Frontend etki özeti

| Madde | Yeni dosya | Değişen dosya | LOC tahmini |
|---|---|---|---|
| #1 | — | — | 0 (BE-only) |
| #2 | — | `PortsTab.tsx` (+row action + bulk buton + mutations + Modal) | +120 |
| #3 | — | `PortsTab.tsx` (+PoE row action + bulk buton + mutations) | +150 |
| #4 | — | `ActionsTab.tsx` (BAKIM kartı + Modal + status polling) · `api/devices.ts` (+reboot endpoint sarmal) | +80 |
| #5 | — | — | 0 (doğrulama) |
| #6 | — | `ActionsTab.tsx` (refactor 4→3 grup, mevcut bileşenler reorganize) | +100/-80 |
| #7 | Belki yeni icon util | OverviewTab, DeviceDetailPage, helper'lar | +100 |

**Toplam yeni LOC:** ~550 (BE 200 + FE 550 net).

## Test stratejisi

| Madde | Backend | Frontend |
|---|---|---|
| #1 | **pytest yeni:** `test_bulk_tasks_rls_bypass.py` — `_get_db()` sonra `backup_schedules` SELECT > 0 | — |
| #2 | (mevcut) | vitest: import smoke; tarayıcı: enable/disable + Popconfirm |
| #3 | **pytest yeni:** vendor command builder unit test (Cisco/Aruba/Ruijie) | vitest: import smoke; tarayıcı: PoE action + restart |
| #4 | **pytest yeni:** reboot endpoint integration test + vendor command | vitest: import smoke; tarayıcı: çift onay flow |
| #5 | (mevcut 26 test) | (mevcut) |
| #6 | — | vitest: ActionsTab import smoke + new layout |
| #7 | — | vitest: yeni helper varsa unit + import smoke |

## Risk + Bağımlılıklar

1. **#1 Backup scheduler regression**: Diğer task modüllerinde aynı bug — audit kapsamı genişler (S → S-M). Fix sonrası backup queue patlayabilir (70 cihaz × 6 gün backup borç) — bulk_backup_configs `queue=bulk` rate-limit gerekebilir.
2. **#3 PoE restart business hours**: Wave 4 maintenance window özelliği gerekebilir (kapsam-dışı şimdi).
3. **#4 Switch restart yanlış cihaz**: Çift onay + audit (mitigation).
4. **#6 restructure plan**: #2-4 commit'lerinin sonrasında placeholders → real action; sıralama önemli.
5. **#7 polish kapsamı belirsiz**: Mockup re-tarama sonrası kapsamı netleşir.

---

## Out of scope (Wave 3 sonrası)

- **Wave 2 #1 Audit Log UI v2** — kurumsal kritik talep, henüz başlamadı. Wave 3 sonrası muhtemelen sıradaki.
- **Wave 2 #7 Advanced Trunk add/remove** — Wave 3 #5 doğrulamasıyla karıştırma; ayrı epik.
- **Wave 2 #3 SSH Terminal Performance** — agent stack incelek.
- **Wave 2 #4-5 Komşular / Health Tab** — yeni sekmeler.
- **Maintenance Windows** — Wave 3 #3-4 risk mitigation için ileride gerekebilir.
- **Cloudflare `/poe` banner** — operasyonel investigation.

## Kapanış kriteri

Wave 3 epik tamamlanmış kabul edilir:
- 7 madde sırasıyla prod'a deploy edilmiş + smoke GREEN
- Backup scheduler 70/70 cihaz için günlük çalışıyor (#1)
- Port + PoE + Reboot operasyonları kullanıcı tarafından prod'da test edilmiş (#2-4)
- Aksiyonlar tab 3 grup yapısında (#6)
- UI polish dokunuşları görsel onaylanmış (#7)
