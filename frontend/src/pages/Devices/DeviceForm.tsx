import { Alert, App, Button, Divider, Form, Input, InputNumber, Select, Switch, Tag, Tooltip } from 'antd'
import { SafetyCertificateOutlined, WarningOutlined, SafetyOutlined } from '@ant-design/icons'
import { RobotOutlined } from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import { agentsApi } from '@/api/agents'
import { credentialProfilesApi } from '@/api/credentialProfiles'
import { locationsApi } from '@/api/locations'
import type { Device } from '@/types'
import { DEVICE_TYPE_OPTIONS, OS_TYPE_OPTIONS, VENDOR_OPTIONS, VENDOR_OS_MAP } from '@/types'
import { useTranslation } from 'react-i18next'

interface Props {
  device?: Device | null
  onSuccess: () => void
}

export default function DeviceForm({ device, onSuccess }: Props) {
  const { message } = App.useApp()
  const { t } = useTranslation()
  const [form] = Form.useForm()

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: agentsApi.list,
  })

  const { data: credProfiles = [] } = useQuery({
    queryKey: ['credential-profiles'],
    queryFn: credentialProfilesApi.list,
  })

  const { data: locationsData } = useQuery({
    queryKey: ['locations'],
    queryFn: () => locationsApi.list(),
    staleTime: 30_000,
  })

  const agentOptions = [
    { label: '— Yok (direkt SSH) —', value: '' },
    ...agents.map((a) => ({
      label: (
        <span>
          <RobotOutlined style={{ marginRight: 6, color: a.status === 'online' ? '#52c41a' : '#f5222d' }} />
          {a.name}
          <Tag
            style={{ marginLeft: 8, fontSize: 10 }}
            color={a.status === 'online' ? 'success' : 'error'}
          >
            {a.status}
          </Tag>
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

  const selectedVendor = Form.useWatch('vendor', form)
  const filteredOsOptions = selectedVendor && VENDOR_OS_MAP[selectedVendor]
    ? OS_TYPE_OPTIONS.filter((o) => VENDOR_OS_MAP[selectedVendor].includes(o.value))
    : OS_TYPE_OPTIONS

  const mutation = useMutation({
    mutationFn: (values: Record<string, unknown>) => {
      const payload = { ...values }
      if (payload.agent_id === '') payload.agent_id = null
      if (payload.layer === '') payload.layer = null
      if (payload.site === '') payload.site = null
      if (payload.building === '') payload.building = null
      if (payload.floor === '') payload.floor = null
      return device ? devicesApi.update(device.id, payload) : devicesApi.create(payload)
    },
    onSuccess: () => {
      message.success(t('common.success'))
      onSuccess()
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail || t('common.error'))
    },
  })

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={device ? {
        hostname: device.hostname,
        ip_address: device.ip_address,
        device_type: device.device_type || 'switch',
        vendor: device.vendor,
        os_type: device.os_type,
        model: device.model,
        location: device.location,
        description: device.description,
        tags: device.tags,
        alias: device.alias,
        layer: device.layer || '',
        site: device.site || '',
        building: device.building || '',
        floor: device.floor || '',
        credential_profile_id: (device as any).credential_profile_id ?? null,
        ssh_username: device.ssh_username,
        ssh_port: device.ssh_port,
        agent_id: device.agent_id || '',
        fallback_agent_ids: (device as any).fallback_agent_ids || [],
        is_readonly: device.is_readonly ?? true,
        approval_required: device.approval_required ?? false,
        snmp_enabled: device.snmp_enabled ?? false,
        snmp_community: '',
        snmp_version: device.snmp_version || 'v2c',
        snmp_port: device.snmp_port || 161,
        snmp_v3_username: device.snmp_v3_username || '',
        snmp_v3_auth_protocol: device.snmp_v3_auth_protocol || undefined,
        snmp_v3_priv_protocol: device.snmp_v3_priv_protocol || undefined,
      } : { ssh_port: 22, device_type: 'switch', vendor: 'cisco', os_type: 'cisco_ios', agent_id: '', fallback_agent_ids: [], hostname: '', layer: '', site: '', building: '', floor: '', is_readonly: true, approval_required: false, snmp_enabled: false, snmp_version: 'v2c', snmp_port: 161 }}
      onValuesChange={(changed) => {
        if ('vendor' in changed) {
          const allowed = VENDOR_OS_MAP[changed.vendor] ?? []
          const current = form.getFieldValue('os_type')
          if (!allowed.includes(current)) {
            form.setFieldValue('os_type', allowed[0] ?? null)
          }
        }
      }}
      onFinish={(values) => mutation.mutate(values)}
    >
      <Form.Item label="Cihaz Tipi" name="device_type" rules={[{ required: true }]}>
        <Select options={DEVICE_TYPE_OPTIONS} />
      </Form.Item>

      <Form.Item
        label="Hostname"
        name="hostname"
        tooltip="Boş bırakırsanız IP adresi kullanılır. 'Bilgi Çek' butonu ile cihazdan otomatik alınabilir."
      >
        <Input placeholder="sw-core-01 (opsiyonel, otomatik çekilebilir)" />
      </Form.Item>

      <Form.Item label="Alias (Takma Ad)" name="alias" tooltip="Kişisel takma ad — aramada ve listede gösterilir">
        <Input placeholder="Örn: Bina-A Ana Switch" />
      </Form.Item>

      <Form.Item label="IP Adresi" name="ip_address" rules={[{ required: !device }]}>
        <Input placeholder="192.168.1.1" disabled={!!device} />
      </Form.Item>

      <Form.Item label="Vendor" name="vendor" rules={[{ required: true }]}>
        <Select options={VENDOR_OPTIONS} />
      </Form.Item>

      <Form.Item label="OS Tipi" name="os_type" rules={[{ required: true }]}>
        <Select options={filteredOsOptions} showSearch />
      </Form.Item>

      <Form.Item label="Model" name="model">
        <Input placeholder="Catalyst 2960" />
      </Form.Item>

      <Form.Item label="Ağ Katmanı" name="layer" tooltip="Topoloji görünümünde katman bazlı filtreleme için kullanılır">
        <Select allowClear placeholder="— Seçin (opsiyonel) —" options={[
          { label: 'Core', value: 'core' },
          { label: 'Distribution', value: 'distribution' },
          { label: 'Access', value: 'access' },
          { label: 'Edge', value: 'edge' },
          { label: 'Wireless', value: 'wireless' },
        ]} />
      </Form.Item>

      <Form.Item label="Konum" name="location">
        <Input placeholder="DC-A / Raf-3" />
      </Form.Item>

      <Form.Item label="Lokasyon" name="site" tooltip="Header'daki lokasyon seçiciyle eşleşir">
        <Select
          allowClear
          placeholder="Lokasyon seçin"
          options={[
            ...(locationsData?.items ?? []).map((l) => ({
              value: l.name,
              label: (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.color || '#3b82f6', display: 'inline-block', flexShrink: 0 }} />
                  {l.name}
                </span>
              ),
            })),
          ]}
        />
      </Form.Item>

      <Form.Item label="Bina" name="building">
        <Input placeholder="A Binası" />
      </Form.Item>

      <Form.Item label="Kat" name="floor">
        <Input placeholder="3. Kat" />
      </Form.Item>

      <Form.Item label="Etiketler" name="tags">
        <Input placeholder="core,vlan10,building-a" />
      </Form.Item>

      <Form.Item
        label={
          <Tooltip title="Aktifken sadece show/ping komutlarına izin verilir. Kapatınca config komutları çalışabilir (denylist hariç).">
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
          <Tooltip title="Aktifken config komutları (medium/high risk) admin onayına gider — 4-gözlü prensip.">
            Admin Onay Akışı
          </Tooltip>
        }
        name="approval_required"
        valuePropName="checked"
      >
        <Switch
          checkedChildren="Onay Zorunlu"
          unCheckedChildren="Serbest"
        />
      </Form.Item>

      <Divider style={{ margin: '12px 0', fontSize: 12 }}>SSH Bağlantısı</Divider>

      <Form.Item
        label={<span><SafetyOutlined style={{ marginRight: 4 }} />Kimlik Profili</span>}
        name="credential_profile_id"
        tooltip="Profil seçilirse SSH/SNMP bağlantılarında bu profil kullanılır; cihaza özel alanlar ikincil kalır."
      >
        <Select
          allowClear
          placeholder="— Cihaza özel credential (profil yok) —"
          options={[
            ...credProfiles.map((p) => ({
              label: `${p.name}${p.description ? ` — ${p.description}` : ''}`,
              value: p.id,
            })),
          ]}
        />
      </Form.Item>

      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.credential_profile_id !== cur.credential_profile_id}
      >
        {({ getFieldValue }) => getFieldValue('credential_profile_id') && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12, fontSize: 12 }}
            message="Kimlik profili aktif — aşağıdaki SSH/SNMP alanları sadece profil eksik alanlar için yedek olarak kullanılır."
          />
        )}
      </Form.Item>

      <Form.Item
        label="Proxy Agent"
        name="agent_id"
        tooltip="Agent seçilirse SSH komutları direkt değil, bu agent üzerinden gönderilir."
      >
        <Select options={agentOptions} />
      </Form.Item>

      <Form.Item
        label="Yedek Agent'lar"
        name="fallback_agent_ids"
        tooltip="Birincil agent çevrimdışıysa sırayla denenir. Boş bırakılabilir."
      >
        <Select
          mode="multiple"
          allowClear
          placeholder="— Yedek agent seçin (opsiyonel) —"
          options={fallbackAgentOptions}
        />
      </Form.Item>

      <Form.Item label="SSH Kullanıcısı" name="ssh_username" rules={[{ required: true }]}>
        <Input placeholder="admin" />
      </Form.Item>

      <Form.Item
        label="SSH Şifre"
        name="ssh_password"
        rules={[{ required: !device, message: 'Şifre gerekli' }]}
      >
        <Input.Password placeholder={device ? '(değiştirmek için girin)' : ''} />
      </Form.Item>

      <Form.Item label="Enable Secret" name="enable_secret">
        <Input.Password placeholder="(opsiyonel)" />
      </Form.Item>

      <Form.Item label="SSH Port" name="ssh_port">
        <InputNumber min={1} max={65535} style={{ width: '100%' }} />
      </Form.Item>

      <Divider orientation="left" plain style={{ fontSize: 12, opacity: 0.6 }}>SNMP</Divider>

      <Form.Item label="SNMP Aktif" name="snmp_enabled" valuePropName="checked">
        <Switch />
      </Form.Item>

      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.snmp_enabled !== cur.snmp_enabled || prev.snmp_version !== cur.snmp_version}
      >
        {({ getFieldValue }) => getFieldValue('snmp_enabled') && (
          <>
            <Form.Item label="Versiyon" name="snmp_version">
              <Select options={[
                { value: 'v1', label: 'SNMPv1' },
                { value: 'v2c', label: 'SNMPv2c' },
                { value: 'v3', label: 'SNMPv3 (USM)' },
              ]} />
            </Form.Item>
            <Form.Item label="SNMP Port" name="snmp_port">
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>

            {/* v1/v2c: community string */}
            {getFieldValue('snmp_version') !== 'v3' && (
              <Form.Item
                label="Community"
                name="snmp_community"
                rules={[{ required: getFieldValue('snmp_version') !== 'v3', message: 'Community gerekli' }]}
              >
                <Input placeholder="public" />
              </Form.Item>
            )}

            {/* v3 USM fields */}
            {getFieldValue('snmp_version') === 'v3' && (
              <>
                <Form.Item label="v3 Username" name="snmp_v3_username" rules={[{ required: true, message: 'Username gerekli' }]}>
                  <Input placeholder="snmpv3user" />
                </Form.Item>
                <Form.Item label="Auth Protokol" name="snmp_v3_auth_protocol">
                  <Select
                    placeholder="Yok (noAuth)"
                    allowClear
                    options={[
                      { value: 'md5', label: 'MD5' },
                      { value: 'sha1', label: 'SHA-1' },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(prev, cur) => prev.snmp_v3_auth_protocol !== cur.snmp_v3_auth_protocol}
                >
                  {({ getFieldValue: gfv }) => gfv('snmp_v3_auth_protocol') && (
                    <Form.Item label="Auth Parola" name="snmp_v3_auth_passphrase" rules={[{ min: 8, message: 'En az 8 karakter' }]}>
                      <Input.Password placeholder="min. 8 karakter" />
                    </Form.Item>
                  )}
                </Form.Item>
                <Form.Item label="Priv Protokol" name="snmp_v3_priv_protocol">
                  <Select
                    placeholder="Yok (noPriv)"
                    allowClear
                    options={[
                      { value: 'des', label: 'DES' },
                      { value: 'aes128', label: 'AES-128' },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  noStyle
                  shouldUpdate={(prev, cur) => prev.snmp_v3_priv_protocol !== cur.snmp_v3_priv_protocol}
                >
                  {({ getFieldValue: gfv }) => gfv('snmp_v3_priv_protocol') && (
                    <Form.Item label="Priv Parola" name="snmp_v3_priv_passphrase" rules={[{ min: 8, message: 'En az 8 karakter' }]}>
                      <Input.Password placeholder="min. 8 karakter" />
                    </Form.Item>
                  )}
                </Form.Item>
              </>
            )}
          </>
        )}
      </Form.Item>

      <Form.Item label="Açıklama" name="description">
        <Input.TextArea rows={2} />
      </Form.Item>

      <Form.Item>
        <Button type="primary" htmlType="submit" loading={mutation.isPending} block>
          {device ? 'Güncelle' : 'Ekle'}
        </Button>
      </Form.Item>
    </Form>
  )
}
