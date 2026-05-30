/**
 * T10 C7.D — Device Detail > VLAN sekmesi.
 *
 * Kaynak: GET /devices/{id}/vlans (devicesApi.getVlans). Canlı SSH (cache).
 * Cihaz erişilemezse boş + uyarı (Ports tab paterni). Yenile = force refresh.
 */
import { Table, Tag, Button, Alert, Spin, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Device, Vlan } from '@/types'
import { devicesApi } from '@/api/devices'

const { Text } = Typography

export default function VlanTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['device-vlans', device.id],
    queryFn: () => devicesApi.getVlans(device.id),
    enabled: device.id > 0,
    staleTime: 30_000,
  })

  const success = q.data?.success !== false
  const vlans: Vlan[] = q.data?.vlans ?? []

  const columns = [
    { title: 'VLAN ID', dataIndex: 'id', key: 'id', width: 90,
      render: (v: number) => <code style={{ fontSize: 12 }}>{v}</code> },
    { title: 'Ad', dataIndex: 'name', key: 'name' },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 110,
      render: (s: string) => {
        const up = /up|active/i.test(s)
        return <Tag color={up ? 'green' : 'default'}>{s || '—'}</Tag>
      } },
    { title: 'Port sayısı', key: 'pc', width: 110,
      render: (_: any, r: Vlan) => r.ports?.length ?? 0 },
    { title: 'Portlar', dataIndex: 'ports', key: 'ports',
      render: (ps: string[]) => ps?.length
        ? <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
            {ps.slice(0, 8).join(', ')}{ps.length > 8 ? ` … (+${ps.length - 8})` : ''}
          </span>
        : '—' },
  ]

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Text strong>VLAN listesi</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {q.data?.cached ? 'cache (≤30s)' : q.data?.fetched_at ? 'canlı' : ''}
        </Text>
        <div style={{ marginLeft: 'auto' }}>
          <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries({ queryKey: ['device-vlans', device.id] })} loading={q.isLoading}>
            Yenile
          </Button>
        </div>
      </div>

      {!q.isLoading && !success && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message="Cihaz erişilemez (VLAN listesi gelmedi)"
          description={q.data?.error || 'SSH/SNMP yanıt vermedi.'}
        />
      )}

      <Spin spinning={q.isLoading}>
        <Table
          size="small" rowKey="id" columns={columns as any} dataSource={vlans}
          pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: success ? 'VLAN bulunamadı' : '—' }}
        />
      </Spin>
    </div>
  )
}
