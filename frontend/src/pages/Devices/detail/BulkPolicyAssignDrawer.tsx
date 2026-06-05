/**
 * T10 C7.C — Seçili portlara toplu port policy ata Drawer.
 *
 * Body: portPolicyAssignmentsApi.bulkSet(deviceId, [{port_name, port_security_policy_id}, ...])
 * Backend atomik (C7.A): tek bir hata → hiçbiri yazılmaz. Mevcut override varsa upsert.
 */
import { Drawer, Form, Select, Button, Alert, Typography, Space, Tag } from 'antd'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  selectedPorts: string[]
  portPolicies: { id: number; name: string; is_default?: boolean }[]
  saving: boolean
  onSubmit: (policyId: number) => void
}

export default function BulkPolicyAssignDrawer({
  open, onClose, selectedPorts, portPolicies, saving, onSubmit,
}: Props) {
  const { t } = useTranslation()
  const [form] = Form.useForm()

  const handleFinish = (vals: { policy_id: number }) => {
    onSubmit(vals.policy_id)
  }

  return (
    <Drawer
      title={t('devices.detail.bulk_policy.title', { count: selectedPorts.length })}
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
          {t('common.apply')}
        </Button>
      }
    >
      <Alert
        type="info" showIcon style={{ marginBottom: 16, fontSize: 12 }}
        message={t('devices.detail.bulk_policy.alert_msg', { count: selectedPorts.length })}
        description={t('devices.detail.bulk_policy.alert_desc')}
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
                {selectedPorts.map((p) => <Tag key={p} style={{ fontFamily: 'var(--font-mono, monospace)' }}>{p}</Tag>)}
              </Space>}
        </div>
      </div>

      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item
          name="policy_id"
          label={t('devices.detail.bulk_policy.policy_label')}
          rules={[{ required: true, message: t('devices.detail.bulk_policy.policy_required') }]}
        >
          <Select
            placeholder={t('devices.detail.bulk_policy.policy_placeholder')}
            options={portPolicies.map((p) => ({
              label: p.is_default ? t('devices.detail.bulk_policy.org_default_suffix', { name: p.name }) : p.name,
              value: p.id,
            }))}
          />
        </Form.Item>
      </Form>
    </Drawer>
  )
}
