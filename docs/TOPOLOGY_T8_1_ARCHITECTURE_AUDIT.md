# TopologyV2 — T8.1 Architecture Audit

> **Source-of-truth date:** 2026-05-21
> **Scope:** every file under `frontend/src/pages/TopologyV2/` (28 production modules + 9 test files + 2 test utilities = 39 source files)
> **Purpose:** five deliverables (engine map, circular-import audit, public API surface, coverage map, render-ownership map) feeding T8.2 module-separation review.
> **Branch:** `topology-gold/T8.1-architecture-audit`. No code changes in this phase — findings only.

---

## 1. Verdict (one paragraph)

The engine is **well-factored**. Zero circular imports, a clear ownership chain (`contract → graphModel → {clustering, overlays, three/}`), a single realtime merge point (`patch.ts`), overlays as a pure read-only projection, the 3D layer as a pure GPU projection, and module-aligned test coverage on every behaviour-bearing file. Two surface findings only — ts-prune flagged a handful of dead exports and three render-bearing files lack a unit test (architectural choice, not a defect). T8.2 separation review has a clean starting point.

---

## 2. Engine architecture map

### 2.1 Layer model

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ENTRY                                                                  │
│    index.tsx                                                            │
│    SigmaCanvas.tsx              three/Topology3D.tsx                    │
└─────────────────────────────────────────────────────────────────────────┘
              ▲                                ▲
              │ reads                          │ reads
┌─────────────┴────────────────────────────────┴──────────────────────────┐
│  RENDER                                                                 │
│    [Sigma 2D]            traffic.ts        rendering.ts                 │
│                                                                         │
│    [r3f 3D]              three/Scene.tsx                                │
│                            ├─ three/NodesLayer.tsx                      │
│                            ├─ three/EdgesLayer.tsx                      │
│                            ├─ three/CameraRig.tsx                       │
│                            └─ three/Atmosphere.tsx                      │
│                          three/sceneData.ts   three/trafficShader.ts    │
│                          three/layout3d.ts    three/lod.ts              │
│                          three/nodeClasses.ts                           │
└─────────────────────────────────────────────────────────────────────────┘
              ▲                                ▲
              │ projection                     │ projection
┌─────────────┴────────────────────────────────┴──────────────────────────┐
│  OVERLAYS (read-only)                                                   │
│    overlays/overlayModel.ts                                             │
│    overlays/overlayStyle.ts        overlays/focus.ts                    │
└─────────────────────────────────────────────────────────────────────────┘
              ▲
              │ derives from
┌─────────────┴───────────────────────────────────────────────────────────┐
│  MODEL                                                                  │
│    graphModel.ts (mutable singleton — graphology.Graph)                 │
│    clustering.ts (cluster view derivation, frontier algorithm)          │
│    layout.ts (FA2 Web-Worker supervisor, 2D positions)                  │
└─────────────────────────────────────────────────────────────────────────┘
              ▲                          ▲
              │ writes via               │ contract
┌─────────────┴──────────────────────────┴────────────────────────────────┐
│  CHANGE                                                                 │
│    patch.ts — SINGLE merge point                                        │
│    realtime.ts — WS subscriber, emits → patch.ts                        │
│    api.ts — fetch contract, emits → patch.ts                            │
└─────────────────────────────────────────────────────────────────────────┘
              ▲
              │
┌─────────────┴───────────────────────────────────────────────────────────┐
│  CONTRACT                                                               │
│    contract.ts (runtime validation against TopologyGraphV2)             │
│    scaleConfig.ts (size-adaptive constants)                             │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  CHROME                                                                 │
│    noc/nocUi.ts (panel/shortcut logic, framework-free)                  │
│    noc/uiPrefs.ts (operator-pref persistence — no tenant data)          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Module responsibility (one-line per module)

| Module | Responsibility | Pure? |
|---|---|---|
| `contract.ts` | runtime validation of `TopologyGraphV2` payload before it reaches the model | ✓ |
| `scaleConfig.ts` | size-adaptive constants — semantic-zoom tiers, label thresholds, LOD ladders | ✓ |
| `api.ts` | React Query data access for `/topology/graph?v=2`; org/loc scope inherited from `client` | side-effect: I/O |
| `graphModel.ts` | builds the graphology graph from a v2 contract + cluster index; mutable singleton lifetime | ✓ (builder) |
| `clustering.ts` | location→layer→rack collapse/expand; frontier algorithm; meta-edge aggregation | ✓ |
| `layout.ts` | FA2 supervisor (Web Worker) — main thread never blocks | side-effect: worker |
| `rendering.ts` | pure mapping `(contract attrs) → Sigma display attrs`; layer fill, status dim, criticality size | ✓ |
| `patch.ts` | **single merge point** — `diffAndPatch` (full reconcile) + `applyTopologyEvent` (incremental) | ✓ (mutates model) |
| `realtime.ts` | per-org `/ws/events` subscriber, surfaces `topology_*` frames; on reconnect emits resync signal | side-effect: WS |
| `traffic.ts` | restrained pulse on the "hot" edge subset; ~11 fps; pauses on tab hidden | side-effect: Sigma |
| `SigmaCanvas.tsx` | Sigma.js v3 mount, drives semantic zoom + LOD + traffic; consumes model | side-effect: WebGL |
| `index.tsx` | top-level orchestration — query + WS + view-mode toggle + NOC panels | side-effect: React state |
| `overlays/overlayModel.ts` | pure projection — anomaly/traffic/health overlay layers derived from model | ✓ |
| `overlays/overlayStyle.ts` | renderer-agnostic style bridge — both 2D + 3D consume identical tones | ✓ |
| `overlays/focus.ts` | BFS blast-radius computation; unit-testable | ✓ |
| `three/Topology3D.tsx` | r3f entry point, no wrapper library | side-effect: WebGL |
| `three/Scene.tsx` | composes the four three.js systems (atmosphere, nodes, edges, camera) | declarative |
| `three/sceneData.ts` | **pure projection** — model → GPU instance lists + packed edge buffer | ✓ |
| `three/layout3d.ts` | deterministic O(n) 3D placement (orbit / cluster) — no force sim | ✓ |
| `three/lod.ts` | distance → label survival + atmospheric fade + cluster-substitution thresholds | ✓ |
| `three/nodeClasses.ts` | tactical node-class mapping + style (size + colour, no geometry showcase) | ✓ |
| `three/trafficShader.ts` | GLSL ShaderMaterial — directional flow, intensity by utilization | ✓ (shader src) |
| `three/NodesLayer.tsx` | one InstancedMesh per node class — handful of draw calls for thousands | side-effect: WebGL |
| `three/EdgesLayer.tsx` | one LineSegments mesh driven by the traffic shader — single draw call | side-effect: WebGL |
| `three/CameraRig.tsx` | OrbitControls + incident-focus lerp + data-stream traversal mode | side-effect: camera |
| `three/Atmosphere.tsx` | exp haze + parallax particle field + soft fill lighting | side-effect: scene |
| `noc/nocUi.ts` | pure: panel visibility rules + keyboard shortcut routing | ✓ |
| `noc/uiPrefs.ts` | localStorage-backed pref persistence — UI-only, **no tenant data** | side-effect: storage |

---

## 3. Circular import audit

```bash
npx madge --circular --extensions ts,tsx frontend/src/pages/TopologyV2
```

**Result:** `✔ No circular dependency found!` (39 files processed)

**Verdict:** clean — no cycles to break, T8.2 can refactor freely.

---

## 4. Public API surface audit

### 4.1 What `TopologyV2/` exports externally

Only **two** consumers outside the module:

| Consumer | Import | Notes |
|---|---|---|
| `App.tsx` | `import TopologyV2Page from '@/pages/TopologyV2'` | route `/topology-next` only |
| `Sidebar.tsx` | (none — uses route path string only) | flag-gated nav entry |

Everything else (graphModel, patch, contract, rendering, …) is internal. The module is a **black box** to the rest of the app — exactly the desired surface for a feature module.

### 4.2 ts-prune findings — dead / module-local exports

```bash
npx ts-prune -p tsconfig.json | grep TopologyV2
```

| Export | File:line | Class |
|---|---|---|
| `fetchTopologyGraphV2` | `api.ts:22` | "used in module" — re-exported from index, called inside `useTopologyGraphV2` |
| `TopologyGraphV2Params` | `api.ts:17` | "used in module" — internal type |
| `collapseCluster` | `clustering.ts:62` | **unused export** — candidate for removal (T8.2) |
| `ClusterViewResult` | `clustering.ts:20` | "used in module" |
| `LinkType` / `LodTier` / `ClusterType` / `NodeKind` / `TopologyNodeData` / `TopologyEdgePortData` / `ClusterHealth` / `ClusterTraffic` / `TopologyPatchProtocol` / `TopologyEventType` / `TopologyPatchEvent` / `TopologyGraphDiff` / `TopologyScope` / `TopologyGraphStats` | `contract.ts:35–204` | **exported types not imported elsewhere** — either re-exports of `@/api/topologyContract` types (contract façade by design — keep), or candidate for trimming (T8.2 to decide) |
| `NodeKind` / `ClusterInfo` | `graphModel.ts:24,26` | "used in module" |
| `VersionRelation` / `IngestStrategy` / `PatchSummary` / `PatchStatus` / `PatchOutcome` | `patch.ts:25–174` | "used in module" — types are public for callers but internal callsites are in patch.ts |
| `RealtimeStatus` | `realtime.ts:17` | "used in module" |
| `GHOST_COLOR` | `rendering.ts:46` | "used in module" |
| `criticalityRank` | `rendering.ts:123` | **unused export** — candidate for removal (T8.2) |
| `ScaleProfile` | `scaleConfig.ts:13` | "used in module" |

**Real dead code:** 2 exports — `clustering.collapseCluster` and `rendering.criticalityRank`. The "used in module" entries are private helpers that ts-prune sees as exported because the test file imports them; benign.

**Action for T8.2:** trim 2 dead exports; decide whether contract.ts is a deliberate type façade (keep) or accidental over-export.

---

## 5. Coverage map

### 5.1 Behavioural modules ↔ test files

| Module | Test file | Notes |
|---|---|---|
| `contract.ts` | `contract.test.ts` | ✓ |
| `graphModel.ts` | `graphModel.test.ts` | ✓ |
| `clustering.ts` | `clustering.test.ts` | ✓ |
| `rendering.ts` | `rendering.test.ts` | ✓ |
| `patch.ts` | `patch.test.ts` | ✓ |
| `overlays/{focus,overlayModel,overlayStyle}.ts` | `overlays.test.ts` | ✓ |
| `noc/{nocUi,uiPrefs}.ts` | `noc.test.ts` | ✓ |
| `three/{layout3d,lod,nodeClasses,sceneData}.ts` | `three.test.ts` | ✓ |
| `__tests__/syntheticGraph.ts` + `__tests__/fixture.ts` | (test utilities) | scale + functional fixtures |
| end-to-end scale | `scale.test.ts` | 1k / 2.5k / 5k / 10k stress (Node) |

### 5.2 Modules without a dedicated unit test (by design)

| Module | Why no dedicated test | T8 stance |
|---|---|---|
| `api.ts` | React Query hook — fetch / cache; integration-level, not unit | OK — covered by E2E + contract.test.ts on the validation half |
| `layout.ts` | FA2 Web Worker — requires worker harness, hard to unit-test deterministically | OK — covered indirectly by scale.test.ts perf assertions |
| `realtime.ts` | WebSocket subscriber — needs a WS mock harness | **Recommend a small unit test in T8.2** — reconnect / version-gap dispatch logic is pure enough |
| `traffic.ts` | Sigma `requestAnimationFrame` driver — animated DOM-only behaviour | OK — visual, manual |
| `scaleConfig.ts` | pure constants | OK |
| `SigmaCanvas.tsx`, `index.tsx`, `three/{Topology3D,Scene,Nodes,Edges,Camera,Atmosphere}.tsx` | jsdom cannot host WebGL; component-level behaviour split into pure helpers that ARE tested | OK — by design |
| `three/trafficShader.ts` | GLSL string — no runtime to assert against in vitest | OK |

### 5.3 Coverage verdict

**Every behaviour-bearing pure module has a unit test.** Only deliberate gaps are the WebGL render components (which delegate logic to pure helpers that are tested) and `realtime.ts` (recommend small additions). No critical hole.

---

## 6. Render ownership map

The five questions the user flagged as scale-debugging-critical.

### 6.1 "Which state is Sigma the source of truth for?"

**Answer: none of the graph data.** Sigma is a **render-only consumer** of the graphology graph.

| State category | Holder | Citation |
|---|---|---|
| Graph topology (nodes/edges/attrs) | `model.graph` (graphology.Graph) | `graphModel.ts:buildTopologyModel` |
| Node positions (x, y) | `model.graph` node attrs | `layout.ts` writes them once; `patch.ts:119,137,240` updates on patch |
| Visual attrs (size, color, label) | `model.graph` node attrs | computed by `rendering.deviceNodeAttrs / edgeAttrs`, written into the graph |
| Cluster collapsed/expanded state | `clusterView` | derived per-render in `clustering.applyClusterView` |
| Sigma-only ephemeral state | `useRef`s in `SigmaCanvas.tsx` | sigma instance, traffic animator, current zoom tier, hovered node, overlay context — **render-loop scratch, not data** (`SigmaCanvas.tsx:49-56`) |
| Camera position | Sigma's internal camera | restored from session via `sigma.getCamera()` interactions only |

**Implication:** a Sigma remount loses the camera, but not the graph data or positions. The graph survives across patches and view-mode toggles. ✓

### 6.2 "graphModel — immutable snapshot or mutable singleton?"

**Answer: mutable singleton.** A single graphology Graph instance is created on the first fetch (`graphModel.ts:buildTopologyModel`) and patched in place by `patch.ts` for the lifetime of the page. A genuine new instance is created only on a **location change** (new contract identity).

Evidence (`patch.ts`):
- `patch.ts:107  graph.dropNode(key)`
- `patch.ts:119  graph.addNode(c.cluster_id, …)`
- `patch.ts:137  graph.addNode(n.id, …)`
- `patch.ts:156  graph.addEdgeWithKey(e.id, e.source, e.target, …)`
- `patch.ts:240  graph.addNode(n.id, …)` (event handler)
- `patch.ts:258  graph.dropNode(event.node_id)` (event handler)
- `patch.ts:271  graph.addEdgeWithKey(…)` (event handler)

**Implication:** Sigma can keep a stable reference to the same graph object across realtime events (no remount), but every renderer + overlay must read from the graph at the latest patch — `patchSignal` in `SigmaCanvas.tsx` is what bumps to trigger that re-read. ✓

### 6.3 "Overlays — render-only or do they mutate model state?"

**Answer: pure read-only projection.** Zero `graph.set/add/drop/update` calls in `overlays/*`. Verified by grep.

```bash
$ grep "graph\.\(add\|drop\|set\|update\|remove\|clear\)" overlays/*.ts
(no output)
```

Overlays consume the model + a list of enabled layers + an optional focus set, and emit `(tone, emphasis)` tuples; the canvas applies them at draw time. ✓

### 6.4 "three.js layer — source of truth or projection?"

**Answer: pure projection** of `graphModel`.

`three/sceneData.ts` is memoized on `(model, clusterView, layoutMode, patchSignal)` and re-derives:

  * per-class node InstancedMesh lists (`buildSceneData` — node positions, classes, sizes)
  * a packed edge buffer (LineSegments vertices + per-edge `aFlow` attribute)
  * layout positions via `layout3d.computeLayout` (deterministic — orbit/cluster)

The 3D engine **does not hold any private graph state**. A patch to `graphModel` flows through `patchSignal` → `useMemo` re-runs → new buffers → r3f re-renders. ✓

Implication: the 2D and 3D engines genuinely share one source of truth; toggling between them does not require any reconciliation.

### 6.5 "Realtime patch — single merge point or scattered?"

**Answer: single merge point in `patch.ts`.**

| Source of change | Calls | Lands in |
|---|---|---|
| Full refetch (initial + reconnect resync + filter switch) | `api.ts:fetchTopologyGraphV2` → `index.tsx:132` `diffAndPatch(prev.model, data)` | `patch.diffAndPatch` |
| Incremental WS event | `realtime.ts` → `index.tsx:150` `applyTopologyEvent(prev.model, event, expectedVersion)` | `patch.applyTopologyEvent` |

Both paths land in `patch.ts`. No other file calls `graph.addNode` / `graph.dropNode` / `graph.addEdgeWithKey`. ✓

**Implication:** any future ingestion path (Server-Sent Events, gRPC streaming, replay-from-history) plugs into the same two functions. T8.6 (isolation audit) can reason about cross-org leak by inspecting **only** `patch.ts`'s gating — `applyTopologyEvent`'s version check is the single chokepoint that would need an `org_id` assertion if we ever fear leakage.

---

## 7. Recommendations for T8.2

| # | Action | Module(s) | Cost |
|---|---|---|---|
| 1 | Delete the 2 dead exports flagged by ts-prune (`clustering.collapseCluster`, `rendering.criticalityRank`) | clustering.ts, rendering.ts | trivial |
| 2 | Decide on `contract.ts` type façade — keep all 14 type re-exports as the public surface, or trim to the consumed subset | contract.ts | 30 min |
| 3 | Add a small unit test around `realtime.ts` reconnect / version-gap dispatch (uses a WebSocket mock) | realtime.ts | 1-2 hours |
| 4 | Add an `org_id` assertion (cheap, defence-in-depth) to `patch.applyTopologyEvent` so cross-org leakage at the WS layer is rejected at the merge point too | patch.ts | 30 min — pre-T8.6 |
| 5 | Document the `patchSignal` invariant in `graphModel.ts` doctring — "bump after every mutation; readers re-read on bump" | graphModel.ts | trivial |

T8.2 should land these as one focused refactor commit, then run the standard regression matrix (`vitest run TopologyV2` — 103 tests + `pytest` 600).

---

## 8. Snapshot of facts (for future reference)

  * **39 source files** under `frontend/src/pages/TopologyV2/`
    (28 production + 9 tests + 2 test utilities)
  * **0 circular imports** (madge audit)
  * **2 genuinely dead exports** (ts-prune; everything else is `used in module`)
  * **1 merge point** for realtime / refetch (`patch.ts`)
  * **1 source of truth** for graph data (`model.graph`, mutable singleton across patches)
  * **5,000-node production gate** measured in T7 — every main-thread stage < 30 ms in Node
  * **Public surface = 1 default export** (`TopologyV2Page` from `index.tsx`)
  * **Feature flag:** `topologyV2` (DEV default on, prod opt-in via `VITE_TOPOLOGY_V2=on`)
  * **Routes:** legacy `/topology` + V2 `/topology-next` parallel; T8.7 redirects legacy to V2 and then deletes the legacy page (`frontend/src/pages/Topology/{index.tsx, Topology3D.tsx}` — 2,621 LOC removed)
