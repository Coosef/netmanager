# Topology "Final Gold Release" — Architecture & Design Plan

> **Status:** Approved workstream charter. Engine/scale decisions confirmed (§7).
> Execution starts with **T0 — foundation hardening**, then 2D engine, then 3D.
> **Branch:** `feature/topology-final-gold-release` (off the frozen Faz 7 baseline `faz7-phase6-complete`).
> **Predecessor:** Faz 7 multi-tenant isolation — complete, frozen, see [M6_LEGACY_DROP_BACKLOG.md](M6_LEGACY_DROP_BACKLOG.md).

---

## 1. Context

The platform now has a DB-enforced multi-tenant foundation (PostgreSQL RLS scoped
by `organization_id` + `location_id`). The topology subsystem was scoped *only*
for data isolation during Faz 7 — its rendering and UX were left untouched and
are not production-grade for enterprise scale.

**Why this workstream:** the current topology is a single 2,050-LOC page using a
DOM-based renderer (React Flow) that degrades past a few hundred nodes, a 3D view
built on a thin wrapper library (`react-force-graph-3d`) with limited control and
a StrictMode incompatibility, a main-thread O(N²) force layout, and realtime that
only patches device online/offline. For a platform targeting 1000+ devices per
organization across many locations, topology must become a first-class,
NOC-grade, scalable visualization system.

**Intended outcome:** a topology-first product surface — a 2D enterprise engine
and a 3D tactical engine — that renders dense networks readably, scales to
thousands of nodes, surfaces AI/anomaly intelligence visually, and **preserves
strict tenant isolation end-to-end**.

**Hard constraint:** every topology data path — queries, realtime events, cache,
WebSocket streams, analytics, AI anomaly overlays — must remain org/location
scoped. The redesign builds *on top of* the RLS model; it must not reintroduce a
shared, unscoped view.

---

## 2. Scope

In scope (user-defined):
1. 2D topology — complete enterprise redesign
2. 3D topology — tactical engine redesign
3. Topology-first UI/UX
4. Production-grade readability
5. Enterprise hierarchy (org → location → layer → rack → device)
6. Dense-but-readable rendering
7. AI / tactical visualization systems
8. Fullscreen NOC experience
9. Intelligent traffic rendering
10. Scalable rendering for large enterprise environments

Out of scope: the M6 legacy `tenant_id` drop (tracked separately); non-topology
pages; new discovery protocols (LLDP/CDP/SNMP discovery stays as-is).

---

## 3. Current-state assessment

### 3.1 Frontend (`frontend/src/pages/Topology/`)
| Aspect | Today | Limitation |
|---|---|---|
| 2D engine | React Flow `@xyflow/react`, DOM/SVG nodes | DOM ceiling ~300–500 nodes; dense graphs unreadable |
| 3D engine | `react-force-graph-3d` + three.js wrapper | Limited control; StrictMode-incompatible; no LOD/instancing |
| Layout | `layout.ts` — force/dagre/grid/circle, **main thread**, ≤200 iters | Blocks UI on large graphs; O(N²) repulsion |
| Data | React Query key `['topology-graph', group, activeSite]` | ✓ already location-scoped |
| Realtime | `/ws/events`, handles only `device_offline/online` | No link/node/drift events; full 60s refetch otherwise |
| UX | Single 2,050-LOC `index.tsx`; 2D/3D tab; fullscreen; filters; legend | Monolith; not NOC-first; no semantic zoom/clustering |
| Density | Circle→grid fallback at >250 nodes; no clustering | No aggregation, no LOD, no viewport culling |
| Styling | Ant Design + inline styles; dark/light | OK; topology-specific design system needed |

### 3.2 Backend (`backend/app/.../topology*`)
Faz 7 isolation is ~95% complete. Solid: `topology_links` has org+location
columns and RLS; `/topology/graph` cache key is `topology:graph:o={org}:l={loc}:…`;
discovery tasks stamp `organization_id`.

**Isolation gaps to close as this workstream's foundation:**
- **G-A** `hop_discover_task` (`topology_tasks.py`) sets no org context → RLS sees
  NULL org → zero rows / silent failure.
- **G-B** `check_topology_drift` (`behavior_analytics_tasks.py`) sets no org context.
- **G-C** `TopologySnapshot` has `organization_id` but no `location_id` — snapshots
  cannot be location-scoped.
- **G-D** No dedicated *topology* realtime event — link up/down, node add/remove,
  drift are not pushed on the per-org channel; UI relies on a 60s poll.
- **G-E** `topology.py` / `build_graph()` still carry legacy `TenantFilter` /
  `LocationNameFilter` / `tenant_id` params (dead under RLS, should be removed).

---

## 4. Target architecture

### 4.1 Rendering engine strategy (key decision)

DOM-based React Flow cannot meet "scalable for large enterprise environments."
The redesign commits to **WebGL rendering** for both engines (confirmed — §7).

**2D engine — Sigma.js v3 + graphology.**
- **Sigma.js v3** (WebGL-native) with **graphology** as the graph model + layout
  (`graphology-layout-forceatlas2`, runnable in a Web Worker). Purpose-built for
  large graphs, WebGL by default, clean separation of model / layout / render.
- React Flow is retained *only* if a small-graph "editor" mode is wanted later;
  not for the primary view. **One primary engine** — no dual maintenance.

**3D engine — custom react-three-fiber tactical engine.**
- Replace `react-force-graph-3d` with a custom **react-three-fiber (r3f)** engine:
  **instanced meshes** for nodes (one draw call for thousands), **LOD** (geometry +
  label detail by camera distance), custom **GLSL shaders** for traffic flow and
  anomaly pulse, layered Z-strata for enterprise hierarchy, GPU-friendly edge
  rendering (lines/ribbons), and a cinematic camera system. r3f integrates with
  React without the wrapper's StrictMode crash (the crash is the wrapper's, not
  three.js's).

### 4.2 Rendering pipeline (shared, both engines)
- **Layout off the main thread** — force/hierarchical layout in a **Web Worker**;
  stream positions back; main thread never blocks.
- **Semantic zoom + LOD** — far: clusters/aggregates; mid: nodes + status; near:
  full detail (ports, labels, traffic).
- **Clustering / aggregation** — collapsible groups by **location → layer → rack**;
  a cluster node expands on zoom/click. This is the core "dense-but-readable" lever.
- **Viewport culling** — only render what's in view (native to Sigma/r3f-instancing).
- **Incremental updates** — realtime patches mutate the graph model in place; no
  full re-layout (pin existing nodes, layout only the delta).

### 4.3 Enterprise hierarchy model
Topology is presented as a navigable hierarchy, not a flat graph:
`Organization → Location(s) → Layer (core/distribution/access/edge/wireless) →
Rack → Device → Port/Link`. The graph supports drill-down (location overview →
intra-location fabric) and roll-up (collapse a location to a single super-node).
Backend `build_graph()` returns hierarchy metadata; the cluster tree is derived
client-side. Uses existing `Device.layer`, `location_id`, and `racks`.

### 4.4 Topology-first UI/UX & NOC experience
- Restructure the monolithic `index.tsx` into a feature module:
  `engine2d/`, `engine3d/`, `panels/`, `realtime/`, `state/`, `hooks/`.
- **NOC fullscreen mode** — borderless, dark, large-format: live graph + incident
  ticker + anomaly heat + KPI strip; designed for wall displays.
- **Focus / incident mode** — select a device/incident → dim the rest, trace
  blast-radius and paths (reuse existing `/topology/blast-radius/{id}`).
- Command palette, fast search, layer/vendor/status filters, legend, minimap,
  saved views. Topology becomes a primary landing surface, not a sub-tab.

### 4.5 Intelligent traffic rendering
Animated, throttled edge flow encoding direction + magnitude from
`snmp_poll_results` utilization (already joined into links by `build_graph`).
Shader-driven in 3D (flow along the edge), animated dashes/particles in 2D.
Color-graded by utilization; widened by capacity. LOD-gated (off when zoomed out).

### 4.6 AI / anomaly / tactical visualization
Overlay, on the graph, data already produced by the backend:
- `/topology/anomalies` — duplicate hostname, asymmetric/stale links, ghost overload.
- Correlation **incidents** + **behavior-analytics topology drift**.
Visual language: anomaly heat halos, pulsing problem nodes, drift diff (added /
removed links since the golden `TopologySnapshot`), blast-radius animation.
A "tactical" overlay mode aggregates these into a NOC threat view.

### 4.7 Realtime topology stream (closes gap G-D)
- Backend: emit dedicated topology events — `topology_link_up/down`,
  `topology_node_added/removed`, `topology_drift` — through the existing
  `publish_network_event()` so they land on the **per-org** channel
  `network:events:org:{org}` (org derived from `device_id`; Faz 7 phase 6d).
- Frontend: the topology realtime layer subscribes to `/ws/events` (already
  org-scoped server-side) and **patches the graph model incrementally** — no full
  refetch. The 60s poll becomes a slow safety-net reconciler.

### 4.8 Tenant isolation — preserved end-to-end
| Path | Mechanism (unchanged or hardened) |
|---|---|
| Topology queries | RLS on `devices` / `topology_links`; scoped session; drop legacy `tenant_id` params (G-E) |
| Realtime events | per-org `network:events:org:{org}` channel; WS resolves org from token (Faz 7 6d) |
| Topology cache | `topology:graph:o={org}:l={loc}:…` key (already namespaced) |
| WebSocket streams | `/ws/events` org-scoped subscribe; `?location=` filter |
| Topology analytics | fix worker org context — G-A `hop_discover_task`, G-B `check_topology_drift` |
| AI anomaly viz | `/topology/anomalies` + incidents under RLS-scoped session |
| Snapshots | add `location_id` to `TopologySnapshot` (G-C) for location-scoped diffs |

No client-trusted scope: the frontend never *sends* an org id; the server derives
it. Location is an advisory filter (`X-Location-Id` / `?location=`), org is the
hard boundary.

---

## 5. Phased roadmap (proposed)

Each phase is independently shippable and ends with a verification gate.

- **T0 — Foundation hardening.** Close G-A/G-B (worker org context), G-C
  (`TopologySnapshot.location_id` migration), G-E (remove legacy `tenant_id` /
  `TenantFilter` from `topology.py` + `build_graph`). Backend only; no UX change.
- **T1 — Backend topology contract.** Extend `/topology/graph` to return
  hierarchy + cluster metadata + capacity/utilization; add the dedicated topology
  realtime events (G-D). Versioned response; old UI still works.
- **T2 — 2D enterprise engine.** New WebGL 2D engine (Sigma/graphology),
  Web-Worker layout, semantic zoom, clustering by location/layer/rack, viewport
  culling. Feature-flagged alongside the old page.
- **T3 — Realtime + traffic.** Incremental graph patching from the per-org
  stream; intelligent traffic rendering.
- **T4 — 3D tactical engine.** Custom r3f engine — instancing, LOD, shader
  traffic/anomaly, layered hierarchy. Replaces `react-force-graph-3d`.
- **T5 — AI / anomaly / tactical overlays.** Anomaly heat, drift diff,
  incident/blast-radius visualization, tactical NOC overlay.
- **T6 — Topology-first UX & NOC mode.** Module restructure, fullscreen NOC,
  focus/incident mode, command palette, saved views; retire the old page.
- **T7 — Scale hardening.** Load-test at 1k / 5k / 10k synthetic nodes; profile
  FPS, layout time, memory; tune LOD/clustering thresholds.

Sequencing rule: T0 first (isolation foundation); 2D (T2–T3) before 3D (T4);
overlays (T5) after both engines exist; UX consolidation (T6) last.

---

## 6. Critical files

**Backend:** `app/api/v1/endpoints/topology.py`, `app/services/topology_service.py`,
`app/models/topology.py`, `app/models/topology_snapshot.py` (+ new `location_id`
migration), `app/workers/tasks/topology_tasks.py`,
`app/workers/tasks/behavior_analytics_tasks.py`, `app/core/event_publish.py`.

**Frontend:** `src/pages/Topology/` (restructure into a feature module),
`src/api/topology.ts`, `src/api/topologyTwin.ts`, `src/contexts/SiteContext.tsx`
(query-key scoping — keep), `src/api/client.ts` (`X-Location-Id` — keep).

**Reuse:** existing layout algorithms in `layout.ts` (port the maths into the
worker); `/topology/blast-radius/{id}` for focus mode; `publish_network_event()`
for the per-org realtime stream; the Faz 7 RLS scoped session.

---

## 7. Confirmed decisions

1. **2D engine — Sigma.js v3 + graphology.** WebGL rendering, semantic zoom,
   clustering and large-graph performance; highest ceiling for dense enterprise
   topology.
2. **3D engine — custom react-three-fiber tactical engine.** Full control over
   instancing, LOD, shaders, traffic animation, AI overlays and cinematic camera
   systems. The thin `react-force-graph-3d` wrapper is discontinued.
3. **Migration — feature-flagged parallel rollout.** The new 2D/3D engines live
   alongside the current topology page behind a flag until verified. No hard
   cutover.
4. **Scale target — 5,000 nodes per view (production target).** Architect for
   graceful degradation toward 10,000 nodes via clustering/LOD, but do not
   optimize for 10k at the expense of UX. LOD/clustering thresholds are
   dimensioned for the 5k target.

---

## 8. Verification (per phase)

- **Isolation (every phase):** org-A session never sees org-B nodes/links/events;
  no-context query → 0 rows; topology cache keys carry `o=`/`l=`; the per-org
  realtime channel never delivers another org's topology event. Re-run the Faz 7
  closure-style scoped-context checks against topology tables.
- **Functionality:** graph renders correctly vs known fixtures; clustering
  expand/collapse; realtime link/node patch without full refetch; traffic +
  anomaly overlays reflect backend data.
- **Performance (T7):** **5,000-node** synthetic graph is the production gate —
  sustained ≥30 FPS pan/zoom, layout under target, no main-thread block, memory
  bounded. A 10,000-node graph must still be usable via clustering/LOD (graceful
  degradation), not necessarily at full FPS. Also profile 1k as the common case.
- **Regression:** existing topology endpoints + discovery unaffected; backend
  test suite green; no RLS / NOT NULL errors in logs.

---

## 9. T7 — Scale hardening results

The 5,000-node production gate. Synthetic fixtures
(`__tests__/syntheticGraph.ts`, test/dev only — no production path
references them) drive the benchmark harness (`__tests__/scale.test.ts`,
run `npx vitest run scale`).

### Measured main-thread pipeline (in-container, Node)

| Stage | 1k | 2.5k | 5k | 10k (stress) |
|---|---|---|---|---|
| buildTopologyModel | 6 ms | 10 ms | 12 ms | 29 ms |
| computeLayout (orbit/cluster) | ~2 ms | ~2 ms | ~6 ms | — |
| applyClusterView | 3 ms | 8 ms | 7 ms | — |
| deriveOverlayModel | 1 ms | 1 ms | 2 ms | — |
| buildSceneData (3D) | 3 ms | 2 ms | 3 ms | 11 ms |
| diffAndPatch | 4 ms | 6 ms | 11 ms | — |

Every main-thread stage is **< 30 ms at 5k** — well inside one frame
budget for an interaction, and far below the 1500 ms regression ceiling.
The ForceAtlas2 force layout runs in a **Web Worker** (off the main
thread) and is excluded above. WebGL rendering is GPU-bound: Sigma (2D)
and instanced three.js (3D) carry 5k nodes / ~7k edges.

### Tuning — size-adaptive (`scaleConfig.ts`)

| Device count | Default tier | Sigma label threshold | Traffic-pulse cap |
|---|---|---|---|
| < 800 | `device` (fully exploded) | 6 | 600 |
| 800–2k | `layer` | 7 | 600 |
| 2k–4k | `layer` | 9 | 500 |
| ≥ 4k (5k gate) | `layer` | 12 | 400 |

Static thresholds (documented in `scaleConfig.ts`): semantic-zoom tiers
(camera ratio 1.6 / 0.7), label priority per tier (≤1 / ≤2 / ≤3), 3D LOD
(near 360 / mid 900 / fade 750→1700 / cluster substitution 1150), 3D
instancing (one InstancedMesh per node class — 7 + cluster bucket).

### Stability at scale (verified)

A 5k graph: a location switch still triggers a clean rebuild; a
`graph_version` gap still forces a controlled refetch; `diffAndPatch`
stays incremental (same graphology instance — no remount); cluster
collapse/expand and incident focus stay < 30 ms.

### Verdict

1k smooth · 2.5k operationally usable · **5k acceptable** with the
size-adaptive layer-tier default + LOD · 10k completes (build 29 ms) as
a graceful-degradation stress case, not the primary target.
