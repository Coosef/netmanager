# 18 — Production Validation Evidence Template

> **Amaç:** Devir alan ekip teslim günü production'a karşı **read-only kanıt** toplayarak [15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md](15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md) §D-J satırlarını doğrulayacak. Bu doküman o kanıtları **disipline edilmiş** şekilde tutmak için şablondur.

> **Kırmızı çizgiler:**
> - **YALNIZ READ ONLY komutlar.** Mutating, restart, recreate, queue purge, cache clear, deploy yok.
> - Komut çıktısı kanıt olarak kaydedilir ama **hiçbir secret, parola, token, gerçek IP veya gerçek hostname** kanıt ekine kopyalanmaz. Gerekiyorsa masking uygulanır.
> - `docker compose config` çıktısı **env değerleri içerebilir**; bu komut **kullanılmaz**. Servis health için `docker compose ps` ve targeted `inspect` yeterlidir.

## Kanıt kayıt sözleşmesi

Her kontrol satırının "Kanıt bağlantısı/ek" sütununa şu **alternatiflerden biri** girer:

| Tip | Format | Saklama |
|---|---|---|
| Ekran görüntüsü | `.png` | Ticket / wiki — secret içermeyen, masking'li |
| Komut çıktısı | `.txt` veya ticket inline | Aynı kurallar |
| Audit log entry referansı | `audit_logs.id` veya UI link | UI içinde kalır |
| External link | URL (status page, grafana panel) | URL |

---

## 1. Git revision / release doğrulaması

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Production'da çekili branch ve HEAD | `[READ ONLY]` VPS SSH → `git branch --show-current && git rev-parse HEAD` | Bilinen release tag veya `main` |  |  |  | ☐ PASS ☐ FAIL |
| Alembic head doğrulama | `[READ ONLY]` `docker compose exec backend alembic current` ve `... alembic heads` | İki çıktı eşit |  |  |  | ☐ PASS ☐ FAIL |
| Working tree temiz | `[READ ONLY]` VPS SSH → `git status --short` | Untracked listede sadece beklenen kalemler (bkz. yerel ignore) |  |  |  | ☐ PASS ☐ FAIL |

---

## 2. Docker compose service health

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| 11 servis Up + healthy | `[READ ONLY]` `docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Health}}"` | postgres / redis / backend / 3×celery / beat / event_consumer / flower / frontend / nginx — hepsi healthy |  |  |  | ☐ PASS ☐ FAIL |
| OOM kontrolü | `[READ ONLY]` `docker inspect <id> --format='{{.State.OOMKilled}}'` her container için | Hiçbiri `true` |  |  |  | ☐ PASS ☐ FAIL |

---

## 3. Backend health endpoint

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| `/health/live` 200 | `[READ ONLY]` `curl -fsS https://<domain>/health/live -o /dev/null -w "%{http_code}\n"` | `200` |  |  |  | ☐ PASS ☐ FAIL |
| `/health/ready` 200 | `[READ ONLY]` aynı `ready` ile | `200` |  |  |  | ☐ PASS ☐ FAIL |
| Origin curl bypass (CF yok sayılarak) | `[READ ONLY]` `curl -fsS -H "Host: <domain>" https://<vps-ip>/health/live --resolve "<domain>:443:<vps-ip>" -k` | `200` |  |  |  | ☐ PASS ☐ FAIL |

---

## 4. Frontend erişimi

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Login sayfası 200 | `[READ ONLY]` `curl -fsS https://<domain>/login -o /dev/null -w "%{http_code}\n"` | `200` |  |  |  | ☐ PASS ☐ FAIL |
| Vite dev path'leri 404 (defansif) | `[READ ONLY]` `/src/`, `/@vite/client`, `/__open-in-editor` curl | hepsi `404` |  |  |  | ☐ PASS ☐ FAIL |
| Browser smoke: login + dashboard | Manuel | Login → dashboard yükleniyor, console error yok |  |  |  | ☐ PASS ☐ FAIL |

---

## 5. Agent relay health

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| WS endpoint upgrade alıyor | `[READ ONLY]` `curl -i -N --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: AAA=" https://<domain>/api/v1/agents/ws` | `101 Switching Protocols` veya backend auth challenge |  |  |  | ☐ PASS ☐ FAIL |
| Agents tablosunda online agent | UI Agents sayfası | En az 1 agent `last_seen_at < 1 dk` |  |  |  | ☐ PASS ☐ FAIL |
| Agent host'larda servis ayakta | `[READ ONLY]` her agent host'ta `systemctl status netmanager-agent` | active (running) |  |  |  | ☐ PASS ☐ FAIL |

---

## 6. Redis health

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Ping | `[READ ONLY]` `docker compose exec redis redis-cli ping` | `PONG` |  |  |  | ☐ PASS ☐ FAIL |
| `used_memory` sınırın altında | `[READ ONLY]` `docker compose exec redis redis-cli info memory \| grep used_memory_human` | < 400 MB (max 512 MB) |  |  |  | ☐ PASS ☐ FAIL |
| AOF aktif | `[READ ONLY]` `docker compose exec redis redis-cli config get appendonly` | `yes` |  |  |  | ☐ PASS ☐ FAIL |

---

## 7. PostgreSQL health

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| `pg_isready` | `[READ ONLY]` `docker compose exec postgres pg_isready` | `accepting connections` |  |  |  | ☐ PASS ☐ FAIL |
| Connection count < 150/200 | `[READ ONLY]` `docker compose exec postgres psql -c "SELECT count(*) FROM pg_stat_activity;"` | < 150 |  |  |  | ☐ PASS ☐ FAIL |
| RLS policy sayısı > 0 | `[READ ONLY]` `... -c "SELECT count(*) FROM pg_policies;"` | > 0 |  |  |  | ☐ PASS ☐ FAIL |
| TimescaleDB hypertable envanteri | `[READ ONLY]` `... -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"` | Beklenen tablo listesi |  |  |  | ☐ PASS ☐ FAIL |

---

## 8. Celery worker / queue health

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Monitor worker ping | `[READ ONLY]` `docker compose exec celery_worker celery -A app.workers.celery_app inspect ping --timeout=5` | `pong` |  |  |  | ☐ PASS ☐ FAIL |
| Agent_cmd worker ping | `[READ ONLY]` aynı, `celery_agent_worker` | `pong` |  |  |  | ☐ PASS ☐ FAIL |
| Default worker ping | `[READ ONLY]` aynı, `celery_default_worker` | `pong` |  |  |  | ☐ PASS ☐ FAIL |
| Active task sample | `[READ ONLY]` `... inspect active` | Liste tipik range içinde |  |  |  | ☐ PASS ☐ FAIL |
| Reserved (queue depth) | `[READ ONLY]` `... inspect reserved` | Liste makul; backlog yok |  |  |  | ☐ PASS ☐ FAIL |

---

## 9. Beat scheduler health

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Beat container healthy | `[READ ONLY]` `docker compose ps celery_beat` | Up (healthy) |  |  |  | ☐ PASS ☐ FAIL |
| Son 24 saatte mac_arp cycle çalıştı | `[READ ONLY]` `... -c "SELECT max(created_at) FROM mac_address_entries;"` | < 16 dk önce |  |  |  | ☐ PASS ☐ FAIL |
| Son 24 saatte poe cycle çalıştı | `[READ ONLY]` `... -c "SELECT max(snapshot_at) FROM poe_port_snapshots;"` *(şema doğrulansın)* | < 16 dk önce |  |  |  | ☐ PASS ☐ FAIL |
| Son 24 saatte SNMP cycle çalıştı | `[READ ONLY]` SNMP-related snapshot tablo lookup | < 6 dk önce |  |  |  | ☐ PASS ☐ FAIL |

---

## 10. Flower erişimi

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Production'da Flower **host'a publish edilmemiş olmalı** | `[READ ONLY]` `docker compose port flower 5555` | boş çıktı veya bağlanılamıyor |  |  |  | ☐ PASS ☐ FAIL |
| Dev overlay ile erişim test | `[READ ONLY]` `docker-compose.dev.yml` overlay'li lokal env'da `http://localhost:5555` basic auth | Auth challenge |  |  |  | ☐ PASS ☐ FAIL |

---

## 11. Backup son başarı zamanı

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| DB backup son tarihi | `[READ ONLY]` backup dizinindeki en son `.pgdump` mtime | < 24 saat |  |  |  | ☐ PASS ☐ FAIL |
| Config backup son tarihi | `[READ ONLY]` `docker compose exec backend ls -lah /app/backups/ \| head` | < 24 saat |  |  |  | ☐ PASS ☐ FAIL |
| Backup SHA / size cross-check | `[READ ONLY]` `sha256sum <son backup>` ve son N backup'la kıyas | büyüme sürekli, sıfır byte yok |  |  |  | ☐ PASS ☐ FAIL |

---

## 12. Restore test kanıtı

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Restore tatbikatı yapıldı mı | **Staging veya temiz** env'da `pg_restore` + login smoke | Login + dashboard çalıştı |  |  |  | ☐ PASS ☐ FAIL |
| RTO ölçümü | Tatbikat süre kaydı | RTO hedefiyle uyumlu |  |  |  | ☐ PASS ☐ FAIL |
| Restore sonrası audit log entry | Tatbikat env'ında manual not | "Restore test başarılı" markdown yazıldı |  |  |  | ☐ PASS ☐ FAIL |

---

## 13. Cloudflare edge / origin doğrulaması

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Edge TLS termination çalışıyor | `[READ ONLY]` `curl -sIL https://<domain>` → CF response header'ları | `cf-ray` header'ı var |  |  |  | ☐ PASS ☐ FAIL |
| HSTS edge'de | `[READ ONLY]` aynı response | `strict-transport-security: max-age=...` |  |  |  | ☐ PASS ☐ FAIL |
| HTTP → HTTPS redirect | `[READ ONLY]` `curl -sIL http://<domain>` | `301` veya `308` HTTPS |  |  |  | ☐ PASS ☐ FAIL |
| Origin bypass curl 200 (yukarıda §3) | aynı | `200` |  |  |  | ☐ PASS ☐ FAIL |

---

## 14. Agent inventory doğrulaması

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Beklenen agent sayısı online | UI Agents tablosu | [16 §10](16-LIVE-ENVIRONMENT-COMPLETION-WORKSHEET.md) "online count" satırı doğrulanır |  |  |  | ☐ PASS ☐ FAIL |
| Agent host'lar reachable | `[READ ONLY]` her host'ta `journalctl -u netmanager-agent --since "5 min ago" \| tail -20` | "Connected" log line var |  |  |  | ☐ PASS ☐ FAIL |
| Soft-deleted org/loc üzerindeki yetim agent var mı | `[READ ONLY]` UI veya `SELECT a.id FROM agents a JOIN locations l ON a.location_id=l.id WHERE l.deleted_at IS NOT NULL;` | 0 satır (veya kabul edildi) |  |  |  | ☐ PASS ☐ FAIL |

---

## 15. Örnek device onboarding doğrulaması

> Bu test için **test cihazı** veya **staging cihaz** kullanılır; production cihaza dokunulmaz.

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Yeni cihaz UI'dan eklendi | UI Devices → "Yeni Cihaz" | 201 + DB'de satır |  |  |  | ☐ PASS ☐ FAIL |
| Fetch Info başarılı | UI butonu | model + firmware + serial dolu |  |  |  | ☐ PASS ☐ FAIL |
| Terminal aç → privileged mode | UI Terminal | Prompt `#` |  |  |  | ☐ PASS ☐ FAIL |
| 10 dk sonra Ports tab dolu | UI | Liste var |  |  |  | ☐ PASS ☐ FAIL |
| audit_logs `device_created` + `device_info_fetched` | UI Audit Log | Görünür |  |  |  | ☐ PASS ☐ FAIL |
| Test sonrası cihaz soft-delete | UI Delete | DB `deleted_at` set |  |  |  | ☐ PASS ☐ FAIL |

---

## 16. RBAC smoke test

| Rol | Test hesap | Beklenen davranış | Test edildi | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| `super_admin` | Geçici test hesabı | Platform Mgmt menüsü görünür; tüm org'lara erişir | ☐ |  |  | ☐ PASS ☐ FAIL |
| `org_admin` | Geçici test hesabı | Yalnız kendi org'unu görür; org içindeki tüm lokasyonlara erişir | ☐ |  |  | ☐ PASS ☐ FAIL |
| `engineer` | Geçici test hesabı | Yalnız atandığı lokasyonların cihazları; Audit silme 403 | ☐ |  |  | ☐ PASS ☐ FAIL |
| `viewer` | Geçici test hesabı | Salt okuma; Terminal aç 403; cihaz oluşturma 403 | ☐ |  |  | ☐ PASS ☐ FAIL |
| Hiç lokasyonu olmayan org_admin testi | Geçici hesap | Boş ekran düşmüyor / anlamlı empty state | ☐ |  |  | ☐ PASS ☐ FAIL |

> Test hesaplarının her biri smoke sonrası **soft-deleted** edilir.

---

## 17. Audit log smoke test

| Kontrol | Güvenli doğrulama yöntemi | Beklenen sonuç | Kanıt bağlantısı/ek | Yapan kişi | Tarih | Sonuç |
|---|---|---|---|---|---|---|
| Yukarıdaki §15 + §16 testlerinin tümü audit log'a düştü | UI Audit Log filtreleri | Her test için ilgili entry görünür |  |  |  | ☐ PASS ☐ FAIL |
| Audit Log v2 UI bileşenleri çalışıyor | UI | AuditActionChip + Drawer + ResourceLink + FilterBar |  |  |  | ☐ PASS ☐ FAIL |
| CSV export | UI | İndirilebilir CSV; secret içermez |  |  |  | ☐ PASS ☐ FAIL |

---

## 18. Known issue acceptance

Devir alan ekip [12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) TD-1..TD-20 listelerini okudu, kabul etti:

| TD | Kabul eden | Tarih | Not |
|---|---|---|---|
| TD-1 (VLAN snapshot collector) |  |  |  |
| TD-2 (Agent pool key credential içermez) |  |  |  |
| TD-3 (Stale cache 5 dk window) |  |  |  |
| TD-4 (SSH error classification PR #119 deploy) |  |  |  |
| TD-5 (Privilege-denied parser-empty) |  |  |  |
| TD-6 (Collection observability) |  |  |  |
| TD-7 (event_consumer scale) |  |  |  |
| TD-8 (Runbook polish) |  |  |  |
| TD-9 (Audit bulk source device) |  |  |  |
| TD-10 (UI empty state ayrımı) |  |  |  |
| TD-11 (Device metadata manuel) |  |  |  |
| TD-12 (Worker RLS regression audit) |  |  |  |
| TD-13 (Agent terminal performance) |  |  |  |
| TD-14 (Backend creds defense) |  |  |  |
| TD-15 (VPS schema drift) |  |  |  |
| TD-16 (CF cache 5xx) |  |  |  |
| TD-17 (Frontend blank screen koruma) |  |  |  |
| TD-18 (Topology stacking) |  |  |  |
| TD-19 (MFA hardening) |  |  |  |
| TD-20 (Frontend permission catalog) |  |  |  |

---

## Bu turdaki yasak listesi

Hiç komut çalıştırılmadığı için her satır şablon olarak kalıyor. Sahaya çıkıldığında bu şablon **birebir** doldurulur. Yasaklar:

- ☒ Bu paket içine secret yazılmaz
- ☒ Yalnız READ ONLY komutlar
- ☒ Mutating, restart, recreate, queue purge yok
- ☒ Production restore üretimde yapılmaz; staging'de tatbikat
- ☒ Test hesapları smoke sonrası **soft-deleted** olur
