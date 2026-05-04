import { useState } from 'react'
import {
  Table, Button, Tag, Modal, Form, Input, Select, Space, Drawer,
  Descriptions, Progress, Empty, Popconfirm, Transfer,
  Typography, Badge,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  AlertOutlined, CheckCircleOutlined, ApartmentOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { servicesApi, type Service } from '@/api/services'
import { devicesApi } from '@/api/devices'
import { useTheme } from '@/contexts/ThemeContext'
import { message } from 'antd'

const { Text } = Typography

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

const PRIORITY_COLOR: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#22c55e',
}

const IMPACT_COLOR: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#22c55e',
  none: '#22c55e',
}

export default function ServicesPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [impactId, setImpactId] = useState<number | null>(null)
  const [targetKeys, setTargetKeys] = useState<string[]>([])

  const { data, isLoading } = useQuery({ queryKey: ['services'], queryFn: servicesApi.list })
  const { data: devicesData } = useQuery({ queryKey: ['devices-all'], queryFn: () => devicesApi.list({ limit: 500 }) })
  const { data: impactData } = useQuery({
    queryKey: ['service-impact', impactId],
    queryFn: () => servicesApi.getImpact(impactId!),
    enabled: !!impactId,
  })

  const createMut = useMutation({
    mutationFn: servicesApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['services'] }); closeDrawer(); message.success('Servis oluşturuldu') },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof servicesApi.update>[1] }) => servicesApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['services'] }); closeDrawer(); message.success('Servis güncellendi') },
  })
  const deleteMut = useMutation({
    mutationFn: servicesApi.delete,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['services'] }); message.success('Servis silindi') },
  })

  const closeDrawer = () => {
    setDrawerOpen(false)
    setEditId(null)
    setTargetKeys([])
    form.resetFields()
  }

  const openCreate = () => {
    form.resetFields()
    setTargetKeys([])
    setEditId(null)
    setDrawerOpen(true)
  }

  const openEdit = (svc: Service) => {
    setEditId(svc.id)
    setTargetKeys((svc.device_ids || []).map(String))
    form.setFieldsValue({
      name: svc.name,
      description: svc.description,
      priority: svc.priority,
      business_owner: svc.business_owner,
      vlan_ids: (svc.vlan_ids || []).join(', '),
      is_active: svc.is_active,
    })
    setDrawerOpen(true)
  }

  const onSave = () => {
    form.validateFields().then(values => {
      const payload = {
        name: values.name,
        description: values.description || undefined,
        priority: values.priority || 'medium',
        business_owner: values.business_owner || undefined,
        device_ids: targetKeys.map(Number),
        vlan_ids: values.vlan_ids
          ? values.vlan_ids.split(',').map((v: string) => parseInt(v.trim())).filter((n: number) => !isNaN(n))
          : [],
        is_active: values.is_active !== false,
      }
      if (editId) {
        updateMut.mutate({ id: editId, data: payload })
      } else {
        createMut.mutate(payload)
      }
    })
  }

  const allDevices = devicesData?.items || []
  const transferSource = allDevices.map(d => ({
    key: String(d.id),
    title: d.hostname,
    description: d.ip_address,
  }))

  const columns = [
    {
      title: 'Servis Adı',
      dataIndex: 'name',
      render: (n: string, row: Service) => (
        <Space>
          <span style={{ color: C.text, fontWeight: 600 }}>{n}</span>
          {!row.is_active && <Tag color="default" style={{ fontSize: 10 }}>Pasif</Tag>}
        </Space>
      ),
    },
    {
      title: 'Öncelik',
      dataIndex: 'priority',
      width: 100,
      render: (p: string) => (
        <Tag style={{ color: PRIORITY_COLOR[p], borderColor: PRIORITY_COLOR[p] + '40', background: PRIORITY_COLOR[p] + '15', margin: 0 }}>
          {p === 'critical' ? 'Kritik' : p === 'high' ? 'Yüksek' : p === 'medium' ? 'Orta' : 'Düşük'}
        </Tag>
      ),
    },
    {
      title: 'Cihazlar',
      dataIndex: 'device_ids',
      width: 90,
      render: (ids: number[]) => <Badge count={(ids || []).length} color="#3b82f6" />,
    },
    {
      title: 'VLAN\'lar',
      dataIndex: 'vlan_ids',
      width: 90,
      render: (ids: number[]) => (ids || []).length > 0 ? <Badge count={(ids || []).length} color="#8b5cf6" /> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Sorumlu',
      dataIndex: 'business_owner',
      render: (o: string) => o ? <Text style={{ fontSize: 12, color: C.muted }}>{o}</Text> : <Text type="secondary">—</Text>,
    },
    {
      title: '',
      width: 140,
      render: (_: unknown, row: Service) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setImpactId(row.id)}>Etki</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          <Popconfirm title="Silinsin mi?" onConfirm={() => deleteMut.mutate(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: '16px 20px', background: isDark ? '#030c1e' : '#f0f5fb', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, color: C.text, fontSize: 18, fontWeight: 700 }}>
            <ApartmentOutlined style={{ marginRight: 8, color: '#3b82f6' }} />
            Servis Etki Haritası
          </h2>
          <p style={{ margin: '4px 0 0', color: C.muted, fontSize: 13 }}>
            Mantıksal servisler ve cihaz etki analizi
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Yeni Servis
        </Button>
      </div>

      <Table
        dataSource={data?.items || []}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 20 }}
        style={{ background: C.bg, borderRadius: 8 }}
      />

      {/* Create / Edit Drawer */}
      <Drawer
        title={editId ? 'Servis Düzenle' : 'Yeni Servis'}
        open={drawerOpen}
        onClose={closeDrawer}
        width={520}
        extra={
          <Button type="primary" onClick={onSave} loading={createMut.isPending || updateMut.isPending}>
            Kaydet
          </Button>
        }
        styles={{ body: { background: C.bg }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Servis Adı" rules={[{ required: true }]}>
            <Input placeholder="POS Sistemi" />
          </Form.Item>
          <Form.Item name="description" label="Açıklama">
            <Input.TextArea rows={2} placeholder="Satış noktası işlem altyapısı" />
          </Form.Item>
          <Form.Item name="priority" label="Öncelik" initialValue="medium">
            <Select options={[
              { value: 'critical', label: 'Kritik' },
              { value: 'high',     label: 'Yüksek' },
              { value: 'medium',   label: 'Orta' },
              { value: 'low',      label: 'Düşük' },
            ]} />
          </Form.Item>
          <Form.Item name="business_owner" label="Sorumlu">
            <Input placeholder="Ağ Ekibi" />
          </Form.Item>
          <Form.Item name="vlan_ids" label="VLAN'lar (virgülle ayır)">
            <Input placeholder="10, 20, 30" />
          </Form.Item>
          <Form.Item label="Bağlı Cihazlar">
            <Transfer
              dataSource={transferSource}
              targetKeys={targetKeys}
              onChange={(keys) => setTargetKeys(keys as string[])}
              render={(item) => item.title}
              titles={['Mevcut', 'Seçili']}
              listStyle={{ width: '45%', height: 240 }}
              showSearch
              filterOption={(val, item) =>
                (item.title?.toLowerCase() || '').includes(val.toLowerCase()) ||
                (item.description?.toLowerCase() || '').includes(val.toLowerCase())
              }
            />
          </Form.Item>
        </Form>
      </Drawer>

      {/* Impact Modal */}
      <Modal
        title={<Space><AlertOutlined /> Servis Etki Analizi</Space>}
        open={!!impactId}
        onCancel={() => setImpactId(null)}
        footer={null}
        width={560}
        styles={{ content: { background: C.bg }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}
      >
        {impactData && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{
                width: 60, height: 60, borderRadius: 12,
                background: IMPACT_COLOR[impactData.impact_level] + '18',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              }}>
                {impactData.impact_level === 'none'
                  ? <CheckCircleOutlined style={{ fontSize: 22, color: '#22c55e' }} />
                  : <AlertOutlined style={{ fontSize: 22, color: IMPACT_COLOR[impactData.impact_level] }} />
                }
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: C.text }}>{impactData.service_name}</div>
                <Tag style={{
                  color: IMPACT_COLOR[impactData.impact_level],
                  borderColor: IMPACT_COLOR[impactData.impact_level] + '40',
                  background: IMPACT_COLOR[impactData.impact_level] + '15',
                  marginTop: 4,
                }}>
                  {impactData.impact_level === 'none' ? 'Etkilenmiyor' :
                   impactData.impact_level === 'critical' ? 'Kritik Etki' :
                   impactData.impact_level === 'high' ? 'Yüksek Etki' :
                   impactData.impact_level === 'medium' ? 'Orta Etki' : 'Düşük Etki'}
                </Tag>
              </div>
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: IMPACT_COLOR[impactData.impact_level] }}>
                  %{impactData.impact_pct}
                </div>
                <div style={{ fontSize: 11, color: C.muted }}>etkileniyor</div>
              </div>
            </div>

            <Progress
              percent={impactData.impact_pct}
              strokeColor={IMPACT_COLOR[impactData.impact_level]}
              style={{ marginBottom: 16 }}
            />

            <Descriptions column={2} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Offline Cihaz">
                <span style={{ color: '#ef4444', fontWeight: 700 }}>{impactData.affected_count}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Online Cihaz">
                <span style={{ color: '#22c55e', fontWeight: 700 }}>{impactData.healthy_count}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Öncelik">
                <Tag style={{ color: PRIORITY_COLOR[impactData.priority], borderColor: PRIORITY_COLOR[impactData.priority] + '40', background: PRIORITY_COLOR[impactData.priority] + '15', margin: 0 }}>
                  {impactData.priority}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="VLAN'lar">
                {(impactData.vlan_ids || []).length > 0
                  ? (impactData.vlan_ids || []).map(v => <Tag key={v} style={{ margin: '0 2px', fontSize: 10 }}>{v}</Tag>)
                  : <Text type="secondary">—</Text>}
              </Descriptions.Item>
            </Descriptions>

            {impactData.affected_devices.length > 0 && (
              <>
                <div style={{ fontWeight: 600, color: '#ef4444', marginBottom: 6, fontSize: 13 }}>
                  <AlertOutlined /> Offline Cihazlar
                </div>
                {impactData.affected_devices.map(d => (
                  <div key={d.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
                    background: '#ef444410', borderRadius: 6, marginBottom: 4,
                  }}>
                    <span style={{ color: '#ef4444', fontSize: 12 }}>●</span>
                    <span style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{d.hostname}</span>
                    <span style={{ color: C.muted, fontSize: 11 }}>{d.ip_address}</span>
                  </div>
                ))}
              </>
            )}

            {impactData.healthy_devices.length > 0 && (
              <>
                <div style={{ fontWeight: 600, color: '#22c55e', marginBottom: 6, marginTop: 10, fontSize: 13 }}>
                  <CheckCircleOutlined /> Online Cihazlar
                </div>
                {impactData.healthy_devices.map(d => (
                  <div key={d.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
                    background: '#22c55e10', borderRadius: 6, marginBottom: 4,
                  }}>
                    <span style={{ color: '#22c55e', fontSize: 12 }}>●</span>
                    <span style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{d.hostname}</span>
                    <span style={{ color: C.muted, fontSize: 11 }}>{d.ip_address}</span>
                  </div>
                ))}
              </>
            )}

            {impactData.affected_count === 0 && impactData.healthy_count === 0 && (
              <Empty description="Bu servise atanmış cihaz yok" />
            )}
          </>
        )}
      </Modal>
    </div>
  )
}
