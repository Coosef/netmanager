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
 * Place every cluster node at the centroid of its member devices. Called
 * once the device layout has settled; cluster super-nodes then sit over
 * the mass they represent instead of wherever the worker scattered them.
 */
export function positionClusterNodes(model: TopologyModel): void {
  const { graph, clusters } = model
  for (const cluster of clusters.values()) {
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
    }
  }
}
