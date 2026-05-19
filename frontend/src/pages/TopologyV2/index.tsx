/**
 * Topology V2 — "Final Gold Release" 2D engine (Sigma.js + graphology).
 *
 * Parallel route `/topology-next`, feature-flagged; the classic
 * `/topology` page is untouched. Topology-first: a full-bleed WebGL
 * canvas with floating NOC-style control overlays — not a dashboard.
 *
 * Data: v2 contract only (`GET /topology/graph?v=2`), org/location scoped
 * server-side by RLS.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Segmented, Spin, Tag, Tooltip } from 'antd'
import {
  ReloadOutlined, FullscreenOutlined, AppstoreOutlined,
  ThunderboltOutlined, CloseOutlined,
} from '@ant-design/icons'
import { useQueryClient } from '@tanstack/react-query'
import { useTopologyGraphV2 } from './api'
import { buildTopologyModel } from './graphModel'
import { collapsedSetForTier, expandCluster, type ClusterTier } from './clustering'
import SigmaCanvas, { type SelectedNode } from './SigmaCanvas'
import type { ZoomTier } from './rendering'

const PANEL_BG = 'rgba(15, 23, 42, 0.92)'
const BORDER = '1px solid rgba(148, 163, 184, 0.18)'

const TIER_BY_ZOOM: Record<ZoomTier, ClusterTier> = {
  0: 'location',
  1: 'layer',
  2: 'device',
}

const LAYER_LEGEND: [string, string][] = [
  ['Core', '#3b82f6'], ['Distribution', '#06b6d4'], ['Access', '#22c55e'],
  ['Edge', '#a855f7'], ['Wireless', '#ec4899'],
]
const TRAFFIC_LEGEND: [string, string][] = [
  ['Idle', '#334155'], ['Normal', '#22c55e'], ['High', '#f59e0b'], ['Saturated', '#ef4444'],
]

export default function TopologyV2Page() {
  const { data, isLoading, isError, error, isFetching } = useTopologyGraphV2()
  const queryClient = useQueryClient()
  const rootRef = useRef<HTMLDivElement>(null)

  // Rebuild the graph model only when the graph actually changed (a no-op
  // 60s poll keeps the same model ⇒ no canvas remount). T3 swaps the poll
  // for realtime incremental patching.
  const model = useMemo(
    () => (data ? buildTopologyModel(data) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data?.graph_version, data?.stats?.total_nodes, data?.stats?.total_edges],
  )

  const [tier, setTier] = useState<ClusterTier>('layer')
  const [autoMode, setAutoMode] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<SelectedNode | null>(null)

  // Reset the cluster view whenever the model or tier changes.
  useEffect(() => {
    if (model) setCollapsed(collapsedSetForTier(model, tier))
  }, [model, tier])

  const handleExpandCluster = (clusterId: string) => {
    if (!model) return
    setAutoMode(false)
    setCollapsed((prev) => expandCluster(model, prev, clusterId))
  }

  const handleZoomTier = (zt: ZoomTier) => {
    if (autoMode) setTier(TIER_BY_ZOOM[zt])
  }

  const handleTier = (t: ClusterTier) => {
    setAutoMode(false)
    setTier(t)
  }

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['topology-graph-v2'] })
  const goFullscreen = () => rootRef.current?.requestFullscreen?.()

  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden',
        background: 'radial-gradient(ellipse at 50% 35%, #0b1424 0%, #060b16 70%, #03070f 100%)',
      }}
    >
      {/* ── WebGL canvas ─────────────────────────────────────────────── */}
      {model && (
        <SigmaCanvas
          key={model.graphVersion + ':' + model.deviceCount}
          model={model}
          collapsed={collapsed}
          onExpandCluster={handleExpandCluster}
          onSelectNode={setSelected}
          onZoomTier={handleZoomTier}
        />
      )}

      {/* ── loading / error ──────────────────────────────────────────── */}
      {isLoading && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <Spin size="large" tip="Topoloji yükleniyor…" />
        </div>
      )}
      {isError && (
        <div style={{ position: 'absolute', top: 80, left: '50%', transform: 'translateX(-50%)' }}>
          <Alert
            type="error" showIcon
            message="Topoloji yüklenemedi"
            description={(error as Error)?.message}
          />
        </div>
      )}

      {/* ── title / classic-view link ────────────────────────────────── */}
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
            Sigma WebGL · v2 contract{isFetching ? ' · senkronize ediliyor…' : ''}
          </div>
        </div>
        <Link to="/topology" style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8 }}>
          Klasik görünüm →
        </Link>
      </div>

      {/* ── control panel ────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute', top: 16, right: 16, padding: 12, width: 232,
        background: PANEL_BG, border: BORDER, borderRadius: 10,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600, letterSpacing: 0.4 }}>
          <AppstoreOutlined /> KÜMELEME
        </div>
        <Segmented
          size="small" block
          value={tier}
          onChange={(v) => handleTier(v as ClusterTier)}
          options={[
            { label: 'Lokasyon', value: 'location' },
            { label: 'Katman', value: 'layer' },
            { label: 'Rack', value: 'rack' },
            { label: 'Cihaz', value: 'device' },
          ]}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            size="small" type={autoMode ? 'primary' : 'default'}
            onClick={() => setAutoMode((m) => !m)}
          >
            Semantik zoom {autoMode ? 'açık' : 'kapalı'}
          </Button>
          <Tooltip title="Yenile">
            <Button size="small" icon={<ReloadOutlined />} onClick={refresh} />
          </Tooltip>
          <Tooltip title="Tam ekran (NOC)">
            <Button size="small" icon={<FullscreenOutlined />} onClick={goFullscreen} />
          </Tooltip>
        </div>
        {model && (
          <div style={{ color: '#64748b', fontSize: 11, lineHeight: 1.7 }}>
            <div>{model.deviceCount} cihaz · {model.ghostCount} ghost</div>
            <div>{model.clusters.size} küme · graph v{model.graphVersion}</div>
          </div>
        )}
      </div>

      {/* ── legend ───────────────────────────────────────────────────── */}
      <div style={{
        position: 'absolute', bottom: 16, left: 16, padding: 12,
        background: PANEL_BG, border: BORDER, borderRadius: 10,
        display: 'flex', gap: 20,
      }}>
        <Legend title="Katman" items={LAYER_LEGEND} />
        <Legend title="Trafik" items={TRAFFIC_LEGEND} />
      </div>

      {/* ── selected-node detail ─────────────────────────────────────── */}
      {selected && (
        <div style={{
          position: 'absolute', top: 16, right: 264, width: 250, padding: 14,
          background: PANEL_BG, border: BORDER, borderRadius: 10,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{selected.label}</span>
            <CloseOutlined
              style={{ color: '#64748b', cursor: 'pointer' }}
              onClick={() => setSelected(null)}
            />
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
