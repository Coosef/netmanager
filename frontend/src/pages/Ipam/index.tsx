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
    <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="nm-card-hd">
        <h3><BarChartOutlined /> Subnet Doluluk Haritası</h3>
        {criticalCount > 0 && (
          <span className="nm-pill" style={{ color: 'var(--crit)', borderColor: 'var(--crit)' }}>
            <WarningOutlined style={{ marginRight: 4 }} />{criticalCount} kritik
          </span>
        )}
        {warningCount > 0 && (
          <span className="nm-pill" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>
            {warningCount} uyarı
          </span>
        )}
        <Space style={{ marginLeft: 'auto', fontSize: 11 }}>
          {[
            { color: '#3b82f6', label: 'Kullanılan' },
            { color: '#f59e0b', label: 'Rezerve' },
            { color: isDark ? '#334155' : '#e2e8f0', label: 'Boş' },
          ].map((l) => (
            <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: l.color, display: 'inline-block' }} />
              <Text style={{ fontSize: 11, color: 'var(--fg-3)' }}>{l.label}</Text>
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

  // Derived per-subnet utilization stats — concrete capacity-planning signal.
  const subnets = subnetsData?.items ?? []
  const utilStats = useMemo(() => {
    const critical = subnets.filter((s) => s.utilization_pct >= 90).length
    const warning = subnets.filter((s) => s.utilization_pct >= 70 && s.utilization_pct < 90).length
    const avgUtil = subnets.length === 0 ? 0
      : Math.round(subnets.reduce((sum, s) => sum + s.utilization_pct, 0) / subnets.length)
    return { critical, warning, avgUtil }
  }, [subnets])

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <style>{IPAM_CSS}</style>

      {/* NOC header */}
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Ağ Operasyonları</span><span>IPAM</span></div>
          <h1 className="nm-page-title">
            IP Adres Yönetimi
            <span className="nm-pill mono">{stats?.subnets ?? 0} subnet</span>
          </h1>
          <div className="nm-page-sub">
            Subnet kataloğu · IP doluluk takibi · ARP/Ping keşif · adres → cihaz eşlemesi.
          </div>
        </div>
        <Button type="primary" icon={<PlusOutlined />}
          onClick={() => { setEditSubnet(null); setSubnetModal(true) }}>
          Subnet Ekle
        </Button>
      </div>

      {/* NOC stat bar — 6 real KPIs */}
      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">SUBNET</div>
          <div className="nm-stat-val">{stats?.subnets ?? 0}</div>
          <div className="nm-stat-delta">{subnets.length} listede</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">TOPLAM ADRES</div>
          <div className="nm-stat-val">{stats?.addresses_total ?? 0}</div>
          <div className="nm-stat-delta">dyn + sta + rez</div>
        </div>
        <div className={`nm-stat ${utilStats.avgUtil >= 70 ? 'warn' : utilStats.avgUtil >= 50 ? '' : 'ok'}`}>
          <div className="nm-stat-label">ORT. DOLULUK</div>
          <div className="nm-stat-val">{utilStats.avgUtil}<small>%</small></div>
          <div className="nm-stat-delta">{subnets.length} subnet üzerinden</div>
        </div>
        <div className={`nm-stat ${utilStats.critical > 0 ? 'crit' : ''}`}>
          <div className="nm-stat-label">KRİTİK (≥90%)</div>
          <div className="nm-stat-val">{utilStats.critical}</div>
          <div className="nm-stat-delta">kapasite tükeniyor</div>
        </div>
        <div className={`nm-stat ${utilStats.warning > 0 ? 'warn' : ''}`}>
          <div className="nm-stat-label">UYARI (70-89%)</div>
          <div className="nm-stat-val">{utilStats.warning}</div>
          <div className="nm-stat-delta">izlemeye alın</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">DİNAMİK / STATİK</div>
          <div className="nm-stat-val mono" style={{ fontSize: 18 }}>
            {stats?.addresses_dynamic ?? 0}<span style={{ color: 'var(--fg-3)' }}> / </span>{stats?.addresses_static ?? 0}
          </div>
          <div className="nm-stat-delta">{stats?.addresses_reserved ?? 0} rezerve</div>
        </div>
      </div>

      <SubnetUtilizationGrid subnets={subnets} />

      {/* Subnets table */}
      <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="nm-card-hd">
          <h3><ClusterOutlined /> Subnetler</h3>
          <span className="nm-pill mono">{subnetsData?.total ?? 0}</span>
          {/* Inline search + reload */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Input
              placeholder="Ağ, ad, açıklama ara…"
              prefix={<SearchOutlined />}
              allowClear
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: 260 }}
              size="small"
            />
            <Button icon={<ReloadOutlined />} size="small"
              onClick={() => qc.invalidateQueries({ queryKey: ['ipam-subnets'] })} />
          </div>
        </div>
        <Table
          dataSource={subnets}
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
