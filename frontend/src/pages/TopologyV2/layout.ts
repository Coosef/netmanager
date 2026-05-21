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

/**
 * Yield to the browser's main-thread scheduler — `requestAnimationFrame`
 * when present (real browser), `setTimeout(0)` otherwise (jsdom, node).
 * The cluster-finalize chunker uses this to split a multi-second sync
 * block into 60-fps-friendly tasks. T8.3.E2.e.
 */
function yieldToMain(): Promise<void> {
  if (typeof requestAnimationFrame !== 'undefined') {
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export interface ChunkedPositionOptions {
  /**
   * Hard ceiling on the amount of main-thread time we spend without
   * yielding. The function checks the wall-clock after each cluster
   * and breaks out via `yieldToMain()` when the budget is exhausted.
   * Default 8 ms — half a 60 fps frame, so even paired with Sigma's
   * own work each tick stays well under the 50 ms long-task threshold.
   */
  budgetMs?: number
  /**
   * Cancellation hook checked between chunks. The FA2-finalize callback
   * in `SigmaCanvas` uses this to bail out cleanly if the component
   * unmounts mid-chunk (location swap or page leave during the 9-second
   * FA2 cap).
   */
  isCancelled?: () => boolean
  /** Optional sink for the IDs we actually wrote — handy when the
   *  caller wants to feed those back into a partial Sigma refresh. */
  onWritten?: (clusterId: string) => void
}

/**
 * Async, chunked variant of `positionClusterNodes` for the post-FA2
 * finalize callback (T8.3.E2.e / BASELINE_PROFILE B6).
 *
 * The sync `positionClusterNodes(model)` at 10 k iterates every
 * cluster's full `memberDeviceKeys` and produces a single ~5+ second
 * main-thread block. This variant processes clusters in time-budgeted
 * batches, yielding to the main thread between them so the longest
 * task observed by the harness stays well below 50 ms.
 *
 * Visual end state is IDENTICAL to the sync function (the same
 * `recomputeClusterCentroid` helper does the arithmetic for both).
 * The only behavioural difference is timing: a brief window exists
 * where some clusters have new centroids and others still hold their
 * pre-finalize positions. Sigma renders continuously through that
 * window, so the user sees clusters "settling in" over a few frames
 * instead of one big snap — usually less jarring, never less correct.
 */
export async function positionClusterNodesChunked(
  model: TopologyModel,
  opts: ChunkedPositionOptions = {},
): Promise<void> {
  const { graph, clusters } = model
  const budget = opts.budgetMs ?? 8
  let chunkStart = performance.now()
  for (const cluster of clusters.values()) {
    if (opts.isCancelled?.()) return
    if (recomputeClusterCentroid(graph, cluster)) {
      opts.onWritten?.(cluster.id)
    }
    if (performance.now() - chunkStart >= budget) {
      await yieldToMain()
      if (opts.isCancelled?.()) return
      chunkStart = performance.now()
    }
  }
}
