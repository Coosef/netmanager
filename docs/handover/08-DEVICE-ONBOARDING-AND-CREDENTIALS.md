# 08 — Cihaz Onboarding ve Credential Yönetimi

## 1. Cihaz ekleme akışı (UI)

1. **Devices → Yeni Cihaz** (`devices.write` yetkisi gerekir).
2. Zorunlu alanlar:
   - `name` (operatör tarafından okunan ad)
   - `hostname` (cihazın aslında bildirdiği prompt; çoğunlukla aynıdır)
   - `ip_address`
   - `device_type` (`cisco_ios`, `ruijie_os`, `aruba_os`, vb.)
   - `organization_id` + `location_id`
   - `agent_id` (private IP cihazlarda **mutlaka**; public IP cihazlarda boş)
3. Credential modu:
   - "Bu cihaz için özel credential gir" → `ssh_username`, `ssh_password`, opsiyonel `enable_secret`
   - **veya** "Credential profili kullan" → ortak `credential_profile_id` (`credential_profiles` tablosu)
4. Opsiyonel metadata: `tags`, `layer`, `building`, `floor`, `model`, `firmware_version`, `serial_number`. Bu alanlar **fetch-info** ile otomatik dolar.
5. Kayıt sonrası **Fetch Info** butonu çalıştırılır:
   - Backend agent-relay üstünden cihaza `show version` / `show running-config | include hostname` benzeri komutlar yapar
   - Dönen çıktıdan model, firmware, serial parse edilir, DB'ye yazılır
   - audit_logs'a `device_info_fetched` kaydı bırakılır

## 2. Agent atama zorunluluğu

| Cihaz IP'si | Agent gerekli mi? |
|---|---|
| Public IP, backend VPS'inden 22/161 reachable | **HAYIR** (backend direct SSH) |
| Private IP, VPS public network'ten erişilemez | **EVET** — `agent_id` set edilmeli |
| Public IP ama firewall arkasında (sadece belirli IP'ler reach) | EVET — VPN/agent çözümü |

**Risk:** `agent_id IS NULL` olup private IP taşıyan bir cihaz için backend SSH dener → TCP timeout → UI **uzun süre asılı kalır**. Bu, [11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md "Backend private IP'ye direct SSH deniyor"](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) ilk soru.

## 3. SSH username / password / enable secret farkı

| Alan | Cihaz tarafı kullanımı | Boş ise davranış |
|---|---|---|
| `ssh_username` | SSH oturum açma kullanıcı adı | Boş kabul edilmez |
| `ssh_password` | SSH oturum açma şifresi | Boş kabul edilmez |
| `enable_secret` | Cihaz **enable mode** parolası (Cisco/Ruijie) | Yoksa cihazda **user mode**'da kalınır — bazı komutlar çalışmaz |

### Ruijie özelinde
- Cihaz default'ta privilege 1 (user mode); prompt `>` ile biter
- `enable` komutu privilege 15'e (privileged mode) geçiş için **enable_secret**'i ister
- Eğer `enable_secret` boş → agent script `enable()` çağrısı yapmaz; user mode'da kalır
- User mode'da `show interfaces status`, `show vlan`, `show mac-address-table`, `show arp` **privilege-denied** döner

Detaylar: [09-RUIJIE-SSH-AND-PARSER-OPERATIONS.md](09-RUIJIE-SSH-AND-PARSER-OPERATIONS.md).

## 4. Cihaz onboarding validation checklist

Yeni cihaz ekledikten sonra:

1. `[READ ONLY]` UI: cihaz "online" mı, "unknown" mı?
2. `[READ ONLY]` Fetch Info butonu → 200 yanıt → model/firmware/serial DB'de dolu mu?
3. `[READ ONLY]` Ports tab açılır → interface listesi var mı?
4. `[READ ONLY]` Terminal aç → cihaz prompt'u doğru mu? (`>` user, `#` privileged)
5. `[READ ONLY]` Audit log: son 5 dk içinde `device_created` + `device_info_fetched` görünüyor mu?

Eğer 3'te "No ports found" çıkarsa:
- Cihaz Ruijie ve enable_secret eksik veya yanlış olabilir → [09](09-RUIJIE-SSH-AND-PARSER-OPERATIONS.md) testleri
- Cihaz Cisco/Aruba ve user `privilege 15` değilse → cihaz tarafı user yetkisi eksik

## 5. Duplicate device kayıtlarının etkisi

- DB'de UNIQUE constraint **(ip_address, organization_id)** üzerinde olabilir, ama hostname/IP duplicate kayıtları **yine de kazara yaratılabilir**.
- Aynı cihaz iki kayda denk düşerse:
  - İki ayrı SSH cycle düşer (agent pool iki ayrı oturum açabilir)
  - Snapshot tabloları (mac/arp/poe) çift kaynaklı veri girer → "device 95'te eski + yeni" karışıklığı
  - audit_logs operatörü yanıltır

**Korunma:**
- Onboarding UI'sı IP + organization_id ile pre-check yapar (varsa) — ⚠ **VERIFY BEFORE HANDOVER**.
- Bulk import sırasında CSV duplicate kontrolü kullanılır.

Duplicate keşfedilirse:
- Birini soft-delete et (`devices.deleted_at = NOW()`).
- Snapshot tablolarındaki `device_id` referansı eski satırda kalır; rapor üretirken bu satırlar otomatik dahil olmaz (çünkü `JOIN devices ON devices.deleted_at IS NULL`).

## 6. Device metadata: hostname, model, firmware, serial, tags, layer, building/floor

| Alan | Doldurma yolu |
|---|---|
| `hostname` | Manuel (cihaz prompt'undan veya `show running-config | include hostname`) |
| `model` | Fetch Info → `show version` parser |
| `firmware_version` | Fetch Info → `show version` parser |
| `serial_number` | Fetch Info → `show version` parser |
| `tags` | Manuel (sınıflandırma) |
| `layer` | Manuel (access/distribution/core) |
| `building`, `floor` | Manuel (rack veya konum verisi) |
| `rack_id` | Manuel — `Racks` modülünden seçilir |
| `model_image_url` | Manuel veya görsel template'ten — UI'da port haritası için |

**Tarihsel ders:** Cihaz metadata manuel alanlarda eksik bırakılırsa Topology / Rack view'da görsel boşluk oluşur. Operatörden onboarding sırasında `building/floor/rack_id` doldurulması beklenir.

## 7. Bulk credential copy davranışı

UI'da iki tip bulk vardır:

| İşlem | Etki |
|---|---|
| **Bulk credential update** | Seçilen cihazların `ssh_password` + `enable_secret` alanları yeni değerle güncellenir. Hedef listesi audit_logs'a yazılır (`bulk_credentials_updated`, `details: {"device_ids": [...]}`) |
| **Bulk credential copy** (kaynak → hedef) | Bir kaynak cihazın credential'ları seçilen hedeflere kopyalanır. Audit log'da hedef listesi tutulur ama **kaynak device_id tutulmaz** — geriye dönüş zor; [12](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) tech-debt |

**Kritik nokta:** Bulk copy DB'yi anında günceller; ancak cihazın *gerçek* credential'ı bu yeni değerle eşleşmiyorsa, bir sonraki SSH cycle'da agent **auth fail** alır → snapshot table'da boş satır + audit'te `authentication_failed`.

Operasyonel kural: **bulk copy öncesi en az 1 hedef cihaz manuel test edilmeli** (özellikle enable_secret).

## 8. Credential değişimi sonrası cache/pool TTL etkisi

| Olay | Değişim noktası | Etki süresi |
|---|---|---|
| UI bulk update / single update | `devices.*_enc` kolonları | Anlık |
| Agent pool eski oturumu | Pool key credential içermez; eski oturum **300s TTL** kadar yaşar | Maks 5 dk |
| Redis interfaces cache | `_IFACE_CACHE_TTL=300s` | Maks 5 dk |
| UI'da "doğru veri" | Yukarısı dolduktan sonra ilk fresh çağrı | **5–10 dk toplam** |

[06-AGENT-INSTALLATION-AND-OPERATIONS.md §Credential update sonrası agent pool/cache etkisi](06-AGENT-INSTALLATION-AND-OPERATIONS.md) tablosunun birebir aynı kontratı.

## 9. Credential update sonrası bekleme ve validation prosedürü

1. UI'dan credential update edilir.
2. **Bekle 10 dk** — pool ve cache TTL'in dolması için.
3. `[READ ONLY]` UI'da cihazın `Ports` tab'ı açılır.
4. Eğer port listesi varsa → başarılı; audit_logs'da yeni `interfaces_refreshed` veya `device_info_fetched` görünmeli.
5. Eğer hala "No ports found":
   - `[READ ONLY]` UI'dan **Fetch Info** çalıştır — error mesajı verirse error layer code'u oku
   - `[READ ONLY]` `agent_command_logs` son 30 dk: `success=t` mi `f` mi? Hangi error?
   - Hala `success=f` ile auth fail görüyorsan → cihazda gerçek credential başka, DB'de yazdığın değer yanlış → düzelt
   - `success=t` ama parser empty → cihaz user mode'da; enable_secret eksik veya yanlış → düzelt
6. Düzeltme sonrası tekrar 10 dk bekle.

**ASLA:** 10 dk içinde art arda restart, cache clear, queue purge atma. Pool TTL doğal şekilde temizler.

## 10. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- Pool key + TTL (`backend/agent_script/netmanager_agent.py`)
- Interfaces cache TTL 300s
- Bulk credential audit log şeması (Site-A bulk credential copy incident bulgusu)
- Ruijie default privilege 1 / enable mandatory enable_secret (gözlemlenmiş)

### VERIFY BEFORE HANDOVER
- UI bulk credential copy ekranındaki `details` payload'ı tam olarak ne içeriyor
- Bulk credential update'i kim çalıştırabiliyor (canonical permission key)
- `credential_profiles` modülünün UI'da görünürlüğü ve usage rate'i
- Fetch Info'nun `show version` parser dokümantasyonu
- Cisco/Aruba için enable_secret kullanım kuralı (Ruijie kadar net mi?)
