# Tenant-Aware Retention / Quota / Archive Policy — Design Document

**Status:** Design only — NOT implemented in PHASE1A.
**Phase:** Will be addressed as a separate branch (PHASE1C) after PHASE1A merges.
**Author:** Generated 2026-06-22 as part of `t10/platform-operations-split-org-context-phase1` design deliverables.

## 1. Purpose

Define a per-organization retention/quota/archive policy that protects the platform from runaway tenant telemetry while letting each customer dial their retention window to their plan tier (Starter / Professional / Enterprise) and legal obligations. **No tenant gets a separate database, no tenant gets a separate table** — the existing shared schema + RLS + `organization_id` model continues. The split is **policy-driven**, applied by background jobs and ingest-time admission controllers.

## 2. Data architecture decision (locked)

| Question                                                          | Answer                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| One database per tenant?                                          | **NO** — shared `network_manager` database                              |
| One table per tenant?                                             | **NO** — shared tables                                                  |
| Tenant isolation mechanism                                        | `organization_id` column + Postgres RLS + `X-Org-Id` header             |
| Time-series storage for high-volume telemetry                     | TimescaleDB hypertables OR native PG declarative partitioning           |
| Cross-tenant queries                                              | Forbidden in operational code; allowed only inside platform-admin jobs  |

## 3. Tables affected

### 3.1 Operational tables (small / medium row counts)

These already use `organization_id` for tenant isolation. The retention policy adds time-based pruning rules but does NOT change schema.

- `devices` — pruned via soft-delete TTL; rows never hard-deleted by retention.
- `agents` — same as devices.
- `locations` — same; deletion is operator-initiated, not retention-driven.
- `users` — never retention-pruned.
- `audit_logs` — retention-pruned by `audit_log_retention_days` (with legal-hold exception).
- `alerts` — retention-pruned by `alert_history_retention_days`.
- `incidents` — retention-pruned by `incident_history_retention_days`.

Recommended composite indexes (idempotent — verify with `EXPLAIN` before adding):

```sql
CREATE INDEX IF NOT EXISTS ix_devices_org_loc
  ON devices (organization_id, location_id);

CREATE INDEX IF NOT EXISTS ix_agents_org_loc
  ON agents (organization_id, location_id);

CREATE INDEX IF NOT EXISTS ix_alerts_org_created
  ON alerts (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_incidents_org_status_updated
  ON incidents (organization_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS ix_audit_logs_org_occurred
  ON audit_logs (organization_id, occurred_at DESC);
```

### 3.2 Time-series tables (large volume — partitioning recommended)

These are the **load-bearing performance tables**. Designed for tenant scale (millions of rows per day).

| Table                  | Time column      | Estimated rate (per tenant) | Recommendation                                                       |
| ---------------------- | ---------------- | --------------------------- | -------------------------------------------------------------------- |
| `agent_metrics`        | `captured_at`    | 1 row / 30s / agent         | TimescaleDB hypertable, 1-day chunks                                 |
| `probe_results`        | `recorded_at`    | 1 row / 60s / probe         | TimescaleDB hypertable, 1-day chunks                                 |
| `syslog_events`        | `received_at`    | bursty; ~10/s / device      | TimescaleDB hypertable, 1-hour chunks                                |
| `availability_records` | `period_end`     | 1 row / 5min / device       | Native PG partitioning, monthly                                      |
| `activity_events`      | `occurred_at`    | medium                      | Native PG partitioning, monthly                                      |

### 3.3 TimescaleDB vs native PG partitioning

| Criterion                       | TimescaleDB hypertable                                | Native PG declarative partitioning           |
| ------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| Setup ergonomics                | `SELECT create_hypertable(...)`; auto-chunks          | Manual `CREATE TABLE … PARTITION BY RANGE`   |
| Continuous aggregates           | Built-in `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)` | Roll your own with `CREATE MATERIALIZED VIEW` + scheduled refresh |
| Retention policy as a primitive | `add_retention_policy('agent_metrics', INTERVAL '90 days')` | Drop partitions manually via cron            |
| Compression                     | Per-chunk columnar compression (Hyperloglog-friendly) | Toast-level only                             |
| Operational complexity          | One Postgres extension to maintain                    | Native; no extra extension                   |
| Vendor lock-in                  | TimescaleDB is open-core; pgvector pattern (open)     | None                                         |
| Production track record (NetMgr)| Not yet adopted                                       | Already used elsewhere in the system         |

**Recommendation:** Adopt TimescaleDB for `agent_metrics`, `probe_results`, `syslog_events`. The continuous-aggregate + retention-policy primitives are worth the operational overhead. `availability_records` and `activity_events` stay on native partitioning (their volume is bounded by inventory size, not ingest rate).

A **Phase 1C migration** (separate branch) will:
1. Install TimescaleDB extension on the VPS Postgres (one-time).
2. Convert the three target tables to hypertables (idempotent migration with backfill).
3. Define one retention policy per table that defers to the per-org `retention_policies` table for the actual TTL.

The migration is NOT executed by this PR.

## 4. `retention_policies` table (proposed schema)

```sql
CREATE TABLE retention_policies (
  id                              SERIAL          PRIMARY KEY,
  organization_id                 INTEGER         NOT NULL UNIQUE
                                  REFERENCES organizations(id) ON DELETE CASCADE,

  -- TTLs (days)
  raw_metrics_retention_days        INTEGER NOT NULL DEFAULT 30,
  aggregated_metrics_retention_days INTEGER NOT NULL DEFAULT 365,
  syslog_retention_days             INTEGER NOT NULL DEFAULT 30,
  audit_log_retention_days          INTEGER NOT NULL DEFAULT 365,
  alert_history_retention_days      INTEGER NOT NULL DEFAULT 90,
  incident_history_retention_days   INTEGER NOT NULL DEFAULT 365,
  device_activity_retention_days    INTEGER NOT NULL DEFAULT 90,

  -- Quotas
  max_telemetry_storage_gb          NUMERIC(10,2) NOT NULL DEFAULT 50.00,

  -- Archive (optional cold-storage offload before delete)
  archive_enabled                   BOOLEAN     NOT NULL DEFAULT FALSE,
  archive_destination               VARCHAR(255),         -- e.g. 's3://bucket/path'
  archive_retention_days            INTEGER,              -- NULL = forever in archive

  -- Locks
  retention_policy_locked           BOOLEAN     NOT NULL DEFAULT FALSE,
  legal_hold                        BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Lifecycle
  effective_from                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  policy_version                    INTEGER     NOT NULL DEFAULT 1,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by                        INTEGER     REFERENCES users(id) ON DELETE SET NULL
);
```

Defaults map to the **Starter** plan. The `policy_version` increments on every UPDATE; the retention job records `policy_version` in its audit event so a future investigation can correlate a deleted row with the policy that condemned it.

## 5. Plan-tier templates (illustrative — product decision)

| Plan         | Raw metrics | Aggregated metrics | Syslog | Audit       | Quota    |
| ------------ | ----------- | ------------------ | ------ | ----------- | -------- |
| Starter      | 30 days     | 12 months          | 30 days  | 12 months  | 50 GB    |
| Professional | 90 days     | 24 months          | 90 days  | 24 months  | 250 GB   |
| Enterprise   | 180-365 days| 36+ months         | 180 days | policy-driven | 1+ TB |

Values are starting points; the product team should refine them based on customer feedback.

## 6. Retention job lifecycle

### 6.1 Scheduling

Every organization's policy is evaluated by a single shared job that runs hourly (or nightly for low-volume tables). The job is implemented as a Celery task or an in-process scheduler thread; both options preserve the existing job runner.

### 6.2 Per-org, per-table processing order

For each `(organization_id, table)`:

1. **Aggregate before delete.** If the table has a continuous aggregate (TimescaleDB) or a manual roll-up table, ensure the aggregate is up to date BEFORE deleting raw rows. Skip-and-retry on aggregate lag.
2. **Archive if enabled.** If `archive_enabled=true` AND the rows fall outside the archive window, stream them to `archive_destination` (S3 / Azure Blob / on-prem). Use `COPY (SELECT …) TO PROGRAM` for efficiency on Postgres-side processing.
3. **Delete / drop chunk.** TimescaleDB: `drop_chunks('agent_metrics', older_than => …, schema_name => …)` per org filter (RLS GUC set to that org). Native partitioning: `DETACH PARTITION` then `DROP`.
4. **Audit event.** Emit `retention_pruned_org=<id>_table=<name>_rows=<count>` with `policy_version`. The frontend's Audit Log v2 chip categorizer renders it as `Operasyon` (existing category).

### 6.3 Failure handling

- **Idempotency:** Each job run has a batch ID stored in `retention_batches`. A re-run with the same batch ID is a no-op.
- **Retry:** Up to 3 retries with exponential backoff. After 3 failures, surface an alert + abort.
- **Cross-tenant safety:** The job MUST hold the per-org RLS GUC for the duration of each (org, table) processing block. Validated by a wrapping unit test (see §10).
- **Legal hold:** If `legal_hold=true` for an org, the audit_logs path is skipped entirely (no delete, no archive). Other tables proceed as configured. A health badge surfaces "Legal hold active" on the platform admin dashboard.

### 6.4 Aggregate / continuous-aggregate strategy

Dashboard queries MUST NOT scan raw rows. Per-table aggregate views:

| Table                  | Aggregate                                                              |
| ---------------------- | ---------------------------------------------------------------------- |
| `agent_metrics`        | `agent_metrics_5min` — `SELECT time_bucket('5min', captured_at), agent_id, AVG(cpu_pct), AVG(mem_pct) …` |
| `probe_results`        | `probe_results_5min` — same pattern                                    |
| `syslog_events`        | `syslog_events_hourly_summary` — `severity_bucket, COUNT(*)`            |
| `availability_records` | already aggregated at 5-min level by ingest; no further roll-up needed |

Aggregates are queried with the same RLS GUC; tenant isolation is preserved.

## 7. API contract (proposed — design only)

### 7.1 Read

`GET /api/v1/platform/organizations/{org_id}/retention-policy`
- super_admin / platform_admin only
- returns the full policy row

### 7.2 Update

`PATCH /api/v1/platform/organizations/{org_id}/retention-policy`
- super_admin / platform_admin only
- body: any subset of the policy fields
- bumps `policy_version` automatically
- emits `retention_policy_updated_org=<id>_v=<n>` audit event
- 422 if any TTL exceeds plan-tier cap (caps are enforced server-side; the UI shows the cap inline)

### 7.3 Per-tenant report

`GET /api/v1/platform/organizations/{org_id}/retention-status`
- super_admin / platform_admin only
- returns oldest retained row per table + estimated storage + projected next-prune date

## 8. Throttling / quota enforcement

When an org approaches `max_telemetry_storage_gb`:

1. **80% utilization** → soft warning on the Platform Admin dashboard.
2. **95% utilization** → ingest backpressure: agents receive a 503 with `Retry-After: 60` on telemetry-only endpoints. Operational endpoints (SSH, config push) keep working.
3. **100% utilization** → ingest hard-stop. Telemetry endpoints return 507 Insufficient Storage. Operational endpoints still work; a daily summary email goes to the platform admin.

The quota table (`tenant_quotas`) is separate and out of scope for this design; the retention policy references its `max_telemetry_storage_gb` field as the source of truth.

## 9. Migration plan (Phase 1C)

1. Create `retention_policies` table (idempotent migration).
2. Backfill one default row per existing organization.
3. Install TimescaleDB extension on the VPS Postgres (one-time, requires brief downtime — coordinate with operator).
4. Convert `agent_metrics`, `probe_results`, `syslog_events` to hypertables (TimescaleDB `create_hypertable` with `migrate_data => true` for backfill).
5. Add continuous aggregates per §6.4.
6. Implement the retention job (one Python module + one Celery task or scheduler entry).
7. Add the Platform Admin UI page `/platform/retention` (depends on PANEL_SPLIT_DESIGN.md).
8. Soft-launch: jobs run in **dry-run mode** (count rows that WOULD be deleted, no actual delete) for 7 days.
9. Operator approval → enable real deletions.

Estimated total: 5-7 days focused work + 7-day soft-launch window.

## 10. Test plan (Phase 1C)

Backend (unit):
1. Policy validation: TTL bounds, plan-tier cap, legal-hold lock.
2. Retention job: idempotent on re-run with same batch id.
3. Retention job: cross-tenant safety (per-org RLS GUC held during processing).
4. Retention job: legal-hold skips `audit_logs` for that org only.
5. Aggregate-before-delete: skip-and-retry when aggregate is stale.
6. Archive failure: 3-retry then alert + abort.
7. Quota throttle: 80%/95%/100% transitions.
8. `retention_pruned_*` audit event emission.

Backend (integration):
9. End-to-end: seed an org with 100k synthetic `agent_metrics` rows older than retention; run job; assert hypertable chunk dropped + audit event emitted.

Frontend (jsdom):
10. Policy editor form validates TTLs.
11. Legal-hold toggle requires a confirmation modal + reason.
12. Quota dashboard renders the 80/95/100 thresholds correctly.

## 11. Risks & Mitigations

| Risk                                                                     | Mitigation                                                                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| R1 — Aggregate lag → silent data loss                                    | The job SKIPS delete + retries on aggregate lag. Operational metric: aggregate lag SLO.                                    |
| R2 — Cross-tenant data leak via retention job                            | Per-org RLS GUC for the duration of each block; unit test pins the contract (`test_retention_job_cross_tenant_safety`).    |
| R3 — Legal hold accidentally skipped                                     | Legal-hold check at the top of `audit_logs` branch; separate test (`test_legal_hold_blocks_audit_pruning`).                |
| R4 — TimescaleDB extension install requires downtime                     | Coordinate with operator; document expected ~5-10 min window; have a rollback plan that disables retention until extension is healthy. |
| R5 — Customer demands TTL longer than plan-tier cap                      | Plan-tier cap is enforced server-side; product team escalates to upsell or one-off override (`retention_policy_locked`).   |
| R6 — Disaster recovery: a botched policy edit deletes too much data      | Audit event + 7-day soft-launch + `policy_version` audit trail; any restore would come from backup, not from the policy.   |
| R7 — Operator confusion ("why did my data disappear?")                   | Platform Admin → Retention page shows projected-next-prune date per table per org; agents emit a banner when their org is < 7 days from a major pruning.|

## 12. Open Questions (for product review)

1. Plan-tier defaults: are the §5 values acceptable as starting points?
2. Quota: should `max_telemetry_storage_gb` be hard cap or soft (alert + bill)?
3. Archive destination: do we offer in-platform archive (cold storage on the VPS) or only external S3/Azure?
4. Legal hold: scope — `audit_logs` only or extends to `alerts` and `incidents` too?
5. Should retention TTLs be per-table or grouped by "raw / aggregated / event"?

## 13. Non-Goals

- This document does NOT implement the policy table, the job, or the UI page.
- This document does NOT install TimescaleDB on production.
- This document does NOT prune any production data.
- This document does NOT modify backend schemas.
- This document does NOT touch loc=9 / macm4 / movempic.

## 14. References

- `docs/design/PANEL_SPLIT_DESIGN.md` — companion design doc.
- `backend/app/core/rls.py` — existing RLS GUC pattern.
- `backend/app/core/org_context.py` — `set_org_context` for the retention job.
- `backend/app/api/v1/endpoints/context.py:130` — `/api/v1/context/organizations` (super-admin only).
- TimescaleDB documentation — `https://docs.timescale.com/`.
- PR #102 — backend cross-tenant guards.
- PR #103 — site-context hydration guard.
- PR #104 — DeviceForm location scope filter.
- PR #105 — X-Location-Id interceptor caller-respect.
