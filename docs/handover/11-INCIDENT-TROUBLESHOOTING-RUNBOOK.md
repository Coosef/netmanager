# 11 — Incident Troubleshooting Runbook

Bu dosya senaryo bazlı **karar ağaçlarını** içerir. Her senaryo şu yapıyı kullanır:

- **Belirti**
- **Muhtemel nedenler**
- **READ ONLY doğrulama**
- **Yasak müdahaleler**
- **Güvenli sonraki adım**
- **Escalation kriteri**

Genel kural: **önce gözle, sonra dokun**. Yıkıcı bir komut atmadan önce daima READ ONLY çıktıların bir incident evidence klasörüne yedeklenmesi tavsiye edilir ([10 §9](10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md)).

---

## Senaryo 1 — Cihaz "online" ama SSH çalışmıyor

**Belirti:** UI'da cihaz status `online`, ama Terminal açılmıyor / Fetch Info 502.

**Muhtemel nedenler:**
- Cihaz ICMP'ye cevap veriyor (heartbeat poller'ı kandırıyor) ama SSH port kapalı / lock-out
- Agent disconnected (UI'da cihaz status backend cache'inden geliyor olabilir)
- Pool entry stale + cihaz tarafı reddediyor
- enable_secret yanlış (privileged mode'a geçilemiyor)

**READ ONLY doğrulama:**
```sql
SELECT id, command, success, error, executed_at
FROM agent_command_logs
WHERE device_id = <ID>
ORDER BY executed_at DESC LIMIT 10;
```
+ Agent host: `journalctl -u netmanager-agent --since "10 min ago"`

**Yasak müdahaleler:**
- Cihaz config moduna gir, password değiştir
- `--no-verify` veya benzeri bypass
- Pool'u manuel "temizlemek" için agent restart (önce sebebi anla)

**Güvenli sonraki adım:**
- Error layer code'una göre Senaryo 2/3/4/5/6'ya geç

**Escalation:** Cihaz tarafında lock-out şüphesi varsa cihazın yöneticisi/SOC çağırılır.

---

## Senaryo 2 — TCP timeout

**Belirti:** SSH connect attempt 30 sn boyunca sürüyor, sonra timeout.

**Muhtemel nedenler:**
- Cihaz unreachable (ICMP yalan söylüyor olabilir)
- Cihaz reachable ama port 22 firewall ile kapalı
- Backend direct SSH path'inde (private IP cihaz, agent_id NULL)

**READ ONLY doğrulama:**
```bash
# Agent host'tan
ping -c 3 <device_ip>
nc -vz <device_ip> 22  # banner
```

**Yasak müdahaleler:**
- VPS public network'ten private IP cihaza erişmeyi denemek (zaten timeout)

**Güvenli sonraki adım:**
- Eğer cihaz private IP + `agent_id` NULL → cihaz kaydına agent ata, retry
- Cihaz tarafında erişim sorunu → saha personeline ulaş

**Escalation:** Cihaz bir saat içinde reachable olmazsa NOC.

---

## Senaryo 3 — Connection reset before banner

**Belirti:** SSH connect başarılı görünür ama remote host hemen RST gönderir, banner yok.

**Muhtemel nedenler:**
- Cihaz **brute-force lock-out** state'inde (yanlış parola tekrarı sonrası IP banlandı)
- Eski Ruijie firmware'da SSH session limit aşıldı
- Cihazın SSH daemon'u kapalı / restart sürecinde

**READ ONLY doğrulama:**
```sql
-- Son 30 dk içinde aynı device için auth failure say
SELECT count(*) FROM agent_command_logs
WHERE device_id = <ID>
  AND success = false
  AND executed_at > now() - interval '30 minutes';
```

**Yasak müdahaleler:**
- Aynı credential'la art arda retry — lock-out süresini uzatır
- Cihaz config moduna geçip auth log temizleme

**Güvenli sonraki adım:**
- Lock-out süresinin geçmesini bekle (cihaza göre 5-15 dk)
- Bu sırada yeni SSH denemesi YAPMA

**Escalation:** Lock-out 30 dk içinde temizlenmezse cihaz local console erişimi gerekir.

---

## Senaryo 4 — Authentication failed

**Belirti:** Agent log'da `Authentication (password) failed.`

**Muhtemel nedenler:**
- DB'deki şifre değeri cihazdaki güncel şifre değil
- Bulk credential update sonrası ama 10 dk dolmadı (eski pool oturumu hala canlı; **fakat agent yeni oturum açmaya çalışıyorsa bu artık eski credential'a sahip değil, hata gerçek**)
- Cihaz hesabı disabled / locked

**READ ONLY doğrulama:**
```sql
-- Son 5 dk içinde aynı device için authentication failed
SELECT count(*), max(executed_at) FROM agent_command_logs
WHERE device_id = <ID>
  AND error ILIKE '%authentication%'
  AND executed_at > now() - interval '5 minutes';
```

**Yasak müdahaleler:**
- 10 dk dolmadan tekrar tekrar Fetch Info — pool stale durumda anlamsız retry; auth fail eskalasyonu

**Güvenli sonraki adım:**
- Bulk update yapıldıysa 10 dk daha bekle
- 10 dk sonra hala fail → cihazdaki gerçek credential'ı doğrula
- Cihaz credential'ı doğru ise UI'dan tekrar set et + 10 dk daha bekle

**Escalation:** Sahibinden konfirmasyon alındığı halde fail devam ediyorsa cihaz reset.

---

## Senaryo 5 — Enable mode failed

**Belirti:** SSH success, ama `enable` komutu sonrası `% Authentication failed` veya benzeri.

**Muhtemel nedenler:**
- DB'deki `enable_secret` cihazdaki gerçek enable password ile eşleşmiyor
- Bulk credential copy yapıldı ama kaynak cihazın enable_secret'i hedef cihazda farklı

**READ ONLY doğrulama:**
- Terminal manuel olarak aç → user prompt `>` → `enable` yaz → password gir → cihaz kabul ediyor mu
- DB enable_secret'i 100 bayt mı (boş değil) — sadece var olduğunu doğrula, **değerini görüntüleme**

**Yasak müdahaleler:**
- `enable secret <yeni>` cihazda config moduna girip değiştirme

**Güvenli sonraki adım:**
- Doğru enable_secret'i UI'dan set et
- 10 dk pool/cache turnover bekle

**Escalation:** Doğru enable_secret bilinmiyorsa cihazın local console kurtarma akışı.

---

## Senaryo 6 — User mode privilege denied

**Belirti:** SSH success, ama `show interfaces status` çıktısı `% User doesn't have sufficient privilege.`

**Muhtemel nedenler:**
- enable_secret eksik veya yanlış → user mode'da kalındı
- Agent script `enable()` çağrısı yapmadı (Ruijie + enable_secret YOK kombinasyonu)
- Pool entry user-mode oturumla reuse edildi

**READ ONLY doğrulama:**
- DB: `enable_secret_enc` NULL mı? (sadece `IS NULL` kontrolü, **değer okuma yok**)
- agent_command_logs raw error'larında privilege/permission var mı

**Yasak müdahaleler:**
- Cihaza config mode'dan elle "privilege 15" verme
- Cihaz user'ı silip yenisini açma

**Güvenli sonraki adım:**
- enable_secret eksikse UI'dan ekle
- 10 dk pool turnover bekle
- 10 dk sonra raw output'ta hala privilege error varsa cihaz user'ı düşürülmüş olabilir → cihaz sahibine sor

**Escalation:** Cihaz config'inde user yetkisi düşürüldüyse.

---

## Senaryo 7 — Fetch Info başarılı ama port/VLAN/MAC boş

**Belirti:** `device_info_fetched` audit log success=t; ama Ports / VLAN / MAC tab'ı boş.

**Muhtemel nedenler:**
- Senaryo 6 (user mode + privilege denied) — Fetch Info `show version` user mode'da çalışır, ama ports/vlan privileged ister
- mac_arp / poe / topology task'ları henüz cycle düşmedi
- Parser hatası

**READ ONLY doğrulama:**
- agent_command_logs son 30 dk hangi komutlar başarılı, hangileri output döndürmüş
- `mac_address_entries` / `poe_port_snapshots` tablolarında son insert ne zaman

**Yasak müdahaleler:**
- Beat'i yeniden tetikle, queue purge, hızlı zoraki invalidate
- Cache key elle sil

**Güvenli sonraki adım:**
- Bir periyodik cycle gelene kadar (15 dk) bekle, sonra tekrar bak
- Hala boşsa Senaryo 6 + 8'e geç

**Escalation:** İki cycle (30 dk) sonra hala boş → derinleştir.

---

## Senaryo 8 — Ports tab "No ports found"

**Belirti:** Cihaz online, audit log clean, Ports tab "No ports found".

**Muhtemel nedenler:**
1. Stale interfaces cache (5 dk TTL)
2. Stale agent pool entry user-mode reuse
3. Parser empty (privilege denied çıktısı)
4. Cihaz **gerçekten** port yok (lab cihaz)

**READ ONLY doğrulama:**
- son cache hit zamanı: backend log'da `/interfaces` 60-180ms response süresi cache hit demek
- agent_command_logs son 5 dk `show interfaces status` success=t mi
- Cihazda tipik port adı bekleniyor mu (Cisco 24-port = `GigabitEthernet0/1..24`)

**Yasak müdahaleler:**
- Manuel `DEL cache:device:o=<org>:<id>:interfaces` ile cache invalidate
- Agent restart (pool turnover doğal süreçten daha hızlı olmaz)

**Güvenli sonraki adım:**
- 10 dk bekle (cache + pool turnover)
- 10 dk sonra hala boşsa raw output'ta privilege error var mı bak → Senaryo 6
- Senaryo 6 ekarte edilmişse parser tarafı incelenir

**Escalation:** 30 dk bekle, hala boş ve raw output sağlıklı (port satırları var) → parser issue → backend ekibi.

---

## Senaryo 9 — MAC table 0

**Belirti:** `mac_address_entries WHERE device_id=X` 0 satır.

**Muhtemel nedenler:**
- mac_arp_tasks cycle henüz çalışmamış (cihaz yeni onboard)
- Cihaz user mode'da → parser empty
- Cihaz gerçekten **boş** (lab veya yeni kurulu)
- mac_arp_tasks worker (`monitor` queue) down

**READ ONLY doğrulama:**
- Flower → mac_arp_tasks.collect_mac_arp_all son success
- Worker healthy mi (`celery_worker inspect ping`)
- Cihaza Terminal manuel aç → `show mac-address-table` raw çıktısını gör

**Yasak müdahaleler:**
- Cycle'ı zorla tetikle (`celery -A app.workers.celery_app call mac_arp_tasks.collect_mac_arp_all`) — bilerek yapılmadıkça bu gerekli değil

**Güvenli sonraki adım:**
- Cihaz online + cycle son 15 dk + raw output dolu ise parser issue
- Cihaz online + cycle YOK ise worker tarafı incele
- Cihaz user mode → Senaryo 6

**Escalation:** Worker `down` → SRE; parser → backend.

---

## Senaryo 10 — PoE 0

**Belirti:** `poe_port_snapshots WHERE device_id=X` 0 satır.

**Muhtemel nedenler:**
- Cihaz PoE destekli değil (gerçek 0)
- poe_tasks worker down
- SNMP-first failure + SSH fallback failure
- Cihaz user mode (privilege denied)
- Eski model (S6250) için ayrı PoE komutu — Aruba PoE parser HF#8 sonrası — ⚠ VERIFY

**READ ONLY doğrulama:**
- Cihaz modeli PoE destekliyor mu (`devices.model` lookup)
- poe_tasks son success
- Raw çıktıda `show poe` veya `show power inline` ne dönüyor

**Yasak müdahaleler:**
- `power inline ...` cihaz tarafında elle değişiklik

**Güvenli sonraki adım:**
- Cihaz PoE destekliyse: parser path doğrulanır
- Worker tarafı incele

**Escalation:** Aynı.

---

## Senaryo 11 — Celery worker down

**Belirti:** `docker compose ps` worker `unhealthy` veya `Exit`.

**Muhtemel nedenler:**
- OOM (mem_limit aşımı)
- SIGBUS (tmpfs saturation — tarihsel 2026-05-21 incident'ı)
- Application exception
- Manual kill

**READ ONLY doğrulama:**
- `docker inspect <id> --format='{{.State.OOMKilled}} {{.State.ExitCode}}'`
- `docker compose logs --tail=200 <worker>`
- `dmesg | grep -i oom`
- `df -h /tmp` ve tmpfs durumu

**Yasak müdahaleler:**
- `down -v` (volume sileceği için DB/Redis yok olur)
- queue purge (worker problemi temizlemez)

**Güvenli sonraki adım:**
- `[SAFE RESTART]` `docker compose restart <worker>`
- Restart sonrası `inspect ping` cevap veriyor mu?
- OOM tekrar ediyorsa: ilgili task batch'ini geçici azalt veya `mem_limit` artır (compose edit + recreate)

**`mem_limit` artırma rollback kriteri:**
- Artış sonrası 24 saat içinde **diğer container'lar OOM'a girmeye başlarsa** (toplam host belleği yetmiyor) → eski değere geri al.
- 24 saat içinde aynı worker OOM'a girmemiş ama agresif throttling görünüyorsa → değer kalır, ek artış için ayrı plan.
- Geri alma: compose dosyasındaki `mem_limit` değerini eski değere döndür + `docker compose up -d --force-recreate <worker>`.

**Escalation:** OOM kalıcı / tmpfs tekrar saturate ediyorsa SRE + backend ekibi.

---

## Senaryo 12 — Redis backlog

**Belirti:** Queue depth `inspect reserved`'da yüksek; UI'da işlemler gecikiyor.

**Muhtemel nedenler:**
- Cihaz tarafı yavaşladı (her task daha uzun sürüyor)
- Worker count yetersiz (cihaz sayısı arttı, concurrency aynı)
- Burst (event_consumer stream patlaması)

**READ ONLY doğrulama:**
- `inspect active` + `inspect reserved`
- Redis `INFO memory`, `INFO stats` — `rejected_connections`?
- Hangi task module yığılıyor?

**Yasak müdahaleler:**
- `purge` (DO NOT RUN CASUALLY)
- `FLUSHDB`

**Güvenli sonraki adım:**
- Geçici olarak `celery_beat` durdurulabilir (yeni task üretimini durdurur)
- Worker concurrency artırılabilir (compose edit + recreate)

**Escalation:** Backlog 30 dk'da düşmüyorsa.

---

## Senaryo 13 — Agent disconnected

**Belirti:** Agents sayfasında `last_seen_at` 5 dk'dan eski; UI cihazlarda 502.

**Muhtemel nedenler:**
- Agent host down
- Agent host network problemi (DNS / firewall)
- Backend recreate sonrası agent reconnect aşaması
- Nginx 1 saatlik timeout dolmuş + agent reconnect denemiyor

**READ ONLY doğrulama:**
- Agent host: `systemctl status netmanager-agent`
- Agent host: `journalctl -u netmanager-agent -n 50`
- Backend: `docker compose logs --tail=200 backend | grep -i agent`

**Yasak müdahaleler:**
- Backend full restart (gereksiz; tüm agent'lar yeniden bağlanır)
- Agent host'ta reboot

**Güvenli sonraki adım:**
- Agent host'ta `systemctl restart netmanager-agent`
- 30 sn içinde `last_seen_at` güncelleniyor mu

**Escalation:** Agent host network problemi varsa saha personeli.

---

## Senaryo 14 — Agent connected ama snapshot yok

**Belirti:** Agents sayfasında agent online; ama cihazlar üzerinde komut sonuçları gelmiyor / snapshot tabloları boş.

**Muhtemel nedenler:**
- Agent backend'in **farklı bir process'ine** bağlanmış (`Agent not connected to this process` hata mesajı)
- Backend horizontal scale ediliyorsa worker process pin'leme gerekir
- Agent enroll edildi ama organization/location yanlış scope

**READ ONLY doğrulama:**
- Backend log'da "Agent X not connected to this process" mesajı var mı
- Agent script'in son komut başarı oranı

**Yasak müdahaleler:**
- "Random agent restart" — sebep bilinmeden

**Güvenli sonraki adım:**
- Backend tek process ise: agent reconnect bekle (60 sn)
- Çok process ise (uvicorn workers > 1): connection registry tutarlılığı doğrulanır — ⚠ VERIFY

**Escalation:** Multi-process backend + agent registry issue → backend ekibi.

---

## Senaryo 15 — Backend private IP'ye direct SSH deniyor

**Belirti:** Yeni cihaz onboard sonrası Fetch Info ~30 sn asılı kalıyor, sonra 502 TCP timeout.

**Muhtemel nedenler:**
- Cihaz private IP + `agent_id IS NULL` → backend doğrudan SSH dener → public network'ten erişilemez

**READ ONLY doğrulama:**
```sql
SELECT id, name, ip_address, agent_id FROM devices WHERE id = <ID>;
```
- `agent_id` NULL + IP private (`10.*`, `172.16-31.*`, `192.168.*`) → tanı kesin

**Yasak müdahaleler:**
- Cihaz IP'sini değiştirmek

**Güvenli sonraki adım:**
- Cihaz kaydına uygun lokasyonun agent'ını ata (UI: Edit → Agent dropdown)
- Fetch Info tekrar dene

**Escalation:** Saha tarafında agent yoksa agent kurulum ihtiyacı var.

---

## Senaryo 16 — Duplicate device record

**Belirti:** Bir cihaz için iki ayrı satır görüyorsun (aynı IP/hostname).

**Muhtemel nedenler:**
- Onboard sırasında IP unique check aşıldı
- Bulk import duplicate kontrol yetmedi

**READ ONLY doğrulama:**
```sql
SELECT id, name, ip_address, agent_id, organization_id, location_id, created_at, deleted_at
FROM devices WHERE ip_address = '<IP>' AND deleted_at IS NULL;
```

**Yasak müdahaleler:**
- `DELETE FROM devices WHERE id=X` (FK referansları kırılır)

**Güvenli sonraki adım:**
- Hangi kayıt aktif kullanılıyor: agent_command_logs son aktivite hangisi için
- Diğerini UI'dan soft-delete (`devices.delete` yetkisi)

**Escalation:** Bulk import'ta yapılmışsa import job sahibine bildir.

---

## Senaryo 17 — Cloudflare upstream / 502

**Belirti:** Browser'da CF error page veya 502.

**Muhtemel nedenler:**
- Backend container recreate (CF sticky cache window)
- Origin nginx down / yanlış config
- Backend gerçek 5xx

**READ ONLY doğrulama:**
- Origin'i bypass et: `curl --resolve` ile direkt VPS IP'sine bak (bkz. [10 §10](10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md))
- `docker compose ps` — backend healthy mi
- `docker compose logs --tail=100 backend`

**Yasak müdahaleler:**
- "Hemen rollback" — CF cache window olabilir; 60 sn bekle

**Güvenli sonraki adım:**
- Backend healthy + origin curl 200 → CF cache; **30-60 sn bekle**
- Backend healthy değilse [10 §8 sistem recovery sırası](10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md)
- Backend 5xx döndürüyorsa log'dan exception bul, fix

**Escalation:** CF tarafında WAF kuralı blokluyor olabilirse CF panel sahibi.

---

## Genel escalation matrisi

| Severity | Tanım | İlk müdahale |
|---|---|---|
| **P1 — Outage** | UI tamamen erişilemez, veya kritik veri kaybı | On-call SRE + backend lead immediate |
| **P2 — Degradation** | Yüksek hata oranı, bazı modüller patlamış | On-call SRE 30 dk içinde |
| **P3 — Single tenant** | Tek organizasyon/lokasyon etkilenmiş | NOC + ilgili müşteri sahibi |
| **P4 — Cosmetic / non-blocking** | UI bug, tek cihaz sorunu | Backlog'a düşer |

## Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- Senaryo 3 lock-out davranışı (Site-A pilot Ruijie incident'ında gözlendi)
- Senaryo 5 enable mode failure pattern (Site-A pilot Ruijie incident'ında gözlendi)
- Senaryo 8 pool + cache TTL = 5 dk + 5 dk pattern
- Senaryo 11 OOM vs SIGBUS tmpfs distinction (incident 2026-05-21)
- Senaryo 17 CF sticky 5xx window (pentest finding 1)

### VERIFY BEFORE HANDOVER
- Worker concurrency artırma için emin etken nedir (cihaz sayısı, OOM olmadan ne kadar büyütülebilir)
- Backend multi-process scenario (uvicorn workers > 1) production'da uygulanıyor mu — Senaryo 14
- Cloudflare WAF kural envanteri — Senaryo 17
