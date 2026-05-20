import { describe, it, expect } from 'vitest'
import { buildTopologyModel, clusterPath } from '../graphModel'
import { makeFixture } from './fixture'

describe('buildTopologyModel', () => {
  it('builds device, ghost and cluster nodes plus contract edges', () => {
    const m = buildTopologyModel(makeFixture())
    // 3 devices + 1 ghost + 4 clusters
    expect(m.graph.order).toBe(8)
    // 3 contract edges (meta-edges are derived at view time, not here)
    expect(m.graph.size).toBe(3)
    expect(m.deviceCount).toBe(3)
    expect(m.ghostCount).toBe(1)
    expect(m.graphVersion).toBe(7)
  })

  it('registers the cluster hierarchy with correct parents and roots', () => {
    const m = buildTopologyModel(makeFixture())
    expect(m.rootClusterIds).toEqual(['loc:7'])
    expect(m.clusters.get('loc:7|layer:core')!.parentId).toBe('loc:7')
    expect(m.clusters.get('loc:7|layer:core|rack:R1')!.depth).toBe(2)
    expect(m.clusters.get('loc:7')!.childClusterIds).toContain('loc:7|layer:access')
  })

  it('accumulates recursive device membership on every ancestor cluster', () => {
    const m = buildTopologyModel(makeFixture())
    // core switch counts toward rack, layer:core and location
    expect(m.clusters.get('loc:7|layer:core|rack:R1')!.memberDeviceKeys).toContain('d-1')
    expect(m.clusters.get('loc:7|layer:core')!.memberDeviceKeys).toContain('d-1')
    expect(m.clusters.get('loc:7')!.memberDeviceKeys).toContain('d-1')
    // location holds every device + the ghost
    expect(m.clusters.get('loc:7')!.memberDeviceKeys.sort())
      .toEqual(['d-1', 'd-2', 'd-3', 'ghost-edge-ap'])
  })

  it('clusterPath walks shallowest-first', () => {
    const m = buildTopologyModel(makeFixture())
    expect(clusterPath('loc:7|layer:core|rack:R1', m.clusters))
      .toEqual(['loc:7', 'loc:7|layer:core', 'loc:7|layer:core|rack:R1'])
  })

  it('seeds every node with a finite position for the layout worker', () => {
    const m = buildTopologyModel(makeFixture())
    m.graph.forEachNode((_k, attr) => {
      expect(Number.isFinite(attr.x)).toBe(true)
      expect(Number.isFinite(attr.y)).toBe(true)
    })
  })
})
