import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ReTooltip,
  XAxis,
  YAxis,
  ReferenceLine,
  LineChart,
  Line,
} from 'recharts'
import {
  App,
  Button,
  Drawer,
  Empty,
  Input,
  Progress,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  MinusCircleOutlined,
  ReloadOutlined,
  SafetyOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { securityAuditApi, type AuditFinding, type AuditListItem } from '@/api/securityAudit'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import dayjs from 'dayjs'

const { Text } = Typography

const AUDIT_CSS = `
@keyframes auditScanRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.audit-row-error td { background: rgba(239,68,68,0.04) !important; }
.audit-row-running td { background: rgba(59,130,246,0.04) !important; }
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const GRADE_HEX: Record<string, string> = {
  A: '#22c55e', B: '#86efac', C: '#f59e0b', D: '#f97316', F: '#ef4444',
}

function gradeColor(grade: string) {
  return GRADE_HEX[grade] ?? '#64748b'
}

function gradeTag(grade: string) {
  const hex = gradeColor(grade)
  return (
    <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontWeight: 700, fontSize: 14, padding: '0 10px' }}>
      {grade}
    </Tag>
  )
}

function scoreColor(score: number) {
  if (score >= 90) return '#22c55e'
  if (score >= 70) return '#86efac'
  if (score >= 50) return '#f59e0b'
  if (score >= 30) return '#f97316'
  return '#ef4444'
}

const STATUS_FINDING_HEX: Record<string, string> = {
  pass: '#22c55e', fail: '#ef4444', warning: '#f59e0b', na: '#64748b',
}

function findingIcon(status: AuditFinding['status']) {
  const hex = STATUS_FINDING_HEX[status] ?? '#64748b'
  switch (status) {
    case 'pass':    return <CheckCircleOutlined style={{ color: hex }} />
    case 'fail':    return <CloseCircleOutlined style={{ color: hex }} />
    case 'warning': return <ExclamationCircleOutlined style={{ color: hex }} />
    case 'na':      return <MinusCircleOutlined style={{ color: hex }} />
  }
}

function findingStatusTag(status: AuditFinding['status']) {
  const hex = STATUS_FINDING_HEX[status] ?? '#64748b'
  const label = { pass: 'Geçti', fail: 'Başarısız', warning: 'Uyarı', na: 'N/A' }[status] ?? status
  return (
    <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>
      {label}
    </Tag>
  )
}

// ── Findings Drawer ───────────────────────────────────────────────────────────

function FindingsDrawer({ auditId, onClose }: { auditId: number | null; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)

  const { data, isLoading } = useQuery({
    queryKey: ['audit-detail', auditId],
    queryFn: () => securityAuditApi.detail(auditId!),
    enabled: auditId !== null,
  })

  const grouped = (data?.findings ?? []).reduce<Record<string, AuditFinding[]>>((acc, f) => {
    ;(acc[f.category] ??= []).push(f)
    return acc
  }, {})

  const passCount = (data?.findings ?? []).filter((f) => f.status === 'pass').length

  return (
    <Drawer
      title={
        data ? (
          <Space>
            <SafetyOutlined style={{ color: '#10b981' }} />
            <span style={{ color: C.text }}>{data.device_hostname}</span>
            {gradeTag(data.grade)}
            <Text style={{ fontSize: 13, color: C.muted }}>
              Skor: {data.score}/100
            </Text>
          </Space>
        ) : (
          <span style={{ color: C.text }}>Audit Detayı</span>
        )
      }
      width={600}
      open={auditId !== null}
      onClose={onClose}
      styles={{
        body: { padding: 16, background: C.bg },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
    >
      {isLoading && <div style={{ textAlign: 'center', padding: 40, color: C.muted }}>Yükleniyor...</div>}
      {!isLoading && data && (
        <>
          <div style={{ display: 'flex', gap: 16, marginBottom: 16, alignItems: 'center' }}>
            <Progress
              type="dashboard"
              percent={data.score}
              strokeColor={scoreColor(data.score)}
              trailColor={isDark ? '#334155' : '#e2e8f0'}
              size={90}
              format={(p) => <span style={{ fontSize: 18, fontWeight: 700, color: scoreColor(data.score) }}>{p}</span>}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { hex: '#ef4444', label: `${data.failed_count} başarısız` },
                { hex: '#f59e0b', label: `${data.warning_count} uyarı` },
                { hex: '#22c55e', label: `${passCount} geçti` },
              ].map((item) => (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.hex, flexShrink: 0, display: 'inline-block' }} />
                  <Text style={{ fontSize: 13, color: C.text }}>{item.label}</Text>
                </div>
              ))}
            </div>
          </div>

          {Object.entries(grouped).map(([category, findings]) => (
            <div
              key={category}
              style={{
                marginBottom: 12,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <div style={{
                padding: '8px 14px',
                borderBottom: `1px solid ${C.border}`,
                background: isDark ? '#0f172a' : '#f8fafc',
              }}>
                <Text strong style={{ color: C.text, fontSize: 12 }}>{category}</Text>
              </div>
              {findings.map((f) => (
                <div
                  key={f.id}
                  style={{
                    padding: '10px 14px',
                    borderBottom: `1px solid ${C.border}`,
                    display: 'flex',
                    gap: 10,
                    alignItems: 'flex-start',
                  }}
                >
                  <span style={{ marginTop: 2, fontSize: 16 }}>{findingIcon(f.status)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text strong style={{ fontSize: 13, color: C.text }}>
                        {f.name}
                      </Text>
                      <Space size={4}>
                        {findingStatusTag(f.status)}
                        {f.status !== 'na' && (
                          <Text style={{ fontSize: 11, color: C.muted }}>
                            {f.earned}/{f.weight} puan
                          </Text>
                        )}
                      </Space>
                    </div>
                    <Text style={{ fontSize: 12, color: C.muted, display: 'block', marginTop: 2 }}>
                      {f.detail}
                    </Text>
                    {f.remediation && f.status !== 'pass' && f.status !== 'na' && (
                      <div
                        style={{
                          marginTop: 6,
                          background: isDark ? '#0f172a' : '#f0fdfa',
                          border: `1px solid ${isDark ? '#134e4a' : '#99f6e4'}`,
                          borderRadius: 4,
                          padding: '4px 10px',
                        }}
                      >
                        <code style={{ fontSize: 11, color: isDark ? '#4ec9b0' : '#0d9488', whiteSpace: 'pre-wrap' }}>
                          {f.remediation}
                        </code>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {data.error && (
            <div style={{ padding: '10px 14px', background: '#ef444418', border: '1px solid #ef444450', borderRadius: 8 }}>
              <Text style={{ color: '#ef4444' }}>Hata: {data.error}</Text>
            </div>
          )}
        </>
      )}
    </Drawer>
  )
}

// ── Fleet Trend Chart ─────────────────────────────────────────────────────────

function FleetTrendChart({ activeSite }: { activeSite?: string }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [days, setDays] = useState(30)

  const { data: trend = [], isLoading } = useQuery({
    queryKey: ['audit-fleet-trend', days, activeSite],
    queryFn: () => securityAuditApi.fleetTrend(days, activeSite || undefined),
    staleTime: 300_000,
  })

  const gradeBands = [
    { y1: 90, y2: 100, color: '#22c55e' },
    { y1: 70, y2: 90,  color: '#86efac' },
    { y1: 50, y2: 70,  color: '#f59e0b' },
    { y1: 30, y2: 50,  color: '#f97316' },
    { y1: 0,  y2: 30,  color: '#ef4444' },
  ]

  const latestScore = trend.length ? trend[trend.length - 1].avg_score : null
  const firstScore = trend.length ? trend[0].avg_score : null
  const delta = latestScore !== null && firstScore !== null ? latestScore - firstScore : null

  return (
    <div style={{
      background: C.bg,
      border: `1px solid ${C.border}`,
      borderRadius: 12,
      marginBottom: 16,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 16px',
        borderBottom: `1px solid ${C.border}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: isDark ? '#0f172a' : '#f8fafc',
      }}>
        <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>Filo Uyumluluk Trendi</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {delta !== null && (
            <span style={{ fontSize: 12, color: delta >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
              {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)} pt
            </span>
          )}
          <Select
            size="small"
            value={days}
            onChange={setDays}
            style={{ width: 90 }}
            options={[
              { value: 7, label: '7 Gün' },
              { value: 14, label: '14 Gün' },
              { value: 30, label: '30 Gün' },
              { value: 60, label: '60 Gün' },
              { value: 90, label: '90 Gün' },
            ]}
          />
        </div>
      </div>
      <div style={{ padding: '12px 16px' }}>
        {isLoading && <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: C.muted }}>Yükleniyor…</Text></div>}
        {!isLoading && trend.length === 0 && (
          <Empty description="Henüz tarama verisi yok — ilk taramayı başlatın" style={{ padding: 24 }} />
        )}
        {!isLoading && trend.length > 0 && (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#e2e8f0'} opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.muted }} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: C.muted }} width={28} />
              <ReTooltip
                contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6 }}
                labelStyle={{ color: C.text }}
                formatter={(v: unknown, name: unknown) => {
                  if (name === 'avg_score') return [`${v}`, 'Ort.']
                  if (name === 'min_score') return [`${v}`, 'Min']
                  if (name === 'max_score') return [`${v}`, 'Max']
                  return [`${v}`]
                }}
              />
              <ReferenceLine y={90} stroke="#22c55e" strokeDasharray="4 2" strokeOpacity={0.4} />
              <ReferenceLine y={70} stroke="#f59e0b" strokeDasharray="4 2" strokeOpacity={0.4} />
              <ReferenceLine y={50} stroke="#f97316" strokeDasharray="4 2" strokeOpacity={0.4} />
              <Area type="monotone" dataKey="max_score" stroke="none" fill="#22c55e" fillOpacity={0.06} dot={false} />
              <Area type="monotone" dataKey="min_score" stroke="none" fill="#ef4444" fillOpacity={0.06} dot={false} />
              <Area
                type="monotone"
                dataKey="avg_score"
                stroke="#3b82f6"
                strokeWidth={2}
                fill="url(#scoreGrad)"
                dot={{ r: 3, fill: '#3b82f6' }}
                activeDot={{ r: 5 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
        {!isLoading && trend.length > 0 && (
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11 }}>
            {gradeBands.map((b) => (
              <span key={b.y1} style={{ color: b.color }}>
                {b.y1 === 0 ? 'F <30' : b.y1 === 30 ? 'D 30–50' : b.y1 === 50 ? 'C 50–70' : b.y1 === 70 ? 'B 70–90' : 'A ≥90'}
              </span>
            ))}
            <span style={{ color: C.muted, marginLeft: 'auto' }}>
              Tarama sayısı: {trend.reduce((s, r) => s + r.scan_count, 0)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Per-device history sparkline ─────────────────────────────────────────────

function DeviceHistoryRow({ deviceId }: { deviceId: number }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)

  const { data: history = [], isLoading } = useQuery({
    queryKey: ['audit-device-history', deviceId],
    queryFn: () => securityAuditApi.deviceHistory(deviceId),
    staleTime: 120_000,
  })

  if (isLoading) return <Spin size="small" style={{ display: 'block', padding: 8 }} />
  if (!history.length) return <div style={{ color: C.muted, fontSize: 12, padding: '6px 0' }}>Tarihçe yok</div>

  const sorted = [...history].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const latest = sorted[sorted.length - 1]
  const first = sorted[0]
  const delta = sorted.length > 1 ? latest.score - first.score : 0
  const deltaColor = delta > 0 ? '#22c55e' : delta < 0 ? '#ef4444' : '#64748b'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '4px 0 4px 8px' }}>
      <div style={{ flex: 1, maxWidth: 300, minWidth: 180, height: 48 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={sorted} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Line
              type="monotone"
              dataKey="score"
              stroke={scoreColor(latest.score)}
              strokeWidth={2}
              dot={{ r: 3, fill: scoreColor(latest.score) }}
            />
            <ReTooltip
              contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11 }}
              formatter={(v: unknown) => [`${v}`, 'Skor']}
              labelFormatter={(_, pl) => pl?.[0]?.payload?.created_at ? dayjs(pl[0].payload.created_at).format('DD.MM.YY HH:mm') : ''}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {sorted.slice(-5).reverse().map((h) => (
          <div key={h.id} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: scoreColor(h.score) }}>{h.score}</div>
            <div style={{ fontSize: 10, color: C.dim }}>{dayjs(h.created_at).format('DD.MM')}</div>
          </div>
        ))}
      </div>
      {sorted.length > 1 && (
        <Tag style={{ color: deltaColor, borderColor: deltaColor + '50', background: deltaColor + '18', fontSize: 11 }}>
          {delta > 0 ? '+' : ''}{delta} puan
        </Tag>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SecurityAuditPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const { activeSite } = useSite()
  const [search, setSearch] = useState('')
  const [gradeFilter, setGradeFilter] = useState<string | undefined>()
  const [page, setPage] = useState(1)
  const [selectedAuditId, setSelectedAuditId] = useState<number | null>(null)

  const { data: stats, refetch: refetchStats } = useQuery({
    queryKey: ['audit-stats', activeSite],
    queryFn: () => securityAuditApi.stats({ site: activeSite || undefined }),
  })

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['audit-list', search, gradeFilter, page, activeSite],
    queryFn: () =>
      securityAuditApi.list({ search: search || undefined, grade: gradeFilter, page, page_size: 50, site: activeSite || undefined }),
  })

  const runMutation = useMutation({
    mutationFn: (deviceIds?: number[]) => securityAuditApi.run(deviceIds),
    onSuccess: (res) => {
      message.success(`${res.device_count} cihaz için denetim başlatıldı (Görev #${res.task_id})`)
      setTimeout(() => { refetch(); refetchStats() }, 3000)
    },
    onError: (err: any) => message.error(err?.response?.data?.detail || 'Denetim başlatılamadı'),
  })

  const columns = [
    {
      title: 'Cihaz',
      dataIndex: 'device_hostname',
      render: (h: string) => <Text strong style={{ color: C.text }}>{h}</Text>,
      sorter: (a: AuditListItem, b: AuditListItem) => a.device_hostname.localeCompare(b.device_hostname),
    },
    {
      title: 'Skor',
      dataIndex: 'score',
      width: 180,
      sorter: (a: AuditListItem, b: AuditListItem) => a.score - b.score,
      render: (score: number, row: AuditListItem) => (
        <Space>
          <Progress
            percent={score}
            size="small"
            strokeColor={scoreColor(score)}
            trailColor={isDark ? '#334155' : '#e2e8f0'}
            style={{ width: 90 }}
            format={() => ''}
          />
          <Text style={{ color: scoreColor(score), fontWeight: 600 }}>{score}</Text>
          {gradeTag(row.grade)}
        </Space>
      ),
    },
    {
      title: 'Bulgular',
      render: (_: unknown, row: AuditListItem) => (
        <Space size={4}>
          {row.failed_count > 0 && (
            <Tag style={{ color: '#ef4444', borderColor: '#ef444450', background: '#ef444418', fontSize: 11 }} icon={<CloseCircleOutlined />}>
              {row.failed_count} hata
            </Tag>
          )}
          {row.warning_count > 0 && (
            <Tag style={{ color: '#f59e0b', borderColor: '#f59e0b50', background: '#f59e0b18', fontSize: 11 }} icon={<ExclamationCircleOutlined />}>
              {row.warning_count} uyarı
            </Tag>
          )}
          {row.failed_count === 0 && row.warning_count === 0 && (
            <Tag style={{ color: '#22c55e', borderColor: '#22c55e50', background: '#22c55e18', fontSize: 11 }} icon={<CheckCircleOutlined />}>
              Temiz
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Durum',
      dataIndex: 'status',
      width: 110,
      render: (s: string) => {
        const map: Record<string, string> = { done: '#22c55e', error: '#ef4444', running: '#3b82f6' }
        const label: Record<string, string> = { done: 'Tamam', error: 'Hata', running: 'Çalışıyor' }
        const hex = map[s] ?? '#64748b'
        return (
          <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>
            {label[s] ?? s}
          </Tag>
        )
      },
    },
    {
      title: 'Son Tarama',
      dataIndex: 'created_at',
      width: 160,
      render: (v: string) =>
        v ? new Date(v).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '-',
    },
    {
      title: '',
      width: 130,
      render: (_: unknown, row: AuditListItem) => (
        <Space size={4}>
          <Button size="small" onClick={() => setSelectedAuditId(row.id)}>
            Detay
          </Button>
          <Tooltip title="Bu cihazı yeniden tara">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={runMutation.isPending}
              onClick={(e) => { e.stopPropagation(); runMutation.mutate([row.device_id]) }}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  const statCards = [
    {
      label: 'Denetlenen Cihaz',
      value: stats?.total ?? 0,
      color: '#10b981',
      icon: <SafetyOutlined />,
    },
    {
      label: 'Ortalama Skor',
      value: stats?.avg_score !== undefined ? `${stats.avg_score.toFixed(1)}` : '—',
      color: scoreColor(stats?.avg_score ?? 0),
      suffix: '/ 100',
      icon: <ThunderboltOutlined />,
    },
    {
      label: 'Kritik Bulgular',
      value: stats?.critical_count ?? 0,
      color: (stats?.critical_count ?? 0) > 0 ? '#ef4444' : '#22c55e',
      icon: <CloseCircleOutlined />,
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{AUDIT_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#10b98120' : C.border}`,
        borderLeft: '4px solid #10b981',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#10b98120', border: '1px solid #10b98130',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <SafetyOutlined style={{ color: '#10b981', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>Güvenlik Denetimi</div>
            <div style={{ color: C.muted, fontSize: 12 }}>Cihaz bazlı sertleştirme skoru & bulgular</div>
          </div>
        </div>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          loading={runMutation.isPending}
          onClick={() => runMutation.mutate(undefined)}
          style={{ background: '#10b981', borderColor: '#10b981' }}
        >
          Tümünü Tara
        </Button>
      </div>

      {/* Stat Cards */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {statCards.map((s) => (
          <div key={s.label} style={{
            flex: 1, minWidth: 140,
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
              <div style={{ color: s.color, fontSize: 20, fontWeight: 800, lineHeight: 1 }}>
                {s.value}{s.suffix && <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 4 }}>{s.suffix}</span>}
              </div>
              <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{s.label}</div>
            </div>
          </div>
        ))}

        {/* Grade distribution card */}
        <div style={{
          flex: 1, minWidth: 140,
          background: isDark ? `linear-gradient(135deg, #6366f10d 0%, ${C.bg} 60%)` : C.bg,
          border: `1px solid ${isDark ? '#6366f128' : C.border}`,
          borderTop: isDark ? '2px solid #6366f155' : '2px solid #6366f1',
          borderRadius: 10, padding: '12px 16px',
        }}>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 8 }}>Derece Dağılımı</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {['A', 'B', 'C', 'D', 'F'].map((g) => {
              const hex = gradeColor(g)
              return (
                <Tooltip key={g} title={`${g} derece`}>
                  <Tag
                    style={{
                      color: hex, borderColor: hex + '50', background: hex + '18',
                      cursor: 'pointer', margin: 0, fontWeight: 600, fontSize: 11,
                    }}
                    onClick={() => setGradeFilter(gradeFilter === g ? undefined : g)}
                  >
                    {g}: {stats?.grades?.[g] ?? 0}
                  </Tag>
                </Tooltip>
              )
            })}
          </div>
        </div>
      </div>

      {/* Fleet Trend */}
      <FleetTrendChart activeSite={activeSite || undefined} />

      {/* Toolbar */}
      <Space style={{ marginBottom: 4 }}>
        <Input
          prefix={<SearchOutlined style={{ color: C.muted }} />}
          placeholder="Cihaz ara..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          allowClear
          style={{ width: 240 }}
        />
        <Select
          placeholder="Derece filtrele"
          allowClear
          value={gradeFilter}
          onChange={(v) => { setGradeFilter(v); setPage(1) }}
          style={{ width: 160 }}
          options={['A', 'B', 'C', 'D', 'F'].map((g) => {
            const hex = gradeColor(g)
            return {
              label: (
                <Space>
                  <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', margin: 0, fontWeight: 700 }}>{g}</Tag>
                  Derece {g}
                </Space>
              ),
              value: g,
            }
          })}
        />
        <Button icon={<ReloadOutlined />} onClick={() => { refetch(); refetchStats() }}>
          Yenile
        </Button>
      </Space>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>Denetim Sonuçları</span>
          {data && (
            <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>
              {data.total} cihaz
            </span>
          )}
        </div>
        <Table
          rowKey="id"
          dataSource={data?.items ?? []}
          columns={columns}
          loading={isLoading}
          pagination={{
            total: data?.total,
            pageSize: 50,
            current: page,
            onChange: setPage,
            showTotal: (t) => `${t} kayıt`,
          }}
          expandable={{
            expandedRowRender: (row: AuditListItem) => <DeviceHistoryRow deviceId={row.device_id} />,
          }}
          rowClassName={(row: AuditListItem) =>
            row.status === 'error' ? 'audit-row-error' : row.status === 'running' ? 'audit-row-running' : ''
          }
          onRow={() => ({ style: { animation: 'auditScanRowIn 0.2s ease-out' } })}
          locale={{ emptyText: <Empty description="Henüz denetim yapılmadı — 'Tümünü Tara' ile başlayın" /> }}
          size="small"
        />
      </div>

      <FindingsDrawer
        auditId={selectedAuditId}
        onClose={() => setSelectedAuditId(null)}
      />
    </div>
  )
}
