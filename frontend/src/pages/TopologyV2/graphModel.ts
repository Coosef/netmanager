/**
 * Graph model — turns the v2 topology contract into a graphology graph.
 *
 * The graph holds three node kinds:
 *   - `device` / `ghost` — leaf nodes (one per contract node)
 *   - `cluster`          — location / layer / rack hierarchy nodes
 * plus the contract's device↔device / device↔ghost edges. Cluster
 * meta-edges are derived at view time (see clustering.ts).
 *
 * The attribute builders (`deviceNodeAttrs`, `clusterNodeAttrs`,
 * `edgeAttrs`) and `buildClusterIndex` are shared with the realtime
 * patch engine (patch.ts) so a freshly fetched contract and an
 * incremental event produce identical graph state. Pure data — no
 * Sigma, no DOM — unit testable.
 *
 * ── Lifetime invariants (T8.2 — render ownership contract) ─────────────
 *
 * 1. The `TopologyModel.graph` is a **mutable singleton**. It is built
 *    once by `buildTopologyModel(contract)` and lives until the next
 *    full rebuild — i.e. a location switch or a `graph_version` gap
 *    that forces a controlled refetch (see `patch.diffAndPatch`).
 *
 * 2. The graph is **mutated in place** by `patch.ts` — the single
 *    merge point for both realtime events (`applyTopologyEvent`) and
 *    full-contract reconciliation (`diffAndPatch`). No other module
 *    should call `graph.addNode` / `dropNode` / `addEdgeWithKey` /
 *    `setNodeAttribute` etc. directly. Overlays (`overlays/*`), the
 *    3D projection (`three/sceneData.ts`), and the 2D canvas
 *    (`SigmaCanvas.tsx`) all read the graph but never write it.
 *
 * 3. Every mutation MUST be followed by a `patchSignal` increment in
 *    the orchestrating React component (`index.tsx`). Downstream
 *    renderers (Sigma traffic loop, `three/Scene.tsx` memo'd scene
 *    data, overlay derivations) re-read the graph only when
 *    `patchSignal` changes — a mutation without a bump is invisible
 *    to the renderer. The patch helpers in `patch.ts` mutate the
 *    graph and report what changed; bumping `patchSignal` after a
 *    successful patch is the caller's responsibility.
 *
 * 4. New graph instances are created ONLY on location switch (or a
 *    `graph_version` gap forcing a refetch). Any other re-creation
 *    is a bug: it would lose the Sigma camera, lose the FA2 layout
 *    state, and re-mount the WebGL surface unnecessarily.
 */
import Graph from 'graphology'
import type {
  TopologyGraphV2, TopologyCluster, TopologyNode, TopologyEdge,
} from './contract'
import {
  nodeColor, nodeSize, clusterColor, clusterSize, edgeColor, edgeSize,
} from './rendering'

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
export function seedPosition(key: string): { x: number; y: number } {
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

/**
 * Build the cluster registry (hierarchy + recursive device membership)
 * from a contract. Shared by `buildTopologyModel` and the patch engine.
 */
export function buildClusterIndex(contract: TopologyGraphV2): {
  clusters: Map<string, ClusterInfo>
  rootClusterIds: string[]
} {
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
  for (const n of contract.nodes) {
    for (const cid of clusterPath(n.data.cluster_id ?? null, clusters)) {
      clusters.get(cid)?.memberDeviceKeys.push(n.id)
    }
  }
  const rootClusterIds = [...clusters.values()]
    .filter((c) => !c.parentId || !clusters.has(c.parentId))
    .map((c) => c.id)
  return { clusters, rootClusterIds }
}

/** graphology attributes for a device/ghost node. */
export function deviceNodeAttrs(
  n: TopologyNode,
  clusters: Map<string, ClusterInfo>,
): Record<string, unknown> {
  const d = n.data
  return {
    nodeKind: n.kind as NodeKind,
    label: d.label,
    clusterId: d.cluster_id ?? null,
    clusterPath: clusterPath(d.cluster_id ?? null, clusters),
    status: d.status ?? 'unknown',
    layer: d.layer ?? 'unknown',
    criticality: d.criticality,
    importanceScore: d.importance_score ?? 0.3,
    labelPriority: d.label_priority ?? 3,
    minZoomLevel: d.min_zoom_level ?? 1,
    lodTier: d.lod_tier ?? 'detail',
    renderClass: d.render_class ?? 'unknown',
    hidden: false,
    raw: n,
  }
}

/** graphology attributes for a cluster node. */
export function clusterNodeAttrs(c: TopologyCluster): Record<string, unknown> {
  return {
    nodeKind: 'cluster' as NodeKind,
    clusterType: c.cluster_type,
    parentClusterId: c.parent_cluster_id,
    depth: CLUSTER_DEPTH[c.cluster_type] ?? 0,
    label: c.label,
    collapsedCount: c.collapsed_count,
    health: c.health,
    traffic: c.traffic,
    hidden: true,
  }
}

/** graphology attributes for a contract edge. */
export function edgeAttrs(e: TopologyEdge): Record<string, unknown> {
  return {
    edgeKind: 'link',
    linkType: e.link_type,
    utilization: e.utilization,
    trafficClass: e.traffic_class,
    anomalyState: e.anomaly_state,
    latencyMs: e.latency_ms,
    hidden: false,
    raw: e,
  }
}

export function buildTopologyModel(contract: TopologyGraphV2): TopologyModel {
  const graph = new Graph({ multi: true, type: 'undirected' })
  const { clusters, rootClusterIds } = buildClusterIndex(contract)

  for (const c of contract.clusters) {
    const pos = seedPosition(c.cluster_id)
    graph.addNode(c.cluster_id, { x: pos.x, y: pos.y, ...clusterNodeAttrs(c) })
  }

  let deviceCount = 0
  let ghostCount = 0
  for (const n of contract.nodes) {
    if (n.kind === 'device') deviceCount++
    else ghostCount++
    const pos = seedPosition(n.id)
    graph.addNode(n.id, { x: pos.x, y: pos.y, ...deviceNodeAttrs(n, clusters) })
  }

  for (const e of contract.edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
    if (graph.hasEdge(e.id)) continue
    graph.addEdgeWithKey(e.id, e.source, e.target, edgeAttrs(e))
  }

  return {
    graph, clusters, rootClusterIds, deviceCount, ghostCount,
    graphVersion: contract.graph_version,
  }
}

/** Apply static Sigma display attributes (colour / size / label) to every
 *  node + edge. Cheap, idempotent — re-run after a patch. */
export function styleGraph(model: TopologyModel): void {
  const { graph } = model
  graph.forEachNode((key, attr) => {
    if (attr.nodeKind === 'cluster') {
      graph.mergeNodeAttributes(key, {
        color: clusterColor(attr.clusterType),
        size: clusterSize(attr.collapsedCount || 1),
        label: `${attr.label} · ${attr.collapsedCount}`,
      })
    } else {
      graph.mergeNodeAttributes(key, {
        color: nodeColor({ kind: attr.nodeKind, status: attr.status, layer: attr.layer }),
        size: nodeSize(attr.importanceScore || 0.3),
        label: attr.label,
      })
    }
  })
  graph.forEachEdge((key, attr) => {
    if (attr.edgeKind === 'meta') return
    graph.mergeEdgeAttributes(key, {
      color: edgeColor(attr.anomalyState, attr.trafficClass),
      size: edgeSize(attr.utilization ?? null),
    })
  })
}
