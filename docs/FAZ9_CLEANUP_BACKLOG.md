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

## 4. Cache warmer dormant `agg:dirty:tenant` references  — ✅ closed 2026-05-21 (Faz 9 #4)

**Files:**
  * [backend/app/workers/tasks/cache_warmer_tasks.py](backend/app/workers/tasks/cache_warmer_tasks.py)
  * [backend/tests/test_faz6b_cache_warmer.py](backend/tests/test_faz6b_cache_warmer.py)

Was: the warmer still snapshotted `agg:dirty:tenant` every cycle, ran
through `build_warm_targets(dirty_tenants)` to spawn per-tenant
sla/risk targets, and called `_tenant_fully_warmed()` to SREM members
on success. The SADD source feeding this set was removed in M6 final
drop, so the set was perpetually empty — the loop iterated zero
members each 60 s but the code stayed.

**Closure (Faz 9 #4):**

  * `build_warm_targets()` is now a no-arg helper that returns the
    stable `["sla", "risk"]` no-filter pair. The per-tenant expansion
    (and `_tenant_fully_warmed`) are gone.
  * `_warm_target()` lost its `tenant_id` parameter. Both call sites
    pass `None` to the still-positional helpers
    `fleet_summary_cache_key` / `fleet_risk_cache_key` (Faz 9 #3
    keeps these signatures for code locality; matches what the
    endpoints themselves do).
  * `_run_warm()` no longer reads `agg:dirty:tenant` or SREMs from
    it; it only snapshots `agg:dirty:device` and drains those markers
    when both no-filter caches confirm warm.
  * `_cleanup_legacy_keys()` runs a best-effort `DEL agg:dirty:tenant`
    on every warm cycle — idempotent on empty/missing sets, cheap
    enough to leave in indefinitely, and guarantees a Redis instance
    that lived through the M6 upgrade clears any stragglers.
  * Concurrency bound lowered from `Semaphore(5)` to `Semaphore(2)`
    (only two targets exist now; the larger bound was sized for the
    per-tenant fan-out).

**Verification:**

  * Warmer pytest: **15 / 15** (was 17 — removed 7 per-tenant tests,
    added 5 no-filter + cleanup tests + 1 net helper test = 15)
  * Full backend pytest: **600 / 600** (delta -2 from 602 is the net
    test-count change above)
  * Live cycle on the local stack with a seeded
    `SADD agg:dirty:tenant 7 9 42`:
      → warmer returned `status: ok, warmed: 2, errors: 0`
      → `EXISTS agg:dirty:tenant` → `0` (drained)
  * Cache warmer steady-state behaviour (no-dirty) is unchanged
    apart from the structural code simplification.

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

## 6. `agent_bridge` startup-race noise  — ✅ closed 2026-05-21 (Faz 9 #6)

**Files:**
  * [backend/app/services/agent_bridge.py](backend/app/services/agent_bridge.py)
  * [backend/app/main.py](backend/app/main.py)

Was: lifespan startup synchronously called `agent_bridge_listener.start(...)`.
If Redis was not yet resolvable at that moment, the try/except
swallowed the failure as `"startup: agent_bridge failed to start
(non-fatal)"` with full `exc_info`. The bridge then stayed dormant for
the lifetime of that backend process — Celery→agent command relay
silently didn't work until the next restart.

**Closure (Faz 9 #6):** `AgentBridgeListener.start()` now schedules a
background retry-on-failure connector task (`bg:agent_bridge_startup`)
that loops over `psubscribe` with exponential backoff (2 → 4 → 8 → 16
→ 30 s cap), at log levels INFO (first miss), WARNING (after 5
consecutive failures), INFO (when subscribe finally succeeds with
attempt count). `start()` itself returns immediately so backend boot
is never blocked. `stop()` cancels both the startup task and the
listen task — `docker compose stop` during a retry loop closes
cleanly with no orphan-task warnings.

Verified scenarios:

  A. Redis up at boot      → single `bridge: listener started, …` log
  B. Redis down at boot    → `bridge: redis not ready yet, retrying`
                             (INFO), backend boot still "Application
                             startup complete"; bridge keeps retrying
                             in background
  C. Redis up mid-flight   → bridge auto-recovers with
                             `bridge: listener started after N attempts`
                             (INFO)
  D. Shutdown during retry → clean `bridge: listener stopped`, no
                             orphan tasks

Out of scope and noted for a future item: the existing `_listen_loop`
crashes at ERROR on Redis disconnect mid-process (`bridge: listen_loop
crashed unexpectedly`); reconnection there would need a different
retry pattern (cancel-and-reschedule from inside the loop's exception
handler). Not covered here.

Added 2026-05-20 from the M6 production-readiness check; closed in
the next sweep.

---

## Suggested ordering for Faz 9

1. ~~**§3 super-admin aliases + SuperAdmin page rewrite**~~ — ✅ closed
   2026-05-20 (Faz 9 #1 / commit `75eef03`).
2. ~~**§5 TopologyV2 deps**~~ — ✅ closed 2026-05-21 (Faz 9 #2). One
   `npm install` zeroed the 96-error TS baseline.
3. ~~**§1 + §2 deps.py shims + endpoint sweep**~~ — ✅ closed 2026-05-21
   (Faz 9 #3 / commits `a7f1b47` + `45be55e`). Touch surface turned out
   to be ~391 in-body uses across 18 files, not ~25; net **-516 LOC**.
4. ~~**§6 agent_bridge startup race**~~ — ✅ closed 2026-05-21 (Faz 9 #6).
   Retry-on-failure connector task replaces the one-shot startup; four
   redis-up / redis-down / mid-recovery / shutdown scenarios verified
   clean.
5. ~~**§4 cache warmer loop**~~ — ✅ closed 2026-05-21 (Faz 9 #4). Per-
   tenant warm path retired; warmer now keeps the two no-filter fleet
   caches warm and best-effort drains the legacy `agg:dirty:tenant`
   set each cycle. Live-verified on the local stack.

**All six Faz 9 cleanup items closed.** Total impact: ~700 LOC of
legacy plumbing removed across 4 commits worth of cleanup, plus the
TopologyV2 baseline + agent_bridge resilience improvements.
