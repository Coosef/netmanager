/**
 * T10 C7.B — Device Detail Page.
 *
 * Route: /devices/:deviceId. Kalıcı sekmeli sayfa. URL ?tab= ile derin link.
 * C7.B'de aktif: Genel + Güvenlik Politikası. Diğer sekmeler placeholder (C7.C/D).
 */
import { useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Spin, Result, Tabs, Tag, Badge } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import { useSite } from '@/contexts/SiteContext'
import { DETAIL_TABS, normalizeTab, type TabKey } from './detail/_tabs'
import OverviewTab from './detail/OverviewTab'
import SecurityPoliciesTab from './detail/SecurityPoliciesTab'
import PortsTab from './detail/PortsTab'
import VlanTab from './detail/VlanTab'
import MacTab from './detail/MacTab'
import PoeTab from './detail/PoeTab'
import EventsTab from './detail/EventsTab'
import BackupTab from './detail/BackupTab'
import ActionsTab from './detail/ActionsTab'

const STATUS_BADGE: Record<string, 'success' | 'error' | 'warning' | 'default'> = {
  online: 'success', offline: 'error', unreachable: 'warning', unknown: 'default',
}

export default function DeviceDetailPage() {
  const { deviceId } = useParams<{ deviceId: string }>()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const id = Number(deviceId)

  const { data: device, isLoading, error } = useQuery({
    queryKey: ['device', id],
    queryFn: () => devicesApi.get(id),
    enabled: Number.isFinite(id) && id > 0,
  })

  // Feature gate: security_policy explicit false ise Güvenlik Politikası sekmesi gizlenir.
  const { features } = useSite()
  const secPolEnabled = features['security_policy'] !== false
  const visibleTabs = useMemo(
    () => DETAIL_TABS.filter((t) => t.key !== 'security' || secPolEnabled),
    [secPolEnabled],
  )

  const activeTab: TabKey = useMemo(() => {
    const t = normalizeTab(search.get('tab'))
    // İstenen tab gizliyse (örn. security gate kapalı) overview'a düş.
    return visibleTabs.some((v) => v.key === t) ? t : 'overview'
  }, [search, visibleTabs])
  const setTab = (key: string) => {
    const next = new URLSearchParams(search)
    next.set('tab', key)
    setSearch(next, { replace: true })
  }

  if (!Number.isFinite(id) || id <= 0) {
    return (
      <div style={{ padding: 24 }}>
        <Result status="404" title="Geçersiz cihaz ID" extra={
          <Button onClick={() => navigate('/devices')}>← Cihazlar</Button>
        } />
      </div>
    )
  }
  if (isLoading) return <div style={{ padding: 24 }}><Spin /> Cihaz yükleniyor…</div>
  if (error || !device) {
    return (
      <div style={{ padding: 24 }}>
        <Result status="404" title="Cihaz bulunamadı"
          subTitle="Cihaz silinmiş, başka bir org'a aitmiş ya da erişim yok."
          extra={<Button onClick={() => navigate('/devices')}>← Cihazlar</Button>} />
      </div>
    )
  }

  const tabItems = visibleTabs.map((t) => ({
    key: t.key,
    label: t.label + (t.placeholder ? ' ·' : ''),
    children: (() => {
      if (t.key === 'overview') return <OverviewTab device={device} />
      if (t.key === 'security') return <SecurityPoliciesTab device={device} />
      if (t.key === 'ports') return <PortsTab device={device} />
      if (t.key === 'vlan') return <VlanTab device={device} />
      if (t.key === 'mac') return <MacTab device={device} />
      if (t.key === 'poe') return <PoeTab device={device} />
      if (t.key === 'events') return <EventsTab device={device} />
      if (t.key === 'backup') return <BackupTab device={device} />
      if (t.key === 'actions') return <ActionsTab device={device} />
      return null  // tüm sekmeler artık live; placeholder yok
    })(),
  }))

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => navigate('/devices')}>Cihazlar</Button>
        <Badge status={STATUS_BADGE[device.status] ?? 'default'} />
        <div style={{ fontSize: 20, fontWeight: 600 }}>{device.hostname || device.ip_address}</div>
        <code style={{ background: 'var(--bg-2, #f5f5f5)', padding: '2px 8px', borderRadius: 4, fontSize: 13 }}>
          {device.ip_address}
        </code>
        <span style={{ fontSize: 12, color: 'var(--fg-3, #64748b)' }}>
          {device.vendor} · {device.os_type}{device.site ? ' · ' + device.site : ''}
        </span>
        {device.lifecycle_status && device.lifecycle_status !== 'production' && (
          <Tag color={device.lifecycle_status === 'archived' ? 'default' : 'orange'}>
            {device.lifecycle_status}
          </Tag>
        )}
      </div>
      <Tabs activeKey={activeTab} onChange={setTab} items={tabItems} destroyInactiveTabPane={false} />
    </div>
  )
}
