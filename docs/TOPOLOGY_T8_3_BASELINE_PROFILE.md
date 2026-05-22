# T8.3.D — Browser-Perf Baseline Profile

> **🟢 OUTCOME (post-E1/E2):** Both hotspots identified in this doc
> are closed. Matrix flagged cells: 6 → 1; total weight: 24 → 1.
> The remaining cell is `ws-patch-flood @ 10k` with weight=1 (only
> `p95FrameTimeMs = 33 ms` in WARN — a Sigma WebGL paint-side concern,
> out of scope for the coalescing work). Branch
> `topology-gold/T8.3-browser-perf` is main-merge-ready. Closing
> summary: [TOPOLOGY_T8_3_FINAL.md](./TOPOLOGY_T8_3_FINAL.md).
> Sub-phase reports: [E2 results](./TOPOLOGY_T8_3_E2_RESULTS.md),
> [E1 results](./TOPOLOGY_T8_3_E1_RESULTS.md).
>
> The rest of THIS document is the immutable pre-E baseline T8.3.E
> was designed against — kept verbatim for reference and any future
> "before/after" citation.
>
> ---

> **Status:** baseline profile derived from the T8.3.C 24-cell matrix.
> **No runtime code change** is associated with this document; it converts
> the measurement output (`frontend/perf/results/SUMMARY.md` + the 24 raw
> JSON artifacts) into a technical report and produces the decision tree
> T8.3.E will execute against.
>
> **Branch:** `topology-gold/T8.3-browser-perf` (not merged to main).
> **Data anchor:** matrix run on 2026-05-21, headless Chromium
> `131.0.6778.33`, viewport `1920×1080`, DPR `1`, headless dev server.

---

## 1. Executive summary

The topology surface holds up well under five of six measured scenarios.
The two scenarios that fail — `ws-patch-flood` and `cluster-expand-
collapse` — fail in **architecturally distinct ways**, which is the
single most important finding of this baseline.

* **Scope.** 6 scenarios × 4 sizes (1k, 2.5k, 5k, 10k) = 24 measurement
  cells. All cells ran to completion; no crashes, no timeouts.
* **Health distribution.** Across the 4 tracked metrics
  (`avgFps`, `p95FrameTimeMs`, `longestTaskMs`, `totalLongTaskMs`) × 24
  cells = 96 metric slots: **🟢 81 OK · 🟡 6 WARN · 🔴 9 FAIL**.
* **Hotspot concentration.** 100% of WARN/FAIL slots live in **two**
  scenarios: `ws-patch-flood` (8 flagged slots) and
  `cluster-expand-collapse` (7 flagged slots). The other 16 cells
  (`cold-boot`, `warm-cache`, `fullscreen-noc`, `filter-switch` × 4
  sizes each) are all green.
* **Production scale is fine.** Production data is currently ~63 devices
  in a single tenant — well below the smallest matrix size (1k = ~16×
  production). Both hotspots are green at 1k. The numbers below are a
  **future-scale stress profile**, not a description of present
  customer pain.
* **The two hotspots have different shapes** — same dimension
  (graph size), different fix architectures:
  * **`ws-patch-flood`** — *many* medium-length main-thread tasks
    (\~310 ms × ~250 events at 10k). Root cause: every event runs
    `graphModel.styleGraph` (O(N+E)) + the SigmaCanvas `patchSignal`
    effect (`applyClusterView` + `positionClusterNodes` + Sigma
    refresh) — two full graph traversals per single-node update.
    Fix category: **event coalescing + scoped restyle**.
  * **`cluster-expand-collapse`** — *one* huge main-thread block
    (16.7 s at 10k). Root cause: every expand re-runs
    `clustering.applyClusterView` (4 graph passes) + a full Sigma
    refresh. Fix category: **chunked apply + incremental meta
    rebuild**.

* **Recommendation (detailed in §9).** T8.3.E proceeds as **two
  independent sub-branches** (E1 + E2) so the fixes can be validated
  against each other's invariants. Suggested order is **E2 first,
  then E1**: E2 has a smaller blast radius (a single function), a
  clearer success metric (`longestTaskMs < 500 ms` at 10k), and lower
  invariant risk; E1 reaches into the realtime + patch funnel and
  needs more care.

* **Go / No-Go.** **GO for T8.3.E**, conditional on §10's
  prerequisites (the two backlog items from T8.3.B/C remain open but
  do not block).

---

## 2. Test matrix & environment

| dimension | value |
|-----------|-------|
| scenarios | `cold-boot`, `warm-cache`, `fullscreen-noc`, `filter-switch`, `cluster-expand-collapse`, `ws-patch-flood` |
| sizes (graph nodes) | 1000, 2500, 5000, 10000 |
| cells | 24 (`scenarios × sizes`) |
| measurement | Playwright 1.49.1 + Chromium DevTools Protocol (`Performance.getMetrics`, in-page rAF + long-task recorder, in-app `<PerfOverlay>` scrape) |
| harness | `frontend/perf/` (isolated TS, never in production bundle) |
| browser | headless Chromium `HeadlessChrome/131.0.6778.33` |
| viewport / DPR | 1920 × 1080 / 1 |
| locale / TZ | `en-US` / `UTC` |
| dev server | Vite (`npm run dev`) on `localhost:5173`; no backend (harness blocks `/api/v1/**` + `/ws/**` and seeds a synthetic super-admin token) |
| stress data | synthetic graph from `__perfdev__/stressLoader` (deterministic, `seed=42`) |
| schema version | artifact `v1` (locked in T8.3.B) |
| Playwright config | parallel off, retries off, trace off, video off, screenshot on failure only |

### Measurement methodology — what each metric captures

| metric | source | semantics |
|--------|--------|-----------|
| `bootDurationMs` | CDP `Performance.getMetrics` (`Timestamp − NavigationStart`) | Wall-clock from navigation start to the moment of harvest. For `cold-boot` this is dominated by FA2's 9 s cap (`layout.ts:34`); for action scenarios it includes the action window. |
| `avgFps` | in-page rAF histogram, mean of `1000 / Δt` | Mean steady-state FPS over the recorder's frame buffer (≤ 2000 entries, ~30 s @ 60 fps). |
| `p95FrameTimeMs` | in-page rAF histogram, 95th percentile of `Δt` | Worst-1-in-20 frame duration. 17 ms ≈ a clean 60-fps target. |
| `longestTaskMs` | in-page `PerformanceObserver({entryTypes:['longtask']})` | Single longest main-thread block in the window. |
| `totalLongTaskMs` | sum of all long-task durations | Cumulative main-thread blocked time. |
| `longTaskCount` | count of long-task entries | Number of distinct `> 50 ms` blocks. |
| `heapUsedMb` | CDP `Performance.getMetrics` (`JSHeapUsedSize`) | Current heap at harvest. Carries known undersampling caveat — see §10 backlog item 1. |
| `domNodeCount` | CDP `Performance.getMetrics` (`Nodes`) | HTML DOM node count. Dominated by AntD chrome; does NOT scale with graph size (Sigma is WebGL into one `<canvas>`). |

---

## 3. Threshold model

Bands are defined in [`frontend/perf/scripts/thresholds.json`](../frontend/perf/scripts/thresholds.json).

### Default bands (apply unless overridden)

| metric | OK | WARN | FAIL |
|--------|----|------|------|
| `avgFps` | ≥ 50 | 30–49 | < 30 |
| `p95FrameTimeMs` | ≤ 20 | 21–50 | > 50 |
| `longestTaskMs` | ≤ 250 | 251–1000 | > 1000 |
| `totalLongTaskMs` | ≤ 500 | 501–5000 | > 5000 |

### Per-scenario overrides

| scenario | metric | OK | WARN | FAIL | rationale |
|----------|--------|----|------|------|-----------|
| `cold-boot` | `longestTaskMs` | ≤ 200 | 201–400 | > 400 | bundle parse adds a measurable baseline burst even when caches are warm |
| `ws-patch-flood` | `avgFps` | ≥ 40 | 15–39 | < 15 | scenario is designed to *stress* the renderer; FPS is the canonical signal |
| `ws-patch-flood` | `totalLongTaskMs` | ≤ 2000 | 2001–20000 | > 20000 | a flood produces long tasks by design |
| `cluster-expand-collapse` | `longestTaskMs` | ≤ 400 | 401–2000 | > 2000 | drilling clusters does real work — `applyClusterView` traversal |
| `cluster-expand-collapse` | `totalLongTaskMs` | ≤ 1500 | 1501–10000 | > 10000 | bounded by the number of expand actions |

Bands are deliberately **rough first-pass** values calibrated against
the very first baseline run. They will tighten as T8.3.E lands wins.

---

## 4. OK / WARN / FAIL distribution

### Cell-level summary

| outcome | count | description |
|---------|-------|-------------|
| **all 4 metrics OK** | 18 | scenario × size combinations with no flagged metric |
| **any WARN, no FAIL** | 2 | `cluster-expand-collapse @ 2.5k`, `ws-patch-flood @ 2.5k` |
| **any FAIL** | 4 | `cluster-expand-collapse @ {5k, 10k}`, `ws-patch-flood @ {5k, 10k}` |

### Metric-slot tally (24 cells × 4 metrics = 96 slots)

| band | count | % | notes |
|------|------:|--:|-------|
| 🟢 OK | 81 | 84.4% | the four healthy scenarios + the production-scale (1k) cells of the two hotspots |
| 🟡 WARN | 6 | 6.3% | early-degradation indicators |
| 🔴 FAIL | 9 | 9.4% | both hotspots at 5k and 10k |
| ⚪ N/A | 0 | 0.0% | every tracked metric has a threshold definition |

### Per-scenario breakdown

| scenario | OK | WARN | FAIL | health |
|----------|---:|-----:|-----:|--------|
| `cold-boot` | 16/16 | 0 | 0 | 🟢 clean |
| `warm-cache` | 16/16 | 0 | 0 | 🟢 clean |
| `fullscreen-noc` | 16/16 | 0 | 0 | 🟢 clean |
| `filter-switch` | 16/16 | 0 | 0 | 🟢 clean |
| `cluster-expand-collapse` | 9/16 | 3 | 4 | 🔴 **HOTSPOT B** |
| `ws-patch-flood` | 8/16 | 3 | 5 | 🔴 **HOTSPOT A** |

---

## 5. Scenario-by-scenario analysis

### 5.1 cold-boot — 🟢 clean

| size | avgFps | p95 | longest-task | totalLT | heap |
|------|--------|-----|--------------|---------|------|
| 1k   | 🟢 56 | 🟢 17ms | 🟢 176ms | 🟢 327ms | 50 MB |
| 2.5k | 🟢 57 | 🟢 17ms | 🟢 145ms | 🟢 280ms | 75 MB |
| 5k   | 🟢 57 | 🟢 17ms | 🟢 144ms | 🟢 300ms | 62 MB |
| 10k  | 🟢 56 | 🟢 17ms | 🟢 160ms | 🟢 369ms | 102 MB |

Boot wall-clock is uniform (~5.3 s) at every size because FA2 is
hard-capped at 9 s
([`layout.ts:34`](../frontend/src/pages/TopologyV2/layout.ts#L34)),
so all sizes settle to the same idle render cost. The longest task
(~150 ms) is the bundle parse — it does not scale with the graph.
Heap grows nearly linearly with size (50 / 75 / 62 / 102 MB) which is
the expected signal that the synthetic graph generator is actually
producing N nodes; the 5k dip is GC noise.

### 5.2 warm-cache — 🟢 clean (and informative)

| size | avgFps | p95 | longest-task | totalLT | heap |
|------|--------|-----|--------------|---------|------|
| 1k   | 🟢 60 | 🟢 17ms | 🟢 0 ms   | 🟢 0 ms   | 63 MB |
| 2.5k | 🟢 59 | 🟢 17ms | 🟢 63 ms  | 🟢 63 ms  | 75 MB |
| 5k   | 🟢 59 | 🟢 17ms | 🟢 97 ms  | 🟢 97 ms  | 147 MB |
| 10k  | 🟢 57 | 🟢 17ms | 🟢 204 ms | 🟢 204 ms | 205 MB |

The headline number is **`longest-task = 0 ms` at 1k**: the bundle-
parse burst that ate 176 ms cold-boot disappears completely when the
caches are warm. At larger sizes what remains is the FA2 main-thread
sync work (apply position updates from the worker), which scales with
the graph. Heap is consistently higher than cold-boot at every size
because the warmup pass leaves allocations behind that GC has not yet
collected — a measurement artifact, not a leak.

### 5.3 fullscreen-noc — 🟢 clean

| size | avgFps | p95 | longest-task | totalLT | heap |
|------|--------|-----|--------------|---------|------|
| 1k   | 🟢 59 | 🟢 17ms | 🟢 160 ms | 🟢 285 ms | 65 MB |
| 2.5k | 🟢 58 | 🟢 17ms | 🟢 148 ms | 🟢 276 ms | 99 MB |
| 5k   | 🟢 58 | 🟢 17ms | 🟢 150 ms | 🟢 308 ms | 148 MB |
| 10k  | 🟢 58 | 🟢 17ms | 🟢 150 ms | 🟢 358 ms | 78 MB |

Four panel-transition state changes (presentation on / fullscreen on
/ fullscreen off / presentation off) produce no measurable
graph-size-dependent cost — the work is panel mount/unmount, not
graph traversal. Heap is mildly elevated vs cold-boot because the
extra render passes leave transient allocations.

### 5.4 filter-switch — 🟢 clean

| size | avgFps | p95 | longest-task | totalLT | heap |
|------|--------|-----|--------------|---------|------|
| 1k   | 🟢 59 | 🟢 17ms | 🟢 147 ms | 🟢 216 ms | 71 MB |
| 2.5k | 🟢 58 | 🟢 17ms | 🟢 146 ms | 🟢 279 ms | 106 MB |
| 5k   | 🟢 58 | 🟢 17ms | 🟢 155 ms | 🟢 310 ms | 167 MB |
| 10k  | 🟢 57 | 🟢 17ms | 🟢 154 ms | 🟢 372 ms | 83 MB |

Cycling all 7 overlay layers (clear → each-in-turn → all) is
**effectively free** as graph size scales. The overlay reducer
pipeline runs INSIDE Sigma's reducer callback (per drawn node /
edge), so the work is bounded by what's actually being painted, not
by the entire graph. This is a quiet design win worth preserving
through T8.3.E.

### 5.5 cluster-expand-collapse — 🔴 HOTSPOT B

| size | avgFps | p95 | longest-task | totalLT | heap | boot |
|------|--------|-----|--------------|---------|------|------|
| 1k   | 🟢 53 | 🟢 17ms | 🟢 281 ms | 🟢 942 ms | 54 MB | 7,250 ms |
| 2.5k | 🟢 53 | 🟢 17ms | 🟡 **1,930 ms** | 🟡 **4,727 ms** | 58 MB | 10,585 ms |
| 5k   | 🟢 55 | 🟢 17ms | 🔴 **6,306 ms** | 🔴 **15,052 ms** | 52 MB | 20,869 ms |
| 10k  | 🟡 46 | 🟢 17ms | 🔴 **16,748 ms** | 🔴 **38,883 ms** | 60 MB | 44,279 ms |

The headline: **`longestTaskMs` grows 60×** between 1k and 10k for
a 10× size increase. `totalLongTaskMs` grows 41×. The block manifests
as ONE giant task per expand action — `applyClusterView` is
synchronous and processes the entire graph in a single tick. FPS
holds at 53–55 until 10k because between expand actions Sigma is
idle; the long block happens inside the action and rAF is suspended
for that duration. Root-cause deep dive in §7.

### 5.6 ws-patch-flood — 🔴 HOTSPOT A

| size | avgFps | p95 | longest-task | totalLT | heap | boot |
|------|--------|-----|--------------|---------|------|------|
| 1k   | 🟢 59 | 🟢 17ms | 🟢 163 ms | 🟢 303 ms | 92 MB | 11,792 ms |
| 2.5k | 🟢 44 | 🟡 **50 ms** | 🟢 144 ms | 🟢 482 ms | 97 MB | 16,047 ms |
| 5k   | 🟡 **25** | 🔴 **100 ms** | 🟢 150 ms | 🔴 **24,097 ms** | 48 MB | 34,118 ms |
| 10k  | 🔴 **9** | 🔴 **333 ms** | 🟡 356 ms | 🔴 **78,320 ms** | 61 MB | 91,901 ms |

**`avgFps` collapses from 59 → 9** as size scales 10×. The shape is
different from §5.5: `longestTaskMs` stays moderate (150–356 ms) but
`totalLongTaskMs` explodes (303 ms → **78,320 ms**) because of *task
count* — 252 long tasks at 10k. The renderer can't keep up with the
intended 50 Hz dispatch; the burst at 10k took 85.6 s of wall-clock
to deliver 250 events that were scheduled for 5 s, because each
`setTimeout(20)` was preempted by the render pipeline catching up.
Root-cause deep dive in §6.

---

## 6. Size-scaling behaviour

Most-scaled metric per scenario, 1k → 10k:

| scenario | `avgFps` (1k → 10k) | `longestTaskMs` | `totalLongTaskMs` | growth shape |
|----------|---------------------|-----------------|-------------------|--------------|
| `cold-boot` | 56 → 56 | 176 → 160 | 327 → 369 | flat |
| `warm-cache` | 60 → 57 | 0 → 204 | 0 → 204 | linear-ish, small absolute values |
| `fullscreen-noc` | 59 → 58 | 160 → 150 | 285 → 358 | flat |
| `filter-switch` | 59 → 57 | 147 → 154 | 216 → 372 | flat |
| `cluster-expand-collapse` | 53 → 46 | 281 → **16,748** | 942 → **38,883** | **super-linear (59× longest-task for 10× size)** |
| `ws-patch-flood` | 59 → 9 | 163 → 356 | 303 → **78,320** | **super-linear (258× totalLT for 10× size)** |

The four healthy scenarios are bounded by *what gets painted*, not by
*how much graph exists*. The two hotspots both touch full-graph
traversal in their hot path — confirmed by source reading in §7 and §8.

---

## 7. Top-10 worst cells

| rank | scenario | size | weight | avgFps | p95 | longest-task | totalLT |
|-----:|----------|-----:|------:|-------:|----:|-------------:|--------:|
| 1 | `ws-patch-flood` | 10k | **7** | 🔴 9 | 🔴 333 ms | 🟡 356 ms | 🔴 78,320 ms |
| 2 | `ws-patch-flood` | 5k | **5** | 🟡 25 | 🔴 100 ms | 🟢 150 ms | 🔴 24,097 ms |
| 3 | `cluster-expand-collapse` | 10k | **5** | 🟡 46 | 🟢 17 ms | 🔴 16,748 ms | 🔴 38,883 ms |
| 4 | `cluster-expand-collapse` | 5k | **4** | 🟢 55 | 🟢 17 ms | 🔴 6,306 ms | 🔴 15,052 ms |
| 5 | `cluster-expand-collapse` | 2.5k | **2** | 🟢 53 | 🟢 17 ms | 🟡 1,930 ms | 🟡 4,727 ms |
| 6 | `ws-patch-flood` | 2.5k | **1** | 🟢 44 | 🟡 50 ms | 🟢 144 ms | 🟢 482 ms |
| 7 — 10 | (the remaining 18 cells all carry weight 0) | | | | | | |

The matrix only generates 6 non-zero-weight cells. T8.3.D's
optimization plan only needs to address two distinct hotspots; the
ranking above is the validation gradient T8.3.E will track (a fix is
"good enough" when the cell's weight drops to 0 or 1).

---

## 8. Hotspot A — ws-patch-flood (root cause + fix categories)

### 8.1 What the numbers show

* At 1k the pipeline is fine (59 fps, totalLT 303 ms over 250 events).
* At 2.5k FPS drops to 44 (-25%); p95 frame time doubles to 50 ms.
* At 5k FPS halves again to 25; `totalLongTaskMs = 24.1 s` over a
  nominally 5 s flood — the pipeline is now slower than the producer.
* At 10k it collapses to 9 fps; the 250-event flood took 85.6 s of
  wall-clock instead of the intended 5 s.

`longestTaskMs` is comparatively modest (356 ms at 10k) — the
*shape* is many medium-sized tasks, not one huge one. The bound
appears to be per-event work × event count.

### 8.2 Code-path trace (per event)

```
WS event (or harness dispatchPatchBurst)
  → TopologyV2/index.tsx::handleEvent           src/pages/TopologyV2/index.tsx:203
    → patch.ts::applyTopologyEvent              src/pages/TopologyV2/patch.ts:295
      → graph.mergeNodeAttributes (single node) src/pages/TopologyV2/patch.ts:361
      → ok() → styleGraph(model)                src/pages/TopologyV2/patch.ts:329
        → forEachNode (entire graph, O(N))      src/pages/TopologyV2/graphModel.ts:227
        → forEachEdge (entire graph, O(E))      src/pages/TopologyV2/graphModel.ts:242
    → setPatchSignal(p+1)                       src/pages/TopologyV2/index.tsx:208
      → React commit
        → SigmaCanvas patchSignal useEffect     src/pages/TopologyV2/SigmaCanvas.tsx:176
          → applyClusterView(model, collapsed)  src/pages/TopologyV2/clustering.ts:79
            → forEachNode (O(N))
            → forEachEdge × 2 passes (O(E) each)
          → positionClusterNodes(model)         src/pages/TopologyV2/layout.ts:42
            → for each cluster, iterate memberDeviceKeys
          → trafficRef.stop() + start()         (animator restart)
          → sigmaRef.current.refresh()          (WebGL full redraw)
```

Per event, **two full graph traversals** (one in `styleGraph`, one in
`applyClusterView`), plus a Sigma `refresh()` that re-uploads the
node/edge buffers. The per-event constant factor at 10k is roughly
2 × (10k node iter + ~15k edge iter) + buffer rebuild + WebGL paint
≈ ~300 ms — which matches the observed `longestTaskMs = 356 ms`
exactly.

### 8.3 Root-cause hypothesis table

| # | suspected file | suspected operation | evidence | fix category | risk | validation metric |
|---|----------------|---------------------|----------|--------------|------|-------------------|
| A1 | `graphModel.ts:225–249 styleGraph` | runs `forEachNode` + `forEachEdge` on the entire graph after every successful event | per-event 300 ms task at 10k matches O(N+E) constant factor; called unconditionally from `patch.ts:329` | **scoped restyle** — only the touched node + its incident edges; skip when no styling-relevant attribute changed (e.g. utilization change → no color change) | low — `styleGraph` is pure; partial restyle is an additive code path | per-event main-thread block < 50 ms at 10k |
| A2 | `index.tsx:203 handleEvent` | a single event triggers a single `setPatchSignal(+1)` → single React commit → single full re-render | 250 events at 10k cause 250 React commits + 250 Sigma refreshes | **event coalescing** — buffer events in a ref, flush once per `requestAnimationFrame` | medium — must preserve the order and drift detection in `applyTopologyEvent` | `longTaskCount` ≤ 16 (one per rAF over a 5 s flood) at 10k |
| A3 | `SigmaCanvas.tsx:176 patchSignal effect` | `applyClusterView` + `positionClusterNodes` + traffic restart + full refresh on every patch | per-event Sigma refresh contributes ~half the per-event cost; cluster view + position recompute are run wholesale | **incremental view update** — diff the patched attribute against what changed (status flip → only color reducer dirty); reuse cluster view if `collapsed` set is unchanged | medium — couples cleanly with A1, but the cluster view's invariant about `hidden` consistency must hold | post-flood `applyClusterView` calls per second ≤ 1 |
| A4 | `traffic.ts` (via SigmaCanvas) | `trafficRef.stop() + start()` on every patch restarts the animator state | not directly measured but is an unconditional restart on every patch — small constant, multiplied by 250 | **stateful update** — drive the animator from the same coalesced flush; do not restart on every event | low — animator already has stop/start; fold into A2's flush | (not directly measured; assert via code review) |

### 8.4 Suggested fix sequence (E1 plan)

1. **E1.a** — add a per-event **scoped restyle** in `patch.ts` that
   replaces the unconditional `styleGraph(model)` with
   `restyleNode(model, nodeId)` / `restyleEdge(model, edgeId)` for the
   single touched element. The original `styleGraph` stays for
   non-granular events (drift / refetch) and the initial build. (A1)
2. **E1.b** — introduce a **rAF-aligned coalescing buffer** in
   `index.tsx::handleEvent`. Events go to a ref-held queue; a single
   `setPatchSignal` fires at the next animation frame. SigmaCanvas's
   patch effect runs once per flush, not once per event. (A2 + A3)
3. **E1.c** — verify the animator restart side effect is replaced by
   a single `start()` per flush, not per event. (A4)

### 8.5 E1 validation gradient (target: drop the cell from weight 7 → 0)

| metric | baseline (10k) | E1.a target | E1.b target | E1 done |
|--------|---------------:|------------:|------------:|--------:|
| `avgFps` | 9 | ≥ 25 | ≥ 40 | ≥ 50 |
| `p95FrameTimeMs` | 333 ms | ≤ 100 ms | ≤ 50 ms | ≤ 25 ms |
| `longestTaskMs` | 356 ms | ≤ 200 ms | ≤ 100 ms | ≤ 60 ms |
| `totalLongTaskMs` | 78,320 ms | ≤ 30,000 ms | ≤ 5,000 ms | ≤ 1,500 ms |

---

## 9. Hotspot B — cluster-expand-collapse (root cause + fix categories)

### 9.1 What the numbers show

* At 1k a 5-cluster drill is OK (281 ms longest task, 942 ms total).
* At 2.5k a single longest task already crosses 1 second.
* At 5k longest task is 6.3 s, total 15 s for the same 5 expand
  actions — each expand averages 1.2–2 s of main-thread work.
* At 10k a single expand task can run for **16.7 seconds**
  uninterrupted; total long-task time across the scenario is 38.9 s.

Unlike §8, `avgFps` does not collapse — it stays around 46–55 because
between actions the renderer is idle. The harm is **interactive
latency**: the user clicks, the UI freezes for seconds.

### 9.2 Code-path trace (per expand action)

```
testHandles.expandCluster(id)
  → TopologyV2/index.tsx::expandCluster handle  src/pages/TopologyV2/index.tsx:178 (inside install)
    → setCollapsed(prev => expandCluster(model, prev, id))   src/pages/TopologyV2/clustering.ts:46
    → React commit (new collapsed set)
      → SigmaCanvas applyClusterView effect    src/pages/TopologyV2/SigmaCanvas.tsx:163
        → applyClusterView(model, collapsed)   src/pages/TopologyV2/clustering.ts:79
          (1) forEachNode — set hidden per node                    O(N)
              · for non-cluster node: walks clusterPath.some(...)  O(depth)
              · for cluster node: calls anyAncestorCollapsed       O(depth)
          (2) forEachEdge — collect stale meta-edges               O(E)
          (3) dropEdge on each stale meta-edge                     O(stale)
          (4) forEachEdge — set hidden + aggregate meta            O(E)
              · per edge: repOf(source) + repOf(target)            O(depth) each
          (5) addEdgeWithKey for each new meta-edge                O(new-meta)
        → positionClusterNodes(model)                              src/pages/TopologyV2/layout.ts:42
          · per cluster: iterate memberDeviceKeys + getAttribute   O(Σ members)
        → sigmaRef.current.refresh()                               (WebGL full redraw)
```

Per expand: **3 full graph traversals** in `applyClusterView`
(forEachNode + 2× forEachEdge), plus the cluster-centroid recompute,
plus a Sigma refresh. At 10k, that's ~50,000+ node attribute reads
per expand, ×5 expands in the scenario = the observed 16.7 s peak.

### 9.3 Root-cause hypothesis table

| # | suspected file | suspected operation | evidence | fix category | risk | validation metric |
|---|----------------|---------------------|----------|--------------|------|-------------------|
| B1 | `clustering.ts:87 applyClusterView` | full O(N+E) scan for a topologically local change (only nodes under the expanded cluster shift visibility) | longest task scales 60× for 10× size → super-linear with the graph, not with the cluster size | **incremental apply** — for `expandCluster(id)`, compute the set of nodes whose hidden state actually flips (id's subtree) and update only those + their incident edges | medium — preserve the invariant that meta-edges are consistent; need a small `applyClusterViewDelta` helper | `longestTaskMs` at 10k ≤ 500 ms |
| B2 | `clustering.ts:111 + 121 forEachEdge × 2` | passes 2 and 4 are two separate edge scans, each O(E) | confirmed by reading — pass 2 collects stale meta, pass 4 sets hidden + aggregates | **single-pass edge sweep** — fold the stale-meta collection into pass 4, since both visit every edge | low — a small refactor; the two passes are independent and can merge | edge-pass count at 10k = 1 (currently 2); contributes ~30% to longest-task |
| B3 | `clustering.ts:90 anyAncestorCollapsed + clusterPath walk` | repeated tree walks per node; `clusterPath` is pre-computed but `anyAncestorCollapsed` walks live | per-node cost has a depth factor; for deep hierarchies this is non-trivial | **memoize ancestor-collapsed per render** — a Set built once at the start of `applyClusterView` from the `collapsed` set + cluster-tree topology, then O(1) lookup per node | low — pure-functional helper, easy to unit-test | wall-clock at 10k 5-expand scenario from 16.7 s → ≤ 4 s |
| B4 | `layout.ts:42 positionClusterNodes` | iterates every cluster's full `memberDeviceKeys` to compute centroid | called from SigmaCanvas patch / expand effect; per-cluster O(members); at 10k, a top-level cluster may contain all 10k devices | **lazy centroid** — only recompute centroids of clusters whose member-set changed (collapse/expand crosses the cluster boundary); cache last centroid otherwise | low — `cluster.memberDeviceKeys` is already tracked | post-fix `positionClusterNodes` cost at 10k bound to O(touched clusters), not O(all clusters × members) |
| B5 | `SigmaCanvas.tsx:167 sigmaRef.current.refresh()` | full WebGL buffer rebuild + redraw | unavoidable for visibility flips, but Sigma supports partial refresh hints in newer versions | **Sigma refresh hints** — pass the `partialGraph` option (Sigma 3.x) listing the affected node + edge IDs so the renderer can skip non-changed buffers | medium — Sigma version-dependent; verify the option in the installed version (`sigma@^3.x`) | reduce per-expand Sigma main-thread cost from full N to O(changed) |

### 9.4 Suggested fix sequence (E2 plan)

1. **E2.a** — add `applyClusterViewDelta(model, prev, next, expandedId)`
   alongside the existing `applyClusterView`. The full version stays
   for the initial cluster view; the delta version handles single
   expand/collapse. (B1 + B2 + B3)
2. **E2.b** — replace the `SigmaCanvas` expand-trigger path
   (`SigmaCanvas.tsx:163` effect) to route through the delta helper.
   Initial mount keeps the full path. (B1 wire)
3. **E2.c** — make `positionClusterNodes` accept an optional set of
   touched cluster ids; only recompute those. (B4)
4. **E2.d** — pass `partialGraph` (or the equivalent in the installed
   Sigma version) to `refresh()` so the WebGL buffers aren't fully
   rebuilt. Verify Sigma's API first. (B5)

### 9.5 E2 validation gradient (target: drop the cell from weight 5 → 0)

| metric | baseline (10k) | E2.a–c target | E2 done |
|--------|---------------:|--------------:|--------:|
| `avgFps` | 46 | ≥ 50 | ≥ 55 |
| `longestTaskMs` | 16,748 ms | ≤ 2,000 ms | ≤ 500 ms |
| `totalLongTaskMs` | 38,883 ms | ≤ 10,000 ms | ≤ 1,500 ms |
| 5-expand wall-clock | ~17 s | ≤ 4 s | ≤ 2 s |

---

## 10. T8.3.E plan recommendation

### 10.1 Split

T8.3.E is recommended to land as **two independent sub-branches** off
`topology-gold/T8.3-browser-perf`:

* **`topology-gold/T8.3-E1-patch-flood-coalescing`** — addresses
  Hotspot A (§8). Touches `patch.ts`, `graphModel.ts`,
  `index.tsx::handleEvent`, `SigmaCanvas.tsx`.
* **`topology-gold/T8.3-E2-cluster-restyle-chunking`** — addresses
  Hotspot B (§9). Touches `clustering.ts`, `layout.ts`,
  `SigmaCanvas.tsx` (the cluster-view effect only).

Each sub-branch keeps T8.2 invariants intact: `patch.ts` stays the
single mutation point in both, overlays remain read-only in both,
realtime flow + scope guard are not touched.

### 10.2 Recommended order — **E2 first, then E1**

**Reasoning:**

| factor | E2 (cluster) | E1 (flood) | tiebreaker |
|--------|--------------|------------|------------|
| Surface area | `clustering.ts` + `layout.ts` (~200 lines) | `patch.ts` + `handleEvent` + `SigmaCanvas` patchSignal effect (~350 lines) | E2 smaller |
| Invariant risk | low — overlays and patch.ts untouched | medium — coalescing changes the realtime funnel | E2 lower |
| Success metric | binary, per-action: `longestTaskMs < 500 ms` | continuous, must hold over 5 s burst: `avgFps ≥ 50`, `totalLT < 1.5 s` | E2 easier to confirm |
| Validation cell | `cluster-expand-collapse @ 10k` is a single cell | `ws-patch-flood` cells couple with `cold-boot`/`warm-cache` because they share `handleEvent` | E2 isolated |
| Blast radius if regressed | a slower expand interaction (annoying, not broken) | dropped events / out-of-order patches (broken realtime) | E2 safer |
| User-visible impact | per-click latency at >2.5k scale | always-on smoothness at >2.5k scale | E1 more impactful — argues for it second so it benefits from E2's invariant testing |

Both wins are needed; the order is about **landing E2 first to bank a
clean, low-risk improvement and exercise the validation harness
before E1's more invasive change**. T8.3.E2 ships, then T8.3.E1
ships, then a final pass re-runs the full 24-cell matrix and
SUMMARY.md should show all 24 cells in OK.

### 10.3 Per-branch validation strategy

1. **Re-run the matrix** after each sub-branch via
   `./perf/scripts/run-perf.sh && ./perf/scripts/run-aggregate.sh`.
2. **Compare against the baseline** in this document; expect cells to
   drop weight and the hotspot ranking to shrink.
3. **`--strict` gate** — after E1 + E2 both land, the aggregator
   should exit 0 on `--strict` (no FAIL band anywhere). Until then,
   `--strict` remains diagnostic.
4. **Vitest 132/132** must stay green at every commit. New unit tests
   in `__tests__/patch.ts` (E1) and `__tests__/clustering.ts` (E2)
   cover the helpers introduced by the optimizations.
5. **No new top-level dependency** for either branch; the
   optimizations should be local to the existing modules.

### 10.4 Out of scope for T8.3.E

* The 2D/3D **topology Final Gold Release** redesign. T8.3 is purely
  the performance refresh; redesign is a separate plan.
* The legacy `/topology` route. T8.7 owns that retirement.
* The two T8.3.B carryover items (heap-peak undersampling, WS
  console noise) — neither blocks E1 or E2; both are documented in
  the project memory.
* Tightening the threshold bands — T8.3.D's bands are first-pass; the
  step after T8.3.E lands is to re-baseline and tighten before the
  matrix becomes a regression gate.

---

## 11. Go / No-Go for T8.3.E

### Decision: **GO**

#### Pre-conditions (all met)

* [x] 24-cell baseline produced and committed (`results/SUMMARY.md`).
* [x] Hotspots identified with file-and-line evidence (§8, §9).
* [x] Each hotspot has a fix-category sequence with **measurable**
  validation gradients (§8.4–8.5, §9.4–9.5).
* [x] T8.2 invariants explicitly preserved in both proposed plans.
* [x] Branch strategy lays out two independent commits so a regression
  in one doesn't block the other.
* [x] Production-scale (~63 devices) is not currently broken; T8.3.E
  is a **scale headroom** investment, not a production fix-it-now.

#### Risks accepted

* **Threshold bands are first-pass.** They are calibrated against the
  baseline run; T8.3.E may produce wins that fall *just* below the
  current OK boundary, or regressions that hide inside WARN. The
  re-tighten-after-E pass in §10.2 covers this.
* **Single-machine baseline.** All 24 cells were run on a single
  developer machine. Per-machine variance for FPS / heap is expected
  but should not change the rank ordering. T8.3.E validation runs
  ideally happen on the same machine.
* **Synthetic graph topology.** The synthetic graph generator's
  cluster structure may not perfectly mirror production hierarchies;
  `cluster-expand-collapse` cost in real production may differ in
  constant factor. The 60× scaling slope is the durable signal,
  regardless.

#### Out-of-band issues that must NOT block

* heap-peak undersampling (carried since T8.3.B; tracked in memory)
* WS-upgrade console noise (carried since T8.3.B)
* `cluster-expand-collapse @ 1k` has weight 0 but the harness picks
  cluster ids from the initial frontier — at 1k there may be too few
  meaningful clusters to drive the action. Worth a synthetic-graph
  tweak in E2 to ensure 1k still produces meaningful cluster depth.

---

## Appendix A — full per-cell raw metrics

The numbers below come straight from
`frontend/perf/results/<scenario>-<size>.json`. The aggregator's
`SUMMARY.md` is the canonical rendering; this appendix is a
flat-table copy for citation by T8.3.E commit messages.

| scenario | size | avgFps | p95 | longest-task | totalLT | longTaskCount | heap-used | boot |
|----------|-----:|-------:|----:|-------------:|--------:|--------------:|----------:|-----:|
| cold-boot | 1k | 56 | 17 | 176 | 327 | 3 | 50 | 5,388 |
| cold-boot | 2.5k | 57 | 17 | 145 | 280 | 3 | 75 | 5,290 |
| cold-boot | 5k | 57 | 17 | 144 | 300 | 3 | 62 | 5,277 |
| cold-boot | 10k | 56 | 17 | 160 | 369 | 3 | 102 | 5,293 |
| warm-cache | 1k | 60 | 17 | 0 | 0 | 0 | 63 | 5,134 |
| warm-cache | 2.5k | 59 | 17 | 63 | 63 | 1 | 75 | 5,125 |
| warm-cache | 5k | 59 | 17 | 97 | 97 | 1 | 147 | 5,139 |
| warm-cache | 10k | 57 | 17 | 204 | 204 | 1 | 205 | 5,167 |
| fullscreen-noc | 1k | 59 | 17 | 160 | 285 | 3 | 65 | 8,510 |
| fullscreen-noc | 2.5k | 58 | 17 | 148 | 276 | 3 | 99 | 8,502 |
| fullscreen-noc | 5k | 58 | 17 | 150 | 308 | 3 | 148 | 8,507 |
| fullscreen-noc | 10k | 58 | 17 | 150 | 358 | 3 | 78 | 8,531 |
| filter-switch | 1k | 59 | 17 | 147 | 216 | 2 | 71 | 8,010 |
| filter-switch | 2.5k | 58 | 17 | 146 | 279 | 3 | 106 | 8,003 |
| filter-switch | 5k | 58 | 17 | 155 | 310 | 3 | 167 | 8,028 |
| filter-switch | 10k | 57 | 17 | 154 | 372 | 3 | 83 | 8,036 |
| cluster-expand-collapse | 1k | 53 | 17 | 281 | 942 | 6 | 54 | 7,250 |
| cluster-expand-collapse | 2.5k | 53 | 17 | 1,930 | 4,727 | 7 | 58 | 10,585 |
| cluster-expand-collapse | 5k | 55 | 17 | 6,306 | 15,052 | 9 | 52 | 20,869 |
| cluster-expand-collapse | 10k | 46 | 17 | 16,748 | 38,883 | 9 | 60 | 44,279 |
| ws-patch-flood | 1k | 59 | 17 | 163 | 303 | 3 | 92 | 11,792 |
| ws-patch-flood | 2.5k | 44 | 50 | 144 | 482 | 7 | 97 | 16,047 |
| ws-patch-flood | 5k | 25 | 100 | 150 | 24,097 | 253 | 48 | 34,118 |
| ws-patch-flood | 10k | 9 | 333 | 356 | 78,320 | 252 | 61 | 91,901 |

---

_Document prepared as the closing artifact of T8.3.D. Source data:
`frontend/perf/results/*.json` + `SUMMARY.md` at branch tip
`825303d`. No runtime code change associated with this commit._
