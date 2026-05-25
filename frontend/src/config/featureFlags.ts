/**
 * Feature flags — compile-time / env-driven toggles.
 *
 * `topologyV2` gates the new Sigma.js 2D topology engine ("Final Gold
 * Release"). Two flags now, layered:
 *
 * - `topologyV2` (VITE_TOPOLOGY_V2)        — keeps the parallel route
 *   `/topology-next` reachable / shown in the sidebar. Default ON in dev.
 *
 * - `topologyV2Canonical` (VITE_TOPOLOGY_V2_CANONICAL) — promotes V2 to
 *   the primary `/topology` route. When on, `/topology-classic` remains
 *   reachable as a permanent kill-switch / escape hatch; users typing
 *   `/topology` get V2. When off, `/topology` keeps rendering the
 *   classic React Flow page (rollback) — V2 is still reachable only at
 *   `/topology-next`. Default ON in dev, OFF in prod until pilot bakes.
 */

function flag(value: string | undefined, devDefault: boolean): boolean {
  if (value === undefined) return devDefault
  return value !== 'off' && value !== 'false' && value !== '0'
}

export const featureFlags = {
  /** New Sigma.js + graphology 2D topology engine. */
  topologyV2: flag(import.meta.env.VITE_TOPOLOGY_V2 as string | undefined, !!import.meta.env.DEV),
  /** Promote V2 to the canonical /topology route. Classic stays at
   *  /topology-classic as a kill-switch. */
  topologyV2Canonical: flag(
    import.meta.env.VITE_TOPOLOGY_V2_CANONICAL as string | undefined,
    !!import.meta.env.DEV,
  ),
}

export type FeatureFlag = keyof typeof featureFlags
