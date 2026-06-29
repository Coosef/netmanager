# 06 — Agent Kurulumu ve Operasyonu

## 1. Agent nedir, neden var

Cihazların büyük çoğunluğu **private IP** üzerinde durur ve VPS public network'ten doğrudan SSH ile erişilemez. Charon Agent, saha tarafında çalışan ve backend ile **WebSocket** üzerinden konuşan bir Python servisidir. Backend bir SSH/SNMP/LLDP komutu yapacaksa onu agent'a iletir; agent komutu private network içinde cihaza yürütür ve sonucu döner.

## 2. Desteklenen host / OS varsayımları

| Agent türü | Host OS | Durum |
|---|---|---|
| **Linux Agent (canonical)** | Ubuntu / Debian, systemd (✅ üretimde) | Üretim hazır |
| **Windows Agent v2** | Windows Server 2019+, PowerShell 5.1, AMD64, embedded Python 3.12 | Geliştirme — feature flag `WINDOWS_AGENT_V2_ENABLED=False` default |
| Mac (operatör test) | macOS, geliştirme amaçlı | Standart üretim case'i değil |

> ⚠ **VERIFY BEFORE HANDOVER**: Windows Agent v2 manuel test paketi `windows-agent-v2-manual-test/` altında; production'da bu flag açık değil. İlk validation campaign BLOCKED kapanışla sonuçlanmıştır (historical internal context — VERIFY BEFORE HANDOVER).

## 3. Linux Agent kurulumu (özet)

Tipik kurulum dizini: `/opt/netmanager-agent/`

| Bileşen | Yol (öneri) |
|---|---|
| Agent script | `/opt/netmanager-agent/netmanager_agent.py` |
| Python venv | `/opt/netmanager-agent/venv/` |
| Konfigürasyon | `/etc/netmanager-agent/config.env` veya `/opt/netmanager-agent/.env` |
| Systemd unit | `/etc/systemd/system/netmanager-agent.service` |
| Log | `journalctl -u netmanager-agent` |

Konfigürasyon (`.env`) anahtarları (örnek, **değer YOK**):
```
NETMANAGER_BACKEND_URL=
NETMANAGER_AGENT_KEY=
LOG_LEVEL=
```

Kurulum akışı (üst seviye, **değerler asla doküman içinde değildir**):

1. UI'dan veya CLI'dan **agent enroll** edilir; geri dönüşte `agent_key` (one-shot plaintext) alınır.
2. Host'a `netmanager_agent.py` + Python venv kopyalanır.
3. `.env` dosyası yazılır, backend URL + agent_key konur, ACL `chmod 600` + sahibi servis hesabı.
4. Systemd unit yüklenir, `systemctl enable --now netmanager-agent`.
5. Backend tarafında agent satırı `last_seen_at` günceller → UI Agents tablosu agent'ı "online" gösterir.

> ⚠ **VERIFY BEFORE HANDOVER**: Windows Agent v2 plan dokümanı ("Plan v11") devir veren ekip tarafından ayrı ve güvenli kanaldan teslim edilir. Linux için onaylı script paketinin tam dosya yolu da devir öncesinde doğrulanmalı.

## 4. Agent servis adı ve health kontrolü

| İşlem | Komut | Risk |
|---|---|---|
| Servis durumu | `systemctl status netmanager-agent` | READ ONLY |
| Son loglar | `journalctl -u netmanager-agent -n 100` | READ ONLY |
| WS bağlantı izleme | `journalctl -u netmanager-agent -f` (canlı) | READ ONLY |
| Restart | `systemctl restart netmanager-agent` | SAFE RESTART |
| Stop | `systemctl stop netmanager-agent` | SAFE RESTART (servis durur — saha cihazlarına erişim kesilir!) |
| Uninstall | `systemctl disable --now netmanager-agent && rm ...` | DO NOT RUN CASUALLY |

UI tarafında: **Settings → Agents** (veya **Platform Mgmt → Agents** super_admin için) sayfasında `last_seen_at`, version, status gösterilir.

## 5. Agent registration / enrollment süreci

1. **UI'dan** (super_admin veya org_admin): `Agents` sayfası → "Yeni Agent" → organization + location seçilir → "Üret" → API döner: `{agent_id, agent_key}`.
2. `agent_key` **bir defalık** gösterilir; sayfa kapanırsa yenisi üretilmesi gerekir.
3. Saha host'una bu key `.env`'e yazılır.
4. Agent restart edilir → WS bağlantı kurulur → backend `agents.last_seen_at` günceller.

**Re-enroll** (key kaybı / şüpheli compromise): UI'dan aynı agent satırına "Re-enroll" → yeni key üretilir → saha host'unda `.env` güncellenip restart.

## 6. Agent'ın backend'e bağlantısı

- Endpoint: `wss://<domain>/api/v1/agents/ws`
- Header / subprotocol: `X-Agent-Key: <token>`
- Nginx WS proxy: `proxy_read_timeout 3600s`, `proxy_send_timeout 3600s`, `proxy_buffering off`.
- Backend tarafı: agent'ı in-memory `_connections` dict'ine ekler; restart sonrası yeniden bağlanılır.

**Bağlantı kopması:**
- 502: nginx → backend timeout veya backend container restart
- Agent loglarında `Authentication (password) failed.` görülürse → key revoke veya re-enroll yanlış kullanılmış olabilir
- Backend recreate sonrası agent **yeniden bağlanır**; in-memory state kaybolur, ama agent ↔ backend sözleşmesi gereği yeni bağlantı ile devam eder.

## 7. Agent logları

| Log | Yer |
|---|---|
| Agent host process log | `journalctl -u netmanager-agent` |
| Agent komut audit | Backend `agent_command_logs` tablosu |
| Audit logs | Backend `audit_logs` tablosu |
| Backend WS event log | `docker compose logs backend` |

Önemli arama desenleri:
- `Authentication (password) failed.` → cihaz tarafından SSH auth reddi
- `EOFError` veya `Connection reset` → cihaz oturumu kestiği için tetiklenebilir
- `enable_secret` hatası → privileged mode'a geçilemediği
- `Agent {agent_id} not connected to this process` → backend o anda agent'ı tanımıyor (recreate / bridge process farklı)

## 8. Agent host troubleshooting

| Belirti | Önce kontrol et |
|---|---|
| UI'da agent offline | Host'ta `systemctl status netmanager-agent`; backend URL DNS doğru mu; firewall WS (443/80) açık mı |
| Komutlar 502 dönüyor | `journalctl -u netmanager-agent` son 5 dk; cihaz reachable mı; SSH port 22 firewall ile kapanmış mı |
| MAC table boş | Cihaz user mode'da kalmış olabilir (enable_secret yok / yanlış); [09](09-RUIJIE-SSH-AND-PARSER-OPERATIONS.md) |
| Periyodik collection 0 | Pool entry stale olabilir, 5 dk sonra tekrar bak; [12](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) tech-debt maddesi |
| Disk dolu (host) | Agent log rotation: `/etc/logrotate.d/netmanager-agent` varsa kontrol; yoksa journald `Storage=persistent` ayarı |

## 9. Credential update sonrası agent pool/cache etkisi

(Anahtar nokta — operatörün **çok defa karşılaştığı** sürpriz.)

| Olay | Değişim noktası | Süre |
|---|---|---|
| Operatör cihaz credential'ını UI'dan günceller | `devices.ssh_password_enc` ve/veya `devices.enable_secret_enc` DB'de güncellenir | Anlık |
| Agent pool eski credential ile açılmış oturumu **tutmaya devam eder** | Pool key `(host, port, username)` credential içermez | Anında stale |
| Eski oturumun TTL'i dolar | `last_used + _POOL_TTL=300s` | Maks 5 dk |
| Idle eviction çalışır | `_pool_evict_idle` her ~60 sn | Pool TTL'ten sonra ~1 dk |
| Bir sonraki SSH komutu fresh oturum açar | Yeni credentials kullanılır | Pool/cache sonrası |
| Interfaces/VLAN Redis cache TTL dolar | `_IFACE_CACHE_TTL=300s` | Maks 5 dk |
| UI doğru veriyi gösterir | Tüm yukarısının sonrası | **5–10 dk** toplam |

**Sonuç:** Credential update sonrası UI'da "doğru veri" gözükmesi **5–10 dakika alır**. Bu süre içinde "kötü" görünen veri **cache'ten geliyor olabilir**; rastgele restart atmak gerekmez.

Detaylı operatör prosedürü: [08-DEVICE-ONBOARDING-AND-CREDENTIALS.md §Credential update sonrası bekleme](08-DEVICE-ONBOARDING-AND-CREDENTIALS.md).

## 10. Agent restart ne zaman gerekir / ne zaman gerekmez

| Senaryo | Restart gerekli mi? |
|---|---|
| Agent loglarında "Connected" görünüyor ve son komutlar başarılı | **HAYIR** |
| Credential update edildi, UI 5-10 dk içinde doğru görünecek | **HAYIR** — bekle |
| Agent disconnected 1 saatten uzun | EVET (önce backend reachability kontrol) |
| Agent host disk doldu | EVET (disk temizliği sonrası) |
| Agent script güncellemesi yapıldı | EVET — yeni dosya yerleşince restart |
| Yeni env değişkeni eklendi | EVET — `.env` reload için |
| Cihaz SSH yapmayı tamamen reddediyor (`Connection reset before banner`) | **HAYIR** — cihaz tarafında lock-out veya KEX uyumsuzluğu olabilir; agent restart düzeltmez |

## 11. Windows Agent v2 — durum ve güvenlik notları

| Konu | Durum |
|---|---|
| Üretim flag'i | `WINDOWS_AGENT_V2_ENABLED=False` (default) |
| Manuel test paketi | `windows-agent-v2-manual-test/` |
| Embedded Python runtime | 3.12.6, payload\current\runtime\python\ |
| Installer pattern | 11 aşamalı transactional installer (Plan v11) |
| Son durum | T1.01 BLOCKED (historical internal context — VERIFY BEFORE HANDOVER); disposable VM bekleniyor |

Güvenlik prensipleri (Plan v11'den çekilmiş, kalıcı):
- Agent key plaintext yalnız 4 dosyada tutulabilir; bunlar SYSTEM + Administrators ACL'i ile kilitli (`config.env`, `config.env.bak`, `staging\config.env.new`, `staging\rollback-config.failed`).
- Installer hedef makineden **yalnız** NetManager backend'e HTTPS açar; PyPI, python.org, winget, Microsoft Store erişim **gerektirmez**.
- Transactional installer'ın 11-aşamalı rollback'i + Stage 11 commit barrier'ı + SCM probe disagreement fail-closed yaklaşımı vardır.

Detaylı plan: Windows Agent v2 plan dokümanı devir veren ekip tarafından ayrı ve güvenli kanaldan teslim edilir.

## 12. Site-A incident'ından generic operasyon dersi

> Bu bölüm kasıtlı olarak **anonimleştirilmiştir**. Gerçek host adı, IP, kullanıcı veya credential **dokümana girmez**. Aşağıdaki, "private network'te bir agent host + Ruijie cihazlar" tipik senaryosundan çıkmış **kalıcı operasyonel ders**'tir.

**Senaryo (anonim):**
- Saha host'u agent çalıştırıyor.
- Cihaz credential'ları UI üzerinden bulk olarak güncellendi.
- UI'da `interfaces` sayfası "No ports found" gösteriyor.
- 5-10 dakika bekleniyor; sorun çözülüyor.

**Çıkardığımız dersler:**
1. **Credential update + pool TTL + interfaces cache TTL** üçü birden 5 dk olduğu için, UI'nin "doğru" görmesi tipik 5-10 dk sürer.
2. **Bulk credential audit log'da yalnızca hedef cihaz listesi tutulur**, **kaynak cihaz** bilgisi tutulmaz — ileride aynı problem patladığında geriye dönüş için bu metadata eksikliği iz kaybettirir.
3. **Privilege-denied output parser'ı 0 entry üretir**; UI bu sonucu "veri yok" olarak gösterir. Operatör "agent kötü mü, credential mı yanlış, cihaz mı down" arasında karar veremez.
4. **Pool key credential içermediği için**, credential update sonrası "şimdi restart at" refleksi yanlıştır — pool TTL doğal olarak doğru oturumu açar.

Operasyonel kural: **credential update sonrası 10 dakika bekle, sonra UI'ya bak**. 10 dakika sonra hala "No ports found" görüyorsan [11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md "Ports tab No ports found"](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) karar ağacına geç.

## 13. Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- Agent pool key `(host, port, username)` ve `_POOL_TTL=300s` (agent_script üzerinde doğrulandı)
- Nginx `/api/v1/agents/ws` WS proxy 3600s timeout
- Backend `internal.py` `agent_relay` endpoint kontratı ("Agent not connected" mesajı)
- `audit_logs` bulk_credentials_updated kayıt yapısı (Site-A incident'ında gözlendi)

### VERIFY BEFORE HANDOVER
- Linux agent canonical install script konumu / sürümü
- Agent'ın hangi `.env` anahtar setini beklediği (tam liste)
- Windows Agent v2 production roll-out kararı zamanlaması
- Agent key DB hash mekanizması (sha256 vs HMAC)
- Üretimdeki tam agent envanteri (saha sayısı, OS dağılımı)
