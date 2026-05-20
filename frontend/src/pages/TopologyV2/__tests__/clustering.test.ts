import { describe, it, expect } from 'vitest'
import { buildTopologyModel } from '../graphModel'
import {
  collapsedSetForTier, expandCluster, applyClusterView,
} from '../clustering'
import { makeFixture } from './fixture'

describe('collapsedSetForTier', () => {
  it('device tier collapses nothing', () => {
    const m = buildTopologyModel(makeFixture())
    expect(collapsedSetForTier(m, 'device').size).toBe(0)
  })

  it('layer tier collapses every layer cluster', () => {
    const m = buildTopologyModel(makeFixture())
    const set = collapsedSetForTier(m, 'layer')
    expect(set).toEqual(new Set(['loc:7|layer:core', 'loc:7|layer:access']))
  })

  it('location tier collapses the location cluster', () => {
    const m = buildTopologyModel(makeFixture())
    expect(collapsedSetForTier(m, 'location')).toEqual(new Set(['loc:7']))
  })
})

describe('applyClusterView', () => {
  it('device tier shows every device and no cluster node', () => {
    const m = buildTopologyModel(makeFixture())
    const res = applyClusterView(m, collapsedSetForTier(m, 'device'))
    expect(res.visibleNodes).toBe(4) // 3 devices + 1 ghost
    expect(res.visibleEdges).toBe(3)
    expect(res.metaEdges).toBe(0)
    expect(m.graph.getNodeAttribute('loc:7', 'hidden')).toBe(true)
    expect(m.graph.getNodeAttribute('d-1', 'hidden')).toBe(false)
  })

  it('layer tier hides devices, shows layer clusters, routes meta-edges', () => {
    const m = buildTopologyModel(makeFixture())
    const res = applyClusterView(m, collapsedSetForTier(m, 'layer'))
    // two layer clusters visible, devices hidden
    expect(res.visibleNodes).toBe(2)
    expect(m.graph.getNodeAttribute('loc:7|layer:core', 'hidden')).toBe(false)
    expect(m.graph.getNodeAttribute('d-1', 'hidden')).toBe(true)
    // the core↔access links collapse into one core-layer↔access-layer meta-edge
    expect(res.metaEdges).toBe(1)
    expect(m.graph.hasEdge('meta-loc:7|layer:access|loc:7|layer:core')).toBe(true)
  })

  it('location tier collapses everything into the single location node', () => {
    const m = buildTopologyModel(makeFixture())
    const res = applyClusterView(m, collapsedSetForTier(m, 'location'))
    expect(res.visibleNodes).toBe(1)
    // all links are intra-location ⇒ no meta-edges
    expect(res.metaEdges).toBe(0)
  })
})

describe('expandCluster', () => {
  it('drills one tier in — replaces a parent with its children', () => {
    const m = buildTopologyModel(makeFixture())
    const atLocation = collapsedSetForTier(m, 'location')
    const next = expandCluster(m, atLocation, 'loc:7')
    expect(next.has('loc:7')).toBe(false)
    expect(next.has('loc:7|layer:core')).toBe(true)
    expect(next.has('loc:7|layer:access')).toBe(true)
  })
})
