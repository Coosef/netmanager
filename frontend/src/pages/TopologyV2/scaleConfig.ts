/**
 * Scale tuning — T7.
 *
 * Size-adaptive defaults + a documented register of every tuning
 * threshold in the topology engine. Calibrated against the synthetic
 * 1k / 2.5k / 5k fixtures (see __tests__/scale.test.ts and the
 * "T7 — Scale" section of docs/TOPOLOGY_FINAL_GOLD_RELEASE_PLAN.md).
 *
 * Production-safe: pure constants, no data — nothing tenant-scoped.
 */
import type { ClusterTier } from './clustering'

export interface ScaleProfile {
  /** Cluster tier the engine opens at — a large graph must never start
   *  fully exploded. */
  defaultTier: ClusterTier
  /** Sigma `labelRenderedSizeThreshold` — higher ⇒ fewer labels drawn,
   *  keeping a dense viewport readable. */
  labelThreshold: number
  /** The traffic pulse is disabled once the hot-edge set exceeds this —
   *  animation stays cheap on loaded fabrics. */
  trafficAnimationMaxHot: number
}

/**
 * Resolve the scale profile for a device count.
 *
 *   < 800    smooth — open at device tier, every node visible
 *   800–2k   open clustered at the layer tier
 *   2k–4k    operationally usable — fewer labels
 *   ≥ 4k     5k production gate — clustered, sparse labels, capped pulse
 */
export function scaleProfile(deviceCount: number): ScaleProfile {
  if (deviceCount >= 4000) {
    return { defaultTier: 'layer', labelThreshold: 12, trafficAnimationMaxHot: 400 }
  }
  if (deviceCount >= 2000) {
    return { defaultTier: 'layer', labelThreshold: 9, trafficAnimationMaxHot: 500 }
  }
  if (deviceCount >= 800) {
    return { defaultTier: 'layer', labelThreshold: 7, trafficAnimationMaxHot: 600 }
  }
  return { defaultTier: 'device', labelThreshold: 6, trafficAnimationMaxHot: 600 }
}

/**
 * Documented threshold register — the source of truth lives in each
 * module; this is the central index for tuning review.
 *
 * Semantic zoom (rendering.ts · cameraRatioToZoomTier)
 *   ratio > 1.6 → tier 0 (far) · > 0.7 → tier 1 (mid) · else tier 2 (near)
 * Label priority (rendering.ts · shouldShowLabel)
 *   tier 0 → priority ≤ 1 · tier 1 → ≤ 2 · tier 2 → ≤ 3, gated by min_zoom_level
 * 3D LOD (three/lod.ts)
 *   near ≤ 360 · mid ≤ 900 · far beyond · atmospheric fade 750→1700
 *   cluster substitution favoured beyond 1150
 * 3D instancing (three/NodesLayer.tsx)
 *   one InstancedMesh per node class — 7 device buckets + 1 cluster bucket
 * Worker layout (three/layout3d.ts deterministic · layout.ts FA2 worker)
 *   FA2 barnesHutOptimize engages above 800 nodes; layout runs off-thread
 */
export const TUNING_NOTES = 'see scaleConfig.ts header + topology plan T7 section'
