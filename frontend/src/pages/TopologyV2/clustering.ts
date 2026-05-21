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

/**
 * Extra payload returned by `applyClusterViewDelta` — the set of nodes
 * and edges Sigma needs to re-upload to GPU buffers after the delta.
 * Plumbing it from `clustering.ts` to the SigmaCanvas effect lets the
 * caller pass a `partialGraph` to `sigma.refresh()` instead of a full
 * 10k-node buffer rebuild.
 *
 * Conservatively over-includes — a node/edge that was touched but
 * didn't actually change a paint-relevant attribute still gets a
 * harmless re-upload. Under-inclusion would leave stale visuals, so
 * `touchedNodeIds` mirrors the delta's `touchedNodes` set verbatim and
 * `touchedEdgeIds` covers every edge whose `hidden` may have flipped
 * plus every meta-edge added in step 6.
 */
export interface ClusterViewDeltaResult extends ClusterViewResult {
  touchedNodeIds: string[]
  touchedEdgeIds: string[]
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
 * Build a fresh meta-edge in the graph from an aggregation entry, OR
 * revive an existing (possibly hidden) one with the same id. The delta
 * path retains stale meta-edges with `hidden: true` instead of dropping
 * them (see `applyClusterViewDelta` step 6 for why — dropping a single
 * edge fires `edgeDropped` on Sigma's graphology subscription, which
 * synchronously runs a full O(N+E) re-index at 10 k).
 *
 * Returns:
 *   `'added'`   — the edge didn't exist; created it.
 *   `'revived'` — the edge existed (likely with `hidden: true` from a
 *                 previous delta); refreshed its attributes + unhid.
 *   `'skipped'` — endpoint node missing; nothing written.
 */
function addOrReviveMetaEdge(
  graph: Graph,
  a: string,
  b: string,
  count: number,
  utilizationSum: number,
): 'added' | 'revived' | 'skipped' {
  const k = a < b ? `${a}|${b}` : `${b}|${a}`
  const id = `meta-${k}`
  const attrs = {
    edgeKind: 'meta' as const,
    count,
    utilization: count ? utilizationSum / count : 0,
    size: 1 + Math.min(6, Math.log2(count + 1) * 2),
    color: '#5b6b85',
    hidden: false,
  }
  if (graph.hasEdge(id)) {
    graph.mergeEdgeAttributes(id, attrs)
    return 'revived'
  }
  if (!graph.hasNode(a) || !graph.hasNode(b)) return 'skipped'
  graph.addEdgeWithKey(id, a, b, attrs)
  return 'added'
}

/** Backwards-compat thin wrapper for the FULL path, which still wants
 *  to know only "did we add a new one?" for its visible-count tally. */
function addMetaEdge(
  graph: Graph,
  a: string,
  b: string,
  count: number,
  utilizationSum: number,
): boolean {
  return addOrReviveMetaEdge(graph, a, b, count, utilizationSum) === 'added'
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
): ClusterViewDeltaResult {
  const graph = model.graph

  // ── 1. diff ──────────────────────────────────────────────────────────────
  const added = new Set<string>()
  const removed = new Set<string>()
  for (const c of next) if (!prev.has(c)) added.add(c)
  for (const c of prev) if (!next.has(c)) removed.add(c)
  if (added.size === 0 && removed.size === 0) {
    return {
      visibleNodes: 0, visibleEdges: 0, metaEdges: 0,
      touchedNodeIds: [], touchedEdgeIds: [],
    }
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

  // ── 4. collect meta-edges potentially affected by the diff ──────────────
  // Critical Sigma internal we work around (T8.3.E2.e, see sigma.esm.js
  // around line 1804+ and line 3268+): when an edge is dropped,
  // `dropEdgeGraphUpdate` calls `refresh({ schedule: true })`. That
  // option only defers the RENDER — the **re-index** runs synchronously,
  // hitting the `fullRefresh` branch (no `partialGraph` is passed),
  // which does `clearEdgeIndices() + clearNodeIndices()` + a full
  // `forEachNode + forEachEdge` walk of the entire graph. At 10 k each
  // drop costs ~10 ms; 1300+ drops cascade to ~13 s of main-thread
  // blocking.
  //
  // Instead of dropping, we **hide**. Stale meta-edges stay in the
  // graph with `hidden: true`. The Sigma reducer skips them
  // visually, and a future delta either re-uses them (via
  // `addOrReviveMetaEdge`, which sets `hidden: false`) or leaves them
  // hidden. The hide event fires `edgeAttributesUpdated`, which Sigma
  // handles with a partial `refresh({ partialGraph: { edges: [edge] }})`
  // — cheap (~0.1 ms). A full apply (initial mount / model swap)
  // sweeps any accumulation back to a clean state.
  const candidateStaleMeta = new Set<string>()
  for (const key of touchedNodes) {
    if (!graph.hasNode(key)) continue
    graph.forEachEdge(key, (edge, attr) => {
      if (attr.edgeKind === 'meta') candidateStaleMeta.add(edge)
    })
  }

  // ── 5. re-aggregate meta-edges from touched link edges ──────────────────
  interface MetaAgg { a: string; b: string; count: number; util: number }
  const meta = new Map<string, MetaAgg>()
  const visited = new Set<string>()       // doubles as the "touched link edges" set
  const nextSet = next as Set<string>

  for (const key of touchedNodes) {
    if (!graph.hasNode(key)) continue
    graph.forEachEdge(key, (edge, attr, source, target) => {
      // Skip non-link edges WITHOUT adding them to `visited` — meta-edges
      // are managed in step 6, and including them here would leak their
      // ids into `touchedEdgeIds`, only for the drop pass to delete them
      // and Sigma's partial refresh to then throw `getEdgeAttributes`.
      if (attr.edgeKind !== 'link') return
      if (visited.has(edge)) return
      visited.add(edge)
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

  // ── 6. emit meta-edges: add new / revive matching / hide stale ─────────
  // For every aggregated key the new state requires:
  //   * if the id exists (visible or hidden from a prior delta) →
  //     `addOrReviveMetaEdge` updates its attrs + unhides
  //   * else → add fresh.
  // Candidates that no aggregation re-produces get **hidden** (not
  // dropped) — see step 4's comment for the rationale.
  const addedMetaIds: string[] = []
  const revivedMetaIds: string[] = []
  for (const agg of meta.values()) {
    const id = `meta-${agg.a < agg.b ? `${agg.a}|${agg.b}` : `${agg.b}|${agg.a}`}`
    const outcome = addOrReviveMetaEdge(graph, agg.a, agg.b, agg.count, agg.util)
    if (outcome === 'added') addedMetaIds.push(id)
    else if (outcome === 'revived') revivedMetaIds.push(id)
    candidateStaleMeta.delete(id)  // not stale; either added or revived
  }
  // Hide candidates that no aggregation re-produced. Already-hidden
  // ones are skipped to avoid re-firing the event handler.
  const hiddenStaleIds: string[] = []
  candidateStaleMeta.forEach((e) => {
    if (!graph.hasEdge(e)) return
    if (graph.getEdgeAttribute(e, 'hidden')) return
    graph.setEdgeAttribute(e, 'hidden', true)
    hiddenStaleIds.push(e)
  })

  // Touched edges for partial Sigma refresh:
  //  * every link edge re-evaluated above (`visited` set)
  //  * every meta-edge added, revived, or freshly hidden
  // All ids in `touchedEdgeIds` exist in the graph after the delta —
  // Sigma can safely look them up to re-apply reducers.
  const touchedEdgeIds: string[] = []
  visited.forEach((e) => touchedEdgeIds.push(e))
  for (const id of addedMetaIds) touchedEdgeIds.push(id)
  for (const id of revivedMetaIds) touchedEdgeIds.push(id)
  for (const id of hiddenStaleIds) touchedEdgeIds.push(id)

  return {
    visibleNodes: 0, visibleEdges: 0, metaEdges: 0,
    touchedNodeIds: Array.from(touchedNodes),
    touchedEdgeIds,
  }
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
