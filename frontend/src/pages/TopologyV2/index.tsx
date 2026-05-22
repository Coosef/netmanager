/**
 * Topology V2 — "Final Gold Release" — enterprise NOC console.
 *
 * Route `/topology-next`, feature-flagged; the classic `/topology` page
 * is untouched. Topology-first: a full-bleed WebGL canvas (2D Sigma /
 * 3D r3f) with minimal floating, collapsible chrome — built for a NOC
 * wall screen, not a dashboard.
 *
 * Data: v2 contract only (`GET /topology/graph?v=2`), org/location
 * scoped server-side by RLS. The graph is patched in place (T3); the 3D
 * engine (T4) and intelligence overlays (T5) share the same model.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Empty, Segmented, Spin, Tag, Tooltip, Badge } from 'antd'
import {
  ReloadOutlined, FullscreenOutlined, FullscreenExitOutlined,
  ThunderboltOutlined, CloseOutlined, WarningOutlined, DesktopOutlined,
  AimOutlined, SearchOutlined, ExportOutlined,
} from '@ant-design/icons'
import { useSite } from '@/contexts/SiteContext'
import { useTopologyGraphV2 } from './api'
import { buildTopologyModel, type TopologyModel } from './graphModel'
import { diffAndPatch, applyTopologyEvent, ingestStrategy, type TopologyEvent } from './patch'
import { useTopologyRealtime } from './realtime'
import { collapsedSetForTier, expandCluster, type ClusterTier } from './clustering'
import SigmaCanvas, { type SelectedNode, type TopologyCameraApi } from './SigmaCanvas'
import Topology3D from './three/Topology3D'
import type { LayoutMode } from './three/layout3d'
import type { CameraMode } from './three/CameraRig'
import type { ZoomTier } from './rendering'
import { deriveOverlayModel, OVERLAY_LAYERS, type OverlayLayer } from './overlays/overlayModel'
import { computeFocusSet } from './overlays/focus'
import type { OverlayContext } from './overlays/overlayStyle'
import { keyboardAction } from './noc/nocUi'
import { loadUiPrefs, saveUiPrefs } from './noc/uiPrefs'
import { scaleProfile } from './scaleConfig'
// T8.3.A — dev / perf measurement scaffolding. `parseStressParams` is
// pure + type-only; the heavier `loadStressGraph` (synthetic generator)
// and the `PerfOverlay` component are dynamic-imported below so neither
// the synthetic graph nor the overlay ships in the default production
// chunk. A user without `?stress=` or `?perf=1` downloads neither.
import { parseStressParams, type StressOptions } from './__perfdev__/stressLoader'
import type { TopologyGraphV2 } from './contract'

const REFETCH_DEBOUNCE_MS = 800

const TIER_BY_ZOOM: Record<ZoomTier, ClusterTier> = { 0: 'location', 1: 'layer', 2: 'device' }
const LAYER_LEGEND: [string, string][] = [
  ['Core', '#22d3c5'], ['Distribution', '#3b82f6'], ['Access', '#94a3b8'],
  ['AP / Wireless', '#22c55e'], ['Edge', '#f97316'],
  ['Down / Critical', '#ef4444'], ['Ghost', '#a855f7'],
]
const TRAFFIC_LEGEND: [string, string][] = [
  ['Normal', '#22c55e'], ['High', '#f97316'], ['Management', '#a855f7'],
  ['Suspicious', '#eab308'], ['Threat', '#ef4444'],
]
const LAYER_META: Record<OverlayLayer, { label: string; color: string }> = {
  anomalyHeat: { label: 'Anomali Isısı', color: '#f59e0b' },
  threats: { label: 'Tehdit', color: '#ef4444' },
  staleLinks: { label: 'Bayat Link', color: '#f59e0b' },
  asymmetric: { label: 'Asimetrik', color: '#f97316' },
  ghosts: { label: 'Ghost', color: '#52617a' },
  bottlenecks: { label: 'Darboğaz', color: '#ef4444' },
  suspicious: { label: 'Şüpheli Yol', color: '#dc2626' },
}
const HINT_DOT: Record<string, string> = {
  info: '#38bdf8', warning: '#f59e0b', critical: '#ef4444',
}

interface Engine { model: TopologyModel; locationId: number | null }

export default function TopologyV2Page() {
  const { activeLocationId } = useSite()

  // ── T8.3.A perf scaffolding ─────────────────────────────────────────────
  // Resolve `?stress=N&scenario=…&perf=1` once at mount. The flag also
  // drives a real-API short-circuit so the page never talks to the
  // backend while a benchmark is running.
  const stressOpts: StressOptions | null = useMemo(
    () => (typeof window !== 'undefined' ? parseStressParams(window.location.search) : null),
    [],
  )
  const [stressData, setStressData] = useState<TopologyGraphV2 | null>(null)
  const [PerfOverlayCmp, setPerfOverlayCmp] = useState<React.ComponentType | null>(null)

  // Real API hook — disabled when we're in stress mode so a benchmark
  // never accidentally pulls a real org's graph alongside the synthetic.
  const realQuery = useTopologyGraphV2()
  const data: TopologyGraphV2 | undefined = stressOpts ? (stressData ?? undefined) : realQuery.data
  const isLoading = stressOpts ? stressData == null : realQuery.isLoading
  const isError = stressOpts ? false : realQuery.isError
  const error = stressOpts ? null : realQuery.error
  const refetch = stressOpts ? (async () => undefined) : realQuery.refetch

  // Dynamic-load the synthetic generator + perf overlay only when active.
  useEffect(() => {
    if (typeof window === 'undefined') return
    // Synthetic graph
    if (stressOpts && !stressData) {
      void import('./__perfdev__/stressLoader').then(({ loadStressGraph }) =>
        loadStressGraph(stressOpts).then(setStressData),
      )
    }
    // Perf overlay — visible in DEV or with ?perf=1
    void import('./__perfdev__/PerfOverlay').then(({ isPerfMode, PerfOverlay }) => {
      if (isPerfMode(window.location.search)) {
        setPerfOverlayCmp(() => PerfOverlay)
      }
    })
  }, [stressOpts, stressData])

  const [engine, setEngine] = useState<Engine | null>(null)
  // engineRef mirrors `engine` for the T8.3.C testHandles useEffect below;
  // testHandles capture engineRef in their closures so they see the
  // current engine even though the install effect runs once per stress
  // mode activation.
  const [patchSignal, setPatchSignal] = useState(0)
  const [drift, setDrift] = useState<TopologyEvent | null>(null)
  const [overlayLayers, setOverlayLayers] = useState<Set<OverlayLayer>>(
    () => new Set(OVERLAY_LAYERS),
  )
  const expectedVersion = useRef(0)
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // T8.4 — camera controls for the left tool rail (filled by SigmaCanvas).
  const cameraApiRef = useRef<TopologyCameraApi | null>(null)

  const [tier, setTier] = useState<ClusterTier>('layer')
  const [autoMode, setAutoMode] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<SelectedNode | null>(null)
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d')
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('orbit')
  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit')

  // ── NOC console UI state ─────────────────────────────────────────────────
  const [fullscreen, setFullscreen] = useState(false)
  const [presentation, setPresentation] = useState(false)
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  // T8.4 NOC design — tool rail mode + hostname/IP search box.
  const [tool, setTool] = useState<'select' | 'pan'>('select')
  const [search, setSearch] = useState('')
  const [showGhost, setShowGhost] = useState(true)
  const [showWireless, setShowWireless] = useState(true)

  // ── persisted console prefs — load once, save on change ──────────────────
  useEffect(() => {
    const p = loadUiPrefs()
    if (p.viewMode) setViewMode(p.viewMode)
    if (p.layoutMode) setLayoutMode(p.layoutMode)
    if (p.overlayLayers?.length) {
      setOverlayLayers(new Set(p.overlayLayers as OverlayLayer[]))
    }
    setPrefsLoaded(true)
  }, [])
  useEffect(() => {
    if (!prefsLoaded) return
    saveUiPrefs({ viewMode, layoutMode, overlayLayers: [...overlayLayers] })
  }, [prefsLoaded, viewMode, layoutMode, overlayLayers])

  // ── T8.3.C perf test handles — engine ref (declared early; the install
  //    `useEffect` lives further down, after `handleEvent`, so the
  //    ws-patch-flood handle can route through the canonical realtime
  //    funnel without breaking the T8.2 §6.5 single-mutation-point
  //    invariant).
  const engineRef = useRef<Engine | null>(null)
  engineRef.current = engine   // mirror live engine into ref — matches the
                               // pattern at the keyboard-shortcuts block.

  // ── ingest contract data — build once per location, else patch in place ──
  useEffect(() => {
    if (!data) return
    setEngine((prev) => {
      const strategy = ingestStrategy(
        prev ? { locationId: prev.locationId, graphVersion: prev.model.graphVersion } : null,
        data, activeLocationId,
      )
      if (strategy === 'skip') return prev
      if (strategy === 'rebuild') {
        expectedVersion.current = data.graph_version
        setDrift(null)
        setPatchSignal(0)
        setSelected(null) // location switch — clear stale selection
        const model = buildTopologyModel(data)
        // T7 — open at a size-appropriate cluster tier so a large graph
        // never starts fully exploded.
        setTier(scaleProfile(model.deviceCount).defaultTier)
        setAutoMode(true)
        return { model, locationId: activeLocationId }
      }
      diffAndPatch(prev!.model, data)
      expectedVersion.current = data.graph_version
      setPatchSignal((v) => v + 1)
      return prev
    })
  }, [data, activeLocationId])

  // ── controlled, debounced refetch ────────────────────────────────────────
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current)
    refetchTimer.current = setTimeout(() => { void refetch() }, REFETCH_DEBOUNCE_MS)
  }, [refetch])
  useEffect(() => () => { if (refetchTimer.current) clearTimeout(refetchTimer.current) }, [])

  // ── realtime topology events ─────────────────────────────────────────────
  // T8.3.E1.b — rAF-aligned coalescing. The pre-E1 implementation
  // called `applyTopologyEvent` + bumped `patchSignal` synchronously per
  // event, so a 50 Hz burst at 10 k triggered ~250 React commits and
  // ~250 Sigma refreshes inside five seconds — saturating the main
  // thread. Now events queue into a ref-held buffer and a single
  // `requestAnimationFrame` callback drains the queue per frame: events
  // are still applied through the canonical `applyTopologyEvent` funnel
  // (T8.2 §6.5 invariant — `patch.ts` stays the single mutation point),
  // but only one `setPatchSignal` fires per frame, and the touched
  // node/edge ids are written to `patchTouchedRef` so the SigmaCanvas
  // patchSignal effect can do a partial refresh.
  const eventQueueRef = useRef<TopologyEvent[]>([])
  const flushRafRef = useRef<number | null>(null)
  // Touched-ids ledger for the SigmaCanvas patchSignal effect.
  // Mutated by the flush; consumed + cleared by the effect.
  const patchTouchedRef = useRef<{
    nodes: Set<string>
    edges: Set<string>
    structural: boolean
  }>({ nodes: new Set(), edges: new Set(), structural: false })
  const engineRefForEvents = useRef<Engine | null>(engine)
  engineRefForEvents.current = engine

  const flushEvents = useCallback(() => {
    flushRafRef.current = null
    const events = eventQueueRef.current
    if (events.length === 0) return
    eventQueueRef.current = []
    const eng = engineRefForEvents.current
    if (!eng) return
    let appliedCount = 0
    let driftEvent: TopologyEvent | null = null
    let needsRefetch = false
    const touched = patchTouchedRef.current
    for (const e of events) {
      const outcome = applyTopologyEvent(eng.model, e, expectedVersion.current)
      expectedVersion.current = outcome.version
      if (outcome.status === 'applied') {
        appliedCount++
        // Surface the touched element ids for the partial Sigma refresh.
        if (e.node_id) touched.nodes.add(e.node_id)
        if (e.edge_id) touched.edges.add(e.edge_id)
        if (e.node?.id) touched.nodes.add(e.node.id)
        if (e.edge?.id) touched.edges.add(e.edge.id)
        // Structural events change cluster.memberDeviceKeys → the
        // cluster view must be re-derived; pure attribute updates can
        // skip that O(N+E) walk.
        if (e.event_type === 'topology_node_added' ||
            e.event_type === 'topology_node_removed' ||
            e.event_type === 'topology_edge_added' ||
            e.event_type === 'topology_edge_removed') {
          touched.structural = true
        }
      } else if (outcome.status === 'drift') {
        driftEvent = e
      } else if (outcome.status === 'refetch') {
        needsRefetch = true
      }
    }
    if (driftEvent) setDrift(driftEvent)
    if (needsRefetch) scheduleRefetch()
    if (appliedCount > 0) setPatchSignal((v) => v + 1)
  }, [scheduleRefetch])

  const handleEvent = useCallback((event: TopologyEvent) => {
    eventQueueRef.current.push(event)
    if (flushRafRef.current === null) {
      flushRafRef.current = requestAnimationFrame(flushEvents)
    }
  }, [flushEvents])

  // Cancel any pending rAF on unmount so the closure doesn't fire on a
  // dead component.
  useEffect(() => () => {
    if (flushRafRef.current !== null) {
      cancelAnimationFrame(flushRafRef.current)
      flushRafRef.current = null
    }
  }, [])

  const { status: rtStatus } = useTopologyRealtime({
    enabled: !!engine,
    locationId: activeLocationId,
    onEvent: handleEvent,
    onReconnect: scheduleRefetch,
  })

  // ── T8.3.C testHandles install ───────────────────────────────────────────
  // `handleEvent` is captured via a ref so the install's `useEffect` can
  // depend on `[stressOpts]` only — handleEvent's useCallback identity
  // changes whenever `scheduleRefetch` changes, but the handle behavior
  // doesn't. Same dynamic-chunk isolation as PerfOverlay / stressLoader.
  const handleEventRef = useRef(handleEvent)
  handleEventRef.current = handleEvent
  // Mirror the live `collapsed` Set so test handles can snapshot the
  // current frontier — distinct from `listClusterIds`, which returns
  // every cluster including non-collapsed ones.
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed
  useEffect(() => {
    if (!stressOpts || typeof window === 'undefined') return
    let cancelled = false
    void import('./__perfdev__/testHandles').then(({ installTestHandles }) => {
      if (cancelled) return
      installTestHandles({
        setPresentation: (on) => setPresentation(on),
        setFullscreen: (on) => setFullscreen(on),
        setOverlayLayers: (layers) => setOverlayLayers(new Set(layers)),
        listClusterIds: () => {
          const e = engineRef.current
          return e ? Array.from(e.model.clusters.keys()) : []
        },
        getCollapsed: () => Array.from(collapsedRef.current),
        setCollapsed: (ids) => setCollapsed(new Set(ids)),
        expandCluster: (clusterId) => {
          const e = engineRef.current
          if (!e) return
          setCollapsed((prev) => expandCluster(e.model, prev, clusterId))
        },
        dispatchPatchBurst: async ({ count, intervalMs, targetDistinctNodes = 50 }) => {
          const e = engineRef.current
          const fn = handleEventRef.current
          const zero = {
            durationMs: 0, applied: 0, ignored_scope_mismatch: 0,
            stale: 0, refetch: 0, invalid_payload: 0, drift: 0,
          }
          if (!e) return zero

          // Round-robin a bounded set of device IDs so each event lands
          // on a real, non-cluster node (only `topology_node_updated`
          // events; status flips between online/offline). graphology
          // stores the kind under `nodeKind` (graphModel.ts:147) — NOT
          // `kind`, which is the contract-side field name.
          const ids: string[] = []
          e.model.graph.forEachNode((n, attrs) => {
            if (ids.length >= targetDistinctNodes) return
            if ((attrs as { nodeKind?: string }).nodeKind === 'device') ids.push(n)
          })
          if (ids.length === 0) return zero

          const start = performance.now()
          for (let i = 0; i < count; i++) {
            const nodeId = ids[i % ids.length]
            const event: TopologyEvent = {
              event_type: 'topology_node_updated',
              graph_version: expectedVersion.current + 1,
              node_id: nodeId,
              changes: { status: i % 2 === 0 ? 'offline' : 'online' },
            }
            fn(event)
            if (intervalMs > 0) {
              await new Promise<void>((r) => setTimeout(r, intervalMs))
            } else {
              await Promise.resolve()
            }
          }
          return {
            durationMs: performance.now() - start,
            applied: count,                  // approximation — handleEvent
            ignored_scope_mismatch: 0,        // doesn't echo per-event outcome
            stale: 0, refetch: 0, invalid_payload: 0, drift: 0,
          }
        },
      })
    })
    return () => {
      cancelled = true
      void import('./__perfdev__/testHandles').then(({ uninstallTestHandles }) => {
        uninstallTestHandles()
      })
    }
  }, [stressOpts])

  // ── cluster view ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (engine) setCollapsed(collapsedSetForTier(engine.model, tier))
  }, [engine, tier])

  const handleExpandCluster = (clusterId: string) => {
    if (!engine) return
    setAutoMode(false)
    setCollapsed((prev) => expandCluster(engine.model, prev, clusterId))
  }
  const handleZoomTier = (zt: ZoomTier) => { if (autoMode) setTier(TIER_BY_ZOOM[zt]) }
  const handleTier = (t: ClusterTier) => { setAutoMode(false); setTier(t) }

  // ── T5 overlays — a pure projection of the RLS-scoped model ──────────────
  const overlayModel = useMemo(
    () => (engine ? deriveOverlayModel(engine.model) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, patchSignal],
  )
  const focusSet = useMemo(
    () => (engine && selected && selected.kind !== 'cluster'
      ? computeFocusSet(engine.model, selected.id)
      : null),
    [engine, selected],
  )
  const overlay = useMemo<OverlayContext | undefined>(
    () => (overlayModel
      ? { model: overlayModel, layers: overlayLayers, focus: focusSet }
      : undefined),
    [overlayModel, overlayLayers, focusSet],
  )
  const toggleLayer = (layer: OverlayLayer) =>
    setOverlayLayers((prev) => {
      const next = new Set(prev)
      if (next.has(layer)) next.delete(layer)
      else next.add(layer)
      return next
    })

  // ── fullscreen — true browser Fullscreen API, ESC-aware ──────────────────
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void rootRef.current?.requestFullscreen?.()
  }, [])
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // ── keyboard shortcuts (F · 2 · 3 · C · O · I · Esc) ─────────────────────
  // (engineRef declared earlier alongside the T8.3.C testHandles block.)
  const overlayModelRef = useRef(overlayModel)
  overlayModelRef.current = overlayModel

  const jumpToIncident = useCallback(() => {
    const om = overlayModelRef.current
    const eng = engineRef.current
    if (!om || !eng) return
    let target: string | null = null
    for (const [id, f] of om.nodes) { if (f.threat) { target = id; break } }
    if (!target) for (const [id, f] of om.nodes) { if (f.heat) { target = id; break } }
    if (!target) return
    const attr = eng.model.graph.getNodeAttributes(target)
    setSelected({ id: target, kind: attr.nodeKind, label: attr.label, raw: attr.raw })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const action = keyboardAction(e.key)
      if (!action) return
      e.preventDefault()
      switch (action.kind) {
        case 'fullscreen': toggleFullscreen(); break
        case 'view': setViewMode(action.view); break
        case 'layout':
          setLayoutMode(action.layout)
          setViewMode((v) => (v === '2d' ? '3d' : v))
          break
        case 'incidentFocus': jumpToIncident(); break
        case 'clear': setSelected(null); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleFullscreen, jumpToIncident])

  const rtBadge = useMemo(() => {
    const map = { open: 'success', connecting: 'processing', closed: 'error' } as const
    return map[rtStatus]
  }, [rtStatus])

  const counts = overlayModel?.counts

  // ── T8.4 NOC design — derived figures + interactions ─────────────────────
  const [zoomPct, setZoomPct] = useState(100)

  // Header stat chips + bottom status-bar figures, from the RLS-scoped
  // model + overlay counts; memoised against patch ticks.
  const topoStats = useMemo(() => {
    let down = 0
    let unreach = 0
    if (engine) {
      engine.model.graph.forEachNode((_id, a) => {
        const at = a as { status?: string; nodeKind?: string }
        if (at.nodeKind === 'cluster') return
        if (at.status === 'offline') down++
        else if (at.status === 'unreachable') unreach++
      })
    }
    return {
      nodes: engine?.model.deviceCount ?? 0,
      links: engine ? engine.model.graph.size : 0,
      down,
      critical: counts?.threats ?? unreach,
      ghost: engine?.model.ghostCount ?? 0,
      anomalies: (counts?.threats ?? 0) + (counts?.bottlenecks ?? 0),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, patchSignal, counts])

  // Filter-bar toggles → SigmaCanvas node-hide hint.
  const filter = useMemo(
    () => ({ hideGhost: !showGhost, hideWireless: !showWireless }),
    [showGhost, showWireless],
  )

  // Hostname / IP search selects the first matching device node.
  const runSearch = useCallback((q: string) => {
    setSearch(q)
    const eng = engineRef.current
    if (!eng || !q.trim()) return
    const needle = q.trim().toLowerCase()
    let hit: string | null = null
    eng.model.graph.forEachNode((id, a) => {
      const at = a as { nodeKind?: string; label?: string; raw?: { data?: { ip?: string } } }
      if (hit || at.nodeKind === 'cluster') return
      const label = String(at.label ?? '').toLowerCase()
      const ip = String(at.raw?.data?.ip ?? '').toLowerCase()
      if (label.includes(needle) || ip.includes(needle)) hit = id
    })
    if (hit) {
      const a = eng.model.graph.getNodeAttributes(hit)
      setSelected({ id: hit, kind: a.nodeKind, label: a.label, raw: a.raw })
    }
  }, [])

  // Tool-rail / minimap zoom + fit through the Sigma camera api.
  const zoom = useCallback((dir: 'in' | 'out' | 'fit') => {
    const api = cameraApiRef.current
    if (!api) return
    if (dir === 'in') api.zoomIn()
    else if (dir === 'out') api.zoomOut()
    else api.reset()
    window.setTimeout(() => {
      const a = cameraApiRef.current
      if (a) setZoomPct(a.zoomPct())
    }, 230)
  }, [])

  // KEŞIF → export current topology stats as a JSON snapshot (no backend).
  const exportSnapshot = useCallback(() => {
    const eng = engineRef.current
    if (!eng) return
    const payload = {
      exported_at: new Date().toISOString(),
      graph_version: eng.model.graphVersion,
      stats: topoStats,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `topology-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [topoStats])

  const chrome = !presentation
  const node = selected

  return (
    <div
      ref={rootRef}
      className="nm-topo-root"
      style={{
        // Normal-flow definite height (the page-wrapper has no positioned
        // ancestor, so `inset:0` would collapse to content height). In
        // fullscreen the browser sizes the element to the screen.
        ...(fullscreen
          ? { position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 9999 }
          : { position: 'relative', height: 'calc(100vh - 104px)', minHeight: 480 }),
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: chrome ? 12 : 0,
        padding: chrome ? 16 : 0,
        borderRadius: chrome && !fullscreen ? 12 : 0,
        background: C.bg,
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        color: C.text,
      }}
    >
      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      {chrome && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...crumb, marginBottom: 6 }}>ENVANTER › TOPOLOJİ</div>
            <h1 style={{
              margin: 0, fontSize: 26, fontWeight: 500, letterSpacing: '-0.01em',
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', color: C.text,
            }}>
              Ağ Topolojisi
              <StatChip label="NODE" value={topoStats.nodes.toLocaleString()} />
              <StatChip label="LINK" value={topoStats.links.toLocaleString()} />
              {topoStats.down > 0 && <StatChip label="DOWN" value={topoStats.down} tone="red" />}
              {topoStats.critical > 0 && <StatChip label="CRITICAL" value={topoStats.critical} tone="orange" />}
              {topoStats.ghost > 0 && <StatChip label="GHOST" value={topoStats.ghost} tone="purple" />}
            </h1>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 6 }}>
              LLDP/CDP otomatik keşif · L2 anomali · Ghost node tespiti · Blast radius · AI katmanlı zekâ
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Segmented size="small" value={viewMode}
              onChange={(v) => setViewMode(v as '2d' | '3d')}
              options={[{ label: '2D', value: '2d' }, { label: '3D', value: '3d' }]} />
            <Tooltip title="Yeniden keşfet">
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()}>Keşfet</Button>
            </Tooltip>
            <Tooltip title="Sunum modu — NOC duvar ekranı">
              <Button size="small" type={presentation ? 'primary' : 'default'}
                icon={<DesktopOutlined />} onClick={() => setPresentation((p) => !p)} />
            </Tooltip>
            <Tooltip title="Tam ekran — F">
              <Button size="small"
                icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                onClick={toggleFullscreen}>
                {fullscreen ? 'Çık' : 'Tam Ekran'}
              </Button>
            </Tooltip>
          </div>
        </div>
      )}

      {/* ── FILTER BAR ─────────────────────────────────────────────────── */}
      {chrome && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
          padding: '8px 14px', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8,
        }}>
          <span style={crumb}>FİLTRELER</span>
          <FilterToggle on={showGhost} color={C.purple} label="👻 Ghost node"
            onClick={() => setShowGhost((v) => !v)} />
          <FilterToggle on={showWireless} color={C.green} label="📶 Wireless"
            onClick={() => setShowWireless((v) => !v)} />
          <Link to="/topology" style={{ fontSize: 11, color: C.sub, marginLeft: 4 }}>Klasik →</Link>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {LAYER_LEGEND.map(([label, color]) => (
              <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.sub, fontSize: 11 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: color }} />{label}
              </span>
            ))}
          </span>
        </div>
      )}

      {/* ── MAIN GRID: tool rail · canvas · right panel ────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: chrome ? '52px 1fr 272px' : '1fr',
        gap: chrome ? 12 : 0, flex: 1, minHeight: 0,
      }}>
        {/* LEFT TOOL RAIL */}
        {chrome && (
          <div style={{
            background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: 6, display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'flex-start',
          }}>
            <ToolBtn icon="↖" active={tool === 'select'} title="Seç" onClick={() => setTool('select')} />
            <ToolBtn icon="✋" active={tool === 'pan'} title="Kaydır" onClick={() => setTool('pan')} />
            <div style={{ height: 1, background: C.border, margin: '2px 4px' }} />
            <ToolBtn icon="⊕" title="Yakınlaştır" onClick={() => zoom('in')} />
            <ToolBtn icon="⊖" title="Uzaklaştır" onClick={() => zoom('out')} />
            <ToolBtn icon="⛶" title="Sığdır" onClick={() => zoom('fit')} />
            <div style={{ height: 1, background: C.border, margin: '2px 4px' }} />
            <ToolBtn icon={<AimOutlined />} title="Olaya odaklan — I" onClick={jumpToIncident} />
            <ToolBtn icon={<ReloadOutlined />} title="Yenile" onClick={() => void refetch()} />
          </div>
        )}

        {/* CENTER CANVAS */}
        <div style={{
          position: 'relative', minHeight: 0, borderRadius: chrome ? 10 : 0,
          overflow: 'hidden', border: chrome ? `1px solid ${C.border}` : 'none', background: C.bg,
        }}>
          {/* subtle grid + vignette */}
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.025) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }} />
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none',
            background: 'radial-gradient(ellipse 80% 60% at 50% 35%, rgba(34,211,197,0.05), transparent 70%)',
          }} />

          {engine && viewMode === '2d' && (
            <SigmaCanvas
              key={`2d:${engine.locationId}`}
              model={engine.model} collapsed={collapsed} patchSignal={patchSignal}
              patchTouched={patchTouchedRef.current}
              overlay={overlay} onExpandCluster={handleExpandCluster}
              onSelectNode={setSelected} onZoomTier={handleZoomTier}
              cameraApiRef={cameraApiRef} filter={filter}
            />
          )}
          {engine && viewMode === '3d' && (
            <Topology3D
              key={`3d:${engine.locationId}`}
              model={engine.model} collapsed={collapsed} patchSignal={patchSignal}
              mode={layoutMode} cameraMode={cameraMode} overlay={overlay}
              onSelectNode={setSelected} onExpandCluster={handleExpandCluster}
            />
          )}

          {isLoading && !engine && (
            <Centered><Spin size="large" tip="Topoloji yükleniyor…" /></Centered>
          )}
          {isError && (
            <Centered>
              <Alert type="error" showIcon message="Topoloji yüklenemedi"
                description={(error as Error)?.message}
                action={<Button size="small" onClick={() => void refetch()}>Yeniden dene</Button>} />
            </Centered>
          )}
          {engine && engine.model.deviceCount === 0 && !isLoading && (
            <Centered>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={<span style={{ color: C.sub }}>Bu kapsamda cihaz yok</span>} />
            </Centered>
          )}

          {/* drift banner */}
          {drift && chrome && (
            <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', maxWidth: 540 }}>
              <Alert type="warning" showIcon icon={<WarningOutlined />}
                message="Topoloji Drift — altın referanstan sapma"
                description={
                  <div style={{ fontSize: 12 }}>
                    <div>{String(drift.message ?? 'Topoloji yapısı altın referanstan farklılaştı')}</div>
                    <div style={{ color: C.sub, marginTop: 4 }}>graph v{drift.graph_version}</div>
                  </div>
                }
                action={<Button size="small" onClick={() => { setDrift(null); void refetch() }}>İncele</Button>}
                closable onClose={() => setDrift(null)} />
            </div>
          )}

          {/* zoom controls (design minimap position, bottom-left) */}
          {chrome && (
            <div style={{
              position: 'absolute', left: 14, bottom: 14,
              background: 'rgba(8,14,32,0.92)', border: `1px solid ${C.border}`, borderRadius: 6,
              padding: 6, display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <ToolBtn icon="＋" title="Yakınlaştır" small onClick={() => zoom('in')} />
              <ToolBtn icon="－" title="Uzaklaştır" small onClick={() => zoom('out')} />
              <ToolBtn icon="⛶" title="Sığdır" small onClick={() => zoom('fit')} />
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.sub, minWidth: 34, textAlign: 'right' }}>
                {zoomPct}%
              </span>
            </div>
          )}
        </div>

        {/* RIGHT PANEL */}
        {chrome && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', minHeight: 0 }}>
            {/* GÖRÜNÜM */}
            <NocCard title="GÖRÜNÜM">
              <div style={{ position: 'relative' }}>
                <span style={{ position: 'absolute', left: 10, top: 8, color: '#475569' }}>
                  <SearchOutlined style={{ fontSize: 12 }} />
                </span>
                <input value={search} onChange={(e) => runSearch(e.target.value)}
                  placeholder="Hostname veya IP ara…"
                  style={{
                    width: '100%', height: 30, background: C.bg, border: `1px solid ${C.border}`,
                    borderRadius: 6, color: C.text, fontSize: 11.5, padding: '0 10px 0 30px', outline: 'none',
                  }} />
              </div>
            </NocCard>

            {/* DİZİLİM — clustering tier + semantic zoom (+ 3D controls) */}
            <NocCard title="GÖRÜNÜM — DİZİLİM">
              {viewMode === '3d' && (
                <>
                  <Segmented size="small" block value={layoutMode}
                    onChange={(v) => setLayoutMode(v as LayoutMode)}
                    options={[{ label: 'Orbit', value: 'orbit' }, { label: 'Cluster', value: 'cluster' }]} />
                  <Segmented size="small" block value={cameraMode}
                    onChange={(v) => setCameraMode(v as CameraMode)}
                    options={[{ label: 'Sabit', value: 'orbit' }, { label: 'Veri Akışı', value: 'traverse' }]} />
                </>
              )}
              <div style={{ ...crumb, marginBottom: 2 }}>KÜMELEME</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {([['location', 'Lokasyon'], ['layer', 'Katman'], ['rack', 'Rack'], ['device', 'Cihaz']] as [ClusterTier, string][]).map(([id, label]) => (
                  <button key={id} onClick={() => handleTier(id)} style={tierBtn(tier === id)}>{label}</button>
                ))}
              </div>
              <button onClick={() => setAutoMode((m) => !m)} style={tierBtn(autoMode)}>
                Semantik zoom {autoMode ? 'açık' : 'kapalı'}
              </button>
            </NocCard>

            {/* KEŞIF */}
            <NocCard title="KEŞIF">
              <button onClick={() => void refetch()} style={discoverBtn}>
                <ReloadOutlined /> Tümünü Keşfet
              </button>
              <button onClick={jumpToIncident} style={{ ...secondaryBtn, color: C.orange, borderColor: 'rgba(249,115,22,0.4)' }}>
                <ThunderboltOutlined /> Anomaliye Odaklan
              </button>
              <button onClick={exportSnapshot} style={secondaryBtn}>
                <ExportOutlined /> JSON Dışa Aktar
              </button>
            </NocCard>

            {/* İSTİHBARAT — overlay layers + tactical hints */}
            <NocCard title="İSTİHBARAT">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {OVERLAY_LAYERS.map((layer) => {
                  const on = overlayLayers.has(layer)
                  const meta = LAYER_META[layer]
                  return (
                    <span key={layer} onClick={() => toggleLayer(layer)} style={{
                      cursor: 'pointer', fontSize: 10, padding: '2px 7px', borderRadius: 5,
                      border: `1px solid ${on ? meta.color : 'rgba(148,163,184,0.25)'}`,
                      color: on ? C.text : C.muted, background: on ? `${meta.color}22` : 'transparent',
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: 6, background: on ? meta.color : '#475569' }} />
                      {meta.label}
                    </span>
                  )
                })}
              </div>
              {overlayModel && overlayModel.hints.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {overlayModel.hints.map((h) => (
                    <div key={h.id}
                      onClick={() => h.layer && setOverlayLayers((p) => new Set(p).add(h.layer!))}
                      style={{ display: 'flex', gap: 7, alignItems: 'flex-start', marginBottom: 6, cursor: h.layer ? 'pointer' : 'default' }}>
                      <span style={{ width: 7, height: 7, borderRadius: 7, marginTop: 3, background: HINT_DOT[h.severity], flexShrink: 0 }} />
                      <span style={{ color: '#cbd5e1', fontSize: 11, lineHeight: 1.4 }}>{h.text}</span>
                    </div>
                  ))}
                </div>
              )}
              {focusSet && (
                <div style={{ color: C.teal, fontSize: 11 }}>
                  <AimOutlined /> Olay odağı: {focusSet.nodes.size} cihaz etkilenebilir
                </div>
              )}
            </NocCard>

            {/* AÇIKLAMA — legend */}
            <NocCard title="AÇIKLAMA">
              {LAYER_LEGEND.map(([label, color]) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0', fontSize: 12, color: C.text }}>
                  <span style={{ width: 11, height: 11, borderRadius: 2, background: color }} />{label}
                </div>
              ))}
              <div style={{ height: 1, background: C.border, margin: '10px 0' }} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 10.5, color: C.sub }}>
                {TRAFFIC_LEGEND.map(([label, color]) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
                    <span style={{ width: 18, height: 0, borderTop: `2px ${label === 'Normal' ? 'solid' : 'dashed'} ${color}` }} />
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </NocCard>
          </div>
        )}
      </div>

      {/* ── BOTTOM STATUS BAR ──────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 26, flexShrink: 0,
        padding: chrome ? '9px 18px' : '5px 14px',
        background: C.panel, border: `1px solid ${C.border}`, borderRadius: chrome ? 8 : 0,
        fontSize: 11.5,
      }}>
        <StatusFig label="Node" value={topoStats.nodes.toLocaleString()} color={C.teal} />
        <StatusFig label="Bağlantı" value={topoStats.links.toLocaleString()} color={C.teal} />
        <StatusFig label="Down" value={topoStats.down} color={C.red} />
        <StatusFig label="Critical" value={topoStats.critical} color={C.orange} />
        <StatusFig label="Ghost" value={topoStats.ghost} color={C.purple} />
        <StatusFig label="Anomali" value={topoStats.anomalies} color={C.yellow} />
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 18, color: C.sub }}>
          <span><Badge status={rtBadge} />{rtStatus === 'open' ? 'CANLI' : rtStatus.toUpperCase()}</span>
          {engine && <span>{engine.model.clusters.size} küme</span>}
          {engine && <span style={{ fontFamily: MONO }}>graph v{engine.model.graphVersion}</span>}
        </span>
      </div>

      {/* ── SELECTED NODE DETAIL (floating) ───────────────────────────── */}
      {node && (
        <div style={{
          position: 'absolute', right: chrome ? 296 : 16, top: chrome ? 96 : 16, width: 320, zIndex: 50,
          background: 'rgba(14,23,41,0.97)', border: `1px solid ${C.teal}`, borderRadius: 10, padding: 16,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)', backdropFilter: 'blur(20px)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: C.text, fontWeight: 600 }}>{node.label}</span>
            <CloseOutlined style={{ color: C.muted, cursor: 'pointer' }} onClick={() => setSelected(null)} />
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <Tag color={node.kind === 'ghost' ? 'default' : 'cyan'}>{node.kind}</Tag>
            {overlayModel?.nodes.get(node.id)?.threat && <Tag color="red">tehdit</Tag>}
          </div>
          <NodeDetail raw={node.raw} />
        </div>
      )}

      {/* T8.3.A — perf overlay, dynamic-loaded; visible in DEV or with ?perf=1 */}
      {PerfOverlayCmp && <PerfOverlayCmp />}
    </div>
  )
}

// ── NOC design tokens + presentational helpers (T8.4) ──────────────────────

const C = {
  bg: '#070b18', panel: '#0e1729', border: '#1c2538',
  text: '#d7e6f5', sub: '#94a3b8', muted: '#64748b',
  teal: '#22d3c5', blue: '#3b82f6', green: '#22c55e', orange: '#f97316',
  red: '#ef4444', yellow: '#eab308', purple: '#a855f7',
}
const MONO = "'IBM Plex Mono', ui-monospace, monospace"

const crumb: React.CSSProperties = {
  fontFamily: MONO, fontSize: 10, color: C.muted,
  letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 600,
}
const secondaryBtn: React.CSSProperties = {
  width: '100%', height: 30, fontSize: 11, marginBottom: 6,
  background: 'transparent', color: C.text, border: `1px solid ${C.border}`,
  borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center',
  justifyContent: 'center', gap: 8,
}
const discoverBtn: React.CSSProperties = {
  width: '100%', height: 34, fontSize: 12.5, marginBottom: 6,
  background: C.blue, color: '#fff', border: 'none', borderRadius: 6,
  cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center',
  justifyContent: 'center', gap: 8,
}
const tierBtn = (active: boolean): React.CSSProperties => ({
  height: 30, fontSize: 11.5, padding: 0, marginTop: 6,
  border: `1px solid ${active ? C.blue : C.border}`,
  background: active ? 'rgba(59,130,246,0.18)' : 'transparent',
  color: active ? '#60a5fa' : C.text, borderRadius: 6, cursor: 'pointer',
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
})

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
      {children}
    </div>
  )
}

function NocCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14 }}>
      <div style={{ ...crumb, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  )
}

function StatChip({ label, value, tone }: { label: string; value: string | number; tone?: 'red' | 'orange' | 'purple' }) {
  const map = {
    red: { bg: 'rgba(239,68,68,0.18)', fg: C.red },
    orange: { bg: 'rgba(249,115,22,0.18)', fg: C.orange },
    purple: { bg: 'rgba(168,85,247,0.18)', fg: C.purple },
  }
  const t = tone ? map[tone] : { bg: C.border, fg: C.sub }
  return (
    <span style={{
      fontFamily: MONO, fontSize: 10.5, padding: '2px 8px', borderRadius: 3,
      background: t.bg, color: t.fg, fontWeight: 600, letterSpacing: '0.06em',
    }}>{value} {label}</span>
  )
}

function StatusFig({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <span><span style={{ color: C.muted }}>{label} </span>
      <strong style={{ color, fontFamily: MONO }}>{value}</strong></span>
  )
}

function FilterToggle({ on, color, label, onClick }: { on: boolean; color: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      height: 26, fontSize: 11, padding: '0 10px', cursor: 'pointer', borderRadius: 6,
      background: on ? `${color}26` : 'transparent', color: on ? color : C.muted,
      border: `1px solid ${on ? `${color}66` : C.border}`,
    }}>{label}</button>
  )
}

function ToolBtn({ icon, active, title, onClick, small }: {
  icon: React.ReactNode; active?: boolean; title: string; onClick: () => void; small?: boolean
}) {
  const s = small ? 24 : 38
  return (
    <Tooltip title={title} placement="right">
      <button onClick={onClick} style={{
        width: s, height: s, borderRadius: 6, fontSize: small ? 12 : 14,
        border: `1px solid ${active ? C.blue : 'transparent'}`,
        background: active ? 'rgba(59,130,246,0.18)' : 'transparent',
        color: active ? '#60a5fa' : C.sub, cursor: 'pointer',
        display: 'grid', placeItems: 'center',
      }}>{icon}</button>
    </Tooltip>
  )
}

function NodeDetail({ raw }: { raw: unknown }) {
  const d = (raw as { data?: Record<string, unknown> } | undefined)?.data
  if (!d) return null
  const rows: [string, unknown][] = [
    ['IP', d.ip], ['Lokasyon', d.location], ['Katman', d.layer],
    ['Rack', d.rack], ['Rol', d.device_role], ['Üretici', d.vendor],
    ['Durum', d.status], ['Kritiklik', d.criticality],
  ]
  return (
    <div style={{ marginTop: 12, fontSize: 11.5, lineHeight: 1.9 }}>
      {rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: C.muted, fontFamily: MONO, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{k}</span>
          <span style={{ color: '#cbd5e1' }}>{String(v)}</span>
        </div>
      ))}
    </div>
  )
}
