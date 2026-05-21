/**
 * Cold-boot scenario — T8.3.C size matrix (4 of 24 cells).
 *
 * Same flow as the T8.3.B canonical (open `/topology-next?stress=N&perf=1&
 * scenario=cold`, wait for the graph to settle, harvest, emit artifact);
 * iterated over the four matrix sizes so one spec file produces all four
 * `cold-boot-<size>.json` artifacts.
 *
 * "Cold" = fresh page, no prior load, no warm Vite chunks. Synthetic
 * graph from the in-app stress loader (no backend round trip).
 *
 * The remaining 5 scenarios (T8.3.C.2–C.4) follow this spec verbatim;
 * only the URL + the post-boot action sequence differ. Anything generic
 * lives in `../harness/`.
 */
import { test, expect } from '@playwright/test'
import { CDPCollector } from '../harness/cdpMetrics'
import { emitArtifact, perfRootFromTestInfo } from '../harness/artifact'
import { seedFakeAuth, blockBackendTraffic, pinViewportHeight } from '../harness/seedAuth'

const SCENARIO = 'cold-boot'
// The T8.3 size matrix — one artifact per entry. `?stress=N` drives the
// synthetic graph generator; no backend involvement.
const SIZES = [1000, 2500, 5000, 10000] as const

// Per-size budget for FA2 layout to finish. At 10k the layout worker
// can run for ~30–60 s; the smaller sizes settle in seconds.
function settleTimeoutMs(size: number): number {
  if (size >= 10000) return 120_000
  if (size >= 5000) return 60_000
  return 30_000
}

// Per-test budget. Headless cold boot at 10k can take 60–90 s end to
// end before harvest — the Playwright default of 60 s would bounce it.
function testTimeoutMs(size: number): number {
  if (size >= 10000) return 240_000
  if (size >= 5000) return 150_000
  return 90_000
}

function sizeTag(size: number): string {
  return size >= 1000 ? `${size / 1000}k` : `${size}`
}

for (const size of SIZES) {
  const tag = sizeTag(size)
  test(`${SCENARIO} @ ${tag}: fresh page → graph settled → metrics harvested`, async ({ page }, testInfo) => {
    test.setTimeout(testTimeoutMs(size))
    const PERF_ROOT = perfRootFromTestInfo(testInfo)

    // Surface real failures: a silent JS exception is the most common
    // cause of "overlay never appeared". Routine network + 4xx noise
    // from the blocked API is filtered.
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

    // ── navigate from cold (no prior load) ────────────────────────────
    const URL_PATH = `/topology-next?stress=${size}&perf=1&scenario=cold&seed=42`
    await page.goto(URL_PATH, { waitUntil: 'load' })

    // The overlay is the canonical "perf mode is active" signal.
    await collector.waitForOverlayReady(20_000)

    // Wait for the graph to settle (rAF unblocked, FA2 done).
    await collector.waitForGraphSettled(settleTimeoutMs(size))

    // ── harvest ────────────────────────────────────────────────────────
    const browser = await collector.browserBuild()
    const { metrics, warnings } = await collector.harvest({ observationWindowMs: 3_000 })
    await collector.stop()

    // ── sanity: the page actually rendered the synthetic graph ────────
    await expect(page.locator('[data-testid="topology-perf-overlay"]')).toBeVisible()
    const canvasCount = await page.locator('canvas').count()
    expect(canvasCount, 'at least one <canvas> mounted (Sigma)').toBeGreaterThanOrEqual(1)

    // ── emit artifact ─────────────────────────────────────────────────
    const target = emitArtifact(PERF_ROOT, {
      scenario: SCENARIO,
      graphSize: size,
      browser,
      environment: {
        viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
        media: 'headless',
        startedAt: new Date().toISOString(),
      },
      stressOptions: { size, scenario: 'cold', seed: 42 },
      metrics,
      warnings,
    })

    console.log(`  ✓ ${tag}: ${target}`)
    // Note: `dom-nodes` is HTML DOM, not graph nodes — Sigma renders the
    // graph in a single <canvas>, so this count is dominated by the
    // AntD chrome and doesn't scale with the synthetic graph size.
    console.log(`  metrics @ ${tag}: avgFps=${metrics.avgFps}  p95=${metrics.p95FrameTimeMs}ms  ` +
                `longest-task=${metrics.longestTaskMs}ms  heap-used=${metrics.heapUsedMb}MB  ` +
                `dom-nodes=${metrics.domNodeCount}  warnings=${warnings.length}`)
  })
}
