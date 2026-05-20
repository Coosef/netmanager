/**
 * Overlay style resolution — the renderer-agnostic bridge.
 *
 * `resolveNodeOverlay` / `resolveEdgeOverlay` collapse the overlay model
 * + enabled layers + incident focus into a single tone + emphasis. Both
 * the 2D Sigma engine and the 3D r3f engine consume these identical
 * results, so an overlay looks and behaves the same in either mode.
 *
 * Tones are restrained — dim desaturates, heat/threat use a quiet amber→
 * red ramp, focus a calm cyan. No neon, no cyberpunk.
 */
import type { OverlayModel, OverlayLayer } from './overlayModel'
import type { FocusSet } from './focus'

export type NodeTone = 'normal' | 'dim' | 'heat' | 'threat' | 'ghost' | 'focus'
export type EdgeTone =
  | 'normal' | 'dim' | 'stale' | 'asymmetric' | 'bottleneck' | 'suspicious' | 'focus'

export interface OverlayResult<T> {
  tone: T
  /** 0..1 — drives size / intensity boost. */
  emphasis: number
}

/** The overlay state both renderers consume — passed through unchanged. */
export interface OverlayContext {
  model: OverlayModel
  layers: Set<OverlayLayer>
  focus: FocusSet | null
}

/** Tone → colour. '' keeps the node/edge base colour (no override). */
export const NODE_TONE_COLOR: Record<NodeTone, string> = {
  normal: '',
  dim: '#2a3346',
  heat: '#f59e0b',
  threat: '#ef4444',
  ghost: '#52617a',
  focus: '#38bdf8',
}

export const EDGE_TONE_COLOR: Record<EdgeTone, string> = {
  normal: '',
  dim: '#1b2334',
  stale: '#f59e0b',
  asymmetric: '#f97316',
  bottleneck: '#ef4444',
  suspicious: '#dc2626',
  focus: '#38bdf8',
}

/**
 * Resolve a node's overlay treatment. Incident focus wins: nodes outside
 * the blast radius dim; nodes inside keep their threat tone or take a
 * depth-faded focus tone.
 */
export function resolveNodeOverlay(
  id: string,
  overlay: OverlayModel,
  layers: Set<OverlayLayer>,
  focus: FocusSet | null,
): OverlayResult<NodeTone> {
  const flags = overlay.nodes.get(id)
  if (focus) {
    if (!focus.nodes.has(id)) return { tone: 'dim', emphasis: 0 }
    if (flags?.threat && layers.has('threats')) return { tone: 'threat', emphasis: 1 }
    const d = focus.depth.get(id) ?? focus.maxDepth
    return { tone: 'focus', emphasis: 1 - d / (focus.maxDepth + 1) }
  }
  if (!flags) return { tone: 'normal', emphasis: 0 }
  if (flags.threat && layers.has('threats')) return { tone: 'threat', emphasis: 1 }
  if (flags.ghost && layers.has('ghosts')) return { tone: 'ghost', emphasis: 0.2 }
  if (flags.heat && layers.has('anomalyHeat')) return { tone: 'heat', emphasis: 0.55 }
  return { tone: 'normal', emphasis: 0 }
}

/**
 * Resolve an edge's overlay treatment. Focus dims edges outside the
 * blast radius; otherwise the most severe enabled layer wins.
 */
export function resolveEdgeOverlay(
  id: string,
  overlay: OverlayModel,
  layers: Set<OverlayLayer>,
  focus: FocusSet | null,
): OverlayResult<EdgeTone> {
  if (focus) {
    return focus.edges.has(id)
      ? { tone: 'focus', emphasis: 1 }
      : { tone: 'dim', emphasis: 0 }
  }
  const flags = overlay.edges.get(id)
  if (!flags) return { tone: 'normal', emphasis: 0 }
  if (flags.suspicious && layers.has('suspicious')) return { tone: 'suspicious', emphasis: 1 }
  if (flags.bottleneck && layers.has('bottlenecks')) return { tone: 'bottleneck', emphasis: 0.8 }
  if (flags.asymmetric && layers.has('asymmetric')) return { tone: 'asymmetric', emphasis: 0.6 }
  if (flags.stale && layers.has('staleLinks')) return { tone: 'stale', emphasis: 0.5 }
  return { tone: 'normal', emphasis: 0 }
}
