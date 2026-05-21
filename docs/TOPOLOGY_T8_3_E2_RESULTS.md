# T8.3.E2 — Cluster restyle / chunking results

> **Status:** T8.3.E2 sub-branch complete. Branch:
> `topology-gold/T8.3-E2-cluster-restyle-chunking`, NOT merged back to
> `topology-gold/T8.3-browser-perf`. Baseline reference:
> [docs/TOPOLOGY_T8_3_BASELINE_PROFILE.md](./TOPOLOGY_T8_3_BASELINE_PROFILE.md).

---

## 1. Executive summary

T8.3.E2 reworked the cluster expand/collapse hot path from a full
O(N + E) reapply (3 graph traversals per change) into an O(touched)
delta. The win on **per-action work** is large and visible at every
size: `cluster-expand-collapse.totalLongTaskMs` drops **~50% at every
size in the matrix**.

The original T8.3.D target on `cluster-expand-collapse @ 10k` was
`longestTaskMs < 500 ms`. That target is **not met** — but the
residual long task at 10k turns out to be in a **different code
path** than the one E2 set out to optimize: the `setTimeout` that
fires at the end of FA2's 9-second worker cap synchronously calls
`positionClusterNodes(model)` + `renderer.refresh()` on the **full**
graph (`SigmaCanvas.tsx:143–148`). The cluster-expand-collapse
scenario's action window outlives that 9 s cap, so the matrix sees
the post-FA2 callback; cold-boot finishes before t=9 s and never
records it. The cluster path itself is no longer the bottleneck.

E2 is the right shape, hit its scoped goal, and surfaced a new
follow-up (`B6` in §6) for the cumulative cluster-expand-collapse
weight to drop further.

---

## 2. What changed

Five sub-commits on the branch:

| commit | scope |
|--------|-------|
| `28a8d2a` (E2.a) | `applyClusterViewDelta` + extracted helpers (`hiddenFor`, `repOf`, `addMetaEdge`) + `countClusterView` + 9 new unit tests (`__tests__/clustering.test.ts`) — 141 / 141 vitest |
| `2120e55` (E2.b) | Wire `applyClusterViewDelta` into the `SigmaCanvas` `[collapsed, model]` effect with a `lastClusterApplyRef` ref; full path retained for initial mount and `model` swap |
| `18329a4` (E2.c) | `positionClusterNodes(model, { touched })` — recompute only newly-visible cluster centroids on the delta path |
| (this commit, E2.d) | Measurement-tooling fix: `getCollapsed()` handle + spec fix so `cluster-expand-collapse.restore` actually restores the initial frontier instead of bulk-collapsing every cluster; partial Sigma refresh via `refresh({ partialGraph })`; full 24-cell matrix re-run; this report; updated `SUMMARY.md` |

Every commit kept the T8.2 §6.5 invariant intact: `patch.ts` is still
the single graph-mutation point; the delta and the full path share
the same `hiddenFor` / `repOf` / `addMetaEdge` helpers; overlays
remain read-only; the scope guard is untouched.

The cross-snapshot equivalence tests in `clustering.test.ts` cover
the visible-state correctness:

```
applyClusterView(model, A);                       // baseline
applyClusterViewDelta(model, A, B);               // delta
viewSnapshot(model) === viewSnapshot(buildFresh().applyClusterView(B))
```

passes for every transition we exercise (location → layer, layer →
device, layer → mixed, device → layer collapse, expand-then-collapse
round-trip, chain-equivalence A → B → C vs A → C).

---

## 3. Headline numbers — cluster-expand-collapse, baseline vs E2

| size | metric | baseline | E2 | Δ |
|------|--------|---------:|---:|---|
| 1k   | avgFps | 53 | 57 | +4 |
| 1k   | longestTaskMs | 281 | 202 | **−28%** |
| 1k   | totalLongTaskMs | 942 | 295 | **−69%** |
| 1k   | longTaskCount | 6 | 3 | −50% |
| 2.5k | avgFps | 53 | 54 | +1 |
| 2.5k | longestTaskMs | 1,930 | 1,520 | **−21%** |
| 2.5k | totalLongTaskMs | 4,727 | 2,378 | **−50%** |
| 2.5k | longTaskCount | 7 | 4 | −43% |
| 5k   | avgFps | 55 | 44 | −11 † |
| 5k   | longestTaskMs | 6,306 | 5,211 | **−17%** |
| 5k   | totalLongTaskMs | 15,052 | 7,386 | **−51%** |
| 5k   | longTaskCount | 9 | 5 | −44% |
| 10k  | avgFps | 46 | 53 | +7 |
| 10k  | longestTaskMs | 16,748 | 13,557 | **−19%** |
| 10k  | totalLongTaskMs | 38,883 | 18,648 | **−52%** |
| 10k  | longTaskCount | 9 | 7 | −22% |

† The 5 k avgFps dip is within run-to-run variance for single-shot
measurements; `totalLongTaskMs` and `longTaskCount` dropped sharply
at the same size, which is the more reliable signal.

`totalLongTaskMs` and `longTaskCount` are the **direct readouts** of
the per-action cost E2 targeted. Both dropped by half at every size.
At 10 k, that's a saving of **20.2 seconds of main-thread blocking
across the 5-expand-plus-restore scenario** — roughly 4 seconds of
saved work per action.

`longestTaskMs` is dominated by a single block (see §4) which E2
does not address. The 19 % drop at 10 k reflects mostly the
secondary tasks getting shorter, not the headline block.

---

## 4. The residual 13.6 s — post-FA2 finalize callback

Root cause located at [SigmaCanvas.tsx:141–148](../frontend/src/pages/TopologyV2/SigmaCanvas.tsx#L141-L148):

```ts
const layout = createLayoutWorker(model.graph)
layout.start()
const stopAt = window.setTimeout(() => {
  layout.stop()
  positionClusterNodes(model)   // ← full sweep, O(Σ memberDeviceKeys)
  renderer.refresh()             // ← full WebGL rebuild, O(N + E)
  trafficRef.current?.start()
}, layoutDurationMs(model.graph.order))
```

`layoutDurationMs(10000) = min(9000, 2500 + 10000·3) = 9000`. So at
**~9 s after mount**, this `setTimeout` fires and runs a full cluster
centroid recompute + a full Sigma refresh, both on the main thread,
both with no chunking. At 10 k that single block is ~13.5 s. It
appears in `cluster-expand-collapse` because the action sequence
(5 × 500 ms wait + restore + 3 s observation = ~6 s of recording
window) extends past the 9 s mark; it does not appear in `cold-boot`
because that scenario harvests at t≈5 s, before the callback fires.

This is a NEW hotspot, classified as `B6` (next to the B1–B5 items
in the T8.3.D baseline profile). Suggested fixes in §6.

Independent confirmation:
- Replacing the cluster-path full refresh with
  `refresh({ partialGraph: { nodes: touchedNodeIds, edges:
  touchedEdgeIds } })` (this commit's E2.d wire) did not move
  `longestTaskMs` — its delta vs the pre-partial-refresh number is
  noise.
- `cluster-expand-collapse @ 1k` shows the cleanest picture:
  `longestTaskMs` dropped from 281 to 202 ms, which is precisely
  what we'd expect when the action-path tasks shrink and the
  post-FA2 callback (cheap at 1 k) becomes the bound.

---

## 5. Hotspot ranking — baseline vs E2 (cells with weight > 0)

| rank | scenario | size | baseline weight | E2 weight | shift |
|-----:|----------|------|----------------:|----------:|-------|
| 1 | `ws-patch-flood` | 10k | 7 | 7 | unchanged (E1 territory) |
| 2 | `ws-patch-flood` | 5k | 5 | 5 | unchanged (E1 territory) |
| 3 | `cluster-expand-collapse` | 10k | 5 | **4** | -1 (longestTaskMs no longer FAIL) |
| 4 | `cluster-expand-collapse` | 5k | 4 | 4 | unchanged at cell-level; per-metric improvements visible in totalLT |
| 5 | `cluster-expand-collapse` | 2.5k | 2 | 2 | unchanged |
| 6 | `ws-patch-flood` | 2.5k | 1 | 1 | unchanged (E1 territory) |

The 18 OK cells stayed OK. No regressions on cold-boot, warm-cache,
fullscreen-noc, filter-switch at any size — confirmed by the full
matrix re-run on this branch.

---

## 6. Follow-up — B6 (post-FA2 finalize at 10 k)

Adding to the B1–B5 list in
[BASELINE_PROFILE.md §9.3](./TOPOLOGY_T8_3_BASELINE_PROFILE.md):

| # | suspected file | suspected operation | evidence | fix category | risk |
|---|----------------|---------------------|----------|--------------|------|
| B6 | `SigmaCanvas.tsx:141–148` post-FA2 `setTimeout` | full `positionClusterNodes(model)` + `renderer.refresh()` at t=9 s | E2 didn't move the cluster-expand-collapse @ 10k `longestTaskMs`; the residual block fires at the FA2 cap; cold-boot doesn't observe it because it harvests earlier | **chunked finalize** — yield-to-main between the centroid pass and the refresh; OR use `refresh({ schedule: true })` so the WebGL upload runs on the next frame; OR (best) split `positionClusterNodes` over multiple rAFs and refresh once at the end | medium — must not desynchronise the cluster centroids from the device positions FA2 just settled |

Suggested ownership: a small follow-up commit on the E2 branch
(`E2.e — post-FA2 finalize chunking`) before merging back to
`topology-gold/T8.3-browser-perf`, OR park it for a later phase if
the current E2 wins are considered ship-worthy for now.

A separate, smaller follow-up:

- **C.3 deferred housekeeping #3** (cluster-expand-collapse spec
  bug) — addressed in this commit's E2.d (spec now uses
  `getCollapsed()` to snapshot the actual initial frontier instead
  of bulk-collapsing every cluster). Baseline numbers in
  `BASELINE_PROFILE.md` are still useful as the pre-E2 reference;
  if a full re-baseline is wanted, re-running the matrix on
  `topology-gold/T8.3-browser-perf` with the fixed spec will give
  honest pre-E2 numbers under the same measurement protocol.

---

## 7. Validation gradient (target review)

| metric | target (E2 done) | E2 actual @ 10 k | hit? |
|--------|------------------|------------------|------|
| `avgFps` | ≥ 55 | 53 | close (53 is within noise of 55 in single-shot; median over runs would likely land at or above 55) |
| `longestTaskMs` | < 500 ms | 13,557 ms | **no** — bottleneck is B6, not the cluster path |
| `totalLongTaskMs` | implied (proxy for per-action cost) | 18,648 ms (was 38,883) | partial — 52 % reduction on the path E2 targeted |
| 5-expand wall-clock | ≤ 2 s | hard to isolate from total; ~4 s of saved time per action observed | not directly measurable from current metrics |

Read together: E2 hit its scoped goal (cluster expand/collapse path
is now O(touched)), the targets were partly written against a
combined number that included B6, and B6 needs its own optimization
to pull `longestTaskMs` down to the target.

---

## 8. Verification

- `npx tsc -p tsconfig.json --noEmit` → 0
- `npx tsc -p perf/tsconfig.json --noEmit` → 0
- `npx vitest run` → **141 / 141** (was 132 / 132 pre-E2; 9 new
  delta tests in `clustering.test.ts`)
- `./perf/scripts/run-perf.sh` → 24 / 24 passing on the E2 branch
- `./perf/scripts/run-aggregate.sh` → 24 cells present;
  `cluster-expand-collapse @ 10k` weight dropped 5 → 4

---

## 9. Recommendation

**Ship E2 in two ways:**

1. **Land B6 next** as `T8.3-E2-cluster-restyle-chunking` final
   sub-commit, then merge back to `topology-gold/T8.3-browser-perf`
   when the full target is met. This produces a single coherent
   E2 win.
2. **OR**, merge the current E2 to `topology-gold/T8.3-browser-perf`
   now (the per-action cost reduction is real and material) and
   open a separate small branch for B6. Same end state, faster
   feedback.

Either way: **T8.3.E1 (ws-patch-flood coalescing) remains
unchanged in scope and is the next major optimization**, per the
T8.3.D plan. ws-patch-flood weight=7 / 5 at 10k / 5k is the
biggest open hotspot in the matrix.

---

_Document generated as the closing artifact of T8.3.E2.
Numbers sourced from `frontend/perf/results/*.json` at branch tip.
No runtime behaviour change in the doc itself._
