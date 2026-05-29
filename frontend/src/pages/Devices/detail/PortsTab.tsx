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
import { Table, Tag, Badge, Button, Tooltip, Alert, Spin, Typography, message } from 'antd'
import { ReloadOutlined, PoweroffOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Device, NetworkInterface } from '@/types'
import { devicesApi } from '@/api/devices'
import { macArpApi } from '@/api/macarp'
import { portPolicyAssignmentsApi } from '@/api/portPolicyAssignments'
import { securityPoliciesApi } from '@/api/securityPolicies'
import { useAuthStore } from '@/store/auth'
import {
  effectivePortPolicy, macCountByPort, MAC_COUNT_CAP, type EffectiveSource,
} from './_portsHelper'
import BulkPolicyAssignDrawer from './BulkPolicyAssignDrawer'

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
}

export default function PortsTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const dev = device as any
  const { isOrgAdmin } = useAuthStore()
  const canWrite = isOrgAdmin()
  const [selected, setSelected] = useState<string[]>([])
  const [bulkOpen, setBulkOpen] = useState(false)

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

  const macMap = useMemo(
    () => macCountByPort((macQ.data?.items ?? []) as { port?: string }[]),
    [macQ.data?.items],
  )

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
      }
    })
  }, [ifaceQ.data?.interfaces, macMap, overridesQ.data, portPoliciesQ.data, dev.port_security_policy_id])

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
          {/* Override kaldır + dry-run pill C7.C commit 4'te. */}
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
    </div>
  )
}
