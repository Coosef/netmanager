/**
 * Dev-only stress loader — T8.3.A.
 *
 * Reads `?stress=N&scenario=NAME&perf=1` from the URL and synthesises a
 * v2 topology contract via `__tests__/syntheticGraph.ts` instead of
 * fetching `/topology/graph?v=2`. Used by the T8.3 measurement harness
 * (headless Playwright + manual user-Chrome spot checks) to drive
 * deterministic benchmarks across 1k / 2.5k / 5k / 10k sizes.
 *
 * Isolation: synthetic data NEVER reaches a real org/location view.
 * Activation requires either `import.meta.env.DEV` or an explicit
 * `?perf=1` flag; the production bundle dynamic-imports this module
 * lazily so users without the URL param never download it. The
 * synthetic generator lives under `__tests__/` and stays import-graph
 * isolated from production code; this loader is the **only** bridge,
 * and it ships in a separate Vite chunk.
 *
 * Returns the v2 contract directly — no graph_version mutation, no
 * realtime simulation. Realtime stress (ws-patch-flood) is scripted
 * by the headless harness via `applyTopologyEvent` calls in-page;
 * this loader only seeds the initial graph.
 */
import type { TopologyGraphV2 } from '../contract'

export interface StressOptions {
  /** Synthetic device count: 1000, 2500, 5000, 10000. Clamped to a sane range. */
  size: number
  /** Named scenario for the harness (cold | warm | flood | noc | filter | cluster). */
  scenario: string
  /** Optional RNG seed for deterministic fixtures. */
  seed?: number
}

const MIN_SIZE = 100
const MAX_SIZE = 20_000
const DEFAULT_SEED = 42
const VALID_SCENARIOS = new Set([
  'cold', 'warm', 'flood', 'noc', 'filter', 'cluster',
])

/**
 * Parse the URL for stress-mode parameters. Returns `null` when the
 * page is in normal (real-API) mode.
 *
 * Activation rules:
 *   * `?stress=<n>` must be set (otherwise normal mode)
 *   * EITHER `import.meta.env.DEV` is true (vite dev server),
 *     OR `?perf=1` is also present (production opt-in for ops)
 *
 * The double gate keeps synthetic data out of production by default
 * — a user with no URL flags sees nothing changed.
 */
export function parseStressParams(search: string): StressOptions | null {
  const params = new URLSearchParams(search)
  const sizeRaw = params.get('stress')
  if (!sizeRaw) return null

  const isDev = import.meta.env.DEV
  const explicitPerf = params.get('perf') === '1'
  if (!isDev && !explicitPerf) return null

  const sizeNum = Number(sizeRaw)
  if (!Number.isFinite(sizeNum)) return null
  const size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(sizeNum)))

  const scenarioRaw = params.get('scenario') ?? 'cold'
  const scenario = VALID_SCENARIOS.has(scenarioRaw) ? scenarioRaw : 'cold'

  const seedRaw = params.get('seed')
  const seedNum = seedRaw != null ? Number(seedRaw) : NaN
  const seed = Number.isFinite(seedNum) ? seedNum : DEFAULT_SEED

  return { size, scenario, seed }
}

/**
 * Build a synthetic v2 contract from the stress options. Dynamic-imports
 * `__tests__/syntheticGraph.ts` so the generator stays in a separate
 * Vite chunk; the chunk is fetched only when the URL param triggers
 * stress mode.
 *
 * Returns a fresh contract object each call — no caching, so a reload
 * with `?seed=N` reproduces the same fixture deterministically.
 */
export async function loadStressGraph(opts: StressOptions): Promise<TopologyGraphV2> {
  const { generateSyntheticContract } = await import('../__tests__/syntheticGraph')
  return generateSyntheticContract(opts.size, { seed: opts.seed ?? DEFAULT_SEED })
}

/**
 * Convenience composer for the React side: parse + (if active) load.
 * Returns `null` in normal mode so the caller falls back to the real
 * `useTopologyGraphV2()` hook.
 */
export async function maybeLoadStress(search: string): Promise<{
  data: TopologyGraphV2
  opts: StressOptions
} | null> {
  const opts = parseStressParams(search)
  if (!opts) return null
  const data = await loadStressGraph(opts)
  return { data, opts }
}
