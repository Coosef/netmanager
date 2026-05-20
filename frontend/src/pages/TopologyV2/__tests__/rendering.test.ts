import { describe, it, expect } from 'vitest'
import {
  nodeColor, nodeSize, edgeColor, edgeSize, edgeIsDashed,
  clusterSize, cameraRatioToZoomTier, shouldShowLabel,
} from '../rendering'

describe('node rendering', () => {
  it('colours a device by layer when online', () => {
    expect(nodeColor({ kind: 'device', status: 'online', layer: 'core' })).toBe('#3b82f6')
    expect(nodeColor({ kind: 'device', status: 'online', layer: 'access' })).toBe('#22c55e')
  })

  it('a non-online status overrides the layer colour', () => {
    expect(nodeColor({ kind: 'device', status: 'offline', layer: 'core' })).toBe('#ef4444')
  })

  it('ghost nodes get the ghost colour', () => {
    expect(nodeColor({ kind: 'ghost', layer: 'core' })).not.toBe('#3b82f6')
  })

  it('node size scales with importance and stays compact', () => {
    expect(nodeSize(0)).toBeGreaterThanOrEqual(3)
    expect(nodeSize(1)).toBeLessThanOrEqual(12)
    expect(nodeSize(1)).toBeGreaterThan(nodeSize(0))
  })

  it('cluster size grows with the folded device count', () => {
    expect(clusterSize(64)).toBeGreaterThan(clusterSize(2))
  })
})

describe('edge rendering', () => {
  it('anomaly colour takes precedence over traffic class', () => {
    expect(edgeColor('asymmetric', 'normal')).toBe('#f97316')
    expect(edgeColor('none', 'saturated')).toBe('#ef4444')
  })

  it('stale and ghost links render dashed', () => {
    expect(edgeIsDashed('stale')).toBe(true)
    expect(edgeIsDashed('ghost')).toBe(true)
    expect(edgeIsDashed('none')).toBe(false)
  })

  it('edge size scales with utilization', () => {
    expect(edgeSize(null)).toBe(1)
    expect(edgeSize(1)).toBe(5)
  })
})

describe('semantic zoom', () => {
  it('maps the camera ratio to a discrete zoom tier', () => {
    expect(cameraRatioToZoomTier(2.5)).toBe(0) // far
    expect(cameraRatioToZoomTier(1.0)).toBe(1) // mid
    expect(cameraRatioToZoomTier(0.3)).toBe(2) // near
  })

  it('keeps only priority-1 labels when zoomed far out', () => {
    expect(shouldShowLabel(1, 0, 0)).toBe(true)
    expect(shouldShowLabel(2, 0, 0)).toBe(false)
    expect(shouldShowLabel(3, 0, 2)).toBe(true) // all labels near in
  })

  it('respects a node min_zoom_level', () => {
    // an edge/wireless node (min_zoom_level 2) stays unlabeled until tier 2
    expect(shouldShowLabel(1, 2, 0)).toBe(false)
    expect(shouldShowLabel(1, 2, 2)).toBe(true)
  })
})
