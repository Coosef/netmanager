import {
  Alert,
  App,
  Button,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartTooltip, ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import {
  CalendarOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import dayjs from 'dayjs'
import { assetLifecycleApi, type AssetItem, type AssetUpsertPayload, type EolLookupResult, type LifecycleStatus } from '@/api/assetLifecycle'
import { devicesApi } from '@/api/devices'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'

const { Text } = Typography

const ASSET_CSS = `
@keyframes assetRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.asset-row-expiring td { background: rgba(249,115,22,0.04) !important; }
.asset-row-expired td  { background: rgba(239,68,68,0.04) !important; }
.asset-row-eol td      { background: rgba(239,68,68,0.06) !important; }
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_HEX: Record<LifecycleStatus, { hex: string; label: string }> = {
  ok:            { hex: '#22c55e', label: 'Aktif'           },
  expiring_soon: { hex: '#f97316', label: '30 Günde Bitiyor' },
  expiring_90d:  { hex: '#f59e0b', label: '90 Günde Bitiyor' },
  expired:       { hex: '#ef4444', label: 'Süresi Dolmuş'   },
  eol:           { hex: '#ef4444', label: 'EOL'             },
}

const SUPPORT_HEX: Record<string, string> = {
  Platinum: '#8b5cf6', Gold: '#f59e0b', Silver: '#06b6d4', Standard: '#3b82f6',
}

function statusTag(status: LifecycleStatus) {
  const m = STATUS_HEX[status] ?? { hex: '#64748b', label: status }
  return (
    <Tag style={{ color: m.hex, borderColor: m.hex + '50', background: m.hex + '18', fontSize: 11 }}>
      {m.label}
    </Tag>
  )
}

function fmtDate(d: string | null) {
  if (!d) return <Text type="secondary">—</Text>
  return dayjs(d).format('DD.MM.YYYY')
}

function daysLeft(d: string | null) {
  if (!d) return null
  const diff = dayjs(d).diff(dayjs(), 'day')
  if (diff < 0) return <Text type="danger">{Math.abs(diff)} gün geçti</Text>
  if (diff <= 30) return <Text type="warning">{diff} gün kaldı</Text>
  return <Text type="secondary">{diff} gün kaldı</Text>
}

// ── Asset Drawer ──────────────────────────────────────────────────────────────

interface DrawerProps {
  open: boolean
  asset: AssetItem | null
  onClose: () => void
}

function AssetDrawer({ open, asset, onClose }: DrawerProps) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [form] = Form.useForm()
  const { message } = App.useApp()
  const qc = useQueryClient()

  const { data: devicesData } = useQuery({
    queryKey: ['devices-list-asset'],
    queryFn: () => devicesApi.list({ limit: 500 }),
    enabled: open,
  })

  const save = useMutation({
    mutationFn: async (vals: any) => {
      const payload: AssetUpsertPayload = {
        device_id: vals.device_id,
        purchase_date: vals.purchase_date ? vals.purchase_date.format('YYYY-MM-DD') : null,
        warranty_expiry: vals.warranty_expiry ? vals.warranty_expiry.format('YYYY-MM-DD') : null,
        eol_date: vals.eol_date ? vals.eol_date.format('YYYY-MM-DD') : null,
        eos_date: vals.eos_date ? vals.eos_date.format('YYYY-MM-DD') : null,
        purchase_cost: vals.purchase_cost ?? null,
        currency: vals.currency ?? 'TRY',
        po_number: vals.po_number ?? null,
        vendor_contract: vals.vendor_contract ?? null,
        support_tier: vals.support_tier ?? null,
        maintenance_notes: vals.maintenance_notes ?? null,
      }
      if (asset) return assetLifecycleApi.update(asset.id, payload)
      return assetLifecycleApi.upsert(payload)
    },
    onSuccess: () => {
      message.success('Kaydedildi')
      qc.invalidateQueries({ queryKey: ['asset-lifecycle'] })
      onClose()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail ?? 'Hata'),
  })

  const onOpen = () => {
    if (asset) {
      form.setFieldsValue({
        device_id: asset.device_id,
        purchase_date: asset.purchase_date ? dayjs(asset.purchase_date) : null,
        warranty_expiry: asset.warranty_expiry ? dayjs(asset.warranty_expiry) : null,
        eol_date: asset.eol_date ? dayjs(asset.eol_date) : null,
        eos_date: asset.eos_date ? dayjs(asset.eos_date) : null,
        purchase_cost: asset.purchase_cost,
        currency: asset.currency ?? 'TRY',
        po_number: asset.po_number,
        vendor_contract: asset.vendor_contract,
        support_tier: asset.support_tier,
        maintenance_notes: asset.maintenance_notes,
      })
    } else {
      form.resetFields()
    }
  }

  const deviceOptions = (devicesData?.items ?? []).map((d: any) => ({
    value: d.id,
    label: `${d.hostname} (${d.ip_address})`,
  }))

  return (
    <Drawer
      open={open}
      title={<span style={{ color: C.text }}>{asset ? 'Asset Lifecycle Düzenle' : 'Yeni Asset Lifecycle'}</span>}
      width={520}
      onClose={onClose}
      afterOpenChange={(v) => v && onOpen()}
      styles={{
        body: { background: C.bg, padding: 20 },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
        footer: { background: C.bg, borderTop: `1px solid ${C.border}` },
      }}
      footer={
        <Space style={{ float: 'right' }}>
          <Button onClick={onClose}>İptal</Button>
          <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
            Kaydet
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item name="device_id" label="Cihaz" rules={[{ required: true }]}>
          <Select
            showSearch
            filterOption={(input, opt) =>
              (opt?.label as string ?? '').toLowerCase().includes(input.toLowerCase())
            }
            options={deviceOptions}
            placeholder="Cihaz seçin"
            disabled={!!asset}
          />
        </Form.Item>

        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="purchase_date" label="Satın Alma Tarihi" style={{ flex: 1 }}>
            <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
          </Form.Item>
          <Form.Item name="warranty_expiry" label="Garanti Bitiş" style={{ flex: 1 }}>
            <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
          </Form.Item>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="eol_date" label="EOL Tarihi" style={{ flex: 1 }}>
            <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
          </Form.Item>
          <Form.Item name="eos_date" label="EOS Tarihi" style={{ flex: 1 }}>
            <DatePicker style={{ width: '100%' }} format="DD.MM.YYYY" />
          </Form.Item>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="purchase_cost" label="Satın Alma Maliyeti" style={{ flex: 1.4 }}>
            <InputNumber style={{ width: '100%' }} min={0} step={100} />
          </Form.Item>
          <Form.Item name="currency" label="Para Birimi" initialValue="TRY" style={{ flex: 1 }}>
            <Select options={[
              { value: 'TRY', label: 'TRY' },
              { value: 'USD', label: 'USD' },
              { value: 'EUR', label: 'EUR' },
            ]} />
          </Form.Item>
        </div>

        <Form.Item name="po_number" label="PO Numarası">
          <Input placeholder="Sipariş/Sözleşme no" />
        </Form.Item>

        <Form.Item name="vendor_contract" label="Satıcı Sözleşmesi">
          <Input placeholder="Sözleşme adı / numarası" />
        </Form.Item>

        <Form.Item name="support_tier" label="Destek Seviyesi">
          <Select allowClear options={[
            { value: 'Platinum', label: 'Platinum' },
            { value: 'Gold', label: 'Gold' },
            { value: 'Silver', label: 'Silver' },
            { value: 'Standard', label: 'Standard' },
            { value: 'None', label: 'Yok' },
          ]} placeholder="Destek seviyesi" />
        </Form.Item>

        <Form.Item name="maintenance_notes" label="Bakım Notları">
          <Input.TextArea rows={3} placeholder="Servis kayıtları, bakım tarihleri, notlar..." />
        </Form.Item>
      </Form>
    </Drawer>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AssetLifecyclePage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message, modal } = App.useApp()
  const { activeSite } = useSite()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | undefined>()
  const [page, setPage] = useState(1)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editAsset, setEditAsset] = useState<AssetItem | null>(null)
  const [eolModalOpen, setEolModalOpen] = useState(false)
  const [eolResults, setEolResults] = useState<{ checked: number; updated: number; not_found: number; results: EolLookupResult[] } | null>(null)

  const { data: stats } = useQuery({
    queryKey: ['asset-lifecycle', 'stats', activeSite],
    queryFn: () => assetLifecycleApi.stats({ site: activeSite || undefined }),
    refetchInterval: 60000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['asset-lifecycle', 'list', search, statusFilter, page, activeSite],
    queryFn: () => assetLifecycleApi.list({ search, status: statusFilter, page, page_size: 50, site: activeSite || undefined }),
  })

  const deleteMut = useMutation({
    mutationFn: assetLifecycleApi.delete,
    onSuccess: () => {
      message.success('Silindi')
      qc.invalidateQueries({ queryKey: ['asset-lifecycle'] })
    },
  })

  const eolLookupMut = useMutation({
    mutationFn: () => assetLifecycleApi.eolLookup([]),
    onSuccess: (res) => {
      setEolResults(res)
      setEolModalOpen(true)
      qc.invalidateQueries({ queryKey: ['asset-lifecycle'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail ?? 'EOL arama hatası'),
  })

  const openEdit = (asset: AssetItem) => { setEditAsset(asset); setDrawerOpen(true) }
  const openNew = () => { setEditAsset(null); setDrawerOpen(true) }

  const confirmDelete = (asset: AssetItem) => {
    modal.confirm({
      title: 'Asset kaydı silinsin mi?',
      content: asset.device_hostname,
      okType: 'danger',
      onOk: () => deleteMut.mutate(asset.id),
    })
  }

  const columns = [
    {
      title: 'Cihaz',
      dataIndex: 'device_hostname',
      render: (v: string) => <Text strong style={{ color: C.text }}>{v}</Text>,
      sorter: (a: AssetItem, b: AssetItem) => a.device_hostname.localeCompare(b.device_hostname),
    },
    {
      title: 'Durum',
      dataIndex: 'lifecycle_status',
      render: (v: LifecycleStatus) => statusTag(v),
    },
    {
      title: 'Garanti Bitiş',
      dataIndex: 'warranty_expiry',
      render: (v: string | null) => (
        <Space direction="vertical" size={0}>
          <span style={{ fontSize: 12, color: C.text }}>{fmtDate(v)}</span>
          {v && <small>{daysLeft(v)}</small>}
        </Space>
      ),
    },
    {
      title: 'EOL Tarihi',
      dataIndex: 'eol_date',
      render: fmtDate,
    },
    {
      title: 'Satın Alma',
      dataIndex: 'purchase_date',
      render: fmtDate,
    },
    {
      title: 'Maliyet',
      dataIndex: 'purchase_cost',
      render: (v: number | null, row: AssetItem) =>
        v != null
          ? <Text style={{ fontSize: 12, color: '#22c55e', fontWeight: 600 }}>{v.toLocaleString('tr-TR')} {row.currency}</Text>
          : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: 'Destek',
      dataIndex: 'support_tier',
      render: (v: string | null) => {
        if (!v) return <Text style={{ color: C.dim }}>—</Text>
        const hex = SUPPORT_HEX[v] ?? '#64748b'
        return <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 10 }}>{v}</Tag>
      },
    },
    {
      title: 'Sözleşme',
      dataIndex: 'vendor_contract',
      render: (v: string | null) => v
        ? <Text style={{ fontSize: 12, color: C.text }}>{v}</Text>
        : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: any, row: AssetItem) => (
        <Space>
          <Tooltip title="Düzenle">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          </Tooltip>
          <Tooltip title="Sil">
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => confirmDelete(row)} />
          </Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{ASSET_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#f9731620' : C.border}`,
        borderLeft: '4px solid #f97316',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#f9731620', border: '1px solid #f9731630',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <CalendarOutlined style={{ color: '#f97316', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>Asset Lifecycle & CMDB</div>
            <div style={{ color: C.muted, fontSize: 12 }}>Cihaz garanti, EOL ve yaşam döngüsü takibi</div>
          </div>
        </div>
        <Space>
          <Tooltip title="Tüm cihazların model bilgisini EOL veritabanında ara ve tarihleri otomatik güncelle">
            <Button
              icon={<SyncOutlined />}
              loading={eolLookupMut.isPending}
              onClick={() => eolLookupMut.mutate()}
            >
              EOL Otomatik Ara
            </Button>
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={openNew}
            style={{ background: '#f97316', borderColor: '#f97316' }}>
            Asset Ekle
          </Button>
        </Space>
      </div>

      {/* Stat Cards */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {[
          { label: 'Takip Edilen', value: stats?.total ?? 0, color: '#3b82f6', icon: <CalendarOutlined /> },
          { label: '30 Günde Bitiyor', value: stats?.expiring_30d ?? 0, color: (stats?.expiring_30d ?? 0) > 0 ? '#f97316' : '#64748b', icon: <WarningOutlined /> },
          { label: '90 Günde Bitiyor', value: stats?.expiring_90d ?? 0, color: (stats?.expiring_90d ?? 0) > 0 ? '#f59e0b' : '#64748b', icon: <WarningOutlined /> },
          { label: 'Süresi Dolmuş', value: stats?.expired ?? 0, color: (stats?.expired ?? 0) > 0 ? '#ef4444' : '#64748b', icon: <CloseCircleOutlined /> },
          { label: 'EOL Cihaz', value: stats?.eol_count ?? 0, color: (stats?.eol_count ?? 0) > 0 ? '#ef4444' : '#64748b', icon: <CloseCircleOutlined /> },
          {
            label: 'Toplam Maliyet',
            value: stats?.total_cost != null ? stats.total_cost.toLocaleString('tr-TR') : '0',
            suffix: ' TRY',
            color: '#22c55e',
            icon: <DollarOutlined />,
          },
        ].map((s) => (
          <div key={s.label} style={{
            flex: 1, minWidth: 110,
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
              <div style={{ color: s.color, fontSize: 18, fontWeight: 800, lineHeight: 1 }}>
                {s.value}{'suffix' in s && <span style={{ fontSize: 11, fontWeight: 400 }}>{s.suffix}</span>}
              </div>
              <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Upcoming expirations */}
      {stats && stats.upcoming_expirations.length > 0 && (
        <div style={{
          background: isDark ? 'linear-gradient(135deg, #f9731608 0%, #1e293b 100%)' : C.bg,
          border: `1px solid ${isDark ? '#f9731625' : C.border}`,
          borderLeft: '3px solid #f97316',
          borderRadius: 10, padding: '10px 16px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <WarningOutlined style={{ color: '#f97316' }} />
            <Text style={{ fontSize: 12, fontWeight: 600, color: C.text }}>Yaklaşan Garanti Bitişleri</Text>
          </div>
          <Space wrap>
            {stats.upcoming_expirations.map((e) => {
              const hex = e.days_left <= 30 ? '#f97316' : '#f59e0b'
              return (
                <Tag key={e.device_id} style={{ color: hex, borderColor: hex + '50', background: hex + '18', marginBottom: 4 }}>
                  {e.device_hostname} — {e.days_left}g
                </Tag>
              )
            })}
          </Space>
        </div>
      )}

      {/* Warranty expiration timeline */}
      {stats && stats.upcoming_expirations.length > 0 && (() => {
        const now = dayjs()
        const buckets: Record<string, { month: string; count: number; critical: number }> = {}
        for (let i = 0; i < 12; i++) {
          const m = now.add(i, 'month')
          const key = m.format('YYYY-MM')
          buckets[key] = { month: m.format('MMM YY'), count: 0, critical: 0 }
        }
        for (const e of stats.upcoming_expirations) {
          const key = dayjs(e.warranty_expiry).format('YYYY-MM')
          if (buckets[key]) {
            buckets[key].count++
            if (e.days_left <= 30) buckets[key].critical++
          }
        }
        const chartData = Object.values(buckets)
        const hasAny = chartData.some((b) => b.count > 0)
        if (!hasAny) return null
        return (
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: isDark ? '#0f172a' : '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
              <CalendarOutlined style={{ color: '#f97316' }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Garanti Bitiş Takvimi (12 ay)</span>
            </div>
            <div style={{ padding: '12px 16px 8px' }}>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -28 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#e2e8f0'} opacity={0.5} />
                  <XAxis dataKey="month" tick={{ fontSize: 10, fill: C.muted }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: C.muted }} />
                  <RechartTooltip
                    contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 }}
                    formatter={(v: unknown, name: unknown) => [`${v} cihaz`, name === 'critical' ? '≤30 gün' : 'Bu ay bitiyor']}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={36}>
                    {chartData.map((b, i) => (
                      <Cell key={i} fill={b.critical > 0 ? '#ef4444' : '#f97316'} fillOpacity={0.8} />
                    ))}
                    <LabelList dataKey="count" position="top" style={{ fontSize: 10, fill: C.muted }}
                      formatter={(v: unknown) => (v as number) > 0 ? `${v}` : ''}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )
      })()}

      {/* Filters */}
      <Space wrap>
        <Input
          prefix={<SearchOutlined style={{ color: C.muted }} />}
          placeholder="Cihaz ara..."
          allowClear
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          style={{ width: 220 }}
        />
        <Select
          allowClear
          placeholder="Durum filtrele"
          value={statusFilter}
          onChange={(v) => { setStatusFilter(v); setPage(1) }}
          style={{ width: 180 }}
          options={[
            { value: 'expiring_soon', label: '30 Günde Bitiyor' },
            { value: 'expiring_90d', label: '90 Günde Bitiyor' },
            { value: 'expired', label: 'Süresi Dolmuş' },
            { value: 'eol', label: 'EOL' },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries({ queryKey: ['asset-lifecycle'] })}>
          Yenile
        </Button>
      </Space>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>Asset Kaydı</span>
          {data && <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>{data.total} kayıt</span>}
        </div>
        <Table
          dataSource={data?.items ?? []}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          size="small"
          pagination={{
            current: page,
            pageSize: 50,
            total: data?.total ?? 0,
            onChange: setPage,
            showTotal: (t) => `${t} kayıt`,
          }}
          rowClassName={(r: AssetItem) =>
            r.lifecycle_status === 'expired' || r.lifecycle_status === 'eol' ? 'asset-row-expired'
            : r.lifecycle_status === 'expiring_soon' ? 'asset-row-expiring' : ''
          }
          onRow={() => ({ style: { animation: 'assetRowIn 0.2s ease-out' } })}
        />
      </div>

      <AssetDrawer
        open={drawerOpen}
        asset={editAsset}
        onClose={() => { setDrawerOpen(false); setEditAsset(null) }}
      />

      {/* EOL Lookup Results Modal */}
      <Modal
        open={eolModalOpen}
        onCancel={() => { setEolModalOpen(false); setEolResults(null) }}
        title={
          <Space>
            <SyncOutlined style={{ color: '#3b82f6' }} />
            <span style={{ color: C.text }}>EOL Otomatik Arama Sonuçları</span>
          </Space>
        }
        width={700}
        footer={<Button type="primary" onClick={() => { setEolModalOpen(false); setEolResults(null) }}>Kapat</Button>}
        destroyOnHidden
        styles={{
          content: { background: C.bg, border: `1px solid ${C.border}` },
          header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
        }}
      >
        {eolResults && (
          <>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              {[
                { label: 'Kontrol Edilen', value: eolResults.checked, color: '#3b82f6' },
                { label: 'Güncellenen', value: eolResults.updated, color: '#22c55e' },
                { label: 'Bulunamadı', value: eolResults.not_found, color: '#64748b' },
              ].map((s) => (
                <div key={s.label} style={{
                  flex: 1, textAlign: 'center',
                  background: isDark ? `${s.color}0d` : `${s.color}0a`,
                  border: `1px solid ${s.color}33`,
                  borderRadius: 8, padding: '10px 0',
                }}>
                  <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{s.label}</div>
                </div>
              ))}
            </div>

            {eolResults.updated > 0 && (
              <Alert
                type="success"
                showIcon
                style={{ marginBottom: 12, fontSize: 12 }}
                message={`${eolResults.updated} cihazın EOL/EOS tarihleri asset lifecycle kaydına yazıldı.`}
              />
            )}

            <Table
              size="small"
              dataSource={eolResults.results}
              rowKey="device_id"
              pagination={false}
              scroll={{ y: 360 }}
              columns={[
                {
                  title: 'Cihaz',
                  dataIndex: 'hostname',
                  render: (v: string) => <strong style={{ color: C.text }}>{v}</strong>,
                },
                {
                  title: 'Model',
                  dataIndex: 'model',
                  render: (v: string | null) => v ?? <span style={{ color: C.dim }}>—</span>,
                },
                {
                  title: 'Eşleşme',
                  dataIndex: 'matched_model',
                  render: (v: string | null, row: EolLookupResult) =>
                    row.status === 'matched' ? (
                      <Tag style={{ color: '#3b82f6', borderColor: '#3b82f650', background: '#3b82f618', fontSize: 11 }}>{v}</Tag>
                    ) : (
                      <Tag style={{ color: '#64748b', borderColor: '#64748b50', background: '#64748b18', fontSize: 11 }}>Bulunamadı</Tag>
                    ),
                },
                {
                  title: 'EOL',
                  dataIndex: 'eol_date',
                  render: (v: string | null) => v
                    ? <Tag style={{ color: '#ef4444', borderColor: '#ef444450', background: '#ef444418', fontSize: 11 }}>{dayjs(v).format('DD.MM.YYYY')}</Tag>
                    : <span style={{ color: C.dim }}>—</span>,
                },
                {
                  title: 'EOS',
                  dataIndex: 'eos_date',
                  render: (v: string | null) => v
                    ? <Tag style={{ color: '#f97316', borderColor: '#f9731650', background: '#f9731618', fontSize: 11 }}>{dayjs(v).format('DD.MM.YYYY')}</Tag>
                    : <span style={{ color: C.dim }}>—</span>,
                },
                {
                  title: '',
                  dataIndex: 'status',
                  width: 36,
                  render: (v: string) =>
                    v === 'matched'
                      ? <CheckCircleOutlined style={{ color: '#22c55e' }} />
                      : <CloseCircleOutlined style={{ color: C.dim }} />,
                },
              ]}
            />
          </>
        )}
      </Modal>
    </div>
  )
}
