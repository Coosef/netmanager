/**
 * T10 C7.B — Device Detail Page (stub).
 *
 * Route: /devices/:deviceId — kalıcı sekmeli sayfa (Devices listesinde cihaz adına
 * tıklayınca buraya gelinir). C7.B Commit 1: iskelet stub (sadece header + placeholder).
 * Tabs + Overview + Security Policies sonraki commit'lerde.
 *
 * Eski "DeviceDetail" modal'ı (Devices/index.tsx içinden açılan) deprecate edildi;
 * dosyası kalır (DeviceDetail.tsx — C7.D'de VLAN/MAC/PoE/Events/Backup sekmelerinde
 * embed için referans). Hızlı Düzenle Drawer aynen kalır.
 */
import { useParams, useNavigate } from 'react-router-dom'
import { Button, Spin, Result } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'

export default function DeviceDetailPage() {
  const { deviceId } = useParams<{ deviceId: string }>()
  const navigate = useNavigate()
  const id = Number(deviceId)

  const { data: device, isLoading, error } = useQuery({
    queryKey: ['device', id],
    queryFn: () => devicesApi.get(id),
    enabled: Number.isFinite(id) && id > 0,
  })

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

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => navigate('/devices')}>Cihazlar</Button>
        <div style={{ fontSize: 20, fontWeight: 600 }}>{device.hostname || device.ip_address}</div>
        <code style={{ background: 'var(--bg-2, #f5f5f5)', padding: '2px 8px', borderRadius: 4, fontSize: 13 }}>
          {device.ip_address}
        </code>
        <span style={{ fontSize: 12, color: 'var(--fg-3, #64748b)' }}>
          {device.vendor} · {device.os_type} · {device.location || '—'}
        </span>
      </div>
      {/* C7.B Commit 2-3: Tabs + Overview + Security Policies (yakında).
          C7.C: Ports/Interfaces sekmesi.
          C7.D: VLAN/MAC/PoE/Events/Backup/Actions sekmeleri. */}
      <div style={{ padding: 24, background: 'var(--bg-1, #f8fafc)', border: '1px dashed var(--line-soft, #cbd5e1)', borderRadius: 8, textAlign: 'center', color: 'var(--fg-3, #64748b)' }}>
        Cihaz detay sekmeleri C7.B (Overview / Security Policies) + C7.C/D ile yakında.
      </div>
    </div>
  )
}
