// T9 Tur 7 — IPAM page (sıfırdan rebuild).
// 3-pane layout: zones (left) → subnets (middle) → subnet detail (right).
import { useEffect, useMemo, useState } from 'react'
import {
  Alert, App, AutoComplete, Button, Card, Col, Drawer, Empty, Form, Input,
  InputNumber, Modal, Popconfirm, Progress, Row, Select, Space, Switch,
  Table, Tag, Tooltip, Typography,
} from 'antd'
import {
  ApartmentOutlined, ApiOutlined, DeleteOutlined, EditOutlined,
  GlobalOutlined, PlusOutlined, ReloadOutlined, SearchOutlined,
  SyncOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ipamApi, type IpamAssignment, type IpamSubnet, type IpamZone,
} from '@/api/ipam'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuthStore } from '@/store/auth'

const { Text } = Typography

function mkC(isDark: boolean) {
  return {
    bg: isDark ? '#1e293b' : '#ffffff',
    bg2: isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text: isDark ? '#f1f5f9' : '#1e293b',
    muted: isDark ? '#64748b' : '#94a3b8',
    dim: isDark ? '#475569' : '#cbd5e1',
  }
}

const TYPE_COLOR: Record<string, string> = {
  static: 'blue', dhcp: 'cyan', reserved: 'purple', gateway: 'gold',
  broadcast: 'magenta', network: 'magenta', dynamic: 'default',
}

// ─── Zone form ─────────────────────────────────────────────────────────────

function ZoneFormModal({
  open, onClose, editing,
}: { open: boolean; onClose: () => void; editing: IpamZone | null }) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const { data: zones = [] } = useQuery({
    queryKey: ['ipam-zones'], queryFn: ipamApi.listZones,
  })
  // Kullanıcının erişim hakkı olan lokasyonlar — Ad önerisi olarak
  // doldururlar; operatör isterse listede olmayan custom ad da yazabilir.
  const { data: myLocations = [] } = useQuery({
    queryKey: ['my-locations-for-zone'],
    queryFn: () => import('@/api/users').then(m => m.usersApi.getMyLocations()),
  })
  // Org-wide kullanıcı (super_admin / org_admin) için tüm lokasyonlar
  const { data: allLocs } = useQuery({
    queryKey: ['locations-for-zone'],
    queryFn: () => import('@/api/locations').then(m => m.locationsApi.list()),
  })

  useEffect(() => {
    if (open) {
      if (editing) form.setFieldsValue(editing)
      else form.resetFields()
    }
  }, [open, editing, form])

  const save = useMutation({
    mutationFn: (vals: any) => editing
      ? ipamApi.updateZone(editing.id, vals)
      : ipamApi.createZone(vals),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ipam-zones'] })
      message.success(editing ? 'Zone güncellendi' : 'Zone oluşturuldu')
      onClose()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata', 6),
  })

  // T9 follow-up — birleşik lokasyon önerisi (auto-suggest).
  // Org-wide kullanıcı için tüm lokasyonlar; location-scoped için yalnız
  // kendi atandığı lokasyonlar listelenir. Listede olmayan custom ad
  // serbest yazılabilir (AutoComplete free-text destekler).
  const allLocsList = (allLocs as any)?.items as { id: number; name: string }[] | undefined
  const locSource = allLocsList && allLocsList.length > 0
    ? allLocsList
    : (myLocations as any[]).map((l) => ({ id: l.location_id, name: l.location_name }))
  const locOptions = (locSource || []).map((l) => ({ value: l.name }))
  // Ad alanı için lokasyon ID seçimini de yapalım — operatör listeden
  // seçince location_id otomatik form'a düşer.
  const onNamePicked = (val: string) => {
    const match = (locSource || []).find((l) => l.name === val)
    if (match) form.setFieldValue('location_id', match.id)
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={editing ? `Zone Düzenle: ${editing.name}` : 'Yeni Zone'}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item
          name="name"
          label="Ad"
          rules={[{ required: true }]}
          help="Kendi lokasyonlarınızdan birini seçin ya da elle özel bir ad yazın."
        >
          <AutoComplete
            options={locOptions}
            onSelect={onNamePicked}
            placeholder="örn. Istanbul-DC1 (lokasyon seç ya da elle yaz)"
            filterOption={(input, opt) =>
              String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
            }
            allowClear
          />
        </Form.Item>
        <Form.Item name="location_id" label="Bağlı Lokasyon (ops.)" tooltip="Zone'u bir lokasyona bağlamak isterseniz seçin">
          <Select
            allowClear
            placeholder="Bağımsız zone — herhangi bir lokasyona bağlı değil"
            options={(locSource || []).map((l) => ({ value: l.id, label: l.name }))}
          />
        </Form.Item>
        <Form.Item name="zone_type" label="Tür" initialValue="site">
          <Select
            options={[
              { value: 'site', label: 'Site' },
              { value: 'environment', label: 'Environment (prod/dev/test)' },
              { value: 'vpc', label: 'VPC' },
              { value: 'rir_block', label: 'RIR Allocation' },
              { value: 'custom', label: 'Özel' },
            ]}
          />
        </Form.Item>
        <Form.Item name="parent_zone_id" label="Üst Zone (ops.)">
          <Select
            allowClear
            options={zones
              .filter((z) => !editing || z.id !== editing.id)
              .map((z) => ({ value: z.id, label: z.name }))}
          />
        </Form.Item>
        <Form.Item name="description" label="Açıklama">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─── Subnet form ───────────────────────────────────────────────────────────

function SubnetFormModal({
  open, onClose, zoneId, editing,
}: {
  open: boolean; onClose: () => void
  zoneId: number | null; editing: IpamSubnet | null
}) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [cidrValue, setCidrValue] = useState<string>('')
  const { data: zones = [] } = useQuery({
    queryKey: ['ipam-zones'], queryFn: ipamApi.listZones,
  })

  useEffect(() => {
    if (open) {
      if (editing) {
        form.setFieldsValue(editing)
        setCidrValue(editing.cidr || '')
      } else {
        form.resetFields()
        form.setFieldsValue({ zone_id: zoneId ?? undefined, utilization_warn_pct: 80, dhcp_enabled: false })
        setCidrValue('')
      }
    }
  }, [open, editing, zoneId, form])

  // Live overlap check (debounced via React's natural batching — cheap call).
  const overlapQuery = useQuery({
    queryKey: ['ipam-overlap', editing?.id, cidrValue],
    queryFn: () => ipamApi.checkOverlap(editing?.id ?? 0, cidrValue),
    enabled: open && cidrValue.length >= 7 && /\/\d+$/.test(cidrValue),
    staleTime: 5_000,
  })

  const save = useMutation({
    mutationFn: (vals: any) => editing
      ? ipamApi.updateSubnet(editing.id, vals)
      : ipamApi.createSubnet(vals),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
      qc.invalidateQueries({ queryKey: ['ipam-summary'] })
      message.success(editing ? 'Subnet güncellendi' : 'Subnet oluşturuldu')
      onClose()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata', 6),
  })

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={editing ? `Subnet Düzenle: ${editing.cidr}` : 'Yeni Subnet'}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      width={620}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="zone_id" label="Zone" rules={[{ required: true }]}>
              <Select
                placeholder="Zone seçin"
                options={zones.map((z) => ({ value: z.id, label: z.name }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="cidr" label="CIDR" rules={[{ required: true }]}>
              <Input
                placeholder="örn. 10.10.20.0/24"
                disabled={!!editing}
                onChange={(e) => setCidrValue(e.target.value)}
              />
            </Form.Item>
          </Col>
        </Row>
        {overlapQuery.data && overlapQuery.data.overlaps.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`Bu CIDR ile çakışan ${overlapQuery.data.overlaps.length} subnet var:`}
            description={overlapQuery.data.overlaps.map((o) => o.cidr).join(', ')}
            style={{ marginBottom: 12 }}
          />
        )}
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="name" label="Ad">
              <Input placeholder="örn. MGMT-DC1" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="vlan_id" label="VLAN ID">
              <InputNumber min={1} max={4094} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="utilization_warn_pct" label="Uyarı %">
              <InputNumber min={1} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="gateway" label="Gateway IP">
          <Input placeholder="10.10.20.1" />
        </Form.Item>
        <Form.Item name="dhcp_enabled" valuePropName="checked" label="DHCP">
          <Switch checkedChildren="Aktif" unCheckedChildren="Pasif" />
        </Form.Item>
        <Form.Item
          noStyle
          shouldUpdate={(p, c) => p.dhcp_enabled !== c.dhcp_enabled}
        >
          {({ getFieldValue }) => getFieldValue('dhcp_enabled') && (
            <Row gutter={12}>
              <Col span={8}>
                <Form.Item name="dhcp_server" label="DHCP Server">
                  <Input placeholder="10.10.20.10" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="dhcp_range_start" label="Pool Start">
                  <Input placeholder="10.10.20.100" />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="dhcp_range_end" label="Pool End">
                  <Input placeholder="10.10.20.200" />
                </Form.Item>
              </Col>
            </Row>
          )}
        </Form.Item>
        <Form.Item name="description" label="Açıklama">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─── Assignment form ───────────────────────────────────────────────────────

function AssignmentFormModal({
  open, onClose, subnet, editing,
}: {
  open: boolean; onClose: () => void
  subnet: IpamSubnet | null; editing: IpamAssignment | null
}) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const { data: freeIps } = useQuery({
    queryKey: ['ipam-free-ips', subnet?.id],
    queryFn: () => ipamApi.freeIps(subnet!.id, 5),
    enabled: open && !editing && subnet !== null,
    staleTime: 0,
  })

  useEffect(() => {
    if (open) {
      if (editing) form.setFieldsValue(editing)
      else { form.resetFields(); form.setFieldsValue({ type: 'static' }) }
    }
  }, [open, editing, form])

  const save = useMutation({
    mutationFn: (vals: any) => editing
      ? ipamApi.updateAssignment(editing.id, vals)
      : ipamApi.createAssignment(subnet!.id, vals),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ipam-assignments', subnet?.id] })
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
      message.success(editing ? 'Atama güncellendi' : 'Atama oluşturuldu')
      onClose()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata', 6),
  })

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={editing
        ? `Atamayı Düzenle: ${editing.ip_address}`
        : `Yeni Atama — ${subnet?.cidr || ''}`
      }
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnClose
    >
      {!editing && freeIps && freeIps.free_ips.length > 0 && (
        <Alert
          type="info"
          showIcon
          message="Önerilen boş IP'ler"
          description={
            <Space wrap>
              {freeIps.free_ips.map((ip) => (
                <Button
                  key={ip}
                  size="small"
                  onClick={() => form.setFieldValue('ip_address', ip)}
                >
                  {ip}
                </Button>
              ))}
            </Space>
          }
          style={{ marginBottom: 12 }}
        />
      )}
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item name="ip_address" label="IP" rules={[{ required: true }]}>
          <Input disabled={!!editing} placeholder="10.10.20.50" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="hostname" label="Hostname">
              <Input placeholder="srv-dns-01" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="mac_address" label="MAC">
              <Input placeholder="aa:bb:cc:dd:ee:ff" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="type" label="Atama Türü">
          <Select
            options={[
              { value: 'static', label: 'Static' },
              { value: 'dhcp', label: 'DHCP' },
              { value: 'reserved', label: 'Reserved' },
              { value: 'gateway', label: 'Gateway' },
              { value: 'broadcast', label: 'Broadcast' },
              { value: 'network', label: 'Network' },
            ]}
          />
        </Form.Item>
        <Form.Item name="description" label="Açıklama">
          <Input.TextArea rows={2} placeholder="Notlar" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─── Subnet detail drawer ──────────────────────────────────────────────────

function SubnetDetailDrawer({
  subnetId, open, onClose, isDark,
}: { subnetId: number | null; open: boolean; onClose: () => void; isDark: boolean }) {
  const C = mkC(isDark)
  const qc = useQueryClient()
  const { message } = App.useApp()
  const canEdit = useAuthStore((s) => s.can('ipam', 'edit'))
  const [assignOpen, setAssignOpen] = useState(false)
  const [editingAssign, setEditingAssign] = useState<IpamAssignment | null>(null)

  const { data: subnet } = useQuery({
    queryKey: ['ipam-subnet-detail', subnetId],
    queryFn: () => ipamApi.getSubnet(subnetId!),
    enabled: open && subnetId !== null,
  })
  const { data: assignments = [] } = useQuery({
    queryKey: ['ipam-assignments', subnetId],
    queryFn: () => ipamApi.listAssignments(subnetId!),
    enabled: open && subnetId !== null,
  })

  const delAssign = useMutation({
    mutationFn: (id: number) => ipamApi.deleteAssignment(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ipam-assignments', subnetId] })
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
      message.success('Atama silindi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silinemedi'),
  })

  // T9 follow-up — Subnet drawer'da ARP-sync + scanner (header'a ek olarak
  // drawer'dan da erişim, kullanıcı subnet detayına bakarken doldurabilsin)
  const arpSync = useMutation({
    mutationFn: () => ipamApi.syncArp(),
    onSuccess: () => {
      message.success('ARP→IPAM sync başlatıldı — birkaç dakika içinde IP atamaları görünür', 6)
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['ipam-assignments', subnetId] })
        qc.invalidateQueries({ queryKey: ['ipam-subnet-detail', subnetId] })
      }, 30_000)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Tetiklenemedi', 6),
  })
  const scanSubnet = useMutation({
    mutationFn: () => ipamApi.scanSubnet(subnetId!),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['ipam-assignments', subnetId] })
      qc.invalidateQueries({ queryKey: ['ipam-subnet-detail', subnetId] })
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
      message.success(
        `${r.cidr}: ${r.responded}/${r.scanned} yanıt verdi · +${r.created} yeni · ↻${r.refreshed} güncel · -${r.deleted} silindi`,
        8,
      )
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Tarama başarısız', 6),
  })

  const cols = [
    { title: 'IP', dataIndex: 'ip_address', width: 130,
      render: (v: string) => <Text style={{ fontFamily: 'monospace' }}>{v}</Text> },
    { title: 'Hostname', dataIndex: 'hostname', render: (v: string | null) => v || <Text style={{ color: C.dim }}>—</Text> },
    { title: 'MAC', dataIndex: 'mac_address', width: 150, render: (v: string | null) =>
        v ? <Text style={{ fontFamily: 'monospace', fontSize: 11 }}>{v}</Text> : <Text style={{ color: C.dim }}>—</Text> },
    { title: 'Tür', dataIndex: 'type', width: 90,
      render: (v: string) => <Tag color={TYPE_COLOR[v] || 'default'}>{v}</Tag> },
    { title: 'Kaynak', dataIndex: 'source', width: 90,
      render: (v: string) => <Tag style={{ fontSize: 10 }}>{v}</Tag> },
    {
      title: '', width: 80,
      render: (_: unknown, r: IpamAssignment) => canEdit && (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />}
            onClick={() => { setEditingAssign(r); setAssignOpen(true) }} />
          <Popconfirm title="Atama silinsin mi?" onConfirm={() => delAssign.mutate(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={920}
      title={subnet ? (
        <Space>
          <ApartmentOutlined style={{ color: '#3b82f6' }} />
          <Text strong>{subnet.cidr}</Text>
          {subnet.name && <Text style={{ color: C.muted }}>· {subnet.name}</Text>}
          {subnet.vlan_id && <Tag color="purple">VLAN {subnet.vlan_id}</Tag>}
        </Space>
      ) : 'Subnet'}
      extra={canEdit && (
        <Space>
          <Tooltip title="Cihazlardan ARP cache'ini çek, IP atamalarını otomatik doldur">
            <Button
              icon={<SyncOutlined />}
              loading={arpSync.isPending}
              onClick={() => arpSync.mutate()}
            >
              ARP'tan Doldur
            </Button>
          </Tooltip>
          <Tooltip title="Bu subnet'teki tüm IP'leri ping at — yanıt verenleri 'discovery' olarak ekle">
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={scanSubnet.isPending}
              onClick={() => scanSubnet.mutate()}
            >
              IP Tara (Ping)
            </Button>
          </Tooltip>
        </Space>
      )}
    >
      {subnet && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
            <Card size="small" style={{ background: C.bg2, border: `1px solid ${C.border}` }}>
              <Text style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>KULLANIM</Text>
              <div style={{ fontSize: 20, fontWeight: 700, color: (subnet.utilization?.is_high ? '#ef4444' : '#22c55e') }}>
                {subnet.utilization?.pct ?? 0}<small>%</small>
              </div>
              <Progress
                percent={subnet.utilization?.pct ?? 0}
                showInfo={false}
                strokeColor={subnet.utilization?.is_high ? '#ef4444' : '#22c55e'}
                size="small"
              />
              <Text style={{ fontSize: 11, color: C.muted }}>
                {subnet.utilization?.used ?? 0} / {subnet.utilization?.total ?? 0}
              </Text>
            </Card>
            <Card size="small" style={{ background: C.bg2, border: `1px solid ${C.border}` }}>
              <Text style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>BOŞ IP</Text>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#3b82f6' }}>
                {subnet.utilization?.free ?? 0}
              </div>
              <Text style={{ fontSize: 11, color: C.muted }}>henüz atanmamış</Text>
            </Card>
            <Card size="small" style={{ background: C.bg2, border: `1px solid ${C.border}` }}>
              <Text style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>GATEWAY</Text>
              <div style={{ fontSize: 14, color: C.text, fontFamily: 'monospace' }}>
                {subnet.gateway || '—'}
              </div>
            </Card>
            <Card size="small" style={{ background: C.bg2, border: `1px solid ${C.border}` }}>
              <Text style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>DHCP</Text>
              <div style={{ fontSize: 14, color: subnet.dhcp_enabled ? '#22c55e' : C.muted }}>
                {subnet.dhcp_enabled
                  ? (subnet.dhcp_range_start
                      ? `${subnet.dhcp_range_start} – ${subnet.dhcp_range_end}`
                      : 'aktif')
                  : 'kapalı'}
              </div>
            </Card>
          </div>

          {canEdit && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => { setEditingAssign(null); setAssignOpen(true) }}
              style={{ marginBottom: 10 }}
            >
              Yeni IP Atama
            </Button>
          )}

          <Table
            dataSource={assignments}
            rowKey="id"
            columns={cols}
            size="small"
            pagination={{ pageSize: 20, showSizeChanger: false }}
            locale={{ emptyText: 'Bu subnet için atama yok' }}
          />
        </>
      )}

      <AssignmentFormModal
        open={assignOpen}
        onClose={() => { setAssignOpen(false); setEditingAssign(null) }}
        subnet={subnet ?? null}
        editing={editingAssign}
      />
    </Drawer>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function IpamPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const qc = useQueryClient()
  const canEdit = useAuthStore((s) => s.can('ipam', 'edit'))

  const [selectedZoneId, setSelectedZoneId] = useState<number | null>(null)
  const [zoneFormOpen, setZoneFormOpen] = useState(false)
  const [editingZone, setEditingZone] = useState<IpamZone | null>(null)
  const [subnetFormOpen, setSubnetFormOpen] = useState(false)
  const [editingSubnet, setEditingSubnet] = useState<IpamSubnet | null>(null)
  const [drilldownId, setDrilldownId] = useState<number | null>(null)
  const [lookupIp, setLookupIp] = useState('')
  const [lookupResult, setLookupResult] = useState<Awaited<ReturnType<typeof ipamApi.lookup>> | null>(null)

  const { data: zones = [], isLoading: zonesLoading } = useQuery({
    queryKey: ['ipam-zones'], queryFn: ipamApi.listZones,
  })
  const { data: subnets = [], isLoading: subnetsLoading, refetch: refetchSubnets } = useQuery({
    queryKey: ['ipam-subnets', selectedZoneId],
    queryFn: () => ipamApi.listSubnets(selectedZoneId ? { zone_id: selectedZoneId } : undefined),
  })
  const { data: summary } = useQuery({
    queryKey: ['ipam-summary'], queryFn: ipamApi.summary,
    refetchInterval: 60_000,
  })

  const delZone = useMutation({
    mutationFn: ipamApi.deleteZone,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ipam-zones'] })
      qc.invalidateQueries({ queryKey: ['ipam-summary'] })
      message.success('Zone silindi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silinemedi', 6),
  })

  const delSubnet = useMutation({
    mutationFn: ipamApi.deleteSubnet,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
      qc.invalidateQueries({ queryKey: ['ipam-summary'] })
      message.success('Subnet silindi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silinemedi'),
  })

  // T9 follow-up — ARP'tan IPAM doldur
  const arpSync = useMutation({
    mutationFn: () => ipamApi.syncArp(),
    onSuccess: () => {
      message.success('ARP→IPAM senkronizasyonu başlatıldı — birkaç dakika içinde subnet\'lerde IP atamaları görünür', 6)
      // 30s sonra otomatik yenile
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
        qc.invalidateQueries({ queryKey: ['ipam-summary'] })
      }, 30_000)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Tetiklenemedi', 6),
  })

  // T9 follow-up — Subnet IP scanner
  const scanSubnet = useMutation({
    mutationFn: (subnetId: number) => ipamApi.scanSubnet(subnetId),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['ipam-subnets'] })
      qc.invalidateQueries({ queryKey: ['ipam-subnet-detail'] })
      qc.invalidateQueries({ queryKey: ['ipam-assignments'] })
      qc.invalidateQueries({ queryKey: ['ipam-summary'] })
      message.success(
        `${r.cidr}: ${r.responded}/${r.scanned} yanıt verdi · +${r.created} yeni · ↻${r.refreshed} güncel · -${r.deleted} silindi`,
        8,
      )
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Tarama başarısız', 6),
  })

  const subnetCols = useMemo(() => [
    {
      title: 'CIDR', dataIndex: 'cidr', width: 150,
      render: (v: string, r: IpamSubnet) => (
        <Space size={4}>
          <Text style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v}</Text>
          {r.utilization?.is_high && (
            <Tooltip title={`%${r.utilization.pct} dolu — eşik %${r.utilization.warn_pct}`}>
              <WarningOutlined style={{ color: '#ef4444' }} />
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: 'Ad', dataIndex: 'name',
      render: (v: string | null, r: IpamSubnet) => (
        <div>
          <Text style={{ color: C.text }}>{v || <Text style={{ color: C.dim }}>—</Text>}</Text>
          {r.vlan_id && <Tag color="purple" style={{ fontSize: 10, marginLeft: 6 }}>VLAN {r.vlan_id}</Tag>}
        </div>
      ),
    },
    {
      title: 'Kullanım', width: 200,
      sorter: (a: IpamSubnet, b: IpamSubnet) =>
        (a.utilization?.pct ?? 0) - (b.utilization?.pct ?? 0),
      render: (_: unknown, r: IpamSubnet) => {
        const u = r.utilization
        if (!u) return <Text style={{ color: C.dim }}>—</Text>
        return (
          <div>
            <Progress
              percent={u.pct}
              size="small"
              status={u.is_high ? 'exception' : 'active'}
              format={(p) => `${p}% (${u.used}/${u.total})`}
            />
          </div>
        )
      },
    },
    {
      title: 'Gateway', dataIndex: 'gateway', width: 130,
      render: (v: string | null) => v
        ? <Text style={{ fontFamily: 'monospace', fontSize: 11 }}>{v}</Text>
        : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'DHCP', dataIndex: 'dhcp_enabled', width: 80,
      render: (v: boolean) => v
        ? <Tag color="green">DHCP</Tag>
        : <Text style={{ color: C.dim, fontSize: 11 }}>—</Text>,
    },
    {
      title: '', width: 160,
      render: (_: unknown, r: IpamSubnet) => (
        <Space size={4}>
          <Tooltip title="Detay & Atamalar">
            <Button size="small" icon={<ApiOutlined />} onClick={() => setDrilldownId(r.id)} />
          </Tooltip>
          {canEdit && (
            <Tooltip title="ICMP ping ile tüm IP'leri tara — yanıt vereni 'discovery' olarak ekle, yanıt vermeyen eski discovery kayıtlarını sil">
              <Button
                size="small"
                icon={<SearchOutlined />}
                loading={scanSubnet.isPending && scanSubnet.variables === r.id}
                onClick={() => scanSubnet.mutate(r.id)}
              />
            </Tooltip>
          )}
          {canEdit && (
            <>
              <Button size="small" icon={<EditOutlined />}
                onClick={() => { setEditingSubnet(r); setSubnetFormOpen(true) }} />
              <Popconfirm title="Subnet silinsin mi?" onConfirm={() => delSubnet.mutate(r.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ], [C, canEdit])

  const handleLookup = async () => {
    if (!lookupIp.trim()) return
    try {
      const r = await ipamApi.lookup(lookupIp.trim())
      setLookupResult(r)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Sorgu başarısız')
    }
  }

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Ağ Operasyonları</span><span>IPAM</span></div>
          <h1 className="nm-page-title">
            IPAM (IP Address Management)
            <span className="nm-pill mono">{summary?.subnet_count ?? 0} subnet</span>
            <span className="nm-pill mono">{summary?.assignment_count ?? 0} atama</span>
            <Tag color="purple" style={{ fontSize: 10, fontWeight: 600 }}>T9 Tur 7</Tag>
          </h1>
          <div className="nm-page-sub">
            Zone → Subnet → IP atama hiyerarşisi · CIDR overlap koruması · ARP keşfi · doluluk uyarıları.
          </div>
        </div>
        <Space>
          <Tooltip title="Cihazlardan ARP cache'ini çek, IP atamalarını otomatik doldur (manual entries dokunulmaz)">
            <Button
              icon={<SyncOutlined />}
              loading={arpSync.isPending}
              onClick={() => arpSync.mutate()}
              disabled={!canEdit}
            >
              ARP'tan Doldur
            </Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={() => refetchSubnets()}>Yenile</Button>
          {canEdit && (
            <Button type="primary" icon={<PlusOutlined />}
              onClick={() => { setEditingSubnet(null); setSubnetFormOpen(true) }}>
              Yeni Subnet
            </Button>
          )}
        </Space>
      </div>

      {/* High-utilization warning */}
      {summary && summary.high_utilization.length > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          style={{ marginBottom: 12 }}
          message={`${summary.high_utilization.length} subnet eşik üzerinde`}
          description={
            <Space wrap>
              {summary.high_utilization.slice(0, 5).map((h) => (
                <Tag key={h.id} color="red" onClick={() => setDrilldownId(h.id)} style={{ cursor: 'pointer' }}>
                  {h.cidr} · %{h.pct}
                </Tag>
              ))}
              {summary.high_utilization.length > 5 && (
                <Text style={{ color: C.muted, fontSize: 12 }}>
                  +{summary.high_utilization.length - 5} daha
                </Text>
              )}
            </Space>
          }
        />
      )}

      {/* IP Lookup */}
      <Card size="small" style={{ marginBottom: 12, background: C.bg, border: `1px solid ${C.border}` }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="IP sorgula — örn. 10.10.20.50"
            value={lookupIp}
            onChange={(e) => setLookupIp(e.target.value)}
            onPressEnter={handleLookup}
          />
          <Button type="primary" onClick={handleLookup} icon={<GlobalOutlined />}>
            Sorgula
          </Button>
        </Space.Compact>
        {lookupResult && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <Text style={{ color: C.muted }}>{lookupResult.ip}: </Text>
            {lookupResult.subnet ? (
              <>
                <Tag color="blue" onClick={() => setDrilldownId(lookupResult.subnet!.id)} style={{ cursor: 'pointer' }}>
                  {lookupResult.subnet.cidr}
                </Tag>
                {lookupResult.assignment ? (
                  <Tag color={TYPE_COLOR[lookupResult.assignment.type] || 'default'}>
                    {lookupResult.assignment.hostname || lookupResult.assignment.type}
                  </Tag>
                ) : <Text style={{ color: C.muted }}>atanmamış</Text>}
              </>
            ) : <Text style={{ color: '#ef4444' }}>Hiçbir subnet'e ait değil</Text>}
          </div>
        )}
      </Card>

      <Row gutter={12}>
        {/* Zones (left) */}
        <Col span={6}>
          <Card
            size="small"
            title={
              <Space>
                <ApartmentOutlined />
                <Text strong>Zone'lar</Text>
                <Tag>{zones.length}</Tag>
              </Space>
            }
            extra={canEdit && (
              <Button size="small" icon={<PlusOutlined />}
                onClick={() => { setEditingZone(null); setZoneFormOpen(true) }} />
            )}
            style={{ background: C.bg, border: `1px solid ${C.border}` }}
            styles={{ body: { padding: 8 } }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button
                onClick={() => setSelectedZoneId(null)}
                style={{
                  textAlign: 'left', cursor: 'pointer', padding: '6px 10px',
                  background: selectedZoneId === null ? (isDark ? '#1e40af40' : '#dbeafe') : 'transparent',
                  border: `1px solid ${selectedZoneId === null ? '#3b82f6' : C.border}`,
                  borderRadius: 6,
                }}
              >
                <Text style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>Tümü</Text>
              </button>
              {zones.map((z) => (
                <button
                  key={z.id}
                  onClick={() => setSelectedZoneId(z.id)}
                  style={{
                    textAlign: 'left', cursor: 'pointer', padding: '6px 10px',
                    background: selectedZoneId === z.id ? (isDark ? '#1e40af40' : '#dbeafe') : 'transparent',
                    border: `1px solid ${selectedZoneId === z.id ? '#3b82f6' : C.border}`,
                    borderRadius: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <Text style={{ color: C.text, fontSize: 13 }}>{z.name}</Text>
                    <Tag style={{ fontSize: 10, margin: 0 }}>{z.zone_type}</Tag>
                  </div>
                  {canEdit && (
                    <Space size={4} style={{ marginTop: 4 }}>
                      <Button
                        size="small" type="text" icon={<EditOutlined />}
                        onClick={(e) => { e.stopPropagation(); setEditingZone(z); setZoneFormOpen(true) }}
                      />
                      <Popconfirm title="Zone silinsin mi?" onConfirm={() => delZone.mutate(z.id)}>
                        <Button size="small" type="text" danger icon={<DeleteOutlined />}
                          onClick={(e) => e.stopPropagation()} />
                      </Popconfirm>
                    </Space>
                  )}
                </button>
              ))}
              {!zonesLoading && zones.length === 0 && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Zone yok" />
              )}
            </div>
          </Card>
        </Col>

        {/* Subnets (right, wide) */}
        <Col span={18}>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <Table
              dataSource={subnets}
              rowKey="id"
              columns={subnetCols}
              loading={subnetsLoading}
              size="small"
              pagination={{ pageSize: 50, showTotal: (n) => <span style={{ color: C.muted }}>{n} subnet</span> }}
              locale={{ emptyText: zones.length === 0 ? 'Önce bir zone oluşturun.' : 'Bu zone için subnet yok.' }}
            />
          </div>
        </Col>
      </Row>

      <ZoneFormModal
        open={zoneFormOpen}
        onClose={() => { setZoneFormOpen(false); setEditingZone(null) }}
        editing={editingZone}
      />
      <SubnetFormModal
        open={subnetFormOpen}
        onClose={() => { setSubnetFormOpen(false); setEditingSubnet(null) }}
        zoneId={selectedZoneId}
        editing={editingSubnet}
      />
      <SubnetDetailDrawer
        subnetId={drilldownId}
        open={drilldownId !== null}
        onClose={() => setDrilldownId(null)}
        isDark={isDark}
      />
    </div>
  )
}
