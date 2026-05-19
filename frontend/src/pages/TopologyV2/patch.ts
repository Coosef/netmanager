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
  seedPosition, styleGraph, clusterPath, type TopologyModel,
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

export type PatchStatus = 'applied' | 'stale' | 'refetch' | 'drift'

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

const GRANULAR = new Set([
  'topology_node_added', 'topology_node_updated', 'topology_node_removed',
  'topology_edge_added', 'topology_edge_updated', 'topology_edge_removed',
])

/**
 * Apply one realtime event. The graph mutates only on `applied`; `drift`
 * is a UI-state signal; `refetch` asks the caller to pull a fresh
 * contract; `stale` is a dropped replay.
 */
export function applyTopologyEvent(
  model: TopologyModel,
  event: TopologyEvent,
  expectedVersion: number,
): PatchOutcome {
  const rel = reconcileVersion(event.graph_version, expectedVersion)
  if (rel === 'stale') return { status: 'stale', version: expectedVersion }
  if (rel === 'gap') return { status: 'refetch', version: expectedVersion }

  // in sequence (expected + 1)
  if (event.event_type === 'topology_drift') {
    return { status: 'drift', version: event.graph_version }
  }
  if (!GRANULAR.has(event.event_type)) {
    // bulk / structural (topology_links_updated, …) — reconcile by refetch
    return { status: 'refetch', version: expectedVersion }
  }

  const { graph } = model
  const ok = (): PatchOutcome => {
    styleGraph(model)
    return { status: 'applied', version: event.graph_version }
  }

  switch (event.event_type) {
    case 'topology_node_added': {
      const n = event.node
      if (!n) return { status: 'refetch', version: expectedVersion }
      if (graph.hasNode(n.id)) return ok()
      // only safe to apply in place when the hierarchy already exists
      const cid = n.data.cluster_id ?? null
      if (cid && !model.clusters.has(cid)) {
        return { status: 'refetch', version: expectedVersion }
      }
      const p = placeNewNode(model, cid)
      graph.addNode(n.id, { x: p.x, y: p.y, ...deviceNodeAttrs(n, model.clusters) })
      for (const c of clusterPath(cid, model.clusters)) {
        model.clusters.get(c)?.memberDeviceKeys.push(n.id)
      }
      if (n.kind === 'device') model.deviceCount++
      else model.ghostCount++
      return ok()
    }
    case 'topology_node_updated': {
      if (!event.node_id || !event.changes) return { status: 'refetch', version: expectedVersion }
      if (!graph.hasNode(event.node_id)) return { status: 'refetch', version: expectedVersion }
      graph.mergeNodeAttributes(event.node_id, event.changes)
      return ok()
    }
    case 'topology_node_removed': {
      if (!event.node_id) return { status: 'refetch', version: expectedVersion }
      if (graph.hasNode(event.node_id)) {
        const kind = graph.getNodeAttribute(event.node_id, 'nodeKind')
        graph.dropNode(event.node_id)
        if (kind === 'device') model.deviceCount = Math.max(0, model.deviceCount - 1)
        else if (kind === 'ghost') model.ghostCount = Math.max(0, model.ghostCount - 1)
      }
      return ok()
    }
    case 'topology_edge_added': {
      const e = event.edge
      if (!e) return { status: 'refetch', version: expectedVersion }
      if (graph.hasEdge(e.id)) return ok()
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) {
        return { status: 'refetch', version: expectedVersion }
      }
      graph.addEdgeWithKey(e.id, e.source, e.target, edgeAttrs(e))
      return ok()
    }
    case 'topology_edge_updated': {
      if (!event.edge_id || !event.changes) return { status: 'refetch', version: expectedVersion }
      if (!graph.hasEdge(event.edge_id)) return { status: 'refetch', version: expectedVersion }
      graph.mergeEdgeAttributes(event.edge_id, event.changes)
      return ok()
    }
    case 'topology_edge_removed': {
      if (!event.edge_id) return { status: 'refetch', version: expectedVersion }
      if (graph.hasEdge(event.edge_id)) graph.dropEdge(event.edge_id)
      return ok()
    }
    default:
      return { status: 'refetch', version: expectedVersion }
  }
}
