/**
 * Artifact writer — T8.3.B.
 *
 * Defines the stable JSON schema every spec writes to
 * `frontend/perf/results/<scenario>-<size>.json`. T8.3.C's automation
 * and T8.3.D's report aggregator both depend on this shape; bump
 * `schema_version` on any incompatible change.
 *
 * Schema (v1):
 *   {
 *     schema_version: 1,
 *     scenario:       string,
 *     graph_size:     number,
 *     timestamp:      ISO-8601 UTC,
 *     harness_version: number,
 *     browser:        { product, major },
 *     environment:    { viewport, deviceScaleFactor, media },
 *     stress_options: { size, scenario, seed },
 *     metrics:        { bootDurationMs, avgFps, … },
 *     warnings:       Warning[]
 *   }
 *
 * Writes are atomic (rename-after-temp) so a half-written artifact never
 * confuses a later aggregation run.
 */
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  HARNESS_VERSION,
  type BrowserBuild,
  type CollectorEnvironment,
  type PageMetrics,
  type Warning,
} from './cdpMetrics'

export const SCHEMA_VERSION = 1

export interface StressOptions {
  size: number
  scenario: string
  seed: number
}

export interface Artifact {
  schema_version: typeof SCHEMA_VERSION
  scenario: string
  graph_size: number
  timestamp: string
  harness_version: number
  browser: BrowserBuild
  environment: CollectorEnvironment
  stress_options: StressOptions
  metrics: PageMetrics
  warnings: Warning[]
}

export interface BuildArtifactInput {
  scenario: string
  graphSize: number
  browser: BrowserBuild
  environment: CollectorEnvironment
  stressOptions: StressOptions
  metrics: PageMetrics
  warnings: Warning[]
}

export function buildArtifact(input: BuildArtifactInput): Artifact {
  return {
    schema_version: SCHEMA_VERSION,
    scenario: input.scenario,
    graph_size: input.graphSize,
    timestamp: new Date().toISOString(),
    harness_version: HARNESS_VERSION,
    browser: input.browser,
    environment: input.environment,
    stress_options: input.stressOptions,
    metrics: input.metrics,
    warnings: input.warnings,
  }
}

/**
 * Resolve the artifact path. `perfRoot` is the absolute path of
 * `frontend/perf`; spec files compute it once from `testInfo.project.testDir`.
 */
export function artifactPath(perfRoot: string, scenario: string, graphSize: number): string {
  const sizeTag = graphSize >= 1000 ? `${graphSize / 1000}k` : String(graphSize)
  return resolve(perfRoot, 'results', `${scenario}-${sizeTag}.json`)
}

/**
 * Write atomically: dump JSON to a `.tmp` next to the target, then
 * rename. A spec interrupted mid-write never leaves a corrupted file
 * behind that the aggregator might pick up.
 */
export function writeArtifact(target: string, artifact: Artifact): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + '\n', 'utf8')
  renameSync(tmp, target)
}

/**
 * Convenience: build + write in one call. Returns the absolute path.
 */
export function emitArtifact(
  perfRoot: string,
  input: BuildArtifactInput,
): string {
  const artifact = buildArtifact(input)
  const target = artifactPath(perfRoot, input.scenario, input.graphSize)
  writeArtifact(target, artifact)
  return target
}

/**
 * Compute the perf-root from a Playwright `testInfo` value. Every spec
 * that emits an artifact calls this — keeping it here means specs are
 * not the ones to worry about ESM/CJS module-system quirks.
 *
 * `testInfo.project.testDir` is always the absolute path of `perf/specs`;
 * the perf root is its parent.
 */
export function perfRootFromTestInfo(testInfo: { project: { testDir: string } }): string {
  return dirname(testInfo.project.testDir)
}
