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
        // Snapshot the initial collapsed set so we can faithfully
        // restore the frontier at the end. `getCollapsed()` returns
        // the ACTUAL collapsed cluster IDs at this moment (the default
        // 'layer' tier frontier built by `collapsedSetForTier` on
        // mount). Earlier versions of this spec used `listClusterIds()`
        // which returns EVERY cluster — that made the restore step a
        // bulk "collapse-everything" call that essentially performed
        // a full reapply equivalent, blocking the main thread for
        // seconds and masking the per-action expand cost.
        const initialCollapsed = await page.evaluate(() => {
          const h = (window as unknown as {
            __perfTestHandles: { getCollapsed: () => string[] }
          }).__perfTestHandles
          return h.getCollapsed()
        })
        // Targets to drill: real cluster IDs from the current frontier
        // (so the expand actually does something). Pick the first N
        // from the snapshot for determinism.
        const targets = initialCollapsed.slice(0, MAX_TARGETS)
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
        // Restore the original frontier — small diff vs the post-drill
        // state, so the delta path handles it in O(touched) again.
        await page.evaluate((ids) => {
          const h = (window as unknown as {
            __perfTestHandles: { setCollapsed: (ids: string[]) => void }
          }).__perfTestHandles
          h.setCollapsed(ids)
        }, initialCollapsed)
        await page.waitForTimeout(perCycle)
      },
    })
  })
}
