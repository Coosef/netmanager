import { describe, it, expect } from 'vitest'
import { buildTopologyModel } from '../graphModel'
import { collapsedSetForTier } from '../clustering'
import { computeLayout } from '../three/layout3d'
import { classifyNode, statusTint, NODE_CLASS_STYLE } from '../three/nodeClasses'
import { lodForDistance, labelVisibleAt, atmosphericFade, lodScale } from '../three/lod'
import { buildSceneData } from '../three/sceneData'
import { makeFixture } from './fixture'

function finiteVec(v: unknown): boolean {
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n))
}

// ── 3D layout ───────────────────────────────────────────────────────────────
describe('computeLayout', () => {
  for (const mode of ['orbit', 'cluster'] as const) {
    it(`${mode}: every node + cluster gets a finite 3D position`, () => {
      const model = buildTopologyModel(makeFixture())
      const layout = computeLayout(model, mode)
      model.graph.forEachNode((id) => {
        expect(finiteVec(layout.get(id)), `${id} missing position`).toBe(true)
      })
    })
  }

  it('orbit places network layers on distinct vertical strata', () => {
    const model = buildTopologyModel(makeFixture())
    const layout = computeLayout(model, 'orbit')
    const coreY = layout.get('d-1')![1]   // core
    const accessY = layout.get('d-2')![1] // access
    expect(coreY).toBeGreaterThan(accessY) // core sits above access
  })
})

// ── node classification ─────────────────────────────────────────────────────
describe('classifyNode', () => {
  it('maps layer to class and ghost-kind to ghost', () => {
    expect(classifyNode({ nodeKind: 'device', layer: 'core' })).toBe('core')
    expect(classifyNode({ nodeKind: 'device', layer: 'access' })).toBe('access')
    expect(classifyNode({ nodeKind: 'ghost', layer: 'wireless' })).toBe('ghost')
  })
  it('maps an AP role to wireless and a client role to the swarm', () => {
    expect(classifyNode({ nodeKind: 'device', layer: 'access', device_role: 'ap' }))
      .toBe('wireless')
    expect(classifyNode({ nodeKind: 'device', layer: 'access', device_role: 'camera' }))
      .toBe('swarm')
  })
  it('every class has a defined tactical style', () => {
    for (const cls of Object.keys(NODE_CLASS_STYLE)) {
      expect(NODE_CLASS_STYLE[cls as keyof typeof NODE_CLASS_STYLE].size).toBeGreaterThan(0)
    }
  })
  it('statusTint overrides colour for offline / unreachable', () => {
    expect(statusTint('offline').override).toBe('#ef4444')
    expect(statusTint('unreachable').override).toBe('#f59e0b')
    expect(statusTint('online').override).toBeUndefined()
  })
})

// ── LOD ─────────────────────────────────────────────────────────────────────
describe('lod', () => {
  it('buckets distance into near / mid / far', () => {
    expect(lodForDistance(100)).toBe('near')
    expect(lodForDistance(600)).toBe('mid')
    expect(lodForDistance(2000)).toBe('far')
  })
  it('keeps only priority-1 labels at far distance', () => {
    expect(labelVisibleAt(1, 2000)).toBe(true)
    expect(labelVisibleAt(3, 2000)).toBe(false)
    expect(labelVisibleAt(3, 100)).toBe(true)
  })
  it('atmospheric fade decreases with distance and stays in 0..1', () => {
    expect(atmosphericFade(100)).toBe(1)
    const far = atmosphericFade(2000)
    expect(far).toBeGreaterThan(0)
    expect(far).toBeLessThan(1)
  })
  it('lod scale shrinks distant instances', () => {
    expect(lodScale('near')).toBeGreaterThan(lodScale('far'))
  })
})

// ── scene data ──────────────────────────────────────────────────────────────
describe('buildSceneData', () => {
  it('device tier — buckets nodes by class and packs every edge', () => {
    const model = buildTopologyModel(makeFixture())
    const data = buildSceneData(model, collapsedSetForTier(model, 'device'), 'orbit')
    expect(data.nodes.core).toHaveLength(1)   // core-sw
    expect(data.nodes.access).toHaveLength(2) // acc-sw1, acc-sw2
    expect(data.nodes.ghost).toHaveLength(1)
    expect(data.clusters).toHaveLength(0)     // nothing collapsed
    expect(data.edges.count).toBe(3)
    // packed buffer is 6 floats (2 verts × xyz) per edge
    expect(data.edges.positions).toHaveLength(3 * 6)
    expect(data.edges.flow).toHaveLength(3 * 2)
  })

  it('layer tier — substitutes clusters for hidden devices', () => {
    const model = buildTopologyModel(makeFixture())
    const data = buildSceneData(model, collapsedSetForTier(model, 'layer'), 'cluster')
    const deviceInstances = Object.values(data.nodes).reduce((s, a) => s + a.length, 0)
    expect(deviceInstances).toBe(0)        // all devices folded away
    expect(data.clusters.length).toBeGreaterThan(0) // cluster super-nodes shown
  })

  it('exposes a layout position for every visible node (camera focus)', () => {
    const model = buildTopologyModel(makeFixture())
    const data = buildSceneData(model, collapsedSetForTier(model, 'device'), 'orbit')
    expect(finiteVec(data.layout.get('d-1'))).toBe(true)
  })
})
