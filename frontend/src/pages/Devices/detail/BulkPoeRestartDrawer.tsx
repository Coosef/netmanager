/**
 * T10 C7 Wave 3 W3.3 — Toplu PoE Restart Drawer.
 *
 * Backend `POST /devices/{id}/ports/bulk-poe` action='restart' tek SSH session'da
 * her port için disable → wait → enable uygular. Skipped (PoE-uyumsuz) ve failed
 * sayaçları response'ta gelir. UI tek "Uygula" → result notification + cache invalidate.
 */
import {
  Drawer, Form, InputNumber, Input, Button, Alert, Typography, Space, Tag,
} from 'antd'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  selectedPorts: string[]
  saving: boolean
  /** restart_wait_sec (1-60, 0=server default), rollback_after_sec, reason */
  onSubmit: (opts: {
    restart_wait_sec: number
    rollback_after_sec: number
    reason?: string
  }) => void
  /** Server default (env POE_RESTART_WAIT_SEC) — bilinmiyorsa 10 */
  defaultWaitSec?: number
}

export default function BulkPoeRestartDrawer({
  open, onClose, selectedPorts, saving, onSubmit, defaultWaitSec = 10,
}: Props) {
  const [form] = Form.useForm()

  const handleFinish = (vals: {
    restart_wait_sec?: number
    rollback_after_sec?: number
    reason?: string
  }) => {
    onSubmit({
      restart_wait_sec: vals.restart_wait_sec ?? defaultWaitSec,
      rollback_after_sec: vals.rollback_after_sec ?? 300,
      reason: vals.reason,
    })
  }

  return (
    <Drawer
      title={`Toplu PoE Restart · ${selectedPorts.length} port`}
      open={open}
      onClose={onClose}
      width={480}
      extra={
        <Button
          type="primary"
          danger
          loading={saving}
          onClick={() => form.submit()}
          disabled={selectedPorts.length === 0}
        >
          Uygula
        </Button>
      }
    >
      <Alert
        type="warning" showIcon style={{ marginBottom: 16, fontSize: 12 }}
        message="PoE Restart akışı: disable → bekle → enable"
        description={
          <span>
            Her port için <strong>iki SSH komut</strong> arasında belirtilen süre kadar
            beklenir. PoE-uyumsuz portlar atlanır (sayaç). AP / IP telefon / kamera için
            <strong> 10–15 sn</strong> önerilir.
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
        initialValues={{
          restart_wait_sec: defaultWaitSec,
          rollback_after_sec: 300,
        }}
        onFinish={handleFinish}
      >
        <Form.Item
          name="restart_wait_sec"
          label="Bekleme süresi (sn)"
          rules={[
            { required: true, message: 'Bekleme süresi gerekli' },
            { type: 'number', min: 1, max: 60, message: '1 ile 60 arası' },
          ]}
          extra="disable → bekle → enable arasındaki süre. Server varsayılanı uygulamak için boş bırakılabilir."
        >
          <InputNumber style={{ width: '100%' }} min={1} max={60} />
        </Form.Item>

        <Form.Item
          name="rollback_after_sec"
          label="Auto-rollback süresi (sn)"
          rules={[{ type: 'number', min: 0, max: 3600, message: '0 ile 3600 arası' }]}
          extra="Bu süre sonunda PoE yine açık kalır (rollback komutu enable). 0 → rollback timer'ı kapatır (kalıcı)."
        >
          <InputNumber style={{ width: '100%' }} min={0} max={3600} />
        </Form.Item>

        <Form.Item
          name="reason"
          label="Açıklama (opsiyonel)"
          extra="Audit log'a yazılır."
        >
          <Input.TextArea rows={2} placeholder="ör. 5. kat kamera donmuş, AP reset" />
        </Form.Item>
      </Form>
    </Drawer>
  )
}
