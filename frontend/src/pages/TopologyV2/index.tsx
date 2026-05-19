/**
 * Topology V2 — "Final Gold Release" 2D engine (Sigma.js + graphology).
 *
 * Parallel route `/topology-next`, feature-flagged; the classic
 * `/topology` page is untouched. Topology-first: a full-bleed WebGL
 * canvas with floating NOC-style control overlays.
 *
 * T3 — realtime: the graph model is built once per location and then
 * patched IN PLACE (poll diff + `topology_*` events); Sigma never
 * remounts except on a location change. graph_version reconciliation
 * drops stale events and triggers a controlled refetch on a gap.
 *
 * Data: v2 contract only (`GET /topology/graph?v=2`), org/location scoped
 * server-side by RLS.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Segmented, Spin, Tag, Tooltip, Badge } from 'antd'
import {
  ReloadOutlined, FullscreenOutlined, AppstoreOutlined,
  ThunderboltOutlined, CloseOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useSite } from '@/contexts/SiteContext'
import { useTopologyGraphV2 } from './api'
import { buildTopologyModel, type TopologyModel } from './graphModel'
import { diffAndPatch, applyTopologyEvent, ingestStrategy, type TopologyEvent } from './patch'
import { useTopologyRealtime } from './realtime'
import { collapsedSetForTier, expandCluster, type ClusterTier } from './clustering'
import SigmaCanvas, { type SelectedNode } from './SigmaCanvas'
import type { ZoomTier } from './rendering'

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

interface Engine { model: TopologyModel; locationId: number | null }

export default function TopologyV2Page() {
  const { activeLocationId } = useSite()
  const { data, isLoading, isError, error, refetch } = useTopologyGraphV2()

  const [engine, setEngine] = useState<Engine | null>(null)
  const [patchSignal, setPatchSignal] = useState(0)
  const [drift, setDrift] = useState(false)
  const expectedVersion = useRef(0)
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const [tier, setTier] = useState<ClusterTier>('layer')
  const [autoMode, setAutoMode] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<SelectedNode | null>(null)

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
        // first load, or the active location changed — clean reset
        expectedVersion.current = data.graph_version
        setDrift(false)
        setPatchSignal(0)
        return { model: buildTopologyModel(data), locationId: activeLocationId }
      }
      // 'patch' — same location, newer version: diff in place, no remount
      diffAndPatch(prev!.model, data)
      expectedVersion.current = data.graph_version
      setPatchSignal((v) => v + 1)
      return prev
    })
  }, [data, activeLocationId])

  // ── controlled, debounced refetch (gap / bulk event / reconnect) ─────────
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
      else if (outcome.status === 'drift') setDrift(true)
      else if (outcome.status === 'refetch') scheduleRefetch()
      // 'stale' → ignored
      return prev
    })
  }, [scheduleRefetch])

  const { status: rtStatus } = useTopologyRealtime({
    enabled: !!engine,
    locationId: activeLocationId,
    onEvent: handleEvent,
    onReconnect: scheduleRefetch, // missed events ⇒ resync by graph_version
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
  const goFullscreen = () => rootRef.current?.requestFullscreen?.()

  const rtBadge = useMemo(() => {
    const map = { open: 'success', connecting: 'processing', closed: 'default' } as const
    return map[rtStatus]
  }, [rtStatus])

  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden',
        background: 'radial-gradient(ellipse at 50% 35%, #0b1424 0%, #060b16 70%, #03070f 100%)',
      }}
    >
      {engine && (
        <SigmaCanvas
          key={`loc:${engine.locationId}`}
          model={engine.model}
          collapsed={collapsed}
          patchSignal={patchSignal}
          onExpandCluster={handleExpandCluster}
          onSelectNode={setSelected}
          onZoomTier={handleZoomTier}
        />
      )}

      {isLoading && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <Spin size="large" tip="Topoloji yükleniyor…" />
        </div>
      )}
      {isError && (
        <div style={{ position: 'absolute', top: 80, left: '50%', transform: 'translateX(-50%)' }}>
          <Alert type="error" showIcon message="Topoloji yüklenemedi"
            description={(error as Error)?.message} />
        </div>
      )}

      {/* drift banner */}
      {drift && (
        <div style={{ position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)' }}>
          <Alert
            type="warning" showIcon icon={<WarningOutlined />}
            message="Topoloji drift tespit edildi — altın referanstan sapma"
            action={<Button size="small" onClick={() => { setDrift(false); void refetch() }}>Yenile</Button>}
            closable onClose={() => setDrift(false)}
          />
        </div>
      )}

      {/* title / classic-view link */}
      <div style={{
        position: 'absolute', top: 16, left: 16, padding: '8px 14px',
        background: PANEL_BG, border: BORDER, borderRadius: 10,
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <ThunderboltOutlined style={{ color: '#38bdf8', fontSize: 18 }} />
        <div>
          <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 14, lineHeight: 1.1 }}>
            Topology · Gold Engine
          </div>
          <div style={{ color: '#64748b', fontSize: 11 }}>
            <Badge status={rtBadge} />
            Sigma WebGL · v2 · realtime {rtStatus === 'open' ? 'bağlı' : rtStatus}
          </div>
        </div>
        <Link to="/topology" style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8 }}>
          Klasik görünüm →
        </Link>
      </div>

      {/* control panel */}
      <div style={{
        position: 'absolute', top: 16, right: 16, padding: 12, width: 232,
        background: PANEL_BG, border: BORDER, borderRadius: 10,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600, letterSpacing: 0.4 }}>
          <AppstoreOutlined /> KÜMELEME
        </div>
        <Segmented
          size="small" block value={tier}
          onChange={(v) => handleTier(v as ClusterTier)}
          options={[
            { label: 'Lokasyon', value: 'location' },
            { label: 'Katman', value: 'layer' },
            { label: 'Rack', value: 'rack' },
            { label: 'Cihaz', value: 'device' },
          ]}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button size="small" type={autoMode ? 'primary' : 'default'}
            onClick={() => setAutoMode((m) => !m)}>
            Semantik zoom {autoMode ? 'açık' : 'kapalı'}
          </Button>
          <Tooltip title="Yenile">
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()} />
          </Tooltip>
          <Tooltip title="Tam ekran (NOC)">
            <Button size="small" icon={<FullscreenOutlined />} onClick={goFullscreen} />
          </Tooltip>
        </div>
        {engine && (
          <div style={{ color: '#64748b', fontSize: 11, lineHeight: 1.7 }}>
            <div>{engine.model.deviceCount} cihaz · {engine.model.ghostCount} ghost</div>
            <div>{engine.model.clusters.size} küme · graph v{engine.model.graphVersion}</div>
          </div>
        )}
      </div>

      {/* legend */}
      <div style={{
        position: 'absolute', bottom: 16, left: 16, padding: 12,
        background: PANEL_BG, border: BORDER, borderRadius: 10, display: 'flex', gap: 20,
      }}>
        <Legend title="Katman" items={LAYER_LEGEND} />
        <Legend title="Trafik" items={TRAFFIC_LEGEND} />
      </div>

      {/* selected-node detail */}
      {selected && (
        <div style={{
          position: 'absolute', top: 16, right: 264, width: 250, padding: 14,
          background: PANEL_BG, border: BORDER, borderRadius: 10,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{selected.label}</span>
            <CloseOutlined style={{ color: '#64748b', cursor: 'pointer' }}
              onClick={() => setSelected(null)} />
          </div>
          <Tag color={selected.kind === 'ghost' ? 'default' : 'blue'} style={{ marginTop: 8 }}>
            {selected.kind}
          </Tag>
          <NodeDetail raw={selected.raw} />
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
