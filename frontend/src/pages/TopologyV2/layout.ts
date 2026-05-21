/**
 * Force layout — runs ForceAtlas2 in a Web Worker so a dense graph never
 * blocks the main thread. T2 is a static engine: the supervisor runs to
 * convergence, then stops; cluster nodes are then positioned at the
 * centroid of their members.
 */
import type Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import FA2LayoutSupervisor from 'graphology-layout-forceatlas2/worker'
import type { TopologyModel } from './graphModel'

/**
 * Create a ForceAtlas2 Web-Worker supervisor for the graph. Caller owns
 * the lifecycle: `.start()`, `.stop()`, `.kill()`.
 */
export function createLayoutWorker(graph: Graph): FA2LayoutSupervisor {
  const inferred = forceAtlas2.inferSettings(graph)
  return new FA2LayoutSupervisor(graph, {
    settings: {
      ...inferred,
      gravity: 1.2,
      scalingRatio: 14,
      slowDown: 8,
      barnesHutOptimize: graph.order > 800, // O(n log n) for large graphs
      adjustSizes: true,
    },
  })
}

/** How long to let the worker layout run before freezing (static engine). */
export function layoutDurationMs(nodeCount: number): number {
  // More nodes ⇒ more iterations needed to settle; capped so the UI is
  // never blocked on layout.
  return Math.min(9000, 2500 + nodeCount * 3)
}

/**
 * Place a cluster node at the centroid of its member devices. Returns
 * `true` if a position was written. Pulled out of `positionClusterNodes`
 * so the full and touched-only paths share the same arithmetic.
 */
function recomputeClusterCentroid(
  graph: Graph,
  cluster: { id: string; memberDeviceKeys: readonly string[] },
): boolean {
  let sx = 0
  let sy = 0
  let n = 0
  for (const key of cluster.memberDeviceKeys) {
    if (!graph.hasNode(key)) continue
    sx += graph.getNodeAttribute(key, 'x') as number
    sy += graph.getNodeAttribute(key, 'y') as number
    n++
  }
  if (n > 0 && graph.hasNode(cluster.id)) {
    graph.setNodeAttribute(cluster.id, 'x', sx / n)
    graph.setNodeAttribute(cluster.id, 'y', sy / n)
    return true
  }
  return false
}

/**
 * Place every cluster node at the centroid of its member devices. Called
 * once the device layout has settled; cluster super-nodes then sit over
 * the mass they represent instead of wherever the worker scattered them.
 *
 * `opts.touched` (T8.3.E2.c) — only recompute centroids of these
 * cluster IDs. The intended use is the SigmaCanvas `[collapsed, model]`
 * delta path: pass the `added = next \ prev` set, and the function
 * skips every cluster whose membership didn't move. At 10 k with ~100
 * clusters, this turns an O(Σ-of-all-memberDeviceKeys) sweep into an
 * O(Σ-of-added-memberDeviceKeys) one — typically a single cluster's
 * worth of work.
 *
 * Pass `undefined` (or omit `opts`) to keep the previous behaviour
 * (full sweep over every cluster). The mount effect and the
 * `[patchSignal]` effect both use the full sweep for correctness:
 * they have no useful `touched` signal.
 */
export function positionClusterNodes(
  model: TopologyModel,
  opts?: { touched?: ReadonlySet<string> },
): void {
  const { graph, clusters } = model
  if (opts?.touched) {
    for (const clusterId of opts.touched) {
      const cluster = clusters.get(clusterId)
      if (cluster) recomputeClusterCentroid(graph, cluster)
    }
    return
  }
  for (const cluster of clusters.values()) {
    recomputeClusterCentroid(graph, cluster)
  }
}
