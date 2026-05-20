# Faz 9 — Carry-forward cleanup backlog

After M6 final-drop (commits `4db3220` + audit-RLS hotfix `0dda106`)
the legacy multi-tenancy layer is gone from the schema and code. These
five items are intentionally **non-blocking** carry-forward — they do
not affect correctness or production deploy — and should be picked up
in Faz 9 as a clean-up sweep, **not** during normal feature work.

Each item links the artifact that proves it's harmless today, plus a
note on the small change required to retire it.

---

## 1. `core/deps.py` no-op `TenantFilter` / `LocationFilter` / `LocationNameFilter` shims

**File:** [backend/app/core/deps.py:124-153](backend/app/core/deps.py#L124)

`get_tenant_context()`, `get_accessible_location_ids()`,
`get_accessible_location_names()` all unconditionally `return None` since
Faz 7 phase 4 (RLS supersedes them). The `Annotated`-type aliases on
lines 151-153 export them for callsites that haven't been swept.

**Why harmless today:** `tenant_filter` is always `None`, so every
endpoint's `if tenant_filter is not None:` branch is dead code — the
body is never executed at runtime. Module import is fine because
function bodies aren't evaluated at import time.

**Cleanup:** delete the 3 helpers + 3 aliases from `deps.py`, then sweep
the 15 endpoint files (listed in §2 below) for the `from app.core.deps
import … TenantFilter …` imports + parameter declarations.

## 2. Endpoint `if tenant_filter:` dead arms

After the §1 sweep, ~25 dead `if tenant_filter:` arms across these 13
files remain (their bodies reference `<Model>.tenant_id` which no longer
exists — Python only evaluates them at call time, and the conditional
is permanently False so they never run):

  * [backend/app/api/v1/endpoints/playbooks.py](backend/app/api/v1/endpoints/playbooks.py) — 2 sites
  * [backend/app/api/v1/endpoints/tasks.py](backend/app/api/v1/endpoints/tasks.py) — 2 sites
  * [backend/app/api/v1/endpoints/approvals.py](backend/app/api/v1/endpoints/approvals.py) — 2 sites
  * [backend/app/api/v1/endpoints/change_rollouts.py](backend/app/api/v1/endpoints/change_rollouts.py) — 2 sites
  * [backend/app/api/v1/endpoints/dashboard.py](backend/app/api/v1/endpoints/dashboard.py) — 4 sites
  * [backend/app/api/v1/endpoints/alert_rules.py](backend/app/api/v1/endpoints/alert_rules.py) — 2 sites
  * [backend/app/api/v1/endpoints/ipam.py](backend/app/api/v1/endpoints/ipam.py) — 3 sites
  * [backend/app/api/v1/endpoints/reports.py](backend/app/api/v1/endpoints/reports.py) — 2 sites
  * [backend/app/api/v1/endpoints/agents.py](backend/app/api/v1/endpoints/agents.py) — 2 sites
  * [backend/app/api/v1/endpoints/backup_schedules.py](backend/app/api/v1/endpoints/backup_schedules.py) — 4 sites (gated by `hasattr` + `tf`)
  * [backend/app/api/v1/endpoints/mac_arp.py](backend/app/api/v1/endpoints/mac_arp.py) — 1 raw-SQL `dm.tenant_id = :tenant_id` predicate (the column is gone; predicate never adds)
  * [backend/app/api/v1/endpoints/monitor.py](backend/app/api/v1/endpoints/monitor.py)
  * [backend/app/api/v1/endpoints/security_audit.py](backend/app/api/v1/endpoints/security_audit.py) / [intelligence.py](backend/app/api/v1/endpoints/intelligence.py) / [sla.py](backend/app/api/v1/endpoints/sla.py)

**Cleanup:** delete each `if tenant_filter:` block AND drop the
`tenant_filter: TenantFilter = None` (or `LocationNameFilter`) parameter
from the endpoint signature.

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

## 5. TopologyV2 / vitest TS baseline

**Files:** `frontend/src/pages/TopologyV2/**/*.ts(x)` +
`frontend/src/pages/TopologyV2/__tests__/*.test.ts` +
`frontend/src/hooks/__tests__/useEventStream.test.ts`

96 TS errors at production build (pre-M6 = post-M6 = 96, unchanged).
All stem from missing dev-deps:

  * `graphology`, `graphology-layout-forceatlas2`, `sigma`,
    `@react-three/fiber`, `three` — UI-engine deps not installed
  * `vitest` types not exposed to TS — the runtime works (33 tests
    pass) but the static type-check fails on `import { describe, it } from "vitest"`

**Why harmless today:** the running app does not load TopologyV2 (the
"Final Gold Release" topology rework is a separate deferred plan); the
errors only affect `tsc`/build output but the actual JS bundle is
produced because Vite's esbuild step is more lenient than `tsc`. `npm
run build` still emits a deployable bundle.

**Cleanup:** install the 5 missing UI deps + vitest types (or stub them
behind a `// @ts-expect-error` until TopologyV2 ships). Independent of
M6.

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

1. **§3 super-admin aliases + SuperAdmin page rewrite** — biggest user-
   visible cleanup, frees the `tenantsApi` shim and the legacy keys.
2. **§5 TopologyV2 deps** — clears the noisy build output so future TS
   regressions stand out.
3. **§1 + §2 deps.py shims + endpoint sweep** — purely server-side,
   ~25 site sweep, can be batched across 2-3 PRs.
4. **§6 agent_bridge startup race** — tiny `depends_on` + retry change;
   bundle with any other compose/lifespan work.
5. **§4 cache warmer loop** — small, do alongside other Redis work.

None of these block production deploy. All of them remove ~250-450 LOC
of legacy plumbing once done.
