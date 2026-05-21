/**
 * Scenario runner — T8.3.C.
 *
 * Most of the 24 matrix cells differ only in (a) the URL's `scenario`
 * tag, (b) the action sequence that runs between "graph settled" and
 * "harvest". The boot, settle, sanity, and artifact-emit boilerplate
 * is identical. This helper consolidates that boilerplate so each
 * scenario spec is just:
 *
 *   for (const size of SIZES) {
 *     test(`${SCENARIO} @ ${tag}: …`, async ({ page }, testInfo) => {
 *       await runScenario(page, testInfo, {
 *         scenario: 'fullscreen-noc',
 *         scenarioUrlTag: 'noc',
 *         size,
 *         action: async ({ page }) => { …toggle UI, wait… },
 *       })
 *     })
 *   }
 *
 * Cold-boot and warm-cache (T8.3.C.1 / .2) keep their existing
 * standalone form — they were written before this helper and are
 * stable; the refactor is deferred to T8.3.D housekeeping.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { CDPCollector } from './cdpMetrics'
import { emitArtifact, perfRootFromTestInfo } from './artifact'
import { seedFakeAuth, blockBackendTraffic, pinViewportHeight } from './seedAuth'

export interface ScenarioRunArgs {
  /** Artifact `scenario` field — e.g. 'fullscreen-noc'. */
  scenario: string
  /** URL `?scenario=…` value — e.g. 'noc'. */
  scenarioUrlTag: string
  /** Synthetic graph size: 1000 / 2500 / 5000 / 10000. */
  size: number
  /** RNG seed for the synthetic generator. Defaults to 42. */
  seed?: number
  /** Per-test wall-clock budget (override only if action is long). */
  testTimeoutMs: number
  /** Max time for the graph to settle (FA2). */
  settleTimeoutMs: number
  /** Observation window for the post-action harvest. Default 3000. */
  observationWindowMs?: number
  /**
   * Scenario-specific action sequence to run AFTER boot + settle and
   * BEFORE harvest. For cold-boot this would be a no-op; for
   * fullscreen-noc it toggles presentation; for filter-switch it cycles
   * overlay layers; etc.
   */
  action: (ctx: { page: Page }) => Promise<void>
  /** Optional: extra `Warning[]` records to merge into the artifact
   * (e.g. an action-specific note). */
  extraWarnings?: Array<{ code: string; detail: string }>
}

/**
 * Boot the page in stress mode, run the scenario's action sequence,
 * harvest, emit the artifact. Use from inside a Playwright `test()` body.
 */
export async function runScenario(
  page: Page,
  testInfo: TestInfo,
  args: ScenarioRunArgs,
): Promise<void> {
  test.setTimeout(args.testTimeoutMs)
  const PERF_ROOT = perfRootFromTestInfo(testInfo)
  const seed = args.seed ?? 42

  // Surface real failures; filter the routine network noise our own
  // blockers produce.
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

  // ── navigate ──────────────────────────────────────────────────────────
  const url =
    `/topology-next?stress=${args.size}` +
    `&perf=1&scenario=${args.scenarioUrlTag}&seed=${seed}`
  await page.goto(url, { waitUntil: 'load' })
  await collector.waitForOverlayReady(20_000)
  await collector.waitForGraphSettled(args.settleTimeoutMs)

  // ── scenario-specific action ──────────────────────────────────────────
  await args.action({ page })

  // ── harvest ───────────────────────────────────────────────────────────
  const browser = await collector.browserBuild()
  const { metrics, warnings } = await collector.harvest({
    observationWindowMs: args.observationWindowMs ?? 3_000,
  })
  await collector.stop()

  // Merge action-supplied warnings into the artifact.
  const allWarnings = args.extraWarnings
    ? [...warnings, ...args.extraWarnings.map((w) => ({
        code: w.code as 'overlay_missing' | 'longtask_unsupported' |
                       'heap_unsupported' | 'frame_history_short',
        detail: w.detail,
      }))]
    : warnings

  // ── sanity ────────────────────────────────────────────────────────────
  await expect(page.locator('[data-testid="topology-perf-overlay"]'))
    .toBeVisible()
  const canvasCount = await page.locator('canvas').count()
  expect(canvasCount, 'at least one <canvas> mounted (Sigma)')
    .toBeGreaterThanOrEqual(1)

  // ── emit ──────────────────────────────────────────────────────────────
  const target = emitArtifact(PERF_ROOT, {
    scenario: args.scenario,
    graphSize: args.size,
    browser,
    environment: {
      viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
      media: 'headless',
      startedAt: new Date().toISOString(),
    },
    stressOptions: { size: args.size, scenario: args.scenarioUrlTag, seed },
    metrics,
    warnings: allWarnings,
  })

  const tag = args.size >= 1000 ? `${args.size / 1000}k` : `${args.size}`
  console.log(`  ✓ ${tag}: ${target}`)
  console.log(`  metrics @ ${tag}: avgFps=${metrics.avgFps}  ` +
              `p95=${metrics.p95FrameTimeMs}ms  boot=${metrics.bootDurationMs}ms  ` +
              `longest-task=${metrics.longestTaskMs}ms  ` +
              `heap-used=${metrics.heapUsedMb}MB  warnings=${allWarnings.length}`)
}

/**
 * Wait for the dev test handles (`window.__perfTestHandles`) to be
 * installed by `TopologyV2/index.tsx`'s perf-mode useEffect. The
 * dynamic import takes a few hundred ms; this is a focused wait so the
 * spec doesn't try to call a handle that isn't there yet.
 */
export async function waitForTestHandles(
  page: Page,
  timeoutMs = 10_000,
): Promise<void> {
  await page.waitForFunction(
    () => !!(window as unknown as { __perfTestHandles?: object }).__perfTestHandles,
    undefined,
    { timeout: timeoutMs },
  )
}

/** Standard size matrix — shared across every T8.3.C scenario. */
export const SIZES = [1000, 2500, 5000, 10000] as const

/** Standard per-size budgets — tuned for headless Chromium 131 on the
 * local dev server (the canonical measurement environment). */
export function settleTimeoutMs(size: number): number {
  if (size >= 10000) return 120_000
  if (size >= 5000) return 60_000
  return 30_000
}

export function testTimeoutMs(size: number, actionBudgetMs = 0): number {
  // Base: cold-boot wall-clock + 30 s slack; the action budget is on top.
  if (size >= 10000) return 240_000 + actionBudgetMs
  if (size >= 5000) return 150_000 + actionBudgetMs
  return 90_000 + actionBudgetMs
}

export function sizeTag(size: number): string {
  return size >= 1000 ? `${size / 1000}k` : `${size}`
}
