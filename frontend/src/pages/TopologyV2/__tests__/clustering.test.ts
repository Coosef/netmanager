import { describe, it, expect } from 'vitest'
import { buildTopologyModel, type TopologyModel } from '../graphModel'
import {
  collapsedSetForTier, expandCluster,
  applyClusterView, applyClusterViewDelta, countClusterView,
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

// ── T8.3.E2.a — delta path ───────────────────────────────────────────────

/**
 * Snapshot the graph state that defines "the cluster view": every
 * node's `hidden` flag + the set of meta-edges and their aggregated
 * counts. Two equal snapshots mean two graphs are visually identical
 * from the topology-view perspective.
 */
function viewSnapshot(model: TopologyModel) {
  const hidden = new Map<string, boolean>()
  model.graph.forEachNode((key, attr) => {
    hidden.set(key, !!attr.hidden)
  })
  const metaEdges = new Map<string, { count: number; utilization: number }>()
  const linkHidden = new Map<string, boolean>()
  model.graph.forEachEdge((key, attr) => {
    if (attr.edgeKind === 'meta') {
      metaEdges.set(key, {
        count: attr.count as number,
        utilization: attr.utilization as number,
      })
    } else if (attr.edgeKind === 'link') {
      linkHidden.set(key, !!attr.hidden)
    }
  })
  return { hidden, metaEdges, linkHidden }
}

describe('applyClusterViewDelta', () => {
  it('returns zero counts on an empty diff (prev === next contents)', () => {
    const m = buildTopologyModel(makeFixture())
    applyClusterView(m, collapsedSetForTier(m, 'layer'))
    const A = collapsedSetForTier(m, 'layer')
    const B = new Set(A) // same contents, different identity
    const res = applyClusterViewDelta(m, A, B)
    expect(res).toEqual({ visibleNodes: 0, visibleEdges: 0, metaEdges: 0 })
    // counted via the explicit counter
    expect(countClusterView(m).visibleNodes).toBe(2)
  })

  it('expand: location → layer matches a full apply', () => {
    // delta path: start at location tier, expand `loc:7` to the layer tier
    const mDelta = buildTopologyModel(makeFixture())
    const atLocation = collapsedSetForTier(mDelta, 'location')
    applyClusterView(mDelta, atLocation)
    const atLayer = expandCluster(mDelta, atLocation, 'loc:7')
    applyClusterViewDelta(mDelta, atLocation, atLayer)

    // reference: a fresh model with the layer set applied directly
    const mFull = buildTopologyModel(makeFixture())
    applyClusterView(mFull, collapsedSetForTier(mFull, 'layer'))

    expect(viewSnapshot(mDelta)).toEqual(viewSnapshot(mFull))
    // and the counts agree too
    expect(countClusterView(mDelta)).toEqual(countClusterView(mFull))
  })

  it('expand: layer → rack/access mix (two sequential expands) matches a full apply', () => {
    // `expandCluster` drills ONE tier per call. From {core, access}:
    // expanding `core` → {rack:R1, access} (core's child is rack:R1);
    // expanding `access` next → {rack:R1} (access has no children).
    const mDelta = buildTopologyModel(makeFixture())
    const atLayer = collapsedSetForTier(mDelta, 'layer')
    applyClusterView(mDelta, atLayer)
    let next = expandCluster(mDelta, atLayer, 'loc:7|layer:core')
    applyClusterViewDelta(mDelta, atLayer, next)
    const afterCore = new Set(next)
    next = expandCluster(mDelta, afterCore, 'loc:7|layer:access')
    applyClusterViewDelta(mDelta, afterCore, next)

    // reference: a fresh apply at the same end state
    const mFull = buildTopologyModel(makeFixture())
    applyClusterView(mFull, next)

    expect(viewSnapshot(mDelta)).toEqual(viewSnapshot(mFull))
    expect(countClusterView(mDelta)).toEqual(countClusterView(mFull))
  })

  it('fully drilling to device tier (rack → device) matches a full apply', () => {
    // continues the previous chain one more expand
    const mDelta = buildTopologyModel(makeFixture())
    const atLayer = collapsedSetForTier(mDelta, 'layer')
    applyClusterView(mDelta, atLayer)
    let next = expandCluster(mDelta, atLayer, 'loc:7|layer:core')
    applyClusterViewDelta(mDelta, atLayer, next)
    let prev = new Set(next)
    next = expandCluster(mDelta, prev, 'loc:7|layer:access')
    applyClusterViewDelta(mDelta, prev, next)
    prev = new Set(next)
    // expand the rack — its only child is none (rack has no sub-clusters)
    next = expandCluster(mDelta, prev, 'loc:7|layer:core|rack:R1')
    applyClusterViewDelta(mDelta, prev, next)
    expect(next.size).toBe(0) // arrived at device tier

    const mFull = buildTopologyModel(makeFixture())
    applyClusterView(mFull, collapsedSetForTier(mFull, 'device'))

    expect(viewSnapshot(mDelta)).toEqual(viewSnapshot(mFull))
    expect(countClusterView(mDelta)).toEqual(countClusterView(mFull))
  })

  it('collapse: device → layer (re-collapse) matches a full apply', () => {
    const mDelta = buildTopologyModel(makeFixture())
    applyClusterView(mDelta, collapsedSetForTier(mDelta, 'device'))
    // collapse to the layer set
    const target = collapsedSetForTier(mDelta, 'layer')
    applyClusterViewDelta(mDelta, new Set<string>(), target)

    const mFull = buildTopologyModel(makeFixture())
    applyClusterView(mFull, target)

    expect(viewSnapshot(mDelta)).toEqual(viewSnapshot(mFull))
  })

  it('expand then collapse round-trip returns to the starting view', () => {
    const m = buildTopologyModel(makeFixture())
    const atLayer = collapsedSetForTier(m, 'layer')
    applyClusterView(m, atLayer)
    const start = viewSnapshot(m)

    // expand `loc:7|layer:access` to device tier (no children → just drops it)
    const next = expandCluster(m, atLayer, 'loc:7|layer:access')
    applyClusterViewDelta(m, atLayer, next)
    // collapse back
    applyClusterViewDelta(m, next, atLayer)

    expect(viewSnapshot(m)).toEqual(start)
  })

  it('replays a chain of deltas to the same end state as a single direct delta', () => {
    // A → B → C via the delta chain
    const mChain = buildTopologyModel(makeFixture())
    const atLocation = collapsedSetForTier(mChain, 'location')
    applyClusterView(mChain, atLocation)
    const atLayer = expandCluster(mChain, atLocation, 'loc:7')
    applyClusterViewDelta(mChain, atLocation, atLayer)
    const atDevice = new Set<string>()
    applyClusterViewDelta(mChain, atLayer, atDevice)

    // A → C directly via the delta path
    const mDirect = buildTopologyModel(makeFixture())
    applyClusterView(mDirect, atLocation)
    applyClusterViewDelta(mDirect, atLocation, atDevice)

    expect(viewSnapshot(mChain)).toEqual(viewSnapshot(mDirect))
  })

  it('re-applying the same delta is idempotent (no duplicate meta-edges)', () => {
    const m = buildTopologyModel(makeFixture())
    const atDevice = new Set<string>()
    applyClusterView(m, atDevice)
    const atLayer = collapsedSetForTier(m, 'layer')

    applyClusterViewDelta(m, atDevice, atLayer)
    const afterOnce = viewSnapshot(m)
    // applying the SAME delta again is a no-op because prev/next match
    // the diff this time is empty
    applyClusterViewDelta(m, atLayer, atLayer)
    expect(viewSnapshot(m)).toEqual(afterOnce)
  })

  it('preserves the meta-edge styling (size formula, color)', () => {
    const m = buildTopologyModel(makeFixture())
    applyClusterView(m, collapsedSetForTier(m, 'device'))
    applyClusterViewDelta(m, new Set<string>(), collapsedSetForTier(m, 'layer'))

    const mFull = buildTopologyModel(makeFixture())
    applyClusterView(mFull, collapsedSetForTier(mFull, 'layer'))

    const dAttrs = m.graph.getEdgeAttributes('meta-loc:7|layer:access|loc:7|layer:core')
    const fAttrs = mFull.graph.getEdgeAttributes('meta-loc:7|layer:access|loc:7|layer:core')
    expect(dAttrs.color).toBe(fAttrs.color)
    expect(dAttrs.size).toBe(fAttrs.size)
    expect(dAttrs.count).toBe(fAttrs.count)
    expect(dAttrs.utilization).toBe(fAttrs.utilization)
    expect(dAttrs.hidden).toBe(fAttrs.hidden)
  })
})
