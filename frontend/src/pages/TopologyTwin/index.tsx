import { useState } from 'react'
import {
  Button, Table, Tag, Modal, Input, Space, Badge,
  Descriptions, Empty, Popconfirm, Tabs, Alert,
} from 'antd'
import {
  PlusOutlined, DeleteOutlined, StarOutlined, StarFilled,
  CheckCircleOutlined, WarningOutlined, ApartmentOutlined,
  ArrowUpOutlined, ArrowDownOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { topologyTwinApi, type TopologySnapshotMeta, type SnapshotLink } from '@/api/topologyTwin'
import { useTheme } from '@/contexts/ThemeContext'
import { message } from 'antd'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

function mkC(isDark: boolean) {
  return {
    bg:     isDark ? '#1e293b' : '#ffffff',
    bg2:    isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
  }
}

const LINK_COLS = (label: string, color: string) => [
  { title: 'Cihaz ID', dataIndex: 'device_id', width: 80, render: (v: number | null) => v ?? '—' },
  { title: 'Port', dataIndex: 'local_port', render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
  { title: 'Komşu', dataIndex: 'neighbor_hostname' },
  { title: 'Komşu Port', dataIndex: 'neighbor_port', render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
  { title: 'Protokol', dataIndex: 'protocol', width: 80, render: (v: string) => <Tag>{v.toUpperCase()}</Tag> },
  {
    title: 'Durum', width: 100,
    render: () => <Tag color={color === '#22c55e' ? 'success' : color === '#ef4444' ? 'error' : 'default'}>{label}</Tag>,
  },
]

export default function TopologyTwinPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [snapName, setSnapName] = useState('')

  const { data: snaps, isLoading } = useQuery({
    queryKey: ['topology-snapshots'],
    queryFn: topologyTwinApi.listSnapshots,
  })
  const { data: diff } = useQuery({
    queryKey: ['topology-diff'],
    queryFn: topologyTwinApi.getDiff,
    refetchInterval: 120000,
  })

  const createMut = useMutation({
    mutationFn: (name: string) => topologyTwinApi.createSnapshot(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topology-snapshots'] })
      setCreateOpen(false)
      setSnapName('')
      message.success('Anlık görüntü oluşturuldu')
    },
  })
  const goldenMut = useMutation({
    mutationFn: (id: number) => topologyTwinApi.setGolden(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topology-snapshots'] })
      qc.invalidateQueries({ queryKey: ['topology-diff'] })
      message.success('Altın baseline güncellendi')
    },
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => topologyTwinApi.deleteSnapshot(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['topology-snapshots'] }) },
  })

  const columns = [
    {
      title: 'Ad',
      dataIndex: 'name',
      render: (n: string, row: TopologySnapshotMeta) => (
        <Space>
          {row.is_golden && <StarFilled style={{ color: '#f59e0b' }} />}
          <span style={{ color: C.text, fontWeight: row.is_golden ? 700 : 400 }}>{n}</span>
        </Space>
      ),
    },
    {
      title: 'Cihaz',
      dataIndex: 'device_count',
      width: 80,
      render: (v: number) => <Badge count={v} color="#3b82f6" />,
    },
    {
      title: 'Bağlantı',
      dataIndex: 'link_count',
      width: 90,
      render: (v: number) => <Badge count={v} color="#8b5cf6" />,
    },
    {
      title: 'Tarih',
      dataIndex: 'created_at',
      width: 160,
      render: (v: string) => dayjs(v).format('DD.MM.YYYY HH:mm'),
    },
    {
      title: '',
      width: 140,
      render: (_: unknown, row: TopologySnapshotMeta) => (
        <Space>
          {!row.is_golden && (
            <Button size="small" icon={<StarOutlined />}
              loading={goldenMut.isPending}
              onClick={() => goldenMut.mutate(row.id)}>
              Altın
            </Button>
          )}
          <Popconfirm title="Silinsin mi?" onConfirm={() => deleteMut.mutate(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: '16px 20px', background: isDark ? '#030c1e' : '#f0f5fb', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, color: C.text, fontSize: 18, fontWeight: 700 }}>
            <ApartmentOutlined style={{ marginRight: 8, color: '#3b82f6' }} />
            Network Digital Twin
          </h2>
          <p style={{ margin: '4px 0 0', color: C.muted, fontSize: 13 }}>
            Topoloji anlık görüntüleri ve beklenen-gerçek karşılaştırması
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          Anlık Görüntü Al
        </Button>
      </div>

      <Tabs
        defaultActiveKey="snapshots"
        items={[
          {
            key: 'snapshots',
            label: `Anlık Görüntüler (${snaps?.total ?? 0})`,
            children: (
              <Table
                dataSource={snaps?.snapshots || []}
                columns={columns}
                rowKey="id"
                loading={isLoading}
                size="small"
                pagination={{ pageSize: 15 }}
                style={{ background: C.bg, borderRadius: 8 }}
              />
            ),
          },
          {
            key: 'diff',
            label: (
              <Space>
                Drift Analizi
                {diff?.drift_detected && <Badge dot status="warning" />}
              </Space>
            ),
            children: (
              <div>
                {!diff?.has_golden ? (
                  <Empty description="Altın baseline yok. Bir anlık görüntüyü '⭐ Altın' olarak işaretleyin." />
                ) : (
                  <>
                    {/* Summary */}
                    <div style={{
                      display: 'flex', gap: 12, marginBottom: 16,
                      flexWrap: 'wrap',
                    }}>
                      {[
                        { icon: <WarningOutlined />, label: 'Yeni Bağlantı', count: diff.added_count, color: '#ef4444' },
                        { icon: <WarningOutlined />, label: 'Kayıp Bağlantı', count: diff.removed_count, color: '#f97316' },
                        { icon: <CheckCircleOutlined />, label: 'Değişmemiş', count: diff.unchanged_count, color: '#22c55e' },
                      ].map(({ icon, label, count, color }) => (
                        <div key={label} style={{
                          flex: '1 1 160px', padding: '14px 18px', borderRadius: 10,
                          background: `${color}0d`, border: `1px solid ${color}25`,
                          display: 'flex', alignItems: 'center', gap: 12,
                        }}>
                          <span style={{ color, fontSize: 22 }}>{icon}</span>
                          <div>
                            <div style={{ fontSize: 24, fontWeight: 700, color }}>{count}</div>
                            <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {diff.drift_detected && (
                      <Alert
                        type="warning"
                        showIcon
                        message={`Topoloji drift tespit edildi — baseline: "${diff.golden?.name}"`}
                        style={{ marginBottom: 16 }}
                      />
                    )}

                    {!diff.drift_detected && (
                      <Alert
                        type="success"
                        showIcon
                        message={`Topoloji baseline ile birebir eşleşiyor — "${diff.golden?.name}"`}
                        style={{ marginBottom: 16 }}
                      />
                    )}

                    {/* Diff tables */}
                    {diff.added.length > 0 && (
                      <>
                        <div style={{ fontWeight: 600, color: '#ef4444', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <ArrowUpOutlined /> Yeni Eklenen Bağlantılar ({diff.added.length})
                        </div>
                        <Table
                          dataSource={diff.added}
                          columns={LINK_COLS('Yeni', '#22c55e') as any}
                          rowKey={(r: SnapshotLink) => `${r.device_id}:${r.local_port}:${r.neighbor_hostname}`}
                          size="small"
                          pagination={false}
                          style={{ marginBottom: 16, background: '#22c55e08', borderRadius: 8 }}
                          rowClassName={() => ''}
                        />
                      </>
                    )}

                    {diff.removed.length > 0 && (
                      <>
                        <div style={{ fontWeight: 600, color: '#ef4444', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <ArrowDownOutlined /> Kayıp Bağlantılar ({diff.removed.length})
                        </div>
                        <Table
                          dataSource={diff.removed}
                          columns={LINK_COLS('Kayıp', '#ef4444') as any}
                          rowKey={(r: SnapshotLink) => `${r.device_id}:${r.local_port}:${r.neighbor_hostname}`}
                          size="small"
                          pagination={false}
                          style={{ marginBottom: 16, background: '#ef444408', borderRadius: 8 }}
                        />
                      </>
                    )}

                    {diff.unchanged.length > 0 && (
                      <Descriptions title={`Değişmeyen Bağlantılar (${diff.unchanged.length})`} size="small" column={1}>
                        <Descriptions.Item label="">
                          <span style={{ color: C.muted, fontSize: 12 }}>
                            {diff.unchanged.length} bağlantı baseline ile eşleşiyor.
                          </span>
                        </Descriptions.Item>
                      </Descriptions>
                    )}
                  </>
                )}
              </div>
            ),
          },
        ]}
      />

      {/* Create Modal */}
      <Modal
        title="Anlık Görüntü Al"
        open={createOpen}
        onCancel={() => { setCreateOpen(false); setSnapName('') }}
        onOk={() => { if (snapName.trim()) createMut.mutate(snapName.trim()) }}
        confirmLoading={createMut.isPending}
        okText="Oluştur"
        cancelText="İptal"
      >
        <Input
          placeholder="Golden State 2026-05-04"
          value={snapName}
          onChange={e => setSnapName(e.target.value)}
          onPressEnter={() => { if (snapName.trim()) createMut.mutate(snapName.trim()) }}
          autoFocus
        />
      </Modal>
    </div>
  )
}
