import { useState, useMemo, useEffect } from 'react'
import {
  Typography, Button, Table, Tag, Progress, Space,
  Tooltip, Collapse, Alert, App, Select,
} from 'antd'
import {
  SafetyOutlined, CheckCircleOutlined, CloseCircleOutlined, WarningOutlined,
  SyncOutlined, ExclamationCircleOutlined, ThunderboltOutlined,
  MinusCircleOutlined, FileExcelOutlined, HistoryOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import { securityAuditApi } from '@/api/securityAudit'
import dayjs from 'dayjs'
import { exportToExcel } from '@/utils/exportExcel'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartTooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell, LabelList,
} from 'recharts'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'

const { Text } = Typography

const COMPLIANCE_CSS = `
@keyframes complianceRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.compliance-row-fail td { background: rgba(239,68,68,0.04) !important; }
.compliance-row-warn td { background: rgba(245,158,11,0.04) !important; }
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

const STORAGE_KEY = 'compliance_scan_results'

function loadCache(): { results: PolicyResult[]; scannedAt: string } | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveCache(results: PolicyResult[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ results, scannedAt: new Date().toISOString() }))
  } catch { /* ignore quota errors */ }
}

interface PolicyResult {
  device_id: number
  hostname: string
  ip: string
  vendor: string
  policy_score: number
  violation_count: number
  critical_count: number
  violations: { rule_id: string; severity: string; description: string }[]
  status: 'compliant' | 'warning' | 'non-compliant' | 'error'
  error?: string
}

function scoreColor(score: number) {
  if (score >= 90) return '#22c55e'
  if (score >= 70) return '#f59e0b'
  return '#ef4444'
}

function scoreStatus(score: number, hasError: boolean): PolicyResult['status'] {
  if (hasError) return 'error'
  if (score >= 90) return 'compliant'
  if (score >= 70) return 'warning'
  return 'non-compliant'
}

const SEVERITY_HEX: Record<string, string> = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' }

export default function ComplianceCheckPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const { activeSite } = useSite()
  const qc = useQueryClient()
  const [results, setResults] = useState<PolicyResult[]>([])
  const [scanning, setScanning] = useState(false)
  const [scannedCount, setScannedCount] = useState(0)
  const [hasScanned, setHasScanned] = useState(false)
  const [lastScannedAt, setLastScannedAt] = useState<string | null>(null)
  const [trendDays, setTrendDays] = useState(30)

  useEffect(() => {
    const cached = loadCache()
    if (cached && cached.results.length > 0) {
      setResults(cached.results)
      setHasScanned(true)
      setScannedCount(cached.results.length)
      setLastScannedAt(cached.scannedAt)
    }
  }, [])

  const { data: trend } = useQuery({
    queryKey: ['compliance-fleet-trend', trendDays, activeSite],
    queryFn: () => securityAuditApi.fleetTrend(trendDays, activeSite || undefined),
    staleTime: 300_000,
  })

  const autoScanMutation = useMutation({
    mutationFn: () => securityAuditApi.run(),
    onSuccess: (res) => {
      message.success(`Otomatik tarama başlatıldı — ${res.device_count} cihaz`)
      qc.invalidateQueries({ queryKey: ['compliance-fleet-trend'] })
    },
    onError: () => message.error('Tarama başlatılamadı'),
  })

  const { data: devicesData } = useQuery({
    queryKey: ['devices-list-compliance', activeSite],
    queryFn: () => devicesApi.list({ limit: 500, site: activeSite || undefined }),
    staleTime: 60_000,
  })

  const devices = devicesData?.items || []

  const runScan = async () => {
    if (devices.length === 0) return
    setScanning(true)
    setScannedCount(0)
    setResults([])
    setHasScanned(true)

    const batchSize = 5
    const newResults: PolicyResult[] = []

    for (let i = 0; i < devices.length; i += batchSize) {
      const batch = devices.slice(i, i + batchSize)
      const batchResults = await Promise.allSettled(
        batch.map((d) => devicesApi.checkConfigPolicy(d.id))
      )
      for (let j = 0; j < batch.length; j++) {
        const d = batch[j]
        const r = batchResults[j]
        if (r.status === 'fulfilled') {
          const v = r.value
          newResults.push({
            device_id: d.id,
            hostname: v.hostname,
            ip: d.ip_address,
            vendor: d.vendor || '',
            policy_score: v.policy_score,
            violation_count: v.violation_count,
            critical_count: v.critical_count,
            violations: v.violations,
            status: scoreStatus(v.policy_score, false),
          })
        } else {
          newResults.push({
            device_id: d.id,
            hostname: d.hostname,
            ip: d.ip_address,
            vendor: d.vendor || '',
            policy_score: 0,
            violation_count: 0,
            critical_count: 0,
            violations: [],
            status: 'error',
            error: 'Bağlantı hatası',
          })
        }
      }
      setScannedCount(Math.min(i + batchSize, devices.length))
      setResults([...newResults])
    }

    setScanning(false)
    saveCache(newResults)
    setLastScannedAt(new Date().toISOString())
    message.success(`Uyumluluk taraması tamamlandı — ${newResults.length} cihaz`)
  }

  const compliant = results.filter((r) => r.status === 'compliant').length
  const warning = results.filter((r) => r.status === 'warning').length
  const nonCompliant = results.filter((r) => r.status === 'non-compliant').length
  const errorCount = results.filter((r) => r.status === 'error').length
  const avgScore = results.length > 0
    ? Math.round(results.filter((r) => r.status !== 'error').reduce((s, r) => s + r.policy_score, 0) / Math.max(results.filter((r) => r.status !== 'error').length, 1))
    : 0

  const scanProgress = devices.length > 0 ? Math.round((scannedCount / devices.length) * 100) : 0

  const allViolations = useMemo(() => {
    const map: Record<string, { rule_id: string; severity: string; description: string; count: number; devices: string[] }> = {}
    for (const r of results) {
      for (const v of r.violations) {
        if (!map[v.rule_id]) map[v.rule_id] = { ...v, count: 0, devices: [] }
        map[v.rule_id].count++
        map[v.rule_id].devices.push(r.hostname)
      }
    }
    return Object.values(map).sort((a, b) => b.count - a.count)
  }, [results])

  const columns = [
    {
      title: 'Cihaz',
      width: 220,
      render: (_: unknown, r: PolicyResult) => (
        <div>
          <Text style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{r.hostname}</Text>
          <div style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>{r.ip}</div>
        </div>
      ),
    },
    {
      title: 'Vendor',
      dataIndex: 'vendor',
      width: 90,
      render: (v: string) => v
        ? <Tag style={{ fontSize: 10, color: '#06b6d4', borderColor: '#06b6d450', background: '#06b6d418' }}>{v}</Tag>
        : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'Puan',
      dataIndex: 'policy_score',
      width: 140,
      sorter: (a: PolicyResult, b: PolicyResult) => a.policy_score - b.policy_score,
      render: (v: number, r: PolicyResult) => r.status === 'error' ? (
        <Text style={{ fontSize: 12, color: C.muted }}>SSH hatası</Text>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Progress
            percent={v}
            size="small"
            showInfo={false}
            strokeColor={scoreColor(v)}
            trailColor={isDark ? '#334155' : '#e2e8f0'}
            style={{ flex: 1, minWidth: 60 }}
          />
          <Text style={{ color: scoreColor(v), fontWeight: 700, fontSize: 13, minWidth: 28 }}>{v}</Text>
        </div>
      ),
    },
    {
      title: 'Durum',
      width: 120,
      sorter: (a: PolicyResult, b: PolicyResult) => {
        const order: Record<string, number> = { error: 0, 'non-compliant': 1, warning: 2, compliant: 3 }
        return order[a.status] - order[b.status]
      },
      render: (_: unknown, r: PolicyResult) => {
        const map: Record<string, { hex: string; label: string; icon: React.ReactNode }> = {
          compliant:     { hex: '#22c55e', label: 'Uyumlu', icon: <CheckCircleOutlined /> },
          warning:       { hex: '#f59e0b', label: 'Uyarı', icon: <WarningOutlined /> },
          'non-compliant': { hex: '#ef4444', label: 'Uyumsuz', icon: <CloseCircleOutlined /> },
          error:         { hex: '#64748b', label: 'Hata', icon: <MinusCircleOutlined /> },
        }
        const { hex, label, icon } = map[r.status] ?? { hex: '#64748b', label: r.status, icon: null }
        return (
          <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }} icon={icon}>
            {label}
          </Tag>
        )
      },
    },
    {
      title: 'İhlaller',
      width: 130,
      sorter: (a: PolicyResult, b: PolicyResult) => a.violation_count - b.violation_count,
      render: (_: unknown, r: PolicyResult) => r.status === 'error' ? (
        <Text style={{ color: C.dim }}>—</Text>
      ) : (
        <Space size={4}>
          {r.critical_count > 0 && (
            <Tag style={{ color: '#ef4444', borderColor: '#ef444450', background: '#ef444418', fontSize: 11 }}>
              {r.critical_count} kritik
            </Tag>
          )}
          {r.violation_count - r.critical_count > 0 && (
            <Tag style={{ color: '#f59e0b', borderColor: '#f59e0b50', background: '#f59e0b18', fontSize: 11 }}>
              {r.violation_count - r.critical_count} uyarı
            </Tag>
          )}
          {r.violation_count === 0 && <Text style={{ fontSize: 12, color: C.dim }}>—</Text>}
        </Space>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{COMPLIANCE_CSS}</style>

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
            <SafetyOutlined style={{ color: '#3b82f6', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>Uyumluluk Denetimi</div>
            <div style={{ color: C.muted, fontSize: 12 }}>
              Konfigürasyon politika kontrolü — {devices.length} cihaz
              {lastScannedAt && !scanning && (
                <span style={{ marginLeft: 10 }}>· Son tarama: {dayjs(lastScannedAt).fromNow()}</span>
              )}
            </div>
          </div>
        </div>
        <Space>
          {hasScanned && results.length > 0 && (
            <Button
              icon={<FileExcelOutlined />}
              style={{ color: '#22c55e', borderColor: '#22c55e' }}
              size="small"
              onClick={() => exportToExcel([
                {
                  name: 'Uyumluluk Sonuçları',
                  data: results.map((r) => ({
                    'Hostname': r.hostname,
                    'IP': r.ip,
                    'Vendor': r.vendor,
                    'Politika Puanı': r.status === 'error' ? '' : r.policy_score,
                    'Durum': r.status === 'compliant' ? 'Uyumlu' : r.status === 'warning' ? 'Uyarı' : r.status === 'non-compliant' ? 'Uyumsuz' : 'Hata',
                    'İhlal Sayısı': r.violation_count,
                    'Kritik İhlal': r.critical_count,
                    'Hata': r.error || '',
                  })),
                },
                {
                  name: 'İhlal Detayları',
                  data: results.flatMap((r) => r.violations.map((v) => ({
                    'Hostname': r.hostname,
                    'IP': r.ip,
                    'Kural ID': v.rule_id,
                    'Önem': v.severity,
                    'Açıklama': v.description,
                  }))),
                },
              ], `uyumluluk_${dayjs().format('YYYY-MM-DD')}`)}
            >
              Excel
            </Button>
          )}
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={scanning}
            onClick={runScan}
            disabled={devices.length === 0}
            style={{ background: '#3b82f6', borderColor: '#3b82f6' }}
          >
            {scanning ? `Tarıyor... (${scannedCount}/${devices.length})` : hasScanned ? 'Yeniden Tara' : 'Tarama Başlat'}
          </Button>
        </Space>
      </div>

      {/* Trend Chart */}
      {trend && trend.length > 0 && (
        <div style={{
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '10px 16px',
            borderBottom: `1px solid ${C.border}`,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            background: isDark ? '#0f172a' : '#f8fafc',
          }}>
            <Space>
              <HistoryOutlined style={{ color: '#3b82f6' }} />
              <Text style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Haftalık Otomatik Tarama Trendi</Text>
              <Select
                size="small"
                value={trendDays}
                onChange={setTrendDays}
                style={{ width: 110 }}
                options={[
                  { value: 7, label: 'Son 7 gün' },
                  { value: 14, label: 'Son 14 gün' },
                  { value: 30, label: 'Son 30 gün' },
                  { value: 60, label: 'Son 60 gün' },
                ]}
              />
            </Space>
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              loading={autoScanMutation.isPending}
              onClick={() => autoScanMutation.mutate()}
            >
              Otomatik Tarama Başlat
            </Button>
          </div>
          <div style={{ padding: '12px 16px' }}>
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="complianceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#e2e8f0'} opacity={0.5} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.muted }} tickFormatter={(v) => dayjs(v).format('DD/MM')} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: C.muted }} />
                <RechartTooltip
                  contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6 }}
                  labelStyle={{ color: C.text }}
                  formatter={(v: unknown) => [`${v}`, 'Ort. Puan']}
                  labelFormatter={(l) => dayjs(l as string).format('DD MMM YYYY')}
                />
                <ReferenceLine y={90} stroke="#22c55e" strokeDasharray="4 2" label={{ value: 'A', position: 'right', fontSize: 10, fill: '#22c55e' }} />
                <ReferenceLine y={70} stroke="#f59e0b" strokeDasharray="4 2" label={{ value: 'B', position: 'right', fontSize: 10, fill: '#f59e0b' }} />
                <Area type="monotone" dataKey="avg_score" stroke="#3b82f6" fill="url(#complianceGrad)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
              Son tarama: {dayjs(trend[trend.length - 1].date).format('DD MMM YYYY')} · {trend[trend.length - 1].scan_count} cihaz tarandı · Ort. puan: {trend[trend.length - 1].avg_score}
            </div>
          </div>
        </div>
      )}

      {/* Scan progress */}
      {scanning && (
        <Alert
          type="info"
          showIcon
          icon={<SyncOutlined spin />}
          message={`Taranıyor: ${scannedCount} / ${devices.length} cihaz`}
          description={<Progress percent={scanProgress} size="small" strokeColor="#3b82f6" />}
        />
      )}

      {/* Stat Cards */}
      {hasScanned && results.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            { label: 'Ort. Puan', value: avgScore, suffix: '/100', color: scoreColor(avgScore), icon: <SafetyOutlined /> },
            { label: 'Uyumlu', value: compliant, color: '#22c55e', icon: <CheckCircleOutlined /> },
            { label: 'Uyarı', value: warning, color: warning > 0 ? '#f59e0b' : '#64748b', icon: <WarningOutlined /> },
            { label: 'Uyumsuz', value: nonCompliant, color: nonCompliant > 0 ? '#ef4444' : '#64748b', icon: <CloseCircleOutlined /> },
            ...(errorCount > 0 ? [{ label: 'Ulaşılamadı', value: errorCount, color: '#64748b', icon: <MinusCircleOutlined /> }] : []),
          ].map((s) => (
            <div key={s.label} style={{
              flex: 1, minWidth: 110,
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
                  {s.value}{'suffix' in s && <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 4 }}>{s.suffix}</span>}
                </div>
                <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{s.label}</div>
              </div>
            </div>
          ))}
          {/* Compliance rate card */}
          <div style={{
            flex: 1, minWidth: 110,
            background: isDark ? `linear-gradient(135deg, #22c55e0d 0%, ${C.bg} 60%)` : C.bg,
            border: `1px solid ${isDark ? '#22c55e28' : C.border}`,
            borderTop: isDark ? '2px solid #22c55e55' : '2px solid #22c55e',
            borderRadius: 10, padding: '12px 16px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <Text style={{ fontSize: 10, color: C.muted }}>Uyumluluk</Text>
              <Text style={{ fontWeight: 700, fontSize: 13, color: '#22c55e' }}>
                {results.length > 0 ? Math.round(compliant / results.length * 100) : 0}%
              </Text>
            </div>
            <Progress
              percent={results.length > 0 ? Math.round(compliant / results.length * 100) : 0}
              size="small"
              showInfo={false}
              strokeColor="#22c55e"
              trailColor={isDark ? '#334155' : '#e2e8f0'}
            />
          </div>
        </div>
      )}

      {/* Most common violations */}
      {allViolations.length > 0 && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
          {/* Panel header */}
          <div style={{
            padding: '10px 16px',
            borderBottom: `1px solid ${C.border}`,
            background: isDark ? '#0f172a' : '#f8fafc',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <ExclamationCircleOutlined style={{ color: '#f59e0b' }} />
            <Text style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
              En Sık İhlaller
            </Text>
            <Text style={{ fontSize: 12, color: C.muted }}>({allViolations.length} kural)</Text>
          </div>

          {/* Horizontal bar chart — top 10 */}
          <div style={{ padding: '12px 16px 0' }}>
            <ResponsiveContainer width="100%" height={Math.min(allViolations.length, 10) * 34 + 16}>
              <BarChart
                layout="vertical"
                data={allViolations.slice(0, 10).map((v) => ({
                  name: v.rule_id,
                  count: v.count,
                  severity: v.severity,
                }))}
                margin={{ top: 0, right: 48, bottom: 0, left: 8 }}
              >
                <XAxis type="number" tick={{ fontSize: 10, fill: C.muted }} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={160}
                  tick={{ fontSize: 11, fill: C.muted, fontFamily: 'monospace' }}
                />
                <RechartTooltip
                  contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: C.text, fontFamily: 'monospace' }}
                  formatter={(v: unknown, _n: unknown, entry: any) => [
                    `${v} cihaz (${entry?.payload?.severity ?? ''})`,
                    'Etkilenen',
                  ]}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={22}>
                  {allViolations.slice(0, 10).map((v, i) => (
                    <Cell
                      key={i}
                      fill={v.severity === 'critical' ? '#ef4444' : v.severity === 'warning' ? '#f59e0b' : '#3b82f6'}
                      fillOpacity={0.85}
                    />
                  ))}
                  <LabelList dataKey="count" position="right" style={{ fontSize: 11, fill: C.muted }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Violations detail table */}
          <Collapse
            size="small"
            ghost
            style={{ margin: '8px 8px 0' }}
            items={[{
              key: 'detail',
              label: <span style={{ color: C.muted, fontSize: 12 }}>Tüm ihlalleri göster</span>,
              children: (
                <Table
                  dataSource={allViolations}
                  rowKey="rule_id"
                  size="small"
                  pagination={false}
                  style={{ marginTop: 0 }}
                  columns={[
                    {
                      title: 'Kural',
                      dataIndex: 'rule_id',
                      width: 180,
                      render: (v: string) => (
                        <code style={{ fontSize: 11, background: isDark ? '#0f172a' : '#f0fdfa', color: isDark ? '#4ec9b0' : '#0d9488', padding: '1px 6px', borderRadius: 3 }}>
                          {v}
                        </code>
                      ),
                    },
                    {
                      title: 'Önem',
                      dataIndex: 'severity',
                      width: 90,
                      render: (v: string) => {
                        const hex = SEVERITY_HEX[v] ?? '#64748b'
                        return <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>{v}</Tag>
                      },
                    },
                    { title: 'Açıklama', dataIndex: 'description', render: (v: string) => <Text style={{ fontSize: 12, color: C.text }}>{v}</Text> },
                    {
                      title: 'Etkilenen',
                      dataIndex: 'count',
                      width: 90,
                      sorter: (a: typeof allViolations[0], b: typeof allViolations[0]) => a.count - b.count,
                      render: (v: number, r: typeof allViolations[0]) => (
                        <Tooltip title={r.devices.join(', ')}>
                          <Tag style={{ color: '#f59e0b', borderColor: '#f59e0b50', background: '#f59e0b18', fontWeight: 700, fontSize: 12 }}>
                            {v}
                          </Tag>
                        </Tooltip>
                      ),
                    },
                  ]}
                />
              ),
            }]}
          />
          <div style={{ height: 8 }} />
        </div>
      )}

      {/* Results table */}
      {!hasScanned ? (
        <div style={{
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12,
          textAlign: 'center', padding: '48px 24px',
        }}>
          <SafetyOutlined style={{ fontSize: 48, color: C.dim, marginBottom: 16 }} />
          <div>
            <Text style={{ fontSize: 15, display: 'block', marginBottom: 8, color: C.muted }}>
              Uyumluluk taraması henüz çalıştırılmadı
            </Text>
            <Text style={{ fontSize: 13, color: C.dim }}>
              "Tarama Başlat" butonuna tıklayarak {devices.length} cihazın konfigürasyon politika uyumluluğunu kontrol edin.
            </Text>
          </div>
        </div>
      ) : (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
            <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>Tarama Sonuçları</span>
            <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>{results.length} cihaz</span>
          </div>
          <Table<PolicyResult>
            dataSource={results}
            rowKey="device_id"
            columns={columns}
            size="small"
            loading={scanning && results.length === 0}
            pagination={{ pageSize: 50, showTotal: (n) => `${n} cihaz`, showSizeChanger: false }}
            onRow={() => ({ style: { animation: 'complianceRowIn 0.2s ease-out' } })}
            expandable={{
              expandedRowRender: (r) => {
                if (r.status === 'error') {
                  return <Alert type="error" showIcon message={r.error || 'SSH bağlantı hatası'} style={{ margin: '8px 0' }} />
                }
                if (r.violations.length === 0) {
                  return (
                    <div style={{ padding: '8px 0', color: '#22c55e', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <CheckCircleOutlined /> Politika ihlali bulunamadı — cihaz tamamen uyumlu
                    </div>
                  )
                }
                return (
                  <Table
                    dataSource={r.violations}
                    rowKey="rule_id"
                    size="small"
                    pagination={false}
                    style={{ margin: '8px 0' }}
                    columns={[
                      {
                        title: 'Kural ID',
                        dataIndex: 'rule_id',
                        width: 180,
                        render: (v: string) => (
                          <code style={{ fontSize: 11, background: isDark ? '#0f172a' : '#f0fdfa', color: isDark ? '#4ec9b0' : '#0d9488', padding: '1px 6px', borderRadius: 3 }}>
                            {v}
                          </code>
                        ),
                      },
                      {
                        title: 'Önem',
                        dataIndex: 'severity',
                        width: 90,
                        render: (v: string) => {
                          const hex = SEVERITY_HEX[v] ?? '#64748b'
                          return <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>{v}</Tag>
                        },
                      },
                      { title: 'Açıklama', dataIndex: 'description', render: (v: string) => <Text style={{ fontSize: 12, color: C.text }}>{v}</Text> },
                    ]}
                  />
                )
              },
            }}
            rowClassName={(r) =>
              r.status === 'non-compliant' ? 'compliance-row-fail'
              : r.status === 'warning' ? 'compliance-row-warn' : ''
            }
          />
        </div>
      )}
    </div>
  )
}
