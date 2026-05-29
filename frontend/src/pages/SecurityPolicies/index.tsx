/**
 * T10 Faz C C6a — Security Policy CRUD (switch + port).
 *
 * Tabs (Switch / Port) + Table + Drawer form (alan-şeması ile gruplu). NULL = "kontrol
 * kapalı" (boş alan → backend'e null gider, 0 DEĞİL; tabloda "—"). org_admin+ yazma,
 * viewer salt-okunur. Feature gate router seviyesinde (security_policy kapalı → menü gizli,
 * API 403). auto_quarantine_on_nth_flap yalnız öneri — gerçek shutdown YOK (C5 sonrası).
 */
import { useMemo, useState } from 'react'
import {
  Button, Collapse, Drawer, Empty, Form, Input, InputNumber, Popconfirm,
  Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  DeleteOutlined, EditOutlined, PlusOutlined, StarFilled, StarOutlined, InfoCircleOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  securityPoliciesApi, type PolicyKind, type FieldDef,
  SWITCH_FIELDS, PORT_FIELDS, SEVERITY_OPTIONS, CONFIG_CHANGE_OPTIONS,
} from '@/api/securityPolicies'
import { useAuthStore } from '@/store/auth'
import { useSite } from '@/contexts/SiteContext'

const { Paragraph } = Typography

function fieldsFor(kind: PolicyKind): FieldDef[] {
  return kind === 'switch' ? SWITCH_FIELDS : PORT_FIELDS
}

// Tablo/gösterim: NULL → "—" (kontrol kapalı). w/c çiftleri kompakt.
const dash = (v: any) => (v === null || v === undefined ? '—' : String(v))

function renderFieldInput(f: FieldDef) {
  switch (f.type) {
    case 'severity':
      return <Select allowClear placeholder="(kapalı)" options={SEVERITY_OPTIONS.map((s) => ({ value: s, label: s }))} />
    case 'config_change':
      return <Select allowClear placeholder="(kapalı)" options={CONFIG_CHANGE_OPTIONS.map((s) => ({ value: s, label: s }))} />
    case 'bool':
      return (
        <Select allowClear placeholder="(kapalı)"
          options={[{ value: true, label: 'Evet (alarm açık)' }, { value: false, label: 'Hayır' }]} />
      )
    case 'text':
      return <Input allowClear placeholder="(boş = kontrol kapalı)" />
    default: // int | pct
      return <InputNumber style={{ width: '100%' }} placeholder="(boş = kapalı)" min={0}
        max={f.type === 'pct' ? 100 : undefined} />
  }
}

function PolicyTab({ kind }: { kind: PolicyKind }) {
  const qc = useQueryClient()
  const { isOrgAdmin } = useAuthStore()
  const canWrite = isOrgAdmin()
  const fields = fieldsFor(kind)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Record<string, any> | null>(null)
  const [form] = Form.useForm()

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['secpol', kind],
    queryFn: () => securityPoliciesApi.list(kind),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['secpol', kind] })

  const saveMut = useMutation({
    mutationFn: (body: Record<string, any>) =>
      editing ? securityPoliciesApi.update(kind, editing.id, body) : securityPoliciesApi.create(kind, body),
    onSuccess: () => { message.success('Policy kaydedildi'); setOpen(false); invalidate() },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Kaydedilemedi'),
  })
  const delMut = useMutation({
    mutationFn: (id: number) => securityPoliciesApi.remove(kind, id),
    onSuccess: () => { message.success('Policy silindi'); invalidate() },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silinemedi'),
  })
  const defMut = useMutation({
    mutationFn: (id: number) => securityPoliciesApi.setDefault(kind, id),
    onSuccess: () => { message.success('Varsayılan policy güncellendi'); invalidate() },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Güncellenemedi'),
  })

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    setOpen(true)
  }
  const openEdit = (rec: Record<string, any>) => {
    setEditing(rec)
    // null değerler form'da boş (undefined) görünsün → "kontrol kapalı"
    const init: Record<string, any> = { name: rec.name, description: rec.description, is_default: rec.is_default }
    for (const f of fields) init[f.key] = rec[f.key] ?? undefined
    form.setFieldsValue(init)
    setOpen(true)
  }

  const onFinish = (vals: Record<string, any>) => {
    // NULL semantic: boş/undefined alan → null (0 DEĞİL). Tüm alanları gönder.
    const body: Record<string, any> = {
      name: (vals.name || '').trim(),
      description: vals.description || null,
      is_default: !!vals.is_default,
    }
    for (const f of fields) {
      const v = vals[f.key]
      body[f.key] = v === undefined || v === '' ? null : v
    }
    saveMut.mutate(body)
  }

  const groups = useMemo(() => {
    const g: Record<string, FieldDef[]> = {}
    for (const f of fields) (g[f.group] ||= []).push(f)
    return g
  }, [fields])

  // Tablo kolonları (özet eşikler kind'a göre).
  const summaryCols = kind === 'switch'
    ? [
        { title: 'CPU (u/k)', render: (_: any, r: any) => `${dash(r.cpu_warning)}/${dash(r.cpu_critical)}` },
        { title: 'Bellek (u/k)', render: (_: any, r: any) => `${dash(r.memory_warning)}/${dash(r.memory_critical)}` },
        { title: 'PoE% (u/k)', render: (_: any, r: any) => `${dash(r.poe_budget_warning_pct)}/${dash(r.poe_budget_critical_pct)}` },
      ]
    : [
        { title: 'MAC flood (u/k)', render: (_: any, r: any) => `${dash(r.mac_flood_warning)}/${dash(r.mac_flood_critical)}` },
        { title: 'Flap (pencere/geçiş)', render: (_: any, r: any) => `${dash(r.mac_flap_window_min)}dk/${dash(r.mac_flap_min_transitions)}` },
        { title: 'Auto-quar (öneri)', render: (_: any, r: any) => dash(r.auto_quarantine_on_nth_flap) },
      ]

  const columns: any[] = [
    {
      title: 'Ad', dataIndex: 'name',
      render: (v: string, r: any) => (
        <Space>
          <span>{v}</span>
          {r.is_default && <Tag color="gold" icon={<StarFilled />}>Varsayılan</Tag>}
        </Space>
      ),
    },
    ...summaryCols,
    {
      title: 'Aksiyon', width: 220,
      render: (_: any, r: any) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
            {canWrite ? 'Düzenle' : 'Gör'}
          </Button>
          {canWrite && !r.is_default && (
            <Tooltip title="Bu org için varsayılan yap">
              <Button size="small" icon={<StarOutlined />} onClick={() => defMut.mutate(r.id)} />
            </Tooltip>
          )}
          {canWrite && (
            <Popconfirm
              title={r.is_default
                ? 'Bu VARSAYILAN policy. Silinirse org varsayılansız kalır (resolver hardcoded fallback kullanır). Yine de sil?'
                : 'Policy silinsin mi?'}
              okText="Sil" okButtonProps={{ danger: true }}
              onConfirm={() => delMut.mutate(r.id)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        {canWrite && <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Yeni Policy</Button>}
        {!canWrite && <Tag>Salt-okunur (org_admin+ düzenleyebilir)</Tag>}
      </Space>
      <Table
        rowKey="id" loading={isLoading} columns={columns} dataSource={rows}
        size="small" pagination={false}
        locale={{ emptyText: <Empty description="Policy yok" /> }}
      />

      <Drawer
        title={editing ? `Policy: ${editing.name}` : 'Yeni Policy'}
        width={560} open={open} onClose={() => setOpen(false)}
        extra={canWrite && (
          <Button type="primary" loading={saveMut.isPending} onClick={() => form.submit()}>Kaydet</Button>
        )}
      >
        <Paragraph type="secondary" style={{ fontSize: 12 }}>
          <InfoCircleOutlined /> <strong>Boş bırakılan alan = bu kontrol çalışmaz (kapalı/sessiz).</strong>{' '}
          0 ile boş (NULL) farklıdır. Severity: info/warning/critical.
        </Paragraph>
        <Form form={form} layout="vertical" onFinish={onFinish} disabled={!canWrite}>
          <Form.Item name="name" label="Ad" rules={[{ required: true, message: 'Ad zorunlu' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Açıklama">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="is_default" label="Bu org için varsayılan policy" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Collapse
            defaultActiveKey={Object.keys(groups).slice(0, 2)}
            items={Object.entries(groups).map(([group, defs]) => ({
              key: group,
              label: group,
              children: defs.map((f) => (
                <Form.Item key={f.key} name={f.key} label={f.label}
                  tooltip={f.hint || undefined} style={{ marginBottom: 12 }}>
                  {renderFieldInput(f)}
                </Form.Item>
              )),
            }))}
          />
        </Form>
      </Drawer>
    </>
  )
}

export default function SecurityPoliciesPage() {
  const { isOrgWide } = useSite()  // sadece bağlam — sayfa RLS org-scoped
  void isOrgWide
  return (
    <div style={{ padding: 16 }}>
      <Typography.Title level={4}>Güvenlik Politikaları</Typography.Title>
      <Paragraph type="secondary" style={{ fontSize: 13 }}>
        Switch ve port güvenlik politikaları. Cihaza policy atanmazsa org varsayılanı, o da yoksa
        sabit fallback kullanılır. Boş (NULL) alan = ilgili kontrol kapalı.
      </Paragraph>
      <Tabs
        items={[
          { key: 'switch', label: 'Switch Policies', children: <PolicyTab kind="switch" /> },
          { key: 'port', label: 'Port Policies', children: <PolicyTab kind="port" /> },
        ]}
      />
    </div>
  )
}
