import { useState, useMemo } from 'react'
import {
  Button, Drawer, Form, Input, InputNumber, message,
  Modal, Popconfirm, Progress, Select, Space, Table,
  Tag, Tooltip, Typography,
} from 'antd'
import {
  AppstoreOutlined, BarChartOutlined, ClusterOutlined, DeleteOutlined,
  EditOutlined, PlusOutlined, RadarChartOutlined, ReloadOutlined,
  SearchOutlined, TableOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ipamApi, IpamSubnet, IpamAddress } from '@/api/ipam'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'

const { Text } = Typography

const IPAM_CSS = `
@keyframes ipamRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes ipamCellPop {
  from { transform: scale(0.7); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}
.ipam-cell:hover { transform: scale(1.35) !important; z-index: 10; }
`

// ── Subnet IP heatmap helpers ────────────────────────────────────────────────

function cidrToHostList(cidr: string): string[] {
  const [base, prefixStr] = cidr.split('/')
  const prefix = parseInt(prefixStr ?? '24')
  if (prefix < 22) return []
  const parts = base.split('.').map(Number)
  const total = Math.pow(2, 32 - prefix)
  const startIp = (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0
  return Array.from({ length: total }, (_, i) => {
    const ip = (startIp + i) >>> 0
    return [24, 16, 8, 0].map((s) => (ip >> s) & 0xff).join('.')
  })
}

function SubnetHeatmap({
  subnet, allAddresses, onClickIp,
}: {
  subnet: IpamSubnet
  allAddresses: IpamAddress[]
  onClickIp: (ip: string, addr?: IpamAddress) => void
}) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const prefix = parseInt(subnet.network.split('/')[1] ?? '24')

  const addrMap = useMemo(() => {
    const m = new Map<string, IpamAddress>()
    for (const a of allAddresses) m.set(a.ip_address, a)
    return m
  }, [allAddresses])

  const ips = useMemo(() => cidrToHostList(subnet.network), [subnet.network])

  if (prefix < 22) {
    return (
      <div style={{ padding: '32px 0', textAlign: 'center', color: C.muted }}>
        <AppstoreOutlined style={{ fontSize: 32, marginBottom: 8, display: 'block', opacity: 0.4 }} />
        /{prefix} subnet için IP ızgarası çok büyük — tablo görünümünü kullanın
      </div>
    )
  }

  const COLS = 16
  const rows = Math.ceil(ips.length / COLS)
  const lastOctetBase = parseInt(subnet.network.split('.')[3] ?? '0')
  const cellSize = ips.length > 256 ? 16 : 20

  const CELL_COLORS = {
    dynamic:  '#3b82f6',
    static:   '#22c55e',
    reserved: '#f59e0b',
    gateway:  '#a78bfa',
    free:     isDark ? '#1a3458' : '#dde5f0',
  }

  return (
    <div>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 12, flexWrap: 'wrap', fontSize: 11, color: C.muted }}>
        {Object.entries({ free: 'Boş', dynamic: 'Dinamik', static: 'Statik', reserved: 'Rezerve', gateway: 'Gateway' }).map(([k, label]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: CELL_COLORS[k as keyof typeof CELL_COLORS], display: 'inline-block', border: `1px solid ${isDark ? '#ffffff10' : '#00000010'}` }} />
            {label}
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>{ips.length} IP · {addrMap.size} kayıtlı</span>
      </div>

      {/* Column header (0-15) */}
      <div style={{ display: 'flex', marginBottom: 3, paddingLeft: 46 }}>
        {Array.from({ length: Math.min(COLS, ips.length) }, (_, c) => (
          <div key={c} style={{ width: cellSize + 2, textAlign: 'center', fontSize: 9, color: C.dim, userSelect: 'none', lineHeight: 1 }}>
            {c === 0 || c % 4 === 0 ? c : ''}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div style={{ overflowY: 'auto', maxHeight: 500 }}>
        {Array.from({ length: rows }, (_, row) => {
          const rowIps = ips.slice(row * COLS, (row + 1) * COLS)
          const rowLastOctet = lastOctetBase + row * COLS
          return (
            <div key={row} style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
              {/* Row label */}
              <div style={{ width: 44, fontSize: 9, color: C.muted, textAlign: 'right', marginRight: 2, flexShrink: 0, userSelect: 'none' }}>
                .{rowLastOctet}
              </div>
              {rowIps.map((ip) => {
                const addr = addrMap.get(ip)
                const isGateway = ip === subnet.gateway
                const status = isGateway ? 'gateway' : (addr?.status as keyof typeof CELL_COLORS | undefined) ?? 'free'
                const color = CELL_COLORS[status] ?? CELL_COLORS.free
                return (
                  <Tooltip
                    key={ip}
                    mouseEnterDelay={0.1}
                    title={
                      <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
                        <div style={{ fontWeight: 700 }}>{ip}</div>
                        {isGateway && <div style={{ color: '#c4b5fd' }}>Gateway</div>}
                        {addr && <div style={{ color: color }}>{STATUS_LABEL[addr.status] || addr.status}</div>}
                        {addr?.hostname && <div>{addr.hostname}</div>}
                        {addr?.mac_address && <div style={{ color: '#94a3b8' }}>{addr.mac_address}</div>}
                        {!addr && !isGateway && <div style={{ color: '#475569' }}>Boş</div>}
                      </div>
                    }
                  >
                    <div
                      className="ipam-cell"
                      onClick={() => onClickIp(ip, addr)}
                      style={{
                        width: cellSize,
                        height: cellSize,
                        borderRadius: 2,
                        background: color,
                        margin: '0 1px',
                        flexShrink: 0,
                        cursor: addr || isGateway ? 'pointer' : 'default',
                        border: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)'}`,
                        transition: 'transform 0.1s ease',
                        animation: 'ipamCellPop 0.15s ease-out',
                      }}
                    />
                  </Tooltip>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

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

// ── Status helpers ────────────────────────────────────────────────────────────
const STATUS_HEX: Record<string, string> = {
  dynamic: '#3b82f6', static: '#22c55e', reserved: '#f59e0b',
}
const STATUS_LABEL: Record<string, string> = {
  dynamic: 'Dinamik', static: 'Statik', reserved: 'Rezerve',
}

// ── Utilization bar ───────────────────────────────────────────────────────────
function UtilBar({ subnet }: { subnet: IpamSubnet }) {
  const { isDark } = useTheme()
  const usedPct = subnet.total_hosts ? (subnet.used / subnet.total_hosts) * 100 : 0
  const resPct = subnet.total_hosts ? (subnet.reserved / subnet.total_hosts) * 100 : 0
  const color = subnet.utilization_pct >= 90 ? '#ef4444' : subnet.utilization_pct >= 70 ? '#f59e0b' : '#3b82f6'

  return (
    <Tooltip title={`Kullanılan: ${subnet.used} | Rezerve: ${subnet.reserved} | Boş: ${subnet.free} / ${subnet.total_hosts}`}>
      <div style={{ minWidth: 120 }}>
        <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: isDark ? '#334155' : '#e2e8f0' }}>
          <div style={{ width: `${usedPct}%`, background: color, transition: 'width 0.3s' }} />
          <div style={{ width: `${resPct}%`, background: '#f59e0b', transition: 'width 0.3s' }} />
        </div>
        <div style={{ fontSize: 11, color, marginTop: 2, fontWeight: 600 }}>{subnet.utilization_pct}%</div>
      </div>
    </Tooltip>
  )
}

// ── Subnet Form Modal ─────────────────────────────────────────────────────────
function SubnetModal({ open, subnet, onClose }: { open: boolean; subnet: IpamSubnet | null; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [form] = Form.useForm()
  const qc = useQueryClient()

  const createMut = useMutation({
    mutationFn: ipamApi.createSubnet,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ipam-subnets'] }); qc.invalidateQueries({ queryKey: ['ipam-stats'] }); onClose() },
    onError: (e: any) => message.error(e.response?.data?.detail || 'Hata'),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => ipamApi.updateSubnet(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ipam-subnets'] }); onClose() },
    onError: (e: any) => message.error(e.response?.data?.detail || 'Hata'),
  })

  const handleOk = async () => {
    const vals = await form.validateFields()
    if (subnet) updateMut.mutate({ id: subnet.id, data: vals })
    else createMut.mutate(vals)
  }

  return (
    <Modal
      open={open}
      title={<span style={{ color: C.text }}>{subnet ? 'Subnet Düzenle' : 'Yeni Subnet Ekle'}</span>}
      onOk={handleOk}
      onCancel={onClose}
      okText={subnet ? 'Güncelle' : 'Ekle'}
      cancelText="İptal"
      confirmLoading={createMut.isPending || updateMut.isPending}
      destroyOnClose
      afterOpenChange={(o) => o && form.setFieldsValue(subnet ?? {})}
      styles={{
        content: { background: C.bg, border: `1px solid ${C.border}` },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        {!subnet && (
          <Form.Item name="network" label="Ağ (CIDR)" rules={[{ required: true, message: 'Zorunlu' }]}>
            <Input placeholder="192.168.1.0/24" />
          </Form.Item>
        )}
        <Form.Item name="name" label="Ad">
          <Input placeholder="Ofis LAN" />
        </Form.Item>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="site" label="Site / Lokasyon" style={{ flex: 1 }}>
            <Input placeholder="İstanbul" />
          </Form.Item>
          <Form.Item name="vlan_id" label="VLAN ID" style={{ flex: 1 }}>
            <InputNumber min={1} max={4094} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="gateway" label="Gateway" style={{ flex: 1 }}>
            <Input placeholder="192.168.1.1" />
          </Form.Item>
          <Form.Item name="dns_servers" label="DNS Sunucuları" style={{ flex: 1 }}>
            <Input placeholder="8.8.8.8,8.8.4.4" />
          </Form.Item>
        </div>
        <Form.Item name="description" label="Açıklama">
          <Input.TextArea rows={2} />
        </Form.Item>
        {subnet && (
          <Form.Item name="is_active" label="Durum">
            <Select options={[{ value: true, label: 'Aktif' }, { value: false, label: 'Pasif' }]} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  )
}

// ── Address Form Modal ────────────────────────────────────────────────────────
function AddressModal({ open, subnetId, address, onClose }: { open: boolean; subnetId: number; address: IpamAddress | null; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [form] = Form.useForm()
  const qc = useQueryClient()

  const createMut = useMutation({
    mutationFn: (data: any) => ipamApi.createAddress(subnetId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ipam-addresses', subnetId] })
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
      qc.invalidateQueries({ queryKey: ['ipam-stats'] })
      onClose()
    },
    onError: (e: any) => message.error(e.response?.data?.detail || 'Hata'),
  })

  const updateMut = useMutation({
    mutationFn: (data: any) => ipamApi.updateAddress(address!.id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ipam-addresses', subnetId] }); onClose() },
    onError: (e: any) => message.error(e.response?.data?.detail || 'Hata'),
  })

  const handleOk = async () => {
    const vals = await form.validateFields()
    if (address) updateMut.mutate(vals)
    else createMut.mutate(vals)
  }

  return (
    <Modal
      open={open}
      title={<span style={{ color: C.text }}>{address ? 'IP Adresi Düzenle' : 'IP Adresi Ekle'}</span>}
      onOk={handleOk}
      onCancel={onClose}
      okText={address ? 'Güncelle' : 'Ekle'}
      cancelText="İptal"
      confirmLoading={createMut.isPending || updateMut.isPending}
      destroyOnClose
      afterOpenChange={(o) => o && form.setFieldsValue(address ?? { status: 'static' })}
      styles={{
        content: { background: C.bg, border: `1px solid ${C.border}` },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        {!address && (
          <Form.Item name="ip_address" label="IP Adresi" rules={[{ required: true, message: 'Zorunlu' }]}>
            <Input placeholder="192.168.1.100" />
          </Form.Item>
        )}
        <Form.Item name="status" label="Durum" rules={[{ required: true }]}>
          <Select options={[
            { value: 'static', label: 'Statik' },
            { value: 'reserved', label: 'Rezerve' },
            { value: 'dynamic', label: 'Dinamik' },
          ]} />
        </Form.Item>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="mac_address" label="MAC Adresi" style={{ flex: 1 }}>
            <Input placeholder="aa:bb:cc:dd:ee:ff" />
          </Form.Item>
          <Form.Item name="hostname" label="Hostname" style={{ flex: 1 }}>
            <Input placeholder="server-01" />
          </Form.Item>
        </div>
        <Form.Item name="description" label="Açıklama">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ── Addresses Drawer ──────────────────────────────────────────────────────────
function AddressDrawer({ subnet, onClose }: { subnet: IpamSubnet | null; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
  const [addrModal, setAddrModal] = useState(false)
  const [editAddr, setEditAddr] = useState<IpamAddress | null>(null)
  const [viewMode, setViewMode] = useState<'table' | 'heatmap'>('table')
  const qc = useQueryClient()

  const { data, isFetching } = useQuery({
    queryKey: ['ipam-addresses', subnet?.id, statusFilter, search],
    queryFn: () => ipamApi.listAddresses(subnet!.id, { status: statusFilter, search: search || undefined }),
    enabled: !!subnet,
    staleTime: 10000,
  })

  // Unfiltered addresses for heatmap
  const { data: allAddressesData } = useQuery({
    queryKey: ['ipam-addresses-all', subnet?.id],
    queryFn: () => ipamApi.listAddresses(subnet!.id, { limit: 1100 }),
    enabled: !!subnet && viewMode === 'heatmap',
    staleTime: 30_000,
  })

  const scanMut = useMutation({
    mutationFn: (pingSweep: boolean) => ipamApi.scanFromArp(subnet!.id, pingSweep),
    onSuccess: (r) => {
      const extra = r.ping_discovered > 0 ? ` (${r.ping_discovered} ping ile)` : ''
      message.success(`${r.imported} yeni, ${r.updated} güncellendi${extra}`)
      qc.invalidateQueries({ queryKey: ['ipam-addresses', subnet?.id] })
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
    },
    onError: (e: any) => message.error(e.response?.data?.detail || 'Tarama hatası'),
  })

  const delMut = useMutation({
    mutationFn: ipamApi.deleteAddress,
    onSuccess: () => {
      message.success('Silindi')
      qc.invalidateQueries({ queryKey: ['ipam-addresses', subnet?.id] })
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
    },
    onError: () => message.error('Silinemedi'),
  })

  const columns = [
    {
      title: 'IP Adresi',
      dataIndex: 'ip_address',
      render: (v: string) => (
        <code style={{ fontSize: 12, background: isDark ? '#0f172a' : '#f0fdfa', color: isDark ? '#4ec9b0' : '#0d9488', padding: '1px 6px', borderRadius: 3, border: `1px solid ${isDark ? '#134e4a' : '#99f6e4'}` }}>
          {v}
        </code>
      ),
      sorter: (a: IpamAddress, b: IpamAddress) => a.ip_address.localeCompare(b.ip_address),
    },
    {
      title: 'Durum',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => {
        const hex = STATUS_HEX[v] ?? '#64748b'
        return <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>{STATUS_LABEL[v] || v}</Tag>
      },
    },
    {
      title: 'MAC',
      dataIndex: 'mac_address',
      render: (v?: string) => v
        ? <code style={{ fontSize: 11, color: '#06b6d4' }}>{v}</code>
        : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'Hostname',
      dataIndex: 'hostname',
      render: (v?: string) => v ? <Text style={{ fontSize: 12, color: C.text }}>{v}</Text> : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'Açıklama',
      dataIndex: 'description',
      ellipsis: true,
      render: (v?: string) => v ? <Text style={{ fontSize: 12, color: C.text }}>{v}</Text> : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'Son Görülme',
      dataIndex: 'last_seen',
      width: 140,
      render: (v?: string) => v
        ? <Text style={{ fontSize: 11, color: C.muted }}>{new Date(v).toLocaleString('tr')}</Text>
        : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: '',
      width: 80,
      render: (_: any, row: IpamAddress) => (
        <Space size={4}>
          <Tooltip title="Düzenle">
            <Button size="small" type="text" icon={<EditOutlined />}
              onClick={() => { setEditAddr(row); setAddrModal(true) }} />
          </Tooltip>
          <Popconfirm title="Silinsin mi?" onConfirm={() => delMut.mutate(row.id)} okText="Evet" cancelText="Hayır">
            <Tooltip title="Sil">
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Drawer
      open={!!subnet}
      onClose={onClose}
      title={subnet ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ClusterOutlined style={{ color: '#3b82f6' }} />
          <span style={{ color: C.text }}>{subnet.network}</span>
          {subnet.name && <Text style={{ fontSize: 13, color: C.muted }}>— {subnet.name}</Text>}
        </div>
      ) : ''}
      width={900}
      styles={{
        body: { background: C.bg, padding: 16 },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
      extra={
        <Space>
          <Button.Group size="small">
            <Tooltip title="Tablo görünümü">
              <Button
                type={viewMode === 'table' ? 'primary' : 'default'}
                icon={<TableOutlined />}
                onClick={() => setViewMode('table')}
              />
            </Tooltip>
            <Tooltip title="IP ızgara haritası">
              <Button
                type={viewMode === 'heatmap' ? 'primary' : 'default'}
                icon={<AppstoreOutlined />}
                onClick={() => setViewMode('heatmap')}
              />
            </Tooltip>
          </Button.Group>
          <Button icon={<RadarChartOutlined />} size="small" loading={scanMut.isPending} onClick={() => scanMut.mutate(false)}>ARP Tara</Button>
          <Button icon={<RadarChartOutlined />} size="small" loading={scanMut.isPending} onClick={() => scanMut.mutate(true)}>Ping Tara</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditAddr(null); setAddrModal(true) }}>IP Ekle</Button>
        </Space>
      }
    >
      {subnet && (
        <>
          {/* subnet summary */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            {[
              { label: 'Toplam Host', value: subnet.total_hosts, color: C.text },
              { label: 'Kullanılan', value: subnet.used, color: '#3b82f6' },
              { label: 'Rezerve', value: subnet.reserved, color: '#f59e0b' },
              { label: 'Boş', value: subnet.free, color: '#22c55e' },
            ].map((s) => (
              <div key={s.label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{s.label}</div>
              </div>
            ))}
            <div style={{ flex: 1, minWidth: 180 }}>
              <Progress
                percent={subnet.utilization_pct}
                strokeColor={subnet.utilization_pct >= 90 ? '#ef4444' : subnet.utilization_pct >= 70 ? '#f59e0b' : '#3b82f6'}
                trailColor={isDark ? '#334155' : '#e2e8f0'}
                style={{ width: '100%' }}
              />
            </div>
          </div>

          {viewMode === 'table' ? (
            <>
              {/* filters */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <Input
                  placeholder="IP, MAC, hostname ara…"
                  prefix={<SearchOutlined style={{ color: C.muted }} />}
                  allowClear
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: 280 }}
                />
                <Select
                  allowClear
                  placeholder="Durum filtrele"
                  value={statusFilter}
                  onChange={setStatusFilter}
                  style={{ width: 160 }}
                  options={[
                    { value: 'dynamic', label: 'Dinamik' },
                    { value: 'static', label: 'Statik' },
                    { value: 'reserved', label: 'Rezerve' },
                  ]}
                />
                <Text style={{ lineHeight: '32px', fontSize: 12, color: C.muted }}>
                  {data?.total ?? 0} kayıt
                </Text>
              </div>
              <Table
                dataSource={data?.items ?? []}
                columns={columns}
                rowKey="id"
                loading={isFetching}
                size="small"
                pagination={{ pageSize: 50, showSizeChanger: false }}
              />
            </>
          ) : (
            <SubnetHeatmap
              subnet={subnet}
              allAddresses={allAddressesData?.items ?? []}
              onClickIp={(ip, addr) => {
                if (addr) {
                  setEditAddr(addr)
                  setAddrModal(true)
                } else {
                  setEditAddr({ ip_address: ip } as IpamAddress)
                  setAddrModal(true)
                }
              }}
            />
          )}
        </>
      )}

      {subnet && (
        <AddressModal
          open={addrModal}
          subnetId={subnet.id}
          address={editAddr}
          onClose={() => { setAddrModal(false); setEditAddr(null) }}
        />
      )}
    </Drawer>
  )
}

// ── Subnet Utilization Grid ───────────────────────────────────────────────────
function SubnetUtilizationGrid({ subnets }: { subnets: IpamSubnet[] }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const sorted = [...subnets].sort((a, b) => b.utilization_pct - a.utilization_pct)
  const criticalCount = sorted.filter((s) => s.utilization_pct >= 90).length
  const warningCount = sorted.filter((s) => s.utilization_pct >= 70 && s.utilization_pct < 90).length

  if (subnets.length === 0) return null

  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, marginBottom: 16, overflow: 'hidden' }}>
      <div style={{
        padding: '10px 16px', borderBottom: `1px solid ${C.border}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: isDark ? '#0f172a' : '#f8fafc',
      }}>
        <Space>
          <BarChartOutlined style={{ color: '#3b82f6' }} />
          <Text strong style={{ fontSize: 13, color: C.text }}>Subnet Doluluk Haritası</Text>
          {criticalCount > 0 && (
            <Tag style={{ color: '#ef4444', borderColor: '#ef444450', background: '#ef444418', fontSize: 11 }} icon={<WarningOutlined />}>
              {criticalCount} kritik (≥90%)
            </Tag>
          )}
          {warningCount > 0 && (
            <Tag style={{ color: '#f59e0b', borderColor: '#f59e0b50', background: '#f59e0b18', fontSize: 11 }}>
              {warningCount} uyarı (≥70%)
            </Tag>
          )}
        </Space>
        <Space style={{ fontSize: 11 }}>
          {[
            { color: '#3b82f6', label: 'Kullanılan' },
            { color: '#f59e0b', label: 'Rezerve' },
            { color: isDark ? '#334155' : '#e2e8f0', label: 'Boş' },
          ].map((l) => (
            <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: l.color, display: 'inline-block' }} />
              <Text style={{ fontSize: 11, color: C.muted }}>{l.label}</Text>
            </span>
          ))}
        </Space>
      </div>
      <div style={{ padding: '10px 16px', maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {sorted.map((s) => {
          const usedPct = s.total_hosts ? (s.used / s.total_hosts) * 100 : 0
          const resPct = s.total_hosts ? (s.reserved / s.total_hosts) * 100 : 0
          const isCritical = s.utilization_pct >= 90
          const isWarning = s.utilization_pct >= 70
          const barColor = isCritical ? '#ef4444' : isWarning ? '#f59e0b' : '#3b82f6'

          return (
            <Tooltip
              key={s.id}
              title={
                <div>
                  <div style={{ fontWeight: 600 }}>{s.network}{s.name ? ` — ${s.name}` : ''}</div>
                  <div>Kullanılan: {s.used} · Rezerve: {s.reserved} · Boş: {s.free} / {s.total_hosts}</div>
                  {s.site && <div>Site: {s.site}</div>}
                </div>
              }
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'default' }}>
                <div style={{ minWidth: 190, flex: '0 0 190px', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {(isCritical || isWarning) && (
                    <WarningOutlined style={{ fontSize: 11, color: barColor, flexShrink: 0 }} />
                  )}
                  <code style={{ fontSize: 11, color: isDark ? '#4ec9b0' : '#0d9488', whiteSpace: 'nowrap' }}>{s.network}</code>
                  {s.name && (
                    <Text style={{ fontSize: 10, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </Text>
                  )}
                </div>
                <div style={{ flex: 1, height: 16, background: isDark ? '#334155' : '#e2e8f0', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
                  <div style={{ width: `${usedPct}%`, background: barColor, transition: 'width 0.4s' }} />
                  <div style={{ width: `${resPct}%`, background: '#f59e0b', opacity: 0.75, transition: 'width 0.4s' }} />
                </div>
                <div style={{ minWidth: 42, textAlign: 'right' }}>
                  <Text style={{ fontSize: 12, fontWeight: 700, color: barColor }}>{s.utilization_pct}%</Text>
                </div>
                <div style={{ minWidth: 80, textAlign: 'right' }}>
                  <Text style={{ fontSize: 11, color: C.muted }}>{s.used + s.reserved}/{s.total_hosts}</Text>
                </div>
              </div>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}

// ── Main IPAM Page ────────────────────────────────────────────────────────────
export default function IpamPage() {
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const [search, setSearch] = useState('')
  const [selectedSubnet, setSelectedSubnet] = useState<IpamSubnet | null>(null)
  const [subnetModal, setSubnetModal] = useState(false)
  const [editSubnet, setEditSubnet] = useState<IpamSubnet | null>(null)
  const qc = useQueryClient()

  const { data: stats } = useQuery({
    queryKey: ['ipam-stats'],
    queryFn: ipamApi.getStats,
    staleTime: 15000,
  })

  const { data: subnetsData, isFetching } = useQuery({
    queryKey: ['ipam-subnets', search, activeSite],
    queryFn: () => ipamApi.listSubnets({ search: search || undefined, site: activeSite || undefined }),
    staleTime: 15000,
  })

  const deleteMut = useMutation({
    mutationFn: ipamApi.deleteSubnet,
    onSuccess: () => {
      message.success('Subnet silindi')
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
      qc.invalidateQueries({ queryKey: ['ipam-stats'] })
    },
    onError: () => message.error('Silinemedi'),
  })

  const scanMut = useMutation({
    mutationFn: ({ id, pingSweep = false }: { id: number; pingSweep?: boolean }) =>
      ipamApi.scanFromArp(id, pingSweep),
    onSuccess: (r) => {
      const extra = r.ping_discovered > 0 ? ` (${r.ping_discovered} ping ile)` : ''
      message.success(`${r.subnet}: ${r.imported} yeni, ${r.updated} güncellendi${extra}`)
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
    },
    onError: (e: any) => message.error(e.response?.data?.detail || 'Tarama hatası'),
  })

  const columns = [
    {
      title: 'Ağ',
      dataIndex: 'network',
      render: (v: string) => (
        <code style={{ fontSize: 13, background: isDark ? '#0f172a' : '#f0fdfa', color: isDark ? '#4ec9b0' : '#0d9488', padding: '1px 6px', borderRadius: 3 }}>
          {v}
        </code>
      ),
      sorter: (a: IpamSubnet, b: IpamSubnet) => a.network.localeCompare(b.network),
    },
    {
      title: 'Ad',
      dataIndex: 'name',
      render: (v?: string) => v
        ? <Text strong style={{ color: C.text }}>{v}</Text>
        : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'Site',
      dataIndex: 'site',
      render: (v?: string) => v
        ? <Tag style={{ color: '#06b6d4', borderColor: '#06b6d450', background: '#06b6d418', fontSize: 11 }}>{v}</Tag>
        : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'VLAN',
      dataIndex: 'vlan_id',
      width: 70,
      render: (v?: number) => v
        ? <Tag style={{ color: '#6366f1', borderColor: '#6366f150', background: '#6366f118', fontSize: 11 }}>{v}</Tag>
        : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'Gateway',
      dataIndex: 'gateway',
      render: (v?: string) => v
        ? <code style={{ fontSize: 12, color: C.muted }}>{v}</code>
        : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'Kullanım',
      width: 150,
      render: (_: any, row: IpamSubnet) => <UtilBar subnet={row} />,
    },
    {
      title: 'Adresler',
      width: 180,
      render: (_: any, row: IpamSubnet) => (
        <Space size={4}>
          <Tag style={{ color: '#3b82f6', borderColor: '#3b82f650', background: '#3b82f618', fontSize: 10 }}>{row.used} kul.</Tag>
          <Tag style={{ color: '#f59e0b', borderColor: '#f59e0b50', background: '#f59e0b18', fontSize: 10 }}>{row.reserved} rez.</Tag>
          <Tag style={{ color: '#22c55e', borderColor: '#22c55e50', background: '#22c55e18', fontSize: 10 }}>{row.free} boş</Tag>
        </Space>
      ),
    },
    {
      title: '',
      width: 140,
      render: (_: any, row: IpamSubnet) => (
        <Space size={4}>
          <Tooltip title="Adresleri Gör">
            <Button size="small" type="link" icon={<SearchOutlined />} onClick={() => setSelectedSubnet(row)}>Detay</Button>
          </Tooltip>
          <Tooltip title="ARP Tarama">
            <Button size="small" type="text" icon={<RadarChartOutlined />} loading={scanMut.isPending} onClick={() => scanMut.mutate({ id: row.id })} />
          </Tooltip>
          <Tooltip title="Düzenle">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => { setEditSubnet(row); setSubnetModal(true) }} />
          </Tooltip>
          <Popconfirm title="Subnet ve tüm adresleri silinecek. Devam edilsin mi?" onConfirm={() => deleteMut.mutate(row.id)} okText="Evet" cancelText="Hayır">
            <Tooltip title="Sil">
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{IPAM_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#3b82f620' : C.border}`,
        borderLeft: '4px solid #3b82f6',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#3b82f620', border: '1px solid #3b82f630',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <ClusterOutlined style={{ color: '#3b82f6', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>IPAM — IP Adres Yönetimi</div>
            <div style={{ color: C.muted, fontSize: 12 }}>Subnet ve IP adresi takibi</div>
          </div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditSubnet(null); setSubnetModal(true) }}
          style={{ background: '#3b82f6', borderColor: '#3b82f6' }}>
          Subnet Ekle
        </Button>
      </div>

      {/* Stat Cards */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {[
          { label: 'Subnetler', value: stats?.subnets ?? 0, color: '#3b82f6', icon: <ClusterOutlined /> },
          { label: 'Toplam Adres', value: stats?.addresses_total ?? 0, color: '#6366f1', icon: <BarChartOutlined /> },
          { label: 'Dinamik', value: stats?.addresses_dynamic ?? 0, color: '#06b6d4', icon: <RadarChartOutlined /> },
          { label: 'Statik', value: stats?.addresses_static ?? 0, color: '#22c55e', icon: <ClusterOutlined /> },
          { label: 'Rezerve', value: stats?.addresses_reserved ?? 0, color: '#f59e0b', icon: <WarningOutlined /> },
        ].map((s) => (
          <div key={s.label} style={{
            flex: 1, minWidth: 100,
            background: isDark ? `linear-gradient(135deg, ${s.color}0d 0%, ${C.bg} 60%)` : C.bg,
            border: `1px solid ${isDark ? s.color + '28' : C.border}`,
            borderTop: isDark ? `2px solid ${s.color}55` : `2px solid ${s.color}`,
            borderRadius: 10, padding: '12px 16px',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: isDark ? `${s.color}20` : `${s.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ color: s.color, fontSize: 14 }}>{s.icon}</span>
            </div>
            <div>
              <div style={{ color: s.color, fontSize: 20, fontWeight: 800, lineHeight: 1 }}>{s.value}</div>
              <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      <SubnetUtilizationGrid subnets={subnetsData?.items ?? []} />

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Input
          placeholder="Ağ, ad, açıklama ara…"
          prefix={<SearchOutlined style={{ color: C.muted }} />}
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 300 }}
        />
        <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries({ queryKey: ['ipam-subnets'] })} />
        <Text style={{ lineHeight: '32px', fontSize: 12, color: C.muted }}>
          {subnetsData?.total ?? 0} subnet
        </Text>
      </div>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <Table
          dataSource={subnetsData?.items ?? []}
          columns={columns}
          rowKey="id"
          loading={isFetching}
          size="small"
          pagination={{ pageSize: 20 }}
          onRow={(row) => ({
            onDoubleClick: () => setSelectedSubnet(row),
            style: { animation: 'ipamRowIn 0.2s ease-out' },
          })}
        />
      </div>

      <SubnetModal
        open={subnetModal}
        subnet={editSubnet}
        onClose={() => { setSubnetModal(false); setEditSubnet(null) }}
      />

      <AddressDrawer
        subnet={selectedSubnet}
        onClose={() => setSelectedSubnet(null)}
      />
    </div>
  )
}
