/**
 * Filter-switch scenario — T8.3.C size matrix (4 of 24 cells).
 *
 * Cycles through the seven T5 overlay layers — clearing, applying each
 * one individually, then re-applying the full set — to measure the
 * cost of running the overlay-style pipeline (reducers, edge re-tone,
 * label re-resolve). The graph itself doesn't change; only the
 * per-node / per-edge style derivation reruns.
 *
 * Expected per-transition cost is proportional to the visible node +
 * edge count, so the variance across sizes is the meaningful signal —
 * unlike cold-boot, which is dominated by bundle parse and FA2.
 */
import { test } from '@playwright/test'
import {
  runScenario, waitForTestHandles,
  SIZES, settleTimeoutMs, testTimeoutMs, sizeTag,
} from '../harness/scenarioBase'

const SCENARIO = 'filter-switch'

// Seven layers (mirrors OVERLAY_LAYERS in overlays/overlayModel.ts).
// We re-declare the names here so the spec doesn't reach into
// production code for runtime values; if the layer set changes upstream
// this list won't drift silently — the harvest will simply skip the
// missing layers (the setOverlayLayers handle accepts any string array
// and lets the reducer-side filter for known values).
const ALL_LAYERS = [
  'anomalyHeat', 'threats', 'staleLinks', 'asymmetric',
  'ghosts', 'bottlenecks', 'suspicious',
] as const
// 7 individual cycles + 1 "all" + 1 "none" = 9 transitions, ~300 ms each.
const ACTION_BUDGET_MS = 9 * 400 + 2_000

for (const size of SIZES) {
  const tag = sizeTag(size)
  test(`${SCENARIO} @ ${tag}: cycle overlay layers`, async ({ page }, testInfo) => {
    await runScenario(page, testInfo, {
      scenario: SCENARIO,
      scenarioUrlTag: 'filter',
      size,
      testTimeoutMs: testTimeoutMs(size, ACTION_BUDGET_MS),
      settleTimeoutMs: settleTimeoutMs(size),
      action: async ({ page }) => {
        await waitForTestHandles(page)
        const set = async (layers: readonly string[]) => {
          await page.evaluate((arr) => {
            const h = (window as unknown as {
              __perfTestHandles: {
                setOverlayLayers: (l: readonly string[]) => void
              }
            }).__perfTestHandles
            h.setOverlayLayers(arr)
          }, layers as readonly string[])
          await page.waitForTimeout(300)
        }
        // Clear; apply each layer in isolation; restore the full set.
        await set([])
        for (const layer of ALL_LAYERS) await set([layer])
        await set([...ALL_LAYERS])
      },
    })
  })
}
