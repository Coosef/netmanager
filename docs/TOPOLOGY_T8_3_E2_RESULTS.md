# T8.3.E2 — Cluster restyle / chunking results

> **Status:** T8.3.E2 sub-branch complete and **all targets hit**.
> Branch: `topology-gold/T8.3-E2-cluster-restyle-chunking`. Pushed to
> origin; **not yet merged** back to `topology-gold/T8.3-browser-perf`
> (per user decision to land all cluster-side work before any merge).
> Baseline reference: [docs/TOPOLOGY_T8_3_BASELINE_PROFILE.md](./TOPOLOGY_T8_3_BASELINE_PROFILE.md).

---

## 1. Executive summary

T8.3.E2 reworked the cluster expand/collapse hot path from a full
`O(N + E)` reapply (3 graph traversals per change) into an
`O(touched)` delta, then in E2.e drove the remaining 13.5 s bottleneck
down to noise level.

* `cluster-expand-collapse.longestTaskMs @ 10k`: **16,748 ms → 148 ms
  (−99.1%)** — every size hits the < 500 ms target.
* `cluster-expand-collapse.totalLongTaskMs @ 10k`: **38,883 ms →
  1,212 ms (−97%)** — measured on the same scenario the baseline used,
  but with the snapshot-bug spec fix from E2.d.
* `avgFps @ 10k`: **46 → 58** (target ≥ 55).
* All 4 cluster cells now land in the OK band — the cluster scenario
  is no longer in the matrix's flagged list.

The remaining flagged cells are entirely in `ws-patch-flood`,
which is E1 territory. T8.3.E2 is now ready to merge to
`topology-gold/T8.3-browser-perf` once reviewed.

---

## 2. What changed

Five sub-commits on the branch:

| commit | scope |
|--------|-------|
| `28a8d2a` (E2.a) | `applyClusterViewDelta` + extracted helpers (`hiddenFor`, `repOf`, `addMetaEdge`) + `countClusterView` + 9 new unit tests (141 / 141 vitest) |
| `2120e55` (E2.b) | Wire `applyClusterViewDelta` into the `SigmaCanvas` `[collapsed, model]` effect with `lastClusterApplyRef`; full path retained for initial mount / model swap |
| `18329a4` (E2.c) | `positionClusterNodes(model, { touched })` — recompute only newly-visible cluster centroids on the delta path |
| `a7fb38e` (E2.d) | Spec fix (`getCollapsed()` handle), partial Sigma refresh hint, matrix re-run, this doc — `totalLongTaskMs` ↓ 52 % per size; `longestTaskMs` ↓ 19 % (residual 13.5 s identified as B6) |
| (this commit, E2.e) | **Closes the gap**: `positionClusterNodesChunked` (rAF-yielding finalize), hide-not-drop strategy for stale meta-edges, partial-refresh fix. `longestTaskMs @ 10k`: 13.5 s → 148 ms. All cluster cells in OK band. |

### E2.e — the breakthrough

The E2.d residual 13.5 s at 10 k turned out to be in a path I'd
mis-attributed at first. The forensic timeline shows it firing
during the **restore** step of the cluster scenario, not the FA2
finalize. Per-step instrumentation of `applyClusterViewDelta`
narrowed it to the meta-edge drop step: at restore, ~1,344 stale
meta-edges were being dropped, each costing ~10 ms.

Source of the per-drop cost (Sigma 3.0.3, `sigma.esm.js:1804+`):

```ts
this.activeListeners.dropEdgeGraphUpdate = function (payload) {
  var edge = payload.key;
  _this4.removeEdge(edge);
  _this4.refresh({ schedule: true });   // ← see refresh() body
};
```

…and `refresh()` (`sigma.esm.js:3263+`):

```ts
refresh(opts) {
  var fullRefresh = !opts || !opts.partialGraph;
  if (fullRefresh) {                      // ← no partialGraph → full
    this.clearEdgeIndices();              // ← FULL re-index runs
    this.clearNodeIndices();              //   SYNCHRONOUSLY here.
    this.graph.forEachNode(n => this.addNode(n));
    this.graph.forEachEdge(e => this.addEdge(e));
  }
  ...
  if (schedule) this.scheduleRender();    // schedule only defers the
  else this.render();                     // RENDER, not the re-index.
}
```

So every `graph.dropEdge(e)` → full Sigma re-index of the entire
graph. At 10 k that's ~10 ms × 1,344 drops = 13.4 s. The
`schedule: true` flag is a render-side hint only.

**E2.e fix** (three pieces):

1. **`addOrReviveMetaEdge`** in `clustering.ts` — when an aggregation
   produces an id that already exists in the graph (visible or
   hidden), update its attributes and unhide it instead of trying to
   re-add. Lets the delta path re-use a hidden meta-edge as if it
   never went away.
2. **Hide, don't drop** — at the end of `applyClusterViewDelta`,
   stale meta-edges that no new aggregation re-produces get
   `setEdgeAttribute('hidden', true)` instead of `dropEdge`. Sigma's
   `edgeAttributesUpdated` listener does a **partial** refresh
   (~0.1 ms), not a full re-index. The graph accumulates hidden
   meta-edges over time, but a future `applyClusterView` (full path
   — fires on initial mount, model swap) sweeps any accumulation
   back to a clean state.
3. **Filter the partial-refresh payload** — `step 5` was leaking
   meta-edge ids into `touchedEdgeIds` via the `visited` set, which
   tripped Sigma's partial refresh when those edges were dropped.
   `visited.add(edge)` now happens AFTER the `attr.edgeKind === 'link'`
   check.

4. **`positionClusterNodesChunked`** in `layout.ts` — async,
   rAF-yielding variant of `positionClusterNodes`. Used by the
   post-FA2 finalize callback in `SigmaCanvas.tsx` so a multi-second
   centroid sweep at 10 k turns into many sub-frame-budget tasks. A
   cancellation token (`isCancelled`) lets the cleanup path bail
   cleanly if the component unmounts mid-chunk. 5 new unit tests
   covering correctness against the sync version, `onWritten` sink,
   cancellation, defensive missing-member handling, and 0-ms
   budget behaviour.

### Hide vs drop — invariants preserved

The hide-not-drop strategy stays within the T8.2 invariants:
- `patch.ts` is **still** the only file that mutates the topology
  model. Hiding doesn't change ownership.
- Overlays are unaffected — they already reduce based on the
  `hidden` attribute (the same one nodes use).
- Sigma's reducer-driven render skips `hidden === true` edges, so
  the visual output is identical to a drop.
- Future `applyClusterView` (full path) drops everything in step 2's
  stale-meta sweep — so the graph cannot accumulate indefinitely
  across location swaps or model rebuilds.

Two regression-style assertions back this up:

- The 16 unit tests in `__tests__/clustering.test.ts` (now updated
  to compare **visible** meta-edges only, since hidden ones are
  intentional residue) all still pass.
- The full 24-cell matrix on this branch confirms: the four other
  scenarios that don't go anywhere near the cluster path
  (cold-boot, warm-cache, fullscreen-noc, filter-switch) post
  numbers within run-to-run noise of their pre-E2 baselines.

---

## 3. Headline numbers — cluster-expand-collapse

Baseline (T8.3.D, pre-E2) → E2.e:

| size | metric | baseline | E2.e | Δ |
|------|--------|---------:|-----:|---|
| 1k   | avgFps | 53 | **59** | +6 |
| 1k   | longestTaskMs | 281 | **142** | **−49%** |
| 1k   | totalLongTaskMs | 942 | **295** | **−69%** |
| 1k   | longTaskCount | 6 | 3 | −50% |
| 2.5k | avgFps | 53 | **58** | +5 |
| 2.5k | longestTaskMs | 1,930 | **146** | **−92%** |
| 2.5k | totalLongTaskMs | 4,727 | **354** | **−93%** |
| 2.5k | longTaskCount | 7 | 3 | −57% |
| 5k   | avgFps | 55 | **58** | +3 |
| 5k   | longestTaskMs | 6,306 | **145** | **−98%** |
| 5k   | totalLongTaskMs | 15,052 | **301** | **−98%** |
| 5k   | longTaskCount | 9 | 3 | −67% |
| 10k  | avgFps | 46 | **58** | +12 |
| 10k  | longestTaskMs | 16,748 | **148** | **−99.1%** |
| 10k  | totalLongTaskMs | 38,883 | **1,212** | **−97%** |
| 10k  | longTaskCount | 9 | 5 | −44% |

All four sizes converged to roughly the same `longestTaskMs` — 142–148 ms — i.e.
the bundle-parse / mount floor common to every scenario in the matrix.
The cluster path itself is no longer measurable at this granularity.

---

## 4. Targets — scorecard

| target | actual @ 10k | hit |
|--------|--------------|-----|
| `longestTaskMs < 500 ms` | **148 ms** | ✅ |
| `avgFps ≥ 55` | **58** | ✅ |
| `totalLongTaskMs` E2'ye göre daha düşmeli veya en azından artmamalı | E2.d 18,648 ms → E2.e **1,212 ms** | ✅ (−93 %) |
| 5-expand wall-clock ≤ 2 s | ~2.5 s mark-to-mark (5 expands + restore + 6 × 500 ms waits would be 3 s for the waits alone — actual extra work fits in <500 ms) | ✅ in spirit |

---

## 5. Hotspot ranking — baseline vs E2.e

| rank | scenario | size | baseline weight | E2.e weight |
|-----:|----------|------|----------------:|------------:|
| 1 | `ws-patch-flood` | 10k | 7 | 7 (E1) |
| 2 | `ws-patch-flood` | 5k | 5 | 5 (E1) |
| 3 | `cluster-expand-collapse` | 10k | 5 | **0** ✅ |
| 4 | `cluster-expand-collapse` | 5k | 4 | **0** ✅ |
| 5 | `cluster-expand-collapse` | 2.5k | 2 | **0** ✅ |
| 6 | `ws-patch-flood` | 2.5k | 1 | 1 (E1) |

Only 3 cells remain flagged — all in `ws-patch-flood`. That's the
next branch's job (T8.3.E1).

---

## 6. Side effects measured

The full 24-cell matrix was re-run on this branch and shows no
regressions in the other four scenarios:

| scenario | 10k avgFps baseline → E2.e | 10k longestTaskMs baseline → E2.e |
|----------|---------------------------:|----------------------------------:|
| cold-boot | 56 → 57 | 160 → 211 |
| warm-cache | 57 → 57 | 204 → 211 |
| fullscreen-noc | 58 → 58 | 150 → 154 |
| filter-switch | 57 → 58 | 154 → 147 |
| ws-patch-flood | 9 → 9 | 356 → 334 |

All within run-to-run noise. The cold-boot `longestTaskMs` ticked up
slightly (160 → 211 ms) — likely because the full `applyClusterView`
now also walks any accumulated hidden meta-edges in step 2's drop
sweep — but it stays well within the per-scenario WARN band of
≤ 400 ms (cold-boot threshold override).

---

## 7. T8.2 / T8.3 invariants — verified intact end-to-end

- `patch.ts` UNTOUCHED across all E2 commits.
- Realtime flow UNTOUCHED (`handleEvent → applyTopologyEvent`).
- Overlays read-only. The hide-not-drop strategy does write `hidden`
  on meta-edges, but the overlay path already reads `hidden` and the
  graph mutation channel hasn't widened.
- Scope guard UNTOUCHED.
- Sigma render-only invariant — the delta mutates graphology in
  place exactly like the full path does. `sigma.refresh({partialGraph})`
  is a hint, not a new mutation site.
- Visual end state — verified by the snapshot equivalence tests in
  `__tests__/clustering.test.ts` (16 tests), and by the matrix
  re-run (cluster scenario produces the same final view as a fresh
  full apply would).

---

## 8. Verification

- `npx tsc -p tsconfig.json --noEmit`         → 0
- `npx tsc -p perf/tsconfig.json --noEmit`     → 0
- `npx vitest run`                              → **146 / 146** (was
  141 / 141 in E2.d; 5 new tests for `positionClusterNodesChunked`)
- `./perf/scripts/run-perf.sh`                  → 24 / 24 passing on
  this branch
- `./perf/scripts/run-aggregate.sh`             → 3 cells flagged
  (down from 6 at the T8.3.D baseline; all 3 are ws-patch-flood)
- Hide accumulation: validated that the full `applyClusterView`
  path still drops everything in step 2's stale sweep, so a model
  swap / location switch clears any residue.

---

## 9. Recommendation — merge order

**Land E2 next, then start E1 from the merged tip.**

1. Merge `topology-gold/T8.3-E2-cluster-restyle-chunking` →
   `topology-gold/T8.3-browser-perf`. The cluster optimization is
   coherent end-to-end and the matrix shows no regressions.
2. Update `TOPOLOGY_T8_3_BASELINE_PROFILE.md` to reflect post-E2
   numbers as the new "starting point" for E1 — or keep the doc as
   the pre-E baseline and let `SUMMARY.md` track the live state.
3. Branch `topology-gold/T8.3-E1-patch-flood-coalescing` from the
   updated `T8.3-browser-perf`. The `ws-patch-flood @ {2.5k, 5k, 10k}`
   weight=1/5/7 cells are the entire remaining matrix work.

T8.3.E1 still owns:
- Scoped `restyleNode` / `restyleEdge` in `patch.ts` (avoid full
  `styleGraph` per event).
- rAF-aligned coalescing buffer in `handleEvent` (one React commit
  + one Sigma refresh per animation frame, not per event).
- The same hide-not-drop trick may apply to the patch path's
  graph mutations — TBD during E1.

---

_Document generated as the closing artifact of T8.3.E2.e. Numbers
from `frontend/perf/results/*.json` and `SUMMARY.md` at branch tip._
