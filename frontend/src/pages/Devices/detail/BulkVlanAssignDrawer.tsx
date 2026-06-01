/**
 * T10 C7 Dalga 1 — Seçili portlara toplu VLAN ata Drawer.
 *
 * Backend bulk endpoint yok; frontend Promise.allSettled ile her port için
 * devicesApi.assignVlan(deviceId, port_name, vlan_id, mode) çağırır. Sonuç
 * raporu: ok / fail per port. Atomik DEĞİL — kısmen başarılı senaryo mümkün.
 * Tek port için PortsTab row aksiyonu kullanılır (Modal pattern).
 */
import { useState } from 'react'
import { Drawer, Form, Select, InputNumber, Button, Alert, Typography, Space, Tag } from 'antd'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  selectedPorts: string[]
  saving: boolean
  onSubmit: (vlanId: number, mode: 'access' | 'trunk') => void
}

export default function BulkVlanAssignDrawer({
  open, onClose, selectedPorts, saving, onSubmit,
}: Props) {
  const [form] = Form.useForm()
  const [mode, setMode] = useState<'access' | 'trunk'>('access')

  const handleFinish = (vals: { vlan_id: number; mode: 'access' | 'trunk' }) => {
    onSubmit(vals.vlan_id, vals.mode)
  }

  return (
    <Drawer
      title={`Toplu VLAN ata · ${selectedPorts.length} port`}
      open={open}
      onClose={onClose}
      width={460}
      extra={
        <Button
          type="primary"
          loading={saving}
          onClick={() => form.submit()}
          disabled={selectedPorts.length === 0}
        >
          Uygula
        </Button>
      }
    >
      <Alert
        type="info" showIcon style={{ marginBottom: 16, fontSize: 12 }}
        message={`Seçili ${selectedPorts.length} porta belirtilen VLAN ataması yapılır.`}
        description={
          <span>
            <strong>Atomik DEĞİL:</strong> her port için ayrı SSH komutu gider; biri
            hata verirse diğerleri yine yazılır. Hata raporu mesaj olarak gösterilir.
          </span>
        }
      />

      <div style={{ marginBottom: 16 }}>
        <Text strong>Seçili portlar</Text>
        <div style={{
          marginTop: 6, padding: 10, background: 'var(--bg-1, #f8fafc)',
          border: '1px solid var(--line-soft, #e2e8f0)', borderRadius: 6,
          maxHeight: 120, overflow: 'auto',
        }}>
          {selectedPorts.length === 0
            ? <Text type="secondary" style={{ fontSize: 12 }}>port seçilmedi</Text>
            : <Space size={[6, 6]} wrap>
                {selectedPorts.map((p) => (
                  <Tag key={p} style={{ fontFamily: 'var(--font-mono, monospace)' }}>{p}</Tag>
                ))}
              </Space>}
        </div>
      </div>

      <Form
        form={form} layout="vertical" onFinish={handleFinish}
        initialValues={{ mode: 'access' }}
      >
        <Form.Item
          name="mode"
          label="Mod"
          rules={[{ required: true, message: 'Mod seçin' }]}
        >
          <Select
            options={[
              { label: 'Access (tek VLAN üyesi)', value: 'access' },
              { label: 'Trunk (çoklu VLAN taşır)', value: 'trunk' },
            ]}
            onChange={(v) => setMode(v)}
          />
        </Form.Item>
        <Form.Item
          name="vlan_id"
          label={mode === 'trunk' ? 'Native VLAN ID (trunk için)' : 'VLAN ID'}
          rules={[
            { required: true, message: 'VLAN ID zorunlu' },
            { type: 'number', min: 1, max: 4094, message: '1 ile 4094 arası' },
          ]}
        >
          <InputNumber style={{ width: '100%' }} placeholder="ör. 100" min={1} max={4094} />
        </Form.Item>
      </Form>
    </Drawer>
  )
}
