import { Alert, App, Button, Divider, Form, Input, InputNumber, Select, Switch, Tag, Tooltip } from 'antd'
import { SafetyCertificateOutlined, WarningOutlined, SafetyOutlined } from '@ant-design/icons'  // SafetyOutlined hâlâ "Kimlik Profili" başlığında kullanılıyor
import { RobotOutlined } from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import { agentsApi } from '@/api/agents'
import { credentialProfilesApi } from '@/api/credentialProfiles'
import { locationsApi } from '@/api/locations'
import { formatApiError } from '@/api/_errors'
import { useSite } from '@/contexts/SiteContext'
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
  // Incident HF#5 (2026-06-02) — Cihaz CREATE'te backend require_active_location
  // X-Location-Id header'ına bakar. Drawer'da seçilen lokasyon adından id türetip
  // mutation'da PER-REQUEST header override olarak gönderiyoruz; global SiteContext
  // submit ÖNCESİ değiştirilmez (setLocation → queryClient.clear → drawer içindeki
  // agents/credProfiles/locations dropdown'larında loading flash riski).
  // POST başarılı olduktan SONRA (drawer kapanınca) opsiyonel olarak setLocation
  // çağrılır → kullanıcı yeni cihazı listede görür.
  const { setLocation, activeLocationId } = useSite()

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

  // T10 C7.B — Güvenlik politikası atama bölümü Drawer'dan çıkarıldı; yeni evi
  // Device Detail > Güvenlik Politikası sekmesi (/devices/:id?tab=security).
  // Bu Drawer "hızlı düzenle" + "yeni cihaz" olarak kalır.

  const agentOptions = [
    { label: t('devices.form.agent_none'), value: '' },
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

  // Incident HF#8 (2026-06-03) — Kimlik profili seçiliyse SSH/SNMP credential
  // alanlari opsiyonel fallback/override gibi davranir (backend SSH manager
  // _load_profile ile profili yukler, device alanlari ikincil kalir). Form
  // validation reactive okumalidir; aksi halde kullanici "Profil seçtim ama
  // SSH Kullanicisi gerekli" hatasi alir.
  const watchedCredentialProfileId = Form.useWatch('credential_profile_id', form)
  const hasCredentialProfile = watchedCredentialProfileId != null

  const mutation = useMutation({
    mutationFn: (values: Record<string, unknown>) => {
      const payload = { ...values }
      if (payload.agent_id === '') payload.agent_id = null
      if (payload.layer === '') payload.layer = null
      if (payload.site === '') payload.site = null
      if (payload.building === '') payload.building = null
      if (payload.floor === '') payload.floor = null

      // Incident HF#9 (2026-06-03) — Kimlik profili seçiliyse HF#8 SSH alanlarını
      // opsiyonel yaptı, kullanıcı boş bırakırsa AntD form `undefined` döndürür
      // → JSON.stringify alan düşürür → backend DeviceCreate `ssh_username: str`
      // missing field → Pydantic 422 (HF#8 sonrası prod crash kaynağı).
      // Backend mevcut sözleşmesi bozulmasın diye empty string fallback.
      // SSH manager runtime'da _load_profile ile profili önceleyip device
      // alanlarını ikincil kullanır; boş string fonksiyonel olarak güvenli.
      payload.ssh_username = typeof values.ssh_username === 'string' ? values.ssh_username : ''
      payload.ssh_password = typeof values.ssh_password === 'string' ? values.ssh_password : ''
      // T10 C7.B — security_policy_id / port_security_policy_id alanları artık
      // Drawer'dan gönderilmez (atama Detail > Güvenlik Politikası sekmesinde).

      // Incident HF#6 (2026-06-02) — Lokasyon form alanı artık `location_id`
      // (number). Backend body'de location_id ALANI YOK (DeviceCreate schema
      // sadece `site` Optional[str] kabul eder), bu yüzden payload'dan
      // location_id silinir ve label olarak `site = matched.name` set edilir.
      // X-Location-Id header'ı doğrudan location_id'den türetilir — name
      // eşleştirme race'i tamamen ortadan kalkar.
      const locationId = typeof values.location_id === 'number' ? values.location_id : undefined
      const matched = locationId != null
        ? (locationsData?.items ?? []).find((l) => l.id === locationId)
        : undefined
      // Body cleanup: backend body'den location_id okumaz; geri uyumluluk için
      // site label olarak gönder (UI'da görünür ad).
      delete payload.location_id
      if (matched) payload.site = matched.name

      if (device) {
        return devicesApi.update(device.id, payload)
      }
      const headers = locationId != null
        ? { 'X-Location-Id': String(locationId) }
        : undefined
      return devicesApi.create(payload, headers ? { headers } : undefined)
    },
    onSuccess: (_data, values) => {
      message.success(t('common.success'))
      // Parent callback önce çalışsın — drawer kapansın, devices listesi
      // invalidate edilsin. ANCAK sırasıyla sync execution: setLocation
      // çağrısı queryClient.clear yapar → drawer zaten kapalı olduğu için
      // UX bozulmaz; list refetch yeni active location header'ı ile yapılır
      // → yeni cihaz görünür.
      onSuccess()
      if (device) return  // update akışında lokasyon zaten değişmez
      // HF#6 — id-tabanlı; name eşleştirmesi yok
      const locationId = typeof values.location_id === 'number' ? values.location_id : undefined
      if (locationId != null && locationId !== activeLocationId) {
        setLocation(locationId)
      }
    },
    onError: (err: any) => {
      // HF#9 — Pydantic v2 422 detail array'i React render'inde object child
      // olarak gecince "Minified React error #31" tetikleniyordu. formatApiError
      // detail'i her formatta string'e normalize eder.
      message.error(formatApiError(err, t('common.error')))
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
        // HF#6 — edit mode'da Select disabled, ama görsel olarak seçili lokasyonu
        // göstermek için device.site adından id türetilir. Lokasyon değişimi
        // "Lokasyona Taşı" endpoint'inden yapılır; bu davranış değişmez.
        location_id: device.site
          ? (locationsData?.items ?? []).find((l) => l.name === device.site)?.id
          : undefined,
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
      <Form.Item label={t('devices.form.device_type')} name="device_type" rules={[{ required: true }]}>
        <Select options={DEVICE_TYPE_OPTIONS} />
      </Form.Item>

      <Form.Item
        label={t('devices.form.hostname')}
        name="hostname"
        tooltip={t('devices.form.hostname_tooltip')}
      >
        <Input placeholder={t('devices.form.hostname_placeholder')} />
      </Form.Item>

      <Form.Item label={t('devices.form.alias')} name="alias" tooltip={t('devices.form.alias_tooltip')}>
        <Input placeholder={t('devices.form.alias_placeholder')} />
      </Form.Item>

      <Form.Item label={t('devices.form.ip_address')} name="ip_address" rules={[{ required: !device, message: t('common.validation.required') }]}>
        <Input placeholder="192.168.1.1" disabled={!!device} />
      </Form.Item>

      <Form.Item label={t('devices.form.vendor')} name="vendor" rules={[{ required: true }]}>
        <Select options={VENDOR_OPTIONS} />
      </Form.Item>

      <Form.Item label={t('devices.form.os_type')} name="os_type" rules={[{ required: true }]}>
        <Select options={filteredOsOptions} showSearch />
      </Form.Item>

      <Form.Item label={t('devices.form.model')} name="model">
        <Input placeholder="Catalyst 2960" />
      </Form.Item>

      <Form.Item label={t('devices.form.layer')} name="layer" tooltip={t('devices.form.layer_tooltip')}>
        <Select allowClear placeholder={t('devices.form.layer_placeholder')} options={[
          { label: 'Core', value: 'core' },
          { label: 'Distribution', value: 'distribution' },
          { label: 'Access', value: 'access' },
          { label: 'Edge', value: 'edge' },
          { label: 'Wireless', value: 'wireless' },
        ]} />
      </Form.Item>

      <Form.Item label={t('devices.form.location')} name="location">
        <Input placeholder={t('devices.form.location_placeholder')} />
      </Form.Item>

      {/* Faz 8 Phase G — device location ownership is immutable through
          the edit form. When editing an existing device the location is
          read-only; it changes ONLY through the audited "Lokasyona Taşı"
          (move) action. On create, the device is placed in the active
          location (the header location selector). */}
      {/* HF#6 — Lokasyon Form alanı artık `location_id` (number). Select value=l.id;
          name eşleştirmesi yok → unicode/whitespace race riski sıfır. Submit'te
          mutationFn doğrudan id'den X-Location-Id türetir + body'ye `site` label
          olarak gönderir (DeviceCreate schema `site: Optional[str]`). */}
      <Form.Item
        label={t('devices.form.org_location')}
        name="location_id"
        tooltip={device
          ? t('devices.form.org_location_tooltip_edit')
          : t('devices.form.org_location_tooltip_new')}
      >
        <Select
          allowClear
          disabled={!!device}
          placeholder={t('devices.form.org_location_placeholder')}
          options={[
            ...(locationsData?.items ?? []).map((l) => ({
              value: l.id,
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

      <Form.Item label={t('devices.form.building')} name="building">
        <Input placeholder={t('devices.form.building_placeholder')} />
      </Form.Item>

      <Form.Item label={t('devices.form.floor')} name="floor">
        <Input placeholder={t('devices.form.floor_placeholder')} />
      </Form.Item>

      <Form.Item label={t('devices.form.tags')} name="tags">
        <Input placeholder="core,vlan10,building-a" />
      </Form.Item>

      <Form.Item
        label={
          <Tooltip title={t('devices.form.readonly_tooltip')}>
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
          <Tooltip title={t('devices.form.approval_tooltip')}>
            {t('devices.form.approval_label')}
          </Tooltip>
        }
        name="approval_required"
        valuePropName="checked"
      >
        <Switch
          checkedChildren={t('devices.form.approval_on')}
          unCheckedChildren={t('devices.form.approval_off')}
        />
      </Form.Item>

      {/* T10 C7.B — Güvenlik politikası bölümü buradan çıkarıldı; yeni evi:
          Device Detail > Güvenlik Politikası sekmesi (/devices/:id?tab=security). */}

      <Divider style={{ margin: '12px 0', fontSize: 12 }}>{t('devices.form.ssh_divider')}</Divider>

      <Form.Item
        label={<span><SafetyOutlined style={{ marginRight: 4 }} />{t('devices.form.cred_profile_label')}</span>}
        name="credential_profile_id"
        tooltip={t('devices.form.cred_profile_tooltip')}
      >
        <Select
          allowClear
          placeholder={t('devices.form.cred_profile_placeholder')}
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
            message={t('devices.form.cred_profile_alert')}
          />
        )}
      </Form.Item>

      <Form.Item
        label={t('devices.form.agent_label')}
        name="agent_id"
        tooltip={t('devices.form.agent_tooltip')}
      >
        <Select options={agentOptions} />
      </Form.Item>

      <Form.Item
        label={t('devices.form.fallback_agents_label')}
        name="fallback_agent_ids"
        tooltip={t('devices.form.fallback_agents_tooltip')}
      >
        <Select
          mode="multiple"
          allowClear
          placeholder={t('devices.form.fallback_agents_placeholder')}
          options={fallbackAgentOptions}
        />
      </Form.Item>

      {/* HF#8 — Kimlik profili seçiliyse required kalkar; alan opsiyonel
          override olarak kullanılır. Label'a "(opsiyonel)" + placeholder net. */}
      <Form.Item
        label={<span>{t('devices.form.ssh_username')} {hasCredentialProfile && <span style={{ color: 'var(--fg-3,#94a3b8)', fontSize: 11, fontWeight: 400 }}>{t('devices.form.optional_profile_used')}</span>}</span>}
        name="ssh_username"
        rules={[{ required: !hasCredentialProfile, message: t('common.validation.ssh_username_required') }]}
      >
        <Input placeholder={hasCredentialProfile ? t('devices.form.placeholder_profile_override') : 'admin'} />
      </Form.Item>

      <Form.Item
        label={<span>{t('devices.form.ssh_password')} {hasCredentialProfile && <span style={{ color: 'var(--fg-3,#94a3b8)', fontSize: 11, fontWeight: 400 }}>{t('devices.form.optional_profile_used')}</span>}</span>}
        name="ssh_password"
        rules={[{ required: !device && !hasCredentialProfile, message: t('common.validation.password_required') }]}
      >
        <Input.Password placeholder={
          hasCredentialProfile
            ? t('devices.form.placeholder_profile_override')
            : (device ? t('devices.form.placeholder_change_password') : '')
        } />
      </Form.Item>

      <Form.Item label={t('devices.form.enable_secret')} name="enable_secret">
        <Input.Password placeholder={hasCredentialProfile ? t('devices.form.placeholder_profile_override_optional') : t('devices.form.placeholder_optional')} />
      </Form.Item>

      <Form.Item label={t('devices.form.ssh_port')} name="ssh_port">
        <InputNumber min={1} max={65535} style={{ width: '100%' }} />
      </Form.Item>

      <Divider orientation="left" plain style={{ fontSize: 12, opacity: 0.6 }}>SNMP</Divider>

      <Form.Item label={t('devices.form.snmp_enabled')} name="snmp_enabled" valuePropName="checked">
        <Switch />
      </Form.Item>

      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.snmp_enabled !== cur.snmp_enabled || prev.snmp_version !== cur.snmp_version}
      >
        {({ getFieldValue }) => getFieldValue('snmp_enabled') && (
          <>
            <Form.Item label={t('devices.form.snmp_version')} name="snmp_version">
              <Select options={[
                { value: 'v1', label: 'SNMPv1' },
                { value: 'v2c', label: 'SNMPv2c' },
                { value: 'v3', label: 'SNMPv3 (USM)' },
              ]} />
            </Form.Item>
            <Form.Item label={t('devices.form.snmp_port')} name="snmp_port">
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>

            {/* v1/v2c: community string — HF#8: profil seçiliyse opsiyonel */}
            {getFieldValue('snmp_version') !== 'v3' && (
              <Form.Item
                label={<span>{t('devices.form.community')} {hasCredentialProfile && <span style={{ color: 'var(--fg-3,#94a3b8)', fontSize: 11, fontWeight: 400 }}>{t('devices.form.optional_profile_used')}</span>}</span>}
                name="snmp_community"
                rules={[{ required: !hasCredentialProfile && getFieldValue('snmp_version') !== 'v3', message: t('common.validation.community_required') }]}
              >
                <Input placeholder={hasCredentialProfile ? t('devices.form.placeholder_profile_override') : 'public'} />
              </Form.Item>
            )}

            {/* v3 USM fields — HF#8: profil seçiliyse v3 username opsiyonel */}
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
                  <Select
                    placeholder={t('devices.form.snmp_v3_auth_none')}
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
                    <Form.Item label={t('devices.form.snmp_v3_auth_passphrase')} name="snmp_v3_auth_passphrase" rules={[{ min: 8, message: t('common.validation.min8') }]}>
                      <Input.Password placeholder={t('devices.form.placeholder_min8')} />
                    </Form.Item>
                  )}
                </Form.Item>
                <Form.Item label={t('devices.form.snmp_v3_priv_protocol')} name="snmp_v3_priv_protocol">
                  <Select
                    placeholder={t('devices.form.snmp_v3_priv_none')}
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
                    <Form.Item label={t('devices.form.snmp_v3_priv_passphrase')} name="snmp_v3_priv_passphrase" rules={[{ min: 8, message: t('common.validation.min8') }]}>
                      <Input.Password placeholder={t('devices.form.placeholder_min8')} />
                    </Form.Item>
                  )}
                </Form.Item>
              </>
            )}
          </>
        )}
      </Form.Item>

      <Form.Item label={t('devices.form.description')} name="description">
        <Input.TextArea rows={2} />
      </Form.Item>

      <Form.Item>
        <Button type="primary" htmlType="submit" loading={mutation.isPending} block>
          {device ? t('devices.form.submit_update') : t('devices.form.submit_add')}
        </Button>
      </Form.Item>
    </Form>
  )
}
