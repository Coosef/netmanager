/**
 * T10 C7 Dalga 1 — Device Detail > VLAN sekmesi (Create + Delete).
 *
 * Kaynak: GET /devices/{id}/vlans (devicesApi.getVlans). Canlı SSH (cache).
 * CRUD: VLAN Oluştur modal + satır Popconfirm Sil. Default VLAN (id=1) silinemez.
 * RBAC: canConnect (devices.connect) — viewer rolünde butonlar gizli.
 * Cihaz erişilemezse boş + uyarı (Ports tab paterni). Yenile = force refresh.
 */
import { useState } from 'react'
import {
  Table, Tag, Button, Alert, Spin, Typography, Modal, Form, Input, InputNumber,
  Popconfirm, App,
} from 'antd'
import { ReloadOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Device, Vlan } from '@/types'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'
import { apiErr } from '@/utils/apiError'

const { Text } = Typography

export default function VlanTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const canConnect = useAuthStore((s) => s.can('devices', 'connect'))
  const [createOpen, setCreateOpen] = useState(false)
  const [form] = Form.useForm()

  const q = useQuery({
    queryKey: ['device-vlans', device.id],
    queryFn: () => devicesApi.getVlans(device.id),
    enabled: device.id > 0,
    staleTime: 30_000,
  })

  const success = q.data?.success !== false
  const vlans: Vlan[] = q.data?.vlans ?? []

  const invalidateVlans = () => qc.invalidateQueries({ queryKey: ['device-vlans', device.id] })

  const createMut = useMutation({
    mutationFn: (vals: { vlan_id: number; name: string }) =>
      devicesApi.createVlan(device.id, vals.vlan_id, vals.name),
    onSuccess: (res) => {
      if (res.success) {
        message.success('VLAN oluşturuldu')
        setCreateOpen(false)
        form.resetFields()
        invalidateVlans()
      } else {
        message.error(res.error || 'VLAN oluşturulamadı')
      }
    },
    onError: (e: any) => message.error(apiErr(e, 'VLAN oluşturulamadı')),
  })

  const deleteMut = useMutation({
    mutationFn: (vlan_id: number) => devicesApi.deleteVlan(device.id, vlan_id),
    onSuccess: (res) => {
      if (res.success) {
        message.success('VLAN silindi')
        invalidateVlans()
      } else {
        message.error(res.error || 'VLAN silinemedi')
      }
    },
    onError: (e: any) => message.error(apiErr(e, 'VLAN silinemedi')),
  })

  const columns = [
    { title: 'VLAN ID', dataIndex: 'id', key: 'id', width: 90,
      render: (v: number) => <code style={{ fontSize: 12 }}>{v}</code> },
    { title: 'Ad', dataIndex: 'name', key: 'name' },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 110,
      render: (s: string) => {
        const up = /up|active/i.test(s)
        return <Tag color={up ? 'green' : 'default'}>{s || '—'}</Tag>
      } },
    { title: 'Port sayısı', key: 'pc', width: 110,
      render: (_: any, r: Vlan) => r.ports?.length ?? 0 },
    { title: 'Portlar', dataIndex: 'ports', key: 'ports',
      render: (ps: string[]) => ps?.length
        ? <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
            {ps.slice(0, 8).join(', ')}{ps.length > 8 ? ` … (+${ps.length - 8})` : ''}
          </span>
        : '—' },
    ...(canConnect ? [{
      title: 'Aksiyon', key: 'action', width: 100,
      render: (_: any, r: Vlan) => {
        const isDefault = r.id === 1
        return (
          <Popconfirm
            title="VLAN silinsin mi?"
            description={`VLAN ${r.id} (${r.name || '—'}) cihazdan kaldırılacak.`}
            onConfirm={() => deleteMut.mutate(r.id)}
            okButtonProps={{ danger: true, loading: deleteMut.isPending }}
            okText="Sil" cancelText="İptal"
            disabled={isDefault}
          >
            <Button
              size="small" danger type="text"
              icon={<DeleteOutlined />}
              disabled={isDefault}
              title={isDefault ? 'Varsayılan VLAN (id=1) silinemez' : 'Sil'}
            />
          </Popconfirm>
        )
      },
    }] : []),
  ]

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Text strong>VLAN listesi</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {q.data?.cached ? 'cache (≤30s)' : q.data?.fetched_at ? 'canlı' : ''}
        </Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {canConnect && (
            <Button icon={<PlusOutlined />} type="primary" onClick={() => setCreateOpen(true)}>
              VLAN Oluştur
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={invalidateVlans} loading={q.isLoading}>
            Yenile
          </Button>
        </div>
      </div>

      {!q.isLoading && !success && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message="Cihaz erişilemez (VLAN listesi gelmedi)"
          description={q.data?.error || 'SSH/SNMP yanıt vermedi.'}
        />
      )}

      <Spin spinning={q.isLoading}>
        <Table
          size="small" rowKey="id" columns={columns as any} dataSource={vlans}
          pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: success ? 'VLAN bulunamadı' : '—' }}
        />
      </Spin>

      <Modal
        open={createOpen}
        title="VLAN Oluştur"
        onCancel={() => { setCreateOpen(false); form.resetFields() }}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending}
        okText="Oluştur" cancelText="İptal"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(vals) => createMut.mutate(vals)}>
          <Form.Item
            label="VLAN ID"
            name="vlan_id"
            rules={[
              { required: true, message: 'VLAN ID zorunlu' },
              { type: 'number', min: 2, max: 4094, message: '2 ile 4094 arası (1 varsayılan)' },
            ]}
          >
            <InputNumber style={{ width: '100%' }} placeholder="ör. 100" min={2} max={4094} />
          </Form.Item>
          <Form.Item
            label="Ad"
            name="name"
            rules={[{ required: true, message: 'Ad zorunlu' }, { max: 64, message: 'En çok 64 karakter' }]}
          >
            <Input placeholder="ör. VLAN-CCTV" maxLength={64} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
