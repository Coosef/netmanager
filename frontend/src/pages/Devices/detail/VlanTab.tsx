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
import { useTranslation } from 'react-i18next'
import type { Device, Vlan } from '@/types'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'
import { apiErr } from '@/utils/apiError'

const { Text } = Typography

export default function VlanTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const { t } = useTranslation()
  // Wave 1.1 RED-fix: kullanıcı geri bildirimi "vlan oluşturma başarılı sonuçlarını
  // verdim ama oluştururken başarı/başarısız bilgisi vermedi". message.success
  // top-center kısa süre kalıyor + Modal animasyonunda maskeleniyordu. notification
  // (sağ üst, 4.5sn, ikon+başlık+açıklama) ile belirgin feedback.
  const { message, notification } = App.useApp()
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
    onSuccess: (res, vars) => {
      if (res.success) {
        notification.success({
          message: t('devices.detail.vlan.toast.created_title'),
          description: t('devices.detail.vlan.toast.created_desc', { vlan_id: vars.vlan_id, name: vars.name }),
          duration: 4.5,
          placement: 'topRight',
        })
        setCreateOpen(false)
        form.resetFields()
        invalidateVlans()
      } else {
        notification.error({
          message: t('devices.detail.vlan.toast.create_failed'),
          description: res.error || t('devices.detail.vlan.toast.backend_success_false'),
          duration: 6,
          placement: 'topRight',
        })
      }
    },
    onError: (e: any) => notification.error({
      message: t('devices.detail.vlan.toast.create_failed'),
      description: apiErr(e, t('common.error')),
      duration: 6,
      placement: 'topRight',
    }),
  })

  const deleteMut = useMutation({
    mutationFn: (vlan_id: number) => devicesApi.deleteVlan(device.id, vlan_id),
    onSuccess: (res, vlan_id) => {
      if (res.success) {
        notification.success({
          message: t('devices.detail.vlan.toast.deleted_title'),
          description: t('devices.detail.vlan.toast.deleted_desc', { vlan_id }),
          duration: 4.5,
          placement: 'topRight',
        })
        invalidateVlans()
      } else {
        notification.error({
          message: t('devices.detail.vlan.toast.delete_failed'),
          description: res.error || t('devices.detail.vlan.toast.backend_success_false'),
          duration: 6,
          placement: 'topRight',
        })
      }
    },
    onError: (e: any) => notification.error({
      message: t('devices.detail.vlan.toast.delete_failed'),
      description: apiErr(e, t('common.error')),
      duration: 6,
      placement: 'topRight',
    }),
  })

  void message  // App.useApp() destructuring koruması — başka mutation eklenmesi için hazır

  const columns = [
    { title: 'VLAN ID', dataIndex: 'id', key: 'id', width: 90,
      render: (v: number) => <code style={{ fontSize: 12 }}>{v}</code> },
    { title: t('devices.detail.vlan.col.name'), dataIndex: 'name', key: 'name' },
    { title: t('common.status'), dataIndex: 'status', key: 'status', width: 110,
      render: (s: string) => {
        const up = /up|active/i.test(s)
        return <Tag color={up ? 'green' : 'default'}>{s || '—'}</Tag>
      } },
    { title: t('devices.detail.vlan.col.port_count'), key: 'pc', width: 110,
      render: (_: any, r: Vlan) => r.ports?.length ?? 0 },
    { title: t('devices.detail.vlan.col.ports'), dataIndex: 'ports', key: 'ports',
      render: (ps: string[]) => ps?.length
        ? <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
            {ps.slice(0, 8).join(', ')}{ps.length > 8 ? ` … (+${ps.length - 8})` : ''}
          </span>
        : '—' },
    ...(canConnect ? [{
      title: t('common.actions'), key: 'action', width: 100,
      render: (_: any, r: Vlan) => {
        const isDefault = r.id === 1
        return (
          <Popconfirm
            title={t('devices.detail.vlan.delete_confirm_title')}
            description={t('devices.detail.vlan.delete_confirm_desc', { vlan_id: r.id, name: r.name || '—' })}
            onConfirm={() => deleteMut.mutate(r.id)}
            okButtonProps={{ danger: true, loading: deleteMut.isPending }}
            okText={t('common.delete')} cancelText={t('common.cancel')}
            disabled={isDefault}
          >
            <Button
              size="small" danger type="text"
              icon={<DeleteOutlined />}
              disabled={isDefault}
              title={isDefault ? t('devices.detail.vlan.default_not_deletable') : t('common.delete')}
            />
          </Popconfirm>
        )
      },
    }] : []),
  ]

  // Wave 2 #2 F4 — VLAN Statistics (3 KPI)
  const activeCount = vlans.filter((v) => /up|active/i.test(v.status || '')).length
  const portCarrying = vlans.filter((v) => (v.ports?.length ?? 0) > 0).length

  return (
    <div style={{ padding: '8px 0 16px' }}>
      {/* Wave 2 #2 F4 — VLAN Statistics statbar (3 KPI) */}
      <div className="nm-statbar" style={{ marginBottom: 12 }}>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('devices.detail.vlan.stat.total')}</div>
          <div className="nm-stat-val">{vlans.length}</div>
        </div>
        <div className={`nm-stat ${activeCount > 0 ? 'ok' : ''}`}>
          <div className="nm-stat-label">{t('devices.detail.vlan.stat.active')}</div>
          <div className="nm-stat-val">{activeCount}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('devices.detail.vlan.stat.port_carrying')}</div>
          <div className="nm-stat-val">{portCarrying}</div>
          <div className="nm-stat-delta">{t('devices.detail.vlan.stat.port_carrying_caption')}</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Text strong>{t('devices.detail.vlan.list_title')}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {q.data?.cached ? t('devices.detail.ports.cache_label') : q.data?.fetched_at ? t('devices.detail.overview.live') : ''}
        </Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {canConnect && (
            <Button icon={<PlusOutlined />} type="primary" onClick={() => setCreateOpen(true)}>
              {t('devices.detail.vlan.create_btn')}
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={invalidateVlans} loading={q.isLoading}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {!q.isLoading && !success && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message={t('devices.detail.vlan.unreachable_title')}
          description={q.data?.error || t('devices.detail.ports.unreachable_default')}
        />
      )}

      <Spin spinning={q.isLoading}>
        <Table
          size="small" rowKey="id" columns={columns as any} dataSource={vlans}
          pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: success ? t('devices.detail.vlan.empty') : '—' }}
        />
      </Spin>

      <Modal
        open={createOpen}
        title={t('devices.detail.vlan.create_modal_title')}
        onCancel={() => { setCreateOpen(false); form.resetFields() }}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending}
        okText={t('devices.detail.vlan.create_ok')} cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(vals) => createMut.mutate(vals)}>
          <Form.Item
            label="VLAN ID"
            name="vlan_id"
            rules={[
              { required: true, message: t('devices.detail.vlan.vlan_id_required') },
              { type: 'number', min: 2, max: 4094, message: t('devices.detail.vlan.range_2_4094') },
            ]}
          >
            <InputNumber style={{ width: '100%' }} placeholder={t('devices.detail.ports.vlan_modal.access_placeholder')} min={2} max={4094} />
          </Form.Item>
          <Form.Item
            label={t('devices.detail.vlan.col.name')}
            name="name"
            rules={[{ required: true, message: t('devices.detail.vlan.name_required') }, { max: 64, message: t('devices.detail.vlan.name_max64') }]}
          >
            <Input placeholder="VLAN-CCTV" maxLength={64} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
