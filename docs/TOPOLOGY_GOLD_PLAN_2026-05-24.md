# Topology Final Gold Release — Phase Plan (T4.1 – T4.6)

Branch: `topology-gold/T8.4-noc-design` · local only

## TL;DR
TopologyV2 (`/topology-next`) already exists, is ≈70% built, and is
**performance-tested green at 1k–10k nodes** (Sigma.js v3 + graphology +
ForceAtlas2 worker; r3f for 3D with LOD + instanced meshes). The
"Final Gold" work is **promotion + NOC design language + RBAC + a few
hardening touches**, not a new engine.

The classic `/topology` (React Flow) stays alive throughout and remains
the canonical route until **T4.6**, where V2 becomes canonical behind a
kill-switch flag (`topologyV2Canonical`).

## Engine decision
**Keep Sigma.js v3 + graphology.** Already in tree, already benched at
52–60 fps with 10k nodes, single mutation point invariant (`patch.ts`),
delta clustering, partial refresh. React Flow / Cytoscape would be a
total rewrite for worse perf. Classic React Flow page stays as a
permanent escape hatch at `/topology-classic`.

## Phases (one commit each)

| # | Phase | Scope | Risk |
|---|---|---|---|
| **T4.1** | NOC design language + RBAC sweep on `/topology-next` | Wrap V2 chrome in `nm-page-hd` / `nm-statbar` / `nm-card`, replace 3 ad-hoc empties with `NmEmpty`, gate every mutating button on `can('topology','create')`. **No data-path change.** | Low |
| **T4.2** | Focus / incident modes wired to backend | Right-panel "Patlama Yarıçapı" button → `/topology/blast-radius/{id}`. "Olay Modu" toggle → `/topology/anomalies` + highlight via existing `OverlayContext.focus`. `N` key cycles anomalies. | Low |
| **T4.3** | Topology-first fullscreen layout | `?wall=1` enters presentation + fullscreen; chrome auto-hides after 8 s of idle; statbar stays pinned. Kiosk-friendly. | Low |
| **T4.4** | WS backpressure cap | If inbound rate > 200/s over 2 s window → switch to poll-only fallback (15 s) + warning card. Auto-recover. Improves yellow `ws-patch-flood-10k` cell. | Medium (alters realtime contract on overload) |
| **T4.5** | Location switch race / epoch ref | Bump epoch on every `activeLocationId` change; `handleEvent` drops stale-epoch frames; verify `wsPathForLocation` rebuilds on swap. | Low |
| **T4.6** | Cutover V2 → canonical `/topology` | App.tsx flag-gated route swap; `/topology-classic` permanent kill-switch; nav tooltip linking to classic. | Medium (visible user-facing change) |

## Risks (top 3)
1. **R1 `react-force-graph-3d` StrictMode crash** — classic page only; T4.6 cutover removes from the primary path. **Do not modify** `Topology/Topology3D.tsx`.
2. **R3 WS frame storm** — discovery sweep burst on 1000 devices. T4.4 addresses.
3. **R6 Operator muscle memory** — `/topology` was React Flow forever. Kill-switch + classic route + tooltip mitigate.

## Out of scope (explicit)
- Classic `/topology` page rewrites (only the route swap in T4.6).
- TopologyTwin (`/topology-twin`) — different feature.
- Backend changes (no new endpoints; existing `/graph?v=2`, `/anomalies`, `/blast-radius`, `/discover*`, `/ws/events`).
- 3D engine swap (r3f custom pipeline stays).
- VPS deploy + push to origin.
- New realtime protocol events.

## Critical files
- `frontend/src/pages/TopologyV2/index.tsx` — primary touch
- `frontend/src/pages/TopologyV2/noc/nocUi.ts` — key map
- `frontend/src/pages/TopologyV2/realtime.ts` — backpressure helper
- `frontend/src/App.tsx` — route swap at T4.6
- `frontend/src/config/featureFlags.ts` — kill-switch
- `frontend/src/components/Layout/useNavGroups.tsx` — nav cutover

## Approval gates
- After each Tx commit: user verifies the smoke listed in the plan section, approves before next phase. With the explicit "tamam devam edebilirsin sonra kontrol edeceğim" the agent may chain T4.1 → T4.5 autonomously, halt before T4.6 for explicit go.

## Full plan text
See the Plan agent transcript in conversation history for the verbatim recon, data-shape walkthrough, and the T4.1 ready-to-implement spec (file paths, function signatures, exact JSX replacements).
