import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Typography, Table, Tag, Select, Space, Tooltip, Progress, Spin, Button,
} from 'antd'
import {
  RiseOutlined, ArrowUpOutlined, ArrowDownOutlined, WarningOutlined,
  FileExcelOutlined, CheckCircleOutlined, CloseCircleOutlined, BarChartOutlined,
} from '@ant-design/icons'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, Cell, AreaChart, Area,
} from 'recharts'
import { slaApi, type UptimeDevice, type DeviceUptimeDetail } from '@/api/sla'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import { exportToExcel } from '@/utils/exportExcel'
import dayjs from 'dayjs'

const { Text } = Typography

const SLA_CSS = `
@keyframes slaRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
`

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

function uptimeColor(pct: number): string {
  if (pct >= 99) return '#22c55e'
  if (pct >= 95) return '#f59e0b'
  return '#ef4444'
}

function uptimeTag(pct: number) {
  const hex = uptimeColor(pct)
  return (
    <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontWeight: 600, fontSize: 11 }}>
      %{pct.toFixed(2)}
    </Tag>
  )
}

function downtimeStr(minutes: number): string {
  if (minutes === 0) return '—'
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h > 0 ? `${h}s ${m}d` : `${m}d`
}

// ── Daily uptime detail (expandable row) ──────────────────────────────────────
function DailyUptimeChart({ deviceId, windowDays, isDark }: {
  deviceId: number; windowDays: number; isDark: boolean
}) {
  const C = mkC(isDark)
  const { data, isLoading } = useQuery<DeviceUptimeDetail>({
    queryKey: ['sla-device-detail', deviceId, windowDays],
    queryFn: () => slaApi.getDeviceUptime(deviceId, windowDays),
    staleTime: 120_000,
  })

  if (isLoading) return <div style={{ padding: 16 }}><Spin size="small" /></div>
  if (!data || !data.daily?.length) {
    return <div style={{ padding: '12px 24px', color: C.muted, fontSize: 12 }}>Günlük veri yok</div>
  }

  const points = data.daily.map((d) => ({
    date: dayjs(d.date).format('DD/MM'),
    pct: d.uptime_pct,
  }))

  return (
    <div style={{ padding: '12px 24px 16px' }}>
      <Text style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 8 }}>
        Günlük uptime dağılımı — {data.window_days} günlük pencere · Genel: %{data.overall_uptime_pct.toFixed(2)} · Toplam downtime: {downtimeStr(data.downtime_minutes)}
      </Text>
      <ResponsiveContainer width="100%" height={100}>
        <AreaChart data={points} margin={{ top: 2, right: 8, left: -28, bottom: 0 }}>
          <defs>
            <linearGradient id="slaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 2" stroke={isDark ? '#1a3458' : '#f1f5f9'} />
          <XAxis dataKey="date" tick={{ fontSize: 9 }} interval={Math.floor(points.length / 8)} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 9 }} tickFormatter={(v) => `${v}%`} />
          <RTooltip
            contentStyle={{ background: isDark ? '#1e293b' : '#fff', border: `1px solid ${C.border}`, fontSize: 12 }}
            formatter={(v: unknown) => `%${Number(v).toFixed(1)}`}
          />
          <Area
            type="monotone"
            dataKey="pct"
            stroke="#3b82f6"
            fill="url(#slaGrad)"
            strokeWidth={1.5}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Worst performers chart ────────────────────────────────────────────────────
function WorstPerformersChart({ devices, isDark }: {
  devices: { hostname: string; device_id: number; uptime_pct: number }[]
  isDark: boolean
}) {
  const C = mkC(isDark)
  if (!devices.length) return null

  const data = devices.map((d) => ({
    name: d.hostname.length > 16 ? d.hostname.slice(0, 15) + '…' : d.hostname,
    uptime: d.uptime_pct,
    downtime: parseFloat((100 - d.uptime_pct).toFixed(3)),
  }))

  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{
        padding: '10px 16px', borderBottom: `1px solid ${C.border}`,
        background: isDark ? '#0f172a' : '#f8fafc',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <BarChartOutlined style={{ color: '#ef4444' }} />
        <Text style={{ fontWeight: 600, fontSize: 13, color: C.text }}>En Düşük Uptime — İlk {data.length} Cihaz</Text>
        <Text style={{ fontSize: 11, color: C.muted, marginLeft: 4 }}>/ Downtime yüzdesi</Text>
      </div>
      <div style={{ padding: '12px 16px' }}>
        <ResponsiveContainer width="100%" height={Math.max(120, data.length * 28)}>
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="2 2" stroke={isDark ? '#1a3458' : '#f1f5f9'} horizontal={false} />
            <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} tickFormatter={(v) => `%${v}`} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={140} />
            <RTooltip
              contentStyle={{ background: isDark ? '#1e293b' : '#fff', border: `1px solid ${C.border}`, fontSize: 12 }}
              formatter={(v: unknown) => `%${Number(v).toFixed(3)}`}
            />
            <Bar dataKey="uptime" name="uptime" radius={[0, 3, 3, 0]} maxBarSize={18}>
              {data.map((d, i) => (
                <Cell key={i} fill={uptimeColor(d.uptime)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ── SLA compliance section ────────────────────────────────────────────────────
function SlaComplianceSection({ isDark }: { isDark: boolean }) {
  const C = mkC(isDark)
  const { data, isLoading } = useQuery({
    queryKey: ['sla-compliance'],
    queryFn: slaApi.getCompliance,
    staleTime: 60_000,
  })

  if (isLoading) return null
  if (!data?.length) return null

  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{
        padding: '10px 16px', borderBottom: `1px solid ${C.border}`,
        background: isDark ? '#0f172a' : '#f8fafc',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <CheckCircleOutlined style={{ color: '#22c55e' }} />
        <Text style={{ fontWeight: 600, fontSize: 13, color: C.text }}>SLA Politika Uyumu</Text>
        <Text style={{ fontSize: 11, color: C.muted }}>{data.length} politika</Text>
      </div>
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data.map((p) => {
          const isOk = p.compliance_pct >= 100
          const color = isOk ? '#22c55e' : p.compliance_pct >= 80 ? '#f59e0b' : '#ef4444'
          return (
            <div key={p.policy_id} style={{
              background: isDark ? `${color}08` : `${color}06`,
              border: `1px solid ${color}30`,
              borderLeft: `3px solid ${color}`,
              borderRadius: 8,
              padding: '10px 14px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <Text style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{p.policy_name}</Text>
                <Tag style={{ color, borderColor: color + '50', background: color + '18', fontSize: 11 }}>
                  Hedef: %{p.target_uptime_pct}
                </Tag>
                {isOk
                  ? <Tag icon={<CheckCircleOutlined />} color="green">Uyumlu</Tag>
                  : <Tag icon={<CloseCircleOutlined />} color="red">{p.breach_count} ihlal</Tag>
                }
                <Text style={{ marginLeft: 'auto', color: C.muted, fontSize: 11 }}>
                  {p.compliant_count}/{p.total_devices} cihaz · {p.window_days}g
                </Text>
              </div>
              <Progress
                percent={p.compliance_pct}
                strokeColor={color}
                trailColor={isDark ? '#334155' : '#e2e8f0'}
                size="small"
                format={(pct) => <span style={{ color, fontSize: 11 }}>%{(pct ?? 0).toFixed(0)} uyum</span>}
              />
              {p.breach_count > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {p.breaches.slice(0, 8).map((b) => (
                    <Tooltip key={b.device_id} title={`Uptime: %${b.uptime_pct.toFixed(2)} (Hedef: %${b.target_pct})`}>
                      <Tag style={{ color: '#f87171', borderColor: '#f8717150', background: '#f8717110', fontSize: 10, cursor: 'default' }}>
                        {b.hostname}
                      </Tag>
                    </Tooltip>
                  ))}
                  {p.breach_count > 8 && (
                    <Text style={{ fontSize: 10, color: C.muted }}>+{p.breach_count - 8} daha</Text>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SlaReportPage() {
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const [windowDays, setWindowDays] = useState(30)
  const [expandedKeys, setExpandedKeys] = useState<number[]>([])

  const { data: report, isLoading } = useQuery({
    queryKey: ['sla-report', windowDays, activeSite],
    queryFn: () => slaApi.getReport(windowDays, undefined, activeSite || undefined),
  })

  const { data: fleet } = useQuery({
    queryKey: ['sla-fleet-summary', windowDays, activeSite],
    queryFn: () => slaApi.getFleetSummary(windowDays, activeSite || undefined),
  })

  const columns = [
    {
      title: 'Cihaz',
      dataIndex: 'hostname',
      render: (v: string) => <strong style={{ color: C.text }}>{v}</strong>,
      sorter: (a: UptimeDevice, b: UptimeDevice) => a.hostname.localeCompare(b.hostname),
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      render: (v: string) => (
        <code style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>{v}</code>
      ),
    },
    {
      title: 'Vendor',
      dataIndex: 'vendor',
      render: (v: string | null) => v
        ? <Tag style={{ fontSize: 10, color: '#06b6d4', borderColor: '#06b6d450', background: '#06b6d418' }}>{v}</Tag>
        : <Text style={{ color: C.dim }}>—</Text>,
      filters: [...new Set(report?.devices.map((d) => d.vendor).filter(Boolean))].map((v) => ({
        text: v as string, value: v as string,
      })),
      onFilter: (value: unknown, record: UptimeDevice) => record.vendor === value,
    },
    {
      title: 'Konum',
      dataIndex: 'location',
      render: (v: string | null) => v || <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: `Uptime (${windowDays}g)`,
      dataIndex: 'uptime_pct',
      width: 200,
      sorter: (a: UptimeDevice, b: UptimeDevice) => a.uptime_pct - b.uptime_pct,
      defaultSortOrder: 'ascend' as const,
      render: (v: number) => (
        <Space>
          {uptimeTag(v)}
          <Progress
            percent={v}
            showInfo={false}
            strokeColor={uptimeColor(v)}
            trailColor={isDark ? '#334155' : '#e2e8f0'}
            size="small"
            style={{ width: 80 }}
          />
        </Space>
      ),
    },
    {
      title: 'Downtime',
      dataIndex: 'downtime_minutes',
      width: 100,
      sorter: (a: UptimeDevice, b: UptimeDevice) => b.downtime_minutes - a.downtime_minutes,
      render: (v: number) => {
        if (v === 0) return <Text style={{ color: C.dim }}>—</Text>
        return (
          <Tooltip title={`${v} dakika`}>
            <Text style={{ color: v > 120 ? '#ef4444' : '#f59e0b', fontSize: 12 }}>
              <WarningOutlined style={{ marginRight: 4 }} />
              {downtimeStr(v)}
            </Text>
          </Tooltip>
        )
      },
    },
    {
      title: 'SLA',
      width: 80,
      render: (_: unknown, r: UptimeDevice) => {
        const ok = r.uptime_pct >= 99.9
        const warn = r.uptime_pct >= 99
        return ok
          ? <Tag icon={<CheckCircleOutlined />} color="green" style={{ fontSize: 10 }}>%99.9</Tag>
          : warn
          ? <Tag icon={<WarningOutlined />} color="orange" style={{ fontSize: 10 }}>%99</Tag>
          : <Tag icon={<CloseCircleOutlined />} color="red" style={{ fontSize: 10 }}>İhlal</Tag>
      },
    },
  ]

  const worstDevices = fleet?.worst_devices ?? []
  const hasCompliance = true

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{SLA_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#3b82f620' : C.border}`,
        borderLeft: '4px solid #3b82f6',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#3b82f620', border: '1px solid #3b82f630',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <RiseOutlined style={{ color: '#3b82f6', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>SLA & Uptime Raporu</div>
            <div style={{ color: C.muted, fontSize: 12 }}>Cihaz bazlı uptime analizi · Satıra tıkla → günlük grafik</div>
          </div>
        </div>
        <Space>
          <Button
            icon={<FileExcelOutlined />}
            style={{ color: '#22c55e', borderColor: '#22c55e' }}
            disabled={!report?.devices?.length}
            size="small"
            onClick={() => report?.devices && exportToExcel([{
              name: 'SLA Raporu',
              data: report.devices.map((d) => ({
                'Hostname': d.hostname,
                'IP': d.ip,
                'Vendor': d.vendor || '',
                'Konum': d.location || '',
                [`Uptime % (${windowDays}g)`]: d.uptime_pct,
                'Downtime (dk)': d.downtime_minutes,
              })),
            }], `sla_raporu_${windowDays}g`)}
          >
            Excel
          </Button>
          <Select
            value={windowDays}
            onChange={setWindowDays}
            size="small"
            style={{ width: 140 }}
            options={[
              { value: 7, label: 'Son 7 gün' },
              { value: 14, label: 'Son 14 gün' },
              { value: 30, label: 'Son 30 gün' },
              { value: 60, label: 'Son 60 gün' },
              { value: 90, label: 'Son 90 gün' },
            ]}
          />
        </Space>
      </div>

      {/* Fleet stat cards */}
      {fleet && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            { label: 'Ortalama Uptime', value: `%${fleet.avg_uptime_pct.toFixed(2)}`, color: uptimeColor(fleet.avg_uptime_pct), icon: <RiseOutlined /> },
            { label: '≥%99 Uptime', value: `${fleet.above_99} / ${fleet.total}`, color: '#22c55e', icon: <ArrowUpOutlined /> },
            { label: '%95–99 Uptime', value: `${fleet.above_95} cihaz`, color: '#f59e0b', icon: <ArrowUpOutlined /> },
            { label: '<%95 Uptime', value: `${fleet.below_95} cihaz`, color: fleet.below_95 > 0 ? '#ef4444' : '#64748b', icon: <ArrowDownOutlined /> },
          ].map((s) => (
            <div key={s.label} style={{
              flex: 1, minWidth: 120,
              background: isDark ? `linear-gradient(135deg, ${s.color}0d 0%, ${C.bg} 60%)` : C.bg,
              border: `1px solid ${isDark ? s.color + '28' : C.border}`,
              borderTop: isDark ? `2px solid ${s.color}55` : `2px solid ${s.color}`,
              borderRadius: 10, padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: isDark ? `${s.color}20` : `${s.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ color: s.color, fontSize: 14 }}>{s.icon}</span>
              </div>
              <div>
                <div style={{ color: s.color, fontSize: 20, fontWeight: 800, lineHeight: 1 }}>{s.value}</div>
                <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{s.label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Worst performers chart */}
      {worstDevices.length > 0 && (
        <WorstPerformersChart devices={worstDevices} isDark={isDark} />
      )}

      {/* SLA Compliance */}
      {hasCompliance && <SlaComplianceSection isDark={isDark} />}

      {/* Device table */}
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>Cihaz Uptime Detayı</span>
          {report && (
            <span style={{ fontSize: 12, color: C.muted }}>
              {report.devices.length} cihaz · {report.window_days} günlük pencere
            </span>
          )}
          <Text style={{ fontSize: 11, color: C.dim, marginLeft: 4 }}>· satırı genişlet → günlük grafik</Text>
        </div>
        <Spin spinning={isLoading}>
          <Table<UptimeDevice>
            dataSource={report?.devices ?? []}
            columns={columns}
            rowKey="device_id"
            size="small"
            pagination={{ pageSize: 50, showSizeChanger: true }}
            onRow={() => ({ style: { animation: 'slaRowIn 0.2s ease-out' } })}
            style={{ minHeight: 200 }}
            expandable={{
              expandedRowKeys: expandedKeys,
              onExpand: (expanded, record) => {
                setExpandedKeys(expanded
                  ? [...expandedKeys, record.device_id]
                  : expandedKeys.filter((k) => k !== record.device_id)
                )
              },
              expandedRowRender: (record) => (
                <DailyUptimeChart
                  deviceId={record.device_id}
                  windowDays={windowDays}
                  isDark={isDark}
                />
              ),
            }}
          />
        </Spin>
      </div>
    </div>
  )
}
