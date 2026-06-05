import { useMemo, useState } from 'react'
import {
  Alert, App, Button, Descriptions, Divider, Form, Input, InputNumber,
  Modal, Select, Space, Spin, Steps, Switch, Tag, Tooltip, Typography,
} from 'antd'
import {
  CheckCircleFilled, CloseCircleFilled, LoadingOutlined,
  RobotOutlined, SafetyCertificateOutlined, SafetyOutlined, WarningOutlined,
  WifiOutlined, ThunderboltOutlined, SyncOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { devicesApi } from '@/api/devices'
import { agentsApi } from '@/api/agents'
import { credentialProfilesApi } from '@/api/credentialProfiles'
import { formatApiError } from '@/api/_errors'
import type { Device } from '@/types'
import { DEVICE_TYPE_OPTIONS, OS_TYPE_OPTIONS, VENDOR_OPTIONS, VENDOR_OS_MAP } from '@/types'

const { Text } = Typography

// ── Field groups per step ─────────────────────────────────────────────────────

const STEP_FIELDS: string[][] = [
  ['hostname', 'ip_address', 'alias', 'description'],
  ['device_type', 'vendor', 'os_type', 'model', 'layer', 'site', 'building', 'floor', 'tags'],
  ['credential_profile_id', 'agent_id', 'fallback_agent_ids',
   'ssh_username', 'ssh_password', 'enable_secret', 'ssh_port',
   'is_readonly', 'approval_required'],
  ['snmp_enabled', 'snmp_version', 'snmp_community', 'snmp_port',
   'snmp_v3_username', 'snmp_v3_auth_protocol', 'snmp_v3_auth_passphrase',
   'snmp_v3_priv_protocol', 'snmp_v3_priv_passphrase'],
]

// ── Step 0: Basic Info ────────────────────────────────────────────────────────

function Step0() {
  const { t } = useTranslation()
  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
        message={t('devices.wizard.step0_alert')}
      />
      <Form.Item
        label={t('devices.form.ip_address')}
        name="ip_address"
        rules={[
          { required: true, message: t('common.validation.ip_required') },
          { pattern: /^(\d{1,3}\.){3}\d{1,3}$/, message: t('common.validation.ipv4_invalid') },
        ]}
      >
        <Input placeholder="192.168.1.1" size="large" autoFocus />
      </Form.Item>

      <Form.Item label={t('devices.form.hostname')} name="hostname" tooltip={t('devices.wizard.hostname_tooltip')}>
        <Input placeholder={t('devices.wizard.hostname_placeholder')} />
      </Form.Item>

      <Form.Item label={t('devices.form.alias')} name="alias" tooltip={t('devices.wizard.alias_tooltip')}>
        <Input placeholder={t('devices.wizard.alias_placeholder')} />
      </Form.Item>

      <Form.Item label={t('devices.form.description')} name="description">
        <Input.TextArea rows={2} placeholder={t('devices.wizard.description_placeholder')} />
      </Form.Item>
    </>
  )
}

// ── Step 1: Device Profile ────────────────────────────────────────────────────

function Step1() {
  const { t } = useTranslation()
  const selectedVendor = Form.useWatch('vendor')
  const filteredOsOptions = selectedVendor && VENDOR_OS_MAP[selectedVendor]
    ? OS_TYPE_OPTIONS.filter((o) => VENDOR_OS_MAP[selectedVendor].includes(o.value))
    : OS_TYPE_OPTIONS

  return (
    <>
      <Form.Item label={t('devices.form.device_type')} name="device_type" rules={[{ required: true }]}>
        <Select options={DEVICE_TYPE_OPTIONS} size="large" />
      </Form.Item>

      <Form.Item label={t('devices.form.vendor')} name="vendor" rules={[{ required: true }]}>
        <Select options={VENDOR_OPTIONS} />
      </Form.Item>

      <Form.Item label={t('devices.form.os_type')} name="os_type" rules={[{ required: true }]}>
        <Select options={filteredOsOptions} showSearch />
      </Form.Item>

      <Form.Item label={t('devices.form.model')} name="model">
        <Input placeholder="Catalyst 2960, Aruba 2530…" />
      </Form.Item>

      <Divider plain style={{ fontSize: 12 }}>{t('devices.wizard.location_topology_divider')}</Divider>

      <Form.Item label={t('devices.form.layer')} name="layer" tooltip={t('devices.wizard.layer_tooltip_short')}>
        <Select allowClear placeholder={t('devices.wizard.pick_placeholder')} options={[
          { label: 'Core', value: 'core' },
          { label: 'Distribution', value: 'distribution' },
          { label: 'Access', value: 'access' },
          { label: 'Edge', value: 'edge' },
          { label: 'Wireless', value: 'wireless' },
        ]} />
      </Form.Item>

      <Form.Item label={t('devices.form.site')} name="site">
        <Input placeholder={t('devices.wizard.site_placeholder')} />
      </Form.Item>

      <Form.Item label={t('devices.form.building')} name="building">
        <Input placeholder={t('devices.form.building_placeholder')} />
      </Form.Item>

      <Form.Item label={t('devices.form.floor')} name="floor">
        <Input placeholder={t('devices.form.floor_placeholder')} />
      </Form.Item>

      <Form.Item label={t('devices.form.tags')} name="tags" tooltip={t('devices.wizard.tags_tooltip')}>
        <Input placeholder="core,vlan10,building-a" />
      </Form.Item>
    </>
  )
}

// ── Step 2: SSH & Credentials ─────────────────────────────────────────────────

function Step2({
  agents,
  credProfiles,
}: {
  agents: any[]
  credProfiles: any[]
}) {
  const { t } = useTranslation()
  const agentOptions = [
    { label: t('devices.form.agent_none'), value: '' },
    ...agents.map((a) => ({
      label: (
        <span>
          <RobotOutlined style={{ marginRight: 6, color: a.status === 'online' ? '#52c41a' : '#f5222d' }} />
          {a.name}
          <Tag style={{ marginLeft: 8, fontSize: 10 }} color={a.status === 'online' ? 'success' : 'error'}>{a.status}</Tag>
        </span>
      ),
      value: a.id,
    })),
  ]

  // Incident HF#8 (2026-06-03) — Kimlik profili seçiliyse SSH credential
  // alanlari opsiyonel olur. Form en yakindaki Form context'ten okur.
  const watchedCredentialProfileId = Form.useWatch('credential_profile_id')
  const hasCredentialProfile = watchedCredentialProfileId != null

  const fallbackAgentOptions = agents.map((a) => ({
    label: (
      <span>
        <RobotOutlined style={{ marginRight: 6, color: a.status === 'online' ? '#52c41a' : '#f5222d' }} />
        {a.name}
        <Tag style={{ marginLeft: 8, fontSize: 10 }} color={a.status === 'online' ? 'success' : 'error'}>{a.status}</Tag>
      </span>
    ),
    value: a.id,
  }))

  return (
    <>
      <Form.Item
        label={<span><SafetyOutlined style={{ marginRight: 4 }} />{t('devices.form.cred_profile_label')}</span>}
        name="credential_profile_id"
        tooltip={t('devices.wizard.cred_profile_tooltip')}
      >
        <Select
          allowClear
          placeholder={t('devices.wizard.cred_profile_placeholder')}
          options={credProfiles.map((p) => ({
            label: `${p.name}${p.description ? ` — ${p.description}` : ''}`,
            value: p.id,
          }))}
        />
      </Form.Item>

      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.credential_profile_id !== cur.credential_profile_id}
      >
        {({ getFieldValue }) => getFieldValue('credential_profile_id') && (
          <Alert
            type="info" showIcon style={{ marginBottom: 12, fontSize: 12 }}
            message={t('devices.wizard.cred_profile_alert')}
          />
        )}
      </Form.Item>

      <Form.Item label={t('devices.form.agent_label')} name="agent_id"
        tooltip={t('devices.wizard.agent_tooltip')}>
        <Select options={agentOptions} />
      </Form.Item>

      <Form.Item label={t('devices.form.fallback_agents_label')} name="fallback_agent_ids"
        tooltip={t('devices.wizard.fallback_tooltip')}>
        <Select mode="multiple" allowClear placeholder={t('devices.wizard.pick_optional_placeholder')} options={fallbackAgentOptions} />
      </Form.Item>

      <Divider plain style={{ fontSize: 12 }}>{t('devices.form.ssh_divider')}</Divider>

      {/* HF#8 — Kimlik profili seçiliyse SSH alanları opsiyonel fallback olur */}
      <Form.Item
        label={<span>{t('devices.form.ssh_username')} {hasCredentialProfile && <span style={{ color: 'var(--fg-3,#94a3b8)', fontSize: 11, fontWeight: 400 }}>{t('devices.form.optional_profile_used')}</span>}</span>}
        name="ssh_username"
        rules={[{ required: !hasCredentialProfile, message: t('common.validation.username_required') }]}
      >
        <Input placeholder={hasCredentialProfile ? t('devices.form.placeholder_profile_override') : 'admin'} />
      </Form.Item>

      <Form.Item
        label={<span>{t('devices.form.ssh_password')} {hasCredentialProfile && <span style={{ color: 'var(--fg-3,#94a3b8)', fontSize: 11, fontWeight: 400 }}>{t('devices.form.optional_profile_used')}</span>}</span>}
        name="ssh_password"
        rules={[{ required: !hasCredentialProfile, message: t('common.validation.password_required') }]}
      >
        <Input.Password placeholder={hasCredentialProfile ? t('devices.form.placeholder_profile_override') : ''} />
      </Form.Item>

      <Form.Item label={t('devices.form.enable_secret')} name="enable_secret">
        <Input.Password placeholder={hasCredentialProfile ? t('devices.form.placeholder_profile_override_optional') : t('devices.wizard.enable_secret_placeholder')} />
      </Form.Item>

      <Form.Item label={t('devices.form.ssh_port')} name="ssh_port">
        <InputNumber min={1} max={65535} style={{ width: '100%' }} />
      </Form.Item>

      <Divider plain style={{ fontSize: 12 }}>{t('devices.wizard.security_divider')}</Divider>

      <Form.Item
        label={
          <Tooltip title={t('devices.wizard.readonly_tooltip_short')}>
            {t('devices.form.readonly_label')}
          </Tooltip>
        }
        name="is_readonly"
        valuePropName="checked"
      >
        <Switch
          checkedChildren={<><SafetyCertificateOutlined /> {t('devices.form.readonly_on')}</>}
          unCheckedChildren={<><WarningOutlined /> {t('devices.form.readonly_off')}</>}
        />
      </Form.Item>

      <Form.Item
        label={
          <Tooltip title={t('devices.wizard.approval_tooltip_short')}>
            {t('devices.form.approval_label')}
          </Tooltip>
        }
        name="approval_required"
        valuePropName="checked"
      >
        <Switch checkedChildren={t('devices.form.approval_on')} unCheckedChildren={t('devices.form.approval_off')} />
      </Form.Item>
    </>
  )
}

// ── Step 3: SNMP ──────────────────────────────────────────────────────────────

function Step3() {
  const { t } = useTranslation()
  // HF#8 — Step2 ile aynı: profil seçiliyse SNMP credential alanları opsiyonel
  const watchedCredentialProfileId = Form.useWatch('credential_profile_id')
  const hasCredentialProfile = watchedCredentialProfileId != null

  return (
    <>
      <Form.Item label={t('devices.form.snmp_enabled')} name="snmp_enabled" valuePropName="checked">
        <Switch checkedChildren={<WifiOutlined />} unCheckedChildren={t('devices.wizard.snmp_off')} />
      </Form.Item>

      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) =>
          prev.snmp_enabled !== cur.snmp_enabled || prev.snmp_version !== cur.snmp_version
        }
      >
        {({ getFieldValue }) => getFieldValue('snmp_enabled') && (
          <>
            <Form.Item label={t('devices.wizard.snmp_version_label')} name="snmp_version">
              <Select options={[
                { value: 'v1', label: 'SNMPv1' },
                { value: 'v2c', label: 'SNMPv2c' },
                { value: 'v3', label: 'SNMPv3 (USM)' },
              ]} />
            </Form.Item>

            <Form.Item label={t('devices.form.snmp_port')} name="snmp_port">
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>

            {getFieldValue('snmp_version') !== 'v3' && (
              <Form.Item
                label={<span>{t('devices.form.community')} {hasCredentialProfile && <span style={{ color: 'var(--fg-3,#94a3b8)', fontSize: 11, fontWeight: 400 }}>{t('devices.form.optional_profile_used')}</span>}</span>}
                name="snmp_community"
                rules={[{ required: !hasCredentialProfile, message: t('common.validation.community_required') }]}
              >
                <Input placeholder={hasCredentialProfile ? t('devices.form.placeholder_profile_override') : 'public'} />
              </Form.Item>
            )}

            {getFieldValue('snmp_version') === 'v3' && (
              <>
                <Form.Item
                  label={<span>{t('devices.form.snmp_v3_username')} {hasCredentialProfile && <span style={{ color: 'var(--fg-3,#94a3b8)', fontSize: 11, fontWeight: 400 }}>{t('devices.form.optional_profile_used')}</span>}</span>}
                  name="snmp_v3_username"
                  rules={[{ required: !hasCredentialProfile, message: t('common.validation.username_required') }]}
                >
                  <Input placeholder={hasCredentialProfile ? t('devices.form.placeholder_profile_override') : 'snmpv3user'} />
                </Form.Item>
                <Form.Item label={t('devices.form.snmp_v3_auth_protocol')} name="snmp_v3_auth_protocol">
                  <Select allowClear placeholder={t('devices.form.snmp_v3_auth_none')} options={[
                    { value: 'md5', label: 'MD5' },
                    { value: 'sha1', label: 'SHA-1' },
                  ]} />
                </Form.Item>
                <Form.Item noStyle shouldUpdate={(p, c) => p.snmp_v3_auth_protocol !== c.snmp_v3_auth_protocol}>
                  {({ getFieldValue: gfv }) => gfv('snmp_v3_auth_protocol') && (
                    <Form.Item label={t('devices.form.snmp_v3_auth_passphrase')} name="snmp_v3_auth_passphrase"
                      rules={[{ min: 8, message: t('common.validation.min8') }]}>
                      <Input.Password placeholder={t('devices.form.placeholder_min8')} />
                    </Form.Item>
                  )}
                </Form.Item>
                <Form.Item label={t('devices.form.snmp_v3_priv_protocol')} name="snmp_v3_priv_protocol">
                  <Select allowClear placeholder={t('devices.form.snmp_v3_priv_none')} options={[
                    { value: 'des', label: 'DES' },
                    { value: 'aes128', label: 'AES-128' },
                  ]} />
                </Form.Item>
                <Form.Item noStyle shouldUpdate={(p, c) => p.snmp_v3_priv_protocol !== c.snmp_v3_priv_protocol}>
                  {({ getFieldValue: gfv }) => gfv('snmp_v3_priv_protocol') && (
                    <Form.Item label={t('devices.form.snmp_v3_priv_passphrase')} name="snmp_v3_priv_passphrase"
                      rules={[{ min: 8, message: t('common.validation.min8') }]}>
                      <Input.Password placeholder={t('devices.form.placeholder_min8')} />
                    </Form.Item>
                  )}
                </Form.Item>
              </>
            )}
          </>
        )}
      </Form.Item>

      <Alert
        type="info" showIcon style={{ marginTop: 12 }}
        message={t('devices.wizard.snmp_alert')}
      />
    </>
  )
}

// ── Step 4: Summary & Test ────────────────────────────────────────────────────

type TestState = 'idle' | 'creating' | 'testing' | 'done'

interface TestResult {
  device: Device
  success: boolean
  message: string
  latency_ms?: number
}

function Step4({
  formValues,
  onComplete,
}: {
  formValues: Record<string, unknown>
  onComplete: (device: Device) => void
}) {
  const { message: msg } = App.useApp()
  const { t } = useTranslation()
  const [state, setState] = useState<TestState>('idle')
  const [result, setResult] = useState<TestResult | null>(null)
  const [fetchedInfo, setFetchedInfo] = useState(false)
  const [fetchingInfo, setFetchingInfo] = useState(false)

  const vLabel = (v: boolean) => v ? <Tag color="green">{t('common.yes')}</Tag> : <Tag>{t('common.no')}</Tag>

  const handleCreate = async () => {
    setState('creating')
    try {
      const payload: Record<string, unknown> = { ...formValues }
      if (payload.agent_id === '') payload.agent_id = null
      if (payload.layer === '') payload.layer = null
      if (!payload.snmp_enabled) {
        payload.snmp_enabled = false
      }

      // Incident HF#9 (2026-06-03) — DeviceForm ile aynı; HF#8 sonrası kimlik
      // profili seçiliyken SSH alanları undefined kalabilir → backend Pydantic
      // 422 missing field. Empty string fallback ile sözleşme korunur.
      payload.ssh_username = typeof formValues.ssh_username === 'string' ? formValues.ssh_username : ''
      payload.ssh_password = typeof formValues.ssh_password === 'string' ? formValues.ssh_password : ''

      const device = await devicesApi.create(payload)
      setState('testing')

      const testRes = await devicesApi.testConnection(device.id)
      setResult({ device, success: testRes.success, message: testRes.message, latency_ms: testRes.latency_ms })
      setState('done')
    } catch (err: any) {
      // HF#9 — Pydantic v2 detail array crash korumasi
      msg.error(formatApiError(err, t('devices.wizard.device_create_failed')))
      setState('idle')
    }
  }

  const handleFetchInfo = async () => {
    if (!result?.device) return
    setFetchingInfo(true)
    try {
      const updated = await devicesApi.fetchInfo(result.device.id)
      setFetchedInfo(true)
      msg.success(t('devices.wizard.fetch_info_success', { name: updated.hostname || result.device.ip_address }))
      setResult((prev) => prev ? { ...prev, device: updated } : prev)
    } catch {
      msg.error(t('devices.wizard.fetch_info_failed'))
    } finally {
      setFetchingInfo(false)
    }
  }

  const ip = String(formValues.ip_address || '—')
  const hostname = String(formValues.hostname || '—')
  const vendor = String(formValues.vendor || '—')
  const osType = String(formValues.os_type || '—')
  const layer = String(formValues.layer || '—')
  const site = String(formValues.site || '—')
  const sshUser = String(formValues.ssh_username || '—')
  const snmpEnabled = Boolean(formValues.snmp_enabled)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Alert
        type="warning" showIcon
        message={t('devices.wizard.summary_alert')}
      />

      <Descriptions bordered size="small" column={1} title={t('devices.wizard.summary_title')}>
        <Descriptions.Item label={t('devices.form.ip_address')}><Text code>{ip}</Text></Descriptions.Item>
        <Descriptions.Item label={t('devices.form.hostname')}>{hostname}</Descriptions.Item>
        <Descriptions.Item label={t('devices.wizard.summary_vendor_os')}>{vendor} / {osType}</Descriptions.Item>
        <Descriptions.Item label={t('devices.form.layer')}>{layer}</Descriptions.Item>
        <Descriptions.Item label={t('devices.form.site')}>{site}</Descriptions.Item>
        <Descriptions.Item label={t('devices.form.ssh_username')}>{sshUser}</Descriptions.Item>
        <Descriptions.Item label="SNMP">{snmpEnabled ? <Tag color="green">{t('devices.wizard.snmp_on_tag')}</Tag> : <Tag>{t('devices.wizard.snmp_off')}</Tag>}</Descriptions.Item>
        <Descriptions.Item label={t('devices.wizard.summary_readonly')}>{vLabel(Boolean(formValues.is_readonly))}</Descriptions.Item>
        <Descriptions.Item label={t('devices.wizard.summary_approval')}>{vLabel(Boolean(formValues.approval_required))}</Descriptions.Item>
      </Descriptions>

      {/* Test result */}
      {state === 'done' && result && (
        <Alert
          type={result.success ? 'success' : 'warning'}
          showIcon
          icon={result.success
            ? <CheckCircleFilled style={{ color: '#52c41a' }} />
            : <CloseCircleFilled style={{ color: '#f5222d' }} />
          }
          message={result.success ? t('devices.wizard.ssh_test_success') : t('devices.wizard.ssh_test_failed')}
          description={
            <div>
              <Text style={{ fontSize: 12 }}>{result.message}</Text>
              {result.latency_ms != null && (
                <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                  {t('devices.wizard.latency', { ms: result.latency_ms })}
                </Text>
              )}
            </div>
          }
        />
      )}

      {/* Action buttons */}
      <Space direction="vertical" style={{ width: '100%' }}>
        {state === 'idle' && (
          <Button
            type="primary"
            size="large"
            block
            icon={<ThunderboltOutlined />}
            onClick={handleCreate}
          >
            {t('devices.wizard.create_and_test')}
          </Button>
        )}

        {(state === 'creating' || state === 'testing') && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <Spin indicator={<LoadingOutlined spin />} />
            <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
              {state === 'creating' ? t('devices.wizard.creating') : t('devices.wizard.testing')}
            </Text>
          </div>
        )}

        {state === 'done' && result && (
          <>
            {!fetchedInfo && (
              <Button
                block
                icon={<SyncOutlined spin={fetchingInfo} />}
                loading={fetchingInfo}
                onClick={handleFetchInfo}
              >
                {t('devices.fetch_info')}
              </Button>
            )}
            {fetchedInfo && (
              <Alert
                type="success" showIcon
                message={t('devices.wizard.info_updated', { name: result.device.hostname || result.device.ip_address })}
              />
            )}
            <Button type="primary" block onClick={() => onComplete(result.device)}>
              {t('devices.wizard.complete')}
            </Button>
          </>
        )}
      </Space>
    </div>
  )
}

// ── Main Wizard ───────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  onSuccess: (device: Device) => void
}

export default function OnboardingWizard({ open, onClose, onSuccess }: Props) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [current, setCurrent] = useState(0)
  const [step4Values, setStep4Values] = useState<Record<string, unknown>>({})

  const STEP_DEFS = useMemo(() => [
    { title: t('devices.wizard.step0_title') },
    { title: t('devices.wizard.step1_title') },
    { title: t('devices.wizard.step2_title') },
    { title: t('devices.wizard.step3_title') },
    { title: t('devices.wizard.step4_title') },
  ], [t])

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: agentsApi.list,
    enabled: open,
  })

  const { data: credProfiles = [] } = useQuery({
    queryKey: ['credential-profiles'],
    queryFn: credentialProfilesApi.list,
    enabled: open,
  })

  const handleNext = async () => {
    try {
      await form.validateFields(STEP_FIELDS[current])
      if (current === STEP_FIELDS.length - 1) {
        // Entering final step — snapshot all values
        const all = form.getFieldsValue(true)
        setStep4Values(all)
      }
      setCurrent((c) => c + 1)
    } catch {
      // validation error shown inline
    }
  }

  const handleBack = () => setCurrent((c) => c - 1)

  const handleClose = () => {
    form.resetFields()
    setCurrent(0)
    setStep4Values({})
    onClose()
  }

  const handleComplete = (device: Device) => {
    handleClose()
    onSuccess(device)
  }

  const isFinalStep = current === STEP_DEFS.length - 1

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      title={
        <Space>
          <ThunderboltOutlined style={{ color: '#1677ff' }} />
          <span>{t('devices.wizard.title')}</span>
        </Space>
      }
      width={680}
      footer={
        isFinalStep ? null : (
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button onClick={handleBack} disabled={current === 0}>
              {t('devices.wizard.back')}
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('devices.wizard.step_progress', { current: current + 1, total: STEP_DEFS.length })}
            </Text>
            <Button type="primary" onClick={handleNext}>
              {current === STEP_DEFS.length - 2 ? t('devices.wizard.summary_next') : t('devices.wizard.next')}
            </Button>
          </Space>
        )
      }
      destroyOnClose
    >
      <Steps
        current={current}
        size="small"
        style={{ marginBottom: 28 }}
        items={STEP_DEFS.map((s) => ({ title: s.title }))}
      />

      <Form
        form={form}
        layout="vertical"
        initialValues={{
          device_type: 'switch',
          vendor: 'cisco',
          os_type: 'cisco_ios',
          ssh_port: 22,
          snmp_enabled: false,
          snmp_version: 'v2c',
          snmp_port: 161,
          is_readonly: true,
          approval_required: false,
          agent_id: '',
          fallback_agent_ids: [],
          layer: '',
        }}
        onValuesChange={(changed) => {
          if ('vendor' in changed) {
            const allowed = VENDOR_OS_MAP[changed.vendor] ?? []
            const current = form.getFieldValue('os_type')
            if (!allowed.includes(current)) {
              form.setFieldValue('os_type', allowed[0] ?? null)
            }
          }
        }}
      >
        {/* Render all steps but only show current (avoids unmounting form state) */}
        <div style={{ display: current === 0 ? 'block' : 'none' }}>
          <Step0 />
        </div>
        <div style={{ display: current === 1 ? 'block' : 'none' }}>
          <Step1 />
        </div>
        <div style={{ display: current === 2 ? 'block' : 'none' }}>
          <Step2 agents={agents} credProfiles={credProfiles} />
        </div>
        <div style={{ display: current === 3 ? 'block' : 'none' }}>
          <Step3 />
        </div>
      </Form>

      {/* Step 4 is outside the form — handles its own async state */}
      {isFinalStep && (
        <Step4 formValues={step4Values} onComplete={handleComplete} />
      )}
    </Modal>
  )
}
