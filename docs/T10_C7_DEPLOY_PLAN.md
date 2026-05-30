# T10 C7 — Production Deploy Mini-Zincir (PLAN)

> **Durum:** PLAN (taslak). Bu doküman deploy talimatı DEĞİL — kapsam + adımlar + smoke gate'leri.
> Asıl deploy ayrı GO ile, adım adım yürütülür. **C5 başlatılmayacak** (gerçek auto-quarantine ertelendi).

## Bağlam

| | Değer |
|---|---|
| Current prod (b3d596b) | git `b3d596b00cd44d8496451a269f5c0b0c1a2df467` / alembic `f9adsecrls` (T10 A+B+C MVP + TD-2) |
| Target main (C7 merged) | git `ff35bc2…` / alembic head **`f9aeportpol`** |
| Aradaki merge'ler | C7.A `107fc37` · C7.B `d89b192` · C7.C `63784b4` · **C7.D `ff35bc2`** (4 epik merge) |
| Pending migration | **1 additive** — `f9ae_port_policy_assignments` |
| Forward-destructive? | **HAYIR** — yalnız `CREATE TABLE` + 3 index + RLS FORCE + GRANT (downgrade'de drop). Aynı pattern f9ab/f9ac/f9ad ile birebir. |
| Compose/network/env değişikliği? | **HAYIR** — B1c zaten canlı; .env aynen kalır; FRONTEND_TARGET=production aynı; BOOTSTRAP_SCHEMA kapalı |
| Risk profili | **Çok düşük** — T10 ana deploy'undaki risklerin küçük bir alt-kümesi |

## Önemli not — B1c sonrası migration komutu

Önceki deploy'da öğrendiğimiz B1c-ağ gerçeği geçerli: yeni compose postgres'i `internal` ağına koyar.
Çalışan stack zaten B1c sonrası `internal`'da olduğu için **şimdi `docker compose run --rm -T backend alembic upgrade head` ÇALIŞIR**
(B1c daha önce yapıldı; one-off backend de `internal` ağına bağlanacak ve `postgres` alias'ı çözecek).

> Bir kez daha güvende olmak için, postgres'in network durumu deploy öncesi kontrol edilir:
> `docker network inspect netmanager_internal | grep -E "postgres|backend"` → her ikisi de orada olmalı.

## Önkoşullar

- [ ] **Cloudflared ingress hâlâ `localhost:80`** (B1c sonrası aynı). Panel teyidi (deploy başlamadan).
- [ ] **Maintenance window** (kısa, dakikalar — recreate sırası saniye düzeyinde blip).
- [ ] Disk durumu — son ölçüm 12G boş / %74. Yeni build ~0.5GB net image; sığar.
- [ ] origin/main = `ff35bc2` (veya teyit edilecek son SHA — docs commit'leri ileri taşıyabilir; deploy günü tekrar kontrol).

## P-fazları

### P1 — Fresh backup + SHA (read-only DB; dosya yazar)
```bash
cd /opt/netmanager
TS=$(date -u +%Y%m%d_%H%M%S); OUT=backups/pre-c7-deploy-${TS}.dump
docker exec netmanager-postgres-1 pg_dump -U netmgr -Fc -d network_manager > "$OUT"
S=$(sha256sum "$OUT" | awk '{print $1}')
echo "$S  $OUT" > "${OUT%.dump}.sha256"
ls -lah "$OUT"; echo "SHA256=$S"
```
- [ ] Dump + SHA-256 + sidecar yazıldı.

### P2 — Rollback anchor (read-only)
```bash
git rev-parse HEAD                                              # b3d596b… (pre-deploy)
docker exec netmanager-postgres-1 psql -U netmgr -d network_manager -tAc \
  "SELECT version_num FROM alembic_version;"                    # f9adsecrls
docker inspect --format '{{.Name}} {{.Image}}' \
  $(docker ps -q --filter name=netmanager)                       # 11 image digest
```
- [ ] Anchor kaydı: git `b3d596b` + alembic `f9adsecrls` + 11 image digest + P1 dump yolu/SHA.

### P3 — Disk + ingress hızlı check
```bash
df -h /opt/netmanager; docker system df
docker network inspect netmanager_internal --format '{{range .Containers}}{{.Name}} {{end}}'
# postgres + backend orada görünmeli (B1c sonrası mevcut canlı)
```
- [ ] Disk > 5GB boş; postgres + backend `internal` ağında.

### P4 — Pinned FF
```bash
git fetch origin
git merge --ff-only ff35bc2     # FF değilse DURUR
git rev-parse HEAD              # ff35bc2…
git status --porcelain          # tracked clean
```
- [ ] HEAD = `ff35bc2`; tracked clean. Çalışan servisler hâlâ eski image.

### P5 — Image build
```bash
docker compose build            # FRONTEND_TARGET=production default; cache aktif
```
- [ ] backend + frontend yeni image digest'leri üretildi. Çalışan container'lar hâlâ eski image'da, restart yok.

### P6 — Migration (1 additive)
B1c sonrası canlı stack zaten `internal` ağında olduğu için `docker compose run` çalışacaktır:
```bash
docker compose run --rm -T backend alembic upgrade head
# Beklenen: f9adsecrls → f9aeportpol
docker exec netmanager-postgres-1 psql -U netmgr -d network_manager -tAc \
  "SELECT version_num FROM alembic_version;"                    # f9aeportpol
```
- [ ] 1 migration koştu; `alembic current = f9aeportpol`; hata yok. (Sorun olursa T10 deploy'unda kullandığımız fallback: `docker run --network netmanager_internal --env-file <(docker inspect netmanager-backend-1 …) netmanager-backend:latest alembic upgrade head`.)

### P7 — Up
```bash
docker compose up -d
docker compose ps               # 11/11 healthy
```
- [ ] Tüm servisler healthy; backend/frontend yeni image; uptime ~saniyeler.

### P8 — Smoke gate'leri
**Backend (creds'siz):**
```bash
B=http://127.0.0.1
echo "/health/ready: $(curl -s -o /dev/null -w '%{http_code}' $B/health/ready)"
echo "/login:        $(curl -s -o /dev/null -w '%{http_code}' $B/login)"
echo "/devices/1:    $(curl -s -o /dev/null -w '%{http_code}' $B/devices/1)"   # SPA route 200
echo "/devices/1?tab=security: $(curl -s -o /dev/null -w '%{http_code}' $B/devices/1?tab=security)"
echo "/api/v1/devices/1/port-policy-assignments (auth'suz): $(curl -s -o /dev/null -w '%{http_code}' $B/api/v1/devices/1/port-policy-assignments)"  # 401
```
- [ ] /health/ready 200 · SPA route'ları 200 · unauth API 401 · backend log temiz (5xx/OAuth2 yok)

**RLS izolasyon** (port_policy_assignments için):
```bash
docker exec -i netmanager-backend-1 python - <<'PY'
import os, psycopg2
url = os.environ['SYNC_DATABASE_URL'].replace('+psycopg2','')
c = psycopg2.connect(url); c.autocommit=True; cur=c.cursor()
def ctx(org):
    cur.execute("SELECT set_config('app.is_super_admin','off',false),"
                " set_config('app.current_org_id',%s,false)", (str(org),))
ctx(1); cur.execute("SELECT count(*) FROM port_policy_assignments"); print("org1 ppa:", cur.fetchone()[0])
ctx(2); cur.execute("SELECT count(*) FROM port_policy_assignments"); print("org2 ppa:", cur.fetchone()[0])
ctx(1); cur.execute("SELECT count(*) FROM port_policy_assignments WHERE organization_id<>1"); print("org1 cross:", cur.fetchone()[0])
PY
# Beklenen: cross=0
```
- [ ] Cross-org cross=0.

**DB permission audit:**
```bash
docker compose exec -T backend python scripts/audit_db_permissions.py
# Beklenen: 25/25 PASS → GO; RLS tablo sayısı 60 → 61 (port_policy_assignments)
```
- [ ] 25/25 PASS; RLS forced tablo +1.

**Tarayıcı (sizin):**
- [ ] `/login` (mevcut admin)
- [ ] `/devices` cihaz adı → `/devices/:id` Detail Page açılıyor
- [ ] **9 sekme** sırayla render: Genel · Portlar · Güvenlik · VLAN · MAC · PoE · Olaylar · Backup · Aksiyonlar
- [ ] Genel: cihaz meta + agent + lifecycle
- [ ] **Güvenlik**: Switch + cihaz-default Port dropdown'ları görünür; org_admin+ kaydeder; effective resolver kartı doğru kaynak Tag'leri gösterir
- [ ] **Portlar**: tablo gelir + effective policy kolonu + kaynak Tag (override/cihaz-default/org-default); toplu seçim + "Policy ata" Drawer + "Override kaldır" + Shutdown DISABLED tooltip; dry-run flap pill (varsa)
- [ ] VLAN tablo gelir (cihaz online ise)
- [ ] MAC tablosu arama çalışır
- [ ] PoE: cihaz PoE varsa istatistik + port tablosu; yoksa friendly empty
- [ ] Olaylar: severity chip + policy_only chip + Drawer detay
- [ ] Backup: tarihçe + indir; org_admin+ "Şimdi Backup Al" Popconfirm
- [ ] Aksiyonlar: 4 kart; **Shutdown disabled** tooltip "C5 ile gelecek"; Sil Popconfirm `<Tag hostname><code IP>` gösterir
- [ ] Viewer rolü: write butonları gizli/disabled; rowSelection kapalı
- [ ] Drawer "Hızlı Düzenle"de C6b Güvenlik Politikası bölümü **YOK** (Security tab'a taşındı)
- [ ] Console: uygulama kaynaklı yeni error yok (background.js eklenti gürültüsü hariç)

### P9 — Rollback kriteri & prosedür
**Geri al:** migration ortada durdu / SPA route 5xx / 9 sekme render edemiyor / RLS izolasyon kırıldı / DB audit FAIL.
**Prosedür:** DR_RUNBOOK §6 — yazan servisleri durdur → P1 dump restore → `git merge --ff-only` / `checkout b3d596b` → image rollback (anchor digest) → P8 gate'leri (1-3) yeşil + alembic=`f9adsecrls`.
> Tek başına `alembic downgrade f9adsecrls` da yeterli olabilir (f9ae additive — drop_table güvenli, mevcut veri yok); ama backup restore güvence katmanı olarak korunur.

## Mini-zincir özet
| Faz | Adım | Yazma | Risk |
|---|---|---|---|
| P1 | pg_dump | dosya | Read-only DB |
| P2 | anchor | yok | Read-only |
| P3 | disk + ingress check | yok | Read-only |
| P4 | git FF | working tree | Çalışan servis etkilenmez |
| P5 | docker compose build | image | Çalışan eski image'da kalır |
| P6 | alembic upgrade head | DB (CREATE TABLE) | 1 additive — düşük |
| P7 | docker compose up -d | servis swap | Saniyeler blip |
| P8 | smoke gates | read-only | Hata → rollback |
| P9 | rollback (gerekirse) | DB+code+image | Anchor + dump şart |

## Riskler & kabul edilen
- **Bundle büyüdü** (9 sekme + 6 yeni file) — vite build OK (warnings yalnız workbox glob, pre-existing).
- **PoeTab `retry:false` 404 toleransı** — staging'de doğrulandı, gerçek prod cihazlarda 404 farklı format dönerse friendly empty zarar vermez.
- **`useNavigate('?tab=…')` derin link** — React Router relative path → mevcut path korunur, query değişir; staging'de teyit.
- **DevicePortsPage silindi** — eski bookmark `/devices/:id/ports` zaten C7.B'de redirect'e bağlandı (`?tab=ports`). 404 olmaz.

## Kapsam DIŞI
- **C5 gerçek auto-quarantine** — başlatılmaz. ActionsTab/Ports tab'da Shutdown DISABLED + tooltip ile yer ayrıldı.
- Vendor-alias port_name normalization (v2.1).
- DeviceDetail.tsx modal cleanup (refactor v2.1).

---

## Onay tetikleyici
Plan'ı kabul edip GO derseniz adım adım yürütürüm (her P-fazından sonra durup çıktı paylaşır, kırmızı gate'te otomatik dururum, rollback için açık onay isterim).
