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
import type { Device } from '@/types'
import { macArpApi } from '@/api/macarp'
import dayjs from 'dayjs'

const { Text } = Typography
const PAGE_LIMIT = 500

export default function MacTab({ device }: { device: Device }) {
  const qc = useQueryClient()
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

  const columns = [
    { title: 'MAC', dataIndex: 'mac_address', key: 'mac', width: 180,
      render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code> },
    { title: 'Port', dataIndex: 'port', key: 'port', width: 150,
      render: (v: string) => v ? <code style={{ fontSize: 12 }}>{v}</code> : '—' },
    { title: 'VLAN', dataIndex: 'vlan_id', key: 'vlan', width: 80,
      render: (v?: number) => v ?? '—' },
    { title: 'Tip', dataIndex: 'entry_type', key: 'type', width: 100,
      render: (v: string) => <Tag style={{ fontSize: 10 }}>{v || 'dynamic'}</Tag> },
    { title: 'Son Görülme', dataIndex: 'last_seen', key: 'ls',
      render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—' },
  ]

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Text strong>MAC Tablosu</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {total} kayıt{capped ? ` (ilk ${PAGE_LIMIT})` : ''}
        </Text>
        <Space style={{ marginLeft: 'auto' }}>
          <Input
            allowClear placeholder="MAC / port / VLAN ara…"
            prefix={<SearchOutlined />} value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries({ queryKey: ['mac-table-device-tab', device.id] })} loading={q.isLoading}>
            Yenile
          </Button>
        </Space>
      </div>

      <Table
        size="small" rowKey="id" columns={columns as any} dataSource={filtered}
        loading={q.isLoading}
        pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
        locale={{ emptyText: total === 0 ? 'MAC kaydı yok' : 'Aramaya uyan kayıt yok' }}
      />
    </div>
  )
}
