import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Badge, Button, Card, Col, Modal, Row, Spin, Table, Tag, Tooltip, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, DiffOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { backupSchedulesApi, type DriftDiff, type DriftItem } from '@/api/backupSchedules'
import { useTheme } from '@/contexts/ThemeContext'

const { Title, Text } = Typography

// ── Inline diff helpers ───────────────────────────────────────────────────────
type DiffEntry = { type: 'same' | 'added' | 'removed'; text: string; lineA: number | null; lineB: number | null }

function diffLines(a: string[], b: string[]): DiffEntry[] {
  const MAX = 1500
  const aS = a.slice(0, MAX), bS = b.slice(0, MAX)
  const m = aS.length, n = bS.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = aS[i-1] === bS[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1])
  const raw: { type: 'same' | 'added' | 'removed'; text: string }[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aS[i-1] === bS[j-1]) { raw.unshift({ type: 'same', text: aS[i-1] }); i--; j-- }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { raw.unshift({ type: 'added', text: bS[j-1] }); j-- }
    else { raw.unshift({ type: 'removed', text: aS[i-1] }); i-- }
  }
  for (let k = m; k < a.length; k++) raw.push({ type: 'removed', text: a[k] })
  for (let k = n; k < b.length; k++) raw.push({ type: 'added', text: b[k] })
  let lA = 0, lB = 0
  return raw.map((r) => {
    if (r.type === 'same')    { lA++; lB++; return { ...r, lineA: lA, lineB: lB } }
    if (r.type === 'removed') { lA++;        return { ...r, lineA: lA, lineB: null } }
    lB++; return { ...r, lineA: null, lineB: lB }
  })
}

function DiffModal({ open, onClose, diff, hostname, isDark }: {
  open: boolean; onClose: () => void; diff: DriftDiff | null; hostname: string; isDark: boolean
}) {
  const bg   = isDark ? '#0a0f1a' : '#f8fafc'
  const bdr  = isDark ? '#1a3458' : '#e2e8f0'
  const entries = diff
    ? diffLines(diff.golden_text.split('\n'), diff.latest_text.split('\n'))
    : []
  const changed = entries.filter(e => e.type !== 'same')

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={<span style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>Config Drift: {hostname}</span>}
      footer={<Button onClick={onClose}>Kapat</Button>}
      width={900}
      styles={{ body: { padding: 0 } }}
    >
      {!diff ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : (
        <>
          <div style={{ padding: '8px 16px', background: isDark ? '#0d1b2a' : '#f1f5f9', display: 'flex', gap: 24, fontSize: 12, color: isDark ? '#64748b' : '#94a3b8', borderBottom: `1px solid ${bdr}` }}>
            <span>Golden: <b style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>{dayjs(diff.golden_at).format('DD/MM/YYYY HH:mm')}</b></span>
            <span>Son Backup: <b style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>{dayjs(diff.latest_at).format('DD/MM/YYYY HH:mm')}</b></span>
            <span style={{ marginLeft: 'auto' }}><Tag color="error">-{entries.filter(e=>e.type==='removed').length}</Tag><Tag color="success">+{entries.filter(e=>e.type==='added').length}</Tag> satır değişti</span>
          </div>
          <div style={{ overflowY: 'auto', maxHeight: 520, fontFamily: 'monospace', fontSize: 12, background: bg }}>
            {changed.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#22c55e' }}>Hash uyuşmazlığı var ama satır farkı bulunamadı.</div>
            ) : (
              entries.map((e, idx) => {
                if (e.type === 'same') return null
                const bg2 = e.type === 'added'
                  ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)')
                  : (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)')
                const col = e.type === 'added' ? '#22c55e' : '#ef4444'
                const prefix = e.type === 'added' ? '+' : '-'
                const lineNum = e.type === 'added' ? e.lineB : e.lineA
                return (
                  <div key={idx} style={{ display: 'flex', background: bg2, borderLeft: `3px solid ${col}` }}>
                    <span style={{ width: 42, textAlign: 'right', paddingRight: 8, color: isDark ? '#334155' : '#cbd5e1', userSelect: 'none', flexShrink: 0 }}>{lineNum}</span>
                    <span style={{ color: col, width: 16, flexShrink: 0 }}>{prefix}</span>
                    <span style={{ color: isDark ? '#e2e8f0' : '#1e293b', whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1 }}>{e.text}</span>
                  </div>
                )
              })
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

function StatCard({ label, value, color, icon, isDark }: {
  label: string; value: number; color: string; icon: React.ReactNode; isDark: boolean
}) {
  return (
    <Card
      size="small"
      style={{
        background: isDark ? 'rgba(14,30,56,0.7)' : '#fff',
        border: `1px solid ${isDark ? '#1a3458' : '#e2e8f0'}`,
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 28, color }}>{icon}</div>
        <div>
          <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
          <div style={{ fontSize: 12, color: isDark ? '#64748b' : '#94a3b8', marginTop: 2 }}>{label}</div>
        </div>
      </div>
    </Card>
  )
}

export default function ConfigDriftPage() {
  const { isDark } = useTheme()
  const [diffDevice, setDiffDevice] = useState<{ id: number; hostname: string } | null>(null)
  const [diffData, setDiffData] = useState<DriftDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  const openDiff = async (item: DriftItem) => {
    setDiffDevice({ id: item.device_id, hostname: item.hostname })
    setDiffData(null)
    setDiffLoading(true)
    try {
      const d = await backupSchedulesApi.driftDiff(item.device_id)
      setDiffData(d)
    } catch { /* modal will show error state */ }
    finally { setDiffLoading(false) }
  }

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['config-drift'],
    queryFn: () => backupSchedulesApi.driftReport({ limit: 500 }),
    staleTime: 60_000,
  })

  const columns = [
    {
      title: 'Cihaz',
      dataIndex: 'hostname',
      key: 'hostname',
      render: (v: string, r: DriftItem) => (
        <div>
          <Text strong style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>{v}</Text>
          {r.ip && <div style={{ fontSize: 11, color: '#64748b' }}>{r.ip}</div>}
        </div>
      ),
    },
    {
      title: 'Vendor',
      dataIndex: 'vendor',
      key: 'vendor',
      width: 110,
      render: (v: string) => v ? <Tag>{v}</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Lokasyon',
      dataIndex: 'site',
      key: 'site',
      width: 140,
      render: (v: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Cihaz Durumu',
      dataIndex: 'device_status',
      key: 'device_status',
      width: 120,
      render: (v: string) => {
        const color = v === 'online' ? 'success' : v === 'offline' ? 'error' : 'default'
        return <Badge status={color as any} text={v || '—'} />
      },
    },
    {
      title: 'Drift Sebebi',
      dataIndex: 'reason',
      key: 'reason',
      width: 150,
      render: (v: string) =>
        v === 'hash_mismatch'
          ? <Tag color="warning" icon={<WarningOutlined />}>Config Değişmiş</Tag>
          : <Tag color="error" icon={<CloseCircleOutlined />}>Backup Yok</Tag>,
    },
    {
      title: 'Son Backup',
      dataIndex: 'latest_backup_at',
      key: 'latest_backup_at',
      width: 160,
      render: (v: string) =>
        v
          ? <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}>
              <Text style={{ fontSize: 12 }}>{dayjs(v).fromNow()}</Text>
            </Tooltip>
          : <Text type="secondary">Hiç yedeklenmemiş</Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, r: DriftItem) =>
        r.reason === 'hash_mismatch' ? (
          <Button
            size="small"
            icon={<DiffOutlined />}
            onClick={() => openDiff(r)}
          >
            Diff
          </Button>
        ) : null,
    },
  ]

  const bg = isDark ? '#030c1e' : '#f0f4f8'
  const cardBg = isDark ? 'rgba(14,30,56,0.7)' : '#fff'
  const border = isDark ? '#1a3458' : '#e2e8f0'

  return (
    <div style={{ padding: '20px 24px', background: bg, minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <Title level={4} style={{ margin: 0, color: isDark ? '#e2e8f0' : '#1e293b' }}>
            Config Drift Raporu
          </Title>
          <Text style={{ color: '#64748b', fontSize: 13 }}>
            Golden config'den sapma gösteren cihazlar
          </Text>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={isFetching}
          onClick={() => refetch()}
        >
          Yenile
        </Button>
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" />
        </div>
      ) : !data || data.total_with_golden === 0 ? (
        <Alert
          type="info"
          message="Golden Config Bulunamadı"
          description="Drift tespiti için cihazların golden config'i işaretlenmiş olması gerekir. Yedekleme Merkezi'nden bir backup'ı 'Golden' olarak işaretleyin."
          showIcon
        />
      ) : (
        <>
          <Row gutter={16} style={{ marginBottom: 20 }}>
            <Col span={6}>
              <StatCard
                label="Golden Config Olan"
                value={data.total_with_golden}
                color="#3b82f6"
                icon={<CheckCircleOutlined />}
                isDark={isDark}
              />
            </Col>
            <Col span={6}>
              <StatCard
                label="Temiz (Drift Yok)"
                value={data.clean_count}
                color="#22c55e"
                icon={<CheckCircleOutlined />}
                isDark={isDark}
              />
            </Col>
            <Col span={6}>
              <StatCard
                label="Config Değişmiş"
                value={data.drift_count - data.no_backup_count}
                color="#f59e0b"
                icon={<WarningOutlined />}
                isDark={isDark}
              />
            </Col>
            <Col span={6}>
              <StatCard
                label="Backup Yok"
                value={data.no_backup_count}
                color="#ef4444"
                icon={<CloseCircleOutlined />}
                isDark={isDark}
              />
            </Col>
          </Row>

          {data.drift_count === 0 ? (
            <Alert
              type="success"
              message="Tüm cihazlar temiz — drift tespit edilmedi"
              showIcon
              icon={<CheckCircleOutlined />}
            />
          ) : (
            <Card
              title={
                <span style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>
                  Drift Tespit Edilen Cihazlar
                  <Tag color="error" style={{ marginLeft: 8 }}>{data.drift_count}</Tag>
                </span>
              }
              style={{ background: cardBg, border: `1px solid ${border}` }}
              styles={{ header: { background: isDark ? 'rgba(14,30,56,0.5)' : '#f8fafc', borderBottom: `1px solid ${border}` } }}
            >
              <Table
                dataSource={data.items}
                columns={columns}
                rowKey="device_id"
                size="small"
                pagination={{ pageSize: 20, showSizeChanger: true }}
                rowClassName={(r) =>
                  r.reason === 'no_backup' ? 'drift-row-critical' : 'drift-row-warning'
                }
              />
            </Card>
          )}
        </>
      )}

      <DiffModal
        open={diffDevice !== null}
        onClose={() => { setDiffDevice(null); setDiffData(null) }}
        diff={diffLoading ? null : diffData}
        hostname={diffDevice?.hostname ?? ''}
        isDark={isDark}
      />
    </div>
  )
}
