import { useState } from 'react'
import {
  App, Button, Card, Col, Form, Input, Modal, Popconfirm,
  Row, Space, Table, Tag, Tooltip, Typography, ColorPicker,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  EnvironmentOutlined, LaptopOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { locationsApi, type Location } from '@/api/locations'
import { useTheme } from '@/contexts/ThemeContext'
import dayjs from 'dayjs'

const { Title, Text } = Typography

const DEFAULT_COLORS = [
  '#3b82f6', '#22c55e', '#f97316', '#ef4444',
  '#8b5cf6', '#06b6d4', '#eab308', '#ec4899',
]

export default function LocationsPage() {
  const { message } = App.useApp()
  const { isDark } = useTheme()
  const qc = useQueryClient()

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Location | null>(null)
  const [form] = Form.useForm()
  const [colorValue, setColorValue] = useState<string>('#3b82f6')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['locations'],
    queryFn: () => locationsApi.list(),
  })

  const createMutation = useMutation({
    mutationFn: locationsApi.create,
    onSuccess: () => {
      message.success('Lokasyon oluşturuldu')
      qc.invalidateQueries({ queryKey: ['locations'] })
      qc.invalidateQueries({ queryKey: ['device-location-options'] })
      closeModal()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Oluşturulamadı'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof locationsApi.update>[1] }) =>
      locationsApi.update(id, data),
    onSuccess: () => {
      message.success('Lokasyon güncellendi')
      qc.invalidateQueries({ queryKey: ['locations'] })
      qc.invalidateQueries({ queryKey: ['device-location-options'] })
      closeModal()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Güncellenemedi'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => locationsApi.delete(id, true),
    onSuccess: () => {
      message.success('Lokasyon silindi')
      qc.invalidateQueries({ queryKey: ['locations'] })
      qc.invalidateQueries({ queryKey: ['device-location-options'] })
    },
    onError: () => message.error('Silinemedi'),
  })

  const openCreate = () => {
    setEditing(null)
    setColorValue('#3b82f6')
    form.resetFields()
    form.setFieldValue('color', '#3b82f6')
    setModalOpen(true)
  }

  const openEdit = (loc: Location) => {
    setEditing(loc)
    const c = loc.color || '#3b82f6'
    setColorValue(c)
    form.setFieldsValue({ name: loc.name, description: loc.description || '', address: loc.address || '', color: c })
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setEditing(null)
    form.resetFields()
  }

  const handleSubmit = async () => {
    const values = await form.validateFields()
    const payload = { ...values, color: colorValue }
    if (editing) {
      updateMutation.mutate({ id: editing.id, data: payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  const cardBg = isDark ? '#0e1e38' : '#ffffff'
  const border = isDark ? '#1a3458' : '#e2e8f0'
  const subText = isDark ? '#64748b' : '#94a3b8'

  const items = data?.items || []
  const totalDevices = items.reduce((s, l) => s + l.device_count, 0)

  const columns = [
    {
      title: 'Lokasyon',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, rec: Location) => (
        <Space>
          <div style={{
            width: 12, height: 12, borderRadius: '50%',
            background: rec.color || '#3b82f6', flexShrink: 0,
          }} />
          <Text strong style={{ fontSize: 14 }}>{name}</Text>
        </Space>
      ),
    },
    {
      title: 'Açıklama',
      dataIndex: 'description',
      key: 'description',
      render: (v: string | null) => v ? <Text type="secondary">{v}</Text> : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>,
    },
    {
      title: 'Adres',
      dataIndex: 'address',
      key: 'address',
      render: (v: string | null) => v ? <Text style={{ fontSize: 13 }}>{v}</Text> : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>,
    },
    {
      title: 'Cihaz',
      dataIndex: 'device_count',
      key: 'device_count',
      width: 90,
      render: (n: number) => (
        <Tag icon={<LaptopOutlined />} color={n > 0 ? 'blue' : 'default'}>
          {n}
        </Tag>
      ),
    },
    {
      title: 'Eklenme',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 130,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('DD.MM.YYYY')}</Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, rec: Location) => (
        <Space size={4}>
          <Tooltip title="Düzenle">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(rec)} />
          </Tooltip>
          <Popconfirm
            title="Lokasyonu sil"
            description={rec.device_count > 0
              ? `${rec.device_count} cihazın site alanı temizlenecek. Emin misiniz?`
              : 'Bu lokasyonu silmek istediğinize emin misiniz?'}
            okText="Sil"
            cancelText="İptal"
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteMutation.mutate(rec.id)}
          >
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            <EnvironmentOutlined style={{ marginRight: 8, color: '#3b82f6' }} />
            Lokasyon Yönetimi
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            Ağ lokasyonlarını tanımlayın — header'dan seçerek lokasyon bazlı izleme yapın
          </Text>
        </div>
        <Space>
          <Tooltip title="Yenile">
            <Button icon={<ReloadOutlined />} onClick={() => refetch()} />
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Yeni Lokasyon
          </Button>
        </Space>
      </div>

      {/* Summary cards */}
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        <Col xs={24} sm={8}>
          <Card style={{ background: cardBg, border: `1px solid ${border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <EnvironmentOutlined style={{ fontSize: 24, color: '#3b82f6' }} />
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>Toplam Lokasyon</Text>
                <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>{items.length}</div>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card style={{ background: cardBg, border: `1px solid ${border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <LaptopOutlined style={{ fontSize: 24, color: '#22c55e' }} />
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>Atanmış Cihaz</Text>
                <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>{totalDevices}</div>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card style={{ background: cardBg, border: `1px solid ${border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <EnvironmentOutlined style={{ fontSize: 24, color: '#f97316' }} />
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>Boş Lokasyon</Text>
                <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2 }}>
                  {items.filter((l) => l.device_count === 0).length}
                </div>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Table */}
      <Card style={{ background: cardBg, border: `1px solid ${border}` }}>
        <Table
          columns={columns}
          dataSource={items}
          rowKey="id"
          loading={isLoading}
          pagination={false}
          size="small"
          locale={{ emptyText: 'Henüz lokasyon eklenmemiş — "Yeni Lokasyon" butonunu kullanın' }}
        />
      </Card>

      {/* Color quick-pick display */}
      <Modal
        title={editing ? 'Lokasyon Düzenle' : 'Yeni Lokasyon'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={closeModal}
        okText={editing ? 'Güncelle' : 'Oluştur'}
        cancelText="İptal"
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        width={480}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            label="Lokasyon Adı"
            name="name"
            rules={[{ required: true, message: 'Lokasyon adı zorunlu' }]}
          >
            <Input placeholder="örn. Merkez Ofis, İstanbul DC, Şube-1" />
          </Form.Item>

          <Form.Item label="Renk" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {DEFAULT_COLORS.map((c) => (
                <div
                  key={c}
                  onClick={() => setColorValue(c)}
                  style={{
                    width: 28, height: 28, borderRadius: 6,
                    background: c, cursor: 'pointer',
                    border: colorValue === c ? '3px solid #fff' : '3px solid transparent',
                    boxShadow: colorValue === c ? `0 0 0 2px ${c}` : undefined,
                    transition: 'all 0.15s',
                  }}
                />
              ))}
              <ColorPicker
                value={colorValue}
                onChange={(_, hex) => setColorValue(hex)}
                size="small"
              />
            </div>
          </Form.Item>

          <Form.Item label="Açıklama" name="description">
            <Input.TextArea rows={2} placeholder="İsteğe bağlı açıklama" />
          </Form.Item>

          <Form.Item label="Adres" name="address">
            <Input placeholder="örn. Maslak, İstanbul" />
          </Form.Item>
        </Form>

        {editing && editing.device_count > 0 && (
          <div style={{
            background: isDark ? '#0c2040' : '#eff6ff',
            border: `1px solid ${isDark ? '#1a3458' : '#bfdbfe'}`,
            borderRadius: 6, padding: '8px 12px', marginTop: 8,
          }}>
            <Text style={{ fontSize: 12, color: subText }}>
              <LaptopOutlined style={{ marginRight: 6 }} />
              Bu lokasyona <strong>{editing.device_count}</strong> cihaz atanmış.
              İsim değiştirilirse cihazların site alanı otomatik güncellenir.
            </Text>
          </div>
        )}
      </Modal>
    </div>
  )
}
