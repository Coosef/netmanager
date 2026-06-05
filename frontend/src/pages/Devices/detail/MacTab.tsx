/**
 * T10 C7.D — Device Detail > MAC Tablosu sekmesi.
 *
 * Kaynak: macArpApi.getMacTable({device_id, limit=500}). Cihaz-filtreli.
 * Arama: MAC / port / VLAN client-side filter (sayfa içi).
 */
import { useMemo, useState } from 'react'
import { Table, Tag, Input, Button, Typography, Space } from 'antd'
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Device } from '@/types'
import { macArpApi } from '@/api/macarp'
import dayjs from 'dayjs'

const { Text } = Typography
const PAGE_LIMIT = 500

export default function MacTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [search, setSearch] = useState('')

  const q = useQuery({
    queryKey: ['mac-table-device-tab', device.id],
    queryFn: () => macArpApi.getMacTable({ device_id: device.id, limit: PAGE_LIMIT }),
    enabled: device.id > 0,
    staleTime: 30_000,
  })

  const filtered = useMemo(() => {
    const items = q.data?.items ?? []
    if (!search.trim()) return items
    const s = search.toLowerCase()
    return items.filter((m) =>
      m.mac_address?.toLowerCase().includes(s) ||
      m.port?.toLowerCase().includes(s) ||
      String(m.vlan_id ?? '').includes(s),
    )
  }, [q.data?.items, search])

  const total = q.data?.total ?? 0
  const capped = (q.data?.items?.length ?? 0) >= PAGE_LIMIT

  // KURAL-E3: MAC / ARP verileri (mac_address, port, vlan_id, entry_type) cihaz
  // verileri olup çevrilmiyor; sadece tablo başlıkları + UI etiketleri çevrilir.
  const columns = [
    { title: 'MAC', dataIndex: 'mac_address', key: 'mac', width: 180,
      render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
    { title: t('devices.detail.ports.col.port'), dataIndex: 'port', key: 'port', width: 150,
      render: (v: string) => v ? <code style={{ fontSize: 12 }}>{v}</code> : '—' },
    { title: 'VLAN', dataIndex: 'vlan_id', key: 'vlan', width: 80,
      render: (v?: number) => v ?? '—' },
    { title: t('devices.detail.mac.col_type'), dataIndex: 'entry_type', key: 'type', width: 100,
      render: (v: string) => <Tag style={{ fontSize: 10 }}>{v || 'dynamic'}</Tag> },
    { title: t('common.last_seen'), dataIndex: 'last_seen', key: 'ls',
      render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—' },
  ]

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Text strong>{t('devices.detail.mac.title')}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {capped
            ? t('devices.detail.mac.total_capped', { count: total, limit: PAGE_LIMIT })
            : t('devices.detail.mac.total_records', { count: total })}
        </Text>
        <Space style={{ marginLeft: 'auto' }}>
          <Input
            allowClear placeholder={t('devices.detail.mac.search_placeholder')}
            prefix={<SearchOutlined />} value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries({ queryKey: ['mac-table-device-tab', device.id] })} loading={q.isLoading}>
            {t('common.refresh')}
          </Button>
        </Space>
      </div>

      <Table
        size="small" rowKey="id" columns={columns as any} dataSource={filtered}
        loading={q.isLoading}
        pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
        locale={{ emptyText: total === 0 ? t('devices.detail.mac.empty_no_records') : t('devices.detail.mac.empty_no_matches') }}
      />
    </div>
  )
}
