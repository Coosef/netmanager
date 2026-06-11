# WIN-INTEGRATE — Backend image drift risk

## Mevcut compose şeması (WIN-INTEGRATE öncesi ve sonrası birebir aynı)

Üst-seviye `docker-compose.yml` içinde **7 servis** aynı backend
Dockerfile'ı kullanır:

| Servis              | Amaç                                            |
|---------------------|-------------------------------------------------|
| `backend`           | FastAPI uvicorn ana API                          |
| `celery_worker`     | SSH komut + cihaz polling kuyruğu               |
| `celery_agent_worker` | Agent WebSocket forward / live-metrics push     |
| `celery_default_worker` | Diğer arka plan görevleri                       |
| `celery_beat`       | Cron-style task scheduler                       |
| `event_consumer`    | Faz 6C Redis Streams ingest tüketici            |
| `flower`            | Celery monitoring UI                            |

WIN-INTEGRATE PR'ı her birinin `build` direktifini sadece
**context + dockerfile yolu** açısından değiştirdi:

```diff
-  build: ./backend
+  build: { context: ., dockerfile: backend/Dockerfile }
```

Hiçbir servis tanımı, environment, network, port, volume, healthcheck
veya runtime davranışı değişmedi.

## "Image drift" tehlikesi — şimdi yeni değil

`docker compose build` her servisi ayrı ayrı build eder.
BuildKit cache aynı katmanları paylaşır, AMA çıktı **7 ayrı image
referansı**dır (her biri `switch-<servis>:latest` veya benzer).

Yani:

- `docker compose build backend` SADECE `backend` servisinin
  image'ını yeniler.
- `docker compose up -d backend` sonrası `celery_worker` halen eski
  image'ı çalıştırıyor olabilir → **eski Python kodu + eski Go host
  binary**.

Bu sözleşme **WIN-INTEGRATE'ten önce de aynıydı**:

```bash
# Eski:    backend Python kodu güncellendi → bu durumda da aynı drift
$ docker compose build backend && docker compose up -d backend
$ # celery_worker hâlâ eski Python kodunda
```

Yeni olan tek şey: WIN-INTEGRATE Go host binary'sini `backend`
image'ına ekledi. Ama bu binary **yalnız `backend` servisi tarafından
serve edilir** (host endpoint backend'de):

- `celery_worker` Go binary'ye dokunmaz.
- `event_consumer` Go binary'ye dokunmaz.
- Drift'in tek görünür etkisi: backend image yeni Go binary'ye sahip,
  worker'lar eski Python koduyla; AMA WIN-INTEGRATE flag default `false`
  olduğu için endpoint zaten 404 dönüyor.

## Production deploy prosedürü — bu PR'da değiştirmiyoruz

Mevcut prosedür her zaman olduğu gibi:

```bash
# Tüm servisleri birlikte build et — image drift olmaz
docker compose build --build-arg \
    HOST_VERSION="2.0.0-mvp0+g$(git rev-parse --short=12 HEAD)"

# Tüm servisleri birlikte ayağa kaldır
docker compose up -d
```

Sadece backend deploy etmek isteyen operatör için **manuel disiplin
kuralı**: WIN-INTEGRATE deploy edildiğinde **TÜM** backend-türevi 7
servisi birlikte yeniden build et:

```bash
docker compose build --build-arg HOST_VERSION="..." \
    backend celery_worker celery_agent_worker celery_default_worker \
    celery_beat event_consumer flower
docker compose up -d backend celery_worker celery_agent_worker \
    celery_default_worker celery_beat event_consumer flower
```

## Compose anchor refactor (kapsam dışı)

Daha sağlıklı uzun-vadeli çözüm: YAML anchor ile build direktifini
ortak `x-backend-build: &backend-build` altına çıkar, her servis
`<<: *backend-build`. Bu **WIN-INTEGRATE kapsam dışı** — mevcut PR
yalnız Go host binary entegrasyonunu hedefliyor. Anchor refactor
ayrı bir PR olarak ele alınmalı (build mantığı tek nokta, drift
matematiksel olarak imkansız).

## Karar

- **WIN-INTEGRATE PR'ında compose 7x build pattern korunur** — bu
  mevcut sözleşmenin parçası, PR'a HAS bir regresyon değil.
- **Production deploy çağrısı** yukarıdaki "7 servisi birlikte
  rebuild" disiplinini izlemeli; aksi takdirde Python kodu drift'i
  oluşur (Go binary drift'i WIN-INTEGRATE flag kapalı iken kullanıcı
  yüzeyine yansımaz).
- **Anchor refactor** ayrı bir clean-up PR olarak takip edilmeli
  (orta-vadeli backlog).
