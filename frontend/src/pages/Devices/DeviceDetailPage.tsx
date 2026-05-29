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
import { DETAIL_TABS, normalizeTab, type TabKey } from './detail/_tabs'
import OverviewTab from './detail/OverviewTab'

const STATUS_BADGE: Record<string, 'success' | 'error' | 'warning' | 'default'> = {
  online: 'success', offline: 'error', unreachable: 'warning', unknown: 'default',
}

function PlaceholderTab({ name, eta }: { name: string; eta: string }) {
  return (
    <div style={{
      padding: 32, textAlign: 'center', color: 'var(--fg-3, #64748b)',
      background: 'var(--bg-1, #f8fafc)', border: '1px dashed var(--line-soft, #cbd5e1)',
      borderRadius: 8, fontSize: 13,
    }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>{name}</div>
      Bu sekme {eta} ile geliyor.
    </div>
  )
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

  const activeTab: TabKey = useMemo(() => normalizeTab(search.get('tab')), [search])
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

  const tabItems = DETAIL_TABS.map((t) => ({
    key: t.key,
    label: t.label + (t.placeholder ? ' ·' : ''),
    children: (() => {
      if (t.key === 'overview') return <OverviewTab device={device} />
      if (t.key === 'security') {
        // C7.B Commit 3'te SecurityPoliciesTab eklenecek.
        return <PlaceholderTab name="Güvenlik Politikası" eta="C7.B (sıradaki commit)" />
      }
      if (t.key === 'ports') return <PlaceholderTab name="Portlar / Arayüzler" eta="C7.C" />
      return <PlaceholderTab name={t.label} eta="C7.D" />
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
