/**
 * SigmaCanvas — the WebGL topology surface.
 *
 * Mounts a Sigma.js v3 renderer over a graphology model, runs the
 * ForceAtlas2 Web-Worker layout, applies the cluster view, drives
 * semantic zoom (camera ratio → zoom tier → label LOD) and the subtle
 * traffic animation.
 *
 * T3: the model is patched in place (see patch.ts) — `patchSignal`
 * bumps on every patch so the canvas re-applies the view and re-collects
 * hot edges WITHOUT remounting Sigma. A genuine remount happens only on
 * a location change (new model identity).
 */
import { useEffect, useRef } from 'react'
import Sigma from 'sigma'
import { styleGraph, type TopologyModel } from './graphModel'
import { applyClusterView } from './clustering'
import { createLayoutWorker, layoutDurationMs, positionClusterNodes } from './layout'
import { createTrafficAnimator, type TrafficAnimator } from './traffic'
import { cameraRatioToZoomTier, shouldShowLabel, type ZoomTier } from './rendering'

export interface SelectedNode {
  id: string
  kind: string
  label: string
  raw?: unknown
}

interface SigmaCanvasProps {
  model: TopologyModel
  collapsed: Set<string>
  /** Bumped by the page on every in-place patch (poll / realtime event). */
  patchSignal: number
  onExpandCluster: (clusterId: string) => void
  onSelectNode: (node: SelectedNode | null) => void
  onZoomTier?: (tier: ZoomTier) => void
}

export default function SigmaCanvas({
  model, collapsed, patchSignal, onExpandCluster, onSelectNode, onZoomTier,
}: SigmaCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sigmaRef = useRef<Sigma | null>(null)
  const trafficRef = useRef<TrafficAnimator | null>(null)
  const zoomTierRef = useRef<ZoomTier>(1)
  const hoveredRef = useRef<string | null>(null)

  // ── mount: Sigma + layout worker + traffic animator ───────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    styleGraph(model)
    applyClusterView(model, collapsed)

    const renderer = new Sigma(model.graph, containerRef.current, {
      renderLabels: true,
      labelColor: { color: '#cbd5e1' },
      labelSize: 11,
      labelWeight: '500',
      labelFont: 'Inter, system-ui, sans-serif',
      labelRenderedSizeThreshold: 6,
      defaultEdgeColor: '#475569',
      minCameraRatio: 0.04,
      maxCameraRatio: 4,
      zIndex: true,
      nodeReducer: (node, data) => {
        const attr = model.graph.getNodeAttributes(node)
        const tier = zoomTierRef.current
        const show =
          attr.nodeKind === 'cluster' ||
          node === hoveredRef.current ||
          shouldShowLabel(attr.labelPriority ?? 3, attr.minZoomLevel ?? 1, tier)
        return { ...data, label: show ? data.label : '' }
      },
    })
    sigmaRef.current = renderer
    trafficRef.current = createTrafficAnimator(renderer, model.graph)

    const camera = renderer.getCamera()
    const onCam = () => {
      const tier = cameraRatioToZoomTier(camera.ratio)
      if (tier !== zoomTierRef.current) {
        zoomTierRef.current = tier
        onZoomTier?.(tier)
        renderer.refresh()
      }
    }
    camera.on('updated', onCam)

    renderer.on('clickNode', ({ node }) => {
      const attr = model.graph.getNodeAttributes(node)
      if (attr.nodeKind === 'cluster') onExpandCluster(node)
      else onSelectNode({ id: node, kind: attr.nodeKind, label: attr.label, raw: attr.raw })
    })
    renderer.on('clickStage', () => onSelectNode(null))
    renderer.on('enterNode', ({ node }) => { hoveredRef.current = node; renderer.refresh() })
    renderer.on('leaveNode', () => { hoveredRef.current = null; renderer.refresh() })

    const layout = createLayoutWorker(model.graph)
    layout.start()
    const stopAt = window.setTimeout(() => {
      layout.stop()
      positionClusterNodes(model)
      renderer.refresh()
      trafficRef.current?.start()
    }, layoutDurationMs(model.graph.order))

    return () => {
      window.clearTimeout(stopAt)
      trafficRef.current?.stop()
      trafficRef.current = null
      layout.kill()
      camera.off('updated', onCam)
      renderer.kill()
      sigmaRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  // ── cluster view changes ──────────────────────────────────────────────────
  useEffect(() => {
    if (!sigmaRef.current) return
    applyClusterView(model, collapsed)
    positionClusterNodes(model)
    sigmaRef.current.refresh()
  }, [collapsed, model])

  // ── in-place patch (poll / realtime) — no remount ─────────────────────────
  useEffect(() => {
    if (!sigmaRef.current || patchSignal === 0) return
    // the graph was mutated in place by the patch engine; re-derive the
    // cluster view, re-collect hot edges and repaint.
    applyClusterView(model, collapsed)
    positionClusterNodes(model)
    trafficRef.current?.stop()
    trafficRef.current?.start()
    sigmaRef.current.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchSignal])

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, background: 'transparent' }}
    />
  )
}
