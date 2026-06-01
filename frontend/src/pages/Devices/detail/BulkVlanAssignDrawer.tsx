/**
 * T10 C7 Dalga 1 — Seçili portlara toplu VLAN ata Drawer.
 *
 * Backend bulk endpoint yok; frontend Promise.allSettled ile her port için
 * devicesApi.assignVlan(deviceId, port_name, vlan_id, mode, native_vlan_id?)
 * çağırır. Sonuç raporu: ok / fail per port. Atomik DEĞİL — kısmen başarılı
 * senaryo mümkün. Tek port için PortsTab row aksiyonu kullanılır (Modal pattern).
 *
 * RED-fix (Dalga 1 retry): mode'a göre form değişir:
 *  - Access → tek "Access VLAN ID"
 *  - Trunk  → "Native VLAN ID" (opsiyonel) + "Allowed VLANs" (parser ile validate)
 */
import {
  Drawer, Form, Select, InputNumber, Input, Button, Alert, Typography, Space, Tag,
} from 'antd'
import { parseVlanList, VlanListError } from './_vlanHelper'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  selectedPorts: string[]
  saving: boolean
  onSubmit: (
    vlan_id: number | number[],
    mode: 'access' | 'trunk',
    native_vlan_id?: number,
  ) => void
}

export default function BulkVlanAssignDrawer({
  open, onClose, selectedPorts, saving, onSubmit,
}: Props) {
  const [form] = Form.useForm()

  const handleFinish = (vals: {
    mode: 'access' | 'trunk'
    access_vlan_id?: number
    native_vlan_id?: number
    allowed_vlans?: string
  }) => {
    if (vals.mode === 'access') {
      onSubmit(vals.access_vlan_id!, 'access')
      return
    }
    // trunk
    try {
      const allowed = parseVlanList(vals.allowed_vlans || '')
      onSubmit(allowed, 'trunk', vals.native_vlan_id || undefined)
    } catch (e: any) {
      const msg = e instanceof VlanListError ? e.message : 'Allowed VLANs geçersiz'
      form.setFields([{ name: 'allowed_vlans', errors: [msg] }])
    }
  }

  return (
    <Drawer
      title={`Toplu VLAN ata · ${selectedPorts.length} port`}
      open={open}
      onClose={onClose}
      width={480}
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
        form={form} layout="vertical"
        initialValues={{ mode: 'access' }}
        onFinish={handleFinish}
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
          />
        </Form.Item>

        <Form.Item shouldUpdate={(p, c) => p.mode !== c.mode} noStyle>
          {({ getFieldValue }) => {
            const mode = getFieldValue('mode') as 'access' | 'trunk'
            if (mode === 'access') {
              return (
                <Form.Item
                  name="access_vlan_id"
                  label="Access VLAN ID"
                  rules={[
                    { required: true, message: 'Access VLAN ID zorunlu' },
                    { type: 'number', min: 1, max: 4094, message: '1 ile 4094 arası' },
                  ]}
                >
                  <InputNumber style={{ width: '100%' }} placeholder="ör. 100" min={1} max={4094} />
                </Form.Item>
              )
            }
            return (
              <>
                <Form.Item
                  name="native_vlan_id"
                  label="Native VLAN ID (opsiyonel)"
                  rules={[{ type: 'number', min: 1, max: 4094, message: '1 ile 4094 arası' }]}
                  extra="Boş bırakılırsa vendor varsayılanı uygulanır (Cisco/Ruijie: 1)."
                >
                  <InputNumber style={{ width: '100%' }} placeholder="ör. 1" min={1} max={4094} />
                </Form.Item>
                <Form.Item
                  name="allowed_vlans"
                  label="Allowed VLANs"
                  rules={[{ required: true, message: 'Allowed VLANs zorunlu (trunk için)' }]}
                  extra="Örn: 1,10,20-30,100,200-220 — virgül + tire range."
                >
                  <Input placeholder="ör. 1,10,20-30,2400,2460" />
                </Form.Item>
              </>
            )
          }}
        </Form.Item>
      </Form>
    </Drawer>
  )
}
