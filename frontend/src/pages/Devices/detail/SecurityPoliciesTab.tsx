/**
 * T10 C7.B — Device Detail > Güvenlik Politikası sekmesi.
 *
 * C6b'den taşınan switch + cihaz-geneli port policy atama UI'sının yeni evi.
 * Atama mevcut PATCH /devices/{id} ile gider (security_policy_id, port_security_policy_id).
 * NULL = "atanmamış" → resolver org default'una düşer (UI'da açıkça yazılı).
 * Per-port override sayısı bilgi olarak gösterilir (CRUD = Portlar sekmesi).
 *
 * Yetki: viewer dropdown'ları görür ama Save disabled; backend
 * `device:edit` granted kullanıcı (org_admin+ veya granted location_admin)
 * kaydeder.
 *
 * P2-F1 HOTFIX (2026-06-23) — Save aksiyonu önceden `isOrgAdmin()` ile
 * kilitliydi. Backend kayıt yolu `PATCH /devices/{id}` zaten `device:edit`
 * kontrol ediyor; UI gate aynı kontrata bağlandı (`can('devices','edit')`)
 * böylece backend SYSTEM_ROLE_PERMISSIONS ile tutarlı.
 *
 * Feature gate: bu sekme yalnız `security_policy` özelliği açıkken render edilir
 * (DeviceDetailPage'te `features['security_policy'] !== false` filtresiyle).
 */
import { useEffect, useState } from 'react'
import { Select, Button, Card, Tag, Typography, message } from 'antd'
import { SafetyOutlined, ArrowRightOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Device } from '@/types'
import { devicesApi } from '@/api/devices'
import { securityPoliciesApi } from '@/api/securityPolicies'
import { portPolicyAssignmentsApi } from '@/api/portPolicyAssignments'
import { useAuthStore } from '@/store/auth'

const { Text, Paragraph } = Typography

export default function SecurityPoliciesTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { t } = useTranslation()
  // P2-F1 HOTFIX (2026-06-23) — Save aksiyonu device PATCH'i ile yapılır,
  // backend gate'i `device:edit`. UI buna hizalandı; granted location_admin
  // de policy ataması yapabilir.
  const canWrite = useAuthStore((s) => s.can('devices', 'edit'))

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
      message.success(t('devices.detail.security.toast.saved'))
      qc.invalidateQueries({ queryKey: ['device', device.id] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('devices.detail.ports.toast.save_failed')),
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
      <Card size="small" title={<><SafetyOutlined /> {t('devices.detail.security.device_level_title')}</>}>
        <div style={{ marginBottom: 16 }}>
          <Text strong>{t('devices.detail.security.switch_policy_label')}</Text>
          <div style={{ color: 'var(--fg-3, #64748b)', fontSize: 12, marginBottom: 6 }}>
            {t('devices.detail.security.switch_policy_desc')}
          </div>
          <Select
            allowClear
            placeholder={orgDefaultSwitch
              ? t('devices.detail.security.unassigned_with_default', { name: orgDefaultSwitch.name })
              : t('devices.detail.security.unassigned')}
            value={switchPid}
            disabled={!canWrite}
            onChange={(v) => setSwitchPid(v ?? undefined)}
            style={{ width: '100%' }}
            options={switchPolicies.map((p: any) => ({
              label: p.is_default ? t('devices.detail.security.option_default', { name: p.name }) : p.name,
              value: p.id,
            }))}
          />
        </div>

        <div>
          <Text strong>{t('devices.detail.security.port_policy_label')}</Text>
          <div style={{ color: 'var(--fg-3, #64748b)', fontSize: 12, marginBottom: 6 }}>
            {t('devices.detail.security.port_policy_desc')}
          </div>
          <Select
            allowClear
            placeholder={orgDefaultPort
              ? t('devices.detail.security.unassigned_with_default', { name: orgDefaultPort.name })
              : t('devices.detail.security.unassigned')}
            value={portPid}
            disabled={!canWrite}
            onChange={(v) => setPortPid(v ?? undefined)}
            style={{ width: '100%' }}
            options={portPolicies.map((p: any) => ({
              label: p.is_default ? t('devices.detail.security.option_default', { name: p.name }) : p.name,
              value: p.id,
            }))}
          />
        </div>

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {!canWrite && <Tag>{t('devices.detail.security.readonly_tag')}</Tag>}
          {canWrite && (
            <Button type="primary" loading={saveMut.isPending} disabled={!dirty} onClick={handleSave}>
              {t('common.save')}
            </Button>
          )}
        </div>
      </Card>

      <Card size="small" title={t('devices.detail.security.resolver_title')} style={{ marginTop: 16 }}>
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          {t('devices.detail.security.resolver_desc')}
        </Paragraph>
        <div style={{ marginBottom: 10 }}>
          <Text strong>{t('devices.detail.security.switch_label')}</Text>{' '}
          {assignedSwitch
            ? <><Tag color="blue">{t('devices.detail.security.tag_assigned')}</Tag> {assignedSwitch.name}</>
            : orgDefaultSwitch
              ? <><Tag>{t('devices.detail.security.tag_org_default')}</Tag> {orgDefaultSwitch.name}</>
              : <><Tag color="red">{t('devices.detail.security.tag_fallback')}</Tag> {t('devices.detail.security.fallback_text')}</>}
        </div>
        <div>
          <Text strong>{t('devices.detail.security.ports_label')}</Text>{' '}
          {overrideCount > 0 && (
            <>
              <Tag color="green">{t('devices.detail.security.port_override_count', { count: overrideCount })}</Tag>{' '}
              <Button size="small" type="link" onClick={() => navigate(`?tab=ports`)}>
                {t('devices.detail.security.ports_tab_link')} <ArrowRightOutlined />
              </Button>
              <br />
              <span style={{ color: 'var(--fg-3,#64748b)', fontSize: 12 }}>
                {t('devices.detail.security.non_override_chain')}
              </span>{' '}
            </>
          )}
          {assignedPort
            ? <><Tag color="blue">{t('devices.detail.security.tag_device_default')}</Tag> {assignedPort.name}</>
            : orgDefaultPort
              ? <><Tag>{t('devices.detail.security.tag_org_default')}</Tag> {orgDefaultPort.name}</>
              : <><Tag color="red">{t('devices.detail.security.tag_fallback')}</Tag> {t('devices.detail.security.fallback_text')}</>}
        </div>
      </Card>
    </div>
  )
}
