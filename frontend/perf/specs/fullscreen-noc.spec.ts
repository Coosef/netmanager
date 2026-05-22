/**
 * Fullscreen-NOC scenario — T8.3.C size matrix (4 of 24 cells).
 *
 * Measures the cost of flipping the topology into NOC presentation mode
 * (panels collapse to a clean dashboard) and back. The `presentation`
 * + `fullscreen` state changes drive layout reflow and a sequence of
 * panel mount/unmount transitions; we want to see the per-toggle frame
 * cost and any long-task burst on the transition.
 *
 * Headless Chromium can't reliably enter document fullscreen, so the
 * test handle toggles the `fullscreen` React state directly — the
 * visual effect (panels auto-hidden, canvas full-bleed) is what the
 * scenario measures, and it's the same code path the user's
 * Fullscreen-API click triggers.
 */
import { test } from '@playwright/test'
import {
  runScenario, waitForTestHandles,
  SIZES, settleTimeoutMs, testTimeoutMs, sizeTag,
} from '../harness/scenarioBase'

const SCENARIO = 'fullscreen-noc'
const ACTION_BUDGET_MS = 4_000 // ~4 toggles × ~1 s settle each

for (const size of SIZES) {
  const tag = sizeTag(size)
  test(`${SCENARIO} @ ${tag}: presentation + fullscreen toggle cycles`, async ({ page }, testInfo) => {
    await runScenario(page, testInfo, {
      scenario: SCENARIO,
      scenarioUrlTag: 'noc',
      size,
      testTimeoutMs: testTimeoutMs(size, ACTION_BUDGET_MS),
      settleTimeoutMs: settleTimeoutMs(size),
      action: async ({ page }) => {
        await waitForTestHandles(page)
        // Four state transitions — each triggers a Layout re-render
        // because `panelCtx` depends on both flags (see index.tsx:304).
        await page.evaluate(() => {
          const h = (window as unknown as {
            __perfTestHandles: {
              setPresentation: (b: boolean) => void
              setFullscreen: (b: boolean) => void
            }
          }).__perfTestHandles
          h.setPresentation(true)
        })
        await page.waitForTimeout(800)
        await page.evaluate(() => {
          const h = (window as unknown as {
            __perfTestHandles: { setFullscreen: (b: boolean) => void }
          }).__perfTestHandles
          h.setFullscreen(true)
        })
        await page.waitForTimeout(800)
        await page.evaluate(() => {
          const h = (window as unknown as {
            __perfTestHandles: { setFullscreen: (b: boolean) => void }
          }).__perfTestHandles
          h.setFullscreen(false)
        })
        await page.waitForTimeout(800)
        await page.evaluate(() => {
          const h = (window as unknown as {
            __perfTestHandles: { setPresentation: (b: boolean) => void }
          }).__perfTestHandles
          h.setPresentation(false)
        })
        await page.waitForTimeout(800)
      },
    })
  })
}
