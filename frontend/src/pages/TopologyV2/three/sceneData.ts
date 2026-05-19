/**
 * Scene data — derives GPU-ready buffers for the 3D engine from the
 * topology model: per-class node instance lists + a packed edge buffer
 * for the traffic shader. Pure (apart from applying the cluster view to
 * the graph) and unit-testable.
 */
import * as THREE from 'three'
import type { TopologyModel } from '../graphModel'
import { applyClusterView } from '../clustering'
import { edgeColor } from '../rendering'
import { computeLayout, type LayoutMode, type Vec3 } from './layout3d'
import {
  classifyNode, statusTint, NODE_CLASS_STYLE, type NodeClass,
} from './nodeClasses'

export interface InstanceRec {
  id: string
  pos: Vec3
  color: string
  scale: number
}

export interface EdgeBuffers {
  positions: Float32Array
  progress: Float32Array
  color: Float32Array
  flow: Float32Array
  seed: Float32Array
  count: number // edge count (2 vertices each)
}

export interface SceneData {
  nodes: Record<NodeClass, InstanceRec[]>
  clusters: InstanceRec[]
  edges: EdgeBuffers
  /** Node id → 3D position — lets the camera resolve an incident focus. */
  layout: Map<string, Vec3>
}

function hashSeed(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return ((h >>> 0) % 1000) / 1000
}

/**
 * Build the renderable scene from the model. Applies the cluster view
 * (collapse/expand) and the chosen 3D layout, then packs instances +
 * the edge vertex buffer.
 */
export function buildSceneData(
  model: TopologyModel,
  collapsed: Set<string>,
  mode: LayoutMode,
): SceneData {
  applyClusterView(model, collapsed)
  const layout = computeLayout(model, mode)
  const graph = model.graph

  const nodes: Record<NodeClass, InstanceRec[]> = {
    core: [], distribution: [], access: [], wireless: [],
    swarm: [], ghost: [], threat: [],
  }
  const clusters: InstanceRec[] = []

  graph.forEachNode((id, attr) => {
    if (attr.hidden) return
    const pos = layout.get(id)
    if (!pos) return

    if (attr.nodeKind === 'cluster') {
      clusters.push({
        id, pos,
        color: attr.color || '#64748b',
        scale: 8 + Math.min(34, Math.log2((attr.collapsedCount || 1) + 1) * 6),
      })
      return
    }

    const cls: NodeClass = classifyNode(attr)
    const style = NODE_CLASS_STYLE[cls]
    const tint = statusTint(attr.status)
    const importance = attr.importanceScore ?? 0.3
    nodes[cls].push({
      id, pos,
      color: tint.override || style.color,
      scale: style.size * (0.7 + importance * 0.6) * tint.mul,
    })
  })

  // ── edges → packed vertex buffer ──────────────────────────────────────
  const visible: { s: Vec3; t: Vec3; flow: number; color: THREE.Color; seed: number }[] = []
  const tmp = new THREE.Color()
  graph.forEachEdge((edge, attr, source, target) => {
    if (attr.hidden) return
    const s = layout.get(source)
    const t = layout.get(target)
    if (!s || !t) return
    const flow = Math.max(0, Math.min(1, attr.utilization ?? 0))
    tmp.set(edgeColor(attr.anomalyState ?? 'none', attr.trafficClass ?? 'unknown'))
    visible.push({ s, t, flow, color: tmp.clone(), seed: hashSeed(edge) })
  })

  const n = visible.length
  const positions = new Float32Array(n * 6)
  const progress = new Float32Array(n * 2)
  const color = new Float32Array(n * 6)
  const flow = new Float32Array(n * 2)
  const seed = new Float32Array(n * 2)
  visible.forEach((e, i) => {
    positions.set([e.s[0], e.s[1], e.s[2], e.t[0], e.t[1], e.t[2]], i * 6)
    progress[i * 2] = 0
    progress[i * 2 + 1] = 1
    color.set([e.color.r, e.color.g, e.color.b, e.color.r, e.color.g, e.color.b], i * 6)
    flow[i * 2] = e.flow
    flow[i * 2 + 1] = e.flow
    seed[i * 2] = e.seed
    seed[i * 2 + 1] = e.seed
  })

  return {
    nodes, clusters, layout,
    edges: { positions, progress, color, flow, seed, count: n },
  }
}
