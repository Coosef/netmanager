# T8.3 — Browser Performance Refresh: Measurement Plan

> **Status:** Plan / review-gate. No code yet. Approve before T8.3.A starts.
> **Branch:** `topology-gold/T8.3-browser-perf`
> **Predecessors:** T8.1 architecture audit (`docs/TOPOLOGY_T8_1_ARCHITECTURE_AUDIT.md`),
> T8.2 engine separation (commit `657d2b3`).
> **Principle (user-locked):** *measure before optimize*. T8.3 first half
> is **pure measurement** — no code optimisation, no behaviour change.

---

## 1. Why we can't just re-run T7

T7's scale results (`docs/TOPOLOGY_FINAL_GOLD_RELEASE_PLAN.md` §9) measured
the **main-thread pipeline in Node** — pure stages like
`buildTopologyModel`, `applyClusterView`, `diffAndPatch`. Each stayed
under 30 ms at 5k. That confirmed the **logic side** scales; it did **not**
measure:

  * actual browser FPS during pan / zoom (Sigma WebGL render),
  * GC pause distribution under sustained load,
  * the FA2 Web-Worker's busy-time fraction,
  * React re-render counts during incremental patches,
  * three.js InstancedMesh draw-call count,
  * long-task distribution during a WS event flood,
  * memory growth + retention over a 10-minute fullscreen NOC session.

Any of these can be the real bottleneck even with the Node pipeline at
< 30 ms — they're GPU-bound, scheduler-bound, or memory-bound, not
CPU-pipeline-bound.

## 2. Approach — three layered pieces

### 2.1 Synthetic stress mode (in-app)

A **dev-only query-param escape hatch** on `/topology-next` that, instead
of fetching `/topology/graph?v=2`, builds the graph from the existing
`syntheticGraph.ts` generator. Two parameters:

  * `?stress=N`       — graph size (1000, 2500, 5000, 10000)
  * `?scenario=NAME`  — drives a scripted user action sequence
    (`cold`, `warm`, `flood`, `noc`, `filter`, `cluster`)

Production behaviour is unchanged. The path is guarded by
`import.meta.env.DEV || (URL has ?perf=1)`. The generator is already
test-only code (no production reference). No new dependency.

### 2.2 In-app perf overlay

A **dev-only `<PerfOverlay>` component** (visible only with `?perf=1`)
showing live:

  * FPS (rolling 1 s window)
  * `performance.memory.usedJSHeapSize` (when available — Chrome only)
  * Long-task count (PerformanceObserver, `longtask` entry type)
  * Sigma reported `framesPerSecond` + per-frame render-call count

Operator-debuggable; the same overlay is read by the headless harness
through DOM scraping so we have one source of truth for the FPS numbers.

### 2.3 Headless Playwright benchmark harness

A new `frontend/perf/` directory with **Playwright** (new dev-dep) and a
Chrome DevTools Protocol bridge. One spec per scenario; each spec:

  * launches a real headless Chromium
  * navigates to `http://localhost:5173/topology-next?stress=N&scenario=…&perf=1`
  * starts Chrome's `Performance.enable` + `Memory.startSampling`
  * drives a scripted user-action sequence (pan, zoom, cluster expand,
    WS event injection, fullscreen toggle, etc.)
  * harvests:
      - average + p95 frame time (from `LayoutShift` / paint timing)
      - long-task count + total long-task duration
      - heap peak + final
      - GC events (`Memory.collectGarbage` + timeline samples)
      - WebGL draw calls (Sigma reports + r3f instanced-mesh counters)
      - React render count (via `<Profiler>` exposed on window for the
        harness — DEV-only, no production weight)
  * writes a `perf/results/<scenario>-<size>.json` artifact

Headless ⇒ reproducible; CI-runnable; no manual button-clicking.

## 3. Scenarios (the six the user named)

| Scenario | Drives | What it stresses |
|---|---|---|
| **cold-boot** | initial load → first paint → graph rendered | Build + layout + initial draw budget |
| **warm-cache** | re-mount with cached query data | TTFB-equivalent + reattach speed |
| **ws-patch-flood** | inject 100 `topology_node_updated` events @ 50ms intervals | Patch + invalidation + React re-render storm |
| **fullscreen-noc** | sustained 10-minute fullscreen pan | GC distribution + memory growth + sustained FPS |
| **filter-switch** | toggle layer / vendor / status filters in sequence | Rebind + visible-set recompute |
| **cluster-expand-collapse** | cluster collapse → expand → collapse cycle | Cluster view derivation + position interpolation |

Each runs against four sizes — **1k, 2.5k, 5k, 10k** — totalling **24** measurement matrix cells.

## 4. Metrics captured (per cell)

| Metric | Source | Target / Gate |
|---|---|---|
| avg FPS | Sigma `framesPerSecond` + paint timing | ≥ 30 FPS @ 5k (prod gate) |
| p95 frame time | paint timing rolling histogram | < 33 ms @ 5k |
| Longest task | PerformanceObserver longtask | < 200 ms / 30 s |
| Total long-task duration / 30 s | PerformanceObserver longtask sum | < 200 ms / 30 s (prod gate) |
| Heap peak | `performance.memory.usedJSHeapSize` max | < 1 GB @ 5k (prod gate) |
| GC pauses (count + max) | Memory timeline samples | report only |
| React render count | React Profiler exposed callback | "incremental patch → small subtree" |
| WebGL draw calls | Sigma reporter + r3f instancedMesh count | report only |

## 5. Output — the T8.3.D baseline profile report

A new `docs/TOPOLOGY_T8_3_BASELINE_PROFILE.md` aggregating every cell:

  * **One table per scenario** — rows = 1k / 2.5k / 5k / 10k, columns =
    the 8 metrics above. Cells colour-tagged against the gates.
  * **Hotspot ranking** — top-5 metric/scenario/size combinations
    that exceed the gate (or come closest). This is the **direct input
    to T8.3.E optimisation**.
  * **Per-stage profile** — `Performance.getCategories` flame extracted
    for the worst hotspot, listed by function for cross-reference
    against the engine modules from T8.1's architecture map.

No optimisation work happens in T8.3 first half — the report is the
deliverable. T8.3.E (second half) consumes this report and addresses
the ranked hotspots one by one, with a re-run of the harness after
each change to detect regressions.

## 6. Regression guard (user-locked)

After every optimisation in T8.3.E, **the harness must show**:

  * the targeted metric improved (otherwise the change is reverted),
  * **no other metric regressed by > 10 %**,
  * existing `vitest run TopologyV2` is unchanged (132 / 132),
  * `tsc` 0 errors, `npm run build` succeeds,
  * the T8.2 patch-merge invariant holds — `patch.ts` is still the only
    file in the engine that calls `graph.addNode` / `dropNode` /
    `addEdgeWithKey`,
  * the T8.2 scope guard still rejects cross-org events (run the
    `cross-org event is rejected as ignored_scope_mismatch` test as a
    smoke after every change).

## 7. T8.3 Phased breakdown

Approve sub-phase boundaries up front so we don't drift into a single
mega-commit:

  * **T8.3.0** *(this doc)* — measurement plan + scope review-gate.
  * **T8.3.A** — synthetic stress mode + `<PerfOverlay>` component. Pure
    dev-only additions. Behaviour unchanged for the real `/topology-next`
    route. Commit + verify.
  * **T8.3.B** — Playwright dev-dep + harness skeleton + **one** spec
    (`cold-boot @ 1k`) end-to-end as a working example. Commit + verify.
  * **T8.3.C** — the remaining 23 cells (5 scenarios × 4 sizes plus
    cold-boot's other 3 sizes). Commit + verify.
  * **T8.3.D** — `docs/TOPOLOGY_T8_3_BASELINE_PROFILE.md` aggregated
    from `perf/results/*.json`, including hotspot ranking. Commit.

**No T8.3.E in this branch.** Optimisation lives in
`topology-gold/T8.3-perf-optimization` (or numbered sub-branches) after
T8.3.D lands and is reviewed.

## 8. New dependencies

  * **Playwright** (`@playwright/test`) — dev-dependency, no production
    bundle impact. Pinned to a specific minor.
  * No other deps; no React-test-library; no Storybook.

## 9. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Headless Chrome != real Chrome on user hardware | Harness reports relative ranking — gates use the same Chromium across runs; user can re-run on their own hardware via the same spec |
| Synthetic graph doesn't model real-world layer mix | `syntheticGraph.ts` is already calibrated against the T7 production-mimicking fixture; we'll spot-check ratios in T8.3.A |
| Perf overlay leaks to production | Gated by `import.meta.env.DEV || ?perf=1` — overlay tree-shakes in prod build; verify in T8.3.A by grepping the prod bundle |
| Playwright run time grows with the matrix | Each cell budgeted at 30 s; full 24-cell run ≈ 12 min; OK for CI |
| Misleading numbers from a single run | Each cell runs **3 times** by default; report the median + variance |

---

## 10. Decisions needed before T8.3.A starts

1. **Playwright OK as new dev-dep?**
2. **Headless Chromium acceptable** as the canonical measurement
   environment (vs. the user's actual Chrome session)? Harness reports
   relative numbers; absolute gates can be re-validated on demand in
   the user's session.
3. **Synthetic graph as the load source** (vs. a frozen real-prod dump)?
   The generator is parameterised over size + cluster mix and is already
   used in T7; a real-prod dump would require a stable snapshot file
   in the repo.
4. **No optimisation in this branch** — confirmed?

## 11. Decisions — approved 2026-05-21

| # | Decision | Implication |
|---|---|---|
| 1 | **Playwright** approved as pinned `@playwright/test` dev-dep | T8.3.B installs and pins one minor; lockfile updated; no prod bundle impact |
| 2 | **Both** headless + user-hardware validate | Headless drives the matrix + hotspot ranking; the **same** in-app `<PerfOverlay>` is also visible in the user's real Chrome session so the same numbers can be eyeballed for spot-check validation. The harness writes `media: 'headless'`; manual spot-checks are recorded as `media: 'user-hw'` in the same JSON shape |
| 3 | **Both** synthetic + small prod-shape dump | Primary matrix = synthetic 1k / 2.5k / 5k / 10k. Plus **one** prod-shape reference cell using a JSON snapshot exported from the **local docker stack** (`/topology/graph?v=2`, ~63 devices, 2 orgs) — checked into the repo at `frontend/perf/fixtures/prod-shape-small.json`. The VPS is currently pinned to `eb7710a` / `d5e6f7a8b9c0` so it has no v=2 contract; lokal docker is the only v=2-shape source today. The reference cell catches synthetic-vs-real mismatches even at a small size |
| 4 | **Pure measurement** in this branch — confirmed | T8.3.A/B/C/D = harness + report only. Optimisation lives in `topology-gold/T8.3-perf-optimization` (or sub-branches), opened only after T8.3.D is reviewed |

### 11.1 Edge cases the decisions surface

  * The prod-shape dump is **63 nodes** — far below the matrix sizes.
    It is not a benchmark cell; it is a **realism reference** to detect
    "the synthetic graph is wrong" before drawing conclusions from the
    1k+ runs. If a metric on prod-shape is wildly out of trend with
    synthetic 1k, T8.3.A's syntheticGraph calibration is suspect.
  * The "in-app perf overlay seen in both headless and user-Chrome"
    invariant means the overlay must be reachable via URL param in
    production builds too — strictly `?perf=1` opt-in, never auto-on.
    Production users who don't append the param see nothing new.

## 12. T8.3.A — what we'll do next

Stub of the next deliverable so the user can sanity-check before code:

  * `src/pages/TopologyV2/__perfdev__/stressLoader.ts` — picks up
    `?stress=N&scenario=…` from the URL, synthesises a v=2 graph via
    `__tests__/syntheticGraph.ts`, and returns it instead of the API
    fetch. Guarded by `import.meta.env.DEV || hasQueryParam('perf')`.
  * `src/pages/TopologyV2/__perfdev__/PerfOverlay.tsx` — rolling FPS,
    heap, long-task count, Sigma reported render count. Position:
    bottom-right corner. Visible only with `?perf=1`.
  * `frontend/perf/fixtures/prod-shape-small.json` — exported from the
    local docker stack with a small Python script that calls
    `/api/v1/topology/graph?v=2` with the admin token and saves the
    response. Checked into the repo. ~50 KB.
  * Wiring in `src/pages/TopologyV2/index.tsx` — the perf loader has
    priority over `useTopologyGraphV2()` when the URL param is set;
    otherwise the page uses the real API hook unchanged.

Verify: vitest 132 / 132, tsc 0, `npm run build` exit 0, `?stress=1000`
on the local dev server renders the synthetic graph, default
`/topology-next` still hits the real API.
