/**
 * Dev-only test handles for the T8.3 perf harness — T8.3.C.
 *
 * Exposes a tiny set of state-driver functions on `window.__perfTestHandles`
 * so the headless Playwright harness can deterministically trigger the
 * in-app actions whose only natural triggers are unlabeled DOM controls
 * (presentation toggle, overlay layer chips, cluster expansion). The
 * remaining scenarios (cold-boot, warm-cache, ws-patch-flood) reach the
 * page through other paths and don't need handles here.
 *
 * Isolation rules:
 *   * Mounted only when stress-mode is active (`?stress=N&perf=1`); the
 *     production bundle dynamic-imports this module from `TopologyV2/
 *     index.tsx` inside a perf-mode `useEffect`, so a normal user
 *     never downloads it — same pattern as `PerfOverlay` and
 *     `stressLoader`.
 *   * Each handle is a pass-through to a setter that already exists in
 *     `TopologyV2/index.tsx`. No new graph mutation paths — `patch.ts`
 *     stays the single mutation point for the topology model (T8.2 §6.5
 *     invariant), and the overlays remain read-only.
 *   * Pure imperative API: the handles never re-render anything by
 *     themselves; they ask React to do it. So the harness sees the same
 *     render path a user-click would trigger.
 */
import type { OverlayLayer } from '../overlays/overlayModel'

const KEY = '__perfTestHandles' as const

export interface TestHandlesAPI {
  /** Toggle the NOC / presentation mode (hides decorative panels). */
  setPresentation: (on: boolean) => void
  /** Direct flip of the `fullscreen` React state — bypasses the
   * Fullscreen API which is flaky in headless Chromium. The visual
   * effect (panels auto-hidden) is what the scenario measures. */
  setFullscreen: (on: boolean) => void
  /** Replace the active overlay-layer set wholesale. Empty array
   * clears all overlays. */
  setOverlayLayers: (layers: OverlayLayer[]) => void
  /** List the cluster IDs the engine currently knows about, so the
   * harness can pick targets without re-implementing topology
   * traversal in TypeScript-on-page. */
  listClusterIds: () => string[]
  /** Replace the collapsed-cluster set wholesale. */
  setCollapsed: (clusters: string[]) => void
  /** Drill one level into a single cluster — delegates to
   * `clustering.expandCluster` with the current engine model. */
  expandCluster: (clusterId: string) => void
}

interface HandleHost {
  [KEY]?: TestHandlesAPI
}

export function installTestHandles(api: TestHandlesAPI): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as HandleHost)[KEY] = api
}

export function uninstallTestHandles(): void {
  if (typeof window === 'undefined') return
  delete (window as unknown as HandleHost)[KEY]
}
