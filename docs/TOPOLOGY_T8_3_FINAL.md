# T8.3 — Browser Performance Refresh — closing report

> **Status: COMPLETE.** Measure → hotspot identification → targeted
> optimization cycle closed end-to-end. Branch
> `topology-gold/T8.3-browser-perf` (merge-tip **`1872070`**) is
> main-merge-ready pending the human-review pass on this commit.

---

## 1. One-page summary

| | matrix flagged cells | total weight | green cells |
|---|---:|---:|---:|
| T8.3.C baseline | 6 | 24 | 18 / 24 |
| E2 merged (cluster) | 3 | 13 | 21 / 24 |
| **E1 merged (flood, final)** | **1** | **1** | **23 / 24** |

The remaining flagged cell is **`ws-patch-flood @ 10k` weight = 1** —
only `p95FrameTimeMs = 33 ms` sits in WARN against the default
`okMax = 20`. Documented as out-of-scope for the coalescing work
T8.3.E was framed around; it's a Sigma WebGL paint-side concern to
be revisited during T8.4 / T8.5 if it surfaces user-side. Every
other metric on every cell sits in OK.

`./perf/scripts/run-aggregate.sh --strict` exits **0** on the
merge tip — no FAIL bands matrix-wide.

## 2. Headline transformations (10 k size, baseline → final)

### Hotspot A — `ws-patch-flood`

| metric | baseline | E1 final | Δ |
|--------|---------:|---------:|---|
| `avgFps` | 9 | **51** | **+467%** |
| `p95FrameTimeMs` | 333 ms | **33 ms** | **−90%** |
| `longestTaskMs` | 356 ms | **155 ms** | **−56%** |
| `totalLongTaskMs` | 78,320 ms | **408 ms** | **−99.5%** |
| `longTaskCount` | 252 | **4** | **−98%** |

### Hotspot B — `cluster-expand-collapse`

| metric | baseline | E2 final | Δ |
|--------|---------:|---------:|---|
| `avgFps` | 46 | **58** | **+26%** |
| `longestTaskMs` | 16,748 ms | **148 ms** | **−99.1%** |
| `totalLongTaskMs` | 38,883 ms | **1,212 ms** | **−97%** |

## 3. Sub-phase commits (history preserved via `--no-ff`)

```
1872070 Merge: T8.3.E1 patch-flood coalescing
└── a7d051b feat(t8.3e1): scoped restyle + rAF coalescing + partial refresh

6fcc30e Merge: T8.3.E2 cluster restyle / chunking
├── bee4c0d E2.e — hide-not-drop + chunked FA2 finalize (all targets hit)
├── a7fb38e E2.d — partial Sigma refresh + spec fix + E2 results doc
├── 18329a4 E2.c — lazy centroid (touched-set only)
├── 2120e55 E2.b — wire applyClusterViewDelta into SigmaCanvas
└── 28a8d2a E2.a — applyClusterViewDelta + 9 unit tests

7b05518 docs(t8.3d) — baseline profile and hotspot ranking
825303d feat(t8.3c.5) — aggregator + thresholds + SUMMARY.md baseline
301fe45 feat(t8.3c.4) — ws-patch-flood scenario; 24-cell matrix complete
b2231fc feat(t8.3c.3) — DOM-driven scenarios + perf test handles
bb2b79b feat(t8.3c.2) — warm-cache scenario × 4 sizes
68d396e feat(t8.3c.1) — cold-boot scenario × 4 sizes
b0cd678 feat(t8.3b)   — Playwright perf harness + cold-boot canonical
5f00d70 feat(t8.3a)   — perf scaffolding: stress mode + dev overlay
```

Reports per phase:

- [docs/TOPOLOGY_T8_3_MEASUREMENT_PLAN.md](./TOPOLOGY_T8_3_MEASUREMENT_PLAN.md) — original plan + §11 decisions
- [docs/TOPOLOGY_T8_3_BASELINE_PROFILE.md](./TOPOLOGY_T8_3_BASELINE_PROFILE.md) — T8.3.D pre-E baseline (immutable)
- [docs/TOPOLOGY_T8_3_E2_RESULTS.md](./TOPOLOGY_T8_3_E2_RESULTS.md) — cluster path closing report
- [docs/TOPOLOGY_T8_3_E1_RESULTS.md](./TOPOLOGY_T8_3_E1_RESULTS.md) — flood path closing report

## 4. T8.2 invariants — verified intact end-to-end

Every invariant the T8.2 cleanup locked in survives the full T8.3
journey, audited at each merge:

- **`patch.ts` is still the single graph-mutation point.** The E1
  rAF coalescing buffer is transport only (queue + flush); each
  event still travels through `applyTopologyEvent`.
- **Realtime contract intact.** `useTopologyRealtime → handleEvent`
  contract unchanged; rAF flush is internal to the page.
- **Overlays read-only.** `restyleNode` / `restyleEdge` /
  `applyClusterViewDelta` / `addOrReviveMetaEdge` all write the
  same attributes the pre-E versions did; no new mutation surface.
- **Scope guard untouched.** `eventInScope` still runs per event
  inside `applyTopologyEvent` — coalescing does NOT merge events,
  so each is independently scope-checked.
- **Sigma render-only invariant preserved.** `refresh({partialGraph,
  skipIndexation})` is a render-side hint; no new graphology
  ownership.

Mechanical confirmations on the merge tip (`1872070`):

- `npx tsc -p tsconfig.json --noEmit`            → 0
- `npx tsc -p perf/tsconfig.json --noEmit`        → 0
- `npx vitest run`                                 → **150 / 150**
  (was 132 / 132 at T8.3.C; 18 net new tests across the journey:
  9 in `clustering.test.ts` for `applyClusterViewDelta`, 5 in
  `layout.test.ts` for `positionClusterNodesChunked`, 4 in
  `patch.test.ts` for scoped restyle)
- `npm run build`                                  → success.
  `testHandles-*.js` stays at 0.18 KB lazy chunk; `PerfOverlay-*.js`
  and `syntheticGraph-*.js` still in their own chunks; main bundle
  `index-*.js` unchanged. No new top-level dependency.
- `./perf/scripts/run-perf.sh`                     → 24 / 24
- `./perf/scripts/run-aggregate.sh --strict`       → exit 0

## 5. Final matrix (per cell)

| scenario | size | avgFps | p95 | longest-task | totalLT | band |
|----------|------|-------:|----:|-------------:|--------:|:----:|
| cold-boot | 1k | 56 | 17 ms | 147 ms | — | OK |
| cold-boot | 2.5k | 58 | 17 ms | 149 ms | — | OK |
| cold-boot | 5k | 57 | 17 ms | 147 ms | — | OK |
| cold-boot | 10k | 57 | 17 ms | 208 ms | — | OK |
| warm-cache | 1k | 60 | 17 ms | 0 ms | — | OK |
| warm-cache | 2.5k | 59 | 17 ms | 62 ms | — | OK |
| warm-cache | 5k | 59 | 17 ms | 93 ms | — | OK |
| warm-cache | 10k | 57 | 17 ms | 211 ms | — | OK |
| fullscreen-noc | × 4 | 58–59 | 17 ms | 148–160 ms | — | OK |
| filter-switch | × 4 | 58–59 | 17 ms | 146–155 ms | — | OK |
| cluster-expand-collapse | 1k | 59 | 17 ms | 142 ms | 295 ms | OK |
| cluster-expand-collapse | 2.5k | 58 | 17 ms | 146 ms | 354 ms | OK |
| cluster-expand-collapse | 5k | 58 | 17 ms | 145 ms | 301 ms | OK |
| cluster-expand-collapse | 10k | 58 | 17 ms | 150 ms | 1,212 ms | OK |
| ws-patch-flood | 1k | 59 | 17 ms | 163 ms | 291 ms | OK |
| ws-patch-flood | 2.5k | 59 | 17 ms | 158 ms | 264 ms | OK |
| ws-patch-flood | 5k | 59 | 17 ms | 160 ms | 298 ms | OK |
| **ws-patch-flood** | **10k** | **51** | **🟡 33 ms** | **155 ms** | **408 ms** | **WARN (p95)** |

(Live SUMMARY: [frontend/perf/results/SUMMARY.md](../frontend/perf/results/SUMMARY.md).)

## 6. Outstanding items

These are **non-blocking** for the main merge — documented for the
T8.4/T8.5 plan:

1. **`ws-patch-flood @ 10k` p95 = 33 ms** — close-miss against the
   default `okMax: 20`. Improvement would need a Sigma WebGL paint-
   side optimization (multi-frame chunking inside Sigma's render
   loop, beyond the coalescing framing E1 operated at). Sits well
   inside WARN (`warnMax: 50`); not user-visible.
2. **heap-peak undersampling** — rAF blocks during boot allocation
   burst, so the peak metric under-reports. Documented at
   `frontend/perf/harness/cdpMetrics.ts:54`. Fix: switch to
   `setInterval` poll or CDP `Memory.getHeapUsage`.
3. **WebSocket-upgrade console noise** — `/api/v1/ws/events`
   upgrade leaks past Playwright 1.49's `page.route`. Cosmetic.
4. **`cold-boot.spec.ts` + `warm-cache.spec.ts` housekeeping** —
   not yet refactored to use `scenarioBase.runScenario` (the other
   four scenarios do). Pure refactor, no behavioural change.

## 7. Main-merge sequence

1. (Optional) Tighten thresholds in
   `frontend/perf/scripts/thresholds.json` to reflect the new
   post-E1 baseline. Most cells sit at 17 ms p95 — `warnMax: 50`
   could drop to 40 or even 25 once we accept the flood-10k WARN.
   Decision: keep current bands; the matrix-wide picture is clean.
2. `git checkout main`
3. `git merge --no-ff topology-gold/T8.3-browser-perf -m "Merge … T8.3 …"`
4. `npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run build`
5. `git push origin main`

After merge, the T8.3 history is preserved as two merge commits
on main, each grouping its sub-phase work. The branch
`topology-gold/T8.3-browser-perf` and its two E sub-branches
can stay as historical references — no rush to delete them.

---

_Closing this loop after 18 commits across T8.3.A → T8.3.E1.
Matrix down from 24 to 1 flagged metric-slot. Both hotspots the
baseline profile flagged are closed; the optimization work
respected every T8.2 invariant; the harness itself is reusable
for the next browser-perf cycle. T8.3 is done._
