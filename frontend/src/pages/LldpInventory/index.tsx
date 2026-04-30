import { useState } from 'react'
import {
  Select, Space, Table, Tag, Tooltip, Button, Modal, InputNumber, Form, Input, message,
} from 'antd'
import { useTranslation } from 'react-i18next'
import {
  RadarChartOutlined, ReloadOutlined, PushpinOutlined, SearchOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { topologyApi, type LldpInventoryItem } from '@/api/topology'

// ── OSM Map import helpers ────────────────────────────────────────────────────
interface _MapNode { id: string; deviceId: number; hostname: string; ip: string; vendor: string; status: string; device_type: string; lat: number; lng: number }
interface _MapEdge { id: string; from: string; to: string; fromPort?: string; toPort?: string }
interface _MapState { nodes: _MapNode[]; edges: _MapEdge[]; rackNodes?: unknown[] }
const MAP_KEY = 'nm-osm-topo-v2'
function _loadMap(): _MapState { try { const s = localStorage.getItem(MAP_KEY); return s ? JSON.parse(s) : { nodes: [], edges: [], rackNodes: [] } } catch { return { nodes: [], edges: [], rackNodes: [] } } }
function _saveMap(st: _MapState) { try { localStorage.setItem(MAP_KEY, JSON.stringify(st)) } catch {} }

function importLldpToMap(items: LldpInventoryItem[], centerLat: number, centerLng: number) {
  type Dev = { hostname: string; ip: string; device_type: string; deviceId: number }
  const devMap = new Map<string, Dev>()

  for (const item of items) {
    if (item.connected_device_hostname && !devMap.has(item.connected_device_hostname)) {
      devMap.set(item.connected_device_hostname, { hostname: item.connected_device_hostname, ip: item.connected_device_ip || '', device_type: 'switch', deviceId: item.connected_device_id })
    }
    if (!devMap.has(item.hostname)) {
      devMap.set(item.hostname, { hostname: item.hostname, ip: item.ip || '', device_type: item.device_type, deviceId: 0 })
    }
  }

  const existing = _loadMap()
  const existingHostnames = new Set(existing.nodes.map((n) => n.hostname))
  const newDevices = [...devMap.values()].filter((d) => !existingHostnames.has(d.hostname))
  const gridSize = Math.max(1, Math.ceil(Math.sqrt(newDevices.length)))
  const spacing = 0.0015

  const ts = Date.now()
  const newNodes: _MapNode[] = newDevices.map((dev, i) => ({
    id: `lldp-${ts}-${i}`,
    deviceId: dev.deviceId,
    hostname: dev.hostname,
    ip: dev.ip,
    vendor: 'other',
    status: 'unknown',
    device_type: dev.device_type,
    lat: centerLat + (Math.floor(i / gridSize) - gridSize / 2) * spacing,
    lng: centerLng + ((i % gridSize) - gridSize / 2) * spacing,
  }))

  const allNodes = [...existing.nodes, ...newNodes]
  const nodeByHostname = new Map(allNodes.map((n) => [n.hostname, n]))
  const existingEdgeKeys = new Set(existing.edges.map((e) => `${e.from}|${e.to}`))
  const newEdges: _MapEdge[] = []

  for (const item of items) {
    const src = nodeByHostname.get(item.connected_device_hostname || '')
    const dst = nodeByHostname.get(item.hostname)
    if (!src || !dst) continue
    const k = `${src.id}|${dst.id}`, rk = `${dst.id}|${src.id}`
    if (existingEdgeKeys.has(k) || existingEdgeKeys.has(rk)) continue
    existingEdgeKeys.add(k)
    newEdges.push({ id: `lldp-e-${ts}-${newEdges.length}`, from: src.id, to: dst.id, fromPort: item.local_port, toPort: item.neighbor_port })
  }

  _saveMap({ nodes: allNodes, edges: [...existing.edges, ...newEdges], rackNodes: existing.rackNodes ?? [] })
  return { addedNodes: newNodes.length, addedEdges: newEdges.length, skipped: devMap.size - newNodes.length }
}

const LLDP_CSS = `
@keyframes lldpRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
`

const TYPE_HEX: Record<string, string> = {
  switch: '#3b82f6', router: '#06b6d4', ap: '#22c55e', phone: '#8b5cf6',
  printer: '#f97316', camera: '#ef4444', firewall: '#dc2626', server: '#6366f1',
  laptop: '#84cc16', other: '#64748b',
}

const TYPE_LABEL: Record<string, string> = {
  switch: 'Switch', router: 'Router', ap: 'Access Point', phone: 'IP Telefon',
  printer: 'Yazıcı', camera: 'Kamera', firewall: 'Firewall', server: 'Sunucu',
  laptop: 'Bilgisayar', other: 'Diğer',
}

const TYPE_ICON: Record<string, string> = {
  switch: '🔀', router: '🌐', ap: '📶', phone: '📞',
  printer: '🖨️', camera: '📷', firewall: '🛡️', server: '🖥️',
  laptop: '💻', other: '❓',
}

function mkC(isDark: boolean) {
  return {
    bg:     isDark ? '#1e293b' : '#ffffff',
    bg2:    isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
    dim:    isDark ? '#475569' : '#cbd5e1',
  }
}

export default function LldpInventoryPage() {
  const [filterType, setFilterType] = useState<string | undefined>()
  const [search, setSearch] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importLat, setImportLat] = useState(41.0082)
  const [importLng, setImportLng] = useState(28.9784)
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const navigate = useNavigate()
  const C = mkC(isDark)

  function handleImport() {
    const items = data?.items ?? []
    if (!items.length) { message.warning('Aktarılacak veri yok'); return }
    const result = importLldpToMap(items, importLat, importLng)
    setImportOpen(false)
    message.success(`${result.addedNodes} cihaz ve ${result.addedEdges} bağlantı haritaya eklendi`)
    navigate('/topology')
  }

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['lldp-inventory', filterType, activeSite],
    queryFn: () => topologyApi.getLldpInventory(filterType, activeSite || undefined),
    refetchInterval: 60000,
  })

  const typeOptions = Object.entries(TYPE_LABEL).map(([k, v]) => ({
    label: `${TYPE_ICON[k]} ${v}`,
    value: k,
  }))

  const q = search.toLowerCase().trim()
  const filteredItems = (data?.items ?? []).filter((r) => {
    if (!q) return true
    return (
      r.hostname.toLowerCase().includes(q) ||
      (r.ip ?? '').includes(q) ||
      (r.connected_device_hostname ?? '').toLowerCase().includes(q) ||
      (r.platform ?? '').toLowerCase().includes(q)
    )
  })

  const columns = [
    {
      title: t('discovery.col_type'),
      dataIndex: 'device_type',
      width: 140,
      render: (v: string) => {
        const hex = TYPE_HEX[v] || '#64748b'
        return (
          <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>
            {TYPE_ICON[v] || '❓'} {TYPE_LABEL[v] || v}
          </Tag>
        )
      },
    },
    {
      title: 'Hostname',
      dataIndex: 'hostname',
      ellipsis: true,
      render: (v: string) => <span style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>{v}</span>,
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      width: 130,
      render: (v: string | undefined) => v
        ? <span style={{ fontFamily: 'monospace', fontSize: 12, color: C.muted }}>{v}</span>
        : <span style={{ color: C.dim }}>—</span>,
    },
    {
      title: 'Platform',
      dataIndex: 'platform',
      ellipsis: true,
      render: (v: string | undefined) =>
        v ? (
          <Tooltip title={v}>
            <span style={{ fontSize: 12, color: C.muted }}>
              {v.length > 50 ? v.slice(0, 50) + '…' : v}
            </span>
          </Tooltip>
        ) : (
          <span style={{ color: C.dim }}>—</span>
        ),
    },
    {
      title: t('discovery.col_source'),
      dataIndex: 'connected_device_hostname',
      width: 160,
      render: (v: string | undefined, r: LldpInventoryItem) => (
        <div>
          <div style={{ fontWeight: 500, color: C.text, fontSize: 12 }}>{v || '—'}</div>
          {r.connected_device_ip && (
            <div style={{ fontSize: 11, color: C.muted }}>{r.connected_device_ip}</div>
          )}
        </div>
      ),
    },
    {
      title: 'Port',
      width: 160,
      render: (_: unknown, r: LldpInventoryItem) => (
        <span style={{
          fontFamily: 'monospace', fontSize: 11, color: C.muted,
          background: isDark ? '#0f172a' : '#f1f5f9',
          padding: '2px 6px', borderRadius: 4,
        }}>
          {r.local_port} ↔ {r.neighbor_port || '—'}
        </span>
      ),
    },
    {
      title: 'Protokol',
      dataIndex: 'protocol',
      width: 80,
      render: (v: string) => {
        const hex = '#3b82f6'
        return <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>{v?.toUpperCase()}</Tag>
      },
    },
    {
      title: t('discovery.col_seen'),
      dataIndex: 'last_seen',
      width: 140,
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}>
          <span style={{ fontSize: 12, color: C.muted }}>{dayjs(v).fromNow()}</span>
        </Tooltip>
      ),
    },
  ]

  const typeCounts = data?.type_counts || {}
  const total = data?.total || 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{LLDP_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#3b82f620' : C.border}`,
        borderLeft: '4px solid #3b82f6',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#3b82f620', border: '1px solid #3b82f630',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <RadarChartOutlined style={{ color: '#3b82f6', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>
              {t('discovery.title')}
              <span style={{ color: C.dim, fontSize: 13, fontWeight: 400, marginLeft: 8 }}>
                ({q ? `${filteredItems.length} / ${total}` : total})
              </span>
            </div>
            <div style={{ color: C.muted, fontSize: 12 }}>LLDP keşif envanteri — 60s otomatik yenileme</div>
          </div>
        </div>
        <Space>
          <Input
            prefix={<SearchOutlined style={{ color: C.muted }} />}
            placeholder="Hostname / IP ara..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            allowClear
            size="small"
            style={{ width: 200 }}
          />
          <Select
            allowClear
            placeholder={t('discovery.filter_all_types')}
            style={{ width: 160 }}
            value={filterType}
            onChange={setFilterType}
            options={typeOptions}
            size="small"
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()}>Yenile</Button>
          <Button
            size="small"
            type="primary"
            icon={<PushpinOutlined />}
            disabled={!data?.total}
            onClick={() => setImportOpen(true)}
          >
            Haritaya Aktar
          </Button>
        </Space>
      </div>

      {/* Type filter chips */}
      {Object.keys(typeCounts).length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {Object.entries(typeCounts)
            .sort(([, a], [, b]) => (b as number) - (a as number))
            .map(([type, count]) => {
              const hex = TYPE_HEX[type] || '#64748b'
              const active = filterType === type
              return (
                <div
                  key={type}
                  onClick={() => setFilterType(filterType === type ? undefined : type)}
                  style={{
                    background: active ? (isDark ? `${hex}20` : `${hex}15`) : (isDark ? '#1e293b' : C.bg),
                    border: `1px solid ${active ? hex + '60' : C.border}`,
                    borderTop: active ? `2px solid ${hex}` : `1px solid ${C.border}`,
                    borderRadius: 8,
                    padding: '6px 12px',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 8,
                    transition: 'all 0.15s ease',
                  }}
                >
                  <span style={{ fontSize: 14 }}>{TYPE_ICON[type]}</span>
                  <div>
                    <div style={{ color: active ? hex : C.text, fontSize: 16, fontWeight: 700, lineHeight: 1 }}>{count as number}</div>
                    <div style={{ color: C.muted, fontSize: 10, marginTop: 1 }}>{TYPE_LABEL[type] || type}</div>
                  </div>
                </div>
              )
            })}
        </div>
      )}

      {/* Table */}
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <Table<LldpInventoryItem>
          dataSource={filteredItems}
          columns={columns}
          rowKey="hostname"
          loading={isLoading}
          size="small"
          pagination={{ pageSize: 50, showSizeChanger: true }}
          locale={{ emptyText: t('common.no_data') }}
          onRow={() => ({ style: { animation: 'lldpRowIn 0.2s ease-out' } })}
        />
      </div>

      {/* Import to Map modal */}
      <Modal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={handleImport}
        title="Haritaya Aktar"
        okText="Aktar"
        cancelText="İptal"
      >
        <div style={{ marginBottom: 12, color: C.muted, fontSize: 13 }}>
          LLDP envanterindeki <strong style={{ color: C.text }}>{data?.total ?? 0}</strong> cihaz fiziksel haritaya (OSM) aktarılacak.
          Zaten haritada olan cihazlar atlanır, yeniler aşağıdaki koordinatların çevresinde otomatik yerleştirilir.
        </div>
        <Form layout="vertical" size="small">
          <Form.Item label="Merkez Enlem (Lat)" style={{ marginBottom: 8 }}>
            <InputNumber
              value={importLat}
              onChange={(v) => setImportLat(v ?? 41.0082)}
              step={0.001}
              precision={4}
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item label="Merkez Boylam (Lng)" style={{ marginBottom: 0 }}>
            <InputNumber
              value={importLng}
              onChange={(v) => setImportLng(v ?? 28.9784)}
              step={0.001}
              precision={4}
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Form>
        <div style={{ marginTop: 10, fontSize: 11, color: C.muted }}>
          Aktarım sonrası Kabinler &amp; Harita sayfasına yönlendirilirsiniz. Cihazları sürükleyerek gerçek konumlarına taşıyabilirsiniz.
        </div>
      </Modal>
    </div>
  )
}
