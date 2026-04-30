import { useState, useMemo } from 'react'
import {
  Table, Tag, Typography, Space, Switch, Tooltip,
  Button, Select, Input, Tabs, message, Alert,
} from 'antd'
import {
  ReloadOutlined, WifiOutlined, ArrowUpOutlined, ArrowDownOutlined,
  WarningOutlined, AlertOutlined, ThunderboltOutlined, SettingOutlined,
  BarChartOutlined, DashboardOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip,
  ResponsiveContainer, Legend, AreaChart, Area,
} from 'recharts'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { useNavigate } from 'react-router-dom'
import { snmpApi, type TrafficRate, type ErrorInterface, type UtilizationPoint } from '@/api/snmp'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'

dayjs.extend(relativeTime)

const { Text } = Typography

function mkC(isDark: boolean) {
  return {
    bg:     isDark ? '#1e293b' : '#ffffff',
    bg2:    isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
  }
}

const BW_CSS = `
  @keyframes bwCritGlow {
    0%,100% { box-shadow: 0 2px 14px rgba(239,68,68,0.18), 0 0 0 1px #ef444420; }
    50%      { box-shadow: 0 2px 24px rgba(239,68,68,0.32), 0 0 0 1px #ef444438; }
  }
  @keyframes bwWarnGlow {
    0%,100% { box-shadow: 0 2px 12px rgba(245,158,11,0.14); }
    50%      { box-shadow: 0 2px 20px rgba(245,158,11,0.28); }
  }
  .bw-row-hot  td         { background: rgba(239,68,68,0.05) !important; }
  .bw-row-hot:hover  td   { background: rgba(239,68,68,0.09) !important; }
  .bw-row-busy td         { background: rgba(245,158,11,0.04) !important; }
  .bw-row-busy:hover td   { background: rgba(245,158,11,0.07) !important; }
`

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatMbps(mbps: number): string {
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbps`
  if (mbps >= 1)    return `${mbps.toFixed(1)} Mbps`
  if (mbps > 0)     return `${(mbps * 1000).toFixed(0)} Kbps`
  return '—'
}

function formatSpeed(mbps: number | null): string {
  if (!mbps) return '—'
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(0)}G`
  return `${mbps}M`
}

function mbpsColor(mbps: number, speed: number | null): string {
  if (!speed) return '#38bdf8'
  const pct = mbps / speed * 100
  if (pct >= 80) return '#ef4444'
  if (pct >= 50) return '#f97316'
  if (pct >= 20) return '#eab308'
  return '#22c55e'
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color, isDark, glow }: {
  label: string; value: number | string; sub?: string; color: string; isDark: boolean; glow?: boolean
}) {
  return (
    <div style={{
      background: isDark
        ? `linear-gradient(135deg, ${color}0f 0%, #1e293b 100%)`
        : '#ffffff',
      border: `1px solid ${color}22`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 10,
      padding: '12px 16px',
      position: 'relative',
      overflow: 'hidden',
      animation: glow
        ? color === '#ef4444' ? 'bwCritGlow 2.5s ease-in-out infinite'
        : 'bwWarnGlow 3s ease-in-out infinite'
        : undefined,
      boxShadow: isDark ? '0 2px 10px rgba(0,0,0,0.25)' : '0 2px 6px rgba(0,0,0,0.06)',
    }}>
      <div style={{
        position: 'absolute', top: -18, right: -18,
        width: 64, height: 64, borderRadius: '50%',
        background: `radial-gradient(circle, ${color}18, transparent 70%)`,
        pointerEvents: 'none',
      }} />
      <div style={{ color: isDark ? '#475569' : '#94a3b8', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color, fontFamily: 'monospace', lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ color: isDark ? '#475569' : '#94a3b8', fontSize: 10, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// ── Utilization history chart (expanded row sparkline) ────────────────────────

function UtilizationHistoryChart({ deviceId, ifIndex, ifName }: {
  deviceId: number; ifIndex: number; ifName: string | null
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['snmp-util-history', deviceId, ifIndex],
    queryFn: () => snmpApi.getUtilizationHistory(deviceId, ifIndex, 72),
    staleTime: 60_000,
  })

  const points = (data?.history || [])
    .filter((p: UtilizationPoint) => p.in_pct !== null || p.out_pct !== null)
    .map((p: UtilizationPoint) => ({
      ts: dayjs(p.ts).format('DD/MM HH:mm'),
      in_pct: p.in_pct ?? 0,
      out_pct: p.out_pct ?? 0,
    }))
    .slice(-48)

  if (isLoading) return <div style={{ padding: '12px 24px' }}><Text type="secondary">Yükleniyor…</Text></div>
  if (!points.length) return <div style={{ padding: '12px 24px' }}><Text type="secondary">Geçmiş veri yok</Text></div>

  const maxVal = Math.max(...points.map((p) => Math.max(p.in_pct, p.out_pct)), 10)

  return (
    <div style={{ padding: '12px 24px' }}>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        {ifName} — Son {points.length} poll · Utilization Geçmişi
      </Text>
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={points} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="inGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="outGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.1)" />
          <XAxis dataKey="ts" tick={{ fontSize: 9 }} interval={Math.floor(points.length / 8)} />
          <YAxis domain={[0, maxVal]} tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
          <ReTooltip
            contentStyle={{ fontSize: 12, backgroundColor: '#1e293b', border: '1px solid #334155' }}
            formatter={(v, name) => [`${Number(v).toFixed(1)}%`, name === 'in_pct' ? 'Giriş' : 'Çıkış']}
          />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }}
            formatter={(v) => v === 'in_pct' ? 'Giriş' : 'Çıkış'} />
          <Area type="monotone" dataKey="in_pct" stroke="#38bdf8" fill="url(#inGrad)" strokeWidth={1.5} dot={false} />
          <Area type="monotone" dataKey="out_pct" stroke="#f97316" fill="url(#outGrad)" strokeWidth={1.5} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Top 10 traffic chart (Mbps) ───────────────────────────────────────────────

interface ChartItem {
  name: string
  in_mbps: number
  out_mbps: number
}

function TopTrafficChart({ data, isDark }: { data: ChartItem[]; isDark: boolean }) {
  const C = mkC(isDark)
  if (!data.length) return null
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.bg2 }}>
        <Text style={{ fontSize: 12, fontWeight: 600, color: C.text }}>
          Top 10 Interface — Anlık Trafik Hızı
        </Text>
        <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
          Son iki poll arasından hesaplanan gerçek Mbps değeri
        </Text>
      </div>
      <div style={{ padding: '12px 16px' }}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 80, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.1)" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => formatMbps(v)} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={140} />
            <ReTooltip
              contentStyle={{ fontSize: 12, backgroundColor: '#1e293b', border: '1px solid #334155' }}
              formatter={(v, name) => [formatMbps(Number(v)), name === 'in_mbps' ? 'Giriş' : 'Çıkış']}
            />
            <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }}
              formatter={(v) => v === 'in_mbps' ? 'Giriş' : 'Çıkış'} />
            <Bar dataKey="in_mbps" name="in_mbps" fill="#38bdf8" radius={[0, 3, 3, 0]} maxBarSize={14} />
            <Bar dataKey="out_mbps" name="out_mbps" fill="#f97316" radius={[0, 3, 3, 0]} maxBarSize={14} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ── Traffic tab ───────────────────────────────────────────────────────────────

function TrafficTab() {
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [minMbps, setMinMbps] = useState(0)
  const [expandedIfaces, setExpandedIfaces] = useState<string[]>([])

  const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['snmp-traffic-rates', minMbps, activeSite],
    queryFn: () => snmpApi.getTrafficRates({ limit: 200, min_mbps: minMbps, site: activeSite || undefined }),
    refetchInterval: autoRefresh ? 60_000 : false,
    staleTime: 30_000,
  })

  const allItems = data?.items || []

  const filtered = useMemo(() => {
    if (!search) return allItems
    const q = search.toLowerCase()
    return allItems.filter((r) =>
      r.hostname.toLowerCase().includes(q) ||
      (r.if_name || '').toLowerCase().includes(q) ||
      r.ip_address.includes(q)
    )
  }, [allItems, search])

  const uniqueDevices = new Set(filtered.map((r) => r.device_id)).size
  const totalIn  = filtered.reduce((s, r) => s + r.in_mbps, 0)
  const totalOut = filtered.reduce((s, r) => s + r.out_mbps, 0)
  const peakItem = filtered[0]

  const top10: ChartItem[] = filtered.slice(0, 10).map((r) => {
    const ifShort = (r.if_name || `#${r.if_index}`).replace(/GigabitEthernet/i, 'Gi').replace(/TenGigabitEthernet/i, 'Te')
    const label = `${r.hostname.slice(0, 11)}/${ifShort.slice(0, 10)}`
    return { name: label, in_mbps: r.in_mbps, out_mbps: r.out_mbps }
  })

  const columns = [
    {
      title: 'Cihaz',
      render: (_: unknown, r: TrafficRate) => (
        <div>
          <Button
            type="link" size="small"
            style={{ padding: 0, fontWeight: 600, fontSize: 12, height: 'auto' }}
            onClick={() => navigate(`/devices?search=${r.ip_address}`)}
          >
            {r.hostname}
          </Button>
          <br />
          <Text type="secondary" style={{ fontSize: 10 }}>{r.ip_address}</Text>
        </div>
      ),
    },
    {
      title: 'Interface',
      render: (_: unknown, r: TrafficRate) => (
        <Space size={4}>
          <WifiOutlined style={{ opacity: 0.4, fontSize: 11 }} />
          <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {r.if_name || `#${r.if_index}`}
          </Text>
          {r.speed_mbps ? (
            <Tag style={{ fontSize: 10, margin: 0, padding: '0 4px' }}>{formatSpeed(r.speed_mbps)}</Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: <Space size={4}><ArrowDownOutlined style={{ color: '#38bdf8' }} />Giriş</Space>,
      width: 130,
      sorter: (a: TrafficRate, b: TrafficRate) => b.in_mbps - a.in_mbps,
      render: (_: unknown, r: TrafficRate) => (
        <Text style={{
          fontFamily: 'monospace', fontSize: 13, fontWeight: 600,
          color: mbpsColor(r.in_mbps, r.speed_mbps),
        }}>
          {formatMbps(r.in_mbps)}
        </Text>
      ),
    },
    {
      title: <Space size={4}><ArrowUpOutlined style={{ color: '#f97316' }} />Çıkış</Space>,
      width: 130,
      sorter: (a: TrafficRate, b: TrafficRate) => b.out_mbps - a.out_mbps,
      render: (_: unknown, r: TrafficRate) => (
        <Text style={{
          fontFamily: 'monospace', fontSize: 13, fontWeight: 600,
          color: mbpsColor(r.out_mbps, r.speed_mbps),
        }}>
          {formatMbps(r.out_mbps)}
        </Text>
      ),
    },
    {
      title: 'Zirve',
      width: 150,
      defaultSortOrder: 'descend' as const,
      sorter: (a: TrafficRate, b: TrafficRate) => b.peak_mbps - a.peak_mbps,
      render: (_: unknown, r: TrafficRate) => (
        <Space size={6}>
          <Text style={{
            fontFamily: 'monospace', fontSize: 13, fontWeight: 700,
            color: mbpsColor(r.peak_mbps, r.speed_mbps),
          }}>
            {formatMbps(r.peak_mbps)}
          </Text>
          {r.util_pct !== null && (
            <Tag
              color={r.util_pct >= 80 ? 'red' : r.util_pct >= 50 ? 'orange' : r.util_pct >= 20 ? 'gold' : 'green'}
              style={{ fontFamily: 'monospace', fontSize: 11, margin: 0 }}
            >
              {r.util_pct.toFixed(0)}%
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Son Poll',
      width: 110,
      render: (_: unknown, r: TrafficRate) => (
        <Tooltip title={`${dayjs(r.polled_at).format('DD.MM.YYYY HH:mm:ss')} · ${r.elapsed_secs}s aralık`}>
          <Text type="secondary" style={{ fontSize: 11 }}>{dayjs(r.polled_at).fromNow()}</Text>
        </Tooltip>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{BW_CSS}</style>

      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          Son iki poll arasındaki counter deltasından hesaplanan anlık trafik hızı
          {dataUpdatedAt ? ` · ${dayjs(dataUpdatedAt).format('HH:mm:ss')} güncellendi` : ''}
        </Text>
        <Space wrap>
          <Input.Search
            placeholder="Cihaz veya interface..."
            style={{ width: 210 }}
            allowClear
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            value={minMbps}
            onChange={setMinMbps}
            style={{ width: 130 }}
            options={[
              { value: 0,   label: 'Hepsi' },
              { value: 1,   label: '≥ 1 Mbps' },
              { value: 10,  label: '≥ 10 Mbps' },
              { value: 100, label: '≥ 100 Mbps' },
              { value: 500, label: '≥ 500 Mbps' },
            ]}
          />
          <Space size={4}>
            <Text style={{ fontSize: 12 }}>Oto. Yenile</Text>
            <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
          </Space>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()} loading={isLoading}>Yenile</Button>
        </Space>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 130 }}>
          <StatCard label="Aktif Switch" value={uniqueDevices} color="#3b82f6" isDark={isDark} />
        </div>
        <div style={{ flex: 1, minWidth: 130 }}>
          <StatCard label="Aktif Interface" value={filtered.length} color="#8b5cf6" isDark={isDark} />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <StatCard
            label="Toplam Giriş"
            value={formatMbps(totalIn)}
            sub="anlık toplam"
            color="#38bdf8"
            isDark={isDark}
          />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <StatCard
            label="Toplam Çıkış"
            value={formatMbps(totalOut)}
            sub="anlık toplam"
            color="#f97316"
            isDark={isDark}
          />
        </div>
        {peakItem && (
          <div style={{ flex: 2, minWidth: 200 }}>
            <StatCard
              label="En Yüksek Trafik"
              value={formatMbps(peakItem.peak_mbps)}
              sub={`${peakItem.hostname} / ${peakItem.if_name || '#' + peakItem.if_index}`}
              color={peakItem.peak_mbps > 800 ? '#ef4444' : '#f97316'}
              isDark={isDark}
              glow={peakItem.peak_mbps > 800}
            />
          </div>
        )}
      </div>

      {/* Top 10 chart */}
      {top10.length > 1 && <TopTrafficChart data={top10} isDark={isDark} />}

      {/* Interface table */}
      <Table<TrafficRate>
        dataSource={filtered}
        rowKey={(r) => `${r.device_id}-${r.if_index}`}
        columns={columns}
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25, showSizeChanger: false, showTotal: (n) => `${n} interface` }}
        rowClassName={(r) => {
          if (!r.speed_mbps) return ''
          const pct = r.peak_mbps / r.speed_mbps * 100
          if (pct >= 80) return 'bw-row-hot'
          if (pct >= 50) return 'bw-row-busy'
          return ''
        }}
        expandable={{
          expandedRowKeys: expandedIfaces,
          onExpand: (expanded, r) => {
            const key = `${r.device_id}-${r.if_index}`
            setExpandedIfaces(expanded ? [key] : expandedIfaces.filter((k) => k !== key))
          },
          expandedRowRender: (r) => (
            <UtilizationHistoryChart deviceId={r.device_id} ifIndex={r.if_index} ifName={r.if_name} />
          ),
          expandIcon: ({ expanded, onExpand, record: r }) => (
            <Tooltip title={expanded ? 'Grafiği gizle' : 'Utilization geçmişini göster'}>
              <Button
                size="small" type="text" icon={<BarChartOutlined />}
                style={{ color: expanded ? '#3b82f6' : '#94a3b8' }}
                onClick={(e) => onExpand(r, e)}
              />
            </Tooltip>
          ),
        }}
        locale={{ emptyText: 'SNMP polling verisi yok — cihazlarda SNMP etkinleştirin ve "Şimdi Poll Et" butonuna basın' }}
      />
    </div>
  )
}

// ── Error history sparkline ───────────────────────────────────────────────────

function ErrorHistoryChart({ deviceId, ifIndex }: { deviceId: number; ifIndex: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['snmp-error-history', deviceId, ifIndex],
    queryFn: () => snmpApi.getErrorHistory(deviceId, ifIndex, 24),
    staleTime: 60_000,
  })

  const points = (data?.history || [])
    .filter((p) => p.in_err_delta !== null)
    .map((p) => ({
      ts: dayjs(p.ts).format('HH:mm'),
      in_err: p.in_err_delta ?? 0,
      out_err: p.out_err_delta ?? 0,
    }))

  if (isLoading) return <Text type="secondary" style={{ fontSize: 12 }}>Yükleniyor…</Text>
  if (!points.length) return <Text type="secondary" style={{ fontSize: 12 }}>Geçmiş hata verisi yok</Text>

  return (
    <div style={{ padding: '8px 24px' }}>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        Son 24 poll — hata delta (her poll aralığındaki yeni hata sayısı)
      </Text>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={points} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis dataKey="ts" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
          <ReTooltip
            contentStyle={{ backgroundColor: '#1f1f1f', border: '1px solid #333', fontSize: 12 }}
          />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="in_err" name="Giriş Hata" fill="#f87171" radius={[2, 2, 0, 0]} />
          <Bar dataKey="out_err" name="Çıkış Hata" fill="#fb923c" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Error interfaces tab ──────────────────────────────────────────────────────

function ErrorInterfacesTab() {
  const [minErrors, setMinErrors] = useState(0)
  const [limit, setLimit] = useState(50)
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [expandedKeys, setExpandedKeys] = useState<string[]>([])
  const { activeSite } = useSite()

  const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['snmp-error-interfaces', limit, minErrors, activeSite],
    queryFn: () => snmpApi.getErrorInterfaces({ limit, min_errors: minErrors, site: activeSite || undefined }),
    refetchInterval: autoRefresh ? 60_000 : false,
    staleTime: 30_000,
  })

  const items = (data?.items || []).filter((r) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      r.hostname.toLowerCase().includes(q) ||
      (r.if_name || '').toLowerCase().includes(q) ||
      r.ip_address.includes(q)
    )
  })

  const totalErrors  = items.reduce((s, r) => s + r.total_err_delta, 0)
  const highestRate  = items.length ? items[0].errors_per_min : 0
  const { isDark }   = useTheme()
  const errC         = mkC(isDark)

  const errorSeverity = (total: number) => {
    if (total >= 100) return { color: '#ef4444', label: 'Kritik' }
    if (total >= 10)  return { color: '#f97316', label: 'Yüksek' }
    if (total >= 1)   return { color: '#eab308', label: 'Düşük' }
    return { color: '#22c55e', label: 'Temiz' }
  }

  const columns = [
    {
      title: '#',
      width: 40,
      render: (_: unknown, __: ErrorInterface, i: number) => (
        <Text type="secondary" style={{ fontSize: 11 }}>{i + 1}</Text>
      ),
    },
    {
      title: 'Cihaz',
      render: (_: unknown, r: ErrorInterface) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{r.hostname}</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 11 }}>{r.ip_address}</Text>
        </div>
      ),
    },
    {
      title: 'Interface',
      render: (_: unknown, r: ErrorInterface) => (
        <Space size={4}>
          <WifiOutlined style={{ opacity: 0.4 }} />
          <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.if_name || `#${r.if_index}`}</Text>
        </Space>
      ),
    },
    {
      title: <Space size={4}><ArrowDownOutlined style={{ color: '#f87171' }} />Giriş Hata</Space>,
      dataIndex: 'in_err_delta',
      width: 120,
      sorter: (a: ErrorInterface, b: ErrorInterface) => b.in_err_delta - a.in_err_delta,
      render: (v: number) => (
        <Text style={{ fontFamily: 'monospace', fontSize: 12, color: v > 0 ? '#f87171' : '#6b7280' }}>
          {v.toLocaleString()}
        </Text>
      ),
    },
    {
      title: <Space size={4}><ArrowUpOutlined style={{ color: '#fb923c' }} />Çıkış Hata</Space>,
      dataIndex: 'out_err_delta',
      width: 120,
      sorter: (a: ErrorInterface, b: ErrorInterface) => b.out_err_delta - a.out_err_delta,
      render: (v: number) => (
        <Text style={{ fontFamily: 'monospace', fontSize: 12, color: v > 0 ? '#fb923c' : '#6b7280' }}>
          {v.toLocaleString()}
        </Text>
      ),
    },
    {
      title: 'Toplam Delta',
      dataIndex: 'total_err_delta',
      width: 110,
      defaultSortOrder: 'descend' as const,
      sorter: (a: ErrorInterface, b: ErrorInterface) => b.total_err_delta - a.total_err_delta,
      render: (v: number) => {
        const sev = errorSeverity(v)
        return (
          <Tag style={{ fontFamily: 'monospace', fontSize: 12, color: sev.color, borderColor: sev.color, background: 'transparent' }}>
            {v.toLocaleString()}
          </Tag>
        )
      },
    },
    {
      title: 'Hata/dk',
      dataIndex: 'errors_per_min',
      width: 90,
      sorter: (a: ErrorInterface, b: ErrorInterface) => b.errors_per_min - a.errors_per_min,
      render: (v: number) => (
        <Text style={{ fontFamily: 'monospace', fontSize: 12, color: v > 1 ? '#f97316' : '#6b7280' }}>
          {v.toFixed(2)}
        </Text>
      ),
    },
    {
      title: 'Toplam Sayaç',
      render: (_: unknown, r: ErrorInterface) => (
        <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>
          {r.in_errors_total.toLocaleString()} / {r.out_errors_total.toLocaleString()}
        </Text>
      ),
    },
    {
      title: 'Son Poll',
      dataIndex: 'polled_at',
      width: 110,
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}>
          <Text type="secondary" style={{ fontSize: 11 }}>{dayjs(v).fromNow()}</Text>
        </Tooltip>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {[
          { label: 'Hatalı Interface', value: items.length, suffix: '', color: items.length > 0 ? '#ef4444' : '#64748b', icon: <AlertOutlined /> },
          { label: 'Toplam Hata (son döngü)', value: totalErrors, suffix: '', color: totalErrors > 0 ? '#f97316' : '#64748b', icon: <WarningOutlined /> },
          { label: 'En Yüksek Oran', value: highestRate.toFixed(2), suffix: '/dk', color: highestRate > 1 ? '#eab308' : '#64748b', icon: <ThunderboltOutlined /> },
          { label: 'Son Güncelleme', value: dataUpdatedAt ? dayjs(dataUpdatedAt).format('HH:mm:ss') : '—', suffix: '', color: '#3b82f6', icon: <ReloadOutlined /> },
        ].map((s) => (
          <div key={s.label} style={{
            flex: 1, minWidth: 140,
            background: isDark ? `linear-gradient(135deg, ${s.color}0d 0%, ${errC.bg} 60%)` : errC.bg,
            border: `1px solid ${s.color}33`,
            borderTop: `2px solid ${s.color}88`,
            borderRadius: 10, padding: '10px 14px',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ color: s.color, fontSize: 16 }}>{s.icon}</span>
            <div>
              <div style={{ color: s.color, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>
                {s.value}{s.suffix && <span style={{ fontSize: 11, fontWeight: 400 }}>{s.suffix}</span>}
              </div>
              <div style={{ color: errC.muted, fontSize: 10, marginTop: 2 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          Her poll döngüsü arasındaki hata counter deltası — 0 delta = temiz interface
        </Text>
        <Space wrap>
          <Input.Search
            placeholder="Cihaz veya interface..."
            style={{ width: 200 }}
            allowClear
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            value={limit}
            onChange={setLimit}
            style={{ width: 110 }}
            options={[
              { value: 20, label: 'Top 20' },
              { value: 50, label: 'Top 50' },
              { value: 100, label: 'Top 100' },
            ]}
          />
          <Space size={4}>
            <Text style={{ fontSize: 12 }}>Min hata:</Text>
            <Select
              value={minErrors}
              onChange={setMinErrors}
              style={{ width: 90 }}
              options={[
                { value: 0,   label: 'Hepsi' },
                { value: 1,   label: '≥1' },
                { value: 10,  label: '≥10' },
                { value: 100, label: '≥100' },
              ]}
            />
          </Space>
          <Space size={4}>
            <Text style={{ fontSize: 12 }}>Oto. Yenile</Text>
            <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
          </Space>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()} loading={isLoading}>Yenile</Button>
        </Space>
      </div>

      <Table<ErrorInterface>
        dataSource={items}
        rowKey={(r) => `${r.device_id}-${r.if_index}`}
        columns={columns}
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25, showSizeChanger: false, showTotal: (n) => `${n} interface` }}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpand: (expanded, r) => {
            const key = `${r.device_id}-${r.if_index}`
            setExpandedKeys(expanded ? [key] : expandedKeys.filter((k) => k !== key))
          },
          expandedRowRender: (r) => (
            <ErrorHistoryChart deviceId={r.device_id} ifIndex={r.if_index} />
          ),
        }}
        locale={{ emptyText: 'Eşiği geçen interface hatası yok' }}
      />
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BandwidthMonitorPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: snmpStatus } = useQuery({
    queryKey: ['snmp-status'],
    queryFn: snmpApi.getStatus,
    refetchInterval: 60_000,
  })

  const pollMutation = useMutation({
    mutationFn: snmpApi.triggerPoll,
    onSuccess: () => {
      message.loading({ content: 'SNMP poll kuyruğa alındı, veriler yükleniyor…', key: 'snmp-poll', duration: 0 })
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['snmp-traffic-rates'] })
        queryClient.invalidateQueries({ queryKey: ['snmp-error-interfaces'] })
        queryClient.invalidateQueries({ queryKey: ['snmp-status'] })
      }, 15_000)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['snmp-traffic-rates'] })
        queryClient.invalidateQueries({ queryKey: ['snmp-error-interfaces'] })
        queryClient.invalidateQueries({ queryKey: ['snmp-status'] })
        message.destroy('snmp-poll')
        message.success('SNMP poll tamamlandı')
      }, 40_000)
    },
    onError: () => message.error('Poll görevi başlatılamadı'),
  })

  const noSnmpEnabled = snmpStatus && snmpStatus.snmp_enabled === 0
  const hasData = snmpStatus && snmpStatus.poll_results > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#06b6d420' : C.border}`,
        borderLeft: '4px solid #06b6d4',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#06b6d420', border: '1px solid #06b6d430',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <DashboardOutlined style={{ color: '#06b6d4', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>Bant Genişliği & Hata Monitörü</div>
            <div style={{ color: C.muted, fontSize: 12 }}>
              Anlık trafik hızı (Mbps) · SNMP counter delta hesabı
            </div>
          </div>
        </div>
        <Space>
          {snmpStatus && (
            <Tag style={{ padding: '4px 10px', color: '#06b6d4', borderColor: '#06b6d450', background: '#06b6d418' }}>
              <WifiOutlined style={{ marginRight: 6 }} />
              {snmpStatus.snmp_enabled}/{snmpStatus.total_devices} cihaz SNMP aktif
              {snmpStatus.last_poll_at && (
                <Text style={{ marginLeft: 8, fontSize: 11, color: C.muted }}>
                  · Son: {dayjs(snmpStatus.last_poll_at).fromNow()}
                </Text>
              )}
            </Tag>
          )}
          <Button
            icon={<ThunderboltOutlined />}
            type="primary"
            loading={pollMutation.isPending}
            onClick={() => pollMutation.mutate()}
          >
            Şimdi Poll Et
          </Button>
          <Button
            icon={<SettingOutlined />}
            onClick={() => navigate('/settings?tab=snmp')}
          >
            SNMP Ayarları
          </Button>
        </Space>
      </div>

      {noSnmpEnabled && (
        <Alert
          type="warning"
          showIcon
          message="SNMP etkinleştirilmemiş"
          description={
            <span>
              Hiçbir cihazda SNMP aktif değil. Veri toplamak için{' '}
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => navigate('/settings?tab=snmp')}>
                SNMP Ayarları
              </Button>
              {' '}sayfasında community string girerek cihazları etkinleştirin, ardından "Şimdi Poll Et" butonuna basın.
            </span>
          }
        />
      )}

      {!noSnmpEnabled && !hasData && snmpStatus && (
        <Alert
          type="info"
          showIcon
          message="Henüz poll verisi yok"
          description='"Şimdi Poll Et" butonuna basarak ilk veri toplamasını başlatın. En az iki poll tamamlanmalıdır.'
        />
      )}

      <Tabs
        items={[
          {
            key: 'traffic',
            label: (
              <Space size={6}>
                <DashboardOutlined />
                Trafik Akışı
              </Space>
            ),
            children: <TrafficTab />,
          },
          {
            key: 'errors',
            label: (
              <Space size={6}>
                <WarningOutlined />
                Interface Hataları
              </Space>
            ),
            children: <ErrorInterfacesTab />,
          },
        ]}
      />
    </div>
  )
}
