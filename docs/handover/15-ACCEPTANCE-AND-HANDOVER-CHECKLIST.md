# 15 — Devir / Kabul Checklisti

Bu doküman **devir alan** ve **devir veren** ekiplerin birlikte doldurup imzalayacağı resmi devir tutanağıdır.

> Tüm satırlar **iki tarafça** işaretlenir. Bir kalem **belirsiz** kaldıysa o kalem **doldurulup imzalanmadan** devir tamamlanmış sayılmaz.

## Bağlantılı dokümanlar (16–19)

Bu checklist'in **her bölümünün arkasında** aşağıdaki canlı şablonlar durur:

- [19-HANDOVER-DAY-RUNBOOK.md](19-HANDOVER-DAY-RUNBOOK.md) — Teslim gününün T-7 → T+30 zaman çizelgesi.
- [16-LIVE-ENVIRONMENT-COMPLETION-WORKSHEET.md](16-LIVE-ENVIRONMENT-COMPLETION-WORKSHEET.md) — VERIFY alanlarının canlı doldurulduğu şablon.
- [17-ACCESS-AND-OWNERSHIP-MATRIX.md](17-ACCESS-AND-OWNERSHIP-MATRIX.md) — Sahiplik / erişim devri matrisi.
- [18-PRODUCTION-VALIDATION-EVIDENCE-TEMPLATE.md](18-PRODUCTION-VALIDATION-EVIDENCE-TEMPLATE.md) — Read-only kanıt toplama şablonu.

## Üç bloklayıcı şart (handover gating)

**Aşağıdaki üç şartın hiçbiri esnetilemez:**

1. **Access owner belirlenmeden handover complete kabul edilmez.** [17-ACCESS-AND-OWNERSHIP-MATRIX.md](17-ACCESS-AND-OWNERSHIP-MATRIX.md)'in her satırı Primary + Backup Owner sütunları **dolu** olmalı. Tek kişiye bağlı erişim handover'ı bloklar.
2. **Backup restore kanıtı olmadan acceptance imzalanmaz.** [18 §12](18-PRODUCTION-VALIDATION-EVIDENCE-TEMPLATE.md) PASS olarak işaretli + RTO ölçümü + kanıt eki bulunmalı.
3. **VERIFY BEFORE HANDOVER alanlarının her biri CONFIRMED / PENDING / RISK ACCEPTED durumuna bağlanmadan handover kapanmaz.** [16 §17](16-LIVE-ENVIRONMENT-COMPLETION-WORKSHEET.md) genel gating tablosunun dört sorusu yanıtlanmış olmalı.

---

## A — Repository erişimi

| Kalem | Durum | Devir veren imza | Devir alan imza |
|---|---|---|---|
| GitHub repository (`Coosef/netmanager` veya doğrulanmış) read+write erişim devredildi | ☐ | | |
| Devir alan ekibin organization member statüsü onaylandı | ☐ | | |
| Devir veren ekibin kişisel erişimleri planlı tarihte revoke edilecek (overlap penceresi) | ☐ | | |
| Bot/API token'lar (CI, Snyk, vb.) ortak vault'a yazıldı | ☐ | | |

---

## B — Branch protection

| Kalem | Durum |
|---|---|
| `main` branch protection ayarları belgelendi ([14 §2](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md)) | ☐ |
| Required reviewers listesi güncel | ☐ |
| Required CI checks listesi güncel | ☐ |
| Force-push `main`'e yasak (zaten production policy) | ☐ |

---

## C — CI / CD doğrulama

| Kalem | Durum |
|---|---|
| Frontend QA workflow yeşil (örnek bir PR ile doğrulandı) | ☐ |
| Snyk scan yeşil | ☐ |
| Integration test workflow yeşil | ☐ |
| Yeni Alembic migration için autocheck (varsa) çalışıyor | ☐ |
| Release tag pattern + workflow belgelendi | ☐ |

---

## D — Production stack health

```bash
# READ ONLY — devir günü çalıştırılır
docker compose ps
curl -fsS https://<domain>/health/live  -o /dev/null -w "%{http_code}\n"
curl -fsS https://<domain>/health/ready -o /dev/null -w "%{http_code}\n"
```

| Kalem | Durum |
|---|---|
| 11 servisin tamamı `healthy` | ☐ |
| `/health/live` 200 | ☐ |
| `/health/ready` 200 | ☐ |
| Frontend smoke (login + dashboard + devices) — devir alan tarafça | ☐ |
| Alembic `current == heads` (devir günü snapshot edildi) | ☐ |

---

## E — Backup restore testi

| Kalem | Durum |
|---|---|
| Üretimden veya seçili tarihten backup alındı | ☐ |
| **Staging / temiz** bir VPS veya lokal Docker'da restore edildi | ☐ |
| Restore sonrası uygulamanın login + dashboard akışı çalıştı | ☐ |
| Restore süresi ölçüldü ve runbook'a eklendi ([10 §5](10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md)) | ☐ |
| Production'a restore **yapılmadı** (bu sadece tatbikat) | ☐ |

---

## F — Agent onboarding testi

| Kalem | Durum |
|---|---|
| Test bir lokasyona yeni agent enroll edildi | ☐ |
| Agent host'a (lokal VM kabul) install edildi | ☐ |
| Agent UI'da `online` görünüyor | ☐ |
| Test cihazı onboard edildi, Fetch Info başarılı | ☐ |
| Sonrasında test agent + cihaz temizlendi (soft-delete) | ☐ |

---

## G — Device onboarding testi

| Kalem | Durum |
|---|---|
| Public IP test cihazı eklendi (Cisco/Aruba/Ruijie biri) | ☐ |
| Fetch Info başarılı, model+firmware+serial dolu | ☐ |
| Terminal aç → privileged mode `#` doğrulandı | ☐ |
| Ports tab → port listesi 10 dk içinde doldu | ☐ |
| audit_logs: `device_created` + `device_info_fetched` görünür | ☐ |
| Test sonrası cihaz soft-delete edildi | ☐ |

---

## H — RBAC testi

Her rol için (super_admin, org_admin, engineer, viewer) bir test hesap:

| Rol | Yetki testi | Durum |
|---|---|---|
| super_admin | Platform Mgmt menüsünü görür | ☐ |
| super_admin | Tüm organizasyonlara erişir | ☐ |
| org_admin | Sadece kendi org'unu görür | ☐ |
| org_admin | Org içinde tüm lokasyonlara erişir | ☐ |
| engineer | Yalnız atandığı lokasyonlardaki cihazları görür | ☐ |
| engineer | Audit log silme / Platform Mgmt → 403 | ☐ |
| viewer | Salt okuma; Terminal aç → forbidden | ☐ |
| viewer | Cihaz oluşturma → forbidden | ☐ |

---

## I — Worker / queue health

| Kalem | Durum |
|---|---|
| 3 worker `inspect ping` → `pong` | ☐ |
| Beat scheduler 33 task'ı listede gösteriyor | ☐ |
| Son 24 saat içinde her ana cycle (mac_arp, snmp, poe) en az 1 success kaydı oluşturmuş | ☐ |
| event_consumer healthy + `event_consumer:alive` key var | ☐ |
| Flower UI (dev overlay açıkken) — workers + tasks görünüyor | ☐ |

---

## J — Incident runbook dry-run

Bir senaryo (örnek: Senaryo 8 "Ports tab No ports found") seçilir:

| Kalem | Durum |
|---|---|
| Devir alan ekip karar ağacını okudu | ☐ |
| READ ONLY doğrulamaları çalıştırıldı | ☐ |
| "Yasak müdahaleler" listesi anlaşıldı | ☐ |
| Güvenli sonraki adımın **gerekli** olup olmayacağına devir alan ekip karar verebildi | ☐ |
| Escalation kriteri net | ☐ |

---

## K — Bilinen risklerin kabulü

[12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) içindeki maddeler:

| ID | Madde | Kabul |
|---|---|---|
| TD-1 | VLAN snapshot collector eksikliği | ☐ |
| TD-2 | Agent pool key credential içermez | ☐ |
| TD-3 | Credential update sonrası stale cache | ☐ |
| TD-4 | SSH error classification UI iyileştirme | ☐ |
| TD-5 | Privilege-denied parser-empty | ☐ |
| TD-6 | MAC/ARP/PoE persistence gözlemlenebilirliği | ☐ |
| TD-7 | event_consumer scaling | ☐ |
| TD-8 | Worker runbook polish | ☐ |
| TD-9 | Audit log bulk source device eksik | ☐ |
| TD-10 | UI gerçek 0 vs failure ayrımı | ☐ |
| TD-11 | Device metadata manuel doldurma | ☐ |
| TD-12 | Worker RLS regression audit | ☐ |
| TD-13 | Agent terminal performance | ☐ |
| TD-14 | Backend credential validation defense | ☐ |
| TD-15 | VPS schema vs main drift | ☐ |
| TD-16 | Cloudflare 5xx cache window | ☐ |
| TD-17 | Frontend blank screen zinciri (closed, koruma) | ☐ |
| TD-18 | Topology stacking hazard | ☐ |
| TD-19 | MFA backend hardening backlog | ☐ |
| TD-20 | Frontend permission catalog / source consolidation | ☐ |

Her satır **devir alan ekip lideri** tarafından imzalanır: "anladım, sahipleneceğim".

---

## L — Eksik erişimlerin listesi

Bu satıra **devir günü hala eksik kalmış** erişimler yazılır:

| Eksik | Sebep | Devir tarihi | Sahip |
|---|---|---|---|
| — | — | — | — |

Eksik kalemler **bekleyen aksiyon** olarak issue tracker'a düşülür.

---

## M — Final imzalar

| Rol | İsim | Tarih | İmza |
|---|---|---|---|
| Devir veren teknik sahibi | | | |
| Devir veren proje sahibi | | | |
| Devir alan teknik sahibi | | | |
| Devir alan proje sahibi | | | |

---

## N — Devir sonrası ilk 30 gün

Devir sonrası ilk ay için planlanan overlap (her iki ekibin de okuyabileceği):

- [ ] Devir veren ekip P1 incident'ta destek için ulaşılabilir (kapasite tanımlı)
- [ ] Devir alan ekip haftalık review meeting koşturuyor
- [ ] [12](12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) P1 maddeleri için sprint atandı
- [ ] [14](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md) hala eksik kalemler kapatıldı
- [ ] 30. günde devir veren ekibin kalan erişimleri revoke edilir
