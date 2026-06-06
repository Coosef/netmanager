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
  Modal, Form, Input, InputNumber, Select, Popconfirm, App,
} from 'antd'
import {
  ReloadOutlined, PoweroffOutlined, ApartmentOutlined, ThunderboltOutlined,
  ReloadOutlined as RestartOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Device, NetworkInterface } from '@/types'
import { devicesApi } from '@/api/devices'
import { macArpApi } from '@/api/macarp'
import { portPolicyAssignmentsApi } from '@/api/portPolicyAssignments'
import { securityPoliciesApi } from '@/api/securityPolicies'
import { poeApi } from '@/api/poe'
import { portControlApi, type BulkPoeResult } from '@/api/portControl'
import { useAuthStore } from '@/store/auth'
import { monitorApi, type NetworkEvent } from '@/api/monitor'
import {
  effectivePortPolicy, macCountByPort, MAC_COUNT_CAP, type EffectiveSource,
} from './_portsHelper'
import { parseVlanList, VlanListError } from './_vlanHelper'
import BulkPolicyAssignDrawer from './BulkPolicyAssignDrawer'
import BulkVlanAssignDrawer from './BulkVlanAssignDrawer'
import BulkPoeRestartDrawer from './BulkPoeRestartDrawer'

const { Text } = Typography

const SOURCE_COLOR: Record<EffectiveSource, string> = {
  'override': 'green',
  'cihaz-default': 'default',
  'org-default': 'default',
  'fallback': 'red',
}

// KURAL-E1: SOURCE_COLOR teknik (CSS), SOURCE_LABEL ise UI etiketi.
// Etiketler hook scope'unda useMemo + t() ile çözülür; module-level literal
// olarak çevrilmez (PortsTab'da useMemo'lu SOURCE_LABEL).
const SOURCE_LABEL_KEY: Record<EffectiveSource, string> = {
  'override':      'devices.detail.ports.source_override',
  'cihaz-default': 'devices.detail.ports.source_device_default',
  'org-default':   'devices.detail.ports.source_org_default',
  'fallback':      'devices.detail.ports.source_fallback',
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
  const { t } = useTranslation()
  const dev = device as any
  const { isOrgAdmin } = useAuthStore()
  const canWrite = isOrgAdmin()
  const { notification } = App.useApp()
  const [selected, setSelected] = useState<string[]>([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkVlanOpen, setBulkVlanOpen] = useState(false)
  const [bulkPoeRestartOpen, setBulkPoeRestartOpen] = useState(false)
  const [assignVlanIface, setAssignVlanIface] = useState<NetworkInterface | null>(null)
  const [assignVlanForm] = Form.useForm()
  // W3.3 — restart akışında "işlemde" göstermek için pending port seti
  const [poePending, setPoePending] = useState<Set<string>>(new Set())

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
  // W3.3 — PoE port snapshot (PoeTab ile aynı queryKey → cache hit).
  // 404 (cihaz PoE desteklemiyor) → friendly null; capability map boş kalır.
  const poePortsQ = useQuery({
    queryKey: ['device-poe', device.id],
    queryFn: () => poeApi.device(device.id).catch(() => null),
    enabled: device.id > 0,
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
    qc.invalidateQueries({ queryKey: ['device-poe', device.id] })
    qc.invalidateQueries({ queryKey: ['poe-device', device.id] })  // OverviewTab key
  }

  // W3.3 — port adı → oper_status haritası (PoE Status kolonu için).
  // Port adı snapshot'ta yoksa "—" (PoE desteklemiyor / henüz keşfedilmedi).
  const poeStatusByPort = useMemo(() => {
    const map = new Map<string, 'on' | 'off' | string>()
    const ports = poePortsQ.data?.ports ?? []
    for (const p of ports) map.set(p.port, p.oper_status)
    return map
  }, [poePortsQ.data?.ports])

  const poeCapableSet = useMemo(() => {
    return new Set((poePortsQ.data?.ports ?? []).map((p) => p.port))
  }, [poePortsQ.data?.ports])

  // W3.3 — bulk işlem sonrası PoE snapshot + interface listesi yenilensin
  const invalidatePoeCaches = () => {
    qc.invalidateQueries({ queryKey: ['device-poe', device.id] })
    qc.invalidateQueries({ queryKey: ['poe-device', device.id] })
    qc.invalidateQueries({ queryKey: ['device-interfaces', device.id] })
  }

  const reportBulkPoeResult = (
    res: BulkPoeResult, actionLabel: string,
  ) => {
    const lines: string[] = []
    if (res.ok > 0) lines.push(t('devices.detail.ports.bulk_poe.ok_line', { count: res.ok, action: actionLabel }))
    if (res.skipped > 0) lines.push(t('devices.detail.ports.bulk_poe.skipped_line', { count: res.skipped }))
    if (res.failed > 0) lines.push(t('devices.detail.ports.bulk_poe.failed_line', { count: res.failed }))
    const desc = lines.length ? lines.join(' · ') : t('devices.detail.ports.bulk_poe.completed', { action: actionLabel })
    if (res.failed > 0 || res.skipped > 0) {
      notification.warning({
        message: t('devices.detail.ports.bulk_poe.result_title', { action: actionLabel }),
        description: desc,
        duration: 6,
      })
    } else {
      notification.success({
        message: t('devices.detail.ports.bulk_poe.success_title', { action: actionLabel }),
        description: desc,
        duration: 4,
      })
    }
  }

  // W3.3 — Tek port PoE on/off (Popconfirm'den çağrılır)
  const setPoeMut = useMutation({
    mutationFn: ({ iface, enable }: { iface: string; enable: boolean }) =>
      portControlApi.setPoe(device.id, iface, enable),
    onSuccess: (_data, vars) => {
      notification.success({
        message: vars.enable
          ? t('devices.detail.ports.toast.poe_on', { iface: vars.iface })
          : t('devices.detail.ports.toast.poe_off', { iface: vars.iface }),
        description: t('devices.detail.ports.toast.poe_permanent'),
        duration: 4,
      })
      invalidatePoeCaches()
    },
    onError: (e: any, vars) => notification.error({
      message: vars.enable
        ? t('devices.detail.ports.toast.poe_on_failed', { iface: vars.iface })
        : t('devices.detail.ports.toast.poe_off_failed', { iface: vars.iface }),
      description: e?.response?.data?.detail || t('common.error'),
    }),
  })

  // W3.3 — Tek port PoE restart
  const restartPoeMut = useMutation({
    mutationFn: (iface: string) => {
      setPoePending((prev) => new Set(prev).add(iface))
      return portControlApi.restartPoe(device.id, iface)
    },
    onSuccess: (_data, iface) => {
      notification.success({
        message: t('devices.detail.ports.toast.poe_restart_ok', { iface }),
        description: t('devices.detail.ports.toast.poe_restart_desc'),
        duration: 4,
      })
      invalidatePoeCaches()
    },
    onError: (e: any, iface) => notification.error({
      message: t('devices.detail.ports.toast.poe_restart_failed', { iface }),
      description: e?.response?.data?.detail || t('common.error'),
    }),
    onSettled: (_d, _e, iface) => {
      setPoePending((prev) => {
        const next = new Set(prev)
        next.delete(iface)
        return next
      })
    },
  })

  // W3.3 — Toplu PoE on/off (Popconfirm)
  const bulkPoeMut = useMutation({
    mutationFn: ({ action }: { action: 'on' | 'off' }) =>
      portControlApi.bulkPoe(device.id, selected, action),
    onSuccess: (res, vars) => {
      reportBulkPoeResult(res, vars.action === 'on' ? t('devices.detail.ports.bulk_poe.action_on') : t('devices.detail.ports.bulk_poe.action_off'))
      setSelected([])
      invalidatePoeCaches()
    },
    onError: (e: any) => notification.error({
      message: t('devices.detail.ports.bulk_poe.bulk_failed'),
      description: e?.response?.data?.detail || t('common.error'),
    }),
  })

  // W3.3 — Toplu PoE restart (drawer)
  const bulkPoeRestartMut = useMutation({
    mutationFn: (opts: { restart_wait_sec: number; rollback_after_sec: number; reason?: string }) => {
      // İşlem sırasında seçili portları "pending" göster
      setPoePending(new Set(selected))
      return portControlApi.bulkPoe(device.id, selected, 'restart', opts)
    },
    onSuccess: (res) => {
      reportBulkPoeResult(res, t('devices.detail.ports.bulk_poe.action_restart'))
      setBulkPoeRestartOpen(false)
      setSelected([])
      invalidatePoeCaches()
    },
    onError: (e: any) => notification.error({
      message: t('devices.detail.ports.bulk_poe.bulk_restart_failed'),
      description: e?.response?.data?.detail || t('common.error'),
    }),
    onSettled: () => setPoePending(new Set()),
  })

  const bulkSetMut = useMutation({
    mutationFn: (policyId: number) =>
      portPolicyAssignmentsApi.bulkSet(
        device.id,
        selected.map((p) => ({ port_name: p, port_security_policy_id: policyId })),
      ),
    onSuccess: () => {
      message.success(t('devices.detail.ports.toast.ports_updated', { count: selected.length }))
      setBulkOpen(false)
      setSelected([])
      qc.invalidateQueries({ queryKey: ['port-policy-assignments', device.id] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('devices.detail.ports.toast.save_failed')),
  })

  const removeOverrideMut = useMutation({
    mutationFn: async () => {
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
      if (fail > 0) message.warning(t('devices.detail.ports.toast.override_partial', { ok, fail }))
      else message.success(t('devices.detail.ports.toast.override_removed', { count: ok }))
      setSelected([])
      qc.invalidateQueries({ queryKey: ['port-policy-assignments', device.id] })
    },
    onError: () => message.error(t('devices.detail.ports.toast.override_remove_failed')),
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
        message.success(t('devices.detail.ports.toast.vlan_assigned', { iface: assignVlanIface!.name }))
        setAssignVlanIface(null)
        assignVlanForm.resetFields()
        qc.invalidateQueries({ queryKey: ['device-interfaces', device.id] })
      } else {
        message.error(res.error || t('devices.detail.ports.toast.vlan_assign_failed'))
      }
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('devices.detail.ports.toast.vlan_assign_failed')),
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
      if (fail > 0) message.warning(t('devices.detail.ports.toast.bulk_vlan_partial', { ok, fail }))
      else message.success(t('devices.detail.ports.toast.bulk_vlan_ok', { count: ok }))
      setBulkVlanOpen(false)
      setSelected([])
      qc.invalidateQueries({ queryKey: ['device-interfaces', device.id] })
    },
    onError: () => message.error(t('devices.detail.ports.toast.bulk_vlan_failed')),
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
      const msg = e instanceof VlanListError ? e.message : t('devices.detail.ports.vlan_modal.allowed_invalid')
      form.setFields([{ name: 'allowed_vlans', errors: [msg] }])
      return null
    }
  }

  const columns = [
    {
      title: t('devices.detail.ports.col.port'), dataIndex: 'name', key: 'name', width: 180,
      render: (v: string) => <code style={{ fontSize: 12 }}>{v}</code>,
    },
    { title: t('devices.detail.ports.col.description'), dataIndex: 'description', key: 'description', ellipsis: true },
    {
      title: t('common.status'), dataIndex: 'status', key: 'status', width: 120,
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
        return <Tooltip title={t('devices.detail.ports.mac_tooltip', { label })}><span>{label}</span></Tooltip>
      },
    },
    {
      // W3.3 — PoE Status (snapshot tablosundan; on/off/restarting/—).
      title: 'PoE', key: 'poe', width: 90,
      render: (_: any, r: Row) => {
        if (poePending.has(r.key)) {
          return <Tag color="processing" style={{ fontSize: 11 }}>{t('devices.detail.ports.poe_processing')}</Tag>
        }
        const st = poeStatusByPort.get(r.key)
        if (!st) return <span style={{ color: 'var(--fg-3,#64748b)' }}>—</span>
        if (st === 'on') return <Tag color="green" style={{ fontSize: 11 }}>{t('devices.detail.ports.poe_on_tag')}</Tag>
        if (st === 'off') return <Tag color="default" style={{ fontSize: 11 }}>{t('devices.detail.ports.poe_off_tag')}</Tag>
        return <Tag color="orange" style={{ fontSize: 11 }}>{st}</Tag>
      },
    },
    {
      title: t('devices.detail.ports.col.policy'), key: 'policy', width: 220,
      render: (_: any, r: Row) => (
        <span>
          <span style={{ fontWeight: 500, marginRight: 6 }}>{r.effective.name}</span>
          <Tag color={SOURCE_COLOR[r.effective.source]} style={{ fontSize: 10 }}>
            {t(SOURCE_LABEL_KEY[r.effective.source])}
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
          <Tooltip title={t('devices.detail.ports.dry_run_tooltip', { policy, count: r.flapEvents.length, trans })}>
            <Tag color="orange" style={{ fontSize: 10 }}>
              DRY-RUN ({r.flapEvents.length})
            </Tag>
          </Tooltip>
        )
      },
    },
    // RBAC: canConnect gerekir; yoksa kolon hiç render edilmez (rows ekleme yok).
    ...(canWrite ? [{
      title: t('common.actions'), key: 'rowAction', width: 280,
      render: (_: any, r: Row) => {
        const iface = (ifaceQ.data?.interfaces ?? []).find((i) => i.name === r.key)
        if (!iface) return null
        const poeSt = poeStatusByPort.get(r.key)
        const poeCapable = poeCapableSet.size === 0 || poeCapableSet.has(r.key)
        const isPending = poePending.has(r.key)
        return (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <Tooltip title={t('devices.detail.ports.row.vlan_tooltip')}>
              <Button
                size="small" type="link"
                icon={<ApartmentOutlined />}
                onClick={() => setAssignVlanIface(iface)}
              >
                VLAN
              </Button>
            </Tooltip>
            {poeCapable && (
              <>
                <Popconfirm
                  title={t('devices.detail.ports.row.poe_on_title', { iface: r.key })}
                  description={t('devices.detail.ports.row.poe_on_desc')}
                  okText={t('devices.detail.ports.row.poe_on_ok')} cancelText={t('common.cancel')}
                  onConfirm={() => setPoeMut.mutate({ iface: r.key, enable: true })}
                  disabled={poeSt === 'on' || isPending}
                >
                  <Button
                    size="small" type="link"
                    icon={<ThunderboltOutlined />}
                    disabled={poeSt === 'on' || isPending}
                    loading={setPoeMut.isPending && setPoeMut.variables?.iface === r.key && setPoeMut.variables?.enable}
                  >{t('devices.detail.ports.row.poe_on_ok')}</Button>
                </Popconfirm>
                <Popconfirm
                  title={t('devices.detail.ports.row.poe_off_title', { iface: r.key })}
                  description={t('devices.detail.ports.row.poe_off_desc')}
                  okText={t('devices.detail.ports.row.poe_off_ok')} okButtonProps={{ danger: true }} cancelText={t('common.cancel')}
                  onConfirm={() => setPoeMut.mutate({ iface: r.key, enable: false })}
                  disabled={poeSt === 'off' || isPending}
                >
                  <Button
                    size="small" type="link" danger
                    icon={<PoweroffOutlined />}
                    disabled={poeSt === 'off' || isPending}
                    loading={setPoeMut.isPending && setPoeMut.variables?.iface === r.key && !setPoeMut.variables?.enable}
                  >{t('devices.detail.ports.row.poe_off_ok')}</Button>
                </Popconfirm>
                <Popconfirm
                  title={t('devices.detail.ports.row.poe_restart_title', { iface: r.key })}
                  description={t('devices.detail.ports.row.poe_restart_desc')}
                  okText={t('devices.detail.ports.row.poe_restart_ok')} cancelText={t('common.cancel')}
                  onConfirm={() => restartPoeMut.mutate(r.key)}
                  disabled={isPending}
                >
                  <Button
                    size="small" type="link"
                    icon={<RestartOutlined />}
                    disabled={isPending}
                    loading={restartPoeMut.isPending && restartPoeMut.variables === r.key}
                  >{t('devices.detail.ports.row.poe_restart_ok')}</Button>
                </Popconfirm>
              </>
            )}
          </div>
        )
      },
    }] : []),
  ]

  // Wave 2 #2 F2 — Port Statistics (5 KPI mockup pages-switch.jsx:173-181)
  const portStats = useMemo(() => {
    const ifaces = ifaceQ.data?.interfaces ?? []
    const upCount = ifaces.filter((i) =>
      /up|connected|forwarding/i.test(i.status || '')).length
    const errCount = ifaces.filter((i) =>
      /err|disabled|down|notconnect/i.test(i.status || '')).length
    const vlanSet = new Set(
      ifaces.map((i) => i.vlan).filter((v) => v && v !== 'trunk') as string[],
    )
    return {
      total: ifaces.length,
      up: upCount,
      err: errCount,
      vlans: vlanSet.size,
      macTotal: macQ.data?.total ?? 0,
    }
  }, [ifaceQ.data?.interfaces, macQ.data?.total])

  return (
    <div style={{ padding: '8px 0 16px' }}>
      {/* Wave 2 #2 F2 — Port Statistics statbar (5 KPI) */}
      <div className="nm-statbar" style={{ marginBottom: 12 }}>
        <div className={`nm-stat ${portStats.up > 0 ? 'ok' : ''}`}>
          <div className="nm-stat-label">{t('devices.detail.overview.active_port')}</div>
          <div className="nm-stat-val">
            {portStats.up}
            {portStats.total > 0 && <small> / {portStats.total}</small>}
          </div>
        </div>
        <div className={`nm-stat ${portStats.err > 0 ? 'crit' : ''}`}>
          <div className="nm-stat-label">{t('devices.detail.overview.err_down')}</div>
          <div className="nm-stat-val">{portStats.err}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('devices.detail.ports.stat.vlan_by_port')}</div>
          <div className="nm-stat-val">{portStats.vlans}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('devices.detail.ports.stat.mac_table')}</div>
          <div className="nm-stat-val">{portStats.macTotal}</div>
          <div className="nm-stat-delta">{t('devices.detail.ports.stat.mac_learned')}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('devices.detail.ports.stat.override')}</div>
          <div className="nm-stat-val">{overrideSet.size}</div>
          <div className="nm-stat-delta">{t('devices.detail.ports.stat.override_caption')}</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Text strong>{t('devices.detail.ports.list_title')}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {ifaceQ.data?.cached ? t('devices.detail.ports.cache_label') : ifaceQ.data?.fetched_at ? t('devices.detail.overview.live') : ''}
        </Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={isLoading}>{t('common.refresh')}</Button>
        </div>
      </div>

      {!isLoading && !fetchSuccess && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message={t('devices.detail.ports.unreachable_title')}
          description={
            <div style={{ fontSize: 12 }}>
              {fetchError || t('devices.detail.ports.unreachable_default')}{' '}
              {t('devices.detail.ports.unreachable_desc')}
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
          locale={{ emptyText: fetchSuccess ? t('devices.detail.ports.empty_no_ports') : '—' }}
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
          <Text strong>{t('devices.detail.ports.toolbar.selected', { count: selected.length })}</Text>
          <Button type="primary" onClick={() => setBulkOpen(true)}>{t('devices.detail.ports.toolbar.policy_assign')}</Button>
          <Button
            icon={<ApartmentOutlined />}
            onClick={() => setBulkVlanOpen(true)}
          >
            {t('devices.detail.ports.toolbar.vlan_assign')}
          </Button>
          <Tooltip title={
            selectedWithOverride.length === 0
              ? t('devices.detail.ports.toolbar.no_override_selected')
              : t('devices.detail.ports.toolbar.override_remove_count', { count: selectedWithOverride.length })
          }>
            <Button
              danger
              disabled={selectedWithOverride.length === 0}
              loading={removeOverrideMut.isPending}
              onClick={() => removeOverrideMut.mutate()}
            >
              {t('devices.detail.ports.toolbar.override_remove_btn')}
              {selectedWithOverride.length > 0 && ` (${selectedWithOverride.length})`}
            </Button>
          </Tooltip>
          <Popconfirm
            title={t('devices.detail.ports.bulk_poe.on_title', { count: selected.length })}
            description={t('devices.detail.ports.bulk_poe.on_desc')}
            okText={t('devices.detail.ports.row.poe_on_ok')} cancelText={t('common.cancel')}
            onConfirm={() => bulkPoeMut.mutate({ action: 'on' })}
          >
            <Button
              icon={<ThunderboltOutlined />}
              loading={bulkPoeMut.isPending && bulkPoeMut.variables?.action === 'on'}
            >{t('devices.detail.ports.bulk_poe.btn_on')}</Button>
          </Popconfirm>
          <Popconfirm
            title={t('devices.detail.ports.bulk_poe.off_title', { count: selected.length })}
            description={t('devices.detail.ports.bulk_poe.off_desc')}
            okText={t('devices.detail.ports.row.poe_off_ok')} okButtonProps={{ danger: true }} cancelText={t('common.cancel')}
            onConfirm={() => bulkPoeMut.mutate({ action: 'off' })}
          >
            <Button
              icon={<PoweroffOutlined />}
              danger
              loading={bulkPoeMut.isPending && bulkPoeMut.variables?.action === 'off'}
            >{t('devices.detail.ports.bulk_poe.btn_off')}</Button>
          </Popconfirm>
          <Button
            icon={<RestartOutlined />}
            onClick={() => setBulkPoeRestartOpen(true)}
          >{t('devices.detail.ports.bulk_poe.btn_restart')}</Button>
          <Button type="text" onClick={() => setSelected([])} style={{ marginLeft: 'auto' }}>{t('devices.table.clear_selection')}</Button>
        </div>
      )}

      {!canWrite && (
        <Alert
          type="info" showIcon style={{ marginTop: 12, fontSize: 12 }}
          message={t('devices.detail.ports.readonly_alert')}
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

      {/* W3.3 — Toplu PoE Restart Drawer */}
      <BulkPoeRestartDrawer
        open={bulkPoeRestartOpen}
        onClose={() => setBulkPoeRestartOpen(false)}
        selectedPorts={selected}
        saving={bulkPoeRestartMut.isPending}
        onSubmit={(opts) => bulkPoeRestartMut.mutate(opts)}
      />

      {/* Tek port VLAN ata (hızlı yol — row aksiyonundan açılır) */}
      <Modal
        open={!!assignVlanIface}
        title={assignVlanIface ? t('devices.detail.ports.vlan_modal.title', { iface: assignVlanIface.name }) : ''}
        onCancel={() => { setAssignVlanIface(null); assignVlanForm.resetFields() }}
        onOk={() => assignVlanForm.submit()}
        confirmLoading={assignVlanMut.isPending}
        okText={t('devices.detail.ports.vlan_modal.assign')} cancelText={t('common.cancel')}
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
            name="mode" label={t('devices.detail.ports.vlan_modal.mode_label')}
            rules={[{ required: true, message: t('devices.detail.ports.vlan_modal.mode_required') }]}
          >
            <Select
              options={[
                { label: t('devices.detail.ports.vlan_modal.mode_access'), value: 'access' },
                { label: t('devices.detail.ports.vlan_modal.mode_trunk'), value: 'trunk' },
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
                    name="access_vlan_id" label={t('devices.detail.ports.vlan_modal.access_vlan_label')}
                    rules={[
                      { required: true, message: t('devices.detail.ports.vlan_modal.access_vlan_required') },
                      { type: 'number', min: 1, max: 4094, message: t('devices.detail.ports.vlan_modal.range') },
                    ]}
                  >
                    <InputNumber style={{ width: '100%' }} placeholder={t('devices.detail.ports.vlan_modal.access_placeholder')} min={1} max={4094} />
                  </Form.Item>
                )
              }
              // trunk
              return (
                <>
                  <Form.Item
                    name="native_vlan_id" label={t('devices.detail.ports.vlan_modal.native_label')}
                    rules={[{ type: 'number', min: 1, max: 4094, message: t('devices.detail.ports.vlan_modal.range') }]}
                    extra={t('devices.detail.ports.vlan_modal.native_extra')}
                  >
                    <InputNumber style={{ width: '100%' }} placeholder={t('devices.detail.ports.vlan_modal.native_placeholder')} min={1} max={4094} />
                  </Form.Item>
                  <Form.Item
                    name="allowed_vlans" label="Allowed VLANs"
                    rules={[{ required: true, message: t('devices.detail.ports.vlan_modal.allowed_required') }]}
                    extra={t('devices.detail.ports.vlan_modal.allowed_extra')}
                  >
                    <Input placeholder="1,10,20-30,2400,2460" />
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
