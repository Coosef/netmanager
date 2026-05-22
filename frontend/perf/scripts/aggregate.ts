/**
 * T8.3.C aggregator — reads every `frontend/perf/results/*.json`, evaluates
 * each cell against the threshold config in `./thresholds.json`, writes
 * `frontend/perf/results/SUMMARY.md`, and prints a one-screen hotspot
 * ranking to stdout (the data the T8.3.D plan will consume).
 *
 * Run via the `run-aggregate.sh` wrapper which invokes Node with
 * `--experimental-strip-types`; no transpilation step required (Node 22+).
 *
 * Designed to be defensive: missing artifacts are listed as `(missing)`
 * in the summary so it's obvious which cells didn't run; an unknown
 * scenario name in the artifact prints a warning but doesn't crash.
 * The exit code is always 0 unless `--strict` is passed AND at least
 * one cell evaluates as FAIL — CI gating is opt-in, not the default,
 * because the baseline expects WARN/FAIL on the known hotspots
 * (cluster-expand-collapse @ 10k, ws-patch-flood @ 5k+).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── resolve paths relative to this script ───────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const PERF_ROOT = resolve(__dirname, '..')
const RESULTS_DIR = join(PERF_ROOT, 'results')
const THRESHOLDS = join(__dirname, 'thresholds.json')
const SUMMARY_PATH = join(RESULTS_DIR, 'SUMMARY.md')

// ── shapes — kept in lockstep with `harness/cdpMetrics.ts` (T8.3.B v1
//    schema). Duplicated here so the script is self-contained; if the
//    schema bumps, both files must update.
interface PageMetrics {
  bootDurationMs: number
  avgFps: number
  p95FrameTimeMs: number
  longestTaskMs: number
  totalLongTaskMs: number
  longTaskCount: number
  heapUsedMb: number
  heapPeakMb: number
  renderCount: number
  webglDrawCalls: number
  domNodeCount: number
}
interface Artifact {
  schema_version: number
  scenario: string
  graph_size: number
  timestamp: string
  metrics: PageMetrics
  warnings: { code: string; detail: string }[]
}

interface MetricBand {
  okMin?: number;  warnMin?: number   // higher-is-better
  okMax?: number;  warnMax?: number   // lower-is-better
}
interface ThresholdConfig {
  metrics: Record<string, MetricBand>
  scenarios?: Record<string, Record<string, MetricBand>>
}

type Band = 'OK' | 'WARN' | 'FAIL' | 'N/A'

const TRACKED_METRICS = [
  'avgFps', 'p95FrameTimeMs', 'longestTaskMs', 'totalLongTaskMs',
] as const
type TrackedMetric = (typeof TRACKED_METRICS)[number]

const SCENARIOS = [
  'cold-boot', 'warm-cache', 'fullscreen-noc',
  'filter-switch', 'cluster-expand-collapse', 'ws-patch-flood',
] as const
const SIZES = [1000, 2500, 5000, 10000] as const

// ── threshold evaluation ────────────────────────────────────────────────
function classify(value: number, band: MetricBand | undefined): Band {
  if (!band) return 'N/A'
  if (band.okMin != null && band.warnMin != null) {
    // higher-is-better
    if (value >= band.okMin) return 'OK'
    if (value >= band.warnMin) return 'WARN'
    return 'FAIL'
  }
  if (band.okMax != null && band.warnMax != null) {
    // lower-is-better
    if (value <= band.okMax) return 'OK'
    if (value <= band.warnMax) return 'WARN'
    return 'FAIL'
  }
  return 'N/A'
}

function effectiveBand(
  metric: string, scenario: string, cfg: ThresholdConfig,
): MetricBand | undefined {
  return cfg.scenarios?.[scenario]?.[metric] ?? cfg.metrics[metric]
}

function bandIcon(b: Band): string {
  switch (b) {
    case 'OK':   return '🟢'
    case 'WARN': return '🟡'
    case 'FAIL': return '🔴'
    case 'N/A':  return '⚪'
  }
}

function bandWeight(b: Band): number {
  switch (b) {
    case 'FAIL': return 2
    case 'WARN': return 1
    default:     return 0
  }
}

// ── artifact loading ────────────────────────────────────────────────────
function sizeTag(n: number): string {
  return n >= 1000 ? `${n / 1000}k` : String(n)
}

function loadArtifacts(): Map<string, Artifact> {
  const map = new Map<string, Artifact>()
  let files: string[]
  try {
    files = readdirSync(RESULTS_DIR)
  } catch {
    return map
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    if (f.startsWith('.')) continue
    if (f === 'SUMMARY.md') continue
    try {
      const body = readFileSync(join(RESULTS_DIR, f), 'utf8')
      const art = JSON.parse(body) as Artifact
      if (art.schema_version !== 1) {
        console.error(`! schema mismatch in ${f}: ${art.schema_version}`)
        continue
      }
      map.set(`${art.scenario}-${sizeTag(art.graph_size)}`, art)
    } catch (e) {
      console.error(`! failed to parse ${f}: ${(e as Error).message}`)
    }
  }
  return map
}

// ── markdown rendering ──────────────────────────────────────────────────
interface CellEval {
  scenario: string
  size: number
  metrics: Record<TrackedMetric, number>
  bands: Record<TrackedMetric, Band>
  totalWeight: number
  heapUsedMb: number
  bootDurationMs: number
  warnings: number
}

function evalCell(art: Artifact, cfg: ThresholdConfig): CellEval {
  const metrics = {} as Record<TrackedMetric, number>
  const bands = {} as Record<TrackedMetric, Band>
  let totalWeight = 0
  for (const m of TRACKED_METRICS) {
    const v = (art.metrics as unknown as Record<string, number>)[m]
    metrics[m] = v
    const b = classify(v, effectiveBand(m, art.scenario, cfg))
    bands[m] = b
    totalWeight += bandWeight(b)
  }
  return {
    scenario: art.scenario,
    size: art.graph_size,
    metrics,
    bands,
    totalWeight,
    heapUsedMb: art.metrics.heapUsedMb,
    bootDurationMs: art.metrics.bootDurationMs,
    warnings: art.warnings.length,
  }
}

function fmt(n: number, unit = ''): string {
  if (!Number.isFinite(n)) return '-'
  const v = Math.round(n).toLocaleString('en-US')
  return unit ? `${v} ${unit}` : v
}

function renderScenarioTable(scenario: string, evals: Map<string, CellEval>): string {
  const lines: string[] = []
  lines.push(`### ${scenario}`)
  lines.push('')
  lines.push('| size | avgFps | p95 | longest-task | totalLT | heap | boot |')
  lines.push('|------|--------|-----|--------------|---------|------|------|')
  for (const size of SIZES) {
    const key = `${scenario}-${sizeTag(size)}`
    const c = evals.get(key)
    if (!c) {
      lines.push(`| ${sizeTag(size)} | (missing) | | | | | |`)
      continue
    }
    const cell = (m: TrackedMetric, unit: string) =>
      `${bandIcon(c.bands[m])} ${fmt(c.metrics[m])}${unit}`
    lines.push(
      `| ${sizeTag(size)} | ${cell('avgFps', '')} | ${cell('p95FrameTimeMs', 'ms')} | ` +
      `${cell('longestTaskMs', 'ms')} | ${cell('totalLongTaskMs', 'ms')} | ` +
      `${fmt(c.heapUsedMb)}MB | ${fmt(c.bootDurationMs)}ms |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

function renderHotspots(evals: CellEval[]): string {
  const lines: string[] = []
  lines.push('## Hotspot ranking (for T8.3.D)')
  lines.push('')
  lines.push('Cells sorted by weighted severity (FAIL=2, WARN=1, OK=0, summed across the 4 tracked metrics). ')
  lines.push('Ties broken by avgFps ascending (worst FPS first).')
  lines.push('')
  const ranked = [...evals]
    .filter((c) => c.totalWeight > 0)
    .sort((a, b) => b.totalWeight - a.totalWeight || a.metrics.avgFps - b.metrics.avgFps)
  if (ranked.length === 0) {
    lines.push('_All cells in OK band — no hotspots to surface._')
    return lines.join('\n')
  }
  lines.push('| rank | scenario | size | weight | avgFps | p95 | longest-task | totalLT |')
  lines.push('|------|----------|------|--------|--------|-----|--------------|---------|')
  ranked.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${c.scenario} | ${sizeTag(c.size)} | ${c.totalWeight} | ` +
      `${bandIcon(c.bands.avgFps)} ${fmt(c.metrics.avgFps)} | ` +
      `${bandIcon(c.bands.p95FrameTimeMs)} ${fmt(c.metrics.p95FrameTimeMs)}ms | ` +
      `${bandIcon(c.bands.longestTaskMs)} ${fmt(c.metrics.longestTaskMs)}ms | ` +
      `${bandIcon(c.bands.totalLongTaskMs)} ${fmt(c.metrics.totalLongTaskMs)}ms |`,
    )
  })
  return lines.join('\n')
}

function renderSummary(evals: CellEval[]): string {
  const total = SCENARIOS.length * SIZES.length
  const counted = evals.length
  const totalsByBand = { OK: 0, WARN: 0, FAIL: 0, NA: 0 } as Record<string, number>
  for (const c of evals) {
    for (const m of TRACKED_METRICS) {
      const b = c.bands[m]
      const key = b === 'N/A' ? 'NA' : b
      totalsByBand[key] = (totalsByBand[key] ?? 0) + 1
    }
  }
  const slotsTotal = counted * TRACKED_METRICS.length
  return [
    `# T8.3.C — perf matrix baseline`,
    '',
    `Generated by \`scripts/aggregate.ts\` from \`results/*.json\`. ` +
    `**${counted} / ${total}** cells present.`,
    '',
    `Threshold band tally (across ${slotsTotal} metric slots): ` +
    `🟢 ${totalsByBand.OK} OK · 🟡 ${totalsByBand.WARN} WARN · ` +
    `🔴 ${totalsByBand.FAIL} FAIL · ⚪ ${totalsByBand.NA} N/A.`,
    '',
    `Schema: \`v1\` (locked in T8.3.B). Thresholds: \`scripts/thresholds.json\`. ` +
    `Per-scenario overrides apply for cold-boot, ws-patch-flood, and ` +
    `cluster-expand-collapse — see the JSON for the rationale per metric.`,
    '',
    `## Per-scenario tables`,
    '',
  ].join('\n')
}

// ── main ────────────────────────────────────────────────────────────────
function main(strict: boolean): number {
  const cfg: ThresholdConfig = JSON.parse(readFileSync(THRESHOLDS, 'utf8'))
  const arts = loadArtifacts()
  if (arts.size === 0) {
    console.error(`! no artifacts found under ${RESULTS_DIR}`)
    return strict ? 2 : 0
  }

  // Eval every artifact, keyed by scenario-size.
  const cellEvals = new Map<string, CellEval>()
  for (const art of arts.values()) {
    const key = `${art.scenario}-${sizeTag(art.graph_size)}`
    cellEvals.set(key, evalCell(art, cfg))
  }
  const allEvals = [...cellEvals.values()]

  const sections: string[] = [renderSummary(allEvals)]
  for (const sc of SCENARIOS) sections.push(renderScenarioTable(sc, cellEvals))
  sections.push(renderHotspots(allEvals))
  sections.push('')
  sections.push(
    `---\n_Generated ${new Date().toISOString()} from ${arts.size} artifact files._`,
  )

  const out = sections.join('\n')
  writeFileSync(SUMMARY_PATH, out + '\n', 'utf8')
  console.log(`✓ wrote ${SUMMARY_PATH}`)

  // Stdout summary — same hotspot ranking, condensed.
  const failCells = allEvals.filter((c) => c.totalWeight > 0)
  console.log(`  cells: ${arts.size} present, ${failCells.length} flagged`)
  for (const c of [...failCells].sort((a, b) => b.totalWeight - a.totalWeight).slice(0, 6)) {
    console.log(`    · ${c.scenario} @ ${sizeTag(c.size)}  weight=${c.totalWeight}  ` +
                `fps=${c.metrics.avgFps}  longestLT=${c.metrics.longestTaskMs}ms  ` +
                `totalLT=${c.metrics.totalLongTaskMs}ms`)
  }

  const anyFail = allEvals.some((c) =>
    TRACKED_METRICS.some((m) => c.bands[m] === 'FAIL'),
  )
  if (strict && anyFail) return 1
  return 0
}

const strict = process.argv.includes('--strict')
process.exit(main(strict))
