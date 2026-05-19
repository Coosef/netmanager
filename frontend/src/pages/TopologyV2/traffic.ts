/**
 * Intelligent traffic rendering — a restrained, enterprise-grade pulse on
 * the "hot" edges only (saturated/high traffic class, or any anomaly).
 *
 * Deliberately subtle, not arcade-like: a slow ~2.4s, low-amplitude
 * (±16%) size breath, ~11 fps, partial-refreshed so only the hot subset
 * re-renders. Pauses when the tab is hidden or when nothing is hot.
 */
import type Sigma from 'sigma'
import type Graph from 'graphology'

const PERIOD_S = 2.4
const AMPLITUDE = 0.16
const FPS_MS = 90
const MAX_HOT = 600 // above this, keep intensity static (let T7 tune)

function isHot(attr: Record<string, unknown>): boolean {
  if (attr.edgeKind !== 'link') return false
  const tc = attr.trafficClass
  const an = attr.anomalyState
  return tc === 'saturated' || tc === 'high' || (an != null && an !== 'none')
}

export interface TrafficAnimator {
  start(): void
  stop(): void
}

/**
 * Build a traffic animator over a mounted Sigma renderer. The hot-edge
 * set is recomputed on `start()`, so call it again after a graph patch.
 */
export function createTrafficAnimator(sigma: Sigma, graph: Graph): TrafficAnimator {
  let timer: ReturnType<typeof setInterval> | null = null
  let hot: string[] = []

  const collect = () => {
    hot = []
    graph.forEachEdge((edge, attr) => {
      if (isHot(attr)) {
        // snapshot the styled base size so the pulse is relative
        if (attr._baseSize == null) {
          graph.setEdgeAttribute(edge, '_baseSize', attr.size ?? 1)
        }
        hot.push(edge)
      }
    })
  }

  const tick = () => {
    if (document.hidden || !hot.length) return
    const t = performance.now() / 1000
    let live = false
    for (const edge of hot) {
      if (!graph.hasEdge(edge)) continue
      live = true
      const base = (graph.getEdgeAttribute(edge, '_baseSize') as number) ?? 1
      // per-edge phase offset so the fleet doesn't pulse in lock-step
      const phase = (edge.length % 7) / 7
      const wave = 0.5 + 0.5 * Math.sin((t / PERIOD_S + phase) * Math.PI * 2)
      graph.setEdgeAttribute(edge, 'size', base * (1 + AMPLITUDE * wave))
    }
    if (live) {
      try {
        sigma.refresh({ partialGraph: { edges: hot }, skipIndexation: true })
      } catch {
        sigma.refresh()
      }
    }
  }

  return {
    start() {
      this.stop()
      collect()
      if (!hot.length || hot.length > MAX_HOT) return // static — no animation
      timer = setInterval(tick, FPS_MS)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      // restore base sizes so a frozen frame isn't mid-pulse
      for (const edge of hot) {
        if (!graph.hasEdge(edge)) continue
        const base = graph.getEdgeAttribute(edge, '_baseSize') as number | undefined
        if (base != null) graph.setEdgeAttribute(edge, 'size', base)
      }
    },
  }
}
