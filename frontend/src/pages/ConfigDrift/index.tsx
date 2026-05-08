import { useQuery } from '@tanstack/react-query'
import { Alert, Badge, Button, Card, Col, Row, Spin, Table, Tag, Tooltip, Typography } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { backupSchedulesApi, type DriftItem } from '@/api/backupSchedules'
import { useTheme } from '@/contexts/ThemeContext'

const { Title, Text } = Typography

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
    </div>
  )
}
