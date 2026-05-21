# Faz 9 — Carry-forward cleanup backlog

After M6 final-drop (commits `4db3220` + audit-RLS hotfix `0dda106`)
the legacy multi-tenancy layer is gone from the schema and code. These
five items are intentionally **non-blocking** carry-forward — they do
not affect correctness or production deploy — and should be picked up
in Faz 9 as a clean-up sweep, **not** during normal feature work.

Each item links the artifact that proves it's harmless today, plus a
note on the small change required to retire it.

---

## 1. `core/deps.py` no-op `TenantFilter` / `LocationFilter` / `LocationNameFilter` shims  — ✅ closed 2026-05-21 (Faz 9 #3a)

**File:** [backend/app/core/deps.py](backend/app/core/deps.py)

The 3 always-None helpers (`get_tenant_context` / `get_accessible_location_ids`
/ `get_accessible_location_names`) and their 3 `Annotated`-type aliases
(`TenantFilter` / `LocationFilter` / `LocationNameFilter`) have been
removed. RLS at the DB layer fully supersedes the legacy app-level
tenant + location filtering — the shims had zero behavioural effect.

Landed in commit `45be55e` (`refactor(faz9/03a): drop deps.py no-op
TenantFilter / LocationFilter / LocationNameFilter shims`) after the
endpoint sweep (Phase B / §2) cleared every importer.

## 2. Endpoint `if tenant_filter:` dead arms  — ✅ closed 2026-05-21 (Faz 9 #3b)

Was: ~25 dead `if tenant_filter:` arms across 13 endpoint files; the
actual surface turned out to be ~391 in-body uses across 18 files
(parameter declarations + guard blocks + helper-positional-args
+ orphan elif/else clauses).

Landed in commit `a7f1b47` (`refactor(faz9/03b): sweep dead
tenant_filter / location_filter branches in 18 endpoints`):

  * 18 files: agents, alert_rules, approvals, asset_lifecycle,
    change_rollouts, dashboard, devices, intelligence, ipam, mac_arp,
    monitor, playbooks, racks, reports, security_audit, sla, snmp, tasks
  * **-516 LOC net** (+113 / -629)
  * Dead `tenant_filter: TenantFilter = None` and
    `location_filter: LocationNameFilter = None` parameters dropped
  * Dead `if … is not None:` guard bodies removed
  * Helper positional args (`_get_or_404`, `_get_agent_scoped`) cleaned
    + all callsites updated
  * Cache-key helpers in `sla.py` / `intelligence.py` keep their
    signatures (still called from the dormant `cache_warmer_tasks.py`
    per-tenant loop — §4 territory) but endpoint callsites now pass
    `None, None`
  * Orphan `elif site:` / `else:` clauses left dangling by the sweep
    were rewritten to plain `if site:` or direct body
  * `TenantFilter` / `LocationNameFilter` removed from every
    `from app.core.deps import …` line

Verification:
  * `python3 -m ast.parse` ✓ on all 18 files
  * Pytest 602 / 602 ✅
  * OpenAPI: 285 / 285 paths unchanged, zero params removed (FastAPI
    dependency-injected params don't appear in the schema)
  * Live authed smoke against 19 representative endpoints: zero 5xx

## 3. Super-admin response back-compat aliases

**File:** [backend/app/api/v1/endpoints/super_admin.py](backend/app/api/v1/endpoints/super_admin.py)

`/super-admin/system-stats`, `/super-admin/resources/devices`,
`/super-admin/resources/agents`, `/super-admin/resources/assign`,
`/super-admin/users/{id}` still emit legacy JSON keys
(`tenants` / `tenant_id` / `tenant_name` / `top_tenants_by_devices`)
alongside the new `organizations` / `org_id` / `org_name`. The
SuperAdmin dashboard reads the legacy keys; the next-major frontend
rework reads the new keys.

**Why harmless today:** clients can use either set; the underlying data
is the same org-sourced rows. Roughly +50 LOC of duplicated keys.

**Cleanup:** drop the `tenants` / `tenant_id` / `tenant_name` keys from
every super-admin response; cut over `frontend/src/api/tenants.ts` to
delete the shim and have `frontend/src/pages/SuperAdmin/index.tsx`
consume `superadminApi.listOrgs({ with_counts: true })` directly.

## 4. Cache warmer dormant `agg:dirty:tenant` references

**Files:**
  * [backend/app/workers/tasks/cache_warmer_tasks.py](backend/app/workers/tasks/cache_warmer_tasks.py)
  * [backend/app/services/cache_invalidation.py](backend/app/services/cache_invalidation.py) (already cleaned in M6-S4)

The warmer still has a per-tenant `SCAN agg:dirty:tenant` loop, but the
SADD source that fed it was removed in M6-S4. The set never grows, so
the loop iterates zero members every 60 s. The constant string
reference is in the warmer code path.

**Why harmless today:** dead Redis SCAN over an empty set is a no-op.

**Cleanup:** remove the per-tenant loop block + the `agg:dirty:tenant`
constant; keep only the per-device dirty-set warming.

## 5. TopologyV2 / vitest TS baseline  — ✅ closed 2026-05-21 (Faz 9 #2)

**Files:** `frontend/src/pages/TopologyV2/**/*.ts(x)` +
`frontend/src/pages/TopologyV2/__tests__/*.test.ts` +
`frontend/src/hooks/__tests__/useEventStream.test.ts`

Was: 96 TS errors at production build, all cascading from missing
modules — `graphology`, `graphology-layout-forceatlas2`, `sigma`,
`@react-three/fiber`, `@react-three/drei`, `vitest`.

**Root cause:** the packages were already declared in `package.json`
and frozen in `package-lock.json`; only `node_modules/` was stale.
Most likely cause: after the TD-1 lockfile regenerate (commit
`f3c5e8d`), the new lockfile resolved but the actual dep tree never
landed on disk.

**Closure (Faz 9 #2):** ran `npm install` — populated 115 packages
from the existing lockfile. Zero code changes were needed. Result:

  * `tsc --noEmit`        96 errors → **0 errors**
  * `npm run build`       exit 0, dist/index-*.js produced (6.8 MB)
  * `vitest run`          33 / 33 → **103 / 103** (the 6 previously
                          file-load-failing test files now run, +70
                          tests freshly passing)
  * backend pytest        unchanged at 602 / 602

**Dev-onboarding follow-up:** the failure mode (lockfile complete +
node_modules empty → 96 TS errors that vanish on `npm install`) is a
trap for new contributors. Worth a one-liner in the frontend README
("after pull, `npm install` is mandatory — the lockfile alone does
not provision node_modules"). Tracked informally; not a separate
backlog item.

## 6. `agent_bridge` startup-race noise

**Files:**
  * [backend/app/main.py:712-718](backend/app/main.py#L712-L718)
  * [backend/app/services/agent_bridge.py](backend/app/services/agent_bridge.py)

Lifespan startup eagerly tries `agent_bridge_listener.start(...)` with
the Redis client. If Redis is not yet resolvable at that moment, the
try/except swallows the failure as
`"startup: agent_bridge failed to start (non-fatal)"` with full
`exc_info`. The bridge then stays stopped for the lifetime of that
backend process — Celery→agent command relay does not work until the
next restart.

**Why mostly harmless today:** in Docker Compose where Redis usually
starts before backend, this rarely fires; the M6 deploy-verification
turn caught it because Redis was deliberately stopped while we were
testing other paths and got started later. After the restart with
Redis up, the listener started cleanly:
`bridge: listener started, pattern=agent:bridge:cmd:*`. So the warning
is a startup-race symptom, not a persistent bug.

**Cleanup:** either
  * add explicit `depends_on: { redis: { condition: service_healthy } }`
    to the `backend` service in `docker-compose.yml` (clean for the
    common case), AND/OR
  * make `agent_bridge_listener.start` retry-on-failure with exponential
    backoff so a transient Redis unavailability at startup doesn't
    silently disable command relay for the rest of the process lifetime.

Added 2026-05-20 from the M6 production-readiness check.

---

## Suggested ordering for Faz 9

1. ~~**§3 super-admin aliases + SuperAdmin page rewrite**~~ — ✅ closed
   2026-05-20 (Faz 9 #1 / commit `75eef03`).
2. ~~**§5 TopologyV2 deps**~~ — ✅ closed 2026-05-21 (Faz 9 #2). One
   `npm install` zeroed the 96-error TS baseline.
3. ~~**§1 + §2 deps.py shims + endpoint sweep**~~ — ✅ closed 2026-05-21
   (Faz 9 #3 / commits `a7f1b47` + `45be55e`). Touch surface turned out
   to be ~391 in-body uses across 18 files, not ~25; net **-516 LOC**.
4. **§6 agent_bridge startup race** — tiny `depends_on` + retry change;
   bundle with any other compose/lifespan work. Next.
5. **§4 cache warmer loop** — small, do alongside other Redis work.

None of these block production deploy. Items #1–#3 closed (~600 LOC of
legacy plumbing removed). Items #4 (warmer dormancy) and #6 (bridge
startup) remain.
