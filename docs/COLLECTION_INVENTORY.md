# NetManager — Veri Toplama Envanteri

> **Soru:** "SSH ile ne bilgi, SNMP ile ne bilgi topluyoruz, neler yapabiliyoruz?"
>
> **Cevap:** Bu doküman canlı sistemin veri toplama kanallarını + neyi ne sıklıkta + nereye yazdığını listeler. T9 Tur 1 madde #10'un çıktısıdır.
>
> Son güncelleme: 2026-05-26 (canlı kod taraması).

---

## 1️⃣ Veri Toplama Kanalları — Yüksek Düzey

| Kanal | Protokol | Hedef | Tetikleyici |
|---|---|---|---|
| **SSH (Netmiko)** | TCP/22 (genelde) | Cihaz CLI komutları | Celery beat + on-demand UI |
| **SNMP (PureSNMP)** | UDP/161 | Cihaz MIB sorguları | Celery beat (5dk) |
| **Agent (WebSocket)** | WSS | Yerel SSH/SNMP relay + syslog dinleme + edge analytics | Sürekli (canlı bağlantı) |
| **Syslog (UDP/Redis Stream)** | UDP/514 (agent) → backend WS → Redis Stream | Olay ingestion | Real-time |
| **SNMP Trap (UDP)** | UDP/162 (agent) → backend WS | Trap ingestion | Real-time |
| **ICMP / TCP probe (agent)** | ICMP + TCP | Erişilebilirlik testi | Periyodik (synthetic probes) |

---

## 2️⃣ SSH ile Toplanan Veriler

Tüm SSH komutları **agent üzerinden relay** edilir (varsa agent_id) veya **doğrudan paramiko/netmiko** ile (fallback). Komut sonuçları parse edilip yapılandırılmış tablolara yazılır.

### A) Periyodik (Celery beat tetiklenir)

| Komut | Vendor/OS | Hedef Tablo | Frekans | Kaynak |
|---|---|---|---|---|
| `show mac address-table` / `show mac-address-table` / `show mac-address` / `display mac-address` | Cisco / Aruba / HP / Ruijie+Comware | `mac_address_entries` | **15dk** | `mac_arp_tasks.collect_mac_arp_all` |
| `show arp` / `display arp` | Cisco/Ruijie / Comware | `arp_entries` | **15dk** | `mac_arp_tasks.collect_mac_arp_all` |
| `show vlan brief` / `show vlan` | Cisco / Aruba+Ruijie | `network_baseline.known_vlans` | **Günlük** | `behavior_analytics_tasks.update_baselines` |
| `show lldp neighbors detail` / `show lldp info remote-device detail` / `show lldp neighbor-info detail` | Cisco / Aruba OSSwitch / AOS-CX | `topology_links` | **6 saat** | `topology_tasks.scheduled_topology_discovery` |
| `show cdp neighbors detail` | Cisco | `topology_links` | **6 saat** | `topology_tasks.scheduled_topology_discovery` |
| `show running-config` (diff için) | Tüm | `config_backups` (hash karşılaştırma) | **Günlük** | `backup_tasks.check_config_drift` |

### B) On-demand (kullanıcı veya servis tetikler)

| Komut | Vendor/OS | Kullanım | Tetikleyici |
|---|---|---|---|
| `show vlan brief` / `show vlan` | Tüm | "Tümünü Yenile" — VLAN snapshot al | `interfaces.py:vlans-refresh` |
| `show interfaces status` / `brief` | Tüm | Cihaz detay → portlar listesi | `interfaces.py` cache |
| `show running-config` | Tüm | Manuel backup veya diff | `backup_tasks` + UI |
| `show version` | Tüm | İlk discovery + model/firmware tespit | `devices.py:1284` (init) |
| `show interfaces switchport` | Cisco/Ruijie | Topology zenginleştirme (mode, vlan) | `topology_service.py:164` |
| `show power inline` | Cisco/Ruijie | Topology PoE bilgisi | `topology_service.py:165` |

### C) Interactive (kullanıcı SSH terminal'i)

| Şey | Açıklama |
|---|---|
| Terminal session (browser ↔ backend ↔ agent ↔ device) | Agent-relay 3-tier WS bridge (T8.5'te yapıldı). Keystroke + çıktı şu an **persistent log'a yazılmıyor** — Tur 3'te ekleyeceğiz |
| Komut audit | `agent_command_logs` tablosu — API komutları (vlan refresh vb) — interactive session **kapsamda değil** |

---

## 3️⃣ SNMP ile Toplanan Veriler

`backend/app/services/snmp_service.py` + `app/workers/tasks/snmp_tasks.py`

### A) Periyodik (her 5 dakika — `poll_snmp_all`)

| OID | Tanım | Hedef |
|---|---|---|
| `1.3.6.1.2.1.2.2.1.*` | ifTable — interface counter'lar (octets, packets, errors, discards) | `snmp_poll_results` |
| `1.3.6.1.2.1.31.1.1.1.*` | ifXTable — 64-bit counter'lar (high-speed link'ler için) | `snmp_poll_results` |

### B) On-demand (`snmp_get` / `snmp_walk` endpoint)

| OID | Tanım | Vendor |
|---|---|---|
| `1.3.6.1.2.1.1.1.0` | sysDescr | Standart |
| `1.3.6.1.2.1.1.5.0` | sysName | Standart |
| `1.3.6.1.2.1.1.3.0` | sysUpTime | Standart |
| `1.3.6.1.2.1.1.6.0` | sysLocation | Standart |
| `1.3.6.1.2.1.25.3.3.1.2` | hrProcessorLoad (Host Resources MIB) | Standart |
| `1.3.6.1.2.1.25.2.3.1.*` | hrStorage — bellek/disk | Standart |
| `1.3.6.1.4.1.9.2.1.57.0` | Cisco eski CPU (avgBusy5) | Cisco |
| `1.3.6.1.4.1.9.9.109.1.1.1.1.8.1` | Cisco yeni CPU (cpmCPUTotal5min) | Cisco |
| `1.3.6.1.4.1.9.9.48.1.1.1.*` | Cisco bellek havuzları | Cisco |

### ❗ Henüz SNMP ile çekmediklerimiz (T9 Tur 6 hedefi)
- **POWER-ETHERNET-MIB** — `pethMainPseConsumptionPower`, `pethPsePortPowerSupportedSwitchPoEPlus` (PoE port gücü)
- **ENTITY-SENSOR-MIB** — `entPhySensorValue` (sıcaklık, gerilim, fan)
- **ENTITY-MIB** — `entPhysicalName`, `entPhysicalSerialNum` (donanım envanteri)

---

## 4️⃣ Agent (Proxy) İşlevleri

`backend/agent_script/netmanager_agent.py` (v1.4.0) + `backend/app/services/agent_manager.py`

### Backend → Agent komut tipleri

| Mesaj | Amaç | Sonuç |
|---|---|---|
| `ssh_command` | Tek SSH komutu çalıştır | `ssh_result` |
| `ssh_config` | Çoklu config push (configure terminal mode) | `ssh_result` |
| `ssh_command_stream` | Uzun çıktı — streamleyerek getir | `ssh_stream_chunk` + `ssh_stream_end` |
| `ssh_shell_open/input/resize/close` | İnteraktif terminal session | `ssh_shell_output` / `ssh_shell_closed` (T8.5) |
| `snmp_get` | Tek OID çek | `snmp_result` |
| `snmp_walk` | Bir OID alt-ağacını çek | `snmp_result` |
| `discover_request` | Subnet scan (TCP port probing) | `discover_result` |
| `ping_check` | ICMP probe | `ping_result` |
| `synthetic_probe` | TCP/DNS/HTTP latency ölçüm | `synthetic_probe_result` |
| `security_config` | Komut whitelist/blacklist güncelle | (ack yok) |
| `key_rotate` | Agent anahtarı değiştir | `key_rotate_ack` |
| `update_available` | Yeni script versiyonu push | `update_ack` / `update_failed` |
| `restart` | Agent process'i yeniden başlat | `restart_ack` |

### Agent → Backend (kendi inisiyatifi)

| Mesaj | Veri | Tetikleyici |
|---|---|---|
| `hello` | Versiyon, platform, hostname, capability flags | Connect anında |
| `heartbeat` | last_heartbeat (her 10s) | Periyodik |
| `device_status_report` | Cihazların online/offline durumu (agent kendisi ping atar) | Periyodik (5dk) |
| `syslog_event` | Syslog mesajları (agent UDP/514'te dinler) | Real-time |
| `snmp_trap` | SNMP trap'ları (agent UDP/162'de dinler) | Real-time |
| `local_anomaly` | Agent edge intelligence anomalileri | Threshold aşımında |
| `queued_results` / `queued_events` | Offline'da biriken mesajlar | Reconnect'te dump |

---

## 5️⃣ Discovery & Topology

| İşlem | Kaynak | Hedef | Frekans |
|---|---|---|---|
| Subnet TCP scan | Agent `discover_request` (port 22, 80, 443, ...) | `discovery_results` | On-demand |
| LLDP/CDP komşu | SSH komutu (vendor-aware) | `topology_links` | 6 saat |
| Port detay (mode/vlan/duplex/poe) | SSH ek komutlar | `topology_links` zenginleştir | 6 saat |
| Topology drift | `topology_links` ↔ `topology_snapshot` (golden) | `network_events` (topology_drift) | 6 saat |

---

## 6️⃣ Anomaly Detection (Davranış Analitiği)

`behavior_analytics_tasks.py`

| Anomali tipi | Veri kaynağı | Karşılaştırma | Frekans |
|---|---|---|---|
| `mac_anomaly` | `mac_address_entries` | MAC sayısı 2× baseline | 30dk (`detect_anomalies`) |
| `traffic_spike` | `snmp_poll_results` (counter delta) | Trafik 2× baseline | 30dk |
| `vlan_anomaly` | `mac_address_entries` (canlı VLAN'lar) vs `network_baseline.known_vlans` | Beklenmeyen VLAN | 30dk |
| `mac_loop_suspicion` | `mac_address_entries` | Aynı MAC farklı portlarda | 30dk |
| `topology_drift` | `topology_links` vs `topology_snapshot` | Bağlantı ekleme/kaybı | 6 saat (`check_topology_drift`) |
| `agent_offline` | WS bağlantı durumu | 20s debounce sonrası | Anlık (agent disconnect) |
| `agent_online` | WS bağlantı durumu | reconnect | Anlık |
| `device_offline` | `poll_device_status` ping/SSH check | 3 ardışık fail | 5dk |
| `backup_failure` | `backup_tasks` çıktısı | Backup retry sonrası fail | Günlük |
| `local_anomaly` | Agent edge intelligence | Agent threshold | Real-time |

---

## 7️⃣ Celery Beat — Tüm Periyodik İşler

`backend/app/workers/celery_app.py:74-182`

| Task | Frekans | Hedef |
|---|---|---|
| `poll_device_status` | 5dk | Cihaz erişilebilirliği (ping/SSH check) |
| `poll_snmp_all` | 5dk | SNMP arayüz counter'lar |
| `collect_mac_arp_all` | 15dk | MAC + ARP tabloları |
| `run_synthetic_probes` | 1dk | TCP/DNS/HTTP latency |
| `process_notifications` | 5dk | Notification queue boşalt |
| `evaluate_escalation_rules` | 5dk | Eskalasyon kuralları |
| `cleanup_stale_tasks` | 30dk | Yarım kalmış task'ları temizle |
| `detect_anomalies` | 30dk | Davranış anomalileri |
| `measure_agent_peer_latency` | 15dk | Agent ↔ agent ping (HA için) |
| `check_topology_drift` | 6 saat | Topology snapshot karşılaştırma |
| `scheduled_topology_discovery` | 6 saat | LLDP/CDP yeniden tarama |
| `warm_aggregation_cache` | 60s | Dashboard cache ısıtma |
| `collect_infrastructure_metrics` | 60s | Prometheus metric'leri |
| `update_baselines` | Günlük | MAC/trafik/VLAN baseline |
| `check_config_drift` | Günlük | Config değişim tespiti |
| `check_lifecycle_expirations` | Günlük | Garanti/EoL süre kontrolü |
| `check_rotation_policies` | Günlük | Credential rotation |
| `compute_availability_scores` | Günlük | Cihaz uptime skoru |
| `cleanup_old_data` | Günlük | Retention (90gün+) — agent_command_logs, network_events, vs |
| `backup_configs_daily` | Günlük | Otomatik config backup |
| `send_weekly_digest` | Haftalık | Email özet |
| `weekly_compliance_scan` | Haftalık | Security audit |
| `check_backup_schedules` | 1dk | Backup zamanlamaları kontrol |
| `check_sla_breaches` | Günlük | SLA ihlal kontrolü |
| `run_scheduled_playbooks` | 1dk | Playbook scheduler |

---

## 8️⃣ Yapılabilen İşlemler (Outbound Actions)

| İşlem | Protokol | Kaynak | Hedef Vendor |
|---|---|---|---|
| Config push | SSH (configure terminal) | `interfaces.py`, `change_rollouts.py`, `playbooks.py` | Tüm |
| Config backup | SSH (`show running-config`) | `backup_tasks.py` | Tüm |
| Config restore (rollback) | SSH (toplu config push) | `change_rollouts.py:rollback` | Tüm (UI eksik — T9 Tur 5) |
| Bulk command | SSH | `bulk_tasks.py` | Tüm |
| Playbook execution | SSH multi-step | `playbook_tasks.py` | Tüm |
| Password change | SSH config push | `rotation_tasks.py` | Tüm |
| Port shutdown / PoE control | **YOK — T9 Tur 4 hedefi** | — | — |
| Firmware update | **YOK — T9 Tur 8 hedefi** | — | — |

---

## 9️⃣ Ana Veri Tabloları (Özet)

| Tablo | İçerik | Veri kaynağı |
|---|---|---|
| `devices` | Cihaz envanteri (IP, model, firmware_version, agent_id, location_id) | İlk kayıt + show version |
| `snmp_poll_results` | Time-series interface counter'lar | SNMP poller (5dk) |
| `mac_address_entries` | MAC + VLAN + port + last_seen | SSH (15dk) |
| `arp_entries` | IP ↔ MAC + last_seen | SSH (15dk) |
| `topology_links` | Cihaz↔cihaz bağlantı listesi (LLDP/CDP) | SSH (6 saat) |
| `network_baseline` | Cihaz başına MAC/trafik/VLAN baseline | Anomaly engine günlük |
| `network_events` | Tüm uyarı/anomali kayıtları | Tüm anomaly detector'lar |
| `syslog_entries` | Syslog mesajları | Agent UDP/514 → WS → Redis stream → DB |
| `config_backups` | Cihaz config snapshot'ları + hash + is_golden | `backup_tasks` (günlük) |
| `agent_command_logs` | API/batch komut audit (135K satır, 87MB) | Agent her SSH komutu |
| `discovery_results` | Subnet TCP scan sonuçları | On-demand `discover_request` |
| `agent_peer_latencies` | Agent↔agent ping latency (HA için) | `agent_peer_tasks` (15dk) |
| `synthetic_probe_results` | TCP/DNS/HTTP probe latency | `synthetic_tasks` (1dk) |
| `device_availability_snapshots` | Cihaz uptime time-series | `availability_tasks` (günlük) |

---

## 🔄 Veri Akış Diyagramı (Yüksek Düzey)

```
                    ┌─────────────────┐
                    │  Switch/Router  │
                    └────────┬────────┘
                             │ SSH/22 + SNMP/161 + syslog/514 + trap/162
                             │
                    ┌────────▼────────┐
                    │ Local Agent     │ (LAN içinde, müşteri ortamında)
                    │ v1.4.0          │
                    │ • SSH relay     │
                    │ • SNMP probe    │
                    │ • Syslog listen │
                    │ • Trap listen   │
                    │ • Edge analytics│
                    └────────┬────────┘
                             │ WSS (TLS)
                             │
                    ┌────────▼────────┐
                    │ Backend (VPS)   │
                    │ • agent_manager │
                    │ • celery worker │
                    │ • celery beat   │
                    └────────┬────────┘
                             │
        ┌────────────────────┼──────────────────────┐
        │                    │                      │
   ┌────▼────┐         ┌────▼─────┐          ┌────▼──────┐
   │Postgres │         │  Redis   │          │  Frontend │
   │+RLS+TS  │         │ (stream  │          │  (React)  │
   │         │         │  cache)  │          │           │
   └─────────┘         └──────────┘          └───────────┘
```

---

## 📌 T9 Tur'larında Bu Envanterin Önemi

- **Tur 1 (#1):** Bu Celery beat schedule UI üzerinden ayarlanacak — admin frekansları değiştirebilsin
- **Tur 3 (#6):** Interactive SSH terminal hâlâ persistent log dışında — eklenecek
- **Tur 4 (#8):** Port shutdown/PoE — SSH command set'i genişletilecek (vendor wrapper)
- **Tur 5 (#11):** Easy config builder zaten driver_template kullanıyor — schema-driven form üretici
- **Tur 6 (#13):** SNMP polling'e POWER-ETHERNET-MIB + ENTITY-SENSOR-MIB eklenecek
- **Tur 8 (#5+#15):** Firmware update için yeni protokol katmanı (TFTP/SCP/HTTP)

---

*Bu doküman canlı sistemin durumudur. Yeni veri kaynağı eklendiğinde veya bir kanal değiştiğinde güncellenmelidir.*
