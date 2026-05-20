/**
 * Level-of-detail — distance-based simplification for the 3D engine.
 *
 * Drives: which labels survive at a given camera distance, an
 * atmospheric-perspective fade for far geometry, and the camera-distance
 * threshold at which device detail gives way to cluster substitution.
 * Pure maths — unit testable.
 */

export type LodLevel = 'near' | 'mid' | 'far'

const NEAR_MAX = 360
const MID_MAX = 900

/** Discrete LOD bucket for a camera→node distance. */
export function lodForDistance(distance: number): LodLevel {
  if (distance <= NEAR_MAX) return 'near'
  if (distance <= MID_MAX) return 'mid'
  return 'far'
}

/**
 * Priority/zoom-aware label gate. label_priority 1 (core/distribution)
 * survives furthest; 3 (edge/wireless/ghost) only up close.
 */
export function labelVisibleAt(labelPriority: number, distance: number): boolean {
  const lod = lodForDistance(distance)
  if (lod === 'near') return labelPriority <= 3
  if (lod === 'mid') return labelPriority <= 2
  return labelPriority <= 1
}

const FADE_START = 750
const FADE_END = 1700

/**
 * Atmospheric-perspective opacity 0..1 — geometry recedes into haze with
 * distance rather than vanishing abruptly.
 */
export function atmosphericFade(distance: number): number {
  if (distance <= FADE_START) return 1
  if (distance >= FADE_END) return 0.12
  const t = (distance - FADE_START) / (FADE_END - FADE_START)
  return 1 - t * 0.88
}

/** Beyond this camera distance the view favours cluster substitution. */
export const CLUSTER_SUBSTITUTION_DISTANCE = 1150

/** Per-LOD instance-scale multiplier — far nodes shrink slightly so dense
 *  fields stay readable instead of merging into a wall. */
export function lodScale(level: LodLevel): number {
  return level === 'near' ? 1 : level === 'mid' ? 0.88 : 0.72
}
