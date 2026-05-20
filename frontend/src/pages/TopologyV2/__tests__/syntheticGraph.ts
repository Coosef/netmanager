/**
 * Synthetic large-graph generator — TEST / DEV ONLY.
 *
 * Produces a valid v2 topology contract of arbitrary size for scale
 * benchmarking (T7). It lives under __tests__/ and is imported only by
 * tests/benchmarks — no production code path references it, so synthetic
 * data can never reach a real org/location view.
 *
 * The shape mirrors what TopologyService.build_graph_v2 emits: an
 * enterprise hierarchy (location → layer → rack), a realistic layer mix,
 * uplink edges and a sprinkling of anomalies.
 */
import type {
  TopologyGraphV2, TopologyNode, TopologyEdge, TopologyCluster,
  TopologyLayer, TrafficClass, EdgeAnomalyState,
} from '../contract'

/** Seeded RNG (mulberry32) — deterministic fixtures. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LAYER_MIX: [TopologyLayer, number][] = [
  ['core', 0.02], ['distribution', 0.09], ['access', 0.68],
  ['edge', 0.09], ['wireless', 0.12],
]
const CRITICALITY: Record<string, 'critical' | 'high' | 'normal' | 'low'> = {
  core: 'critical', distribution: 'high', access: 'normal',
  edge: 'normal', wireless: 'low',
}
const IMPORTANCE: Record<string, number> = {
  core: 0.97, distribution: 0.78, access: 0.45, edge: 0.32, wireless: 0.28,
}
const LABEL_PRIORITY: Record<string, number> = {
  core: 1, distribution: 1, access: 2, edge: 3, wireless: 3,
}
const MIN_ZOOM: Record<string, number> = {
  core: 0, distribution: 0, access: 1, edge: 2, wireless: 2,
}
const VENDORS = ['cisco', 'aruba', 'ruijie', 'juniper']
const TRAFFIC: TrafficClass[] = ['idle', 'low', 'normal', 'normal', 'high', 'saturated']

export interface SyntheticOptions {
  seed?: number
  /** Fraction of edges flagged stale / asymmetric. */
  anomalyRate?: number
  /** Ghost nodes as a fraction of device count. */
  ghostRate?: number
}

/**
 * Generate a synthetic v2 contract with ~`nodeCount` device nodes
 * (+ ghosts), a realistic hierarchy and uplink topology.
 */
export function generateSyntheticContract(
  nodeCount: number,
  options: SyntheticOptions = {},
): TopologyGraphV2 {
  const { seed = 1, anomalyRate = 0.05, ghostRate = 0.04 } = options
  const rand = rng(seed)
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]

  const locationCount = Math.min(6, Math.max(2, Math.round(nodeCount / 2000)))
  const nodes: TopologyNode[] = []
  const edges: TopologyEdge[] = []
  const clusterSet = new Map<string, TopologyCluster>()

  // device id → layer, for edge wiring
  const byLayer: Record<string, number[]> = {
    core: [], distribution: [], access: [], edge: [], wireless: [],
  }
  const deviceLoc = new Map<number, number>()

  let nextId = 1
  const perLocation = Math.ceil(nodeCount / locationCount)

  for (let loc = 1; loc <= locationCount; loc++) {
    const locCid = `loc:${loc}`
    ensureCluster(clusterSet, locCid, 'location', `Lokasyon ${loc}`, null)

    const here = Math.min(perLocation, nodeCount - (loc - 1) * perLocation)
    if (here <= 0) break
    let rackCounter = 0
    let rackFill = 0
    let rackName = `R${loc}-1`

    for (const [layer, frac] of LAYER_MIX) {
      const count = Math.max(layer === 'core' ? 1 : 0, Math.round(here * frac))
      const layerCid = `${locCid}|layer:${layer}`
      ensureCluster(clusterSet, layerCid, 'layer', layer, locCid)

      for (let i = 0; i < count && nextId <= nodeCount * 1; i++) {
        const id = nextId++
        let clusterId = layerCid
        let rack: string | null = null
        if (layer === 'access') {
          if (rackFill >= 24) { rackCounter++; rackFill = 0; rackName = `R${loc}-${rackCounter + 1}` }
          rackFill++
          rack = rackName
          clusterId = `${layerCid}|rack:${rack}`
          ensureCluster(clusterSet, clusterId, 'rack', rack, layerCid)
        }
        const status = rand() < 0.05 ? (rand() < 0.5 ? 'offline' : 'unreachable') : 'online'
        nodes.push({
          id: `d-${id}`, kind: 'device',
          data: {
            device_id: id, label: `${layer.slice(0, 3)}-${id}`,
            ip: `10.${loc}.${(id >> 8) & 255}.${id & 255}`,
            organization_id: 1, location_id: loc, location: `Lokasyon ${loc}`,
            layer, rack, zone: `Bina ${loc}`, device_role: 'switch',
            vendor: pick(VENDORS), status, criticality: CRITICALITY[layer],
            cluster_id: clusterId, importance_score: IMPORTANCE[layer],
            label_priority: LABEL_PRIORITY[layer], render_class: layer,
            min_zoom_level: MIN_ZOOM[layer], lod_tier:
              layer === 'core' || layer === 'distribution' ? 'primary'
                : layer === 'access' ? 'secondary' : 'detail',
          },
        })
        byLayer[layer].push(id)
        deviceLoc.set(id, loc)
      }
    }
  }

  // ── uplink topology: access → distribution → core, per location ─────────
  const addEdge = (a: number, b: number) => {
    if (a === b) return
    const id = `e-${Math.min(a, b)}-${Math.max(a, b)}-${edges.length}`
    const anomaly: EdgeAnomalyState =
      rand() < anomalyRate / 2 ? 'stale'
        : rand() < anomalyRate / 2 ? 'asymmetric' : 'none'
    const traffic = pick(TRAFFIC)
    edges.push({
      id, source: `d-${a}`, target: `d-${b}`,
      link_type: 'uplink',
      utilization: traffic === 'saturated' ? 0.92 : traffic === 'high' ? 0.7
        : traffic === 'normal' ? 0.4 : traffic === 'low' ? 0.15 : 0.02,
      traffic_class: traffic, anomaly_state: anomaly, latency_ms: null, data: {},
    })
  }
  const sameLoc = (ids: number[], loc: number) => ids.filter((d) => deviceLoc.get(d) === loc)

  for (let loc = 1; loc <= locationCount; loc++) {
    const core = sameLoc(byLayer.core, loc)
    const dist = sameLoc(byLayer.distribution, loc)
    const access = sameLoc(byLayer.access, loc)
    const edge = sameLoc(byLayer.edge, loc)
    const wireless = sameLoc(byLayer.wireless, loc)
    // core mesh
    for (let i = 0; i < core.length; i++) {
      for (let j = i + 1; j < core.length; j++) addEdge(core[i], core[j])
    }
    // distribution → core
    dist.forEach((d) => { if (core.length) addEdge(d, core[Math.floor(rand() * core.length)]) })
    // access / edge / wireless → distribution
    const upTarget = dist.length ? dist : core
    ;[...access, ...edge, ...wireless].forEach((d) => {
      if (upTarget.length) addEdge(d, upTarget[Math.floor(rand() * upTarget.length)])
    })
  }
  // cross-location core backbone
  for (let loc = 2; loc <= locationCount; loc++) {
    const a = sameLoc(byLayer.core, loc - 1)[0]
    const b = sameLoc(byLayer.core, loc)[0]
    if (a && b) addEdge(a, b)
  }

  // ── ghost devices ───────────────────────────────────────────────────────
  const ghostCount = Math.round(nodes.length * ghostRate)
  for (let g = 0; g < ghostCount; g++) {
    const access = byLayer.access
    if (!access.length) break
    const src = access[Math.floor(rand() * access.length)]
    const gid = `ghost-gx-${g}`
    const loc = deviceLoc.get(src) ?? 1
    nodes.push({
      id: gid, kind: 'ghost',
      data: {
        label: `ghost-${g}`, ghost: true, layer: 'wireless', device_role: 'ap',
        criticality: 'low', cluster_id: `loc:${loc}|layer:access`,
        importance_score: 0.15, label_priority: 3, render_class: 'ghost',
        min_zoom_level: 2, lod_tier: 'detail', source_device_id: src,
        organization_id: 1, location_id: loc,
      },
    })
    edges.push({
      id: `eg-${src}-${g}`, source: `d-${src}`, target: gid,
      link_type: 'ghost', utilization: null, traffic_class: 'unknown',
      anomaly_state: 'ghost', latency_ms: null, data: {},
    })
  }

  const clusters = [...clusterSet.values()]
  return {
    contract_version: 2,
    graph_version: 1,
    updated_at: new Date().toISOString(),
    scope: { organization_id: 1, location_id: null },
    nodes, edges, clusters,
    stats: {
      total_nodes: nodes.length,
      device_nodes: nodes.filter((n) => n.kind === 'device').length,
      ghost_nodes: ghostCount,
      total_edges: edges.length,
      clusters: clusters.length,
    },
    patch_protocol: {
      graph_version: 1,
      channel: 'network:events:org:{organization_id}',
      event_prefix: 'topology_',
      node_events: ['topology_node_added', 'topology_node_removed', 'topology_node_updated'],
      edge_events: ['topology_edge_added', 'topology_edge_removed', 'topology_edge_updated'],
      bulk_events: ['topology_links_updated', 'topology_drift'],
    },
  }
}

function ensureCluster(
  map: Map<string, TopologyCluster>,
  id: string,
  type: TopologyCluster['cluster_type'],
  label: string,
  parent: string | null,
): void {
  if (map.has(id)) return
  map.set(id, {
    cluster_id: id, cluster_type: type, label, parent_cluster_id: parent,
    collapsed_count: 0,
    health: { online: 0, offline: 0, unknown: 0, score: 1 },
    traffic: { avg_utilization: 0, max_utilization: 0 },
  })
}
