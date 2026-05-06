import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'

const NODE_WIDTH = 155
const NODE_HEIGHT = 72

export type LayoutType = 'TB' | 'LR' | 'grid' | 'circle' | 'force'

export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB',
): Node[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, nodesep: 90, ranksep: 130, edgesep: 30 })
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }))
  edges.forEach((e) => g.setEdge(e.source, e.target))
  dagre.layout(g)
  return nodes.map((n) => {
    const pos = g.node(n.id)
    return { ...n, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } }
  })
}

export function applyGridLayout(nodes: Node[], cols?: number): Node[] {
  const c = cols ?? Math.ceil(Math.sqrt(nodes.length * 1.6))
  const H = 200
  const V = 120
  return nodes.map((n, i) => ({
    ...n,
    position: { x: (i % c) * H, y: Math.floor(i / c) * V },
  }))
}

export function applyCircularLayout(nodes: Node[]): Node[] {
  if (nodes.length === 0) return nodes
  if (nodes.length > 250) return applyGridLayout(nodes)
  const radius = Math.max(220, Math.min(Math.ceil(nodes.length * 15), 2400))
  const angleStep = (2 * Math.PI) / nodes.length
  return nodes.map((n, i) => ({
    ...n,
    position: {
      x: Math.cos(i * angleStep - Math.PI / 2) * radius,
      y: Math.sin(i * angleStep - Math.PI / 2) * radius,
    },
  }))
}

// Fruchterman-Reingold force-directed layout
export function applyForceLayout(nodes: Node[], edges: Edge[]): Node[] {
  const N = nodes.length
  if (N === 0) return nodes
  if (N === 1) return [{ ...nodes[0], position: { x: 0, y: 0 } }]

  // Canvas area proportional to node count
  const area = Math.max(180_000, N * 8_000)
  const W = Math.sqrt(area * 1.6)
  const H = Math.sqrt(area / 1.6)
  const k = Math.sqrt(area / N)       // ideal spring length
  const REPULSION = k * k
  const ITERATIONS = Math.min(200, 80 + N * 2)

  // Initialize in a circle to avoid overlapping start
  const pos: { x: number; y: number }[] = nodes.map((_, i) => {
    const angle = (i / N) * 2 * Math.PI
    return {
      x: W / 2 + Math.cos(angle) * (W / 3.5),
      y: H / 2 + Math.sin(angle) * (H / 3.5),
    }
  })

  const idxMap = new Map(nodes.map((n, i) => [n.id, i]))

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const temp = W * (1 - iter / ITERATIONS) * 0.5 + 2
    const disp: { x: number; y: number }[] = Array.from({ length: N }, () => ({ x: 0, y: 0 }))

    // Repulsion between all pairs
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = pos[i].x - pos[j].x
        const dy = pos[i].y - pos[j].y
        const dist2 = dx * dx + dy * dy || 0.01
        const dist = Math.sqrt(dist2)
        const force = REPULSION / dist
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        disp[i].x += fx; disp[i].y += fy
        disp[j].x -= fx; disp[j].y -= fy
      }
    }

    // Attraction along edges
    for (const e of edges) {
      const si = idxMap.get(e.source)
      const ti = idxMap.get(e.target)
      if (si === undefined || ti === undefined) continue
      const dx = pos[ti].x - pos[si].x
      const dy = pos[ti].y - pos[si].y
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
      const force = (dist * dist) / k
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      disp[si].x += fx; disp[si].y += fy
      disp[ti].x -= fx; disp[ti].y -= fy
    }

    // Apply with temperature (cooling)
    for (let i = 0; i < N; i++) {
      const len = Math.sqrt(disp[i].x ** 2 + disp[i].y ** 2) || 1
      const scale = Math.min(temp, len) / len
      pos[i].x = Math.max(0, Math.min(W, pos[i].x + disp[i].x * scale))
      pos[i].y = Math.max(0, Math.min(H, pos[i].y + disp[i].y * scale))
    }
  }

  // Shift so min x/y = 0
  const minX = Math.min(...pos.map((p) => p.x))
  const minY = Math.min(...pos.map((p) => p.y))
  return nodes.map((n, i) => ({
    ...n,
    position: { x: pos[i].x - minX, y: pos[i].y - minY },
  }))
}

export function applyLayout(nodes: Node[], edges: Edge[], type: LayoutType): Node[] {
  if (type === 'grid')   return applyGridLayout(nodes)
  if (type === 'circle') return applyCircularLayout(nodes)
  if (type === 'force')  return applyForceLayout(nodes, edges)
  return applyDagreLayout(nodes, edges, type)
}
