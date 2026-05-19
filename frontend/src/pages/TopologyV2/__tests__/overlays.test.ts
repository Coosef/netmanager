import { describe, it, expect } from 'vitest'
import { buildTopologyModel } from '../graphModel'
import { collapsedSetForTier } from '../clustering'
import { applyTopologyEvent, type TopologyEvent } from '../patch'
import { deriveOverlayModel, OVERLAY_LAYERS, type OverlayLayer } from '../overlays/overlayModel'
import { computeFocusSet } from '../overlays/focus'
import { resolveNodeOverlay, resolveEdgeOverlay } from '../overlays/overlayStyle'
import { computeLayout } from '../three/layout3d'
import { buildSceneData } from '../three/sceneData'
import { makeFixture } from './fixture'

const ALL = new Set<OverlayLayer>(OVERLAY_LAYERS)

// ── overlay state derivation ────────────────────────────────────────────────
describe('deriveOverlayModel', () => {
  it('classifies anomalous edges and warms the nodes they touch', () => {
    const om = deriveOverlayModel(buildTopologyModel(makeFixture()))
    // e-1-3 is a saturated + asymmetric uplink
    expect(om.edges.get('e-1-3')!.asymmetric).toBe(true)
    expect(om.edges.get('e-1-3')!.bottleneck).toBe(true)
    expect(om.edges.get('e-1-3')!.suspicious).toBe(true)
    // its endpoints d-1 / d-3 become heat (1 anomaly edge each, no threat)
    expect(om.nodes.get('d-1')!.heat).toBe(true)
    expect(om.nodes.get('d-3')!.heat).toBe(true)
    expect(om.counts.asymmetricLinks).toBe(1)
    expect(om.counts.ghosts).toBe(1)
  })

  it('promotes a critical down device to a threat', () => {
    const model = buildTopologyModel(makeFixture())
    model.graph.setNodeAttribute('d-1', 'status', 'offline') // d-1 is criticality=critical
    const om = deriveOverlayModel(model)
    expect(om.nodes.get('d-1')!.threat).toBe(true)
    expect(om.counts.threats).toBe(1)
  })

  it('emits tactical hints for the detected categories', () => {
    const om = deriveOverlayModel(buildTopologyModel(makeFixture()))
    const ids = om.hints.map((h) => h.id)
    expect(ids).toContain('asymmetric')
    expect(ids).toContain('suspicious')
    expect(ids).toContain('ghosts')
  })

  it('is a pure projection — two models yield independent overlays (RLS scope)', () => {
    const a = deriveOverlayModel(buildTopologyModel(makeFixture()))
    const small = makeFixture()
    small.nodes = small.nodes.slice(0, 1)
    small.edges = []
    const b = deriveOverlayModel(buildTopologyModel(small))
    expect(a.nodes.size).toBeGreaterThan(b.nodes.size)
    // overlay never references a node outside its own (scoped) model
    for (const id of b.nodes.keys()) expect(id).toBe('d-1')
  })
})

// ── anomaly path / incident focus selection ─────────────────────────────────
describe('computeFocusSet', () => {
  it('collects the blast radius within N hops', () => {
    const model = buildTopologyModel(makeFixture())
    const f1 = computeFocusSet(model, 'd-1', 1)!
    expect(f1.nodes).toEqual(new Set(['d-1', 'd-2', 'd-3']))
    expect(f1.edges).toEqual(new Set(['e-1-2', 'e-1-3']))
    expect(f1.depth.get('d-1')).toBe(0)
    expect(f1.depth.get('d-2')).toBe(1)
  })

  it('reaches further-hop dependencies at greater depth', () => {
    const model = buildTopologyModel(makeFixture())
    const f2 = computeFocusSet(model, 'd-1', 2)!
    expect(f2.nodes.has('ghost-edge-ap')).toBe(true) // d-1 → d-2 → ghost
  })

  it('returns null for a cluster or unknown node', () => {
    const model = buildTopologyModel(makeFixture())
    expect(computeFocusSet(model, 'loc:7')).toBeNull()
    expect(computeFocusSet(model, 'd-999')).toBeNull()
  })
})

// ── drift rendering state ───────────────────────────────────────────────────
describe('drift state', () => {
  it('a topology_drift event is surfaced as drift, not a graph mutation', () => {
    const model = buildTopologyModel(makeFixture())
    const event: TopologyEvent = {
      event_type: 'topology_drift', graph_version: 8,
      message: '2 yeni bağlantı, 1 kayıp',
    }
    const out = applyTopologyEvent(model, event, 7)
    expect(out.status).toBe('drift')
    expect(out.version).toBe(8) // drift advances the version
  })
})

// ── 2D / 3D overlay model compatibility ─────────────────────────────────────
describe('overlay model compatibility (2D + 3D)', () => {
  it('resolveNodeOverlay — focus dims nodes outside the blast radius', () => {
    const model = buildTopologyModel(makeFixture())
    const om = deriveOverlayModel(model)
    const focus = computeFocusSet(model, 'd-1', 1)!
    // ghost-edge-ap is outside d-1's 1-hop radius → dimmed
    expect(resolveNodeOverlay('ghost-edge-ap', om, ALL, focus).tone).toBe('dim')
    expect(resolveNodeOverlay('d-2', om, ALL, focus).tone).not.toBe('dim')
  })

  it('resolveEdgeOverlay — a suspicious edge wins the tone', () => {
    const model = buildTopologyModel(makeFixture())
    const om = deriveOverlayModel(model)
    expect(resolveEdgeOverlay('e-1-3', om, ALL, null).tone).toBe('suspicious')
  })

  it('a disabled layer suppresses its tone', () => {
    const model = buildTopologyModel(makeFixture())
    const om = deriveOverlayModel(model)
    const noStale = new Set(OVERLAY_LAYERS.filter((l) => l !== 'suspicious' && l !== 'bottlenecks' && l !== 'asymmetric'))
    expect(resolveEdgeOverlay('e-1-3', om, noStale, null).tone).toBe('normal')
  })

  it('the 3D engine buckets a threat node into the threat class', () => {
    const model = buildTopologyModel(makeFixture())
    model.graph.setNodeAttribute('d-1', 'status', 'offline') // → threat
    const om = deriveOverlayModel(model)
    const layout = computeLayout(model, 'orbit')
    const data = buildSceneData(model, collapsedSetForTier(model, 'device'), layout, {
      model: om, layers: ALL, focus: null,
    })
    expect(data.nodes.threat.some((r) => r.id === 'd-1')).toBe(true)
    expect(data.nodes.core.some((r) => r.id === 'd-1')).toBe(false)
  })
})
