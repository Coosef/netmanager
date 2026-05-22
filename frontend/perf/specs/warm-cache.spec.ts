/**
 * Warm-cache scenario — T8.3.C size matrix (4 of 24 cells).
 *
 * Same surface as cold-boot, measured **after** a warmup load. The
 * warmup primes:
 *   * Vite's served chunks (HTTP cache + dev server module graph)
 *   * V8's compilation cache for the bundle
 *   * Chromium's font / blob caches
 *   * The synthetic graph generator chunk (`syntheticGraph-*.js`)
 *
 * The measured pass is a `page.reload()` — same URL, same seed, same
 * synthetic fixture — so the only delta vs cold-boot is the cache
 * state. Expected outcome: materially shorter boot-to-settled time
 * and a smaller initial long-task burst. If warm-cache shows no
 * improvement over cold, the bundle is bottlenecked on something
 * that the cache doesn't help (a hint for T8.3.E).
 *
 * Notes:
 *   * `installInPageRecorder` is an init script, so the recorder
 *     state is reset to a fresh `__perfRec` on every load — the
 *     measurement reads only the post-reload window.
 *   * CDP `Performance.getMetrics` returns `NavigationStart` from
 *     the most-recent commit, so `bootDurationMs` is the reload
 *     timing, not the cumulative warmup + reload time.
 */
import { test, expect } from '@playwright/test'
import { CDPCollector } from '../harness/cdpMetrics'
import { emitArtifact, perfRootFromTestInfo } from '../harness/artifact'
import { seedFakeAuth, blockBackendTraffic, pinViewportHeight } from '../harness/seedAuth'

const SCENARIO = 'warm-cache'
const SIZES = [1000, 2500, 5000, 10000] as const

function settleTimeoutMs(size: number): number {
  if (size >= 10000) return 120_000
  if (size >= 5000) return 60_000
  return 30_000
}

function testTimeoutMs(size: number): number {
  // Warm-cache runs the boot twice; bump the budget accordingly.
  if (size >= 10000) return 360_000
  if (size >= 5000) return 240_000
  return 150_000
}

function sizeTag(size: number): string {
  return size >= 1000 ? `${size / 1000}k` : `${size}`
}

for (const size of SIZES) {
  const tag = sizeTag(size)
  test(`${SCENARIO} @ ${tag}: warmup → reload → metrics harvested`, async ({ page }, testInfo) => {
    test.setTimeout(testTimeoutMs(size))
    const PERF_ROOT = perfRootFromTestInfo(testInfo)

    page.on('pageerror', (e) => console.log(`  ✗ pageerror: ${e.message}`))
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (text.includes('net::ERR_FAILED')) return
      if (text.includes('Failed to load resource')) return
      if (text.startsWith('Warning: [antd:')) return
      console.log(`  ✗ console.error: ${text}`)
    })

    const collector = new CDPCollector(page)
    await collector.start()
    await collector.installInPageRecorder()
    await seedFakeAuth(page)
    await blockBackendTraffic(page)
    await pinViewportHeight(page)

    const URL_PATH = `/topology-next?stress=${size}&perf=1&scenario=warm&seed=42`

    // ── warmup pass: load + settle, throw the measurement away ────────
    await page.goto(URL_PATH, { waitUntil: 'load' })
    await collector.waitForOverlayReady(20_000)
    await collector.waitForGraphSettled(settleTimeoutMs(size))

    // ── measured pass: reload + settle, harvest ───────────────────────
    // `reload()` triggers a fresh navigation that re-runs the init
    // scripts, so `window.__perfRec` is recreated from t=0 on the
    // measured nav.
    await page.reload({ waitUntil: 'load' })
    await collector.waitForOverlayReady(20_000)
    await collector.waitForGraphSettled(settleTimeoutMs(size))

    const browser = await collector.browserBuild()
    const { metrics, warnings } = await collector.harvest({ observationWindowMs: 3_000 })
    await collector.stop()

    await expect(page.locator('[data-testid="topology-perf-overlay"]')).toBeVisible()
    const canvasCount = await page.locator('canvas').count()
    expect(canvasCount, 'at least one <canvas> mounted (Sigma)').toBeGreaterThanOrEqual(1)

    const target = emitArtifact(PERF_ROOT, {
      scenario: SCENARIO,
      graphSize: size,
      browser,
      environment: {
        viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
        media: 'headless',
        startedAt: new Date().toISOString(),
      },
      stressOptions: { size, scenario: 'warm', seed: 42 },
      metrics,
      warnings,
    })

    console.log(`  ✓ ${tag}: ${target}`)
    console.log(`  metrics @ ${tag}: avgFps=${metrics.avgFps}  p95=${metrics.p95FrameTimeMs}ms  ` +
                `boot=${metrics.bootDurationMs}ms  longest-task=${metrics.longestTaskMs}ms  ` +
                `heap-used=${metrics.heapUsedMb}MB  warnings=${warnings.length}`)
  })
}
