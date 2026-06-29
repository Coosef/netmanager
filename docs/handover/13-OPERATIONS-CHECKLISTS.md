# 13 — Operasyon Checklistleri

Tüm komutlar etiketlidir: `READ ONLY`, `SAFE RESTART`, `MUTATING`, `DO NOT RUN CASUALLY`.

---

## 1. Günlük operasyon kontrolü (~5 dk)

> **Pre-condition:** [14 §1 VPS erişim sahibi](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md) şablonu doldurulmuş, devir alan ekibin SSH public key'i VPS'e tanıtılmış ve `ssh <vps>` çalışıyor olmalı. Bu pre-condition tamamlanmadan §1 uygulanamaz.

```bash
# READ ONLY
docker compose ps                                                # 11 servis healthy?
curl -fsS https://<domain>/health/live   -o /dev/null -w "%{http_code}\n"
curl -fsS https://<domain>/health/ready  -o /dev/null -w "%{http_code}\n"
```

- [ ] Tüm compose servisleri `Up (healthy)`
- [ ] `/health/live` 200
- [ ] `/health/ready` 200
- [ ] Cloudflare panel — origin reachable (varsa origin monitor)
- [ ] Browser smoke: login → dashboard → bir devices sayfası → audit log son satır
- [ ] Flower UI (dev overlay açıksa) — active task `0` veya tipik range içinde
- [ ] Disk usage VPS'te `df -h` < %80

Bir kalem işaretlenemiyorsa: [11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md).

---

## 2. Haftalık platform sağlığı (~30 dk)

```bash
# READ ONLY
docker compose exec backend alembic current
docker compose exec backend alembic heads
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM pg_stat_activity;"
docker compose exec redis redis-cli info memory | grep used_memory_human
```

- [ ] Alembic `current == heads`
- [ ] Postgres connection count < 150 (max 200)
- [ ] Redis `used_memory_human` < 400 MB (max 512 MB)
- [ ] Son 7 günde celery worker OOM (`docker inspect --format='{{.State.OOMKilled}}'`) — 0 olmalı
- [ ] `agent_command_logs` son 7 gün success rate > %95 (sample query yazın)
- [ ] Snapshot tabloları (mac/arp/poe) son 24 saatte yeni row üretmiş mi
- [ ] Audit log son 7 gün — anormal `failed login` patlaması var mı
- [ ] Backup dosyaları taze mi (`config_backups` volume son tarih)
- [ ] DB backup taze mi (otomasyon varsa)

---

## 3. Yeni agent onboarding (saha tarafı yeni nokta)

`MUTATING` (yeni agent enroll edilir, DB'ye yazılır).

- [ ] UI'dan `Agents` → "Yeni Agent" → organization + location seçimi
- [ ] Geri dönen `agent_key` **bir defalık** — güvenli kanaldan saha personeline iletilir (mail / Slack DM **değil**; 1Password / kurum şifreli yöntemi)
- [ ] Saha personeli host'a `netmanager_agent.py` + venv + `.env` koyar
- [ ] `.env` ACL `chmod 600`, sahip = servis hesabı
- [ ] `systemctl enable --now netmanager-agent`
- [ ] UI'da agent online görünüyor (`last_seen_at` < 1 dk)
- [ ] Agent'a bir test cihazı atanır (boş bir test cihaz kaydı)
- [ ] Test cihazı üzerinde Fetch Info çalışıyor mu
- [ ] audit_logs: `agent_enrolled` kaydı var mı
- [ ] Onboarding sonrası: agent_key dökümü olmadığından emin ol (chat history, ticket attachment temizle)

---

## 4. Yeni cihaz onboarding (operatör)

`MUTATING` (DB'ye device + credentials yazılır).

- [ ] Cihazın yerleştiği lokasyon doğrulanır
- [ ] O lokasyona atanmış aktif bir agent var mı?
  - **Hayır** → Önce §3 (yeni agent)
  - **Evet** → devam
- [ ] Cihazın gerçek SSH credential'ı bilinmeli (cihaz sahibi onaylar)
- [ ] UI: `Devices` → "Yeni Cihaz"
- [ ] Zorunlu alanlar: name, hostname, ip_address, device_type, organization_id, location_id, agent_id (private IP ise)
- [ ] Credential modu seç: bireysel veya profil
- [ ] Kayıt sonrası **Fetch Info** çalıştır
- [ ] Model, firmware, serial DB'de doluyor mu (Fetch Info başarılı sonrası)
- [ ] Terminal aç → prompt geliyor mu, privileged mode `#` görünüyor mu (Ruijie ise enable test)
- [ ] Ports tab → 10 dk sonra port listesi var mı
- [ ] audit_logs: `device_created` + `device_info_fetched` görünmeli
- [ ] Onboarding sonrası operatör notu yazılır (ticket / wiki)

Onboarding fail sebepleri → [11](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) Senaryo 15 (private IP + agent NULL), Senaryo 4 (auth), Senaryo 5 (enable).

---

## 5. Credential rotation (cihaz)

`MUTATING` (devices.*_enc kolonları değişir).

- [ ] Yeni credential cihaz tarafında set edildi mi? (cihaz sahibi onaylar)
- [ ] En az **1 cihaz** manuel test edildi mi? (UI Terminal → enable + privileged komut)
- [ ] UI'dan bulk credential update / copy seç
- [ ] Hedef listede beklenmedik cihaz yok mu (lokasyon filtresi doğru mu)
- [ ] audit_logs: `bulk_credentials_updated` görünmeli (hedef listesi ile)
- [ ] **10 dk bekle** — TD-2 ve TD-3 gereği
- [ ] Sonra UI'dan random 2-3 cihaz check: Ports tab + MAC table dolu mu
- [ ] Eğer fail → [11](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) Senaryo 8 + 9

---

## 6. Incident başlangıcı (P1/P2 paging sonrası)

İlk 5 dakika:

- [ ] Severity belirle (UI hiç açılmıyor mu / partial mi / tek tenant mi)
- [ ] Incident channel aç (Slack/Discord/Mattermost)
- [ ] [10 §9](10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md) ile evidence klasörü başlat:
  ```bash
  # READ ONLY
  EVIDENCE=/tmp/incident-$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p "$EVIDENCE" && docker compose ps > "$EVIDENCE/ps.txt"
  ```
- [ ] [11](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) içinde uygun senaryoya bak
- [ ] Read-only doğrulamaları yap, evidence'a yaz
- [ ] Yasak müdahaleleri **yapma**
- [ ] Güvenli sonraki adım seç, uygula, doğrula
- [ ] Eskaleyt: severity'ye göre matrix uygula
- [ ] Incident kapanışında postmortem dosyası `docs/incidents/YYYY-MM-DD-<kısa-isim>.md` aç

---

## 7. Celery recovery (worker down)

`SAFE RESTART`.

- [ ] `docker compose ps` ile worker'ın `Exit` veya `unhealthy` olduğunu doğrula
- [ ] `[READ ONLY]` `docker inspect <id> --format='{{.State.OOMKilled}} {{.State.ExitCode}}'`
- [ ] `[READ ONLY]` `docker compose logs --tail=200 <worker>`
- [ ] OOM mu? → `dmesg | grep -i oom`
- [ ] tmpfs saturation mı? → `df -h /var/lib/docker` ve `prom_multiproc` volume
- [ ] Sebep belirsizse evidence al
- [ ] `[SAFE RESTART]` `docker compose restart <worker>`
- [ ] Restart sonrası `inspect ping` cevap veriyor mu
- [ ] 5 dk içinde aynı worker tekrar düşerse: ya bir task batch yüksek RAM kullanıyor, ya tmpfs gene saturate; deep dive gerekiyor

---

## 8. Production deploy

`MUTATING` (image build + recreate + opsiyonel Alembic).

- [ ] PR merge edilmiş, CI yeşil
- [ ] Release tag oluşturulmuş (`v1.2.3`)
- [ ] Pre-deploy [02 §8](02-DEPLOYMENT-AND-INFRASTRUCTURE.md) çalıştırıldı
- [ ] Yeni Alembic migration varsa: dosya okundu, riskli operasyon yok
- [ ] DB backup taze (son 24 saat içinde)
- [ ] **Mesai dışı pencere** (gerekli ise)
- [ ] VPS'e SSH; `cd /opt/netmanager/switch` (veya doğru path)
- [ ] `[READ ONLY]` `git status` — temiz mi
- [ ] `[MUTATING]` `git fetch origin && git checkout <tag>`
- [ ] `[MUTATING]` `docker compose up -d --build backend frontend`
- [ ] `[MUTATING]` Alembic varsa: `docker compose exec backend alembic upgrade head`
- [ ] `[READ ONLY]` Post-deploy [02 §8](02-DEPLOYMENT-AND-INFRASTRUCTURE.md):
  - tüm servisler healthy
  - `/health/live` + `/health/ready` 200
  - browser smoke
  - audit log son 5 dk error pattern
- [ ] Cloudflare 5xx cache window'u için ~60 sn bekle
- [ ] Sorun yoksa announcement / closeout

Rollback gerekirse: [02 §9](02-DEPLOYMENT-AND-INFRASTRUCTURE.md).

---

## 9. Pre-merge doğrulama (PR sahibi tarafı)

`READ ONLY` (yerel makinede).

- [ ] CI green (Frontend QA + Snyk + integration testleri yeşil)
- [ ] `git status` temiz; yalnız PR scope dosyaları değişmiş
- [ ] Yeni Alembic migration varsa: down-fix yok, destruktif DROP yok
- [ ] Yeni endpoint varsa permission gate var
- [ ] Yeni Celery task varsa queue routing tanımlı
- [ ] Yeni cache key TTL tanımlı
- [ ] Frontend yeni route eklediyse permission map güncel
- [ ] PR description'da risk + rollback yazılı
- [ ] Reviewer onayı + branch protection geçildi

---

## 10. Handover sonrası ilk hafta kontrolü

| Gün | Checklist | Sahibi |
|---|---|---|
| Day 1 | §1 günlük + browser smoke + erişim doğrulama (her devralan kullanıcı login deniyor) | Devir alan + devir veren |
| Day 2 | Backup restore tatbikatı (staging environment) | Devir alan SRE |
| Day 3 | §4 — test cihaz onboard (test env veya pre-prod) | Devir alan NOC |
| Day 4 | RBAC test: her rol için bir kullanıcı; UI matrisinin beklenenle eşleşmesi | Devir alan güvenlik |
| Day 5 | §2 haftalık platform sağlığı + Celery beat schedule audit | Devir alan SRE |
| Day 6 | [11](11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) dry-run: bir senaryo seç, READ ONLY doğrulamaları uygula, "şimdi ne yapardım?" yaz | Devir alan on-call |
| Day 7 | Open ticket + tech-debt review ([12](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md)) — ilk ay önceliklendirme | Devir alan ekip lideri |
| Day 7 sonu | [15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md](15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md) imzalanır | Her iki taraf |

## Doğrulanmış ve doğrulama bekleyen alanlar

### Doğrulanmış
- Tüm komutlar `docker-compose.yml` ve `celery_app.py` üzerinde geçerli
- Etiketler dökümentasyon kontratıyla tutarlı

### VERIFY BEFORE HANDOVER
- Otomatik nightly DB backup mevcudiyeti (varsa cron path)
- Incident channel platformu ve naming convention
- Release tag pattern (`v1.2.3` mi `release-YYYY-MM-DD` mi)
