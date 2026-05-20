/**
 * 3D layout — two deterministic, O(n) placement modes for the tactical
 * engine. Deterministic (no main-thread force sim) so it scales to 5k
 * nodes and is unit-testable.
 *
 *   Orbit   — layered hierarchy: each network layer is a horizontal
 *             stratum; devices sit on a golden-angle disc with organic,
 *             asymmetric jitter — a living, semi-organic system.
 *   Cluster — molecular: location nuclei → layer sub-nuclei → devices on
 *             electron-shell fibonacci spheres. Force-directed in feel,
 *             stabilised by construction.
 */
import type { TopologyModel } from '../graphModel'

export type Vec3 = [number, number, number]
export type LayoutMode = 'orbit' | 'cluster'

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

const LAYER_Y: Record<string, number> = {
  core: 150, distribution: 75, access: 0, edge: -75, wireless: -150,
}

/** Deterministic [0,1) hash of a string — stable organic jitter. */
function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/** Point i of n on a unit fibonacci sphere. */
function fibSphere(i: number, n: number): Vec3 {
  if (n <= 1) return [0, 0, 0]
  const y = 1 - (i / (n - 1)) * 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const theta = i * GOLDEN_ANGLE
  return [Math.cos(theta) * r, y, Math.sin(theta) * r]
}

interface NodeRec {
  id: string
  kind: string
  layer: string
  path: string[] // cluster path: [location, layer, rack?]
  sourceId?: string | null
}

function collectNodes(model: TopologyModel): NodeRec[] {
  const recs: NodeRec[] = []
  model.graph.forEachNode((id, attr) => {
    if (attr.nodeKind === 'cluster') return
    recs.push({
      id,
      kind: attr.nodeKind,
      layer: (attr.layer || 'unknown').toLowerCase(),
      path: attr.clusterPath || [],
      sourceId: attr.raw?.data?.source_device_id != null
        ? `d-${attr.raw.data.source_device_id}` : null,
    })
  })
  return recs
}

/** Place every cluster super-node at the centroid of its members. */
function placeClusters(model: TopologyModel, pos: Map<string, Vec3>): void {
  for (const cluster of model.clusters.values()) {
    let sx = 0, sy = 0, sz = 0, n = 0
    for (const key of cluster.memberDeviceKeys) {
      const p = pos.get(key)
      if (!p) continue
      sx += p[0]; sy += p[1]; sz += p[2]; n++
    }
    if (n > 0) pos.set(cluster.id, [sx / n, sy / n, sz / n])
  }
}

// ── Orbit mode ──────────────────────────────────────────────────────────────

function orbitLayout(model: TopologyModel): Map<string, Vec3> {
  const pos = new Map<string, Vec3>()
  const recs = collectNodes(model)

  const devices = recs.filter((r) => r.kind === 'device')
  const ghosts = recs.filter((r) => r.kind === 'ghost')

  // group devices by layer stratum
  const byLayer = new Map<string, NodeRec[]>()
  for (const r of devices) {
    const arr = byLayer.get(r.layer) || []
    arr.push(r)
    byLayer.set(r.layer, arr)
  }

  for (const [layer, arr] of byLayer) {
    const baseY = LAYER_Y[layer] ?? 0
    const discR = 80 + Math.sqrt(arr.length) * 24
    arr.forEach((r, i) => {
      // golden-angle disc + organic asymmetric jitter
      const t = i / Math.max(1, arr.length)
      const radius = discR * Math.sqrt(t) * (0.85 + hash01(r.id, 1) * 0.3)
      const theta = i * GOLDEN_ANGLE + hash01(r.id, 2) * 0.4
      const y = baseY + (hash01(r.id, 3) - 0.5) * 36
      pos.set(r.id, [Math.cos(theta) * radius, y, Math.sin(theta) * radius])
    })
  }

  // ghosts hover just outside their source device
  for (const g of ghosts) {
    const src = g.sourceId ? pos.get(g.sourceId) : undefined
    if (src) {
      pos.set(g.id, [
        src[0] + (hash01(g.id, 4) - 0.5) * 70,
        src[1] - 20 - hash01(g.id, 5) * 30,
        src[2] + (hash01(g.id, 6) - 0.5) * 70,
      ])
    } else {
      const r = 120 + hash01(g.id, 7) * 200
      const th = hash01(g.id, 8) * Math.PI * 2
      pos.set(g.id, [Math.cos(th) * r, LAYER_Y.wireless - 40, Math.sin(th) * r])
    }
  }

  placeClusters(model, pos)
  return pos
}

// ── Cluster mode ────────────────────────────────────────────────────────────

function clusterLayout(model: TopologyModel): Map<string, Vec3> {
  const pos = new Map<string, Vec3>()
  const recs = collectNodes(model)

  // group: location → layerCluster → nodes
  const byLoc = new Map<string, Map<string, NodeRec[]>>()
  for (const r of recs) {
    const loc = r.path[0] || 'loc:none'
    const layerCid = r.path[1] || r.path[0] || 'layer:none'
    let layers = byLoc.get(loc)
    if (!layers) { layers = new Map(); byLoc.set(loc, layers) }
    const arr = layers.get(layerCid) || []
    arr.push(r)
    layers.set(layerCid, arr)
  }

  const locIds = [...byLoc.keys()]
  const LOC_R = locIds.length > 1 ? 320 + locIds.length * 28 : 0

  locIds.forEach((loc, li) => {
    const lt = (li / Math.max(1, locIds.length)) * Math.PI * 2
    const nucleus: Vec3 = [Math.cos(lt) * LOC_R, 0, Math.sin(lt) * LOC_R]
    const layers = byLoc.get(loc)!
    const layerIds = [...layers.keys()]

    layerIds.forEach((layerCid, ci) => {
      // layer sub-nucleus on a small sphere around the location nucleus
      const s = fibSphere(ci, Math.max(2, layerIds.length))
      const LAYER_R = 130
      const sub: Vec3 = [
        nucleus[0] + s[0] * LAYER_R,
        nucleus[1] + s[1] * LAYER_R * 0.7,
        nucleus[2] + s[2] * LAYER_R,
      ]
      const arr = layers.get(layerCid)!
      const devR = 38 + Math.sqrt(arr.length) * 17
      arr.forEach((r, i) => {
        const f = fibSphere(i, Math.max(2, arr.length))
        const jitter = 0.88 + hash01(r.id, 9) * 0.24
        pos.set(r.id, [
          sub[0] + f[0] * devR * jitter,
          sub[1] + f[1] * devR * jitter,
          sub[2] + f[2] * devR * jitter,
        ])
      })
    })
  })

  placeClusters(model, pos)
  return pos
}

/** Compute 3D positions for every node in the model. */
export function computeLayout(model: TopologyModel, mode: LayoutMode): Map<string, Vec3> {
  return mode === 'cluster' ? clusterLayout(model) : orbitLayout(model)
}
