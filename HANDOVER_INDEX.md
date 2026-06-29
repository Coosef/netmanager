# NetManager / Charon — Handover Index

> Bu dosya proje kökünde durur ve `docs/handover/` altındaki resmî devir paketini hızlı erişim için listeler.
> Detaylı içerik için: [docs/handover/README.md](docs/handover/README.md).

## Devir paketi dizini

`docs/handover/`

| Dosya | Konu | Kim okumalı |
|---|---|---|
| [00-EXECUTIVE-HANDOVER.md](docs/handover/00-EXECUTIVE-HANDOVER.md) | Yönetici özeti, ilk 30 dakika, kritik riskler | Devir alacak ekip lideri |
| [01-ARCHITECTURE-OVERVIEW.md](docs/handover/01-ARCHITECTURE-OVERVIEW.md) | Yüksek seviye mimari, request/command flow diyagramları | Tüm teknik ekip |
| [02-DEPLOYMENT-AND-INFRASTRUCTURE.md](docs/handover/02-DEPLOYMENT-AND-INFRASTRUCTURE.md) | Stack, compose servisleri, deploy/rollback | DevOps / SRE |
| [03-BACKEND-FRONTEND-AGENT-ARCHITECTURE.md](docs/handover/03-BACKEND-FRONTEND-AGENT-ARCHITECTURE.md) | Modüller, cache katmanları, error chain | Backend / frontend / agent geliştirici |
| [04-DATABASE-MIGRATIONS-AND-DATA-MODEL.md](docs/handover/04-DATABASE-MIGRATIONS-AND-DATA-MODEL.md) | Alembic, kritik tablolar, soft-delete, tenant scoping | Backend / DBA |
| [05-SECURITY-RBAC-ORGANIZATION-SCOPING.md](docs/handover/05-SECURITY-RBAC-ORGANIZATION-SCOPING.md) | Roller, izinler, RLS, credential encryption | Backend / güvenlik |
| [06-AGENT-INSTALLATION-AND-OPERATIONS.md](docs/handover/06-AGENT-INSTALLATION-AND-OPERATIONS.md) | Agent kurulum, host troubleshooting, pool/cache etkisi | Saha / NOC |
| [07-CELERY-REDIS-BACKGROUND-JOBS.md](docs/handover/07-CELERY-REDIS-BACKGROUND-JOBS.md) | Worker'lar, beat, recovery, queue politikası | DevOps / Backend |
| [08-DEVICE-ONBOARDING-AND-CREDENTIALS.md](docs/handover/08-DEVICE-ONBOARDING-AND-CREDENTIALS.md) | Cihaz ekleme, credential update sonrası bekleme | NOC / Operatör |
| [09-RUIJIE-SSH-AND-PARSER-OPERATIONS.md](docs/handover/09-RUIJIE-SSH-AND-PARSER-OPERATIONS.md) | Ruijie SSH, user vs privileged, parser farkları | Operatör / Saha |
| [10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md](docs/handover/10-MONITORING-BACKUP-RECOVERY-RUNBOOK.md) | Health, backup, restore, sistem recovery | SRE |
| [11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md](docs/handover/11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md) | Senaryo bazlı karar ağaçları | NOC / On-call |
| [12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md](docs/handover/12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md) | Doğrulanmış teknik borçlar + öncelikler | Yeni ekip lideri / PM |
| [13-OPERATIONS-CHECKLISTS.md](docs/handover/13-OPERATIONS-CHECKLISTS.md) | Günlük/haftalık/event-driven checklistler | NOC / DevOps |
| [14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md](docs/handover/14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md) | Erişim sahipliği şablonu (boş, doldurulacak) | Tüm taraflar |
| [15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md](docs/handover/15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md) | İmza/teslim checklisti | Devir alan + devir veren |

## Risk sınıflandırması

Tüm komut bloklarında etiket konulmuştur:

| Etiket | Anlam |
|---|---|
| `READ ONLY` | Hiçbir mutation yok; istenildiği kadar çalıştırılabilir |
| `SAFE RESTART` | Servis restart eder ama veri kaybı/state bozulması yok |
| `MUTATING` | DB / file / config mutation yapar; öncesinde tetik koşulları doğrulanmalı |
| `DO NOT RUN CASUALLY` | Yıkıcı veya geri dönüşü zor; yalnızca felaket kurtarma kapsamında |

## Kırmızı çizgiler

- Bu paket **hiçbir secret içermez**. Erişim/parola/key sahipliği [14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md](docs/handover/14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md) içinde **şablon** olarak teslim edilir; gerçek değerler ayrı kanalla (1Password, gpg, vb.) iletilir.
- Kodda doğrulanamamış noktalar her dosyada `VERIFY BEFORE HANDOVER` etiketiyle işaretlidir; devir alacak ekibin bunları sahibiyle birlikte doğrulaması beklenir.
- Bu paket **tarihsel incident özetleri ile kalıcı mimari bilgileri ayırır**: incident özetleri yalnız 11 ve 12'de, mimari bilgi 01–10'da.
