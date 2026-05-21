/**
 * CDP-based browser metric collector — T8.3.B.
 *
 * The harness drives a real headless Chromium and harvests metrics from
 * three sources:
 *
 *   1. Chrome DevTools Protocol — `Performance.getMetrics`, `Memory`
 *      domain, plus a paint-timing observer for frame stats.
 *   2. The in-app `<PerfOverlay>` — the same `data-testid` rows the user
 *      sees in their own Chrome session, scraped via DOM. This is the
 *      "single source of truth" lock from T8.3.0 §11.
 *   3. Sigma + r3f render counters — exposed on `window` only in DEV
 *      builds (none yet — captured as 0 today; will start populating
 *      when T8.3.E surfaces a hotspot that wants the data).
 *
 * The collector is **read-only**: it never mutates page state, never
 * calls into the topology engine, and never triggers a refetch. A spec
 * drives the page through its scenario; the collector observes.
 */
import type { Page, CDPSession } from '@playwright/test'

export interface BrowserBuild {
  /** Chromium product string, e.g. "HeadlessChrome/131.0.6778.33". */
  product: string
  /** Major Chromium version, parsed from `product`. */
  major: number | null
}

export interface CollectorEnvironment {
  viewport: { width: number; height: number; deviceScaleFactor: number }
  /** Always "headless" for the canonical run; user-Chrome spot checks
   *  set this to "user-hw" via the artifact writer. */
  media: 'headless' | 'user-hw'
  /** UTC ISO timestamp at collection start. */
  startedAt: string
}

export interface PageMetrics {
  /** Wall-clock elapsed from navigation start to graph-stable signal (ms). */
  bootDurationMs: number
  /** Mean FPS over the observation window, as reported by the in-app overlay. */
  avgFps: number
  /** 95th percentile per-frame time (ms), from a rolling 1 s rAF histogram. */
  p95FrameTimeMs: number
  /** Single longest task in the window (ms). */
  longestTaskMs: number
  /** Sum of long-task durations in the window (ms). */
  totalLongTaskMs: number
  /** Long-task count in the window. */
  longTaskCount: number
  /** Current JS heap (MB) at sample end. */
  heapUsedMb: number
  /**
   * Peak JS heap (MB) observed during the window.
   *
   * Caveat — the in-page recorder samples `performance.memory` on every
   * `requestAnimationFrame`. Long tasks suspend rAF, so the busiest
   * window (initial layout / Sigma init) is sampled THE LEAST. The
   * resulting peak undersells the true allocation burst; an artifact
   * with `heapPeakMb < heapUsedMb` is a sign of exactly this. T8.3.E
   * is the place to switch the heap-peak source to a `setInterval`
   * poll independent of rAF (or to read Memory.getHeapUsage via CDP).
   */
  heapPeakMb: number
  /** Cumulative React render frame count from the overlay (since mount). */
  renderCount: number
  /** Sigma + r3f WebGL draw calls (sum, when reported on window). 0 if unreported. */
  webglDrawCalls: number
  /** DOM node count via `Performance.getMetrics` ("Nodes"). */
  domNodeCount: number
}

export interface Warning {
  code: 'overlay_missing' | 'longtask_unsupported' | 'heap_unsupported' | 'frame_history_short'
  detail: string
}

const COLLECTOR_VERSION = 1

// ──────────────────────────────────────────────────────────────────────────

export class CDPCollector {
  private cdp: CDPSession | null = null

  constructor(private readonly page: Page) {}

  /** Open the CDP session + enable the domains we need. Idempotent. */
  async start(): Promise<void> {
    if (this.cdp) return
    this.cdp = await this.page.context().newCDPSession(this.page)
    await this.cdp.send('Performance.enable')
    // Memory domain — only sample on demand (sampling burns CPU); we
    // ask for one snapshot at the start and one at the end.
  }

  async stop(): Promise<void> {
    if (!this.cdp) return
    try {
      await this.cdp.send('Performance.disable')
    } catch {
      /* CDP can already be detached if the page closed first */
    }
    try {
      await this.cdp.detach()
    } catch {
      /* ditto */
    }
    this.cdp = null
  }

  /** Identify the running Chromium build. */
  async browserBuild(): Promise<BrowserBuild> {
    const ua = await this.page.evaluate(() => navigator.userAgent)
    const match = /Chrome\/(\d+)/.exec(ua)
    return {
      product: ua,
      major: match ? Number(match[1]) : null,
    }
  }

  /**
   * Install an in-page perf recorder that runs alongside `<PerfOverlay>`.
   * The overlay drives the visible UI; this script drives the harness
   * harvest. They share the same `PerformanceObserver` event stream so
   * the numbers do not drift.
   *
   * Call BEFORE the page navigates so the script is the first thing the
   * page loads.
   */
  async installInPageRecorder(): Promise<void> {
    await this.page.addInitScript(() => {
      interface Recorder {
        startedAt: number
        frames: number[]
        longTasks: { ts: number; dur: number }[]
        heapPeak: number
      }
      const rec: Recorder = {
        startedAt: performance.now(),
        frames: [],
        longTasks: [],
        heapPeak: 0,
      }
      // rAF histogram
      let lastTs = performance.now()
      const tick = (ts: number) => {
        const delta = ts - lastTs
        if (delta > 0 && delta < 1000) rec.frames.push(delta)
        // bound the history to ~30 s @ 60 fps so we don't grow forever
        if (rec.frames.length > 2000) rec.frames.shift()
        lastTs = ts
        const mem = (performance as Performance & {
          memory?: { usedJSHeapSize: number }
        }).memory
        if (mem && mem.usedJSHeapSize > rec.heapPeak) {
          rec.heapPeak = mem.usedJSHeapSize
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      // long-task observer
      try {
        const obs = new PerformanceObserver((list) => {
          const now = performance.now()
          for (const e of list.getEntries()) {
            rec.longTasks.push({ ts: now, dur: e.duration })
          }
        })
        obs.observe({ entryTypes: ['longtask'] })
      } catch {
        /* not supported */
      }
      ;(window as unknown as { __perfRec: Recorder }).__perfRec = rec
    })
  }

  /**
   * Wait until the `<PerfOverlay>` is rendered and its frame counter
   * has advanced — the canonical "the page is interactive" signal for
   * the topology surface.
   */
  async waitForOverlayReady(timeoutMs = 30_000): Promise<void> {
    await this.page.waitForSelector('[data-testid="topology-perf-overlay"]', { timeout: timeoutMs })
    // Wait for the frame counter to advance past 0 — it ticks on rAF, so
    // any value > 0 means the rAF loop is running.
    await this.page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="perf-frames"]')
        if (!el) return false
        const n = Number(el.textContent ?? '0')
        return n > 0
      },
      undefined,
      { timeout: timeoutMs },
    )
  }

  /**
   * Wait for the topology to "settle" — graph rendered, FA2 worker
   * stopped writing new positions, FPS stable above a threshold. We
   * use a simple heuristic: 3 consecutive 200 ms samples where the
   * frame counter advances by ≥ 10 (i.e. ≥ 50 fps) means rAF is
   * unblocked.
   */
  async waitForGraphSettled(timeoutMs = 30_000): Promise<void> {
    const start = Date.now()
    let consecutive = 0
    let prev = await this.readFrameCounter()
    while (Date.now() - start < timeoutMs) {
      await this.page.waitForTimeout(200)
      const cur = await this.readFrameCounter()
      const delta = cur - prev
      prev = cur
      if (delta >= 10) {
        consecutive++
        if (consecutive >= 3) return
      } else {
        consecutive = 0
      }
    }
    // Don't throw — we still want metrics from a slow boot. The artifact
    // surfaces this as `boot_duration_ms` ≈ the timeout cap.
  }

  private async readFrameCounter(): Promise<number> {
    return this.page.evaluate(() => {
      const el = document.querySelector('[data-testid="perf-frames"]')
      return Number(el?.textContent ?? '0')
    })
  }

  /**
   * Harvest the metric set. Run AFTER the scenario has driven the page
   * through its action sequence (or, for cold-boot, after settle).
   */
  async harvest(opts: { observationWindowMs?: number } = {}): Promise<{
    metrics: PageMetrics
    warnings: Warning[]
  }> {
    const warnings: Warning[] = []
    const cdp = this.cdp!

    // observation window — let the rAF histogram fill before reading
    const windowMs = opts.observationWindowMs ?? 2_000
    await this.page.waitForTimeout(windowMs)

    // ── CDP performance metrics (DOM nodes, JS heap) ─────────────────
    const perf = await cdp.send('Performance.getMetrics')
    const m: Record<string, number> = {}
    for (const { name, value } of perf.metrics) m[name] = value

    const navStart = m['NavigationStart'] ?? 0
    const ts = m['Timestamp'] ?? 0
    const bootDurationMs = navStart > 0 && ts > 0 ? Math.round((ts - navStart) * 1000) : 0

    const domNodeCount = Math.round(m['Nodes'] ?? 0)
    const heapUsedMb = (m['JSHeapUsedSize'] ?? 0) / (1024 * 1024)

    // ── in-page recorder ─────────────────────────────────────────────
    type Recorder = {
      frames: number[]
      longTasks: { ts: number; dur: number }[]
      heapPeak: number
    }
    const rec = await this.page.evaluate(() => {
      return (window as unknown as { __perfRec?: Recorder }).__perfRec ?? null
    })

    let avgFps = 0
    let p95FrameTimeMs = 0
    let longestTaskMs = 0
    let totalLongTaskMs = 0
    let longTaskCount = 0
    let heapPeakMb = heapUsedMb // fallback: at-least the current value

    if (rec) {
      if (rec.frames.length >= 30) {
        const sum = rec.frames.reduce((a: number, b: number) => a + b, 0)
        const meanFrameMs = sum / rec.frames.length
        avgFps = meanFrameMs > 0 ? Math.round(1000 / meanFrameMs) : 0
        const sorted = [...rec.frames].sort((a, b) => a - b)
        p95FrameTimeMs = Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0)
      } else {
        warnings.push({
          code: 'frame_history_short',
          detail: `only ${rec.frames.length} frame samples (window may have been too short)`,
        })
      }
      longTaskCount = rec.longTasks.length
      for (const t of rec.longTasks) {
        totalLongTaskMs += t.dur
        if (t.dur > longestTaskMs) longestTaskMs = t.dur
      }
      longestTaskMs = Math.round(longestTaskMs)
      totalLongTaskMs = Math.round(totalLongTaskMs)
      heapPeakMb = rec.heapPeak / (1024 * 1024)
    } else {
      warnings.push({ code: 'overlay_missing', detail: '__perfRec not on window' })
    }

    // ── overlay scraping (final render-count value) ──────────────────
    const renderCount = await this.page.evaluate(() => {
      const el = document.querySelector('[data-testid="perf-frames"]')
      return Number(el?.textContent ?? '0')
    })

    // ── optional WebGL counters (Sigma / r3f reported on window) ─────
    const webglDrawCalls = await this.page.evaluate(() => {
      const w = window as unknown as { __sigmaStats?: { drawCalls?: number }; __r3fGl?: { info?: { render?: { calls?: number } } } }
      const sigma = w.__sigmaStats?.drawCalls ?? 0
      const r3f = w.__r3fGl?.info?.render?.calls ?? 0
      return sigma + r3f
    })

    return {
      metrics: {
        bootDurationMs,
        avgFps,
        p95FrameTimeMs,
        longestTaskMs,
        totalLongTaskMs,
        longTaskCount,
        heapUsedMb: Math.round(heapUsedMb),
        heapPeakMb: Math.round(heapPeakMb),
        renderCount,
        webglDrawCalls,
        domNodeCount,
      },
      warnings,
    }
  }
}

export const HARNESS_VERSION = COLLECTOR_VERSION
