/**
 * WS patch-flood scenario — T8.3.C size matrix (4 of 24 cells).
 *
 * Synthesises a 5-second burst of `topology_node_updated` events
 * dispatched through `dispatchPatchBurst` on `window.__perfTestHandles`,
 * which routes every event through the SAME `handleEvent` →
 * `applyTopologyEvent` funnel that the real WebSocket path uses (T8.2
 * §6.5: `patch.ts` stays the single mutation point).
 *
 * Why a dev handle and not a fake WS server: a fake server would need
 * to bind to the live `/api/v1/ws/events` endpoint, replace the
 * `seedAuth.blockBackendTraffic` route, and manage the upgrade race —
 * way more harness machinery than the single-page-function call this
 * scenario actually needs. The events go through the production funnel
 * either way; the harness just synthesises them in-page.
 *
 * Event rate: 50 events/sec for 5 s = 250 events. This is well above
 * a realistic production rate (a saturated 1k-node fleet typically
 * pushes ~5–15 events/sec during a topology storm) so the scenario
 * deliberately stresses the rendering side, not the realistic path.
 * The scenario name is `ws-patch-flood`: the "flood" word is load-
 * bearing — we want the upper bound.
 *
 * The harness's rAF + long-task recorder runs continuously across the
 * boot + flood window, so the harvested metrics include the flood's
 * frames. The post-flood 3 s observation window also captures the
 * steady-state recovery; T8.3.D can split the two in post-processing
 * if needed.
 */
import { test } from '@playwright/test'
import {
  runScenario, waitForTestHandles,
  SIZES, settleTimeoutMs, testTimeoutMs, sizeTag,
} from '../harness/scenarioBase'

const SCENARIO = 'ws-patch-flood'
const PATCH_COUNT = 250
const PATCH_INTERVAL_MS = 20            // 50 Hz dispatch
const ACTION_BUDGET_MS = PATCH_COUNT * PATCH_INTERVAL_MS + 3_000 // 8 s

for (const size of SIZES) {
  const tag = sizeTag(size)
  test(`${SCENARIO} @ ${tag}: 5 s × 50 Hz topology_node_updated burst`, async ({ page }, testInfo) => {
    await runScenario(page, testInfo, {
      scenario: SCENARIO,
      scenarioUrlTag: 'flood',
      size,
      testTimeoutMs: testTimeoutMs(size, ACTION_BUDGET_MS),
      settleTimeoutMs: settleTimeoutMs(size),
      // Bump the observation window so a sizeable tail of the flood's
      // long tasks lands inside it (the recorder is cumulative; this
      // just keeps the harvest from cutting off mid-burst).
      observationWindowMs: 4_000,
      action: async ({ page }) => {
        await waitForTestHandles(page)
        const result = await page.evaluate(
          async ({ count, intervalMs }) => {
            const h = (window as unknown as {
              __perfTestHandles: {
                dispatchPatchBurst: (opts: { count: number; intervalMs: number }) => Promise<{
                  durationMs: number; applied: number
                  ignored_scope_mismatch: number; stale: number
                  refetch: number; invalid_payload: number; drift: number
                }>
              }
            }).__perfTestHandles
            return await h.dispatchPatchBurst({ count, intervalMs })
          },
          { count: PATCH_COUNT, intervalMs: PATCH_INTERVAL_MS },
        )
        console.log(
          `  · burst: ${result.applied}/${PATCH_COUNT} applied in ${Math.round(result.durationMs)}ms`,
        )
      },
    })
  })
}
