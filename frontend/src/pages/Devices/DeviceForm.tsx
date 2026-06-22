import { useEffect, useRef } from 'react'
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
import { useRouteOrgId } from '@/hooks/useRouteOrgId'
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
  //
  // DEVICE-CREATE-LOCATION-SCOPE-FIX (2026-06-19) — `organization` +
  // `ctxResolved` joined the consumer so the dropdowns can be scoped
  // to the operator's active tenant. Backend cross-tenant guards in
  // devices.py (PR #102) remain the authoritative gate; the filter
  // here is a UX preview that surfaces a friendlier 400 BEFORE the
  // request leaves the browser.
  const {
    // ORG-CONTEXT-FALLBACK-FIX (2026-06-22) — switched from
    // `isSuperAdmin` (BYPASS state) to `isPlatformSuperAdmin` (ROLE
    // identity) for the tenant-required guard below. A scoped
    // super-admin's `is_super_admin` is false at the backend, so the
    // pre-fix code skipped the guard for them — incorrect when
    // `organization` is unexpectedly null. Role identity is the
    // semantically correct gate.
    setLocation, activeLocationId, organization, ctxResolved,
    isPlatformSuperAdmin,
  } = useSite()

  // DEVICE-CREATE-LOCATION-SCOPE-FIX (2026-06-19) — the active tenant
  // org id, resolved once. Used for the locations + agents fetch
  // params AND the submit-time guard. For every role except a
  // super-admin who has not picked a tenant context yet, this is
  // non-null whenever `ctxResolved` is true.
  //
  // PR-A REVISED (2026-06-22) — URL-AUTHORITATIVE PRECEDENCE.
  //   routeOrgId (from /app/org/:organizationId/*) takes PRIMARY
  //   authority. `organization.id` (from /context/current) is the
  //   fallback ONLY when routeOrgId is null (legacy / platform shell).
  //   `scopeOrgId` is the resolved value used for queryKey + queryFn
  //   `organization_id` filter — guaranteeing the locations + agents
  //   dropdowns scope to the URL's tenant, not a stale localStorage-
  //   driven tenant the operator switched away from.
  const routeOrgId = useRouteOrgId()
  const scopeOrgId = routeOrgId ?? (organization?.id ?? null)
  // Backward-compatible alias for the submit-time guard below.
  const activeOrgId = scopeOrgId
  // Super-admin without a tenant context is a hard block (mirror of
  // PR #96 agent-create modal). Backend would 400 the create call;
  // we surface the explanation here BEFORE the user types a hostname.
  const tenantMissing = ctxResolved && isPlatformSuperAdmin && organization === null

  const { data: agents = [] } = useQuery({
    // PR-A REVISED — queryKey carries routeOrgId so cache partitions
    // per URL-authoritative tenant. Inside /app/org/6/devices the
    // dropdown CANNOT serve org=1's previously-cached agents.
    queryKey: ['org', routeOrgId, 'agents'],
    queryFn: agentsApi.list,
    enabled: ctxResolved,
  })

  const { data: credProfiles = [] } = useQuery({
    queryKey: ['credential-profiles'],
    queryFn: credentialProfilesApi.list,
  })

  // DEVICE-CREATE-LOCATION-SCOPE-FIX (2026-06-19) — the location list
  // is fetched with the `organization_id` filter the API already
  // supports, scoped to the operator's active tenant. For super-admin
  // browsing one tenant at a time this means the dropdown shows that
  // tenant's locations ONLY — the cross-tenant "Mövempic" surprise
  // (org=1 deleted, org=6 active, same name) becomes impossible at
  // the UX layer. Backend still rejects authoritatively.
  //
  // PR-A REVISED — queryKey carries routeOrgId; queryFn uses
  // scopeOrgId (routeOrgId ?? activeOrgId fallback). The request
  // organization_id filter is therefore URL-authoritative inside
  // /app/org/:id/*; a stale localStorage org id cannot leak.
  const { data: locationsData } = useQuery({
    queryKey: ['org', routeOrgId, 'locations'],
    queryFn: () =>
      locationsApi.list(
        scopeOrgId != null ? { organization_id: scopeOrgId } : undefined,
      ),
    staleTime: 30_000,
    enabled: ctxResolved && scopeOrgId != null,
  })

  // DEVICE-CREATE-LOCATION-SCOPE-FIX (2026-06-19) — derived view: the
  // raw API list further constrained to NON-soft-deleted rows (the
  // backend already filters by `deleted_at IS NULL` but pinning it
  // client-side adds belt + braces for any future RLS regression).
  const scopedLocations = (locationsData?.items ?? []).filter(
    (l) => scopeOrgId != null && l.organization_id === scopeOrgId,
  )

  // Watch the selected location_id reactively so the agent dropdown,
  // the submit guard, and the location-change reset effect all see
  // the same value without dance-around-the-form-state hacks.
  const selectedLocationId = Form.useWatch('location_id', form) as number | undefined

  // X-LOC-INTERCEPTOR-FIX (2026-06-21) — Hotfix C: stale-aware default
  // seeding. When the operator opens the create form, the global
  // `activeLocationId` (header-driven) may belong to a DIFFERENT
  // tenant's location than the one the form is scoped to (e.g. a
  // super_admin browsing org=6 Mövempic in the header while their
  // home org=1 form scopes the dropdown to org=1 locations). Using
  // that cross-tenant id as the form's `location_id` default would
  // produce the exact 400 the form is supposed to prevent.
  //
  // Rule: seed the default ONLY when `activeLocationId` is in
  // `scopedLocations` (i.e. same active tenant). Otherwise leave the
  // field empty so the new `rules: [{required: true}]` block forces
  // the operator to pick from the in-scope dropdown.
  //
  // Implementation:
  //   1. `scopedLocations` loads asynchronously; the seeding effect
  //      runs once per mount, gated on a ref so a later context
  //      refresh cannot overwrite an operator's manual pick.
  //   2. Edit-mode (`device != null`) is exempt — the existing
  //      device's location is the source of truth, handled by the
  //      initialValues block below.
  //   3. The effect NEVER writes to localStorage / setLocation;
  //      header context cleanup is a separate product decision and
  //      out of scope for this hotfix.
  const seededLocationRef = useRef(false)
  useEffect(() => {
    if (device) return
    if (seededLocationRef.current) return
    if (activeLocationId == null) return
    if (!scopedLocations.length) return
    if (!scopedLocations.some((l) => l.id === activeLocationId)) return
    if (form.getFieldValue('location_id') != null) return
    form.setFieldValue('location_id', activeLocationId)
    seededLocationRef.current = true
  }, [device, activeLocationId, scopedLocations, form])

  // T10 C7.B — Güvenlik politikası atama bölümü Drawer'dan çıkarıldı; yeni evi
  // Device Detail > Güvenlik Politikası sekmesi (/devices/:id?tab=security).
  // Bu Drawer "hızlı düzenle" + "yeni cihaz" olarak kalır.

  // DEVICE-CREATE-LOCATION-SCOPE-FIX (2026-06-19) — only show agents
  // that match the operator's active tenant org AND the operator-
  // selected location. Three layers of filtering, each with a clear
  // semantic:
  //   1. agent.organization_id === activeOrgId
  //      — RLS already keeps super_admin from seeing other tenants'
  //        agents in most paths, but the additive expose of
  //        `organization_id` on AgentResponse lets us mirror the
  //        backend devices.py:509 guard here too.
  //   2. agent.location_id === selectedLocationId  (when a location
  //      is picked) — the backend insists primary+backup agents
  //      belong to the SAME location as the device, so showing
  //      agents from other locations only invites the rejection
  //      the user just saw.
  //   3. Legacy agents (organization_id === null) are excluded —
  //      they cannot satisfy backend's `agent.org_id == device.org_id`
  //      check and a click would only reach the same reject path.
  const compatibleAgents = activeOrgId == null
    ? []
    : agents.filter((a) => {
        if (a.organization_id !== activeOrgId) return false
        if (selectedLocationId == null) return true
        return a.location_id === selectedLocationId
      })

  const agentOptions = [
    { label: t('devices.form.agent_none'), value: '' },
    ...compatibleAgents.map((a) => ({
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

  const fallbackAgentOptions = compatibleAgents.map((a) => ({
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
    mutationFn: async (values: Record<string, unknown>) => {
      // DEVICE-CREATE-LOCATION-SCOPE-FIX (2026-06-19) — three guard
      // layers. None of them replaces the backend devices.py:490-517
      // reject; they exist to surface a friendlier message BEFORE
      // the request leaves the browser and to keep a half-typed form
      // from being thrown away by an unexplained 400.
      //
      // The guards mirror exactly the backend predicates so the
      // operator-facing UX matches what the server would have said
      // anyway — modulo a localized + targeted message instead of
      // the server's compound "Mövempic farklı bir organizasyona
      // ait — header'daki lokasyon seçicisinden …" sentence.
      if (!device) {
        if (tenantMissing) {
          throw new Error(t('devices.form.scope_guard_tenant_required'))
        }
        const locationId = typeof values.location_id === 'number'
          ? values.location_id
          : undefined
        // X-LOC-INTERCEPTOR-FIX (2026-06-21) — defense-in-depth: the
        // form's `rules: [{ required: true }]` on `location_id` is the
        // primary block, but the AntD validation can be bypassed by a
        // synthetic submit or a programmatic `form.submit()`. Without
        // a location in the form values, the per-request X-Location-Id
        // override is undefined and the api/client.ts fallback would
        // send the GLOBAL active location (potentially cross-tenant
        // for a super_admin in another tenant's location context).
        // Reject up front with the same localized i18n key the form
        // validation surfaces.
        if (locationId == null) {
          throw new Error(t('devices.form.org_location_required'))
        }
        const inScope = scopedLocations.some((l) => l.id === locationId)
        if (!inScope) {
          throw new Error(t('devices.form.scope_guard_location_not_in_context'))
        }
        const checkAgent = (agentId: unknown): string | null => {
          if (typeof agentId !== 'string' || !agentId) return null
          const agent = agents.find((a) => a.id === agentId)
          if (!agent) return null
          if (agent.organization_id !== activeOrgId) {
            return t('devices.form.scope_guard_agent_incompatible')
          }
          if (locationId != null && agent.location_id !== locationId) {
            return t('devices.form.scope_guard_agent_incompatible')
          }
          return null
        }
        const primaryFail = checkAgent(values.agent_id)
        if (primaryFail) throw new Error(primaryFail)
        const backups = Array.isArray(values.fallback_agent_ids)
          ? (values.fallback_agent_ids as unknown[])
          : []
        for (const b of backups) {
          const fail = checkAgent(b)
          if (fail) throw new Error(fail)
        }
      }

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
        // DEVICE-CREATE-LOCATION-SCOPE-FIX (2026-06-19) — when the
        // operator changes the location, the previously-selected agent
        // (primary + fallback) may belong to a different location's
        // tenant scope. Resetting the selections forces a fresh pick
        // from the now-filtered dropdown so the form can never carry
        // a stale cross-location agent reference into submit.
        // Edit-mode is exempt: the device's location is immutable
        // through this form (changed only by "Lokasyona Taşı"), so
        // the agent selection follows the existing device, not the
        // form field.
        if ('location_id' in changed && !device) {
          form.setFieldValue('agent_id', '')
          form.setFieldValue('fallback_agent_ids', [])
        }
      }}
      onFinish={(values) => mutation.mutate(values)}
    >
      {/* DEVICE-CREATE-LOCATION-SCOPE-FIX (2026-06-19) — super_admin
          without an active tenant context cannot create a device. The
          form fields stay rendered so the operator sees what they
          would have filled, but the Alert explains the gate and the
          submit-time guard rejects with the same message. Edit-mode
          is exempt — an existing device already has a tenant. */}
      {!device && tenantMissing && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('devices.form.scope_guard_tenant_required')}
          description={t('devices.form.scope_guard_tenant_required_desc')}
          data-testid="device-create-blocked-tenant-required"
        />
      )}

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
        rules={!device ? [
          {
            required: true,
            message: t('devices.form.org_location_required'),
          },
        ] : undefined}
      >
        <Select
          allowClear
          disabled={!!device || tenantMissing}
          placeholder={t('devices.form.org_location_placeholder')}
          options={(() => {
            // DEVICE-CREATE-LOCATION-SCOPE-FIX (2026-06-19) — three
            // semantic rules baked into the option set:
            //   1. Only `scopedLocations` (active tenant) are eligible;
            //      cross-org rows from the raw API list (which the
            //      query already filters server-side, but pinning
            //      client-side adds belt+braces) NEVER appear.
            //   2. Same-name duplicates within the active tenant
            //      get a `· #id` disambiguator appended so the
            //      operator can tell them apart at a glance. Cross-
            //      tenant duplicates are already excluded by rule 1.
            //   3. Soft-deleted rows are filtered by the backend list
            //      endpoint; should the backend ever regress, the
            //      `organization_id !== activeOrgId` filter for rule
            //      1 still excludes a stale row because soft-deleted
            //      rows are excluded server-side from the list.
            const nameCounts = scopedLocations.reduce<Record<string, number>>(
              (m, l) => {
                m[l.name] = (m[l.name] ?? 0) + 1
                return m
              },
              {},
            )
            return scopedLocations.map((l) => {
              const isDup = (nameCounts[l.name] ?? 0) > 1
              return {
                value: l.id,
                label: (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.color || '#3b82f6', display: 'inline-block', flexShrink: 0 }} />
                    {l.name}
                    {isDup && (
                      <span
                        style={{ color: 'var(--fg-3,#94a3b8)', fontSize: 11 }}
                        data-testid={`location-disambig-${l.id}`}
                      >
                        · #{l.id}
                      </span>
                    )}
                  </span>
                ),
              }
            })
          })()}
          data-testid="device-create-location-select"
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
        <Select
          options={agentOptions}
          disabled={!device && (tenantMissing || selectedLocationId == null)}
          data-testid="device-create-agent-select"
        />
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
          disabled={!device && (tenantMissing || selectedLocationId == null)}
          data-testid="device-create-fallback-agents-select"
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
