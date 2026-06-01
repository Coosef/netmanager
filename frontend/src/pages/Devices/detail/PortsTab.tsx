/**
 * T10 C7.C — Device Detail > Portlar / Arayüzler sekmesi (commit 2: read-only).
 *
 * Veri kaynakları:
 *   - port listesi + status/desc/VLAN: GET /devices/{id}/interfaces (canlı SSH, cache)
 *   - MAC count: GET /mac-arp/mac-table?device_id=N + client-side group/count
 *   - per-port override: GET /devices/{id}/port-policy-assignments (C7.A)
 *   - org port policies (effective resolver için): GET /security-policies/port (C6a)
 * Effective policy zinciri client-side: override → cihaz default → org default → fallback.
 *
 * Bu commit: tablo + read-only kolonlar. Toplu seçim/atama/override-kaldır (commit 3-4).
 */
import { useMemo, useState } from 'react'
import {
  Table, Tag, Badge, Button, Tooltip, Alert, Spin, Typography, message,
  Modal, Form, Input, InputNumber, Select,
} from 'antd'
import { ReloadOutlined, PoweroffOutlined, ApartmentOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Device, NetworkInterface } from '@/types'
import { devicesApi } from '@/api/devices'
import { macArpApi } from '@/api/macarp'
import { portPolicyAssignmentsApi } from '@/api/portPolicyAssignments'
import { securityPoliciesApi } from '@/api/securityPolicies'
import { useAuthStore } from '@/store/auth'
import { monitorApi, type NetworkEvent } from '@/api/monitor'
import {
  effectivePortPolicy, macCountByPort, MAC_COUNT_CAP, type EffectiveSource,
} from './_portsHelper'
import { parseVlanList, VlanListError } from './_vlanHelper'
import BulkPolicyAssignDrawer from './BulkPolicyAssignDrawer'
import BulkVlanAssignDrawer from './BulkVlanAssignDrawer'

const { Text } = Typography

const SOURCE_COLOR: Record<EffectiveSource, string> = {
  'override': 'green',
  'cihaz-default': 'default',
  'org-default': 'default',
  'fallback': 'red',
}

const SOURCE_LABEL: Record<EffectiveSource, string> = {
  'override': 'override',
  'cihaz-default': 'cihaz-default',
  'org-default': 'org-default',
  'fallback': 'fallback',
}

interface Row {
  key: string
  name: string
  description: string
  status: string
  vlan: string
  duplex: string
  speed: string
  macCount: number
  macCapped: boolean
  effective: ReturnType<typeof effectivePortPolicy>
  flapEvents: NetworkEvent[]
}

export default function PortsTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const dev = device as any
  const { isOrgAdmin } = useAuthStore()
  const canWrite = isOrgAdmin()
  const [selected, setSelected] = useState<string[]>([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkVlanOpen, setBulkVlanOpen] = useState(false)
  const [assignVlanIface, setAssignVlanIface] = useState<NetworkInterface | null>(null)
  const [assignVlanForm] = Form.useForm()

  const ifaceQ = useQuery({
    queryKey: ['device-interfaces', device.id],
    queryFn: () => devicesApi.getInterfaces(device.id),
    enabled: device.id > 0,
    staleTime: 30_000,
  })
  const macQ = useQuery({
    queryKey: ['mac-table-device', device.id],
    queryFn: () => macArpApi.getMacTable({ device_id: device.id, limit: MAC_COUNT_CAP }),
    enabled: device.id > 0,
    staleTime: 30_000,
  })
  const overridesQ = useQuery({
    queryKey: ['port-policy-assignments', device.id],
    queryFn: () => portPolicyAssignmentsApi.list(device.id),
    staleTime: 30_000,
  })
  const portPoliciesQ = useQuery({
    queryKey: ['secpol', 'port'],
    queryFn: () => securityPoliciesApi.list('port'),
    staleTime: 30_000,
  })
  // C7.C dry-run pill: bu cihazın son 24 saatlik mac_flap policy olayları.
  const flapQ = useQuery({
    queryKey: ['flap-events', device.id],
    queryFn: () => monitorApi.getEvents({
      device_id: device.id, event_type: 'mac_flap', hours: 24, limit: 50,
    }),
    staleTime: 60_000,
  })

  const macMap = useMemo(
    () => macCountByPort((macQ.data?.items ?? []) as { port?: string }[]),
    [macQ.data?.items],
  )

  // dry-run flap olaylarını port_name başına grupla (details.current_port).
  const flapByPort = useMemo(() => {
    const map = new Map<string, NetworkEvent[]>()
    for (const ev of flapQ.data?.items ?? []) {
      const det = (ev.details ?? {}) as Record<string, any>
      if (det.dry_run !== true) continue
      const port = typeof det.current_port === 'string' ? det.current_port : null
      if (!port) continue
      const arr = map.get(port) ?? []
      arr.push(ev)
      map.set(port, arr)
    }
    return map
  }, [flapQ.data?.items])

  // Hangi seçili port'larda override VAR (Override kaldır butonunun aktiflik kararı için).
  const overrideSet = useMemo(
    () => new Set((overridesQ.data ?? []).map((o) => o.port_name)),
    [overridesQ.data],
  )
  const selectedWithOverride = selected.filter((p) => overrideSet.has(p))

  const rows: Row[] = useMemo(() => {
    const ifaces: NetworkInterface[] = ifaceQ.data?.interfaces ?? []
    const overrides = overridesQ.data ?? []
    const portPolicies = (portPoliciesQ.data ?? []) as { id: number; name: string; is_default?: boolean }[]
    return ifaces.map((i) => {
      const mac = macMap.get(i.name) ?? { count: 0, isCapped: false }
      return {
        key: i.name,
        name: i.name,
        description: i.description || '',
        status: i.status || '',
        vlan: i.vlan || '',
        duplex: i.duplex || '',
        speed: i.speed || '',
        macCount: mac.count,
        macCapped: mac.isCapped,
        effective: effectivePortPolicy(i.name, overrides, dev.port_security_policy_id, portPolicies),
        flapEvents: flapByPort.get(i.name) ?? [],
      }
    })
  }, [ifaceQ.data?.interfaces, macMap, overridesQ.data, portPoliciesQ.data, dev.port_security_policy_id, flapByPort])

  const isLoading = ifaceQ.isLoading || overridesQ.isLoading || portPoliciesQ.isLoading
  const fetchSuccess = ifaceQ.data?.success !== false  // backend success flag
  const fetchError = ifaceQ.data?.error

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['device-interfaces', device.id] })
    qc.invalidateQueries({ queryKey: ['mac-table-device', device.id] })
    qc.invalidateQueries({ queryKey: ['port-policy-assignments', device.id] })
  }

  const bulkSetMut = useMutation({
    mutationFn: (policyId: number) =>
      portPolicyAssignmentsApi.bulkSet(
        device.id,
        selected.map((p) => ({ port_name: p, port_security_policy_id: policyId })),
      ),
    onSuccess: () => {
      message.success(`${selected.length} port güncellendi`)
      setBulkOpen(false)
      setSelected([])
      qc.invalidateQueries({ queryKey: ['port-policy-assignments', device.id] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Kaydedilemedi'),
  })

  const removeOverrideMut = useMutation({
    mutationFn: async () => {
      // Yalnız override'ı OLAN portları DELETE; atanmamışları atla. Paralel; 404'leri yut.
      const results = await Promise.allSettled(
        selectedWithOverride.map((p) =>
          portPolicyAssignmentsApi.remove(device.id, p),
        ),
      )
      const ok = results.filter((r) => r.status === 'fulfilled').length
      const fail = results.length - ok
      return { ok, fail }
    },
    onSuccess: ({ ok, fail }) => {
      if (fail > 0) message.warning(`${ok} override kaldırıldı, ${fail} başarısız`)
      else message.success(`${ok} override kaldırıldı`)
      setSelected([])
      qc.invalidateQueries({ queryKey: ['port-policy-assignments', device.id] })
    },
    onError: () => message.error('Override kaldırma başarısız'),
  })

  // Tek port VLAN ata (row aksiyon — hızlı yol). assignVlanIface state ile drive.
  // Backend (interfaces.py:832): vlan_id int | int[] (trunk allowed), mode, native_vlan_id?
  const assignVlanMut = useMutation({
    mutationFn: (vals: {
      vlan_id: number | number[]
      mode: 'access' | 'trunk'
      native_vlan_id?: number
    }) =>
      devicesApi.assignVlan(
        device.id, assignVlanIface!.name,
        vals.vlan_id, vals.mode, vals.native_vlan_id,
      ),
    onSuccess: (res) => {
      if (res.success) {
        message.success(`${assignVlanIface!.name} → VLAN ataması yapıldı`)
        setAssignVlanIface(null)
        assignVlanForm.resetFields()
        qc.invalidateQueries({ queryKey: ['device-interfaces', device.id] })
      } else {
        message.error(res.error || 'VLAN atanamadı')
      }
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'VLAN atanamadı'),
  })

  // Çoklu port toplu VLAN ata — Promise.allSettled (backend bulk endpoint yok).
  // Atomik DEĞİL: kısmen başarılı senaryo mümkün; rapor mesaj olarak gösterilir.
  const bulkAssignVlanMut = useMutation({
    mutationFn: async ({
      vlan_id, mode, native_vlan_id,
    }: {
      vlan_id: number | number[]
      mode: 'access' | 'trunk'
      native_vlan_id?: number
    }) => {
      const results = await Promise.allSettled(
        selected.map((p) =>
          devicesApi.assignVlan(device.id, p, vlan_id, mode, native_vlan_id),
        ),
      )
      const ok = results.filter(
        (r) => r.status === 'fulfilled' && (r.value as { success?: boolean }).success,
      ).length
      const fail = results.length - ok
      return { ok, fail }
    },
    onSuccess: ({ ok, fail }) => {
      if (fail > 0) message.warning(`${ok} port güncellendi, ${fail} başarısız`)
      else message.success(`${ok} port güncellendi`)
      setBulkVlanOpen(false)
      setSelected([])
      qc.invalidateQueries({ queryKey: ['device-interfaces', device.id] })
    },
    onError: () => message.error('Toplu VLAN ataması başarısız'),
  })

  /** Form'dan modal submit'i payload'a çevirir. parseVlanList hata atarsa Form
   *  setFields ile validation hatası gösterir. */
  const buildAssignPayload = (
    vals: {
      mode: 'access' | 'trunk'
      access_vlan_id?: number
      native_vlan_id?: number
      allowed_vlans?: string
    },
    form: typeof assignVlanForm,
  ): { vlan_id: number | number[]; mode: 'access' | 'trunk'; native_vlan_id?: number } | null => {
    if (vals.mode === 'access') {
      return { vlan_id: vals.access_vlan_id!, mode: 'access' }
    }
    // trunk
    try {
      const allowed = parseVlanList(vals.allowed_vlans || '')
      return {
        vlan_id: allowed,
        mode: 'trunk',
        ...(vals.native_vlan_id ? { native_vlan_id: vals.native_vlan_id } : {}),
      }
    } catch (e: any) {
      const msg = e instanceof VlanListError ? e.message : 'Allowed VLANs geçersiz'
      form.setFields([{ name: 'allowed_vlans', errors: [msg] }])
      return null
    }
  }

  const columns = [
    {
      title: 'Port', dataIndex: 'name', key: 'name', width: 180,
      render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code>,
    },
    { title: 'Açıklama', dataIndex: 'description', key: 'description', ellipsis: true },
    {
      title: 'Status', dataIndex: 'status', key: 'status', width: 120,
      render: (s: string) => {
        const up = /up|connected|forwarding/i.test(s)
        const down = /down|notconnect/i.test(s)
        return <Badge status={up ? 'success' : down ? 'error' : 'default'} text={s || '—'} />
      },
    },
    { title: 'VLAN', dataIndex: 'vlan', key: 'vlan', width: 90, render: (v: string) => v || '—' },
    {
      title: 'MAC', key: 'mac', width: 90,
      render: (_: any, r: Row) => {
        if (r.macCount === 0) return <span style={{ color: 'var(--fg-3,#64748b)' }}>0</span>
        const label = r.macCapped ? `${r.macCount}+` : `${r.macCount}`
        return <Tooltip title={`Bu portta ${label} MAC kaydı`}><span>{label}</span></Tooltip>
      },
    },
    {
      title: 'PoE', key: 'poe', width: 70,
      // C7.C v1: PoE federasyonu kapsam dışı (snapshot endpoint farklılıkları); kolon "—".
      render: () => <span style={{ color: 'var(--fg-3,#64748b)' }}>—</span>,
    },
    {
      title: 'Policy', key: 'policy', width: 220,
      render: (_: any, r: Row) => (
        <span>
          <span style={{ fontWeight: 500, marginRight: 6 }}>{r.effective.name}</span>
          <Tag color={SOURCE_COLOR[r.effective.source]} style={{ fontSize: 10 }}>
            {SOURCE_LABEL[r.effective.source]}
          </Tag>
        </span>
      ),
    },
    {
      title: '⚠', key: 'flap', width: 110,
      render: (_: any, r: Row) => {
        if (r.flapEvents.length === 0) return null
        const top = r.flapEvents[0]
        const det = (top.details ?? {}) as Record<string, any>
        const policy = typeof det.policy === 'string' ? det.policy : '?'
        const trans = typeof det.transitions === 'number' ? det.transitions : '?'
        return (
          <Tooltip title={`DRY-RUN öneri [policy=${policy}] · ${r.flapEvents.length} flap olayı (24sa), son: ${trans} port değişimi. Gerçek aksiyon UYGULANMADI (shutdown C5 ile gelecek).`}>
            <Tag color="orange" style={{ fontSize: 10 }}>
              DRY-RUN ({r.flapEvents.length})
            </Tag>
          </Tooltip>
        )
      },
    },
    // RBAC: canConnect gerekir; yoksa kolon hiç render edilmez (rows ekleme yok).
    ...(canWrite ? [{
      title: 'Aksiyon', key: 'rowAction', width: 110,
      render: (_: any, r: Row) => {
        const iface = (ifaceQ.data?.interfaces ?? []).find((i) => i.name === r.key)
        if (!iface) return null
        return (
          <Tooltip title="Bu porta VLAN ata (tek port hızlı yol)">
            <Button
              size="small" type="link"
              icon={<ApartmentOutlined />}
              onClick={() => setAssignVlanIface(iface)}
            >
              VLAN
            </Button>
          </Tooltip>
        )
      },
    }] : []),
  ]

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Text strong>Port listesi</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {ifaceQ.data?.cached ? 'cache (≤30s)' : ifaceQ.data?.fetched_at ? 'canlı' : ''}
        </Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={isLoading}>Yenile</Button>
        </div>
      </div>

      {!isLoading && !fetchSuccess && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message="Cihaz erişilemez (port listesi gelmedi)"
          description={
            <div style={{ fontSize: 12 }}>
              {fetchError || 'SSH/SNMP yanıt vermedi.'}{' '}
              Politika override'ları yine kaydedilebilir; cihaz erişilince effective değer
              uygulanır. Toplu işlemler (C7.C commit 3-4) yine açık olacak.
            </div>
          }
        />
      )}

      <Spin spinning={isLoading}>
        <Table
          size="small"
          rowKey="key"
          columns={columns as any}
          dataSource={rows}
          pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: fetchSuccess ? 'Port bulunamadı' : '—' }}
          rowSelection={canWrite ? {
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys as string[]),
            preserveSelectedRowKeys: false,
          } : undefined}
        />
      </Spin>

      {/* Sticky toolbar — yalnız org_admin+ ve seçim varsa görünür. */}
      {canWrite && selected.length > 0 && (
        <div style={{
          position: 'sticky', bottom: 8, marginTop: 12,
          padding: '8px 12px', background: 'var(--bg-2, #ffffff)',
          border: '1px solid var(--line-soft, #cbd5e1)', borderRadius: 8,
          display: 'flex', alignItems: 'center', gap: 12,
          boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
        }}>
          <Text strong>Seçili {selected.length} port</Text>
          <Button type="primary" onClick={() => setBulkOpen(true)}>Policy ata ▾</Button>
          <Button
            icon={<ApartmentOutlined />}
            onClick={() => setBulkVlanOpen(true)}
          >
            VLAN ata ▾
          </Button>
          <Tooltip title={
            selectedWithOverride.length === 0
              ? 'Seçili portların hiçbirinde override yok'
              : `${selectedWithOverride.length} portta override kaldırılacak (atanmamışlar atlanır)`
          }>
            <Button
              danger
              disabled={selectedWithOverride.length === 0}
              loading={removeOverrideMut.isPending}
              onClick={() => removeOverrideMut.mutate()}
            >
              Override kaldır
              {selectedWithOverride.length > 0 && ` (${selectedWithOverride.length})`}
            </Button>
          </Tooltip>
          <Tooltip title="Gerçek port kapatma C5 (approval + kill-switch) ile gelecek">
            <Button icon={<PoweroffOutlined />} disabled>Shutdown</Button>
          </Tooltip>
          <Button type="text" onClick={() => setSelected([])} style={{ marginLeft: 'auto' }}>Seçimi temizle</Button>
        </div>
      )}

      {!canWrite && (
        <Alert
          type="info" showIcon style={{ marginTop: 12, fontSize: 12 }}
          message="Salt-okunur görünüm. Toplu atama ve override kaldırma için org_admin+ rolü gerekir."
        />
      )}

      <BulkPolicyAssignDrawer
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        selectedPorts={selected}
        portPolicies={(portPoliciesQ.data ?? []) as any}
        saving={bulkSetMut.isPending}
        onSubmit={(policyId) => bulkSetMut.mutate(policyId)}
      />

      <BulkVlanAssignDrawer
        open={bulkVlanOpen}
        onClose={() => setBulkVlanOpen(false)}
        selectedPorts={selected}
        saving={bulkAssignVlanMut.isPending}
        onSubmit={(vlan_id, mode, native_vlan_id) =>
          bulkAssignVlanMut.mutate({ vlan_id, mode, native_vlan_id })}
      />

      {/* Tek port VLAN ata (hızlı yol — row aksiyonundan açılır) */}
      <Modal
        open={!!assignVlanIface}
        title={assignVlanIface ? `${assignVlanIface.name} → VLAN ata` : ''}
        onCancel={() => { setAssignVlanIface(null); assignVlanForm.resetFields() }}
        onOk={() => assignVlanForm.submit()}
        confirmLoading={assignVlanMut.isPending}
        okText="Ata" cancelText="İptal"
        destroyOnHidden
        width={520}
      >
        <Form
          form={assignVlanForm} layout="vertical"
          initialValues={{ mode: 'access' }}
          onFinish={(vals) => {
            const payload = buildAssignPayload(vals, assignVlanForm)
            if (payload) assignVlanMut.mutate(payload)
          }}
        >
          <Form.Item
            name="mode" label="Mod"
            rules={[{ required: true, message: 'Mod seçin' }]}
          >
            <Select
              options={[
                { label: 'Access (tek VLAN üyesi)', value: 'access' },
                { label: 'Trunk (çoklu VLAN taşır)', value: 'trunk' },
              ]}
            />
          </Form.Item>

          {/* Mode'a göre alanlar — Form.Item shouldUpdate ile dinamik render. */}
          <Form.Item shouldUpdate={(p, c) => p.mode !== c.mode} noStyle>
            {({ getFieldValue }) => {
              const mode = getFieldValue('mode') as 'access' | 'trunk'
              if (mode === 'access') {
                return (
                  <Form.Item
                    name="access_vlan_id" label="Access VLAN ID"
                    rules={[
                      { required: true, message: 'Access VLAN ID zorunlu' },
                      { type: 'number', min: 1, max: 4094, message: '1 ile 4094 arası' },
                    ]}
                  >
                    <InputNumber style={{ width: '100%' }} placeholder="ör. 100" min={1} max={4094} />
                  </Form.Item>
                )
              }
              // trunk
              return (
                <>
                  <Form.Item
                    name="native_vlan_id" label="Native VLAN ID (opsiyonel)"
                    rules={[{ type: 'number', min: 1, max: 4094, message: '1 ile 4094 arası' }]}
                    extra="Boş bırakılırsa vendor varsayılanı uygulanır (Cisco/Ruijie: 1)."
                  >
                    <InputNumber style={{ width: '100%' }} placeholder="ör. 1" min={1} max={4094} />
                  </Form.Item>
                  <Form.Item
                    name="allowed_vlans" label="Allowed VLANs"
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
      </Modal>
    </div>
  )
}
