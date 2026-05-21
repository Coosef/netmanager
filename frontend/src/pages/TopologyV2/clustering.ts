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
 * Apply a collapsed-set to the graph: toggle `hidden` on every node/edge
 * and rebuild cluster meta-edges. Mutates the graphology graph in place.
 */
export function applyClusterView(
  model: TopologyModel,
  collapsed: Set<string>,
): ClusterViewResult {
  const graph: Graph = model.graph

  // ── 1. node visibility ──────────────────────────────────────────────────
  let visibleNodes = 0
  graph.forEachNode((key, attr) => {
    let hidden: boolean
    if (attr.nodeKind === 'cluster') {
      hidden = !(collapsed.has(key) && !anyAncestorCollapsed(model, key, collapsed))
    } else {
      const path: string[] = attr.clusterPath || []
      hidden = path.some((cid) => collapsed.has(cid))
    }
    graph.setNodeAttribute(key, 'hidden', hidden)
    if (!hidden) visibleNodes++
  })

  // representative of a node = itself if visible, else its frontier cluster
  const repOf = (key: string): string => {
    const attr = graph.getNodeAttributes(key)
    if (attr.nodeKind === 'cluster') return key
    if (!attr.hidden) return key
    const path: string[] = attr.clusterPath || []
    for (const cid of path) if (collapsed.has(cid)) return cid
    return key
  }

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

  graph.forEachEdge((_edge, attr, source, target) => {
    if (attr.edgeKind !== 'link') return
    const sHidden = graph.getNodeAttribute(source, 'hidden')
    const tHidden = graph.getNodeAttribute(target, 'hidden')
    const linkVisible = !sHidden && !tHidden
    graph.setEdgeAttribute(_edge, 'hidden', !linkVisible)
    if (linkVisible) {
      visibleEdges++
      return
    }
    // routed into a meta-edge
    const ra = repOf(source)
    const rb = repOf(target)
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
  for (const [key, agg] of meta) {
    const id = `meta-${key}`
    if (graph.hasEdge(id)) continue
    if (!graph.hasNode(agg.a) || !graph.hasNode(agg.b)) continue
    graph.addEdgeWithKey(id, agg.a, agg.b, {
      edgeKind: 'meta',
      count: agg.count,
      utilization: agg.count ? agg.util / agg.count : 0,
      size: 1 + Math.min(6, Math.log2(agg.count + 1) * 2),
      color: '#5b6b85',
      hidden: false,
    })
    metaEdges++
  }

  return { visibleNodes, visibleEdges, metaEdges }
}
