/**
 * Overlay model — derives the operational-intelligence layer of the
 * topology from the v2 contract fields already on the graph
 * (anomaly_state, traffic_class, utilization, criticality, status,
 * nodeKind). No new data path — overlays are a pure projection of the
 * RLS-scoped model, so they inherit org/location isolation.
 *
 * Pure + unit-testable. Recomputed on every patch (cheap, O(n+e)).
 */
import type { TopologyModel } from '../graphModel'

/** Toggleable overlay layers. */
export type OverlayLayer =
  | 'anomalyHeat' | 'threats' | 'staleLinks' | 'asymmetric'
  | 'ghosts' | 'bottlenecks' | 'suspicious'

export const OVERLAY_LAYERS: OverlayLayer[] = [
  'anomalyHeat', 'threats', 'staleLinks', 'asymmetric',
  'ghosts', 'bottlenecks', 'suspicious',
]

export type HintSeverity = 'info' | 'warning' | 'critical'

export interface TacticalHint {
  id: string
  severity: HintSeverity
  text: string
  layer?: OverlayLayer
}

export interface NodeOverlayFlags {
  threat: boolean
  heat: boolean
  ghost: boolean
  anomalyEdges: number
}

export interface EdgeOverlayFlags {
  stale: boolean
  asymmetric: boolean
  bottleneck: boolean
  suspicious: boolean
}

export interface OverlayCounts {
  threats: number
  heat: number
  ghosts: number
  staleLinks: number
  asymmetricLinks: number
  bottlenecks: number
  suspicious: number
}

export interface OverlayModel {
  nodes: Map<string, NodeOverlayFlags>
  edges: Map<string, EdgeOverlayFlags>
  hints: TacticalHint[]
  counts: OverlayCounts
}

const BAD_STATUS = new Set(['offline', 'unreachable'])
const HOT_TRAFFIC = new Set(['high', 'saturated'])

/**
 * Classify every node + edge of the model into overlay categories and
 * generate rule-derived tactical hints.
 */
export function deriveOverlayModel(model: TopologyModel): OverlayModel {
  const graph = model.graph
  const nodes = new Map<string, NodeOverlayFlags>()
  const edges = new Map<string, EdgeOverlayFlags>()
  const anomalyDegree = new Map<string, number>()

  const counts: OverlayCounts = {
    threats: 0, heat: 0, ghosts: 0,
    staleLinks: 0, asymmetricLinks: 0, bottlenecks: 0, suspicious: 0,
  }

  // ── edges ───────────────────────────────────────────────────────────────
  graph.forEachEdge((edge, attr, source, target) => {
    if (attr.edgeKind !== 'link') return
    const stale = attr.anomalyState === 'stale'
    const asymmetric = attr.anomalyState === 'asymmetric'
    const bottleneck = HOT_TRAFFIC.has(attr.trafficClass)
    const suspicious = (stale || asymmetric) && bottleneck
    edges.set(edge, { stale, asymmetric, bottleneck, suspicious })
    if (stale) counts.staleLinks++
    if (asymmetric) counts.asymmetricLinks++
    if (bottleneck) counts.bottlenecks++
    if (suspicious) counts.suspicious++
    if (stale || asymmetric) {
      anomalyDegree.set(source, (anomalyDegree.get(source) || 0) + 1)
      anomalyDegree.set(target, (anomalyDegree.get(target) || 0) + 1)
    }
  })

  // ── nodes ───────────────────────────────────────────────────────────────
  graph.forEachNode((id, attr) => {
    if (attr.nodeKind === 'cluster') return
    const ghost = attr.nodeKind === 'ghost'
    const adeg = anomalyDegree.get(id) || 0
    const badStatus = BAD_STATUS.has(attr.status)
    const critical = attr.criticality === 'critical' || attr.criticality === 'high'
    // threat — a critical device down, or a node entangled in ≥2 anomalies
    const threat = !ghost && ((badStatus && critical) || adeg >= 2)
    // heat — warm but not a full threat
    const heat = !ghost && !threat && (adeg >= 1 || badStatus)
    nodes.set(id, { threat, heat, ghost, anomalyEdges: adeg })
    if (ghost) counts.ghosts++
    else if (threat) counts.threats++
    else if (heat) counts.heat++
  })

  return { nodes, edges, hints: buildHints(counts), counts }
}

/** Rule-derived tactical hints — concise operational guidance. */
function buildHints(c: OverlayCounts): TacticalHint[] {
  const hints: TacticalHint[] = []
  if (c.threats > 0) {
    hints.push({
      id: 'threats', severity: 'critical', layer: 'threats',
      text: `${c.threats} tehdit düğümü — operasyonel risk altında`,
    })
  }
  if (c.suspicious > 0) {
    hints.push({
      id: 'suspicious', severity: 'critical', layer: 'suspicious',
      text: `${c.suspicious} şüpheli trafik yolu — yüksek yük + anomali`,
    })
  }
  if (c.bottlenecks > 0) {
    hints.push({
      id: 'bottlenecks', severity: 'warning', layer: 'bottlenecks',
      text: `${c.bottlenecks} yüksek kullanımlı bağlantı — darboğaz`,
    })
  }
  if (c.asymmetricLinks > 0) {
    hints.push({
      id: 'asymmetric', severity: 'warning', layer: 'asymmetric',
      text: `${c.asymmetricLinks} asimetrik bağlantı — olası yapılandırma hatası`,
    })
  }
  if (c.staleLinks > 0) {
    hints.push({
      id: 'stale', severity: 'warning', layer: 'staleLinks',
      text: `${c.staleLinks} bayat bağlantı — yeniden keşif önerilir`,
    })
  }
  if (c.ghosts > 0) {
    hints.push({
      id: 'ghosts', severity: 'info', layer: 'ghosts',
      text: `${c.ghosts} ghost cihaz — envantere alınmamış komşu`,
    })
  }
  return hints
}
