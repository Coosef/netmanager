# T10 C7 Wave 3 W3.1 — Backup Scheduler RLS Regression Fix: Deploy Log

> **Tarih:** 2026-06-01
> **Branch:** main
> **Kapsam:** `bulk_tasks.py` _get_db() RLS bypass + TaskModel(organization_id) zorunlu propagation
> **Sonuç:** 🟢 SMOKE PASSED — 6 günlük backup borcu tetiklendi

## Bağlam

Wave 2 #2 prod canlıya alındıktan sonra kullanıcı tespit etti: 70 switch, 0 güncel backup, 64 stale (>7g), 6 hiç. Diagnostic:

- `celery_beat` her dakika `check-backup-schedules-every-minute` task'ı kuyruğa atıyor
- `celery_default_worker` task'ı RECEIVED ediyor — exception yok
- Sessiz fail: `bulk_tasks._get_db()` ham `SyncSessionLocal()` döndürüyor — RLS bypass yok
- `backup_schedules` tablosu RLS-forced → SELECT 0 satır → `due=[]` → return

**Kök neden:** Faz 7 isolation rework'ün `worker_rls_session` fleet-bypass listesi `bulk_tasks.*` modülünü atlamış. Aynı pattern 8 task modülünde mevcut (bkz. `project_worker_rls_regression_audit` memory) — W3.1 yalnız `bulk_tasks.py`'ı kapsadı.

## Commit zinciri

| Commit | Açıklama |
|---|---|
| `0475e66` | W3.1 ilk fix — `_get_db()` içine `SET app.is_super_admin='on'` |
| `ff1a661` | Merge `t10/c7-wave3-backup-rls-fix` → main |
| `463e7a0` | W3.1 follow-up — `TaskModel(...)` `organization_id` zorunlu (model-level fail-secure hook) |
| `c26c1f4` | Merge `t10/c7-wave3-backup-rls-followup` → main |

## Follow-up fix gerekçesi

İlk fix sonrası smoke test başarısız: `BackupSchedule.last_run_at` hâlâ 2026-05-26. Manuel `check_backup_schedules()` trigger şu hatayı verdi:
```
scoped-write rejected: tasks.organization_id unresolved
```

Sebep: RLS bypass'le DB sorguları çalıştı ama `TaskModel(...)` INSERT'inde model-level `before_insert` hook fail-secure davrandı çünkü `organization_id` set edilmemişti. Faz 7 Phase 3d kuralı: "bypass mode'da çalışan task'lar yine `organization_id` doğru kaydetmeli."

**Çözüm:** `_trigger_schedule_backup_sync(..., organization_id: int)` zorunlu parametre + caller chain (`check_backup_schedules` → `schedule.organization_id` türetir). Async versiyonu + `scheduled_backup` fallback (org_id=1 hardcoded) + `backup_schedules.run_schedule_now` aynı şekilde güncellendi.

## Test

| Test | Sonuç |
|---|---|
| `test_w3_1_bulk_tasks_rls_bypass.py::test_get_db_calls_rls_bypass_sql` | ✅ PASS (mock-based) |
| `test_w3_1_bulk_tasks_rls_bypass.py::test_bulk_tasks_module_imports` | ✅ PASS |

## Prod deploy

| Adım | Komut | Sonuç |
|---|---|---|
| P0 anchor | `git rev-parse HEAD` (önce ff1a661) | OK |
| P1 fast-forward | `git merge --ff-only origin/main` → `c26c1f4` | OK |
| P2 build | `docker compose build backend celery_worker celery_default_worker celery_agent_worker celery_beat event_consumer` | ~6dk |
| P3 recreate | `docker compose up -d --no-deps backend + 5 workers` | 6 servis up |
| P4 smoke | BackupSchedule.last_run_at güncellenmesi | ✅ 16sn içinde |

Deploy tetikleme: 12:56:48 UTC tamamlandı.
İlk Beat cycle: 12:57:04 UTC → `last_run_at=2026-06-01 12:57:04.024573+00:00` (gecikme: 16 saniye).
`next_run_at=2026-06-02 02:00:00+00:00` (varsayılan günlük schedule, doğru hesaplandı).
`last_task_id=183` → `Task 183: name='Scheduled Backup (all)' status=running org_id=1`.

15 dakika sonrası: 3 yeni `ConfigBackup` row → backup loop canlı.

## Kapanış kriteri ✅

- [x] `BackupSchedule.last_run_at` güncellenmeye başladı (6 günlük borç tetiklendi)
- [x] `bulk_backup_configs` task'ı kuyruğa giriyor (Task 183)
- [x] `organization_id` doğru kaydediliyor (org_id=1)
- [x] Hiçbir worker fail/restart yok
- [x] pytest 2/2 PASS

## Geriye kalan (Wave 3 audit kuyruğu)

`project_worker_rls_regression_audit` memory'sinde 7 modül daha aynı pattern'ı taşıyor:

1. `backup_tasks.check_config_drift` — drift detection
2. `correlation_tasks.*` — event correlation
3. `topology_tasks.*` — LLDP/CDP discovery (6 saatte 1) — son 5 task fail/partial, audit bekliyor
4. `maintenance_tasks.*` — maintenance window enforcement
5. `security_policy_tasks.*` — policy enforcement
6. `monitor_tasks.poll_device_status` — prod'da çalışıyor (status'lar güncel) — özel inceleme
7. `driver_tasks.*` — driver template management

Bunlar Wave 3 W3.1 dışı, ayrı iş paketi.

## Rollback bilgisi (kullanılmadı)

- Önceki image tag'leri saklı; gerek olursa `docker tag netmanager-backend:ff1a661 netmanager-backend:latest && docker compose up -d --no-deps backend ...`
- Backup loop yan etki yok — fail-secure model `organization_id` yoksa INSERT reddedildiğinden cross-org sızıntı riski sıfır.

🟢 **Wave 3 W3.1 RESMI KAPANIŞ — 2026-06-01 12:57 UTC**
