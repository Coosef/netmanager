/**
 * T10 C7.B — Device Detail > Güvenlik Politikası sekmesi.
 *
 * C6b'den taşınan switch + cihaz-geneli port policy atama UI'sının yeni evi.
 * Atama mevcut PATCH /devices/{id} ile gider (security_policy_id, port_security_policy_id).
 * NULL = "atanmamış" → resolver org default'una düşer (UI'da açıkça yazılı).
 * Per-port override sayısı bilgi olarak gösterilir (CRUD = C7.C Ports sekmesi).
 *
 * Yetki: viewer dropdown'ları görür ama Save disabled; org_admin+ kaydeder.
 * Feature gate: bu sekme yalnız `security_policy` özelliği açıkken render edilir
 * (DeviceDetailPage'te `features['security_policy'] !== false` filtresiyle).
 */
import { useEffect, useState } from 'react'
import { Select, Button, Card, Alert, Tag, Typography, message } from 'antd'
import { SafetyOutlined, ArrowRightOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Device } from '@/types'
import { devicesApi } from '@/api/devices'
import { securityPoliciesApi } from '@/api/securityPolicies'
import { portPolicyAssignmentsApi } from '@/api/portPolicyAssignments'
import { useAuthStore } from '@/store/auth'

const { Text, Paragraph } = Typography

export default function SecurityPoliciesTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { isOrgAdmin } = useAuthStore()
  const canWrite = isOrgAdmin()

  const { data: switchPolicies = [] } = useQuery({
    queryKey: ['secpol', 'switch'],
    queryFn: () => securityPoliciesApi.list('switch'),
    staleTime: 30_000,
  })
  const { data: portPolicies = [] } = useQuery({
    queryKey: ['secpol', 'port'],
    queryFn: () => securityPoliciesApi.list('port'),
    staleTime: 30_000,
  })
  const { data: overrides = [] } = useQuery({
    queryKey: ['port-policy-assignments', device.id],
    queryFn: () => portPolicyAssignmentsApi.list(device.id),
    staleTime: 30_000,
  })

  // Form state — cihaz değişince ya da query sonucu gelince senkron.
  const [switchPid, setSwitchPid] = useState<number | undefined>(
    (device as any).security_policy_id ?? undefined,
  )
  const [portPid, setPortPid] = useState<number | undefined>(
    (device as any).port_security_policy_id ?? undefined,
  )
  useEffect(() => {
    setSwitchPid((device as any).security_policy_id ?? undefined)
    setPortPid((device as any).port_security_policy_id ?? undefined)
  }, [device.id, (device as any).security_policy_id, (device as any).port_security_policy_id])

  const orgDefaultSwitch = switchPolicies.find((p: any) => p.is_default)
  const orgDefaultPort  = portPolicies.find((p: any) => p.is_default)
  const assignedSwitch  = switchPid ? switchPolicies.find((p: any) => p.id === switchPid) : undefined
  const assignedPort    = portPid ? portPolicies.find((p: any) => p.id === portPid) : undefined

  const saveMut = useMutation({
    mutationFn: (payload: Record<string, any>) => devicesApi.update(device.id, payload),
    onSuccess: () => {
      message.success('Politika ataması kaydedildi')
      qc.invalidateQueries({ queryKey: ['device', device.id] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Kaydedilemedi'),
  })

  const dirty =
    (switchPid ?? null) !== ((device as any).security_policy_id ?? null) ||
    (portPid ?? null) !== ((device as any).port_security_policy_id ?? null)

  const handleSave = () => {
    saveMut.mutate({
      security_policy_id: switchPid ?? null,
      port_security_policy_id: portPid ?? null,
    })
  }

  const overrideCount = overrides.length

  return (
    <div style={{ padding: '8px 0 16px', maxWidth: 880 }}>
      <Card size="small" title={<><SafetyOutlined /> Cihaz Seviyesi Atamalar</>}>
        <div style={{ marginBottom: 16 }}>
          <Text strong>Switch Politikası</Text>
          <div style={{ color: 'var(--fg-3, #64748b)', fontSize: 12, marginBottom: 6 }}>
            Bu cihazın CPU/bellek/PoE eşikleri vb. — boş = atanmamış → org varsayılanı.
          </div>
          <Select
            allowClear
            placeholder={`— Atanmamış (org varsayılanı${orgDefaultSwitch ? `: ${orgDefaultSwitch.name}` : ''}) —`}
            value={switchPid}
            disabled={!canWrite}
            onChange={(v) => setSwitchPid(v ?? undefined)}
            style={{ width: '100%' }}
            options={switchPolicies.map((p: any) => ({
              label: p.is_default ? `${p.name} (varsayılan)` : p.name,
              value: p.id,
            }))}
          />
        </div>

        <div>
          <Text strong>Port Politikası (cihaz geneli default)</Text>
          <div style={{ color: 'var(--fg-3, #64748b)', fontSize: 12, marginBottom: 6 }}>
            Cihazın tüm portları için varsayılan. Port-bazlı override = Portlar sekmesi (C7.C).
          </div>
          <Select
            allowClear
            placeholder={`— Atanmamış (org varsayılanı${orgDefaultPort ? `: ${orgDefaultPort.name}` : ''}) —`}
            value={portPid}
            disabled={!canWrite}
            onChange={(v) => setPortPid(v ?? undefined)}
            style={{ width: '100%' }}
            options={portPolicies.map((p: any) => ({
              label: p.is_default ? `${p.name} (varsayılan)` : p.name,
              value: p.id,
            }))}
          />
        </div>

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {!canWrite && <Tag>Salt-okunur (org_admin+ kaydedebilir)</Tag>}
          {canWrite && (
            <Button type="primary" loading={saveMut.isPending} disabled={!dirty} onClick={handleSave}>
              Kaydet
            </Button>
          )}
        </div>
      </Card>

      <Card size="small" title="Etkin Resolver Zinciri" style={{ marginTop: 16 }}>
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          Cihaz/port için **uygulanan** politika nereden geliyor:
          <em> atanan → cihaz default → org default → hardcoded fallback.</em>
        </Paragraph>
        <div style={{ marginBottom: 10 }}>
          <Text strong>Switch:</Text>{' '}
          {assignedSwitch
            ? <><Tag color="blue">atanan</Tag> {assignedSwitch.name}</>
            : orgDefaultSwitch
              ? <><Tag>org default</Tag> {orgDefaultSwitch.name}</>
              : <><Tag color="red">fallback</Tag> hardcoded baseline</>}
        </div>
        <div>
          <Text strong>Portlar:</Text>{' '}
          {overrideCount > 0 && (
            <>
              <Tag color="green">{overrideCount} port override</Tag>{' '}
              <Button size="small" type="link" onClick={() => navigate(`?tab=ports`)}>
                Portlar sekmesi <ArrowRightOutlined />
              </Button>
              <br />
              <span style={{ color: 'var(--fg-3,#64748b)', fontSize: 12 }}>
                Override olmayan portlar şu zincire düşer:
              </span>{' '}
            </>
          )}
          {assignedPort
            ? <><Tag color="blue">cihaz default</Tag> {assignedPort.name}</>
            : orgDefaultPort
              ? <><Tag>org default</Tag> {orgDefaultPort.name}</>
              : <><Tag color="red">fallback</Tag> hardcoded baseline</>}
        </div>
      </Card>

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 12, fontSize: 12 }}
        message="Per-port override CRUD (toplu seçim, tek tek atama, dry-run quarantine önerileri) C7.C ile Portlar sekmesinde gelecek."
      />
    </div>
  )
}
