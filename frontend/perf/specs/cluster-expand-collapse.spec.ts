/**
 * Cluster expand/collapse scenario — T8.3.C size matrix (4 of 24 cells).
 *
 * Drills into a handful of top-level clusters one at a time, waits for
 * the canvas to redraw, then restores the original collapsed set. Each
 * expansion triggers `applyClusterView` (mutating the graphology graph
 * in place: nodes/edges toggled hidden, cluster meta-edges rebuilt) +
 * a Sigma re-render. The collapse pass tears those changes back out.
 *
 * This is the most graph-heavy interactive scenario in the matrix —
 * the cost scales with cluster size and edge density, so the per-size
 * delta is the signal T8.3.D will rank for the hotspot list.
 */
import { test } from '@playwright/test'
import {
  runScenario, waitForTestHandles,
  SIZES, settleTimeoutMs, testTimeoutMs, sizeTag,
} from '../harness/scenarioBase'

const SCENARIO = 'cluster-expand-collapse'
const MAX_TARGETS = 5
// Per-cycle wait scales lightly with size — bigger graphs need a beat
// to re-render after the cluster-view rebuild.
function cycleWaitMs(size: number): number {
  if (size >= 10000) return 500
  if (size >= 5000) return 400
  return 300
}

for (const size of SIZES) {
  const tag = sizeTag(size)
  const perCycle = cycleWaitMs(size)
  // MAX_TARGETS expand + 1 collapse-restore, both pre/post wait.
  const ACTION_BUDGET_MS = (MAX_TARGETS + 1) * (perCycle + 100) + 2_000
  test(`${SCENARIO} @ ${tag}: drill ${MAX_TARGETS} clusters then restore`, async ({ page }, testInfo) => {
    await runScenario(page, testInfo, {
      scenario: SCENARIO,
      scenarioUrlTag: 'cluster',
      size,
      testTimeoutMs: testTimeoutMs(size, ACTION_BUDGET_MS),
      settleTimeoutMs: settleTimeoutMs(size),
      action: async ({ page }) => {
        await waitForTestHandles(page)
        // Snapshot the initial collapsed set so we can restore it.
        const before = await page.evaluate(() => {
          // The harness installs `listClusterIds()`; the initial
          // collapsed set isn't exposed (it's derived from the
          // collapsedSetForTier helper). Treat "the current cluster
          // IDs" as the initial frontier and pick the first N as
          // expand targets.
          const h = (window as unknown as {
            __perfTestHandles: { listClusterIds: () => string[] }
          }).__perfTestHandles
          return h.listClusterIds()
        })
        const targets = before.slice(0, MAX_TARGETS)
        if (targets.length === 0) {
          // Synthetic 1k graph might end up with zero clusters at the
          // active tier. Don't fail — emit the artifact with a note
          // and let T8.3.D's aggregator flag the size as not applicable.
          return
        }
        for (const clusterId of targets) {
          await page.evaluate((id) => {
            const h = (window as unknown as {
              __perfTestHandles: { expandCluster: (id: string) => void }
            }).__perfTestHandles
            h.expandCluster(id)
          }, clusterId)
          await page.waitForTimeout(perCycle)
        }
        // Restore the original frontier (no need to recompute; just
        // collapse the IDs back).
        await page.evaluate((ids) => {
          const h = (window as unknown as {
            __perfTestHandles: { setCollapsed: (ids: string[]) => void }
          }).__perfTestHandles
          h.setCollapsed(ids)
        }, before)
        await page.waitForTimeout(perCycle)
      },
    })
  })
}
