# 09 — Ruijie SSH ve Parser Operasyonları

## 1. Ruijie `ruijie_os` davranışı (genel)

- Netmiko driver: `ruijie_os` (RGOS legacy `RuijieOSBase`)
- Default privilege seviyesi: **1 (user mode)**, prompt sonu `>`
- Privileged mode: **15**, prompt sonu `#`
- `enable` komutu privilege 15'e geçirir; password sorar (cihazda set'li `enable secret`)
- User mode'da çoğu `show` komutu **privilege denied** döner
- Privileged mode'a geçilince `show interfaces status`, `show vlan`, `show mac-address-table`, `show arp` çalışır

## 2. Legacy SSH KEX / host-key uyumluluk notları

- Eski Ruijie cihazlar (RGOS_SSH) **ssh-rsa host key**, **SHA1 KEX** kullanır
- Modern OpenSSH client default'ta bunları reject eder (`no matching host key type`, `no matching kex algorithm`)
- Agent script'in netmiko / paramiko parametreleri bu legacy desteği açar:
  - `HostKeyAlgorithms +ssh-rsa`
  - `KexAlgorithms +diffie-hellman-group14-sha1` (veya benzeri)
- Eğer bir Ruijie cihazına SSH yapamıyorsan ve hata `no matching ...` ise: cihaz çok eski firmware'da olabilir; agent script tarafında parameter override gerekebilir. ⚠ **VERIFY BEFORE HANDOVER**: parametre listesini agent_script kaynağından doğrula.

## 3. User mode `>` vs privileged mode `#`

Cihaz prompt'una bakarak hangi mode'da olduğunu anlarsın:

```
Switch>                   ← user mode (privilege 1)
Switch#                   ← privileged mode (privilege 15)
Switch(config)#           ← global config mode
Switch(config-if)#        ← interface config mode
```

Agent script şu sözleşmeyi kullanır:
- Cihaz Ruijie ve `enable_secret` DB'de set ise → `session_preparation` içinde otomatik `enable`
- Cihaz Ruijie ama `enable_secret` boş ise → user mode'da kalır; `enable()` çağrılmaz

## 4. enable gerektiren komutlar

| Komut | User mode'da çalışır mı? | Privileged mode gerekli mi? |
|---|---|---|
| `show interfaces status` | Hayır (privilege denied) | EVET |
| `show vlan` | Bazı firmware'da kısmi; çoğu reddeder | EVET |
| `show mac-address-table` | Hayır | EVET |
| `show arp` | Hayır | EVET |
| `show version` | EVET (sınırlı çıktı) | Tam çıktı için EVET |
| `show running-config` | Hayır | EVET |
| `show poe` veya `show power inline ...` | Hayır | EVET |

## 5. Komut başına çıktı kontratı

### `show interfaces status`
- Sütunlar: Port, Name, Status, Vlan, Duplex, Speed, Type
- Parser bu satırları regex ile yakalar; sütun başlığı satırı + ayraç satırı atlanır

### `show vlan`
- VLAN ID, Name, Status, Ports listesi (bazı firmware'da multi-line)
- Parser her VLAN için 1 entry üretir

### `show mac-address-table`
Üç firmware varyantı vardır (ruijie_os parserlarda):
| Varyant | Anahtar pattern |
|---|---|
| Standart | `VLAN  MAC Address       Type   Interface` başlığı |
| Ruijie RGOS dot-format | `0000.0000.0000` (üç gruplu nokta) |
| Ruijie RGOS colon-format | `00:00:00:00:00:00` |
| Ruijie RGOS "Live Time" anchor | "Total" sonu + "Live Time" anchor'lı satırlar |

Backend `mac_arp.py:_parse_mac_table` 5 pattern barındırır (`ruijie_rgos_pat`, `ruijie_dot_pat`, `ruijie_colon_pat`, +Cisco/Aruba).

### `show arp`
- IP, MAC, Interface, Type sütunları
- Backend parser `_parse_arp_table` Cisco + Ruijie varyantlarını destekler

### `show poe interfaces status` (S5310, modern)
- Sütunlar: Interface, Power, Class, Voltage, Current, Status
- Backend `topology_service.EXTENDED_COMMANDS["power"]` bunu kullanır

### `show power inline ...` (S6250, eski)
- Farklı çıktı şeması — ⚠ **VERIFY BEFORE HANDOVER** üretimde S6250 + S5310 model dağılımı doğrulanmalı

## 6. S6250 / S5310 farkları

| Boyut | S6250 (eski) | S5310 (modern) |
|---|---|---|
| PoE komut | `show power inline ...` | `show poe interfaces status` |
| SSH KEX | Daha sıkı legacy | Daha modern uyum |
| Privileged enable | enable_secret zorunlu | enable_secret zorunlu |
| Default user | admin / kuruma göre | admin / kuruma göre |
| Interface adlandırma | `GigabitEthernet 0/1` | Aynı (firmware'a bağlı) |

> ⚠ **VERIFY BEFORE HANDOVER**: Production envanterinde S6250 / S5310 sayıları + her birinin firmware sürümleri; parser path'lerinin gerçek dağılımla eşleşmesi gerekiyor.

## 7. Parserların hangi veri türlerini doldurduğu

| Komut | Hedef tablo | Yenilenme |
|---|---|---|
| `show mac-address-table` | `mac_address_entries` | mac_arp_tasks (15 dk) |
| `show arp` | `arp_entries` | mac_arp_tasks (15 dk) |
| `show interfaces status` | UI on-demand (Redis cache) + ⚠ snapshot ⚠ | UI talep ettiğinde |
| `show vlan` | UI on-demand (Redis cache) | UI talep ettiğinde |
| `show poe ...` | `poe_port_snapshots` | poe_tasks (15 dk) |
| `show version` | `devices.{model, firmware_version, serial_number}` | Fetch Info (manuel) |
| LLDP komutları | `topology_links`, `lldp_neighbors` | topology_tasks (6 saat) |

## 8. Parser hata vs privilege-denied output ayrımı

Bu **kritik bir noktadır** — incident'lerin önemli bir kısmı buradan çıkar.

### Privilege-denied output
Cihaz user mode'da iken `show interfaces status` çağrılırsa çıktı şuna benzer:
```
% User doesn't have sufficient privilege.
Switch>
```
veya
```
% Permission denied.
Switch>
```

- SSH **execution başarılı** (TCP + auth OK)
- Backend agent-relay → `success=True`, `output=<privilege-denied metin>`
- Parser (`_parse_interfaces`, `_parse_vlan`, vb.) bu metni okur; **regex eşleşmesi yok** → 0 entry üretir
- Redis cache 0-entry sonucu yazar (TTL 300s)
- UI "No ports found" / "No VLANs" gösterir
- audit_logs / agent_command_logs: `success=t` görür (komut çalıştı; sonuç anlamsız değil — sadece parser eşleşmedi)

**Sonuç:** Operatör için "boş veri" pek çok şey olabilir. Bu yüzden **ayırt etme yolu**:

1. agent_command_logs'a bak: `success=t` mi?
2. **Komutun raw output'unu** terminal manuel açıp çalıştırarak gör
3. Output'ta `privilege` / `permission` / `Permission denied` / `% Authorization failed` görüyorsan → privilege denied
4. Output **gerçekten boş** (cihazda PoE port yok, MAC table boş) ise → durum normal

### Parser hatası (gerçek)
Cihaz **modern privileged çıktı veriyor** ama parser regex yetmiyor.

- Tüm cihazlarda aynı kalıp ile boş geliyorsa → parser kovalanır
- Sadece bir model + firmware'da boş geliyorsa → regex pattern eklenir

[12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) içinde "privilege-denied'i ayrı sınıflandır" maddesi vardır.

## 9. MAC table neden boş olabilir

| Sebep | Doğrulama |
|---|---|
| Cihaz user mode'da kalmış | Raw output'a bak: privilege error var mı |
| Stale agent pool entry user-mode session ile reuse edilmiş | 5 dk bekle; tekrar dene |
| `mac_arp_tasks.collect_mac_arp_all` cycle çalışmıyor | `inspect active` + `inspect reserved`; flower; task son çalışma zamanı |
| Cihaz son onboard, henüz hiç cycle çalışmadı | İlk cycle'ı bekle (max 15 dk) |
| Cihaz gerçekten **boş** (kullanıcısı yok, lab cihazı) | Cihazda yapılı host var mı? |
| Parser hatası (gerçek) | Farklı firmware'da da boş mu? |

## 10. PoE 0 gerçek değer mi, collection failure mı

| Durum | Doğrulama |
|---|---|
| Cihaz **PoE destekli değil** (ör. core/distribution layer 3 switch) | Model + firmware'a bak; `show interfaces` çıktısında "PoE" yok |
| Cihaz PoE destekli ama hiçbir port'a güç verilmiyor | Cihazda gerçekten PoE etkin device bağlı mı |
| SNMP-first çağrı başarısız + SSH fallback failure | Cihaz user mode + enable_secret yanlış |
| `poe_tasks.snapshot_poe_status` cycle çalışmıyor | beat schedule + worker status |

`poe_port_snapshots` tablosu boşsa: önce `poe_tasks.snapshot_poe_status` cycle son çalıştırılmasına bak; sonra cihaz model bakımı yap.

## 11. Güvenli test komutları (`READ ONLY`)

Cihaza dokunmadan agent ve backend tarafını kontrol için:

```bash
# READ ONLY — agent host üzerinde
systemctl status netmanager-agent
journalctl -u netmanager-agent --since "10 min ago"

# READ ONLY — backend host üzerinde
docker compose logs --tail=100 backend | grep -i 'ssh\|agent\|error'

# READ ONLY — DB üzerinde (psql)
SELECT id, command, success, duration_ms, executed_at
FROM agent_command_logs
WHERE device_id = <ID>
ORDER BY executed_at DESC LIMIT 10;
```

Cihaza dokunan **güvenli** test komutları (privileged mode'da):
| Komut | Etkisi |
|---|---|
| `show version` | Sadece okuma |
| `show interfaces status` | Sadece okuma |
| `show vlan` | Sadece okuma |
| `show mac-address-table` | Sadece okuma |
| `show arp` | Sadece okuma |
| `show running-config | include hostname` | Sadece okuma |
| `show poe interfaces status` | Sadece okuma |
| `show ip interface brief` | Sadece okuma |

## 12. Kesinlikle yasak komutlar (Charon üzerinden)

Bu paketin kırmızı çizgileri:

- `configure terminal`
- `write memory` / `copy running-config startup-config`
- `reload`
- `clear ...`
- Herhangi bir `no ...` veya `interface ... shutdown / no shutdown`

UI'da bunlar **operatör onaylı playbook** veya **port_control endpoint'i** üzerinden yapılır; terminal sözlüğünde değil. Bir incident'ta operatör doğrudan terminal'den config moduna geçmemeli; bu hem audit'i bozar hem de Charon'un guard zincirini atlatır.

## 13. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- Ruijie default privilege 1 → enable 15 davranışı
- mac_arp.py `_parse_mac_table` 5 pattern (ruijie_rgos_pat + ruijie_dot_pat + ruijie_colon_pat + Cisco/Aruba)
- `topology_service.EXTENDED_COMMANDS` PoE komut tabanı (`show poe interfaces status` modern)
- agent_command_logs `success` flag'i komutun TCP/SSH execution başarısını gösterir, output anlamlılığını değil

### VERIFY BEFORE HANDOVER
- Eski (RGOS legacy) cihazlar için agent script SSH parametrelerinin tam listesi
- S6250 vs S5310 üretim dağılımı
- Aruba PoE parser durumu (HF#8 sonrası incident sprint kararı — historical internal context, VERIFY BEFORE HANDOVER)
- "show running-config" ile tam config diff almanın hangi modülden yapıldığı (config_builder vs backup_tasks)
