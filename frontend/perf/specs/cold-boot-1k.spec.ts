/**
 * Cold-boot @ 1k — T8.3.B canonical spec.
 *
 * The first end-to-end measurement: open `/topology-next?stress=1000&
 * perf=1&scenario=cold` in a fresh headless Chromium, wait for the
 * graph to settle, harvest the metric set, write the artifact.
 *
 * "Cold" = no prior page load, no warm Vite chunks. Synthetic 1k
 * graph from the in-app stress loader (no backend round trip).
 *
 * The other 23 matrix cells (T8.3.C) follow this spec verbatim; only
 * the URL and the post-boot action sequence differ. Anything generic
 * (auth gate / backend block / viewport pin / metric collection /
 * artifact write) lives in `../harness/`.
 */
import { test, expect } from '@playwright/test'
import { CDPCollector } from '../harness/cdpMetrics'
import { emitArtifact, perfRootFromTestInfo } from '../harness/artifact'
import { seedFakeAuth, blockBackendTraffic, pinViewportHeight } from '../harness/seedAuth'

const SCENARIO = 'cold-boot'
const GRAPH_SIZE = 1000
const URL_PATH = `/topology-next?stress=${GRAPH_SIZE}&perf=1&scenario=cold&seed=42`

test('cold-boot @ 1k: fresh page → graph settled → metrics harvested', async ({ page }, testInfo) => {
  // Perf-root from Playwright's own test info — works regardless of how
  // Playwright transpiles this file (CJS vs ESM differs by version).
  const PERF_ROOT = perfRootFromTestInfo(testInfo)

  // Surface real failures: a silent JS exception in the bundle is the
  // most common cause of "overlay never appeared". Routine network +
  // 4xx noise from the blocked API is filtered.
  page.on('pageerror', (e) => console.log(`  ✗ pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    // Expected, harness-induced noise — don't print.
    if (text.includes('net::ERR_FAILED')) return
    if (text.includes('Failed to load resource')) return
    if (text.startsWith('Warning: [antd:')) return
    console.log(`  ✗ console.error: ${text}`)
  })

  const collector = new CDPCollector(page)
  await collector.start()
  await collector.installInPageRecorder()
  // Auth gate + backend isolation + viewport lock — must run before goto.
  // See `harness/seedAuth.ts` for why each is needed.
  await seedFakeAuth(page)
  await blockBackendTraffic(page)
  await pinViewportHeight(page)

  // ── navigate from cold (no prior load) ─────────────────────────────
  await page.goto(URL_PATH, { waitUntil: 'load' })

  // The overlay is the canonical "perf mode is active" signal.
  await collector.waitForOverlayReady(20_000)

  // Wait for the graph to settle (rAF unblocked, FA2 done).
  await collector.waitForGraphSettled(30_000)

  // ── harvest ─────────────────────────────────────────────────────────
  const browser = await collector.browserBuild()
  const { metrics, warnings } = await collector.harvest({ observationWindowMs: 3_000 })
  await collector.stop()

  // ── sanity: the page actually rendered the synthetic graph ─────────
  // The PerfOverlay is up AND the SigmaCanvas mounted a `<canvas>`.
  await expect(page.locator('[data-testid="topology-perf-overlay"]')).toBeVisible()
  const canvasCount = await page.locator('canvas').count()
  expect(canvasCount, 'at least one <canvas> mounted (Sigma)').toBeGreaterThanOrEqual(1)

  // ── emit artifact ──────────────────────────────────────────────────
  const target = emitArtifact(PERF_ROOT, {
    scenario: SCENARIO,
    graphSize: GRAPH_SIZE,
    browser,
    environment: {
      viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
      media: 'headless',
      startedAt: new Date().toISOString(),
    },
    stressOptions: { size: GRAPH_SIZE, scenario: 'cold', seed: 42 },
    metrics,
    warnings,
  })

  console.log(`  ✓ artifact: ${target}`)
  console.log(`  metrics: avgFps=${metrics.avgFps}  p95=${metrics.p95FrameTimeMs}ms  ` +
              `longest-task=${metrics.longestTaskMs}ms  heap-peak=${metrics.heapPeakMb}MB  ` +
              `nodes=${metrics.domNodeCount}  warnings=${warnings.length}`)
})
