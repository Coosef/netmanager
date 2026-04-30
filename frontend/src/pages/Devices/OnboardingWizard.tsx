import { useState } from 'react'
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
import { devicesApi } from '@/api/devices'
import { agentsApi } from '@/api/agents'
import { credentialProfilesApi } from '@/api/credentialProfiles'
import type { Device } from '@/types'
import { DEVICE_TYPE_OPTIONS, OS_TYPE_OPTIONS, VENDOR_OPTIONS, VENDOR_OS_MAP } from '@/types'

const { Text } = Typography

// ── Field groups per step ─────────────────────────────────────────────────────

const STEP_FIELDS: string[][] = [
  // 0 — Temel Bilgiler
  ['hostname', 'ip_address', 'alias', 'description'],
  // 1 — Cihaz Profili
  ['device_type', 'vendor', 'os_type', 'model', 'layer', 'site', 'building', 'floor', 'tags'],
  // 2 — SSH & Kimlik
  ['credential_profile_id', 'agent_id', 'fallback_agent_ids',
   'ssh_username', 'ssh_password', 'enable_secret', 'ssh_port',
   'is_readonly', 'approval_required'],
  // 3 — SNMP (optional)
  ['snmp_enabled', 'snmp_version', 'snmp_community', 'snmp_port',
   'snmp_v3_username', 'snmp_v3_auth_protocol', 'snmp_v3_auth_passphrase',
   'snmp_v3_priv_protocol', 'snmp_v3_priv_passphrase'],
  // 4 — Özet & Test (no form fields — handled separately)
]

const STEP_DEFS = [
  { title: 'Temel Bilgiler', icon: '①' },
  { title: 'Cihaz Profili', icon: '②' },
  { title: 'SSH & Kimlik', icon: '③' },
  { title: 'SNMP', icon: '④' },
  { title: 'Test & Tamamla', icon: '⑤' },
]

// ── Step 0: Basic Info ────────────────────────────────────────────────────────

function Step0() {
  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
        message="IP adresi zorunludur. Hostname boş bırakılırsa son adımda cihazdan otomatik çekilebilir."
      />
      <Form.Item
        label="IP Adresi"
        name="ip_address"
        rules={[
          { required: true, message: 'IP adresi gerekli' },
          { pattern: /^(\d{1,3}\.){3}\d{1,3}$/, message: 'Geçerli bir IPv4 adresi girin' },
        ]}
      >
        <Input placeholder="192.168.1.1" size="large" autoFocus />
      </Form.Item>

      <Form.Item label="Hostname" name="hostname" tooltip="Boş bırakabilirsiniz — son adımda cihazdan otomatik alınabilir">
        <Input placeholder="sw-core-01 (opsiyonel)" />
      </Form.Item>

      <Form.Item label="Alias (Takma Ad)" name="alias" tooltip="Listede ve aramada gösterilir">
        <Input placeholder="Örn: Bina-A Dağıtım Switch'i" />
      </Form.Item>

      <Form.Item label="Açıklama" name="description">
        <Input.TextArea rows={2} placeholder="Kısa açıklama (opsiyonel)" />
      </Form.Item>
    </>
  )
}

// ── Step 1: Device Profile ────────────────────────────────────────────────────

function Step1() {
  const selectedVendor = Form.useWatch('vendor')
  const filteredOsOptions = selectedVendor && VENDOR_OS_MAP[selectedVendor]
    ? OS_TYPE_OPTIONS.filter((o) => VENDOR_OS_MAP[selectedVendor].includes(o.value))
    : OS_TYPE_OPTIONS

  return (
    <>
      <Form.Item label="Cihaz Tipi" name="device_type" rules={[{ required: true }]}>
        <Select options={DEVICE_TYPE_OPTIONS} size="large" />
      </Form.Item>

      <Form.Item label="Vendor" name="vendor" rules={[{ required: true }]}>
        <Select options={VENDOR_OPTIONS} />
      </Form.Item>

      <Form.Item label="OS Tipi" name="os_type" rules={[{ required: true }]}>
        <Select options={filteredOsOptions} showSearch />
      </Form.Item>

      <Form.Item label="Model" name="model">
        <Input placeholder="Catalyst 2960, Aruba 2530…" />
      </Form.Item>

      <Divider plain style={{ fontSize: 12 }}>Konum & Topoloji</Divider>

      <Form.Item label="Ağ Katmanı" name="layer" tooltip="Topoloji görünümünde katman filtresi için">
        <Select allowClear placeholder="— Seçin —" options={[
          { label: 'Core', value: 'core' },
          { label: 'Distribution', value: 'distribution' },
          { label: 'Access', value: 'access' },
          { label: 'Edge', value: 'edge' },
          { label: 'Wireless', value: 'wireless' },
        ]} />
      </Form.Item>

      <Form.Item label="Site" name="site">
        <Input placeholder="Merkez Ofis" />
      </Form.Item>

      <Form.Item label="Bina" name="building">
        <Input placeholder="A Binası" />
      </Form.Item>

      <Form.Item label="Kat" name="floor">
        <Input placeholder="3. Kat" />
      </Form.Item>

      <Form.Item label="Etiketler" name="tags" tooltip="Virgülle ayırın: core,vlan10,building-a">
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
  const agentOptions = [
    { label: '— Yok (direkt SSH) —', value: '' },
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
        label={<span><SafetyOutlined style={{ marginRight: 4 }} />Kimlik Profili</span>}
        name="credential_profile_id"
        tooltip="Profil seçilirse SSH/SNMP bağlantılarında bu profil kullanılır; aşağıdaki alanlar yedek olarak kalır."
      >
        <Select
          allowClear
          placeholder="— Cihaza özel credential —"
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
            message="Kimlik profili aktif — SSH/SNMP bağlantılarında bu profil kullanılır."
          />
        )}
      </Form.Item>

      <Form.Item label="Proxy Agent" name="agent_id"
        tooltip="SSH komutları bu agent üzerinden yönlendirilir (opsiyonel)">
        <Select options={agentOptions} />
      </Form.Item>

      <Form.Item label="Yedek Agent'lar" name="fallback_agent_ids"
        tooltip="Birincil agent çevrimdışıysa sırayla denenir">
        <Select mode="multiple" allowClear placeholder="— Seçin (opsiyonel) —" options={fallbackAgentOptions} />
      </Form.Item>

      <Divider plain style={{ fontSize: 12 }}>SSH Bağlantısı</Divider>

      <Form.Item label="SSH Kullanıcısı" name="ssh_username" rules={[{ required: true, message: 'Kullanıcı adı gerekli' }]}>
        <Input placeholder="admin" />
      </Form.Item>

      <Form.Item label="SSH Şifre" name="ssh_password" rules={[{ required: true, message: 'Şifre gerekli' }]}>
        <Input.Password />
      </Form.Item>

      <Form.Item label="Enable Secret" name="enable_secret">
        <Input.Password placeholder="(opsiyonel — Cisco enable için)" />
      </Form.Item>

      <Form.Item label="SSH Port" name="ssh_port">
        <InputNumber min={1} max={65535} style={{ width: '100%' }} />
      </Form.Item>

      <Divider plain style={{ fontSize: 12 }}>Güvenlik</Divider>

      <Form.Item
        label={
          <Tooltip title="Aktifken sadece show/ping komutlarına izin verilir.">
            CLI Güvenlik Modu
          </Tooltip>
        }
        name="is_readonly"
        valuePropName="checked"
      >
        <Switch
          checkedChildren={<><SafetyCertificateOutlined /> Salt-okunur</>}
          unCheckedChildren={<><WarningOutlined /> Yazma İzni</>}
        />
      </Form.Item>

      <Form.Item
        label={
          <Tooltip title="Aktifken config komutları admin onayına gider.">
            Admin Onay Akışı
          </Tooltip>
        }
        name="approval_required"
        valuePropName="checked"
      >
        <Switch checkedChildren="Onay Zorunlu" unCheckedChildren="Serbest" />
      </Form.Item>
    </>
  )
}

// ── Step 3: SNMP ──────────────────────────────────────────────────────────────

function Step3() {
  return (
    <>
      <Form.Item label="SNMP Aktif" name="snmp_enabled" valuePropName="checked">
        <Switch checkedChildren={<WifiOutlined />} unCheckedChildren="Kapalı" />
      </Form.Item>

      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) =>
          prev.snmp_enabled !== cur.snmp_enabled || prev.snmp_version !== cur.snmp_version
        }
      >
        {({ getFieldValue }) => getFieldValue('snmp_enabled') && (
          <>
            <Form.Item label="SNMP Versiyon" name="snmp_version">
              <Select options={[
                { value: 'v1', label: 'SNMPv1' },
                { value: 'v2c', label: 'SNMPv2c' },
                { value: 'v3', label: 'SNMPv3 (USM)' },
              ]} />
            </Form.Item>

            <Form.Item label="SNMP Port" name="snmp_port">
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>

            {getFieldValue('snmp_version') !== 'v3' && (
              <Form.Item label="Community" name="snmp_community"
                rules={[{ required: true, message: 'Community gerekli' }]}>
                <Input placeholder="public" />
              </Form.Item>
            )}

            {getFieldValue('snmp_version') === 'v3' && (
              <>
                <Form.Item label="v3 Username" name="snmp_v3_username"
                  rules={[{ required: true, message: 'Username gerekli' }]}>
                  <Input placeholder="snmpv3user" />
                </Form.Item>
                <Form.Item label="Auth Protokol" name="snmp_v3_auth_protocol">
                  <Select allowClear placeholder="Yok (noAuth)" options={[
                    { value: 'md5', label: 'MD5' },
                    { value: 'sha1', label: 'SHA-1' },
                  ]} />
                </Form.Item>
                <Form.Item noStyle shouldUpdate={(p, c) => p.snmp_v3_auth_protocol !== c.snmp_v3_auth_protocol}>
                  {({ getFieldValue: gfv }) => gfv('snmp_v3_auth_protocol') && (
                    <Form.Item label="Auth Parola" name="snmp_v3_auth_passphrase"
                      rules={[{ min: 8, message: 'En az 8 karakter' }]}>
                      <Input.Password placeholder="min. 8 karakter" />
                    </Form.Item>
                  )}
                </Form.Item>
                <Form.Item label="Priv Protokol" name="snmp_v3_priv_protocol">
                  <Select allowClear placeholder="Yok (noPriv)" options={[
                    { value: 'des', label: 'DES' },
                    { value: 'aes128', label: 'AES-128' },
                  ]} />
                </Form.Item>
                <Form.Item noStyle shouldUpdate={(p, c) => p.snmp_v3_priv_protocol !== c.snmp_v3_priv_protocol}>
                  {({ getFieldValue: gfv }) => gfv('snmp_v3_priv_protocol') && (
                    <Form.Item label="Priv Parola" name="snmp_v3_priv_passphrase"
                      rules={[{ min: 8, message: 'En az 8 karakter' }]}>
                      <Input.Password placeholder="min. 8 karakter" />
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
        message="SNMP devre dışı bırakılabilir — sonradan Cihaz Ayarları'ndan etkinleştirilebilir."
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
  const [state, setState] = useState<TestState>('idle')
  const [result, setResult] = useState<TestResult | null>(null)
  const [fetchedInfo, setFetchedInfo] = useState(false)
  const [fetchingInfo, setFetchingInfo] = useState(false)

  const vLabel = (v: boolean) => v ? <Tag color="green">Evet</Tag> : <Tag>Hayır</Tag>

  const handleCreate = async () => {
    setState('creating')
    try {
      const payload: Record<string, unknown> = { ...formValues }
      if (payload.agent_id === '') payload.agent_id = null
      if (payload.layer === '') payload.layer = null
      if (!payload.snmp_enabled) {
        payload.snmp_enabled = false
      }

      const device = await devicesApi.create(payload)
      setState('testing')

      const testRes = await devicesApi.testConnection(device.id)
      setResult({ device, success: testRes.success, message: testRes.message, latency_ms: testRes.latency_ms })
      setState('done')
    } catch (err: any) {
      msg.error(err?.response?.data?.detail || 'Cihaz oluşturulamadı')
      setState('idle')
    }
  }

  const handleFetchInfo = async () => {
    if (!result?.device) return
    setFetchingInfo(true)
    try {
      const updated = await devicesApi.fetchInfo(result.device.id)
      setFetchedInfo(true)
      msg.success(`Bilgiler çekildi: ${updated.hostname || result.device.ip_address}`)
      setResult((prev) => prev ? { ...prev, device: updated } : prev)
    } catch {
      msg.error('Bilgi çekme başarısız')
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
        message="Aşağıdaki özeti kontrol edin, ardından cihazı oluşturun ve SSH bağlantısını test edin."
      />

      <Descriptions bordered size="small" column={1} title="Özet">
        <Descriptions.Item label="IP Adresi"><Text code>{ip}</Text></Descriptions.Item>
        <Descriptions.Item label="Hostname">{hostname}</Descriptions.Item>
        <Descriptions.Item label="Vendor / OS">{vendor} / {osType}</Descriptions.Item>
        <Descriptions.Item label="Katman">{layer}</Descriptions.Item>
        <Descriptions.Item label="Site">{site}</Descriptions.Item>
        <Descriptions.Item label="SSH Kullanıcısı">{sshUser}</Descriptions.Item>
        <Descriptions.Item label="SNMP">{snmpEnabled ? <Tag color="green">Aktif</Tag> : <Tag>Kapalı</Tag>}</Descriptions.Item>
        <Descriptions.Item label="Salt-okunur CLI">{vLabel(Boolean(formValues.is_readonly))}</Descriptions.Item>
        <Descriptions.Item label="Admin Onay">{vLabel(Boolean(formValues.approval_required))}</Descriptions.Item>
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
          message={result.success ? 'SSH bağlantısı başarılı' : 'SSH bağlantısı başarısız'}
          description={
            <div>
              <Text style={{ fontSize: 12 }}>{result.message}</Text>
              {result.latency_ms != null && (
                <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                  Gecikme: {result.latency_ms} ms
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
            Cihaz Oluştur & SSH Test Et
          </Button>
        )}

        {(state === 'creating' || state === 'testing') && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <Spin indicator={<LoadingOutlined spin />} />
            <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
              {state === 'creating' ? 'Cihaz oluşturuluyor…' : 'SSH testi yapılıyor…'}
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
                Cihaz Bilgilerini Çek (hostname, model, firmware)
              </Button>
            )}
            {fetchedInfo && (
              <Alert
                type="success" showIcon
                message={`Bilgiler güncellendi — ${result.device.hostname || result.device.ip_address}`}
              />
            )}
            <Button type="primary" block onClick={() => onComplete(result.device)}>
              Tamamla
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
  const [form] = Form.useForm()
  const [current, setCurrent] = useState(0)
  const [step4Values, setStep4Values] = useState<Record<string, unknown>>({})

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
          <span>Yeni Cihaz Ekleme Sihirbazı</span>
        </Space>
      }
      width={680}
      footer={
        isFinalStep ? null : (
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button onClick={handleBack} disabled={current === 0}>
              ← Geri
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Adım {current + 1} / {STEP_DEFS.length}
            </Text>
            <Button type="primary" onClick={handleNext}>
              {current === STEP_DEFS.length - 2 ? 'Özet & Test →' : 'İleri →'}
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
