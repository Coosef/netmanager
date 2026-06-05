/**
 * T10 C7.D — Device Detail > PoE sekmesi.
 *
 * Kaynak: poeApi.device(deviceId). Cihaz PoE desteklemiyorsa 404 → friendly empty.
 */
import { Table, Card, Statistic, Row, Col, Tag, Alert, Spin, Typography } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Device } from '@/types'
import { poeApi, type PoePort } from '@/api/poe'
import dayjs from 'dayjs'

const { Text } = Typography

// PoE port oper_status backend enum'u → Tag rengi. Tag içeriği teknik enum
// (on/off/denied/faulty/searching) kullanıcıya gösterilir; çevrilmez.
const STATUS_COLOR: Record<string, string> = {
  on: 'green', off: 'default', denied: 'red', faulty: 'red', searching: 'blue',
}

export default function PoeTab({ device }: { device: Device }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['device-poe', device.id],
    queryFn: () => poeApi.device(device.id),
    enabled: device.id > 0,
    staleTime: 60_000,
    retry: false,  // 404 (PoE yok) → uzun retry yok
  })

  if (q.isLoading) {
    return <div style={{ padding: 24 }}><Spin /> {t('devices.detail.poe.loading')}</div>
  }

  // 404 / cihaz PoE desteklemiyor → friendly empty
  if (q.isError) {
    return (
      <Alert
        type="info" showIcon
        message={t('devices.detail.poe.no_info_title')}
        description={
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('devices.detail.poe.no_info_desc')}
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
    { title: t('devices.detail.ports.col.port'), dataIndex: 'port', key: 'port', width: 160,
      render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
    { title: t('common.status'), dataIndex: 'oper_status', key: 'op', width: 110,
      render: (s: string) => <Tag color={STATUS_COLOR[s] ?? 'default'}>{s || '—'}</Tag> },
    { title: t('devices.detail.poe.col_power_w'), dataIndex: 'power_watts', key: 'pw', width: 90,
      render: (v: number) => v ? v.toFixed(1) : '0' },
    { title: t('devices.detail.poe.col_max_mw'), dataIndex: 'max_mw', key: 'max', width: 100,
      render: (v: number | null) => v ?? '—' },
    { title: t('devices.detail.poe.col_class'), dataIndex: 'device_class', key: 'cls', width: 80,
      render: (v: string | null) => v ?? '—' },
    { title: t('devices.detail.poe.col_source'), dataIndex: 'source', key: 'src', width: 90,
      render: (v: string) => <Tag style={{ fontSize: 10 }}>{v}</Tag> },
    { title: t('devices.detail.poe.col_updated'), dataIndex: 'updated_at', key: 'u',
      render: (v: string | null) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—' },
  ]

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card size="small"><Statistic title={t('devices.detail.poe.stat_total_ports')} value={s.total_ports} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title={t('devices.detail.poe.stat_active_ports')} value={s.active_ports} prefix={<ThunderboltOutlined />} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title={t('devices.detail.poe.stat_consumption_w')} value={used} suffix="W" /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title={t('devices.detail.poe.stat_consumption_mw')} value={s.total_power_mw} /></Card></Col>
      </Row>

      <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('devices.detail.poe.port_detail')}</Text>
      <Table
        size="small" rowKey="id" columns={columns as any} dataSource={data.ports as PoePort[]}
        pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
        locale={{ emptyText: t('devices.detail.poe.empty') }}
      />
    </div>
  )
}
