import { useState, useMemo } from 'react'
import {
  Button, Input, Select, Space,
  Table, Tag, Tabs, Tooltip, message, Modal, List,
  Segmented, Badge,
} from 'antd'
import {
  ReloadOutlined, SearchOutlined, SyncOutlined, ApartmentOutlined,
  GlobalOutlined, TableOutlined, CameraOutlined, DiffOutlined,
  PlusCircleOutlined, MinusCircleOutlined, LaptopOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { macArpApi, type MacEntry, type ArpEntry, type PortSummaryItem, type DeviceInventoryItem } from '@/api/macarp'
import { devicesApi } from '@/api/devices'
import { ouiLookup, ouiColor } from '@/utils/oui'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import dayjs from 'dayjs'

const MAC_ARP_CSS = `
@keyframes macRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.mac-row-new td { background: rgba(34,197,94,0.05) !important; }
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

// ── MAC Table tab ────────────────────────────────────────────────────────────

function ageBadge(lastSeen: string) {
  const mins = dayjs().diff(dayjs(lastSeen), 'minute')
  if (mins < 60) return <Tag style={{ fontSize: 10, margin: 0, color: '#22c55e', borderColor: '#22c55e50', background: '#22c55e18' }}>Yeni &lt;1sa</Tag>
  if (mins < 60 * 24) return <Tag style={{ fontSize: 10, margin: 0, color: '#3b82f6', borderColor: '#3b82f650', background: '#3b82f618' }}>Bugün</Tag>
  if (mins < 60 * 24 * 7) return <Tag style={{ fontSize: 10, margin: 0, color: '#64748b', borderColor: '#64748b50', background: '#64748b18' }}>Bu Hafta</Tag>
  return null
}

function MacTableTab() {
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const [deviceId, setDeviceId] = useState<number>()
  const [macFilter, setMacFilter] = useState('')
  const [vlanFilter, setVlanFilter] = useState<number>()
  const [portFilter, setPortFilter] = useState('')
  const [ageFilter, setAgeFilter] = useState<'all' | '1h' | '24h' | '7d'>('all')
  const [page, setPage] = useState(1)
  const pageSize = 100

  const { data: devicesData } = useQuery({
    queryKey: ['devices-all-for-mac', activeSite],
    queryFn: () => devicesApi.list({ limit: 2000, site: activeSite || undefined }),
    staleTime: 60000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['mac-table', deviceId, macFilter, vlanFilter, portFilter, page, activeSite],
    queryFn: () =>
      macArpApi.getMacTable({
        skip: (page - 1) * pageSize,
        limit: pageSize,
        device_id: deviceId,
        mac_address: macFilter || undefined,
        vlan_id: vlanFilter,
        port: portFilter || undefined,
        site: activeSite || undefined,
      }),
  })

  const deviceOptions = [
    { label: '— Tüm Cihazlar —', value: undefined as any },
    ...(devicesData?.items || []).map((d) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id })),
  ]

  const columns = [
    {
      title: 'Cihaz',
      dataIndex: 'device_hostname',
      width: 180,
      render: (v: string) => <span style={{ fontWeight: 600, fontSize: 12, color: C.text }}>{v}</span>,
    },
    {
      title: 'MAC Adresi',
      dataIndex: 'mac_address',
      render: (v: string, r: MacEntry) => {
        const vendor = ouiLookup(v)
        return (
          <div>
            <code style={{ fontSize: 12, background: isDark ? '#0f172a' : '#f1f5f9', color: isDark ? '#4ec9b0' : '#0891b2', padding: '1px 6px', borderRadius: 3, border: `1px solid ${isDark ? '#1e3a5f' : '#bae6fd'}` }}>
              {v}
            </code>
            {vendor && (
              <Tag style={{ marginLeft: 6, fontSize: 10, background: `${ouiColor(vendor)}22`, border: `1px solid ${ouiColor(vendor)}66`, color: ouiColor(vendor) }}>
                {vendor}
              </Tag>
            )}
            <div style={{ marginTop: 2 }}>{ageBadge(r.last_seen)}</div>
          </div>
        )
      },
    },
    {
      title: 'VLAN',
      dataIndex: 'vlan_id',
      width: 70,
      render: (v?: number) => v != null
        ? <Tag style={{ color: '#3b82f6', borderColor: '#3b82f650', background: '#3b82f618', fontSize: 11 }}>{v}</Tag>
        : <span style={{ color: C.dim }}>—</span>,
    },
    {
      title: 'Port',
      dataIndex: 'port',
      render: (v?: string) => v
        ? <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.muted, background: isDark ? '#0f172a' : '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>{v}</span>
        : <span style={{ color: C.dim }}>—</span>,
    },
    {
      title: 'Tip',
      dataIndex: 'entry_type',
      width: 90,
      render: (v: string) => {
        const hex = v === 'static' ? '#22c55e' : v === 'self' ? '#f59e0b' : '#3b82f6'
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: hex, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: C.muted }}>{v}</span>
          </span>
        )
      },
    },
    {
      title: 'Son Görülme',
      dataIndex: 'last_seen',
      width: 130,
      sorter: (a: MacEntry, b: MacEntry) => dayjs(b.last_seen).unix() - dayjs(a.last_seen).unix(),
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}>
          <span style={{ fontSize: 11, color: C.muted }}>{dayjs(v).fromNow()}</span>
        </Tooltip>
      ),
    },
  ]

  // Client-side age filter (API doesn't support it directly)
  const ageFilteredData = useMemo(() => {
    if (ageFilter === 'all' || !data?.items) return data?.items
    const cutoff = {
      '1h': dayjs().subtract(1, 'hour'),
      '24h': dayjs().subtract(24, 'hour'),
      '7d': dayjs().subtract(7, 'day'),
    }[ageFilter]
    return data.items.filter((r) => dayjs(r.last_seen).isAfter(cutoff))
  }, [data?.items, ageFilter])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Space wrap>
        <Select
          allowClear
          showSearch
          placeholder="Cihaz filtrele"
          style={{ width: 260 }}
          value={deviceId}
          onChange={(v) => { setDeviceId(v); setPage(1) }}
          options={deviceOptions}
          filterOption={(i, o) => (o?.label as string)?.toLowerCase().includes(i.toLowerCase())}
        />
        <Input
          placeholder="MAC ara (örn: aa:bb)"
          style={{ width: 180 }}
          allowClear
          prefix={<SearchOutlined style={{ color: C.muted }} />}
          value={macFilter}
          onChange={(e) => { setMacFilter(e.target.value); setPage(1) }}
        />
        <Input
          placeholder="Port ara"
          style={{ width: 140 }}
          allowClear
          value={portFilter}
          onChange={(e) => { setPortFilter(e.target.value); setPage(1) }}
        />
        <Input
          placeholder="VLAN"
          type="number"
          style={{ width: 90 }}
          allowClear
          value={vlanFilter ?? ''}
          onChange={(e) => { setVlanFilter(e.target.value ? parseInt(e.target.value) : undefined); setPage(1) }}
        />
        <Segmented
          size="small"
          value={ageFilter}
          onChange={(v) => setAgeFilter(v as typeof ageFilter)}
          options={[
            { value: 'all', label: 'Tümü' },
            { value: '1h', label: '<1sa' },
            { value: '24h', label: '<24sa' },
            { value: '7d', label: '<7g' },
          ]}
        />
      </Space>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <Table<MacEntry>
          dataSource={ageFilteredData}
          rowKey="id"
          loading={isLoading}
          size="small"
          columns={columns}
          pagination={{
            total: ageFilter === 'all' ? data?.total : ageFilteredData?.length,
            pageSize,
            current: page,
            onChange: setPage,
            showSizeChanger: false,
            showTotal: (n) => <span style={{ color: C.muted }}>{n} kayıt</span>,
          }}
          rowClassName={(r) => dayjs().diff(dayjs(r.last_seen), 'minute') < 60 ? 'mac-row-new' : ''}
          onRow={() => ({ style: { animation: 'macRowIn 0.2s ease-out' } })}
        />
      </div>
    </div>
  )
}

// ── Changes (snapshot comparison) tab ────────────────────────────────────────

function ChangesTab() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [snapshot, setSnapshot] = useState<MacEntry[] | null>(null)
  const [snapshotTime, setSnapshotTime] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState<number>()

  const { data: devicesData } = useQuery({
    queryKey: ['devices-all-for-changes'],
    queryFn: () => devicesApi.list({ limit: 2000 }),
    staleTime: 60000,
  })

  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['mac-table-changes', deviceId],
    queryFn: () => macArpApi.getMacTable({ limit: 2000, device_id: deviceId }),
    staleTime: 30_000,
  })

  const current = data?.items || []

  const { added, removed } = useMemo(() => {
    if (!snapshot) return { added: [], removed: [] }
    const snapshotMacs = new Set(snapshot.map((r) => `${r.device_hostname}:${r.mac_address}`))
    const currentMacs = new Set(current.map((r) => `${r.device_hostname}:${r.mac_address}`))
    return {
      added: current.filter((r) => !snapshotMacs.has(`${r.device_hostname}:${r.mac_address}`)),
      removed: snapshot.filter((r) => !currentMacs.has(`${r.device_hostname}:${r.mac_address}`)),
    }
  }, [snapshot, current])

  const deviceOptions = [
    { label: '— Tüm Cihazlar —', value: undefined as any },
    ...(devicesData?.items || []).map((d) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id })),
  ]

  const changeColumns = (type: 'added' | 'removed') => [
    {
      title: '',
      width: 32,
      render: () => type === 'added'
        ? <PlusCircleOutlined style={{ color: '#22c55e' }} />
        : <MinusCircleOutlined style={{ color: '#ef4444' }} />,
    },
    {
      title: 'Cihaz',
      dataIndex: 'device_hostname',
      width: 180,
      render: (v: string) => <span style={{ fontWeight: 600, fontSize: 12, color: C.text }}>{v}</span>,
    },
    {
      title: 'MAC Adresi',
      dataIndex: 'mac_address',
      render: (v: string) => {
        const vendor = ouiLookup(v)
        return (
          <Space size={6}>
            <code style={{ fontSize: 12, background: isDark ? '#0f172a' : '#f1f5f9', color: isDark ? '#4ec9b0' : '#0891b2', padding: '1px 6px', borderRadius: 3, border: `1px solid ${isDark ? '#1e3a5f' : '#bae6fd'}` }}>{v}</code>
            {vendor && <Tag style={{ fontSize: 10, color: ouiColor(vendor), borderColor: ouiColor(vendor) + '50', background: ouiColor(vendor) + '18' }}>{vendor}</Tag>}
          </Space>
        )
      },
    },
    {
      title: 'VLAN',
      dataIndex: 'vlan_id',
      width: 70,
      render: (v?: number) => v != null
        ? <Tag style={{ color: '#3b82f6', borderColor: '#3b82f650', background: '#3b82f618', fontSize: 11 }}>{v}</Tag>
        : <span style={{ color: C.dim }}>—</span>,
    },
    {
      title: 'Port',
      dataIndex: 'port',
      render: (v?: string) => v
        ? <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.muted }}>{v}</span>
        : <span style={{ color: C.dim }}>—</span>,
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        background: isDark ? '#1e293b' : '#eff6ff',
        border: `1px solid ${isDark ? '#1e3a5f' : '#bfdbfe'}`,
        borderRadius: 8, padding: '10px 14px', fontSize: 12, color: C.muted,
      }}>
        <strong style={{ color: '#3b82f6' }}>Anlık Görüntü Karşılaştırması</strong> — "Anlık Görüntü Al" ile mevcut MAC tablosunu kaydedin. Sonra tekrar veri toplayın ve değişiklikleri burada görün.
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select
          allowClear showSearch placeholder="Cihaz filtrele (opsiyonel)"
          style={{ width: 260 }} value={deviceId} onChange={setDeviceId}
          options={deviceOptions}
          filterOption={(i, o) => (o?.label as string)?.toLowerCase().includes(i.toLowerCase())}
        />
        <Button
          icon={<CameraOutlined />}
          onClick={() => { setSnapshot(current); setSnapshotTime(new Date().toISOString()) }}
          disabled={current.length === 0}
        >
          Anlık Görüntü Al {current.length > 0 && `(${current.length} kayıt)`}
        </Button>
        {snapshotTime && (
          <span style={{ fontSize: 12, color: C.muted }}>
            Görüntü: {dayjs(snapshotTime).format('HH:mm:ss')} — {snapshot?.length} kayıt
          </span>
        )}
      </div>

      {!snapshot && (
        <div style={{
          background: isDark ? '#1e293b' : '#fffbeb',
          border: `1px solid ${isDark ? '#78350f' : '#fde68a'}`,
          borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#f59e0b',
        }}>
          Henüz anlık görüntü alınmadı. Karşılaştırma için önce görüntü alın.
        </div>
      )}

      {snapshot && (
        <>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderTop: '2px solid #22c55e', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '8px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 6 }}>
                <PlusCircleOutlined style={{ color: '#22c55e' }} />
                <span style={{ color: '#22c55e', fontWeight: 600, fontSize: 12 }}>Yeni Bağlanan ({added.length})</span>
              </div>
              {added.length === 0
                ? <div style={{ padding: '12px 14px', fontSize: 12, color: C.muted }}>Yeni cihaz yok</div>
                : <Table dataSource={added} rowKey="id" columns={changeColumns('added')} size="small" pagination={false} scroll={{ y: 300 }} loading={isLoading} />
              }
            </div>
            <div style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderTop: '2px solid #ef4444', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '8px 14px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 6 }}>
                <MinusCircleOutlined style={{ color: '#ef4444' }} />
                <span style={{ color: '#ef4444', fontWeight: 600, fontSize: 12 }}>Ayrılan ({removed.length})</span>
              </div>
              {removed.length === 0
                ? <div style={{ padding: '12px 14px', fontSize: 12, color: C.muted }}>Ayrılan cihaz yok</div>
                : <Table dataSource={removed} rowKey="id" columns={changeColumns('removed')} size="small" pagination={false} scroll={{ y: 300 }} loading={isLoading} />
              }
            </div>
          </div>
          <span style={{ fontSize: 11, color: C.dim }}>
            Son güncelleme: {dataUpdatedAt ? dayjs(dataUpdatedAt).format('HH:mm:ss') : '—'} · Toplam mevcut: {current.length} · Görüntü: {snapshot.length}
          </span>
        </>
      )}
    </div>
  )
}

// ── ARP Table tab ────────────────────────────────────────────────────────────

function ArpTableTab() {
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const [deviceId, setDeviceId] = useState<number>()
  const [ipFilter, setIpFilter] = useState('')
  const [macFilter, setMacFilter] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 100

  const { data: devicesData } = useQuery({
    queryKey: ['devices-all-for-arp', activeSite],
    queryFn: () => devicesApi.list({ limit: 2000, site: activeSite || undefined }),
    staleTime: 60000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['arp-table', deviceId, ipFilter, macFilter, page, activeSite],
    queryFn: () =>
      macArpApi.getArpTable({
        skip: (page - 1) * pageSize,
        limit: pageSize,
        device_id: deviceId,
        ip_address: ipFilter || undefined,
        mac_address: macFilter || undefined,
        site: activeSite || undefined,
      }),
  })

  const deviceOptions = [
    { label: '— Tüm Cihazlar —', value: undefined as any },
    ...(devicesData?.items || []).map((d) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id })),
  ]

  const columns = [
    {
      title: 'Cihaz',
      dataIndex: 'device_hostname',
      width: 180,
      render: (v: string) => <span style={{ fontWeight: 600, fontSize: 12, color: C.text }}>{v}</span>,
    },
    {
      title: 'IP Adresi',
      dataIndex: 'ip_address',
      render: (v: string) => (
        <code style={{ fontSize: 12, background: isDark ? '#0f172a' : '#f0f9ff', color: isDark ? '#569cd6' : '#0369a1', padding: '1px 6px', borderRadius: 3, border: `1px solid ${isDark ? '#1e3a5f' : '#bae6fd'}` }}>
          {v}
        </code>
      ),
    },
    {
      title: 'MAC Adresi',
      dataIndex: 'mac_address',
      render: (v: string) => (
        <code style={{ fontSize: 12, background: isDark ? '#0f172a' : '#f0fdfa', color: isDark ? '#4ec9b0' : '#0d9488', padding: '1px 6px', borderRadius: 3, border: `1px solid ${isDark ? '#134e4a' : '#99f6e4'}` }}>
          {v}
        </code>
      ),
    },
    {
      title: 'Interface',
      dataIndex: 'interface',
      render: (v?: string) => v
        ? <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.muted, background: isDark ? '#0f172a' : '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>{v}</span>
        : <span style={{ color: C.dim }}>—</span>,
    },
    {
      title: 'Son Görülme',
      dataIndex: 'last_seen',
      width: 130,
      render: (v: string) => (
        <span style={{ fontSize: 11, color: C.muted }}>{dayjs(v).format('DD.MM HH:mm')}</span>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Space wrap>
        <Select
          allowClear
          showSearch
          placeholder="Cihaz filtrele"
          style={{ width: 260 }}
          value={deviceId}
          onChange={(v) => { setDeviceId(v); setPage(1) }}
          options={deviceOptions}
          filterOption={(i, o) => (o?.label as string)?.toLowerCase().includes(i.toLowerCase())}
        />
        <Input
          placeholder="IP ara (örn: 192.168)"
          style={{ width: 180 }}
          allowClear
          prefix={<SearchOutlined style={{ color: C.muted }} />}
          value={ipFilter}
          onChange={(e) => { setIpFilter(e.target.value); setPage(1) }}
        />
        <Input
          placeholder="MAC ara"
          style={{ width: 180 }}
          allowClear
          value={macFilter}
          onChange={(e) => { setMacFilter(e.target.value); setPage(1) }}
        />
      </Space>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <Table<ArpEntry>
          dataSource={data?.items}
          rowKey="id"
          loading={isLoading}
          size="small"
          columns={columns}
          pagination={{
            total: data?.total,
            pageSize,
            current: page,
            onChange: setPage,
            showSizeChanger: false,
            showTotal: (n) => <span style={{ color: C.muted }}>{n} kayıt</span>,
          }}
          onRow={() => ({ style: { animation: 'macRowIn 0.2s ease-out' } })}
        />
      </div>
    </div>
  )
}

// ── Port Summary tab ─────────────────────────────────────────────────────────

function PortSummaryTab() {
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const [deviceId, setDeviceId] = useState<number>()

  const { data: devicesData } = useQuery({
    queryKey: ['devices-all-for-port', activeSite],
    queryFn: () => devicesApi.list({ limit: 2000, site: activeSite || undefined }),
    staleTime: 60000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['port-summary', deviceId, activeSite],
    queryFn: () => macArpApi.getPortSummary(deviceId, activeSite || undefined),
  })

  const deviceOptions = [
    { label: '— Tüm Cihazlar —', value: undefined as any },
    ...(devicesData?.items || []).map((d) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id })),
  ]

  const columns = [
    {
      title: 'Cihaz',
      dataIndex: 'device_hostname',
      width: 200,
      render: (v: string) => <span style={{ fontWeight: 600, fontSize: 12, color: C.text }}>{v}</span>,
    },
    {
      title: 'Port',
      dataIndex: 'port',
      render: (v?: string) => v
        ? <span style={{ fontFamily: 'monospace', fontSize: 11, color: C.muted, background: isDark ? '#0f172a' : '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>{v}</span>
        : <span style={{ color: C.dim }}>—</span>,
    },
    {
      title: 'VLAN',
      dataIndex: 'vlan_id',
      width: 70,
      render: (v?: number) => v != null
        ? <Tag style={{ color: '#3b82f6', borderColor: '#3b82f650', background: '#3b82f618', fontSize: 11 }}>{v}</Tag>
        : <span style={{ color: C.dim }}>—</span>,
    },
    {
      title: 'MAC Sayısı',
      dataIndex: 'mac_count',
      width: 110,
      render: (v: number) => {
        const hex = v === 0 ? '#64748b' : v === 1 ? '#22c55e' : v <= 5 ? '#3b82f6' : '#f97316'
        return <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>{v} cihaz</Tag>
      },
      sorter: (a: PortSummaryItem, b: PortSummaryItem) => a.mac_count - b.mac_count,
      defaultSortOrder: 'descend' as const,
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Select
        allowClear
        showSearch
        placeholder="Cihaz filtrele"
        style={{ width: 260 }}
        value={deviceId}
        onChange={setDeviceId}
        options={deviceOptions}
        filterOption={(i, o) => (o?.label as string)?.toLowerCase().includes(i.toLowerCase())}
      />

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <Table<PortSummaryItem>
          dataSource={data?.items}
          rowKey={(r) => `${r.device_id}-${r.port}-${r.vlan_id}`}
          loading={isLoading}
          size="small"
          columns={columns}
          pagination={{ pageSize: 100, showTotal: (n) => <span style={{ color: C.muted }}>{n} port</span> }}
          onRow={() => ({ style: { animation: 'macRowIn 0.2s ease-out' } })}
        />
      </div>
    </div>
  )
}

// ── Device Inventory tab ──────────────────────────────────────────────────────

const DT_ICON: Record<string, string> = {
  printer: '🖨️', camera: '📷', phone: '📞', ap: '📶',
  switch: '🔀', router: '🌐', firewall: '🛡️', server: '🖥️',
  vm: '☁️', laptop: '💻', iot: '🔌', other: '❓',
}
const DT_LABEL: Record<string, string> = {
  printer: 'Yazıcı', camera: 'Kamera', phone: 'IP Telefon', ap: 'Access Point',
  switch: 'Switch', router: 'Router', firewall: 'Firewall', server: 'Sunucu',
  vm: 'Sanal Makine', laptop: 'Bilgisayar', iot: 'IoT', other: 'Diğer',
}
const DT_COLOR: Record<string, string> = {
  printer: '#f97316', camera: '#ef4444', phone: '#8b5cf6', ap: '#22c55e',
  switch: '#3b82f6', router: '#06b6d4', firewall: '#dc2626', server: '#6366f1',
  vm: '#607078', laptop: '#84cc16', iot: '#f59e0b', other: '#64748b',
}

function DeviceInventoryTab() {
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const [deviceId, setDeviceId] = useState<number>()
  const [search, setSearch] = useState('')
  const [dtFilter, setDtFilter] = useState<string>()
  const [vlanFilter, setVlanFilter] = useState<number>()
  const [page, setPage] = useState(1)
  const pageSize = 100

  const { data: devicesData } = useQuery({
    queryKey: ['devices-all-for-inv', activeSite],
    queryFn: () => devicesApi.list({ limit: 2000, site: activeSite || undefined }),
    staleTime: 60000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['device-inventory', deviceId, search, dtFilter, vlanFilter, page, activeSite],
    queryFn: () =>
      macArpApi.getDeviceInventory({
        skip: (page - 1) * pageSize,
        limit: pageSize,
        device_id: deviceId,
        search: search || undefined,
        device_type: dtFilter || undefined,
        vlan_id: vlanFilter,
        site: activeSite || undefined,
      }),
  })

  // type_counts comes from the backend aggregate — reflects full filtered dataset, not just current page
  const typeCounts: Record<string, number> = data?.type_counts ?? {}

  const deviceOptions = [
    { label: '— Tüm Switch\'ler —', value: undefined as any },
    ...(devicesData?.items || []).map((d) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id })),
  ]

  const dtOptions = [
    { label: 'Tüm Tipler', value: undefined as any },
    ...Object.entries(DT_LABEL).map(([k, v]) => ({
      label: `${DT_ICON[k]} ${v}`,
      value: k,
    })),
  ]

  const columns = [
    {
      title: 'Tip',
      dataIndex: 'device_type',
      width: 130,
      render: (v: string) => {
        const color = DT_COLOR[v] || '#64748b'
        return (
          <Tag style={{
            color, borderColor: color + '50', background: color + '18',
            fontSize: 11, fontWeight: 600,
          }}>
            {DT_ICON[v] || '❓'} {DT_LABEL[v] || v}
          </Tag>
        )
      },
    },
    {
      title: 'Üretici (OUI)',
      dataIndex: 'oui_vendor',
      width: 160,
      render: (v?: string) => v
        ? <span style={{ fontSize: 12, color: C.text, fontWeight: 500 }}>{v}</span>
        : <span style={{ color: C.dim, fontSize: 11 }}>Bilinmiyor</span>,
    },
    {
      title: 'MAC Adresi',
      dataIndex: 'mac_address',
      render: (v: string) => (
        <code style={{
          fontSize: 11, background: isDark ? '#0f172a' : '#f0fdfa',
          color: isDark ? '#4ec9b0' : '#0d9488',
          padding: '1px 6px', borderRadius: 3,
          border: `1px solid ${isDark ? '#134e4a' : '#99f6e4'}`,
        }}>
          {v}
        </code>
      ),
    },
    {
      title: 'IP Adresi',
      dataIndex: 'ip_address',
      width: 140,
      render: (v?: string) => v
        ? <code style={{ fontSize: 11, background: isDark ? '#0f172a' : '#f0f9ff', color: isDark ? '#569cd6' : '#0369a1', padding: '1px 6px', borderRadius: 3, border: `1px solid ${isDark ? '#1e3a5f' : '#bae6fd'}` }}>{v}</code>
        : <span style={{ color: C.dim }}>—</span>,
    },
    {
      title: 'Switch / Port',
      render: (_: any, r: DeviceInventoryItem) => (
        <div>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{r.device_hostname}</span>
          {r.port && (
            <span style={{ marginLeft: 6, fontFamily: 'monospace', fontSize: 10, color: C.muted, background: isDark ? '#1e293b' : '#f1f5f9', padding: '1px 5px', borderRadius: 3 }}>
              {r.port}
            </span>
          )}
        </div>
      ),
    },
    {
      title: 'VLAN',
      dataIndex: 'vlan_id',
      width: 70,
      render: (v?: number) => v != null
        ? <Tag style={{ color: '#3b82f6', borderColor: '#3b82f650', background: '#3b82f618', fontSize: 10 }}>{v}</Tag>
        : <span style={{ color: C.dim }}>—</span>,
    },
    {
      title: 'Son Görülme',
      dataIndex: 'last_seen',
      width: 120,
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm')}>
          <span style={{ fontSize: 11, color: C.muted }}>{dayjs(v).fromNow()}</span>
        </Tooltip>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Type breakdown pills */}
      {Object.keys(typeCounts).length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(typeCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([dt, cnt]) => {
              const color = DT_COLOR[dt] || '#64748b'
              return (
                <div
                  key={dt}
                  onClick={() => setDtFilter(dtFilter === dt ? undefined : dt)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '4px 10px', borderRadius: 20, cursor: 'pointer',
                    background: dtFilter === dt ? color + '30' : (isDark ? '#1e293b' : '#f8fafc'),
                    border: `1px solid ${dtFilter === dt ? color : (isDark ? '#334155' : '#e2e8f0')}`,
                    transition: 'all 0.15s',
                  }}
                >
                  <span style={{ fontSize: 13 }}>{DT_ICON[dt]}</span>
                  <span style={{ fontSize: 11, color: dtFilter === dt ? color : C.muted, fontWeight: 600 }}>
                    {DT_LABEL[dt] || dt}
                  </span>
                  <Badge
                    count={cnt}
                    style={{ background: color, fontSize: 9, minWidth: 16, height: 16, lineHeight: '16px', padding: '0 4px' }}
                  />
                </div>
              )
            })}
        </div>
      )}

      {/* Filters */}
      <Space wrap>
        <Select
          allowClear showSearch placeholder="Switch filtrele"
          style={{ width: 240 }} value={deviceId}
          onChange={(v) => { setDeviceId(v); setPage(1) }}
          options={deviceOptions}
          filterOption={(i, o) => (o?.label as string)?.toLowerCase().includes(i.toLowerCase())}
        />
        <Select
          allowClear placeholder="Cihaz tipi"
          style={{ width: 160 }} value={dtFilter}
          onChange={(v) => { setDtFilter(v); setPage(1) }}
          options={dtOptions}
        />
        <Input
          placeholder="MAC / IP / Üretici ara"
          style={{ width: 200 }}
          allowClear
          prefix={<SearchOutlined style={{ color: C.muted }} />}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
        />
        <Input
          placeholder="VLAN"
          type="number"
          style={{ width: 90 }}
          allowClear
          value={vlanFilter ?? ''}
          onChange={(e) => { setVlanFilter(e.target.value ? parseInt(e.target.value) : undefined); setPage(1) }}
        />
      </Space>

      {data?.total === 0 && !isLoading && (
        <div style={{
          background: isDark ? '#1e293b' : '#fffbeb',
          border: `1px solid ${isDark ? '#78350f' : '#fde68a'}`,
          borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#f59e0b',
        }}>
          Henüz veri yok — "Veri Topla" butonuna tıklayarak switch'lerden MAC ve ARP tablolarını çekin.
        </div>
      )}

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <Table<DeviceInventoryItem>
          dataSource={data?.items}
          rowKey={(r) => `${r.device_id}-${r.mac_address}`}
          loading={isLoading}
          size="small"
          columns={columns}
          pagination={{
            total: data?.total,
            pageSize,
            current: page,
            onChange: setPage,
            showSizeChanger: false,
            showTotal: (n) => <span style={{ color: C.muted }}>{n} cihaz</span>,
          }}
          onRow={() => ({ style: { animation: 'macRowIn 0.2s ease-out' } })}
        />
      </div>
    </div>
  )
}

// ── Search Modal ─────────────────────────────────────────────────────────────

function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState('')

  const { data, isFetching } = useQuery({
    queryKey: ['mac-arp-search', searched],
    queryFn: () => macArpApi.search(searched),
    enabled: searched.length >= 3,
  })

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={<Space><SearchOutlined style={{ color: '#06b6d4' }} /><span style={{ color: C.text }}>MAC / IP Ara</span></Space>}
      footer={null}
      width={700}
      styles={{
        content: { background: C.bg, border: `1px solid ${C.border}` },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
    >
      <Input.Search
        placeholder="MAC adresi veya IP girin (min. 3 karakter)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onSearch={(v) => setSearched(v)}
        loading={isFetching}
        style={{ marginBottom: 16 }}
        enterButton
      />
      {data && (
        <>
          {data.mac_hits.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontWeight: 600, fontSize: 12, color: C.text }}>MAC Tablosu ({data.mac_hits.length} sonuç)</span>
              <List
                size="small"
                style={{ marginTop: 6, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6 }}
                dataSource={data.mac_hits}
                renderItem={(item) => (
                  <List.Item style={{ borderBottom: `1px solid ${C.border}` }}>
                    <Space wrap>
                      <Tag style={{ color: '#3b82f6', borderColor: '#3b82f650', background: '#3b82f618', fontSize: 10 }}>VLAN {item.vlan_id ?? '—'}</Tag>
                      <code style={{ fontSize: 12, background: isDark ? '#0f172a' : '#f0fdfa', color: isDark ? '#4ec9b0' : '#0d9488', padding: '1px 5px', borderRadius: 3 }}>{item.mac_address}</code>
                      <span style={{ fontSize: 12, color: C.text }}>{item.device_hostname}</span>
                      <span style={{ fontSize: 12, color: C.muted }}>{item.port}</span>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          )}
          {data.arp_hits.length > 0 && (
            <div>
              <span style={{ fontWeight: 600, fontSize: 12, color: C.text }}>ARP Tablosu ({data.arp_hits.length} sonuç)</span>
              <List
                size="small"
                style={{ marginTop: 6, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6 }}
                dataSource={data.arp_hits}
                renderItem={(item) => (
                  <List.Item style={{ borderBottom: `1px solid ${C.border}` }}>
                    <Space wrap>
                      <code style={{ fontSize: 12, background: isDark ? '#0f172a' : '#f0f9ff', color: isDark ? '#569cd6' : '#0369a1', padding: '1px 5px', borderRadius: 3 }}>{item.ip_address}</code>
                      <code style={{ fontSize: 12, background: isDark ? '#0f172a' : '#f0fdfa', color: isDark ? '#4ec9b0' : '#0d9488', padding: '1px 5px', borderRadius: 3 }}>{item.mac_address}</code>
                      <span style={{ fontSize: 12, color: C.text }}>{item.device_hostname}</span>
                      <span style={{ fontSize: 12, color: C.muted }}>{item.interface}</span>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          )}
          {data.mac_hits.length === 0 && data.arp_hits.length === 0 && (
            <span style={{ color: C.muted }}>Sonuç bulunamadı.</span>
          )}
        </>
      )}
    </Modal>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function MacArpPage() {
  const qc = useQueryClient()
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [searchOpen, setSearchOpen] = useState(false)
  const [, setCollectModal] = useState(false)

  const { data: stats } = useQuery({
    queryKey: ['mac-arp-stats'],
    queryFn: macArpApi.getStats,
    refetchInterval: 60000,
  })

  const collectMutation = useMutation({
    mutationFn: () => macArpApi.collect(),
    onSuccess: (res) => {
      message.success(`${res.collected} cihazdan veri toplandı — MAC: ${res.total_mac}, ARP: ${res.total_arp}`)
      setCollectModal(false)
      qc.invalidateQueries({ queryKey: ['mac-table'] })
      qc.invalidateQueries({ queryKey: ['arp-table'] })
      qc.invalidateQueries({ queryKey: ['port-summary'] })
      qc.invalidateQueries({ queryKey: ['mac-arp-stats'] })
      qc.invalidateQueries({ queryKey: ['device-inventory'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Toplama başarısız'),
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{MAC_ARP_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#06b6d420' : C.border}`,
        borderLeft: '4px solid #06b6d4',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#06b6d420', border: '1px solid #06b6d430',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <ApartmentOutlined style={{ color: '#06b6d4', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>Port Intelligence</div>
            <div style={{ color: C.muted, fontSize: 12 }}>Cihaz Envanteri · MAC Tablosu · ARP Tablosu · Port Özeti</div>
          </div>
        </div>
        <Space wrap>
          <Button icon={<SearchOutlined />} onClick={() => setSearchOpen(true)}>
            MAC / IP Ara
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              qc.invalidateQueries({ queryKey: ['mac-table'] })
              qc.invalidateQueries({ queryKey: ['arp-table'] })
              qc.invalidateQueries({ queryKey: ['port-summary'] })
              qc.invalidateQueries({ queryKey: ['mac-arp-stats'] })
              qc.invalidateQueries({ queryKey: ['device-inventory'] })
            }}
          >
            Yenile
          </Button>
          <Button
            type="primary"
            icon={<SyncOutlined />}
            loading={collectMutation.isPending}
            onClick={() => collectMutation.mutate()}
          >
            Veri Topla
          </Button>
        </Space>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 10 }}>
        {[
          { label: 'MAC Kaydı', value: stats?.mac_entries ?? 0, icon: <TableOutlined />, color: '#3b82f6' },
          { label: 'ARP Kaydı', value: stats?.arp_entries ?? 0, icon: <GlobalOutlined />, color: '#22c55e' },
          { label: 'Veri Olan Cihaz', value: stats?.devices_with_mac_data ?? 0, icon: <ApartmentOutlined />, color: '#f59e0b' },
        ].map((s) => (
          <div key={s.label} style={{
            flex: 1,
            background: isDark ? `linear-gradient(135deg, ${s.color}0d 0%, ${C.bg} 60%)` : C.bg,
            border: `1px solid ${isDark ? s.color + '28' : C.border}`,
            borderTop: isDark ? `2px solid ${s.color}55` : `2px solid ${s.color}`,
            borderRadius: 10,
            padding: '12px 16px',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <div style={{
              width: 34, height: 34, borderRadius: 8,
              background: isDark ? `${s.color}20` : `${s.color}15`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ color: s.color, fontSize: 15 }}>{s.icon}</span>
            </div>
            <div>
              <div style={{ color: s.color, fontSize: 20, fontWeight: 800, lineHeight: 1 }}>{s.value.toLocaleString()}</div>
              <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <Tabs
        defaultActiveKey="inventory"
        items={[
          {
            key: 'inventory',
            label: <span><LaptopOutlined /> Cihaz Envanteri</span>,
            children: <DeviceInventoryTab />,
          },
          {
            key: 'mac',
            label: <span><TableOutlined /> MAC Tablosu</span>,
            children: <MacTableTab />,
          },
          {
            key: 'arp',
            label: <span><GlobalOutlined /> ARP Tablosu</span>,
            children: <ArpTableTab />,
          },
          {
            key: 'ports',
            label: <span><ApartmentOutlined /> Port Özeti</span>,
            children: <PortSummaryTab />,
          },
          {
            key: 'changes',
            label: <span><DiffOutlined /> Değişimler</span>,
            children: <ChangesTab />,
          },
        ]}
      />

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  )
}
