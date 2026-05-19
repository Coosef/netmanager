/**
 * Feature flags — compile-time / env-driven toggles.
 *
 * `topologyV2` gates the new Sigma.js 2D topology engine ("Final Gold
 * Release"). It runs as a parallel route (`/topology-next`); the classic
 * `/topology` page is untouched. Default: ON in dev, overridable with
 * `VITE_TOPOLOGY_V2=off|on`.
 */

function flag(value: string | undefined, devDefault: boolean): boolean {
  if (value === undefined) return devDefault
  return value !== 'off' && value !== 'false' && value !== '0'
}

export const featureFlags = {
  /** New Sigma.js + graphology 2D topology engine. */
  topologyV2: flag(import.meta.env.VITE_TOPOLOGY_V2 as string | undefined, !!import.meta.env.DEV),
}

export type FeatureFlag = keyof typeof featureFlags
