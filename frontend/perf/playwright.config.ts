/**
 * Playwright config — T8.3.B perf harness.
 *
 * Goal: a deterministic, headless-Chromium-only measurement environment
 * that runs alongside (but never inside) the application build. No
 * production code path imports from this directory; Playwright's runner
 * picks the specs up directly via this config.
 *
 * The settings here lock down everything that could perturb a perf
 * measurement: parallel execution off, retries off, traces / videos
 * off, screenshots only on failure, viewport + DPR fixed, exactly one
 * Chromium build (headless shell).
 *
 * Two ways to run:
 *   1. Manual dev server — `npm run dev` in one terminal, then
 *      `npx playwright test --config=perf/playwright.config.ts` in
 *      another. The `webServer` block is OFF by default so the perf
 *      run does not wait on Vite startup.
 *   2. Auto dev server — set `PERF_AUTO_DEVSERVER=1` to have
 *      Playwright start Vite itself and tear it down at the end.
 *      Useful for CI; slightly less deterministic since Vite's first
 *      paint timing is in the loop.
 *
 * `baseURL` can be overridden via `PERF_BASE_URL`. Default points at
 * the Vite dev server on `http://localhost:5173`.
 */
import { defineConfig } from '@playwright/test'

const BASE_URL = process.env.PERF_BASE_URL ?? 'http://localhost:5173'
const AUTO_DEVSERVER = process.env.PERF_AUTO_DEVSERVER === '1'

export default defineConfig({
  testDir: './specs',
  outputDir: './.playwright-output',

  // ── deterministic execution ──────────────────────────────────────────
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // 60 s per spec is ample for cold-boot @ 1k; the harvest loop reads
  // the overlay after the graph stabilises (typically < 5 s @ 1k).
  timeout: 60_000,
  expect: { timeout: 5_000 },

  // ── reporting (lightweight; the artifacts are the real output) ─────
  reporter: [
    ['list'],
    ['json', { outputFile: './results/.playwright-summary.json' }],
  ],

  use: {
    baseURL: BASE_URL,
    headless: true,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    // No traces, no videos — they distort the timing we're trying to
    // measure. Screenshots only when something failed.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    // `reducedMotion` deliberately left at Chromium's default ("no-preference"
    // — we MEASURE motion; do not reduce it). Playwright 1.49 doesn't expose
    // it at the use-block level; if a later upgrade does, set it explicitly.
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: 'chromium-headless',
      // Locked to headless Chromium (downloaded by `playwright install
      // chromium --with-deps`); no Firefox / WebKit so cross-engine
      // variance is out of the loop. We deliberately DO NOT spread
      // `devices['Desktop Chrome']` here — it would override the
      // 1920×1080 viewport set in the top-level `use` block.
      use: {
        browserName: 'chromium',
        headless: true,
      },
    },
  ],

  // ── optional auto dev-server (CI) ──────────────────────────────────
  webServer: AUTO_DEVSERVER
    ? {
        command: 'npm run dev -- --port 5173 --strictPort',
        url: BASE_URL,
        cwd: '..',
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
      }
    : undefined,
})
