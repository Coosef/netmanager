import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'

const NODE_WIDTH = 145
const NODE_HEIGHT = 70

export type LayoutType = 'TB' | 'LR' | 'grid' | 'circle'

export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB',
): Node[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 80, edgesep: 20 })
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }))
  edges.forEach((e) => g.setEdge(e.source, e.target))
  dagre.layout(g)
  return nodes.map((n) => {
    const pos = g.node(n.id)
    return { ...n, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } }
  })
}

export function applyGridLayout(nodes: Node[]): Node[] {
  const cols = Math.ceil(Math.sqrt(nodes.length * 1.4))
  const H = 185
  const V = 110
  return nodes.map((n, i) => ({
    ...n,
    position: { x: (i % cols) * H, y: Math.floor(i / cols) * V },
  }))
}

export function applyCircularLayout(nodes: Node[]): Node[] {
  if (nodes.length === 0) return nodes
  // For very large graphs, circle becomes impractical — fall back to grid
  if (nodes.length > 250) return applyGridLayout(nodes)
  // ~80px arc-spacing per node, capped at 2400px to stay within safe SVG bounds
  const radius = Math.max(200, Math.min(Math.ceil(nodes.length * 13), 2400))
  const angleStep = (2 * Math.PI) / nodes.length
  return nodes.map((n, i) => ({
    ...n,
    position: {
      x: Math.cos(i * angleStep - Math.PI / 2) * radius,
      y: Math.sin(i * angleStep - Math.PI / 2) * radius,
    },
  }))
}

export function applyLayout(nodes: Node[], edges: Edge[], type: LayoutType): Node[] {
  if (type === 'grid') return applyGridLayout(nodes)
  if (type === 'circle') return applyCircularLayout(nodes)
  return applyDagreLayout(nodes, edges, type)
}
