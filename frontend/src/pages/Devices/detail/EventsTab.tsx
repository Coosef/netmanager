/**
 * T10 C7.D — Device Detail > Olaylar sekmesi.
 *
 * Kaynak: monitorApi.getEvents({device_id, severity, hours, policy_only}).
 * Severity + policy_only chip filtreleri; satır click ile basit detay panel.
 */
import { useMemo, useState } from 'react'
import { Table, Tag, Button, Typography, Space, Badge, Empty, Drawer, Descriptions } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Device } from '@/types'
import { monitorApi, type NetworkEvent } from '@/api/monitor'
import dayjs from 'dayjs'

const { Text } = Typography

type SevKey = 'critical' | 'warning' | 'info'
// KURAL-E1: SEV_COLOR + SEV_BADGE teknik (CSS/AntD enum); SEV_LABEL component
// içinde useMemo + t() ile çözülür.
const SEV_COLOR: Record<SevKey, string> = { critical: 'red', warning: 'orange', info: 'blue' }
const SEV_BADGE: Record<SevKey, 'error' | 'warning' | 'default'> = {
  critical: 'error', warning: 'warning', info: 'default',
}

export default function EventsTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [severity, setSeverity] = useState<'all' | SevKey>('all')
  const [policyOnly, setPolicyOnly] = useState(false)
  const [hours, setHours] = useState(168)  // 7gün default
  const [selected, setSelected] = useState<NetworkEvent | null>(null)

  const SEV_LABEL = useMemo<Record<SevKey, string>>(() => ({
    critical: t('devices.detail.events.sev.critical'),
    warning:  t('devices.detail.events.sev.warning'),
    info:     t('devices.detail.events.sev.info'),
  }), [t])

  const q = useQuery({
    queryKey: ['device-events', device.id, severity, hours, policyOnly],
    queryFn: () => monitorApi.getEvents({
      device_id: device.id,
      severity: severity === 'all' ? undefined : severity,
      hours,
      policy_only: policyOnly || undefined,
      limit: 200,
    }),
    enabled: device.id > 0,
    staleTime: 30_000,
  })

  const items = q.data?.items ?? []
  const total = q.data?.total ?? 0

  const columns = [
    { title: t('devices.detail.events.col_date'), dataIndex: 'created_at', key: 'd', width: 150,
      render: (v: string) => <span style={{ fontSize: 12 }}>{dayjs(v).format('MM-DD HH:mm')}</span> },
    { title: t('devices.detail.events.col_severity'), dataIndex: 'severity', key: 's', width: 100,
      render: (s: string) => {
        const k = (s in SEV_LABEL ? s : 'info') as SevKey
        return <Badge status={SEV_BADGE[k]} text={SEV_LABEL[k]} />
      } },
    { title: t('devices.detail.events.col_type'), dataIndex: 'event_type', key: 't', width: 140,
      render: (v: string) => <code style={{ fontSize: 11 }}>{v}</code> },
    { title: t('devices.detail.events.col_title'), dataIndex: 'title', key: 'ti', ellipsis: true },
    { title: t('common.status'), dataIndex: 'acknowledged', key: 'ack', width: 100,
      render: (a: boolean) => a ? <Tag color="green">{t('devices.detail.events.tag_acked')}</Tag> : <Tag color="orange">{t('devices.detail.events.tag_open')}</Tag> },
  ]

  const chip = (active: boolean, label: string, onClick: () => void) => (
    <Tag.CheckableTag checked={active} onChange={onClick} style={{ fontSize: 12 }}>
      {label}
    </Tag.CheckableTag>
  )

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <Text strong>{t('devices.detail.events.title')}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{t('devices.detail.backup.records', { count: total })}</Text>
        <Space size={[4, 4]} wrap style={{ marginLeft: 8 }}>
          {chip(severity === 'all', t('common.all'), () => setSeverity('all'))}
          {chip(severity === 'critical', t('devices.detail.events.sev.critical'), () => setSeverity('critical'))}
          {chip(severity === 'warning', t('devices.detail.events.sev.warning'), () => setSeverity('warning'))}
          {chip(severity === 'info', t('devices.detail.events.sev.info'), () => setSeverity('info'))}
          <span style={{ borderLeft: '1px solid var(--line-soft,#cbd5e1)', height: 18 }} />
          {chip(policyOnly, t('devices.detail.events.policy_only'), () => setPolicyOnly(!policyOnly))}
        </Space>
        <Space style={{ marginLeft: 'auto' }}>
          <Button type={hours === 24 ? 'primary' : 'default'} size="small" onClick={() => setHours(24)}>{t('devices.detail.events.range_24h')}</Button>
          <Button type={hours === 168 ? 'primary' : 'default'} size="small" onClick={() => setHours(168)}>{t('devices.detail.events.range_7d')}</Button>
          <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries({ queryKey: ['device-events', device.id] })} loading={q.isLoading} />
        </Space>
      </div>

      <Table
        size="small" rowKey="id" columns={columns as any} dataSource={items}
        loading={q.isLoading}
        pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
        onRow={(r) => ({ onClick: () => setSelected(r as NetworkEvent), style: { cursor: 'pointer' } })}
        locale={{ emptyText: <Empty description={t('devices.detail.events.empty')} /> }}
      />

      <Drawer
        title={selected ? `#${selected.id} — ${selected.title}` : ''}
        open={!!selected} onClose={() => setSelected(null)} width={520}
      >
        {selected && (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label={t('devices.detail.events.col_date')}>{dayjs(selected.created_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
            <Descriptions.Item label={t('devices.detail.events.col_severity')}>
              <Tag color={SEV_COLOR[(selected.severity as SevKey)] ?? 'default'}>
                {SEV_LABEL[(selected.severity as SevKey)] ?? selected.severity}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('devices.detail.events.col_type')}><code>{selected.event_type}</code></Descriptions.Item>
            <Descriptions.Item label={t('common.status')}>{selected.acknowledged ? t('devices.detail.events.tag_acked_lower') : t('devices.detail.events.tag_open_lower')}</Descriptions.Item>
            <Descriptions.Item label={t('devices.detail.events.label_message')}>{selected.message || '—'}</Descriptions.Item>
            {selected.details && Object.keys(selected.details).length > 0 && (
              <Descriptions.Item label={t('devices.detail.events.label_details')}>
                <pre style={{ fontSize: 11, margin: 0 }}>{JSON.stringify(selected.details, null, 2)}</pre>
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Drawer>
    </div>
  )
}
