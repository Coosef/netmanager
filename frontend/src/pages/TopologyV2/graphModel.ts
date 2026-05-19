/**
 * Graph model — turns the v2 topology contract into a graphology graph.
 *
 * The graph holds three node kinds:
 *   - `device` / `ghost` — leaf nodes (one per contract node)
 *   - `cluster`          — location / layer / rack hierarchy nodes
 * plus the contract's device↔device / device↔ghost edges. Cluster
 * meta-edges are derived at view time (see clustering.ts), not stored
 * here. This module is pure data — no Sigma, no DOM — so it is unit
 * testable.
 */
import Graph from 'graphology'
import type { TopologyGraphV2, TopologyCluster } from './contract'

export type NodeKind = 'device' | 'ghost' | 'cluster'

export interface ClusterInfo {
  id: string
  type: TopologyCluster['cluster_type']
  parentId: string | null
  depth: number // location 0 · layer 1 · rack 2
  childClusterIds: string[]
  memberDeviceKeys: string[] // every device/ghost under this cluster (recursive)
}

export interface TopologyModel {
  graph: Graph
  clusters: Map<string, ClusterInfo>
  rootClusterIds: string[]
  deviceCount: number
  ghostCount: number
  graphVersion: number
}

const CLUSTER_DEPTH: Record<TopologyCluster['cluster_type'], number> = {
  location: 0,
  layer: 1,
  rack: 2,
}

/** Deterministic scatter — gives FA2 a stable, non-degenerate seed. */
function seedPosition(key: string): { x: number; y: number } {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  const a = (h % 1000) / 1000
  const b = ((h >> 10) % 1000) / 1000
  return { x: a * 1000 - 500, y: b * 1000 - 500 }
}

/** Walk a device's ancestor cluster chain, shallowest-first. */
export function clusterPath(
  clusterId: string | null,
  clusters: Map<string, ClusterInfo>,
): string[] {
  const path: string[] = []
  let cur = clusterId
  let guard = 0
  while (cur && guard++ < 16) {
    const c = clusters.get(cur)
    if (!c) break
    path.unshift(cur)
    cur = c.parentId
  }
  return path
}

export function buildTopologyModel(contract: TopologyGraphV2): TopologyModel {
  const graph = new Graph({ multi: true, type: 'undirected' })

  // ── 1. cluster registry ─────────────────────────────────────────────────
  const clusters = new Map<string, ClusterInfo>()
  for (const c of contract.clusters) {
    clusters.set(c.cluster_id, {
      id: c.cluster_id,
      type: c.cluster_type,
      parentId: c.parent_cluster_id,
      depth: CLUSTER_DEPTH[c.cluster_type] ?? 0,
      childClusterIds: [],
      memberDeviceKeys: [],
    })
  }
  for (const c of clusters.values()) {
    if (c.parentId && clusters.has(c.parentId)) {
      clusters.get(c.parentId)!.childClusterIds.push(c.id)
    }
  }
  const rootClusterIds = [...clusters.values()]
    .filter((c) => !c.parentId || !clusters.has(c.parentId))
    .map((c) => c.id)

  // ── 2. cluster nodes ────────────────────────────────────────────────────
  for (const c of contract.clusters) {
    const pos = seedPosition(c.cluster_id)
    graph.addNode(c.cluster_id, {
      x: pos.x,
      y: pos.y,
      nodeKind: 'cluster' as NodeKind,
      clusterType: c.cluster_type,
      parentClusterId: c.parent_cluster_id,
      depth: CLUSTER_DEPTH[c.cluster_type] ?? 0,
      label: c.label,
      collapsedCount: c.collapsed_count,
      health: c.health,
      traffic: c.traffic,
      size: 8,
      color: '#64748b',
      hidden: true, // clustering.ts decides visibility
    })
  }

  // ── 3. device / ghost nodes ─────────────────────────────────────────────
  let deviceCount = 0
  let ghostCount = 0
  for (const n of contract.nodes) {
    const pos = seedPosition(n.id)
    const d = n.data
    const path = clusterPath(d.cluster_id ?? null, clusters)
    // register membership on every ancestor cluster
    for (const cid of path) clusters.get(cid)?.memberDeviceKeys.push(n.id)

    if (n.kind === 'device') deviceCount++
    else ghostCount++

    graph.addNode(n.id, {
      x: pos.x,
      y: pos.y,
      nodeKind: n.kind as NodeKind,
      label: d.label,
      clusterId: d.cluster_id ?? null,
      clusterPath: path,
      status: d.status ?? 'unknown',
      layer: d.layer ?? 'unknown',
      criticality: d.criticality,
      importanceScore: d.importance_score ?? 0.3,
      labelPriority: d.label_priority ?? 3,
      minZoomLevel: d.min_zoom_level ?? 1,
      lodTier: d.lod_tier ?? 'detail',
      renderClass: d.render_class ?? 'unknown',
      size: 4,
      color: '#94a3b8',
      hidden: false,
      raw: n,
    })
  }

  // ── 4. contract edges (device↔device / device↔ghost) ────────────────────
  for (const e of contract.edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
    if (graph.hasEdge(e.id)) continue
    graph.addEdgeWithKey(e.id, e.source, e.target, {
      edgeKind: 'link',
      linkType: e.link_type,
      utilization: e.utilization,
      trafficClass: e.traffic_class,
      anomalyState: e.anomaly_state,
      latencyMs: e.latency_ms,
      size: 1,
      color: '#475569',
      hidden: false,
      raw: e,
    })
  }

  return {
    graph,
    clusters,
    rootClusterIds,
    deviceCount,
    ghostCount,
    graphVersion: contract.graph_version,
  }
}
