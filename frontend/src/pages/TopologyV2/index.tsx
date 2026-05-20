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
  ReloadOutlined, FullscreenOutlined, FullscreenExitOutlined, AppstoreOutlined,
  ThunderboltOutlined, CloseOutlined, WarningOutlined, DesktopOutlined,
  DownOutlined, RightOutlined, AimOutlined,
} from '@ant-design/icons'
import { useSite } from '@/contexts/SiteContext'
import { useTopologyGraphV2 } from './api'
import { buildTopologyModel, type TopologyModel } from './graphModel'
import { diffAndPatch, applyTopologyEvent, ingestStrategy, type TopologyEvent } from './patch'
import { useTopologyRealtime } from './realtime'
import { collapsedSetForTier, expandCluster, type ClusterTier } from './clustering'
import SigmaCanvas, { type SelectedNode } from './SigmaCanvas'
import Topology3D from './three/Topology3D'
import type { LayoutMode } from './three/layout3d'
import type { CameraMode } from './three/CameraRig'
import type { ZoomTier } from './rendering'
import { deriveOverlayModel, OVERLAY_LAYERS, type OverlayLayer } from './overlays/overlayModel'
import { computeFocusSet } from './overlays/focus'
import type { OverlayContext } from './overlays/overlayStyle'
import {
  keyboardAction, isPanelVisible, isPanelExpanded, togglePanel, type PanelId,
} from './noc/nocUi'
import { loadUiPrefs, saveUiPrefs } from './noc/uiPrefs'
import { scaleProfile } from './scaleConfig'

const PANEL_BG = 'rgba(15, 23, 42, 0.92)'
const BORDER = '1px solid rgba(148, 163, 184, 0.18)'
const REFETCH_DEBOUNCE_MS = 800

const TIER_BY_ZOOM: Record<ZoomTier, ClusterTier> = { 0: 'location', 1: 'layer', 2: 'device' }
const LAYER_LEGEND: [string, string][] = [
  ['Core', '#3b82f6'], ['Distribution', '#06b6d4'], ['Access', '#22c55e'],
  ['Edge', '#a855f7'], ['Wireless', '#ec4899'],
]
const TRAFFIC_LEGEND: [string, string][] = [
  ['Idle', '#334155'], ['Normal', '#22c55e'], ['High', '#f59e0b'], ['Saturated', '#ef4444'],
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
  const { data, isLoading, isError, error, refetch } = useTopologyGraphV2()

  const [engine, setEngine] = useState<Engine | null>(null)
  const [patchSignal, setPatchSignal] = useState(0)
  const [drift, setDrift] = useState<TopologyEvent | null>(null)
  const [overlayLayers, setOverlayLayers] = useState<Set<OverlayLayer>>(
    () => new Set(OVERLAY_LAYERS),
  )
  const expectedVersion = useRef(0)
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

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
  const [collapsedPanels, setCollapsedPanels] = useState<Set<PanelId>>(new Set())
  const [prefsLoaded, setPrefsLoaded] = useState(false)

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
  const handleEvent = useCallback((event: TopologyEvent) => {
    setEngine((prev) => {
      if (!prev) return prev
      const outcome = applyTopologyEvent(prev.model, event, expectedVersion.current)
      expectedVersion.current = outcome.version
      if (outcome.status === 'applied') setPatchSignal((v) => v + 1)
      else if (outcome.status === 'drift') setDrift(event)
      else if (outcome.status === 'refetch') scheduleRefetch()
      return prev
    })
  }, [scheduleRefetch])

  const { status: rtStatus } = useTopologyRealtime({
    enabled: !!engine,
    locationId: activeLocationId,
    onEvent: handleEvent,
    onReconnect: scheduleRefetch,
  })

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
  const engineRef = useRef<Engine | null>(engine)
  engineRef.current = engine
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

  const panelCtx = { fullscreen, presentation, hasSelection: !!selected }
  const showControls = isPanelVisible('controls', panelCtx)
  const showIntel = isPanelVisible('intel', panelCtx)
  const showDetail = isPanelVisible('detail', panelCtx)
  const showLegend = isPanelVisible('legend', panelCtx)

  const counts = overlayModel?.counts

  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden',
        background: 'radial-gradient(ellipse at 50% 35%, #0b1424 0%, #060b16 70%, #03070f 100%)',
      }}
    >
      {/* ── WebGL canvas — dominates the viewport ──────────────────────── */}
      {engine && viewMode === '2d' && (
        <SigmaCanvas
          key={`2d:${engine.locationId}`}
          model={engine.model} collapsed={collapsed} patchSignal={patchSignal}
          overlay={overlay} onExpandCluster={handleExpandCluster}
          onSelectNode={setSelected} onZoomTier={handleZoomTier}
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

      {/* ── states: loading / error / empty ────────────────────────────── */}
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
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<span style={{ color: '#94a3b8' }}>Bu kapsamda cihaz yok</span>}
          />
        </Centered>
      )}

      {/* ── top bar — always-on minimal chrome ─────────────────────────── */}
      <div style={{
        position: 'absolute', top: 14, left: 14, right: 14, display: 'flex',
        justifyContent: 'space-between', alignItems: 'flex-start', pointerEvents: 'none',
      }}>
        <div style={{
          ...panelStyle, padding: presentation ? '6px 12px' : '8px 14px',
          display: 'flex', alignItems: 'center', gap: 12, pointerEvents: 'auto',
        }}>
          <ThunderboltOutlined style={{ color: '#38bdf8', fontSize: 18 }} />
          <div>
            <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 14, lineHeight: 1.1 }}>
              Topology · Gold NOC
            </div>
            <div style={{ color: '#64748b', fontSize: 11 }}>
              <Badge status={rtBadge} />
              {viewMode === '3d' ? '3D Tactical' : '2D Sigma'} · realtime{' '}
              {rtStatus === 'open' ? 'bağlı' : rtStatus}
            </div>
          </div>
          {!presentation && (
            <Link to="/topology" style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>
              Klasik →
            </Link>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, pointerEvents: 'auto' }}>
          <Segmented
            size="small" value={viewMode}
            onChange={(v) => setViewMode(v as '2d' | '3d')}
            options={[{ label: '2D', value: '2d' }, { label: '3D', value: '3d' }]}
          />
          <Tooltip title="Sunum modu (NOC duvar ekranı)">
            <Button size="small" type={presentation ? 'primary' : 'default'}
              icon={<DesktopOutlined />} onClick={() => setPresentation((p) => !p)} />
          </Tooltip>
          <Tooltip title="Tam ekran — F">
            <Button size="small"
              icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={toggleFullscreen} />
          </Tooltip>
        </div>
      </div>

      {/* ── drift detail banner ────────────────────────────────────────── */}
      {drift && !presentation && (
        <div style={{ position: 'absolute', top: 62, left: '50%', transform: 'translateX(-50%)', maxWidth: 540 }}>
          <Alert
            type="warning" showIcon icon={<WarningOutlined />}
            message="Topoloji Drift — altın referanstan sapma"
            description={
              <div style={{ fontSize: 12 }}>
                <div>{String(drift.message ?? 'Topoloji yapısı altın referanstan farklılaştı')}</div>
                <div style={{ color: '#94a3b8', marginTop: 4 }}>
                  graph v{drift.graph_version} · {String(drift.ts ?? '').slice(11, 19)}
                </div>
              </div>
            }
            action={<Button size="small" onClick={() => { setDrift(null); void refetch() }}>İncele</Button>}
            closable onClose={() => setDrift(null)}
          />
        </div>
      )}

      {/* ── controls panel ─────────────────────────────────────────────── */}
      {showControls && (
        <FloatingPanel
          style={{ top: 64, right: 14, width: 236 }}
          title="KONSOL" icon={<AppstoreOutlined />}
          expanded={isPanelExpanded('controls', collapsedPanels)}
          onToggle={() => setCollapsedPanels((p) => togglePanel(p, 'controls'))}
        >
          {viewMode === '3d' && (
            <>
              <Segmented size="small" block value={layoutMode}
                onChange={(v) => setLayoutMode(v as LayoutMode)}
                options={[
                  { label: 'Orbit', value: 'orbit' },
                  { label: 'Cluster', value: 'cluster' },
                ]} />
              <Segmented size="small" block value={cameraMode}
                onChange={(v) => setCameraMode(v as CameraMode)}
                options={[
                  { label: 'Sabit', value: 'orbit' },
                  { label: 'Veri Akışı', value: 'traverse' },
                ]} />
            </>
          )}
          <div style={labelStyle}>KÜMELEME</div>
          <Segmented size="small" block value={tier}
            onChange={(v) => handleTier(v as ClusterTier)}
            options={[
              { label: 'Lokasyon', value: 'location' },
              { label: 'Katman', value: 'layer' },
              { label: 'Rack', value: 'rack' },
              { label: 'Cihaz', value: 'device' },
            ]} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="small" type={autoMode ? 'primary' : 'default'}
              onClick={() => setAutoMode((m) => !m)}>
              Semantik zoom {autoMode ? 'açık' : 'kapalı'}
            </Button>
            <Tooltip title="Yenile">
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()} />
            </Tooltip>
          </div>
          {engine && (
            <div style={{ color: '#64748b', fontSize: 11, lineHeight: 1.7 }}>
              <div>{engine.model.deviceCount} cihaz · {engine.model.ghostCount} ghost</div>
              <div>{engine.model.clusters.size} küme · graph v{engine.model.graphVersion}</div>
            </div>
          )}
        </FloatingPanel>
      )}

      {/* ── intelligence panel (overlay layers + tactical hints) ───────── */}
      {showIntel && (
        <FloatingPanel
          style={{ bottom: 14, right: 14, width: 252 }}
          title="İSTİHBARAT" icon={<ThunderboltOutlined />}
          expanded={isPanelExpanded('intel', collapsedPanels)}
          onToggle={() => setCollapsedPanels((p) => togglePanel(p, 'intel'))}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {OVERLAY_LAYERS.map((layer) => {
              const on = overlayLayers.has(layer)
              const meta = LAYER_META[layer]
              return (
                <span key={layer} onClick={() => toggleLayer(layer)} style={{
                  cursor: 'pointer', fontSize: 10, padding: '2px 7px', borderRadius: 5,
                  border: `1px solid ${on ? meta.color : 'rgba(148,163,184,0.25)'}`,
                  color: on ? '#e2e8f0' : '#64748b',
                  background: on ? `${meta.color}22` : 'transparent',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: 6, background: on ? meta.color : '#475569' }} />
                  {meta.label}
                </span>
              )
            })}
          </div>
          {overlayModel && overlayModel.hints.length > 0 && (
            <div style={{ marginTop: 4 }}>
              {overlayModel.hints.map((h) => (
                <div key={h.id}
                  onClick={() => h.layer && setOverlayLayers((p) => new Set(p).add(h.layer!))}
                  style={{
                    display: 'flex', gap: 7, alignItems: 'flex-start', marginBottom: 6,
                    cursor: h.layer ? 'pointer' : 'default',
                  }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: 7, marginTop: 3,
                    background: HINT_DOT[h.severity], flexShrink: 0,
                  }} />
                  <span style={{ color: '#cbd5e1', fontSize: 11, lineHeight: 1.4 }}>{h.text}</span>
                </div>
              ))}
            </div>
          )}
          {focusSet && (
            <div style={{ color: '#38bdf8', fontSize: 11 }}>
              <AimOutlined /> Olay odağı: {focusSet.nodes.size} cihaz etkilenebilir
            </div>
          )}
        </FloatingPanel>
      )}

      {/* ── legend (auto-hidden in fullscreen / presentation) ──────────── */}
      {showLegend && (
        <div style={{ ...panelStyle, position: 'absolute', bottom: 14, left: 14, padding: 12, display: 'flex', gap: 20 }}>
          <Legend title="Katman" items={LAYER_LEGEND} />
          <Legend title="Trafik" items={TRAFFIC_LEGEND} />
        </div>
      )}

      {/* ── selected-node detail (contextual) ──────────────────────────── */}
      {showDetail && selected && (
        <div style={{ ...panelStyle, position: 'absolute', top: 64, left: 14, width: 250, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{selected.label}</span>
            <CloseOutlined style={{ color: '#64748b', cursor: 'pointer' }}
              onClick={() => setSelected(null)} />
          </div>
          <Tag color={selected.kind === 'ghost' ? 'default' : 'blue'} style={{ marginTop: 8 }}>
            {selected.kind}
          </Tag>
          {overlayModel?.nodes.get(selected.id)?.threat && (
            <Tag color="red" style={{ marginTop: 8 }}>tehdit</Tag>
          )}
          <NodeDetail raw={selected.raw} />
        </div>
      )}

      {/* ── NOC status strip — minimal, always-on (wall-screen ready) ──── */}
      <div style={{
        position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
        ...panelStyle, padding: '5px 14px', display: 'flex', gap: 16, alignItems: 'center',
        fontSize: 11, color: '#94a3b8',
      }}>
        <span><Badge status={rtBadge} />{rtStatus === 'open' ? 'CANLI' : rtStatus.toUpperCase()}</span>
        {engine && <span>{engine.model.deviceCount} cihaz</span>}
        {counts && counts.threats > 0 && (
          <span style={{ color: '#ef4444' }}>⬤ {counts.threats} tehdit</span>
        )}
        {counts && counts.bottlenecks > 0 && (
          <span style={{ color: '#f59e0b' }}>⬤ {counts.bottlenecks} darboğaz</span>
        )}
        {drift && <span style={{ color: '#f59e0b' }}>drift</span>}
      </div>
    </div>
  )
}

// ── presentational helpers ────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  background: PANEL_BG, border: BORDER, borderRadius: 10,
}
const labelStyle: React.CSSProperties = {
  color: '#94a3b8', fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
      {children}
    </div>
  )
}

function FloatingPanel({
  style, title, icon, expanded, onToggle, children,
}: {
  style: React.CSSProperties
  title: string
  icon: React.ReactNode
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div style={{ ...panelStyle, position: 'absolute', padding: 10, ...style }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: 'pointer', ...labelStyle,
        }}
      >
        <span>{icon} {title}</span>
        {expanded ? <DownOutlined /> : <RightOutlined />}
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 9 }}>
          {children}
        </div>
      )}
    </div>
  )
}

function Legend({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div>
      <div style={{ color: '#94a3b8', fontSize: 10, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      {items.map(([label, color]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <span style={{ width: 9, height: 9, borderRadius: 9, background: color }} />
          <span style={{ color: '#cbd5e1', fontSize: 10 }}>{label}</span>
        </div>
      ))}
    </div>
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
    <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.9 }}>
      {rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: '#64748b' }}>{k}</span>
          <span style={{ color: '#cbd5e1' }}>{String(v)}</span>
        </div>
      ))}
    </div>
  )
}
