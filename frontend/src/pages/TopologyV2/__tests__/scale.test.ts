/**
 * Scale benchmark + hardening gate (T7).
 *
 * Doubles as the benchmark harness — run `npx vitest run scale` to print
 * the timing table. Measures the main-thread pipeline costs (graph
 * build, 3D layout, scene build, overlay derivation, patch) at 1k / 2.5k
 * / 5k, with a 10k stress run. The FA2 force layout itself runs in a Web
 * Worker and is not measured here (it never blocks the main thread).
 *
 * Assertions are generous regression guards, not micro-benchmarks.
 */
import { describe, it, expect } from 'vitest'
import { generateSyntheticContract } from './syntheticGraph'
import { validateTopologyGraphV2 } from '../contract'
import { buildTopologyModel } from '../graphModel'
import { diffAndPatch, applyTopologyEvent, ingestStrategy } from '../patch'
import { collapsedSetForTier, applyClusterView } from '../clustering'
import { computeFocusSet } from '../overlays/focus'
import { deriveOverlayModel } from '../overlays/overlayModel'
import { computeLayout } from '../three/layout3d'
import { buildSceneData } from '../three/sceneData'
import { scaleProfile } from '../scaleConfig'

function time<T>(fn: () => T): { ms: number; result: T } {
  const t0 = performance.now()
  const result = fn()
  return { ms: performance.now() - t0, result }
}

const SIZES = [1000, 2500, 5000] as const
// Generous main-thread ceilings (ms) — catch a real regression, tolerate CI.
const CEILING = 1500

describe('synthetic graph generation', () => {
  for (const size of SIZES) {
    it(`generates a valid ${size}-node v2 contract`, () => {
      const contract = generateSyntheticContract(size)
      expect(() => validateTopologyGraphV2(contract)).not.toThrow()
      expect(contract.stats.device_nodes).toBeGreaterThan(size * 0.6)
      expect(contract.edges.length).toBeGreaterThan(size * 0.5)
      expect(contract.clusters.length).toBeGreaterThan(0)
    })
  }
})

describe('scale benchmark — main-thread pipeline', () => {
  for (const size of SIZES) {
    it(`${size} nodes — every stage stays under the ceiling`, () => {
      const contract = generateSyntheticContract(size)

      const build = time(() => buildTopologyModel(contract))
      const model = build.result
      const orbit = time(() => computeLayout(model, 'orbit'))
      const cluster = time(() => computeLayout(model, 'cluster'))
      const layerSet = collapsedSetForTier(model, 'layer')
      const view = time(() => applyClusterView(model, layerSet))
      const overlay = time(() => deriveOverlayModel(model))
      const scene = time(() => buildSceneData(model, layerSet, orbit.result))
      const patch = time(() => diffAndPatch(model, contract))

      // eslint-disable-next-line no-console
      console.log(
        `[scale ${size}] build=${build.ms.toFixed(1)} ` +
        `layout(orbit)=${orbit.ms.toFixed(1)} layout(cluster)=${cluster.ms.toFixed(1)} ` +
        `clusterView=${view.ms.toFixed(1)} overlay=${overlay.ms.toFixed(1)} ` +
        `scene=${scene.ms.toFixed(1)} patch=${patch.ms.toFixed(1)} ` +
        `| ${model.deviceCount} dev, ${model.graph.size} edges`,
      )

      for (const stage of [build, orbit, cluster, view, overlay, scene, patch]) {
        expect(stage.ms).toBeLessThan(CEILING)
      }
      // patch must stay incremental — same graphology instance, no rebuild
      const ref = model.graph
      diffAndPatch(model, contract)
      expect(model.graph).toBe(ref)
    })
  }

  it('10k stress run — degrades gracefully, still completes', () => {
    const contract = generateSyntheticContract(10000)
    const build = time(() => buildTopologyModel(contract))
    const model = build.result
    const scene = time(() =>
      buildSceneData(model, collapsedSetForTier(model, 'layer'), computeLayout(model, 'orbit')))
    // eslint-disable-next-line no-console
    console.log(`[scale 10000] build=${build.ms.toFixed(1)} scene=${scene.ms.toFixed(1)}`)
    expect(build.ms).toBeLessThan(CEILING * 3) // stress — looser budget
    expect(model.deviceCount).toBeGreaterThan(6000)
  })
})

describe('scaleProfile — size-adaptive defaults', () => {
  it('small graphs open fully exploded at the device tier', () => {
    expect(scaleProfile(300).defaultTier).toBe('device')
  })
  it('large graphs open clustered at the layer tier', () => {
    expect(scaleProfile(1000).defaultTier).toBe('layer')
    expect(scaleProfile(5000).defaultTier).toBe('layer')
  })
  it('label budget tightens as the graph grows', () => {
    expect(scaleProfile(5000).labelThreshold).toBeGreaterThan(scaleProfile(300).labelThreshold)
  })
  it('the traffic pulse cap drops at 5k scale', () => {
    expect(scaleProfile(5000).trafficAnimationMaxHot)
      .toBeLessThan(scaleProfile(300).trafficAnimationMaxHot)
  })
})

describe('scale stability — behaviours hold at 5k', () => {
  it('a location switch still triggers a clean rebuild', () => {
    const contract = generateSyntheticContract(5000)
    expect(ingestStrategy({ locationId: 7, graphVersion: 1 }, contract, 9)).toBe('rebuild')
  })

  it('a graph_version gap still forces a controlled refetch', () => {
    const model = buildTopologyModel(generateSyntheticContract(5000))
    const out = applyTopologyEvent(
      model,
      { event_type: 'topology_node_updated', graph_version: 999, node_id: 'd-1', changes: {} },
      1,
    )
    expect(out.status).toBe('refetch')
  })

  it('cluster collapse/expand and focus stay fast at 5k', () => {
    const model = buildTopologyModel(generateSyntheticContract(5000))
    const collapse = time(() => applyClusterView(model, collapsedSetForTier(model, 'location')))
    const expand = time(() => applyClusterView(model, collapsedSetForTier(model, 'device')))
    const focus = time(() => computeFocusSet(model, 'd-1', 3))
    expect(collapse.ms).toBeLessThan(CEILING)
    expect(expand.ms).toBeLessThan(CEILING)
    expect(focus.ms).toBeLessThan(CEILING)
  })
})
