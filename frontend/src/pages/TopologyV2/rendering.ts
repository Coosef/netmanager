/**
 * Rendering rules — pure functions mapping contract attributes onto
 * Sigma display attributes. Enterprise-grade, compact, readable:
 * fill by layer, dimmed by status, sized by importance; edges coloured
 * by anomaly → traffic class. No DOM / Sigma imports — unit testable.
 */
import type {
  TrafficClass,
  EdgeAnomalyState,
  Criticality,
} from './contract'

// ── palette ───────────────────────────────────────────────────────────────
const LAYER_COLOR: Record<string, string> = {
  core: '#3b82f6',
  distribution: '#06b6d4',
  access: '#22c55e',
  edge: '#a855f7',
  wireless: '#ec4899',
  unknown: '#94a3b8',
}
const STATUS_COLOR: Record<string, string> = {
  offline: '#ef4444',
  unreachable: '#f59e0b',
  unknown: '#64748b',
}
const TRAFFIC_COLOR: Record<TrafficClass, string> = {
  idle: '#334155',
  low: '#3b82f6',
  normal: '#22c55e',
  high: '#f59e0b',
  saturated: '#ef4444',
  unknown: '#475569',
}
const ANOMALY_COLOR: Partial<Record<EdgeAnomalyState, string>> = {
  stale: '#f59e0b',
  asymmetric: '#f97316',
  ghost: '#52617a',
}
const CLUSTER_COLOR: Record<string, string> = {
  location: '#6366f1',
  layer: '#0ea5e9',
  rack: '#14b8a6',
}

export const GHOST_COLOR = '#52617a'

// ── nodes ───────────────────────────────────────────────────────────────────

/** Device/ghost fill — layer colour, overridden by a non-online status. */
export function nodeColor(opts: {
  kind: 'device' | 'ghost'
  status?: string
  layer?: string
}): string {
  if (opts.kind === 'ghost') return GHOST_COLOR
  if (opts.status && opts.status !== 'online' && STATUS_COLOR[opts.status]) {
    return STATUS_COLOR[opts.status]
  }
  return LAYER_COLOR[(opts.layer || 'unknown').toLowerCase()] || LAYER_COLOR.unknown
}

/** 3–12px by importance — keeps dense graphs compact, not toy-like. */
export function nodeSize(importanceScore: number): number {
  return 3 + Math.max(0, Math.min(1, importanceScore)) * 9
}

export function clusterColor(type: string): string {
  return CLUSTER_COLOR[type] || '#64748b'
}

/** Cluster super-node size grows with the device count it folds in. */
export function clusterSize(collapsedCount: number): number {
  return 10 + Math.min(28, Math.log2(Math.max(1, collapsedCount)) * 5)
}

// ── edges ───────────────────────────────────────────────────────────────────

/** Anomaly takes precedence over traffic for edge colour. */
export function edgeColor(anomaly: EdgeAnomalyState, traffic: TrafficClass): string {
  if (anomaly && anomaly !== 'none' && ANOMALY_COLOR[anomaly]) {
    return ANOMALY_COLOR[anomaly]!
  }
  return TRAFFIC_COLOR[traffic] || TRAFFIC_COLOR.unknown
}

/** 1–5px by utilization (0..1). */
export function edgeSize(utilization: number | null): number {
  if (utilization == null) return 1
  return 1 + Math.max(0, Math.min(1, utilization)) * 4
}

/** Dashed edges for stale / ghost links (consumed by the edge program). */
export function edgeIsDashed(anomaly: EdgeAnomalyState): boolean {
  return anomaly === 'stale' || anomaly === 'ghost'
}

// ── semantic zoom ───────────────────────────────────────────────────────────

export type ZoomTier = 0 | 1 | 2 // 0 far · 1 mid · 2 near

/** Sigma camera ratio (smaller = zoomed in) → discrete zoom tier. */
export function cameraRatioToZoomTier(ratio: number): ZoomTier {
  if (ratio > 1.6) return 0
  if (ratio > 0.7) return 1
  return 2
}

/**
 * Priority/zoom-aware label gate — uses `label_priority` + `min_zoom_level`
 * from the contract. Far out only priority-1 labels survive; near in all do.
 */
export function shouldShowLabel(
  labelPriority: number,
  minZoomLevel: number,
  tier: ZoomTier,
): boolean {
  if (minZoomLevel > tier) return false
  const maxPriority = tier === 0 ? 1 : tier === 1 ? 2 : 3
  return labelPriority <= maxPriority
}

export const criticalityRank: Record<Criticality, number> = {
  critical: 3,
  high: 2,
  normal: 1,
  low: 0,
}
