/**
 * T10 C7.D — Device Detail > PoE sekmesi.
 *
 * Kaynak: poeApi.device(deviceId). Cihaz PoE desteklemiyorsa 404 → friendly empty.
 */
import { Table, Card, Statistic, Row, Col, Tag, Alert, Spin, Typography } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import type { Device } from '@/types'
import { poeApi, type PoePort } from '@/api/poe'
import dayjs from 'dayjs'

const { Text } = Typography

const STATUS_COLOR: Record<string, string> = {
  on: 'green', off: 'default', denied: 'red', faulty: 'red', searching: 'blue',
}

export default function PoeTab({ device }: { device: Device }) {
  const q = useQuery({
    queryKey: ['device-poe', device.id],
    queryFn: () => poeApi.device(device.id),
    enabled: device.id > 0,
    staleTime: 60_000,
    retry: false,  // 404 (PoE yok) → uzun retry yok
  })

  if (q.isLoading) {
    return <div style={{ padding: 24 }}><Spin /> PoE verisi yükleniyor…</div>
  }

  // 404 / cihaz PoE desteklemiyor → friendly empty
  if (q.isError) {
    return (
      <Alert
        type="info" showIcon
        message="Bu cihazda PoE bilgisi yok"
        description={
          <Text type="secondary" style={{ fontSize: 12 }}>
            Cihaz PoE desteklemiyor, henüz veri toplanmadı veya endpoint yanıt vermedi. PoE
            destekleyen switch'ler için T9 Tur 6B SNMP poll'ü ile veri gelmesi beklenir.
          </Text>
        }
      />
    )
  }

  const data = q.data
  if (!data) return null
  const s = data.summary
  const used = s.total_power_watts.toFixed(1)

  const columns = [
    { title: 'Port', dataIndex: 'port', key: 'port', width: 160,
      render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
    { title: 'Durum', dataIndex: 'oper_status', key: 'op', width: 110,
      render: (s: string) => <Tag color={STATUS_COLOR[s] ?? 'default'}>{s || '—'}</Tag> },
    { title: 'Güç (W)', dataIndex: 'power_watts', key: 'pw', width: 90,
      render: (v: number) => v ? v.toFixed(1) : '0' },
    { title: 'Max (mW)', dataIndex: 'max_mw', key: 'max', width: 100,
      render: (v: number | null) => v ?? '—' },
    { title: 'Sınıf', dataIndex: 'device_class', key: 'cls', width: 80,
      render: (v: string | null) => v ?? '—' },
    { title: 'Kaynak', dataIndex: 'source', key: 'src', width: 90,
      render: (v: string) => <Tag style={{ fontSize: 10 }}>{v}</Tag> },
    { title: 'Güncelleme', dataIndex: 'updated_at', key: 'u',
      render: (v: string | null) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—' },
  ]

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card size="small"><Statistic title="Toplam port" value={s.total_ports} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="Aktif port" value={s.active_ports} prefix={<ThunderboltOutlined />} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="Tüketim (W)" value={used} suffix="W" /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="Tüketim (mW)" value={s.total_power_mw} /></Card></Col>
      </Row>

      <Text strong style={{ display: 'block', marginBottom: 8 }}>Port detay</Text>
      <Table
        size="small" rowKey="id" columns={columns as any} dataSource={data.ports as PoePort[]}
        pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
        locale={{ emptyText: 'PoE port verisi yok' }}
      />
    </div>
  )
}
