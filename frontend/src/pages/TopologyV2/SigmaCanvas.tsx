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
import { applyClusterView, applyClusterViewDelta } from './clustering'
import {
  createLayoutWorker, layoutDurationMs,
  positionClusterNodes, positionClusterNodesChunked,
} from './layout'
import { createTrafficAnimator, type TrafficAnimator } from './traffic'
import { cameraRatioToZoomTier, shouldShowLabel, type ZoomTier } from './rendering'
import {
  resolveNodeOverlay, resolveEdgeOverlay, NODE_TONE_COLOR, EDGE_TONE_COLOR,
  type OverlayContext,
} from './overlays/overlayStyle'
import { scaleProfile } from './scaleConfig'

export interface SelectedNode {
  id: string
  kind: string
  label: string
  raw?: unknown
}

/**
 * T8.3.E1 — touched-element ledger written by `index.tsx`'s
 * rAF-coalesced flush and read by this component's `patchSignal`
 * effect. The shared mutable container lets the effect issue a
 * partial Sigma refresh (only the touched buffers) and skip the
 * `applyClusterView` re-derivation when no structural event fired.
 *
 * Owned by the page; passed through by reference. After each
 * patchSignal bump the effect drains and clears the sets.
 */
export interface PatchTouchedLedger {
  nodes: Set<string>
  edges: Set<string>
  /** `true` when at least one of the flush's events was a
   *  node/edge add/remove — the cluster view must be re-derived. */
  structural: boolean
}

interface SigmaCanvasProps {
  model: TopologyModel
  collapsed: Set<string>
  /** Bumped by the page on every in-place patch (poll / realtime event). */
  patchSignal: number
  /** Optional touched-element ledger used by the partial-refresh path
   *  on patches (T8.3.E1). When absent, the patch effect falls back to
   *  a full refresh — same behaviour as pre-E1. */
  patchTouched?: PatchTouchedLedger
  /** Operational-intelligence overlay (T5) — applied in the reducers. */
  overlay?: OverlayContext
  onExpandCluster: (clusterId: string) => void
  onSelectNode: (node: SelectedNode | null) => void
  onZoomTier?: (tier: ZoomTier) => void
  /** T8.4 — the page's left tool rail drives zoom/fit through this ref.
   *  Populated on mount from the live Sigma camera; nulled on unmount.
   *  Read-only escape hatch — does not touch the render/patch paths. */
  cameraApiRef?: React.MutableRefObject<TopologyCameraApi | null>
  /** T8.4 — filter-bar toggles. Consulted in the node reducer (via a ref,
   *  so a toggle never remounts Sigma) to hide ghost / wireless nodes. */
  filter?: { hideGhost: boolean; hideWireless: boolean }
}

/** Imperative camera controls exposed to the page tool rail (T8.4). */
export interface TopologyCameraApi {
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  zoomPct: () => number
}

export default function SigmaCanvas({
  model, collapsed, patchSignal, patchTouched, overlay,
  onExpandCluster, onSelectNode, onZoomTier, cameraApiRef, filter,
}: SigmaCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sigmaRef = useRef<Sigma | null>(null)
  const trafficRef = useRef<TrafficAnimator | null>(null)
  const zoomTierRef = useRef<ZoomTier>(1)
  const hoveredRef = useRef<string | null>(null)
  // overlay consulted by the reducers — kept in a ref so a layer toggle
  // never remounts Sigma.
  const overlayRef = useRef<OverlayContext | undefined>(overlay)
  overlayRef.current = overlay

  // T8.4 — filter toggles consulted in the node reducer (ref-held so a
  // toggle refreshes rather than remounts Sigma).
  const filterRef = useRef(filter)
  filterRef.current = filter

  // ── mount: Sigma + layout worker + traffic animator ───────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    styleGraph(model)
    applyClusterView(model, collapsed)
    const profile = scaleProfile(model.deviceCount)

    const renderer = new Sigma(model.graph, containerRef.current, {
      renderLabels: true,
      labelColor: { color: '#cbd5e1' },
      labelSize: 11,
      labelWeight: '500',
      labelFont: 'Inter, system-ui, sans-serif',
      labelRenderedSizeThreshold: profile.labelThreshold,
      defaultEdgeColor: '#475569',
      minCameraRatio: 0.04,
      maxCameraRatio: 4,
      zIndex: true,
      nodeReducer: (node, data) => {
        const attr = model.graph.getNodeAttributes(node)
        // T8.4 filter-bar hide (ghost / wireless). Clusters always show.
        const flt = filterRef.current
        if (flt && attr.nodeKind !== 'cluster') {
          if (flt.hideGhost && attr.nodeKind === 'ghost') return { ...data, hidden: true }
          if (flt.hideWireless && String(attr.layer ?? '').toLowerCase() === 'wireless') {
            return { ...data, hidden: true }
          }
        }
        const tier = zoomTierRef.current
        const show =
          attr.nodeKind === 'cluster' ||
          node === hoveredRef.current ||
          shouldShowLabel(attr.labelPriority ?? 3, attr.minZoomLevel ?? 1, tier)
        const out: Record<string, unknown> = { ...data, label: show ? data.label : '' }
        const ov = overlayRef.current
        if (ov && attr.nodeKind !== 'cluster') {
          const res = resolveNodeOverlay(node, ov.model, ov.layers, ov.focus)
          if (res.tone === 'dim') {
            out.color = NODE_TONE_COLOR.dim
            out.zIndex = 0
            out.label = ''
          } else if (res.tone !== 'normal' && NODE_TONE_COLOR[res.tone]) {
            out.color = NODE_TONE_COLOR[res.tone]
            out.size = (data.size ?? 4) * (1 + res.emphasis * 0.45)
            out.zIndex = res.tone === 'threat' ? 3 : 2
          }
        }
        return out
      },
      edgeReducer: (edge, data) => {
        const ov = overlayRef.current
        if (!ov) return data
        const res = resolveEdgeOverlay(edge, ov.model, ov.layers, ov.focus)
        if (res.tone === 'dim') {
          return { ...data, color: EDGE_TONE_COLOR.dim, zIndex: 0 }
        }
        if (res.tone !== 'normal' && EDGE_TONE_COLOR[res.tone]) {
          return {
            ...data,
            color: EDGE_TONE_COLOR[res.tone],
            size: (data.size ?? 1) * (1 + res.emphasis * 0.8),
            zIndex: 2,
          }
        }
        return data
      },
    })
    sigmaRef.current = renderer
    trafficRef.current = createTrafficAnimator(renderer, model.graph, profile.trafficAnimationMaxHot)

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

    // T8.4 — expose zoom/fit to the page tool rail. Pure camera ops; no
    // graph mutation, no effect on the patch/refresh perf paths.
    if (cameraApiRef) {
      cameraApiRef.current = {
        zoomIn: () => { camera.animate({ ratio: camera.ratio / 1.4 }, { duration: 200 }) },
        zoomOut: () => { camera.animate({ ratio: camera.ratio * 1.4 }, { duration: 200 }) },
        reset: () => { camera.animatedReset({ duration: 300 }) },
        zoomPct: () => Math.round((1 / Math.max(camera.ratio, 1e-4)) * 100),
      }
    }

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
    // T8.3.E2.e (BASELINE_PROFILE B6) — the post-FA2 finalize used to
    // run `positionClusterNodes(model)` + a full `renderer.refresh()`
    // synchronously, producing a 10–15 s main-thread block at 10 k.
    // The chunked variant yields between time-budgeted batches of
    // clusters; the refresh is partial-graph (only the cluster nodes
    // we explicitly re-positioned — FA2 streamed device updates into
    // graphology continuously during its 9 s run, so Sigma already
    // holds fresh device-buffer state by the time we arrive here).
    let finalizeCancelled = false
    const stopAt = window.setTimeout(async () => {
      if (finalizeCancelled) return
      layout.stop()
      const writtenClusters: string[] = []
      await positionClusterNodesChunked(model, {
        isCancelled: () => finalizeCancelled,
        onWritten: (id) => writtenClusters.push(id),
      })
      if (finalizeCancelled || !sigmaRef.current) return
      // Partial refresh — only the cluster nodes we touched. Devices
      // were streamed through `Sigma`'s graphology subscription during
      // FA2 iteration, so their buffers are already current. Falling
      // back to a full refresh if the partialGraph hint is ignored
      // would still be correct, just costlier.
      renderer.refresh({ partialGraph: { nodes: writtenClusters } })
      trafficRef.current?.start()
    }, layoutDurationMs(model.graph.order))

    return () => {
      finalizeCancelled = true
      window.clearTimeout(stopAt)
      trafficRef.current?.stop()
      trafficRef.current = null
      layout.kill()
      camera.off('updated', onCam)
      if (cameraApiRef) cameraApiRef.current = null
      renderer.kill()
      sigmaRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  // ── cluster view changes ──────────────────────────────────────────────────
  //
  // T8.3.E2.b: prefer the delta path when only `collapsed` changed.
  // The first run after mount (or any time `model` identity changes —
  // e.g. a location swap) falls back to the full `applyClusterView`
  // because the graph state may not reflect a known `prev`. Subsequent
  // runs use `applyClusterViewDelta(prev, next)` so the work is
  // O(touched), not O(N+E). See T8.3.D §9 for the baseline numbers
  // this targets; the validation gradient lives in
  // `docs/TOPOLOGY_T8_3_BASELINE_PROFILE.md`.
  const lastClusterApplyRef = useRef<{
    model: TopologyModel | null
    collapsed: Set<string> | null
  }>({ model: null, collapsed: null })
  useEffect(() => {
    if (!sigmaRef.current) return
    const last = lastClusterApplyRef.current
    if (last.model !== model || last.collapsed === null) {
      // First run after mount, or `model` identity changed (location
      // swap). Graph state may not reflect any specific `prev` — start
      // fresh with the full path + full centroid sweep + full refresh.
      // The full path also sweeps any stale hidden meta-edges the
      // delta path may have accumulated (clustering.ts step 6).
      applyClusterView(model, collapsed)
      positionClusterNodes(model)
      sigmaRef.current.refresh()
    } else {
      // Delta path: only the cluster ids in `added = next \ prev` need
      // a fresh centroid (they just became visible). The clusters in
      // `removed` are now hidden; their centroid doesn't matter.
      const result = applyClusterViewDelta(model, last.collapsed, collapsed)
      const added = new Set<string>()
      for (const c of collapsed) if (!last.collapsed.has(c)) added.add(c)
      positionClusterNodes(model, { touched: added })
      // Partial Sigma refresh — only the buffers whose underlying
      // state changed. At 10 k this turns a ~2 s full re-index into a
      // sub-50 ms partial one.
      sigmaRef.current.refresh({
        partialGraph: {
          nodes: result.touchedNodeIds,
          edges: result.touchedEdgeIds,
        },
      })
    }
    lastClusterApplyRef.current = { model, collapsed }
  }, [collapsed, model])

  // ── overlay layer toggle / incident focus — repaint via the reducers ──────
  useEffect(() => {
    sigmaRef.current?.refresh()
  }, [overlay])

  // T8.4 — re-render when a filter-bar toggle (ghost / wireless) flips.
  useEffect(() => {
    sigmaRef.current?.refresh()
  }, [filter?.hideGhost, filter?.hideWireless])

  // ── in-place patch (poll / realtime) — no remount ─────────────────────────
  //
  // T8.3.E1.c — the patch effect now reads the `patchTouched` ledger
  // populated by the page's rAF-coalesced flush:
  //   * `structural === false` (only `topology_*_updated` events) →
  //     skip `applyClusterView` entirely. Pure attribute updates can't
  //     change cluster.memberDeviceKeys or the hidden state of any
  //     node; re-deriving the view would be wasted O(N+E) work.
  //   * `nodes` / `edges` → partial Sigma refresh — re-upload only the
  //     touched WebGL buffers instead of the full graph.
  // Falls back to the pre-E1 behaviour (full refresh + applyClusterView)
  // when `patchTouched` is absent or empty.
  useEffect(() => {
    if (!sigmaRef.current || patchSignal === 0) return
    const t = patchTouched
    const usePartial = t && (t.nodes.size > 0 || t.edges.size > 0) && !t.structural
    if (!usePartial) {
      // Fallback (no ledger, empty ledger, or structural events in
      // the flush) → re-derive the cluster view.
      applyClusterView(model, collapsed)
      positionClusterNodes(model)
    }
    if (usePartial) {
      // `skipIndexation: true` keeps Sigma's `needToProcess` flag from
      // flipping, so the next animation frame skips the O(N+E)
      // `process()` pass (extent computation + normalization matrix
      // rebuild). Safe here because the touched nodes / edges already
      // exist in `nodeProgramIndex` / `edgeProgramIndex` — we
      // intentionally only enter the partial branch when there are
      // no structural events in the flush. Pre-E1 the patch effect
      // called `refresh()` with no options, which forced the
      // `fullRefresh` branch (re-index of every node + edge) every
      // single time.
      sigmaRef.current.refresh({
        partialGraph: {
          nodes: Array.from(t!.nodes),
          edges: Array.from(t!.edges),
        },
        skipIndexation: true,
      })
    } else {
      sigmaRef.current.refresh()
    }
    // Capture touched-edge count BEFORE clearing so the traffic-
    // restart decision below can read it.
    const touchedEdgesInFlush = t?.edges.size ?? 0
    if (t) {
      t.nodes.clear()
      t.edges.clear()
      t.structural = false
    }
    // Traffic-animator restart is only needed when the set of hot
    // edges may have shifted: any edge attribute update OR a
    // structural event. Pure node-attribute updates (the
    // ws-patch-flood shape) leave the hot-edge set unchanged, so we
    // skip the ~5–10 ms `collect() + setInterval` re-arm cycle.
    const trafficNeedsRefresh = !t || t.structural || touchedEdgesInFlush > 0
    if (trafficNeedsRefresh) {
      trafficRef.current?.stop()
      trafficRef.current?.start()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchSignal])

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, background: 'transparent' }}
    />
  )
}
