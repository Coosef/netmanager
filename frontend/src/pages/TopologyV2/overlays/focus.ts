/**
 * Incident focus — blast-radius / dependency-impact computation.
 *
 * A breadth-first sweep over the link graph from a selected node yields
 * the set of devices within N hops — the "blast radius" if that node is
 * impaired. Renderers dim everything outside the set and emphasise the
 * affected paths. Pure + unit-testable.
 */
import type { TopologyModel } from '../graphModel'

export interface FocusSet {
  rootId: string
  /** Affected node ids (root + everything within maxDepth hops). */
  nodes: Set<string>
  /** Link-edge ids fully inside the affected set. */
  edges: Set<string>
  /** node id → hop distance from the root. */
  depth: Map<string, number>
  maxDepth: number
}

/** Link-edge adjacency (device↔device / device↔ghost, ignores meta-edges). */
function linkAdjacency(model: TopologyModel): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  model.graph.forEachEdge((_e, attr, s, t) => {
    if (attr.edgeKind !== 'link') return
    ;(adj.get(s) ?? adj.set(s, []).get(s)!).push(t)
    ;(adj.get(t) ?? adj.set(t, []).get(t)!).push(s)
  })
  return adj
}

/**
 * Compute the blast radius of `nodeId` — the BFS reachable set within
 * `maxDepth` hops. Returns null for an unknown or cluster node.
 */
export function computeFocusSet(
  model: TopologyModel,
  nodeId: string,
  maxDepth = 3,
): FocusSet | null {
  if (!model.graph.hasNode(nodeId)) return null
  if (model.graph.getNodeAttribute(nodeId, 'nodeKind') === 'cluster') return null

  const adj = linkAdjacency(model)
  const depth = new Map<string, number>([[nodeId, 0]])
  let frontier = [nodeId]
  for (let d = 1; d <= maxDepth; d++) {
    const next: string[] = []
    for (const node of frontier) {
      for (const nb of adj.get(node) ?? []) {
        if (!depth.has(nb)) {
          depth.set(nb, d)
          next.push(nb)
        }
      }
    }
    frontier = next
    if (!frontier.length) break
  }

  const nodes = new Set(depth.keys())
  const edges = new Set<string>()
  model.graph.forEachEdge((edge, attr, s, t) => {
    if (attr.edgeKind === 'link' && nodes.has(s) && nodes.has(t)) edges.add(edge)
  })

  return { rootId: nodeId, nodes, edges, depth, maxDepth }
}
