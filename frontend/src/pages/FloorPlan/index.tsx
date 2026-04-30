import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App, Button, Drawer, Empty, Input, Popconfirm, Select, Space,
  Tooltip, Upload, Tag, Spin,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, EditOutlined,
  HddOutlined, AppstoreOutlined, UnorderedListOutlined,
  SearchOutlined, SaveOutlined, FolderOpenOutlined,
  UploadOutlined, CloseOutlined, ZoomInOutlined,
  ZoomOutOutlined, FullscreenOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import { racksApi } from '@/api/racks'
import type { Device } from '@/types'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'

// ── Canvas constants ──────────────────────────────────────────────────────────
const CANVAS_W = 1400
const CANVAS_H = 900
const MIN_ZOOM = 0.1
const MAX_ZOOM = 6

// ── Vendor / status palette ───────────────────────────────────────────────────
const VENDOR_COLORS: Record<string, string> = {
  cisco: '#1d6fa4', aruba: '#ff8300', ruijie: '#e4002b',
  fortinet: '#ee3124', other: '#64748b',
}
const STATUS_COLORS: Record<string, string> = {
  online: '#22c55e', offline: '#ef4444', unknown: '#f59e0b', unreachable: '#f97316',
}

// ── Storage types ─────────────────────────────────────────────────────────────
const FP_KEY = 'nm-floorplans-v2'

interface FpNode {
  id: string
  deviceId: number
  hostname: string
  ip_address: string
  vendor: string
  status: string
  x: number   // % of CANVAS_W
  y: number   // % of CANVAS_H
}
interface FpRackNode {
  id: string
  rackName: string
  x: number
  y: number
}
interface FpEdge { id: string; from: string; to: string }
interface FloorPlan {
  id: string
  name: string
  imageDataUrl: string | null
  nodes: FpNode[]
  rackNodes: FpRackNode[]
  edges: FpEdge[]
}
type FpStore = Record<string, FloorPlan>

function loadStore(): FpStore {
  try { const s = localStorage.getItem(FP_KEY); return s ? JSON.parse(s) : {} }
  catch { return {} }
}
function saveStore(st: FpStore) {
  try { localStorage.setItem(FP_KEY, JSON.stringify(st)) } catch {}
}

// ── Coord helpers ─────────────────────────────────────────────────────────────
function screenToCanvas(
  sx: number, sy: number,
  rect: DOMRect,
  pan: { x: number; y: number },
  zoom: number,
) {
  return { x: (sx - rect.left - pan.x) / zoom, y: (sy - rect.top - pan.y) / zoom }
}
function clampPct(v: number, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)) }

// ── Canvas component ──────────────────────────────────────────────────────────
interface CanvasProps {
  plan: FloorPlan
  mode: 'place' | 'connect' | 'erase'
  isDark: boolean
  onUpdate: (p: FloorPlan) => void
  onClickRack: (rackName: string) => void
  liveStatus?: Record<number, string>
}

function FloorCanvas({ plan, mode, isDark, onUpdate, onClickRack, liveStatus }: CanvasProps) {
  const [zoom, setZoom] = useState(0.7)
  const [pan, setPan] = useState({ x: 20, y: 20 })
  const [connecting, setConnecting] = useState<string | null>(null)

  const draggingNode = useRef<{
    id: string; nodeType: 'device' | 'rack'
    startCX: number; startCY: number
    origX: number; origY: number
  } | null>(null)
  const panning = useRef<{ startX: number; startY: number; origPX: number; origPY: number } | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  const textShadow = isDark ? '0 1px 4px rgba(0,0,0,0.9)' : '0 1px 3px rgba(0,0,0,0.35)'
  const labelBg    = isDark ? 'rgba(3,12,30,0.78)' : 'rgba(255,255,255,0.88)'

  // ── Zoom controls ──────────────────────────────────────────────────────────
  const applyZoom = useCallback((factor: number, cx?: number, cy?: number) => {
    const rect = viewportRef.current?.getBoundingClientRect()
    const mx = cx ?? (rect ? rect.width / 2 : 300)
    const my = cy ?? (rect ? rect.height / 2 : 200)
    setZoom(z => {
      const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * factor))
      setPan(p => ({
        x: mx - (mx - p.x) * (nz / z),
        y: my - (my - p.y) * (nz / z),
      }))
      return nz
    })
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = viewportRef.current!.getBoundingClientRect()
    applyZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top)
  }, [applyZoom])

  const fitToView = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) return
    const zw = rect.width / CANVAS_W
    const zh = rect.height / CANVAS_H
    const nz = Math.min(zw, zh) * 0.95
    setZoom(nz)
    setPan({ x: (rect.width - CANVAS_W * nz) / 2, y: (rect.height - CANVAS_H * nz) / 2 })
  }, [])

  // ── Viewport-level mouse events ────────────────────────────────────────────
  const handleViewportMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-fp-node]')) return
    if (mode === 'place' && e.button === 0) {
      panning.current = { startX: e.clientX, startY: e.clientY, origPX: pan.x, origPY: pan.y }
    }
  }, [pan, mode])

  const handleViewportMouseMove = useCallback((e: React.MouseEvent) => {
    if (draggingNode.current) {
      const rect = viewportRef.current!.getBoundingClientRect()
      const { x: cx, y: cy } = screenToCanvas(e.clientX, e.clientY, rect, pan, zoom)
      const dx = ((cx - draggingNode.current.startCX) / CANVAS_W) * 100
      const dy = ((cy - draggingNode.current.startCY) / CANVAS_H) * 100
      const nx = clampPct(draggingNode.current.origX + dx, 0.5, 99)
      const ny = clampPct(draggingNode.current.origY + dy, 0.5, 97)
      if (draggingNode.current.nodeType === 'device') {
        onUpdate({ ...plan, nodes: plan.nodes.map(n => n.id === draggingNode.current!.id ? { ...n, x: nx, y: ny } : n) })
      } else {
        onUpdate({ ...plan, rackNodes: plan.rackNodes.map(r => r.id === draggingNode.current!.id ? { ...r, x: nx, y: ny } : r) })
      }
      return
    }
    if (panning.current) {
      setPan({
        x: panning.current.origPX + (e.clientX - panning.current.startX),
        y: panning.current.origPY + (e.clientY - panning.current.startY),
      })
    }
  }, [pan, zoom, plan, onUpdate])

  const handleViewportMouseUp = useCallback(() => {
    draggingNode.current = null
    panning.current = null
  }, [])

  // ── Drop from sidebar ──────────────────────────────────────────────────────
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const rect = viewportRef.current!.getBoundingClientRect()
    const { x: cx, y: cy } = screenToCanvas(e.clientX, e.clientY, rect, pan, zoom)
    const x = clampPct((cx / CANVAS_W) * 100, 1, 98)
    const y = clampPct((cy / CANVAS_H) * 100, 1, 96)

    const devData = e.dataTransfer.getData('application/fp-device')
    if (devData) {
      const d: Device = JSON.parse(devData)
      if (plan.nodes.some(n => n.deviceId === d.id)) return
      onUpdate({ ...plan, nodes: [...plan.nodes, { id: `fn${Date.now()}`, deviceId: d.id, hostname: d.hostname, ip_address: d.ip_address, vendor: d.vendor, status: d.status, x, y }] })
      return
    }
    const rackData = e.dataTransfer.getData('application/fp-rack')
    if (rackData) {
      const rackName: string = JSON.parse(rackData)
      if (plan.rackNodes.some(r => r.rackName === rackName)) return
      onUpdate({ ...plan, rackNodes: [...plan.rackNodes, { id: `fr${Date.now()}`, rackName, x, y }] })
    }
  }, [pan, zoom, plan, onUpdate])

  // ── Node interactions ──────────────────────────────────────────────────────
  const startNodeDrag = useCallback((e: React.MouseEvent, id: string, nodeType: 'device' | 'rack', origX: number, origY: number) => {
    e.stopPropagation()
    if (mode !== 'place') return
    const rect = viewportRef.current!.getBoundingClientRect()
    const { x, y } = screenToCanvas(e.clientX, e.clientY, rect, pan, zoom)
    draggingNode.current = { id, nodeType, startCX: x, startCY: y, origX, origY }
  }, [mode, pan, zoom])

  const handleNodeClick = useCallback((e: React.MouseEvent, id: string, nodeType: 'device' | 'rack', rackName?: string) => {
    e.stopPropagation()
    if (mode === 'erase') {
      if (nodeType === 'device')
        onUpdate({ ...plan, nodes: plan.nodes.filter(n => n.id !== id), edges: plan.edges.filter(ed => ed.from !== id && ed.to !== id) })
      else
        onUpdate({ ...plan, rackNodes: plan.rackNodes.filter(r => r.id !== id), edges: plan.edges.filter(ed => ed.from !== id && ed.to !== id) })
      return
    }
    if (mode === 'connect') {
      if (!connecting) { setConnecting(id); return }
      if (connecting !== id) {
        const dup = plan.edges.some(ed => (ed.from === connecting && ed.to === id) || (ed.from === id && ed.to === connecting))
        if (!dup) onUpdate({ ...plan, edges: [...plan.edges, { id: `fe${Date.now()}`, from: connecting, to: id }] })
      }
      setConnecting(null)
      return
    }
    if (nodeType === 'rack' && rackName) onClickRack(rackName)
  }, [mode, connecting, plan, onUpdate, onClickRack])

  const handleEdgeClick = useCallback((edgeId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (mode === 'erase') onUpdate({ ...plan, edges: plan.edges.filter(ed => ed.id !== edgeId) })
  }, [mode, plan, onUpdate])

  // ── Render ─────────────────────────────────────────────────────────────────
  const allNodes = useMemo(() => {
    const map: Record<string, { x: number; y: number }> = {}
    plan.nodes.forEach(n => { map[n.id] = { x: (n.x / 100) * CANVAS_W, y: (n.y / 100) * CANVAS_H } })
    plan.rackNodes.forEach(r => { map[r.id] = { x: (r.x / 100) * CANVAS_W, y: (r.y / 100) * CANVAS_H } })
    return map
  }, [plan])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* ── Zoom controls ───────────────────────────────────────────────── */}
      <div style={{ position: 'absolute', bottom: 16, right: 16, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Button size="small" icon={<ZoomInOutlined />} onClick={() => applyZoom(1.25)} />
        <Button size="small" icon={<ZoomOutOutlined />} onClick={() => applyZoom(1 / 1.25)} />
        <Button size="small" icon={<FullscreenOutlined />} onClick={fitToView} />
      </div>

      {/* ── Zoom indicator ──────────────────────────────────────────────── */}
      <div style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 20, fontSize: 11, fontWeight: 600,
        color: isDark ? '#64748b' : '#94a3b8', background: isDark ? 'rgba(15,23,42,0.8)' : 'rgba(255,255,255,0.8)',
        padding: '3px 8px', borderRadius: 6 }}>
        {Math.round(zoom * 100)}%
      </div>

      {/* ── Connect hint ────────────────────────────────────────────────── */}
      {mode === 'connect' && connecting && (
        <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
          background: '#22c55e', color: 'white', padding: '6px 16px', borderRadius: 20,
          fontSize: 12, fontWeight: 600, pointerEvents: 'none', zIndex: 20, whiteSpace: 'nowrap',
          boxShadow: '0 2px 12px rgba(34,197,94,0.5)' }}>
          🔗 {[...plan.nodes, ...plan.rackNodes].find(n => n.id === connecting && 'hostname' in n)
              ? (plan.nodes.find(n => n.id === connecting)?.hostname ?? '')
              : (plan.rackNodes.find(r => r.id === connecting)?.rackName ?? '')} → Hedefe tıkla
        </div>
      )}

      {/* ── Viewport ────────────────────────────────────────────────────── */}
      <div
        ref={viewportRef}
        onWheel={handleWheel}
        onMouseDown={handleViewportMouseDown}
        onMouseMove={handleViewportMouseMove}
        onMouseUp={handleViewportMouseUp}
        onMouseLeave={handleViewportMouseUp}
        onDrop={handleDrop}
        onDragOver={e => e.preventDefault()}
        style={{ width: '100%', height: '100%', overflow: 'hidden',
          cursor: panning.current ? 'grabbing' : mode === 'erase' ? 'crosshair' : mode === 'connect' ? 'cell' : 'grab' }}
      >
        {/* ── Inner canvas (transformed) ────────────────────────────── */}
        <div style={{
          position: 'absolute', width: CANVAS_W, height: CANVAS_H,
          transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
        }}>
          {/* Background image */}
          {plan.imageDataUrl ? (
            <img
              src={plan.imageDataUrl}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none', userSelect: 'none' }}
              alt=""
              draggable={false}
            />
          ) : (
            <div style={{
              position: 'absolute', inset: 0,
              background: isDark ? '#0f1a2e' : '#e8edf3',
              backgroundImage: 'linear-gradient(rgba(148,163,184,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.15) 1px, transparent 1px)',
              backgroundSize: '50px 50px',
            }} />
          )}

          {/* SVG edges */}
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            {plan.edges.map(edge => {
              const f = allNodes[edge.from], t = allNodes[edge.to]
              if (!f || !t) return null
              const mx = (f.x + t.x) / 2, my = (f.y + t.y) / 2
              return (
                <g key={edge.id} style={{ pointerEvents: 'all', cursor: mode === 'erase' ? 'pointer' : 'default' }}
                  onClick={ev => handleEdgeClick(edge.id, ev as any)}>
                  <line x1={f.x} y1={f.y} x2={t.x} y2={t.y}
                    stroke={mode === 'erase' ? '#ef4444' : '#3b82f6'}
                    strokeWidth={2.5} strokeDasharray="8 5" opacity={0.85} />
                  <line x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke="transparent" strokeWidth={14} />
                  <text x={mx} y={my - 6} textAnchor="middle" fontSize={10}
                    fill={isDark ? '#e2e8f0' : '#1e293b'} fontFamily="monospace"
                    style={{ textShadow }} />
                </g>
              )
            })}
          </svg>

          {/* Device nodes */}
          {plan.nodes.map(node => {
            const px = (node.x / 100) * CANVAS_W
            const py = (node.y / 100) * CANVAS_H
            const vc = VENDOR_COLORS[node.vendor] || VENDOR_COLORS.other
            const effStatus = liveStatus?.[node.deviceId] ?? node.status
            const sc = STATUS_COLORS[effStatus] || '#f59e0b'
            const sel = connecting === node.id
            const era = mode === 'erase'
            const border = sel ? '#22c55e' : era ? '#ef4444' : vc
            const ring   = sel ? '0 0 0 4px rgba(34,197,94,0.35)' : era ? '0 0 0 4px rgba(239,68,68,0.35)' : 'none'
            return (
              <div key={node.id}
                data-fp-node="1"
                onMouseDown={e => startNodeDrag(e, node.id, 'device', node.x, node.y)}
                onClick={e => handleNodeClick(e, node.id, 'device')}
                style={{ position: 'absolute', left: px, top: py, transform: 'translate(-50%,-50%)',
                  userSelect: 'none', cursor: mode === 'erase' ? 'pointer' : 'grab' }}
              >
                <div style={{ width: 34, height: 34, background: 'white', border: `2.5px solid ${border}`,
                  borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: `0 2px 8px rgba(0,0,0,0.25), ${ring}`, position: 'relative' }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: sc,
                    boxShadow: effStatus === 'online' ? `0 0 5px ${sc}` : 'none' }} />
                  <div style={{ position: 'absolute', bottom: -1, right: -1, width: 10, height: 10,
                    borderRadius: '50%', background: vc, border: '2px solid white' }} />
                </div>
                <div style={{ position: 'absolute', top: -20, left: '50%', transform: 'translateX(-50%)',
                  whiteSpace: 'nowrap', fontSize: 11, fontWeight: 700, color: isDark ? '#e2e8f0' : '#1e293b',
                  background: labelBg, padding: '1px 6px', borderRadius: 4, textShadow }}>
                  {node.hostname}
                </div>
              </div>
            )
          })}

          {/* Rack nodes */}
          {plan.rackNodes.map(rn => {
            const px = (rn.x / 100) * CANVAS_W
            const py = (rn.y / 100) * CANVAS_H
            const sel = connecting === rn.id
            const era = mode === 'erase'
            const border = sel ? '#22c55e' : era ? '#ef4444' : '#7c3aed'
            const ring   = sel ? '0 0 0 4px rgba(34,197,94,0.35)' : era ? '0 0 0 4px rgba(239,68,68,0.35)' : 'none'
            return (
              <div key={rn.id}
                data-fp-node="1"
                onMouseDown={e => startNodeDrag(e, rn.id, 'rack', rn.x, rn.y)}
                onClick={e => handleNodeClick(e, rn.id, 'rack', rn.rackName)}
                style={{ position: 'absolute', left: px, top: py, transform: 'translate(-50%,-50%)',
                  userSelect: 'none', cursor: mode === 'erase' ? 'pointer' : mode === 'place' ? 'pointer' : 'grab' }}
              >
                <div style={{ width: 36, height: 42, background: '#7c3aed18', border: `2.5px solid ${border}`,
                  borderRadius: 6, display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', gap: 3, padding: '4px 5px',
                  boxShadow: `0 2px 10px rgba(0,0,0,0.25), ${ring}` }}>
                  {[0, 1, 2, 3].map(i => (
                    <div key={i} style={{ width: 24, height: 5, background: border, borderRadius: 2, opacity: 0.9 - i * 0.15 }} />
                  ))}
                </div>
                <div style={{ position: 'absolute', top: -20, left: '50%', transform: 'translateX(-50%)',
                  whiteSpace: 'nowrap', fontSize: 11, fontWeight: 700, color: isDark ? '#e2e8f0' : '#1e293b',
                  background: labelBg, padding: '1px 6px', borderRadius: 4, textShadow }}>
                  {rn.rackName}
                </div>
              </div>
            )
          })}

          {/* Empty state */}
          {!plan.imageDataUrl && plan.nodes.length === 0 && plan.rackNodes.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 10, pointerEvents: 'none' }}>
              <div style={{ fontSize: 64, opacity: 0.15 }}>🏢</div>
              <div style={{ fontSize: 14, color: isDark ? '#334155' : '#94a3b8', fontWeight: 500 }}>
                Görsel yükleyin, cihaz/kabini sürükleyin
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Rack detail panel ─────────────────────────────────────────────────────────
function RackDetailPanel({ rackName, isDark, onClose }: {
  rackName: string; isDark: boolean; onClose: () => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['fp-rack-detail', rackName],
    queryFn: () => racksApi.get(rackName),
    enabled: !!rackName,
  })
  const C = {
    bg:     isDark ? '#1e293b' : '#ffffff',
    bg2:    isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
  }
  const usedU = data ? data.devices.reduce((s, d) => s + (d.rack_height || 1), 0) + data.items.reduce((s, i) => s + i.unit_height, 0) : 0
  const fillPct = data ? Math.min(100, Math.round((usedU / data.total_u) * 100)) : 0
  const fillColor = fillPct > 80 ? '#ef4444' : fillPct > 60 ? '#f59e0b' : '#22c55e'

  const STATUS_HEX: Record<string, string> = { online: '#22c55e', offline: '#ef4444', unknown: '#f59e0b', unreachable: '#f97316' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg }}>
      {/* Header */}
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>📦</span>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Kabin: {rackName}
          </div>
        </div>
        <Button size="small" icon={<CloseOutlined />} onClick={onClose} />
      </div>

      {isLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
          <Spin />
        </div>
      )}

      {data && (
        <>
          {/* Stats row */}
          <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}` }}>
            {[
              { l: 'TOPLAM', v: `${data.total_u}U`, c: '#64748b' },
              { l: 'CİHAZ', v: data.devices.length, c: '#3b82f6' },
              { l: 'ÖĞE', v: data.items.length, c: '#7c3aed' },
            ].map(s => (
              <div key={s.l} style={{ flex: 1, padding: '10px 6px', textAlign: 'center', borderRight: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: s.c }}>{s.v}</div>
                <div style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>{s.l}</div>
              </div>
            ))}
          </div>

          {/* Capacity bar */}
          <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: C.muted }}>Doluluk</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: fillColor }}>{fillPct}% · {usedU}/{data.total_u}U</span>
            </div>
            <div style={{ height: 6, background: isDark ? '#0f172a' : '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${fillPct}%`, height: '100%', background: `linear-gradient(90deg,${fillColor}88,${fillColor})`, borderRadius: 3, transition: 'width 0.3s' }} />
            </div>
          </div>

          {/* Physical U-slot rack diagram (compact) */}
          <div style={{ padding: '10px 16px 6px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Fiziksel Düzen
            </div>
            <div style={{ background: isDark ? '#0a0f18' : '#d1d9e6', borderRadius: 6, padding: '6px 8px',
              border: `2px solid ${isDark ? '#1e2a3a' : '#94a3b8'}`, overflow: 'hidden', maxHeight: 280, overflowY: 'auto' }}>
              {Array.from({ length: data.total_u }, (_, i) => {
                const unit = i + 1
                const device = data.devices.find(d => d.rack_unit === unit)
                const item   = data.items.find(it => it.unit_start === unit)
                const isCont = data.devices.some(d => d.rack_unit < unit && d.rack_unit + (d.rack_height || 1) > unit)
                            || data.items.some(it => it.unit_start < unit && it.unit_start + it.unit_height > unit)
                if (isCont) return null
                const h = device ? (device.rack_height || 1) : item ? item.unit_height : 1
                const vc  = device ? (VENDOR_COLORS[device.vendor] || VENDOR_COLORS.other) : '#7c3aed'
                const sc  = device ? (STATUS_HEX[device.status] || '#f59e0b') : undefined
                const isEmpty = !device && !item
                return (
                  <div key={unit} style={{
                    display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2,
                    height: h * 18, minHeight: h * 18,
                    background: isEmpty ? (isDark ? '#0b0f18' : '#e8edf5') : (isDark ? vc + '22' : vc + '18'),
                    border: `1px solid ${isEmpty ? (isDark ? '#0a0f1a' : '#c8d5e3') : vc + '55'}`,
                    borderRadius: 3, padding: '0 5px',
                  }}>
                    <span style={{ fontSize: 8, color: isDark ? '#334155' : '#94a3b8', fontFamily: 'monospace', width: 18, flexShrink: 0 }}>
                      {unit}U
                    </span>
                    {device && (
                      <>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: sc, flexShrink: 0, boxShadow: device.status === 'online' ? `0 0 4px ${sc}` : 'none' }} />
                        <span style={{ fontSize: 9, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', flex: 1 }}>
                          {device.hostname}
                        </span>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: vc, flexShrink: 0 }} />
                      </>
                    )}
                    {item && (
                      <span style={{ fontSize: 9, color: '#7c3aed', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', flex: 1 }}>
                        {item.label} ({item.item_type})
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Device list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              CİHAZLAR
            </div>
            {data.devices.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '16px 0', color: C.muted, fontSize: 12 }}>
                Bu kabinde cihaz yok
              </div>
            ) : (
              data.devices.map(d => {
                const vc = VENDOR_COLORS[d.vendor] || VENDOR_COLORS.other
                const sc = STATUS_HEX[d.status] || '#f59e0b'
                return (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px',
                    borderRadius: 7, marginBottom: 4, border: `1px solid ${C.border}`, background: C.bg2 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: vc, flexShrink: 0 }} />
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontWeight: 600, fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                        {d.hostname}
                      </div>
                      <div style={{ fontSize: 10, color: C.muted }}>{d.ip_address} · U{d.rack_unit}</div>
                    </div>
                    <Tag style={{ fontSize: 9, padding: '0 5px', color: sc, borderColor: sc + '55', background: sc + '18', margin: 0 }}>
                      {d.status}
                    </Tag>
                  </div>
                )
              })
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FloorPlanPage() {
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const { message } = App.useApp()

  const [store, setStore] = useState<FpStore>(() => loadStore())
  const wsRef = useRef<WebSocket | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [liveStatus, setLiveStatus] = useState<Record<number, string>>({})
  const [activeId, setActiveId] = useState<string | null>(() => Object.keys(loadStore())[0] ?? null)
  const [mode, setMode] = useState<'place' | 'connect' | 'erase'>('place')
  const [layoutDrawerOpen, setLayoutDrawerOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [deviceSearch, setDeviceSearch] = useState('')
  const [sidebarTab, setSidebarTab] = useState<'devices' | 'racks'>('devices')
  const [gridView, setGridView] = useState(false)
  const [selectedRack, setSelectedRack] = useState<string | null>(null)

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = window.location.hostname
    const port = (import.meta as any).env?.DEV ? '8000' : window.location.port
    const token = localStorage.getItem('token')
    const url = `${proto}://${host}:${port}/api/v1/ws/events${token ? `?token=${token}` : ''}`
    const connect = () => {
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onopen = () => setWsConnected(true)
      ws.onclose = () => { setWsConnected(false); setTimeout(connect, 5000) }
      ws.onerror = () => ws.close()
      ws.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data as string)
          if ((evt.event_type === 'device_offline' || evt.event_type === 'device_online') && evt.device_id) {
            setLiveStatus((prev) => ({ ...prev, [evt.device_id as number]: evt.event_type === 'device_online' ? 'online' : 'offline' }))
          }
        } catch { /* ignore */ }
      }
    }
    connect()
    return () => wsRef.current?.close()
  }, [])

  const { data: deviceData } = useQuery({
    queryKey: ['fp-devices', activeSite],
    queryFn: () => devicesApi.list({ limit: 500, site: activeSite || undefined }),
  })
  const { data: racksData } = useQuery({
    queryKey: ['fp-racks', activeSite],
    queryFn: () => racksApi.list({ site: activeSite || undefined }),
  })

  const devices = deviceData?.items ?? []
  const allRacks = racksData ?? []

  const C = useMemo(() => ({
    bg:     isDark ? '#0f172a' : '#f1f5f9',
    card:   isDark ? '#1e293b' : '#ffffff',
    border: isDark ? '#334155' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
    active: isDark ? '#172554' : '#eff6ff',
  }), [isDark])

  const activePlan = activeId ? store[activeId] : null

  const persist = useCallback((updated: FpStore) => { setStore(updated); saveStore(updated) }, [])
  const updatePlan = useCallback((p: FloorPlan) => persist({ ...store, [p.id]: p }), [store, persist])

  const handleNewPlan = () => {
    const name = newName.trim(); if (!name) return
    const id = `fp${Date.now()}`
    const plan: FloorPlan = { id, name, imageDataUrl: null, nodes: [], rackNodes: [], edges: [] }
    persist({ ...store, [id]: plan })
    setActiveId(id); setNewName('')
    message.success(`"${name}" oluşturuldu`)
  }
  const handleDeletePlan = (id: string) => {
    const { [id]: _, ...rest } = store
    persist(rest)
    if (activeId === id) setActiveId(Object.keys(rest)[0] ?? null)
  }
  const handleImageUpload = (file: File) => {
    if (!activePlan) return false
    const reader = new FileReader()
    reader.onload = e => {
      updatePlan({ ...activePlan, imageDataUrl: e.target?.result as string })
      message.success('Görsel yüklendi')
    }
    reader.readAsDataURL(file)
    return false
  }

  const filtered = useMemo(() => {
    const q = deviceSearch.toLowerCase()
    if (sidebarTab === 'devices') return devices.filter(d => !q || d.hostname.toLowerCase().includes(q) || d.ip_address.includes(q))
    return allRacks.filter(r => !q || r.rack_name.toLowerCase().includes(q))
  }, [devices, allRacks, deviceSearch, sidebarTab])

  const placedDeviceIds = useMemo(() => new Set(activePlan?.nodes.map(n => n.deviceId) ?? []), [activePlan])
  const placedRackNames = useMemo(() => new Set(activePlan?.rackNodes.map(r => r.rackName) ?? []), [activePlan])

  const modeBtn = (m: 'place' | 'connect' | 'erase', icon: React.ReactNode, label: string, color: string) => (
    <button
      key={m} onClick={() => setMode(m)}
      style={{ flex: 1, padding: '7px 0', fontSize: 11, fontWeight: 600, cursor: 'pointer',
        borderRadius: 7, border: `1.5px solid ${mode === m ? color : C.border}`,
        background: mode === m ? color + '22' : 'transparent',
        color: mode === m ? color : C.muted,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        transition: 'all 0.15s' }}
    >
      {icon}{label}
    </button>
  )

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 100px)', borderRadius: 12, overflow: 'hidden',
      border: `1px solid ${C.border}`, background: C.bg }}>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <div style={{ width: 214, background: C.card, borderRight: `1px solid ${C.border}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>

        {/* Plan selector */}
        <div style={{ padding: '10px 8px 6px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.text, flex: 1 }}>Kat Planları</span>
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => setLayoutDrawerOpen(true)} />
          </div>
          <Select size="small" style={{ width: '100%' }} value={activeId ?? undefined}
            placeholder="Plan seç…" onChange={setActiveId}
            options={Object.values(store).map(p => ({ label: p.name, value: p.id }))} />
        </div>

        {/* Mode buttons */}
        <div style={{ padding: '6px 6px 0', display: 'flex', gap: 4 }}>
          {modeBtn('place', <AppstoreOutlined />, 'Yerleştir', '#3b82f6')}
          {modeBtn('connect', <EditOutlined />, 'Bağla', '#22c55e')}
          {modeBtn('erase', <DeleteOutlined />, 'Sil', '#ef4444')}
        </div>

        {/* Image upload */}
        {activePlan && (
          <div style={{ padding: '4px 6px', display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}` }}>
            <Upload showUploadList={false} accept="image/*" beforeUpload={handleImageUpload}>
              <Button size="small" icon={<UploadOutlined />} style={{ fontSize: 10 }}>
                {activePlan.imageDataUrl ? 'Değiştir' : 'Görsel Yükle'}
              </Button>
            </Upload>
            {activePlan.imageDataUrl && (
              <Tooltip title="Görseli kaldır">
                <Button size="small" icon={<CloseOutlined />} danger onClick={() => updatePlan({ ...activePlan, imageDataUrl: null })} />
              </Tooltip>
            )}
          </div>
        )}

        {/* Devices / Racks tabs */}
        <div style={{ display: 'flex', borderBottom: `1px solid ${C.border}` }}>
          {(['devices', 'racks'] as const).map(tab => (
            <button key={tab} onClick={() => setSidebarTab(tab)} style={{
              flex: 1, padding: '6px 0', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              borderBottom: `2px solid ${sidebarTab === tab ? '#3b82f6' : 'transparent'}`,
              color: sidebarTab === tab ? '#3b82f6' : C.muted, background: 'transparent', border: 'none',
              borderBottomWidth: 2, borderBottomStyle: 'solid',
            }}>
              {tab === 'devices' ? '💻 Cihazlar' : '📦 Kabinler'}
            </button>
          ))}
        </div>

        {/* Search + view toggle */}
        <div style={{ padding: '5px 6px 3px', display: 'flex', gap: 4 }}>
          <Input size="small" placeholder={sidebarTab === 'devices' ? 'Cihaz ara…' : 'Kabin ara…'} allowClear
            prefix={<SearchOutlined style={{ color: C.muted, fontSize: 10 }} />}
            value={deviceSearch} onChange={e => setDeviceSearch(e.target.value)} />
          <Button size="small"
            icon={gridView ? <UnorderedListOutlined /> : <AppstoreOutlined />}
            onClick={() => setGridView(v => !v)} />
        </div>

        {/* Scrollable list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '2px 5px 8px' }}>
          {sidebarTab === 'devices' ? (
            gridView ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
                {(filtered as Device[]).map(d => {
                  const placed = placedDeviceIds.has(d.id)
                  const vc = VENDOR_COLORS[d.vendor] || VENDOR_COLORS.other
                  const sc = STATUS_COLORS[d.status] || '#f59e0b'
                  return (
                    <div key={d.id} draggable={!placed && !!activePlan}
                      onDragStart={e => e.dataTransfer.setData('application/fp-device', JSON.stringify(d))}
                      style={{ padding: '5px 4px', borderRadius: 6, textAlign: 'center', opacity: placed ? 0.4 : 1,
                        cursor: placed ? 'default' : 'grab', border: `1px solid ${C.border}`, background: C.bg }}>
                      <HddOutlined style={{ color: vc, fontSize: 14 }} />
                      <div style={{ fontSize: 9, color: C.text, marginTop: 2, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {d.hostname.length > 10 ? d.hostname.slice(0, 9) + '…' : d.hostname}
                      </div>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: sc, margin: '2px auto 0' }} />
                    </div>
                  )
                })}
              </div>
            ) : (
              (filtered as Device[]).map(d => {
                const placed = placedDeviceIds.has(d.id)
                const vc = VENDOR_COLORS[d.vendor] || VENDOR_COLORS.other
                const sc = STATUS_COLORS[d.status] || '#f59e0b'
                return (
                  <div key={d.id} draggable={!placed && !!activePlan}
                    onDragStart={e => e.dataTransfer.setData('application/fp-device', JSON.stringify(d))}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 5px',
                      borderRadius: 5, marginBottom: 2, opacity: placed ? 0.4 : 1,
                      cursor: placed ? 'default' : 'grab' }}
                    onMouseEnter={e => { if (!placed) (e.currentTarget as HTMLElement).style.background = C.active }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: vc, flexShrink: 0 }} />
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.hostname}</div>
                      <div style={{ fontSize: 10, color: C.muted }}>{d.ip_address}</div>
                    </div>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: sc, flexShrink: 0 }} />
                  </div>
                )
              })
            )
          ) : (
            (filtered as typeof allRacks).map(r => {
              const placed = placedRackNames.has(r.rack_name)
              const fillPct = r.total_u > 0 ? Math.round((r.used_u / r.total_u) * 100) : 0
              const fc = fillPct > 80 ? '#ef4444' : fillPct > 60 ? '#f59e0b' : '#22c55e'
              return (
                <div key={r.rack_name} draggable={!placed && !!activePlan}
                  onDragStart={e => e.dataTransfer.setData('application/fp-rack', JSON.stringify(r.rack_name))}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 5px',
                    borderRadius: 5, marginBottom: 2, opacity: placed ? 0.4 : 1,
                    cursor: placed ? 'default' : 'grab' }}
                  onMouseEnter={e => { if (!placed) (e.currentTarget as HTMLElement).style.background = C.active }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                  <div style={{ fontSize: 16, flexShrink: 0 }}>📦</div>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.rack_name}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                      <div style={{ flex: 1, height: 3, background: isDark ? '#0f172a' : '#e2e8f0', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${fillPct}%`, height: '100%', background: fc, borderRadius: 2 }} />
                      </div>
                      <span style={{ fontSize: 9, color: C.muted }}>{r.used_u}/{r.total_u}U</span>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer stats */}
        {activePlan && (
          <div style={{ padding: '5px 10px', borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.muted,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{activePlan.nodes.length} cihaz · {activePlan.rackNodes.length} kabin · {activePlan.edges.length} bağlantı</span>
            <Tooltip title={wsConnected ? 'Canlı durum aktif' : 'Bağlantı bekleniyor…'}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: wsConnected ? '#22c55e' : '#64748b',
                  boxShadow: wsConnected ? '0 0 4px #22c55e' : undefined }} />
                <span style={{ color: wsConnected ? '#22c55e' : C.muted, fontWeight: 600 }}>
                  {wsConnected ? 'CANLI' : 'BEKLEME'}
                </span>
              </div>
            </Tooltip>
          </div>
        )}
      </div>

      {/* ── Canvas area ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {activePlan ? (
          <FloorCanvas
            plan={activePlan}
            mode={mode}
            isDark={isDark}
            onUpdate={updatePlan}
            onClickRack={setSelectedRack}
            liveStatus={liveStatus}
          />
        ) : (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <Empty description={<span style={{ color: C.muted }}>Henüz kat planı yok</span>} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setLayoutDrawerOpen(true)}>
              Yeni Kat Planı
            </Button>
          </div>
        )}
      </div>

      {/* ── Rack detail panel (right drawer) ────────────────────────────────── */}
      {selectedRack && (
        <div style={{ width: 300, borderLeft: `1px solid ${C.border}`, overflow: 'hidden', flexShrink: 0 }}>
          <RackDetailPanel rackName={selectedRack} isDark={isDark} onClose={() => setSelectedRack(null)} />
        </div>
      )}

      {/* ── Plans management drawer ──────────────────────────────────────────── */}
      <Drawer title="Kat Planları" open={layoutDrawerOpen} onClose={() => setLayoutDrawerOpen(false)}
        width={320} styles={{ body: { padding: '12px 16px' } }}>
        <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
          <Input placeholder="Yeni plan adı…" value={newName}
            onChange={e => setNewName(e.target.value)} onPressEnter={handleNewPlan} />
          <Button type="primary" icon={<SaveOutlined />} onClick={handleNewPlan}>Oluştur</Button>
        </Space.Compact>

        {Object.values(store).length === 0 && <Empty description="Henüz kat planı yok" style={{ marginTop: 32 }} />}

        {Object.values(store).map(plan => (
          <div key={plan.id}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8,
              marginBottom: 6, border: `1px solid ${activeId === plan.id ? '#3b82f6' : C.border}`,
              background: activeId === plan.id ? (isDark ? 'rgba(59,130,246,0.1)' : 'rgba(59,130,246,0.05)') : C.card,
              cursor: 'pointer' }}
            onClick={() => { setActiveId(plan.id); setLayoutDrawerOpen(false) }}
          >
            <span style={{ fontSize: 18 }}>🏢</span>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{plan.name}</div>
              <div style={{ fontSize: 11, color: C.muted }}>
                {plan.nodes.length} cihaz · {plan.rackNodes.length} kabin · {plan.edges.length} bağlantı
                {plan.imageDataUrl ? ' · Görsel var' : ''}
              </div>
            </div>
            <Popconfirm title="Bu planı sil?" onConfirm={e => { e?.stopPropagation(); handleDeletePlan(plan.id) }} okText="Sil" cancelText="İptal">
              <Button size="small" danger icon={<DeleteOutlined />} onClick={e => e.stopPropagation()} />
            </Popconfirm>
          </div>
        ))}
      </Drawer>
    </div>
  )
}
