/**
 * Dev / perf overlay — T8.3.A.
 *
 * A bottom-right floating panel showing live performance metrics —
 * exactly the same numbers the headless Playwright harness will scrape
 * over CDP, so a manual user-Chrome spot-check and the headless run
 * read from one source of truth.
 *
 * Metrics:
 *   * **FPS** — rolling 1-second window from `requestAnimationFrame`
 *     timestamps; matches what the eye perceives during pan / zoom.
 *   * **Heap** — `performance.memory.usedJSHeapSize` when Chrome
 *     exposes it (Chrome-only API; non-Chrome browsers show `—`).
 *   * **Long tasks** — count + total duration over the last 30 s,
 *     captured via `PerformanceObserver` on the `longtask` entry.
 *     Aligned with the T8.3 gate (`< 200 ms / 30 s`).
 *   * **Render count** — cumulative number of frames the component
 *     observed since mount; useful for the WS-flood scenario where
 *     React re-renders are the suspect.
 *
 * Activation:
 *   * Visible only when `import.meta.env.DEV` is true OR the URL
 *     contains `?perf=1`. Production users without the param see
 *     nothing.
 *   * The whole module is dynamic-imported by `index.tsx` only when
 *     either of the above gates is hit, so the perf overlay does
 *     not ship in the default production chunk.
 *
 * The overlay is **read-only** for the page; it never touches Sigma,
 * three.js, the graph model or any state outside its own component.
 */
import { useEffect, useRef, useState } from 'react'

interface LongTaskWindow {
  /** Number of long tasks observed in the last 30 s. */
  count: number
  /** Sum of long-task durations (ms) in the same window. */
  totalMs: number
  /** Single longest task duration (ms) in the same window. */
  maxMs: number
}

const EMPTY_LT: LongTaskWindow = { count: 0, totalMs: 0, maxMs: 0 }
const WINDOW_MS = 30_000

interface PerfMemory {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

function readHeap(): number | null {
  // Chrome-only. Wrapped in try/catch in case a future Chrome locks it
  // behind a permission policy.
  try {
    const mem = (performance as Performance & { memory?: PerfMemory }).memory
    return mem ? mem.usedJSHeapSize : null
  } catch {
    return null
  }
}

function formatMB(bytes: number | null): string {
  if (bytes == null) return '—'
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

export function PerfOverlay() {
  const [fps, setFps] = useState(0)
  const [heap, setHeap] = useState<number | null>(null)
  const [lt, setLt] = useState<LongTaskWindow>(EMPTY_LT)
  const [renderCount, setRenderCount] = useState(0)

  const frameTimes = useRef<number[]>([])
  const longTasks = useRef<{ ts: number; dur: number }[]>([])

  // FPS + heap sampler — rAF loop, ~60 Hz when idle.
  useEffect(() => {
    let raf = 0
    let stopped = false

    const tick = (ts: number) => {
      if (stopped) return
      const arr = frameTimes.current
      arr.push(ts)
      // keep only the last second of frame timestamps
      const cutoff = ts - 1000
      while (arr.length && arr[0] < cutoff) arr.shift()
      setFps(arr.length)
      setRenderCount((r) => r + 1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const heapTimer = window.setInterval(() => setHeap(readHeap()), 1000)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      window.clearInterval(heapTimer)
    }
  }, [])

  // Long-task observer — exposed by all modern browsers, surfaces
  // anything that blocked the main thread for > 50 ms.
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return
    let obs: PerformanceObserver
    try {
      obs = new PerformanceObserver((list) => {
        const now = performance.now()
        for (const entry of list.getEntries()) {
          longTasks.current.push({ ts: now, dur: entry.duration })
        }
        // window the buffer + recompute
        const cutoff = now - WINDOW_MS
        const live = longTasks.current.filter((t) => t.ts >= cutoff)
        longTasks.current = live
        let total = 0
        let max = 0
        for (const t of live) {
          total += t.dur
          if (t.dur > max) max = t.dur
        }
        setLt({ count: live.length, totalMs: Math.round(total), maxMs: Math.round(max) })
      })
      obs.observe({ entryTypes: ['longtask'] })
    } catch {
      // longtask not supported (e.g. Safari) — leave the row at zeros.
      return
    }
    return () => obs?.disconnect()
  }, [])

  // Long-task window also has to age out when no new tasks arrive
  // (otherwise count stays stale forever after a quiet period).
  useEffect(() => {
    const sweep = window.setInterval(() => {
      const now = performance.now()
      const cutoff = now - WINDOW_MS
      const live = longTasks.current.filter((t) => t.ts >= cutoff)
      if (live.length !== longTasks.current.length) {
        longTasks.current = live
        let total = 0
        let max = 0
        for (const t of live) {
          total += t.dur
          if (t.dur > max) max = t.dur
        }
        setLt({ count: live.length, totalMs: Math.round(total), maxMs: Math.round(max) })
      }
    }, 5000)
    return () => window.clearInterval(sweep)
  }, [])

  // ── styling — small, monospace, restrained; not a UI feature ───────────
  const tone = (warn: boolean) => (warn ? '#f87171' : '#94a3b8')

  return (
    <div
      data-testid="topology-perf-overlay"
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        background: 'rgba(8, 17, 36, 0.88)',
        color: '#e2e8f0',
        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        fontSize: 11,
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid #1e293b',
        zIndex: 9999,
        pointerEvents: 'none',
        minWidth: 180,
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ color: '#64748b' }}>fps</span>
        <span data-testid="perf-fps" style={{ color: tone(fps < 30) }}>{fps}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ color: '#64748b' }}>heap</span>
        <span data-testid="perf-heap" style={{ color: tone((heap ?? 0) > 1024 * 1024 * 1024) }}>
          {formatMB(heap)}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ color: '#64748b' }}>long-tasks/30s</span>
        <span data-testid="perf-longtasks" style={{ color: tone(lt.totalMs > 200) }}>
          {lt.count} · {lt.totalMs}ms · max {lt.maxMs}ms
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ color: '#64748b' }}>frames</span>
        <span data-testid="perf-frames">{renderCount}</span>
      </div>
    </div>
  )
}

/** True when the page should mount the overlay (DEV or `?perf=1`). */
export function isPerfMode(search: string = window.location.search): boolean {
  if (import.meta.env.DEV) return true
  return new URLSearchParams(search).get('perf') === '1'
}
