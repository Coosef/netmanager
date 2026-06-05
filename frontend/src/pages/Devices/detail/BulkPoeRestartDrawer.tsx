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
import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
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
      title={t('devices.detail.bulk_poe_restart.title', { count: selectedPorts.length })}
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
          {t('common.apply')}
        </Button>
      }
    >
      <Alert
        type="warning" showIcon style={{ marginBottom: 16, fontSize: 12 }}
        message={t('devices.detail.bulk_poe_restart.flow_title')}
        description={t('devices.detail.bulk_poe_restart.flow_desc')}
      />

      <div style={{ marginBottom: 16 }}>
        <Text strong>{t('devices.detail.bulk_policy.selected_ports')}</Text>
        <div style={{
          marginTop: 6, padding: 10, background: 'var(--bg-1, #f8fafc)',
          border: '1px solid var(--line-soft, #e2e8f0)', borderRadius: 6,
          maxHeight: 120, overflow: 'auto',
        }}>
          {selectedPorts.length === 0
            ? <Text type="secondary" style={{ fontSize: 12 }}>{t('devices.detail.bulk_policy.no_ports')}</Text>
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
          label={t('devices.detail.bulk_poe_restart.wait_label')}
          rules={[
            { required: true, message: t('devices.detail.bulk_poe_restart.wait_required') },
            { type: 'number', min: 1, max: 60, message: t('devices.detail.bulk_poe_restart.wait_range') },
          ]}
          extra={t('devices.detail.bulk_poe_restart.wait_extra')}
        >
          <InputNumber style={{ width: '100%' }} min={1} max={60} />
        </Form.Item>

        <Form.Item
          name="rollback_after_sec"
          label={t('devices.detail.bulk_poe_restart.rollback_label')}
          rules={[{ type: 'number', min: 0, max: 3600, message: t('devices.detail.bulk_poe_restart.rollback_range') }]}
          extra={t('devices.detail.bulk_poe_restart.rollback_extra')}
        >
          <InputNumber style={{ width: '100%' }} min={0} max={3600} />
        </Form.Item>

        <Form.Item
          name="reason"
          label={t('devices.detail.bulk_poe_restart.reason_label')}
          extra={t('devices.detail.bulk_poe_restart.reason_extra')}
        >
          <Input.TextArea rows={2} placeholder={t('devices.detail.bulk_poe_restart.reason_placeholder')} />
        </Form.Item>
      </Form>
    </Drawer>
  )
}
