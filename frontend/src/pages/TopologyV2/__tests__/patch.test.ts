import { describe, it, expect } from 'vitest'
import { buildTopologyModel } from '../graphModel'
import {
  reconcileVersion, ingestStrategy, diffAndPatch, applyTopologyEvent,
  type TopologyEvent,
} from '../patch'
import { makeFixture } from './fixture'
import type { TopologyGraphV2, TopologyNode } from '../contract'

const clone = (g: TopologyGraphV2): TopologyGraphV2 => structuredClone(g)

// ── graph_version reconciliation ──────────────────────────────────────────
describe('reconcileVersion', () => {
  it('flags an older-or-equal version as stale', () => {
    expect(reconcileVersion(7, 7)).toBe('stale')
    expect(reconcileVersion(5, 7)).toBe('stale')
  })
  it('flags the next consecutive version as in-sequence', () => {
    expect(reconcileVersion(8, 7)).toBe('next')
  })
  it('flags a skipped version as a gap', () => {
    expect(reconcileVersion(12, 7)).toBe('gap')
  })
})

// ── ingest strategy (location switch) ─────────────────────────────────────
describe('ingestStrategy', () => {
  it('rebuilds on first load', () => {
    expect(ingestStrategy(null, makeFixture(), 7)).toBe('rebuild')
  })
  it('rebuilds when the active location changed', () => {
    expect(ingestStrategy({ locationId: 7, graphVersion: 7 }, makeFixture(), 9))
      .toBe('rebuild')
  })
  it('skips an identical-version poll', () => {
    expect(ingestStrategy({ locationId: 7, graphVersion: 7 }, makeFixture(), 7))
      .toBe('skip')
  })
  it('patches a newer contract for the same location', () => {
    const c = clone(makeFixture()); c.graph_version = 8
    expect(ingestStrategy({ locationId: 7, graphVersion: 7 }, c, 7)).toBe('patch')
  })
})

// ── full-contract diff ────────────────────────────────────────────────────
describe('diffAndPatch', () => {
  it('adds, removes and updates without recreating the graph', () => {
    const model = buildTopologyModel(makeFixture())
    const graphRef = model.graph
    model.graph.setNodeAttribute('d-1', 'x', 123.456) // sentinel position

    const next = clone(makeFixture())
    next.graph_version = 8
    next.nodes = next.nodes.filter((n) => n.id !== 'd-3')   // remove d-3
    next.edges = next.edges.filter((e) => e.id !== 'e-1-3') // its edge
    next.nodes[1].data.status = 'offline'                   // d-2 went down
    next.nodes.push({
      id: 'd-9', kind: 'device',
      data: {
        device_id: 9, label: 'acc-sw9', layer: 'access', status: 'online',
        criticality: 'normal', cluster_id: 'loc:7|layer:access',
        importance_score: 0.4, label_priority: 2, render_class: 'access',
        min_zoom_level: 1, lod_tier: 'secondary', organization_id: 1, location_id: 7,
      },
    } as TopologyNode)

    const summary = diffAndPatch(model, next)

    expect(model.graph).toBe(graphRef)               // same instance — no remount
    expect(model.graphVersion).toBe(8)
    expect(model.graph.hasNode('d-9')).toBe(true)
    expect(model.graph.hasNode('d-3')).toBe(false)
    expect(model.graph.hasEdge('e-1-3')).toBe(false)
    expect(model.graph.getNodeAttribute('d-2', 'status')).toBe('offline')
    expect(model.graph.getNodeAttribute('d-1', 'x')).toBe(123.456) // position kept
    expect(summary.nodesAdded).toBeGreaterThanOrEqual(1)
    expect(summary.nodesRemoved).toBeGreaterThanOrEqual(1)
  })
})

// ── single realtime event ─────────────────────────────────────────────────
describe('applyTopologyEvent', () => {
  const ev = (e: Partial<TopologyEvent>): TopologyEvent =>
    ({ event_type: 'topology_node_updated', graph_version: 8, ...e } as TopologyEvent)

  it('drops a stale event and leaves the graph untouched', () => {
    const model = buildTopologyModel(makeFixture())
    const before = model.graph.getNodeAttribute('d-3', 'status')
    const out = applyTopologyEvent(model, ev({ graph_version: 7 }), 7)
    expect(out.status).toBe('stale')
    expect(model.graph.getNodeAttribute('d-3', 'status')).toBe(before)
  })

  it('treats a version gap as a controlled refetch', () => {
    const model = buildTopologyModel(makeFixture())
    const out = applyTopologyEvent(model, ev({ graph_version: 20 }), 7)
    expect(out.status).toBe('refetch')
    expect(out.version).toBe(7) // unchanged until the refetch reconciles
  })

  it('routes a bulk topology_links_updated event to a refetch', () => {
    const model = buildTopologyModel(makeFixture())
    const out = applyTopologyEvent(
      model, ev({ event_type: 'topology_links_updated', graph_version: 8 }), 7)
    expect(out.status).toBe('refetch')
  })

  it('surfaces a drift event as drift state and advances the version', () => {
    const model = buildTopologyModel(makeFixture())
    const out = applyTopologyEvent(
      model, ev({ event_type: 'topology_drift', graph_version: 8 }), 7)
    expect(out.status).toBe('drift')
    expect(out.version).toBe(8)
  })

  it('applies an in-sequence node_updated patch', () => {
    const model = buildTopologyModel(makeFixture())
    const out = applyTopologyEvent(
      model, ev({ node_id: 'd-3', changes: { status: 'online' } }), 7)
    expect(out.status).toBe('applied')
    expect(out.version).toBe(8)
    expect(model.graph.getNodeAttribute('d-3', 'status')).toBe('online')
  })

  it('applies a node_removed event', () => {
    const model = buildTopologyModel(makeFixture())
    const out = applyTopologyEvent(
      model, ev({ event_type: 'topology_node_removed', node_id: 'd-3' }), 7)
    expect(out.status).toBe('applied')
    expect(model.graph.hasNode('d-3')).toBe(false)
  })

  it('applies an edge_updated event', () => {
    const model = buildTopologyModel(makeFixture())
    const out = applyTopologyEvent(
      model, ev({ event_type: 'topology_edge_updated', edge_id: 'e-1-2',
        changes: { trafficClass: 'high' } }), 7)
    expect(out.status).toBe('applied')
    expect(model.graph.getEdgeAttribute('e-1-2', 'trafficClass')).toBe('high')
  })

  it('applies a node_added event carrying full node data', () => {
    const model = buildTopologyModel(makeFixture())
    const node: TopologyNode = {
      id: 'd-50', kind: 'device',
      data: {
        device_id: 50, label: 'new-sw', layer: 'access', status: 'online',
        criticality: 'normal', cluster_id: 'loc:7|layer:access',
        importance_score: 0.4, label_priority: 2, render_class: 'access',
        min_zoom_level: 1, lod_tier: 'secondary', organization_id: 1, location_id: 7,
      },
    }
    const out = applyTopologyEvent(
      model, ev({ event_type: 'topology_node_added', node }), 7)
    expect(out.status).toBe('applied')
    expect(model.graph.hasNode('d-50')).toBe(true)
  })

  it('refetches a node_added event that lacks node data', () => {
    const model = buildTopologyModel(makeFixture())
    const out = applyTopologyEvent(
      model, ev({ event_type: 'topology_node_added' }), 7)
    expect(out.status).toBe('refetch')
  })
})
