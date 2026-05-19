/**
 * SigmaCanvas — the WebGL topology surface.
 *
 * Mounts a Sigma.js v3 renderer over a graphology model, runs the
 * ForceAtlas2 Web-Worker layout, applies the cluster view, and wires
 * semantic zoom (camera ratio → zoom tier → label LOD). Pure render
 * surface — cluster/selection state is owned by the page.
 */
import { useEffect, useRef } from 'react'
import Sigma from 'sigma'
import type { TopologyModel } from './graphModel'
import { applyClusterView } from './clustering'
import { createLayoutWorker, layoutDurationMs, positionClusterNodes } from './layout'
import {
  nodeColor, nodeSize, clusterColor, clusterSize,
  edgeColor, edgeSize, cameraRatioToZoomTier, shouldShowLabel, type ZoomTier,
} from './rendering'

export interface SelectedNode {
  id: string
  kind: string
  label: string
  raw?: unknown
}

interface SigmaCanvasProps {
  model: TopologyModel
  collapsed: Set<string>
  onExpandCluster: (clusterId: string) => void
  onSelectNode: (node: SelectedNode | null) => void
  onZoomTier?: (tier: ZoomTier) => void
}

/** One-time static styling of every node/edge attribute. */
function styleGraph(model: TopologyModel): void {
  const { graph } = model
  graph.forEachNode((key, attr) => {
    if (attr.nodeKind === 'cluster') {
      graph.mergeNodeAttributes(key, {
        color: clusterColor(attr.clusterType),
        size: clusterSize(attr.collapsedCount || 1),
        label: `${attr.label} · ${attr.collapsedCount}`,
      })
    } else {
      graph.mergeNodeAttributes(key, {
        color: nodeColor({ kind: attr.nodeKind, status: attr.status, layer: attr.layer }),
        size: nodeSize(attr.importanceScore || 0.3),
        label: attr.label,
      })
    }
  })
  graph.forEachEdge((key, attr) => {
    if (attr.edgeKind === 'meta') return
    graph.mergeEdgeAttributes(key, {
      color: edgeColor(attr.anomalyState, attr.trafficClass),
      size: edgeSize(attr.utilization ?? null),
    })
  })
}

export default function SigmaCanvas({
  model, collapsed, onExpandCluster, onSelectNode, onZoomTier,
}: SigmaCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sigmaRef = useRef<Sigma | null>(null)
  const zoomTierRef = useRef<ZoomTier>(1)
  const hoveredRef = useRef<string | null>(null)

  // ── mount: Sigma + layout worker ──────────────────────────────────────────
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
      // Priority/zoom-aware labels — uses the contract's label_priority +
      // min_zoom_level so a dense graph never drowns in text.
      nodeReducer: (node, data) => {
        const attr = model.graph.getNodeAttributes(node)
        const tier = zoomTierRef.current
        const show =
          attr.nodeKind === 'cluster' ||
          node === hoveredRef.current ||
          shouldShowLabel(attr.labelPriority ?? 3, attr.minZoomLevel ?? 1, tier)
        return { ...data, label: show ? data.label : '' }
      },
      edgeReducer: (edge, data) => {
        const attr = model.graph.getEdgeAttributes(edge)
        // Fade contract links when their cluster meta-edge is carrying them.
        if (attr.edgeKind === 'meta') return { ...data, zIndex: 0 }
        return data
      },
    })
    sigmaRef.current = renderer

    // semantic zoom — camera ratio drives the discrete zoom tier
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
      if (attr.nodeKind === 'cluster') {
        onExpandCluster(node)
      } else {
        onSelectNode({ id: node, kind: attr.nodeKind, label: attr.label, raw: attr.raw })
      }
    })
    renderer.on('clickStage', () => onSelectNode(null))
    renderer.on('enterNode', ({ node }) => { hoveredRef.current = node; renderer.refresh() })
    renderer.on('leaveNode', () => { hoveredRef.current = null; renderer.refresh() })

    // worker layout — runs off the main thread, frozen once settled
    const layout = createLayoutWorker(model.graph)
    layout.start()
    const stopAt = window.setTimeout(() => {
      layout.stop()
      positionClusterNodes(model)
      renderer.refresh()
    }, layoutDurationMs(model.graph.order))

    return () => {
      window.clearTimeout(stopAt)
      layout.kill()
      camera.off('updated', onCam)
      renderer.kill()
      sigmaRef.current = null
    }
    // model identity changes ⇒ full remount (new dataset)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  // ── cluster view changes ──────────────────────────────────────────────────
  useEffect(() => {
    if (!sigmaRef.current) return
    applyClusterView(model, collapsed)
    positionClusterNodes(model)
    sigmaRef.current.refresh()
  }, [collapsed, model])

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, background: 'transparent' }}
    />
  )
}
