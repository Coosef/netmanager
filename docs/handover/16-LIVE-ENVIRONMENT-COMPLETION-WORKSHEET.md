# 16 — Live Environment Completion Worksheet

> **Amaç:** Bu doküman, [00-EXECUTIVE-HANDOVER.md](00-EXECUTIVE-HANDOVER.md) ve diğer 01–15 dosyalarında bırakılan ⚠ **VERIFY BEFORE HANDOVER** alanlarının teslim günü **canlı ortamdan** doldurulacağı tek noktadır. Bu paket commit'lendiğinde **boş** durur; doldurma işi devir alan/veren ekip ortak yürütür.

> **Kırmızı çizgiler:** Bu çalışma sayfası şunları **asla** içermez: gerçek parola, JWT, Fernet key, Bearer token, postgresql:// URL'sinin user:pass kısmı, Cloudflare API token, SSH private key, agent_key plaintext. Hassas değerler ayrı bir parola kasası ([14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md)) üzerinden devredilir; bu dosyaya **yalnız "Set / Not Set" gözlemi veya "Vault'ta saklanıyor" notu** girer.

## Durum sözlüğü

| Durum | Anlam |
|---|---|
| **CONFIRMED** | Devir veren ekip + devir alan ekip tarafından canlı kanıtla doğrulandı |
| **PENDING** | Doğrulama tamamlanmadı; bekleyen aksiyon var |
| **NOT APPLICABLE** | Bu kurulumda bu alan kullanılmıyor |
| **RISK ACCEPTED** | Boşluk var ancak ekip kabul ederek devam ediyor (sebep + sahibi yazılmalı) |

Acceptance ([15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md](15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md)) için **kural**: her satır CONFIRMED / NOT APPLICABLE / RISK ACCEPTED durumlarından birinde olmadan handover kapanmaz.

---

## 1. VPS & Host

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Production environment adı (`prod`, `prod-eu`, ...) |  |  |  |  |  |
| VPS sağlayıcısı (Hetzner / DigitalOcean / AWS EC2 / on-prem / ...) |  |  |  |  |  |
| VPS hostname (public veya internal — kasaya yaz, değeri NOT BURADA) | _stored in vault_ | [14 §1](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md) |  |  |  |
| OS dağıtımı + sürüm (örn. Ubuntu 22.04 LTS) |  | `lsb_release -a` |  |  |  |
| Kernel sürümü |  | `uname -r` |  |  |  |
| CPU / RAM / disk |  | `lscpu`, `free -h`, `df -h` |  |  |  |
| Docker daemon sürümü |  | `docker --version` |  |  |  |
| Docker Compose sürümü |  | `docker compose version` |  |  |  |
| Gerçek deploy dizini (`/opt/netmanager/switch` veya alternatif) |  | `pwd` çıktısı (vault'a) |  |  |  |
| Disk usage threshold alarmı kuruldu mu? |  |  |  |  |  |

---

## 2. Git / Release

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Production'da çekili git branch |  | VPS'te `git branch --show-current` |  |  |  |
| Production HEAD commit SHA |  | VPS'te `git rev-parse HEAD` |  |  |  |
| Production release tag (varsa) |  | VPS'te `git describe --tags` |  |  |  |
| `origin/main` ile commit farkı (ahead/behind) |  | `git log --oneline origin/main..HEAD`, `git log --oneline HEAD..origin/main` |  |  |  |
| Alembic `current` revision |  | `docker compose exec backend alembic current` |  |  |  |
| Alembic `heads` revision |  | `docker compose exec backend alembic heads` |  |  |  |
| `current == heads` doğrulandı mı |  |  |  |  |  |
| Son merge edilen PR numarası + tarihi |  | GitHub |  |  |  |

---

## 3. Docker / Image source

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Image build stratejisi (image-baked dist / bind-mount / hybrid) |  | [02 §4](02-DEPLOYMENT-AND-INFRASTRUCTURE.md) |  |  |  |
| Disposable build worktree pattern kullanılıyor mu |  |  |  |  |  |
| Backend image son build tarihi |  | `docker image inspect ... --format='{{.Created}}'` |  |  |  |
| Frontend image son build tarihi |  | aynı |  |  |  |
| Container registry kullanılıyor mu (yoksa local build only) |  |  |  |  |  |
| Multi-arch build durumu (amd64 / arm64) |  |  |  |  |  |

---

## 4. Cloudflare ingress modeli

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Ingress modeli | ☐ **Tunnel** ☐ **A-record + origin certificate** ☐ **Diğer** |  |  |  |  |
| Cloudflared (tunnel) çalışıyorsa servis sahibi |  |  |  |  |  |
| Tunnel adı |  | (vault) |  |  |  |
| A-record + origin cert ise: certificate expiry |  |  |  |  |  |
| "Always Use HTTPS" | ☐ ON ☐ OFF |  |  |  |  |
| WAF kuralları envanteri (var/yok + sayı) |  |  |  |  |  |
| Page Rules envanteri |  |  |  |  |  |
| Bot Fight Mode | ☐ ON ☐ OFF |  |  |  |  |
| Rate Limiting policy | ☐ ON ☐ OFF |  |  |  |  |

---

## 5. Domain / DNS

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Production domain |  | (vault) |  |  |  |
| Domain registrar |  |  |  |  |  |
| Domain expiry |  |  |  |  |  |
| DNS owner |  |  |  |  |  |
| Public health URL (`https://<domain>/health/live`) |  | curl 200 |  |  |  |
| Backend public URL (REST root) |  |  |  |  |  |
| Agent relay URL (WS) |  |  |  |  |  |

---

## 6. Veritabanı

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Postgres host adı (compose servis adı veya FQDN) | `postgres` (compose internal) | `docker compose ps postgres` |  |  |  |
| Postgres port (container) | `5432` | `docker compose ps postgres` |  |  |  |
| Postgres database name |  | (vault) |  |  |  |
| Postgres superuser adı | _stored in vault_ | [14 §4](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md) |  |  |  |
| App role kullanıcı adı | _stored in vault_ | [14 §4](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md) |  |  |  |
| `max_connections` (compose default 200) |  | `SHOW max_connections;` |  |  |  |
| `shared_buffers` |  | `SHOW shared_buffers;` |  |  |  |
| Active hypertable seti (TimescaleDB) |  | `SELECT hypertable_name FROM timescaledb_information.hypertables;` |  |  |  |
| RLS aktif policy sayısı |  | `SELECT count(*) FROM pg_policies;` |  |  |  |
| Connection idle count (anlık) |  | `SELECT count(*) FROM pg_stat_activity;` |  |  |  |

---

## 7. Redis

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Redis host (compose servis adı) | `redis` | `docker compose ps redis` |  |  |  |
| Redis port | `6379` |  |  |  |  |
| Redis password kullanılıyor mu (compose default: yok) |  |  |  |  |  |
| `maxmemory` |  | `redis-cli config get maxmemory` |  |  |  |
| `maxmemory-policy` |  | `redis-cli config get maxmemory-policy` |  |  |  |
| AOF aktif | ☐ Evet ☐ Hayır | `redis-cli config get appendonly` |  |  |  |
| `used_memory_human` (anlık) |  | `redis-cli info memory` |  |  |  |
| Anahtar sayısı | | `redis-cli dbsize` |  |  |  |

---

## 8. Backup

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| DB backup otomasyonu mevcut mu | ☐ Evet ☐ Hayır |  |  |  |  |
| DB backup zamanlayıcı (cron / Celery / manuel) |  |  |  |  |  |
| DB backup hedefi (S3 / B2 / on-prem / yok) |  |  |  |  |  |
| DB backup encryption key sahibi |  | (vault) |  |  |  |
| DB backup retention politikası |  |  |  |  |  |
| Son başarılı DB backup zamanı |  |  |  |  |  |
| Config backup volume (`config_backups`) snapshot stratejisi |  |  |  |  |  |
| Last restore test tarihi |  |  |  |  |  |
| Restore süresi (RTO ölçümü) |  |  |  |  |  |

---

## 9. Monitoring & Logging

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Prometheus / Grafana overlay aktif mi | ☐ Evet ☐ Hayır | `docker-compose.monitoring.yml` |  |  |  |
| Alert sistemi (PagerDuty / OpsGenie / e-posta / yok) |  |  |  |  |  |
| Alert owner (on-call) |  | [17-ACCESS-AND-OWNERSHIP-MATRIX.md](17-ACCESS-AND-OWNERSHIP-MATRIX.md) |  |  |  |
| Application log retention (Docker `max-size` 50m × 5) | 250m/servis (compose default) | compose |  |  |  |
| Centralized log shipper (Loki / ELK / yok) |  |  |  |  |  |
| Uptime monitor (external) |  |  |  |  |  |
| Cloudflare analytics owner |  |  |  |  |  |

---

## 10. Agent envanteri

| Site / Lokasyon adı | Organization | Agent host OS | Agent versiyonu | Online mı | Son seen | Sahibi | Durum |
|---|---|---|---|---|---|---|---|
| _Site A_ |  |  |  |  |  |  |  |
| _Site B_ |  |  |  |  |  |  |  |
| _ekle_ |  |  |  |  |  |  |  |

Toplam agent sayısı: __  
Online agent sayısı: __  
Yetim (org/loc soft-deleted) agent var mı: ☐ Evet ☐ Hayır

---

## 11. Cihaz envanteri (özet)

> Detay envanter ayrı bir CSV/spreadsheet'te tutulur; burada **sayım özeti** girer.

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Toplam cihaz sayısı |  | UI Devices listesi count |  |  |  |
| Aktif (`is_active=true`) cihaz sayısı |  |  |  |  |  |
| `status=online` cihaz sayısı |  |  |  |  |  |
| Cihaz tipleri dağılımı (cisco_ios/ruijie_os/aruba_os/diğer) |  |  |  |  |  |
| Public IP cihaz sayısı (backend direct path) |  |  |  |  |  |
| Private IP cihaz sayısı (agent-relay path) |  |  |  |  |  |
| Duplicate cihaz kayıt taraması yapıldı mı |  | [08 §5](08-DEVICE-ONBOARDING-AND-CREDENTIALS.md) |  |  |  |
| Eksik metadata (rack/floor/layer) cihaz sayısı |  |  |  |  |  |

---

## 12. Windows Agent durumu

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| `WINDOWS_AGENT_V2_ENABLED` flag durumu | ☐ False (default) ☐ True | `.env` (vault) |  |  |  |
| Production'da Windows Agent yüklü mü |  |  |  |  |  |
| Manuel test paketi sürümü (`windows-agent-v2-manual-test/` altında) |  |  |  |  |  |
| T1.01 validation durumu (BLOCKED / completed) |  |  |  |  |  |
| Disposable test VM hazır mı |  |  |  |  |  |
| Bir sonraki test kampanyası planı |  |  |  |  |  |

---

## 13. PR #119 (SSH error classification v1)

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Branch durumu (merged / open / draft) |  | GitHub PR |  |  |  |
| `agent_script/netmanager_agent.py` production'da `_classify_ssh_exception` içeriyor mu | ☐ Evet ☐ Hayır | agent host'ta dosya hash + grep |  |  |  |
| Agent host'a deploy edildi mi (her saha için) |  |  |  |  |  |
| 6 layer code'un canlı log'da gözlemi (audit) |  |  |  |  |  |
| TD-4 ([12](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md)) status'u güncellenecek mi |  |  |  |  |  |

---

## 14. VLAN snapshot ownership / durumu (TD-1)

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Production'da `vlan_snapshots` tablosu var mı | ☐ Evet ☐ Hayır | `\d vlan_snapshots` |  |  |  |
| Periodic collector çalışıyor mu (beat schedule listesinde) | ☐ Evet ☐ Hayır | `celery_app.py beat_schedule` |  |  |  |
| Manuel snapshot ihtiyacı var mı |  |  |  |  |  |
| TD-1 sahipliği (ileride implement edecek ekip) |  |  |  |  |  |

---

## 15. event_consumer durumu (TD-7)

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| `event_consumer:alive` Redis key TTL var mı | | `redis-cli ttl event_consumer:alive` |  |  |  |
| `ingest:syslog` stream length anlık |  | `redis-cli xlen ingest:syslog` |  |  |  |
| Stream pending entries (varsa) |  | `redis-cli xpending ingest:syslog consumer-group-name` |  |  |  |
| Son 24 saat ingestion rate |  | log aggregation |  |  |  |
| Syslog kaynak yolu (agent vs HTTP POST) |  | [07 §10](07-CELERY-REDIS-BACKGROUND-JOBS.md) |  |  |  |

---

## 16. Sertifikalar / TLS

| Alan | Değer | Kanıt/Kaynak | Doğrulayan | Tarih | Durum |
|---|---|---|---|---|---|
| Cloudflare edge cert (yönetilen) |  |  |  |  |  |
| Origin cert (nginx içinde) varsa expiry |  |  |  |  |  |
| Agent ↔ backend TLS termination noktası (nginx mi CF mi) |  |  |  |  |  |
| Sertifika rotation prosedürü dokümante mi |  |  |  |  |  |

---

## 17. Genel handover gating

| Soru | Cevap | Not |
|---|---|---|
| Tüm satırların durumu CONFIRMED / NOT APPLICABLE / RISK ACCEPTED'tan biri mi? |  |  |
| PENDING satır kaldı mı? Kaldıysa hepsi blocker mı yoksa post-handover deliverable mı? |  |  |
| RISK ACCEPTED satırlar için kabul eden + sebep + tahmini kalıcı çözüm tarihi yazıldı mı? |  |  |
| Bu çalışma sayfası boş hiçbir kritik gating alanı kalmadı mı? |  |  |

Bu dosya doldurulup signed-off edildiğinde [15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md](15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md) §M imzaları açılır. Aksi halde handover **resmi olarak tamamlanmamış** sayılır.
