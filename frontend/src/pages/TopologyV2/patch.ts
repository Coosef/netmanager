/**
 * Realtime patch engine — applies v2 topology changes to the live
 * graphology graph WITHOUT rebuilding it, so Sigma never remounts.
 *
 * Two entry points:
 *   - `diffAndPatch`      — reconcile the graph against a freshly fetched
 *                           contract (used after a poll / controlled refetch)
 *   - `applyTopologyEvent` — apply a single `topology_*` realtime event
 *
 * `graph_version` reconciliation: every event carries a monotonic
 * version. An event at `expected+1` is applied in sequence; `<= expected`
 * is a stale replay and dropped; `> expected+1` is a gap (missed events)
 * and triggers a controlled refetch. Bulk / structural events also
 * refetch — a precise in-place patch is only attempted when the event
 * carries enough data.
 */
import type { TopologyGraphV2, TopologyNode, TopologyEdge } from './contract'
import {
  buildClusterIndex, deviceNodeAttrs, clusterNodeAttrs, edgeAttrs,
  seedPosition, styleGraph, restyleNode, restyleEdge,
  clusterPath, type TopologyModel,
} from './graphModel'

// ── version reconciliation ────────────────────────────────────────────────

export type VersionRelation = 'stale' | 'next' | 'gap'

export function reconcileVersion(
  eventVersion: number,
  expectedVersion: number,
): VersionRelation {
  if (eventVersion <= expectedVersion) return 'stale'
  if (eventVersion === expectedVersion + 1) return 'next'
  return 'gap'
}

// ── contract-ingest strategy ──────────────────────────────────────────────

export type IngestStrategy = 'rebuild' | 'patch' | 'skip'

/**
 * Decide how to absorb a freshly fetched contract:
 *   - `rebuild` — first load, or the active location changed ⇒ a clean
 *                 new model (the engine remounts; isolation is reset)
 *   - `skip`    — identical graph_version ⇒ a no-op poll, ignore
 *   - `patch`   — same location, newer version ⇒ diff in place
 */
export function ingestStrategy(
  prev: { locationId: number | null; graphVersion: number } | null,
  contract: TopologyGraphV2,
  currentLocationId: number | null,
): IngestStrategy {
  if (!prev || prev.locationId !== currentLocationId) return 'rebuild'
  if (contract.graph_version === prev.graphVersion) return 'skip'
  return 'patch'
}

// ── full-contract diff ────────────────────────────────────────────────────

export interface PatchSummary {
  nodesAdded: number
  nodesRemoved: number
  nodesUpdated: number
  edgesAdded: number
  edgesRemoved: number
  edgesUpdated: number
}

const EMPTY_SUMMARY: PatchSummary = {
  nodesAdded: 0, nodesRemoved: 0, nodesUpdated: 0,
  edgesAdded: 0, edgesRemoved: 0, edgesUpdated: 0,
}

/** Place a freshly-added node near its cluster's existing members. */
function placeNewNode(model: TopologyModel, clusterId: string | null): { x: number; y: number } {
  const info = clusterId ? model.clusters.get(clusterId) : null
  const members = info?.memberDeviceKeys.filter((k) => model.graph.hasNode(k)) ?? []
  if (!members.length) return seedPosition(clusterId || Math.random().toString())
  let sx = 0
  let sy = 0
  for (const k of members) {
    sx += model.graph.getNodeAttribute(k, 'x') as number
    sy += model.graph.getNodeAttribute(k, 'y') as number
  }
  return { x: sx / members.length + (Math.random() - 0.5) * 40, y: sy / members.length + (Math.random() - 0.5) * 40 }
}

/**
 * Reconcile the in-memory graph with a freshly fetched contract — add /
 * update / remove nodes + edges in place. Mutates `model`; the graphology
 * Graph instance is preserved so the bound Sigma renderer is not remounted.
 */
export function diffAndPatch(model: TopologyModel, contract: TopologyGraphV2): PatchSummary {
  const { graph } = model
  const summary: PatchSummary = { ...EMPTY_SUMMARY }

  const { clusters, rootClusterIds } = buildClusterIndex(contract)
  const contractNodeIds = new Set(contract.nodes.map((n) => n.id))
  const contractClusterIds = new Set(contract.clusters.map((c) => c.cluster_id))
  const contractEdgeIds = new Set(contract.edges.map((e) => e.id))

  // ── remove vanished nodes (drops their edges automatically) ─────────────
  for (const key of [...graph.nodes()]) {
    const kind = graph.getNodeAttribute(key, 'nodeKind')
    const gone =
      kind === 'cluster' ? !contractClusterIds.has(key) : !contractNodeIds.has(key)
    if (gone) {
      graph.dropNode(key)
      summary.nodesRemoved++
    }
  }

  // ── cluster nodes ───────────────────────────────────────────────────────
  for (const c of contract.clusters) {
    const attrs = clusterNodeAttrs(c)
    if (graph.hasNode(c.cluster_id)) {
      graph.mergeNodeAttributes(c.cluster_id, attrs)
    } else {
      const p = seedPosition(c.cluster_id)
      graph.addNode(c.cluster_id, { x: p.x, y: p.y, ...attrs })
      summary.nodesAdded++
    }
  }

  // ── device / ghost nodes ────────────────────────────────────────────────
  let deviceCount = 0
  let ghostCount = 0
  for (const n of contract.nodes) {
    if (n.kind === 'device') deviceCount++
    else ghostCount++
    const attrs = deviceNodeAttrs(n, clusters)
    if (graph.hasNode(n.id)) {
      // preserve layout position; refresh everything else
      graph.mergeNodeAttributes(n.id, attrs)
      summary.nodesUpdated++
    } else {
      const p = placeNewNode(model, n.data.cluster_id ?? null)
      graph.addNode(n.id, { x: p.x, y: p.y, ...attrs })
      summary.nodesAdded++
    }
  }

  // ── edges ───────────────────────────────────────────────────────────────
  for (const edge of [...graph.edges()]) {
    if (graph.getEdgeAttribute(edge, 'edgeKind') === 'meta') continue
    if (!contractEdgeIds.has(edge)) {
      graph.dropEdge(edge)
      summary.edgesRemoved++
    }
  }
  for (const e of contract.edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
    if (graph.hasEdge(e.id)) {
      graph.mergeEdgeAttributes(e.id, edgeAttrs(e))
      summary.edgesUpdated++
    } else {
      graph.addEdgeWithKey(e.id, e.source, e.target, edgeAttrs(e))
      summary.edgesAdded++
    }
  }

  model.clusters = clusters
  model.rootClusterIds = rootClusterIds
  model.deviceCount = deviceCount
  model.ghostCount = ghostCount
  model.graphVersion = contract.graph_version
  styleGraph(model)
  return summary
}

// ── single-event patch ────────────────────────────────────────────────────

/**
 * Outcome statuses for an incoming realtime event.
 *
 *   - `applied`                 — the graph was mutated in place
 *   - `stale`                   — graph_version < expected (replay) — dropped
 *   - `refetch`                 — gap (missed events) or a bulk / structural
 *                                 event the caller should resync from a fresh
 *                                 contract
 *   - `drift`                   — `topology_drift` UI signal (no mutation)
 *   - `ignored_scope_mismatch`  — T8.2 defence-in-depth: the event's
 *                                 organization_id / location_id does not
 *                                 match the active session scope. Cross-org
 *                                 leakage at the WS layer is a release
 *                                 blocker (T8.6); rejecting at this single
 *                                 merge point closes the door.
 *   - `invalid_payload`         — the granular event is missing the data
 *                                 it needs to apply (e.g. `node_added`
 *                                 without `node`); a refetch is safer than
 *                                 a partial update, so callers still
 *                                 resync, but the status name surfaces the
 *                                 distinction in logs / metrics.
 */
export type PatchStatus =
  | 'applied'
  | 'stale'
  | 'refetch'
  | 'drift'
  | 'ignored_scope_mismatch'
  | 'invalid_payload'

export interface PatchOutcome {
  status: PatchStatus
  /** The version the caller should now expect. */
  version: number
}

/** Realtime topology event as delivered on the per-org `/ws/events` channel. */
export interface TopologyEvent {
  event_type: string
  graph_version: number
  organization_id?: number
  location_id?: number | null
  ts?: string
  node?: TopologyNode
  edge?: TopologyEdge
  node_id?: string
  edge_id?: string
  changes?: Record<string, unknown>
  [key: string]: unknown
}

/** Active session scope (org + optional location) for the scope guard. */
export interface PatchScope {
  /** Active organization id — must match `event.organization_id` if present. */
  orgId: number | null
  /** Active location id — when non-null, must match `event.location_id`
   *  if the event carries one. `null` = ALL LOCATIONS, accepts any. */
  locationId: number | null
}

/**
 * T8.2 scope guard — return `true` if the event is in-scope for the
 * active session (or no scope was provided). The check is permissive on
 * missing fields: an event without `organization_id` is treated as
 * legacy / system and allowed; the org guard kicks in only when both
 * sides declare an id and they disagree.
 *
 * Exported for direct unit testing; the integrated check happens inside
 * `applyTopologyEvent`.
 */
export function eventInScope(event: TopologyEvent, scope: PatchScope | null): boolean {
  if (!scope) return true
  // Org check — the hard isolation boundary.
  if (
    scope.orgId != null &&
    event.organization_id != null &&
    event.organization_id !== scope.orgId
  ) {
    return false
  }
  // Location check — narrows only when the session has a specific location.
  // ALL LOCATIONS (scope.locationId === null) accepts every event.
  if (
    scope.locationId != null &&
    event.location_id != null &&
    event.location_id !== scope.locationId
  ) {
    return false
  }
  return true
}

const GRANULAR = new Set([
  'topology_node_added', 'topology_node_updated', 'topology_node_removed',
  'topology_edge_added', 'topology_edge_updated', 'topology_edge_removed',
])

/**
 * Bulk / structural event types — well-formed but too coarse for a
 * granular in-place patch; the caller resyncs from a fresh contract.
 * `topology_drift` is handled separately above (its own UI state).
 * An event_type with the `topology_` prefix that is in neither
 * `GRANULAR` nor `KNOWN_BULK` is treated as `invalid_payload`, NOT
 * silently refetched — refusing to refetch on an unrecognised name
 * surfaces a backend / frontend contract drift in logs instead of
 * masking it as a redundant fetch.
 */
const KNOWN_BULK = new Set([
  'topology_links_updated',
  'topology_links_replaced',
])

/**
 * Apply one realtime event. The graph mutates only on `applied`; `drift`
 * is a UI-state signal; `refetch` asks the caller to pull a fresh
 * contract; `stale` is a dropped replay; `ignored_scope_mismatch` is
 * the cross-org / cross-location defence-in-depth reject;
 * `invalid_payload` is a malformed granular event.
 *
 * `currentScope` is optional for backwards-compat — when omitted, the
 * scope check is skipped. Callsites in the engine should pass a scope
 * derived from the auth-store / SiteContext so the guard runs.
 */
export function applyTopologyEvent(
  model: TopologyModel,
  event: TopologyEvent,
  expectedVersion: number,
  currentScope: PatchScope | null = null,
): PatchOutcome {
  // T8.2 — scope guard FIRST. A cross-org event must never reach the
  // mutation paths even by accident; rejecting here is the cheapest
  // and most localised place to do it.
  if (!eventInScope(event, currentScope)) {
    return { status: 'ignored_scope_mismatch', version: expectedVersion }
  }

  const rel = reconcileVersion(event.graph_version, expectedVersion)
  if (rel === 'stale') return { status: 'stale', version: expectedVersion }
  if (rel === 'gap') return { status: 'refetch', version: expectedVersion }

  // in sequence (expected + 1)
  if (event.event_type === 'topology_drift') {
    return { status: 'drift', version: event.graph_version }
  }
  if (KNOWN_BULK.has(event.event_type)) {
    // structural change (links_updated, …) — well-formed but coarse,
    // resync from a fresh contract.
    return { status: 'refetch', version: expectedVersion }
  }
  if (!GRANULAR.has(event.event_type)) {
    // Neither granular nor known-bulk — an unrecognised event type is
    // a contract drift, not a refetch. Surface it.
    return { status: 'invalid_payload', version: expectedVersion }
  }

  const { graph } = model
  // T8.3.E1 — scoped restyle per event. The pre-E1 implementation
  // called `styleGraph(model)` (O(N+E) full sweep) after every
  // successful event; for a `ws-patch-flood` burst at 10 k that
  // amounted to ~250 full sweeps and saturated the main thread.
  // The scoped variants update only the touched element. Visual
  // outcome is identical: a node/edge whose attributes change gets
  // exactly the same style derivation `styleGraph` would have
  // produced for it.
  const okNode = (nodeId: string): PatchOutcome => {
    restyleNode(model, nodeId)
    return { status: 'applied', version: event.graph_version }
  }
  const okEdge = (edgeId: string): PatchOutcome => {
    restyleEdge(model, edgeId)
    return { status: 'applied', version: event.graph_version }
  }
  /** Variant for events that don't restyle anything (removals — the
   *  element is gone). */
  const okNoRestyle = (): PatchOutcome => ({ status: 'applied', version: event.graph_version })

  // Distinguish two failure modes for granular events (T8.2):
  //   * malformed payload  → `invalid_payload` (the event itself is broken)
  //   * out-of-sync graph  → `refetch`        (event is well-formed but the
  //                                            local graph cannot apply it
  //                                            in place — resync required)
  const invalid = (): PatchOutcome => ({ status: 'invalid_payload', version: expectedVersion })
  const resync = (): PatchOutcome => ({ status: 'refetch', version: expectedVersion })

  switch (event.event_type) {
    case 'topology_node_added': {
      const n = event.node
      if (!n) return invalid()
      if (graph.hasNode(n.id)) return okNode(n.id)
      // only safe to apply in place when the hierarchy already exists
      const cid = n.data.cluster_id ?? null
      if (cid && !model.clusters.has(cid)) return resync()
      const p = placeNewNode(model, cid)
      graph.addNode(n.id, { x: p.x, y: p.y, ...deviceNodeAttrs(n, model.clusters) })
      for (const c of clusterPath(cid, model.clusters)) {
        model.clusters.get(c)?.memberDeviceKeys.push(n.id)
      }
      if (n.kind === 'device') model.deviceCount++
      else model.ghostCount++
      return okNode(n.id)
    }
    case 'topology_node_updated': {
      if (!event.node_id || !event.changes) return invalid()
      if (!graph.hasNode(event.node_id)) return resync()
      graph.mergeNodeAttributes(event.node_id, event.changes)
      return okNode(event.node_id)
    }
    case 'topology_node_removed': {
      if (!event.node_id) return invalid()
      if (graph.hasNode(event.node_id)) {
        const kind = graph.getNodeAttribute(event.node_id, 'nodeKind')
        graph.dropNode(event.node_id)
        if (kind === 'device') model.deviceCount = Math.max(0, model.deviceCount - 1)
        else if (kind === 'ghost') model.ghostCount = Math.max(0, model.ghostCount - 1)
      }
      return okNoRestyle()
    }
    case 'topology_edge_added': {
      const e = event.edge
      if (!e) return invalid()
      if (graph.hasEdge(e.id)) return okEdge(e.id)
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) return resync()
      graph.addEdgeWithKey(e.id, e.source, e.target, edgeAttrs(e))
      return okEdge(e.id)
    }
    case 'topology_edge_updated': {
      if (!event.edge_id || !event.changes) return invalid()
      if (!graph.hasEdge(event.edge_id)) return resync()
      graph.mergeEdgeAttributes(event.edge_id, event.changes)
      return okEdge(event.edge_id)
    }
    case 'topology_edge_removed': {
      if (!event.edge_id) return invalid()
      if (graph.hasEdge(event.edge_id)) graph.dropEdge(event.edge_id)
      return okNoRestyle()
    }
    default:
      // Unknown event type — neither in GRANULAR nor in the bulk set.
      return invalid()
  }
}
