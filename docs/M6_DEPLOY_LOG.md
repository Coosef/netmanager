# M6 Final-Drop Production Deploy Log

**Cutover date:** 2026-05-20
**Branch:** `feature/faz8-isolation-hardening`
**Alembic head after deploy:** `f8a6auditpermissivewrites`
**Closing commit:** `0dda106` (audit-RLS hotfix)
**M6 S4 destructive drop commit:** `4db3220`

## Pre-deploy rollback anchors

| Anchor               | Value                                                                  |
|----------------------|------------------------------------------------------------------------|
| Last pre-M6 commit   | `2df82d7` (`chore(m6/s2): feature-flag legacy /tenants UI`)            |
| M6 destructive drop  | `4db3220` (`refactor(m6/s4): destructive drop — retire legacy Tenant`) |
| Audit-RLS hotfix     | `0dda106` (`fix(audit-rls): unblock pre-auth + just-post-auth audit writes`) |
| DB backup            | `backups/pre-m6-production-deploy-20260520T123727Z.sql.gz` (18 MB)     |
| Backup SHA-256       | `17235c13453dc5d20a2d475c06c824ad6386593a141209133c0b5282356e2dca`     |

To roll back to the pre-M6 schema, restore the backup AND check out
`2df82d7`. Roll-forward downgrade is "recreate-empty-schema" only —
real row data recovery requires the backup.

## Checklist results

| # | Step                                                                        | Result | Notes |
|---|-----------------------------------------------------------------------------|--------|-------|
| 1 | Full DB `pg_dump` backup taken                                              | ✅ pass | 18 MB compressed, SHA-256 logged above. |
| 2 | `alembic current` matches expected head                                     | ✅ pass | `f8a6auditpermissivewrites (head)`. |
| 3 | Backend container boots clean post-restart                                  | ✅ pass | Uvicorn "Application startup complete"; healthcheck green. |
| 4 | OpenAPI `/api/v1/tenants` purged                                            | ✅ pass | 285 paths total, 0 containing `tenants`. |
| 5 | Super-admin auth round-trip (login + system-stats + orgs?with_counts=true)  | ✅ pass | After f8a6 hotfix — see "Audit-RLS deploy blocker" below. |
| 6 | Frontend production build error count = baseline                            | ✅ pass | 96 errors, all pre-existing TopologyV2/missing-dep baseline; 0 M6-induced. |
| 7 | Backend pytest                                                              | ✅ pass | 602 passed (baseline 604 minus 2 dropped `tenant_id`-arg tests). |
| 8 | Rollback SHA + backup path logged                                           | ✅ pass | This document. |

## Audit-RLS deploy blocker — found + fixed during this checklist

During step 5 the authed super-admin round-trip surfaced a 500 against
`/api/v1/auth/login` (both wrong-pw and right-pw paths). Investigation
showed a **pre-existing Faz 7 phase 6c bug** in the `audit_logs` RLS
layer — not caused by M6 but invisible to the SQLite-backed test suite.
Both audit-write call paths (`login_failed` with NULL org, and `login`
success with `org_id` set but no GUC yet) were rejected by an
`INSERT … RETURNING audit_logs.id` re-check through the strict USING
clause.

Fix shipped as commit `0dda106`:

* migration `f8a6_audit_logs_permissive_writes` — USING stays strict
  (read isolation = unchanged), WITH CHECK relaxed to `true` (writes
  trusted from server-side `audit_service.log_action`);
* `audit_service.log_action` — write via raw `text()` INSERT with no
  RETURNING, per-dialect bindparam types so SQLite tests still pass.

Threat model reviewed in the commit body. Read isolation — the actual
confidentiality boundary — is unchanged: org A still cannot SELECT org
B's audit rows.

## Post-deploy smoke

Captured immediately after `f8a6` upgrade:

```
POST /api/v1/auth/login  (wrong pw)  → 401 + audit row (NULL org)
POST /api/v1/auth/login  (good pw)   → 200 + audit row (org_id=1)
GET  /api/v1/super-admin/system-stats
  organizations.total=2 active=2
  users.total=4 devices.total=63 locations.total=4
  legacy alias `tenants` still present (kept for one release)

GET  /api/v1/super-admin/orgs?with_counts=true
  total=2 returned=2
  org#1 'Varsayılan Organizasyon' status=active devs=63 usrs=2 locs=3 plan=free
  org#2 'Test Şubesi'             status=active devs=0  usrs=2 locs=1 plan=free
```

## Production deploy procedure (for the actual cutover)

1. **Snapshot** the prod DB:
   `pg_dump -U <prod_user> -d <prod_db> | gzip > backups/prod-pre-m6-<UTC>.sql.gz`
2. Verify backup integrity (file size, optional restore-to-staging test).
3. Pull the merged branch on the prod box.
4. `alembic upgrade head` — runs `f8a5droplegacytenant` + `f8a6auditpermissivewrites`.
5. Restart `backend`, `celery_worker`, `event_consumer`.
6. Verify `/health` → 200, no `Tenant` references in logs, no
   `InsufficientPrivilegeError` after a wrong-pw login probe.
7. Deploy frontend bundle.
8. Run the 8-step checklist above against the live prod environment.

## Rollback procedure (last resort)

1. Stop `backend` + `celery_worker` + `event_consumer`.
2. `alembic downgrade f8a4orgmgmt` — drops back through f8a6+f8a5.
3. Restore the pre-deploy `pg_dump` backup over the now-empty schema.
4. `git checkout 2df82d7` (M6-S2 — last green pre-destructive commit).
5. Restart services.

The downgrade is "recreate-empty-schema": running it after a real cut-
over without restoring the backup leaves the DB with empty
`tenants`/`tenant_id` columns + dropped `users.role` rows — code boots
but production data is gone. The backup restore is the actual rollback.
