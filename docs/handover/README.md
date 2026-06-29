# NetManager / Charon — Devir Paketi

Bu paket, Charon (kod adı) / NetManager projesini başka bir teknik ekibe **sıfırdan kurabilecek**, **güvenli şekilde işletebilecek**, **sorun giderebilecek** ve **geliştirmeye devam edebilecek** düzeyde devretmek için hazırlanmıştır.

## Terminoloji

**Charon** sistemin kod adı, **NetManager** ise ürün/proje adı olarak kullanılır. Bu dokümanda ikisi aynı platformu ifade eder. Repo dizinleri, container adları, modüller daha çok "NetManager" veya çıplak teknik isimler (`netmanager-agent`, `network_manager`) kullanırken; iç yazışmalarda + bazı UI öğelerinde + kod inceleme kayıtlarında "Charon" tercih edilir.

## Okuma sırası

Devir alacak ekip için önerilen okuma sırası:

1. **[00-EXECUTIVE-HANDOVER.md](00-EXECUTIVE-HANDOVER.md)** — Yönetici özeti, ilk 30 dakikada bilmen gerekenler
2. **[01-ARCHITECTURE-OVERVIEW.md](01-ARCHITECTURE-OVERVIEW.md)** — Bütünü kafanda oturt (Mermaid diyagramları dahil)
3. **[02-DEPLOYMENT-AND-INFRASTRUCTURE.md](02-DEPLOYMENT-AND-INFRASTRUCTURE.md)** — Production ortamını tanı
4. **[05-SECURITY-RBAC-ORGANIZATION-SCOPING.md](05-SECURITY-RBAC-ORGANIZATION-SCOPING.md)** — Güvenlik modeli ve yetkiler
5. **[14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md](14-SECRETS-ACCESS-HANDOVER-TEMPLATE.md)** — Erişimleri eski sahiplerden devral
6. Operasyonel kuyruğa geç: **06 → 07 → 08 → 09 → 10 → 11 → 13**
7. Mühendislik kuyruğu: **03 → 04 → 12**
8. **[15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md](15-ACCEPTANCE-AND-HANDOVER-CHECKLIST.md)** — İmza/teslim

## Komut etiketleri — risk sınıflandırması

Tüm doküman içindeki shell komutları aşağıdaki etiketlerden biriyle başlar:

| Etiket | Tanım | Örnek |
|---|---|---|
| `READ ONLY` | Hiçbir mutation yapmaz. Production'da sınırsız çalıştırılabilir. | `docker compose ps`, `psql -c "SELECT ..."` |
| `SAFE RESTART` | Bir servisi temiz şekilde yeniden başlatır. Veri kaybı, queue purge veya state bozulması içermez. | `docker compose restart backend` |
| `MUTATING` | DB / dosya / konfig üzerinde mutation yapar. Tetik koşulları önceden doğrulanmalı. | `alembic upgrade head`, `docker compose up -d --build` |
| `DO NOT RUN CASUALLY` | Yıkıcı veya geri alınması zor. Yalnız felaket kurtarma kapsamında, izinli kişi tarafından, ayrı doğrulama ile. | `docker compose down -v`, `psql -c "TRUNCATE ..."`, `redis-cli FLUSHALL` |

## VERIFY BEFORE HANDOVER

Kod tabanından **kesin olarak doğrulanmış** olmayan iddialar dokümanlar içinde `> ⚠ **VERIFY BEFORE HANDOVER**:` blokları olarak işaretlenmiştir. Devir alacak ekip bunları devir veren ekiple beraber doğrulamadan production değişikliği yapmamalı.

Her dosyanın sonunda (uygulanabilir yerlerde) konunun **doğrulanmış** ve **doğrulama bekleyen** alanları ayrı listelenmiştir.

## Kırmızı çizgiler

- **Bu paket hiçbir secret, password, token, private key, encrypted blob, gerçek kullanıcı bilgisi veya Cloudflare token içermez.** Yalnızca **nerede tutulduğu**, **nasıl devredileceği** ve **nasıl rotate edileceği** anlatılır.
- Tüm sayısal/sözel iddialar **kaynak dosya yolu** (`backend/...`, `frontend/...`, `docker-compose.yml`, alembic migration, vb.) veya **mevcut compose/nginx kontratı** ile desteklenmiştir.
- Devir paketi dokümanları **tarihsel incident** ile **kalıcı mimari** bilgiyi ayrı tutar:
  - Tarihsel incident: yalnız `11-INCIDENT-TROUBLESHOOTING-RUNBOOK.md` (karar ağaçları) ve `12-KNOWN-ISSUES-TECH-DEBT-ROADMAP.md` (doğrulanmış borçlar).
  - Kalıcı mimari: 01–10.

## Versiyon

| Alan | Değer |
|---|---|
| Paket sürümü | 1.0 (DRAFT) |
| Hazırlandığı dal | `t10/device96-ssh-error-classification-v1` |
| Hazırlandığı `main` HEAD'i | `2b26cdb` (Merge pull request #118 from Coosef/t10/p0-2-2-context-token-only-runtime-fetch) |
| Tarih | 2026-06-29 |
| Hazırlama yöntemi | Source code + docker-compose + alembic migrations + nginx config üzerinden doğrulanmış statik audit; production'da komut çalıştırılmamıştır |
