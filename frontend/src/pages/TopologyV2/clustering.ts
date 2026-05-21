/**
 * Clustering — collapse / expand of the location → layer → rack hierarchy
 * and the derivation of cluster meta-edges.
 *
 * Visibility model:
 *   - a device/ghost is visible  ⇔  none of its ancestor clusters is collapsed
 *   - a cluster node is visible  ⇔  it is collapsed AND no ancestor is collapsed
 *     (the "frontier" — the shallowest collapsed cluster on each branch)
 *   - a contract link shows only when both endpoints are visible
 *   - otherwise each endpoint is mapped to its visible representative and a
 *     `meta` edge is drawn between representatives (aggregating traffic)
 *
 * Pure graph logic over the graphology model — no Sigma / DOM.
 */
import type Graph from 'graphology'
import type { TopologyModel } from './graphModel'

export type ClusterTier = 'location' | 'layer' | 'rack' | 'device'

export interface ClusterViewResult {
  visibleNodes: number
  visibleEdges: number
  metaEdges: number
}

/** Collapsed-cluster set for a global tier. */
export function collapsedSetForTier(model: TopologyModel, tier: ClusterTier): Set<string> {
  const set = new Set<string>()
  if (tier === 'device') return set
  if (tier === 'location' || tier === 'layer') {
    for (const c of model.clusters.values()) {
      if (c.type === tier) set.add(c.id)
    }
    return set
  }
  // 'rack' — collapse each device to its deepest cluster (rack, else layer).
  model.graph.forEachNode((_key, attr) => {
    if (attr.nodeKind === 'cluster') return
    const path: string[] = attr.clusterPath || []
    if (path.length) set.add(path[path.length - 1])
  })
  return set
}

/** Expand one cluster: reveal its children (drill one tier in). */
export function expandCluster(
  model: TopologyModel,
  collapsed: Set<string>,
  clusterId: string,
): Set<string> {
  const next = new Set(collapsed)
  next.delete(clusterId)
  const info = model.clusters.get(clusterId)
  if (info) {
    // Drill one level: child clusters become the new frontier.
    for (const child of info.childClusterIds) next.add(child)
  }
  return next
}

function anyAncestorCollapsed(
  model: TopologyModel,
  clusterId: string,
  collapsed: Set<string>,
): boolean {
  let cur = model.clusters.get(clusterId)?.parentId ?? null
  let guard = 0
  while (cur && guard++ < 16) {
    if (collapsed.has(cur)) return true
    cur = model.clusters.get(cur)?.parentId ?? null
  }
  return false
}

/**
 * Per-node hidden computation. Shared between the full and delta paths
 * so the visibility rule is defined once. Pure function — no graph
 * mutation, no side effects.
 */
function hiddenFor(
  model: TopologyModel,
  graph: Graph,
  key: string,
  collapsed: Set<string>,
): boolean {
  const attr = graph.getNodeAttributes(key)
  if (attr.nodeKind === 'cluster') {
    return !(collapsed.has(key) && !anyAncestorCollapsed(model, key, collapsed))
  }
  const path: string[] = attr.clusterPath || []
  return path.some((cid) => collapsed.has(cid))
}

/**
 * Per-node representative against a given collapsed set: the node
 * itself when visible, otherwise the deepest collapsed cluster on its
 * path. Shared by both paths.
 */
function repOf(
  graph: Graph,
  key: string,
  collapsed: Set<string>,
): string {
  const attr = graph.getNodeAttributes(key)
  if (attr.nodeKind === 'cluster') return key
  if (!attr.hidden) return key
  const path: string[] = attr.clusterPath || []
  for (const cid of path) if (collapsed.has(cid)) return cid
  return key
}

/**
 * Build a fresh meta-edge in the graph from an aggregation entry.
 * Centralised so the full and delta paths agree on the styling.
 */
function addMetaEdge(
  graph: Graph,
  a: string,
  b: string,
  count: number,
  utilizationSum: number,
): boolean {
  const k = a < b ? `${a}|${b}` : `${b}|${a}`
  const id = `meta-${k}`
  if (graph.hasEdge(id)) return false
  if (!graph.hasNode(a) || !graph.hasNode(b)) return false
  graph.addEdgeWithKey(id, a, b, {
    edgeKind: 'meta',
    count,
    utilization: count ? utilizationSum / count : 0,
    size: 1 + Math.min(6, Math.log2(count + 1) * 2),
    color: '#5b6b85',
    hidden: false,
  })
  return true
}

/**
 * Apply a collapsed-set to the graph: toggle `hidden` on every node/edge
 * and rebuild cluster meta-edges. Mutates the graphology graph in place.
 *
 * Use this for the INITIAL view, location/model swap, or any context
 * where there's no meaningful "previous" collapsed set. For incremental
 * single-cluster expand/collapse, prefer `applyClusterViewDelta` —
 * it's O(touched) instead of O(N+E).
 */
export function applyClusterView(
  model: TopologyModel,
  collapsed: Set<string>,
): ClusterViewResult {
  const graph: Graph = model.graph

  // ── 1. node visibility ──────────────────────────────────────────────────
  let visibleNodes = 0
  graph.forEachNode((key) => {
    const hidden = hiddenFor(model, graph, key, collapsed)
    graph.setNodeAttribute(key, 'hidden', hidden)
    if (!hidden) visibleNodes++
  })

  // ── 2. drop stale meta-edges ────────────────────────────────────────────
  const stale: string[] = []
  graph.forEachEdge((edge, attr) => {
    if (attr.edgeKind === 'meta') stale.push(edge)
  })
  stale.forEach((e) => graph.dropEdge(e))

  // ── 3. contract link visibility + meta aggregation ──────────────────────
  let visibleEdges = 0
  interface MetaAgg { a: string; b: string; count: number; util: number }
  const meta = new Map<string, MetaAgg>()

  graph.forEachEdge((edge, attr, source, target) => {
    if (attr.edgeKind !== 'link') return
    const sHidden = graph.getNodeAttribute(source, 'hidden')
    const tHidden = graph.getNodeAttribute(target, 'hidden')
    const linkVisible = !sHidden && !tHidden
    graph.setEdgeAttribute(edge, 'hidden', !linkVisible)
    if (linkVisible) {
      visibleEdges++
      return
    }
    // routed into a meta-edge
    const ra = repOf(graph, source, collapsed)
    const rb = repOf(graph, target, collapsed)
    if (ra === rb) return // intra-cluster — nothing to draw
    const key = ra < rb ? `${ra}|${rb}` : `${rb}|${ra}`
    const agg = meta.get(key)
    if (agg) {
      agg.count++
      agg.util += attr.utilization || 0
    } else {
      meta.set(key, { a: ra, b: rb, count: 1, util: attr.utilization || 0 })
    }
  })

  // ── 4. add fresh meta-edges ─────────────────────────────────────────────
  let metaEdges = 0
  for (const agg of meta.values()) {
    if (addMetaEdge(graph, agg.a, agg.b, agg.count, agg.util)) metaEdges++
  }

  return { visibleNodes, visibleEdges, metaEdges }
}

/**
 * Incremental cluster-view update — T8.3.E2.
 *
 * Equivalent end state to `applyClusterView(model, next)`, but the work
 * is proportional to the SET of nodes/edges actually affected by the
 * `prev → next` transition, not the full graph. For a single expand
 * (`{id} → children-of-id`) the touched set is `id`'s memberDeviceKeys
 * + the cluster node and its children, which at 10k typically beats
 * the full walk by an order of magnitude or more.
 *
 * Algorithm:
 *   1. `added`   = `next \ prev`,  `removed` = `prev \ next`. No diff →
 *      no work.
 *   2. `touched` = (added ∪ removed) ∪ ⋃ memberDeviceKeys(c) for c in
 *      that union — every device whose path crosses a changed cluster.
 *      Unchanged-cluster nodes are NOT touched: their visibility is
 *      fully determined by clusters in `prev ∩ next`, which are
 *      unchanged.
 *   3. Re-evaluate `hidden` for every touched node using the SAME
 *      `hiddenFor` helper as the full path.
 *   4. Drop meta-edges incident to any cluster in (added ∪ removed) —
 *      these are the only meta-edges whose representative endpoints
 *      could have shifted.
 *   5. Re-aggregate meta-edges from touched link edges (edges incident
 *      to a touched node). Edges between two untouched devices route
 *      to meta-edges with unchanged representatives, so their existing
 *      meta-edge (if any) is still valid.
 *   6. Add fresh meta-edges from the aggregation map; `addMetaEdge`
 *      skips duplicates so step 4's targeted drop doesn't need to be
 *      exhaustive.
 *
 * Pre-conditions:
 *   - Graph state reflects `prev` (i.e. a prior `applyClusterView`
 *     or `applyClusterViewDelta` chain has been applied).
 *   - `prev` and `next` are Sets of cluster IDs that exist in
 *     `model.clusters`. Adding a cluster that doesn't exist is a no-op
 *     for that entry (touchedNodes only adds the cluster id itself).
 *
 * Returns the same `ClusterViewResult` shape as the full path so the
 * call site is signature-compatible. The count fields are NOT
 * recomputed here (would require an O(N+E) re-scan, defeating the
 * purpose) — they're returned as `0` and the SigmaCanvas caller doesn't
 * read them. If you need an accurate count, call `countClusterView`
 * (also below) which is O(N+E) but explicit.
 */
export function applyClusterViewDelta(
  model: TopologyModel,
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
): ClusterViewResult {
  const graph = model.graph

  // ── 1. diff ──────────────────────────────────────────────────────────────
  const added = new Set<string>()
  const removed = new Set<string>()
  for (const c of next) if (!prev.has(c)) added.add(c)
  for (const c of prev) if (!next.has(c)) removed.add(c)
  if (added.size === 0 && removed.size === 0) {
    return { visibleNodes: 0, visibleEdges: 0, metaEdges: 0 }
  }

  // ── 2. touched node set ──────────────────────────────────────────────────
  const touchedNodes = new Set<string>()
  for (const c of added) touchedNodes.add(c)
  for (const c of removed) touchedNodes.add(c)
  for (const c of added) {
    const info = model.clusters.get(c)
    if (info) for (const m of info.memberDeviceKeys) touchedNodes.add(m)
  }
  for (const c of removed) {
    const info = model.clusters.get(c)
    if (info) for (const m of info.memberDeviceKeys) touchedNodes.add(m)
  }

  // ── 3. re-evaluate hidden for touched nodes ─────────────────────────────
  for (const key of touchedNodes) {
    if (!graph.hasNode(key)) continue
    graph.setNodeAttribute(key, 'hidden', hiddenFor(model, graph, key, next as Set<string>))
  }

  // ── 4. drop meta-edges incident to ANY touched node ─────────────────────
  // Stale meta-edges live on touched cluster reps OR on touched devices
  // — a device that was visible (its own rep) can have a meta-edge that
  // collapses when the device hides (the cluster becomes its new rep).
  // Iterating touchedNodes (which already covers both) handles both
  // categories without a second pass over the graph.
  const dropQueue = new Set<string>()
  for (const key of touchedNodes) {
    if (!graph.hasNode(key)) continue
    graph.forEachEdge(key, (edge, attr) => {
      if (attr.edgeKind === 'meta') dropQueue.add(edge)
    })
  }
  dropQueue.forEach((e) => graph.dropEdge(e))

  // ── 5. re-aggregate meta-edges from touched link edges ──────────────────
  interface MetaAgg { a: string; b: string; count: number; util: number }
  const meta = new Map<string, MetaAgg>()
  const visited = new Set<string>()
  const nextSet = next as Set<string>

  for (const key of touchedNodes) {
    if (!graph.hasNode(key)) continue
    graph.forEachEdge(key, (edge, attr, source, target) => {
      if (visited.has(edge)) return
      visited.add(edge)
      if (attr.edgeKind !== 'link') return
      const sHidden = graph.getNodeAttribute(source, 'hidden')
      const tHidden = graph.getNodeAttribute(target, 'hidden')
      const linkVisible = !sHidden && !tHidden
      graph.setEdgeAttribute(edge, 'hidden', !linkVisible)
      if (linkVisible) return
      const ra = repOf(graph, source, nextSet)
      const rb = repOf(graph, target, nextSet)
      if (ra === rb) return
      const k = ra < rb ? `${ra}|${rb}` : `${rb}|${ra}`
      const agg = meta.get(k)
      if (agg) {
        agg.count++
        agg.util += attr.utilization || 0
      } else {
        meta.set(k, { a: ra, b: rb, count: 1, util: attr.utilization || 0 })
      }
    })
  }

  // ── 6. add fresh meta-edges ──────────────────────────────────────────────
  for (const agg of meta.values()) {
    addMetaEdge(graph, agg.a, agg.b, agg.count, agg.util)
  }

  return { visibleNodes: 0, visibleEdges: 0, metaEdges: 0 }
}

/**
 * Compute the same {visibleNodes, visibleEdges, metaEdges} counts the
 * full `applyClusterView` returns, but WITHOUT mutating the graph.
 * Cheap to call once after a delta pass when you really need the
 * summary numbers (e.g. test assertions). For runtime hot paths the
 * delta returns zero-counts and the caller ignores them.
 */
export function countClusterView(model: TopologyModel): ClusterViewResult {
  const graph = model.graph
  let visibleNodes = 0
  let visibleEdges = 0
  let metaEdges = 0
  graph.forEachNode((_key, attr) => { if (!attr.hidden) visibleNodes++ })
  graph.forEachEdge((_edge, attr) => {
    if (attr.edgeKind === 'meta') {
      if (!attr.hidden) metaEdges++
    } else if (!attr.hidden) {
      visibleEdges++
    }
  })
  return { visibleNodes, visibleEdges, metaEdges }
}
