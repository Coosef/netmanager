/**
 * T10 C7.D — Device Detail > Aksiyonlar sekmesi.
 *
 * Cihaz seviyesi aksiyonlar: bağlantı testi, bilgi çek, yaşam döngüsü, lokasyon
 * taşı, arşive al, sil. Shutdown / port quarantine = disabled (C5 ile gelecek).
 * Viewer: read-only — bilgi banner. org_admin+ aksiyon yapabilir.
 */
import { useState } from 'react'
import { Card, Button, Space, Tag, Popconfirm, message, Tooltip, Alert, Select } from 'antd'
import {
  ApiOutlined, ReloadOutlined, EnvironmentOutlined, InboxOutlined,
  DeleteOutlined, PoweroffOutlined, SyncOutlined, HeartOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Device } from '@/types'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'

const LIFECYCLE_OPTIONS = [
  { value: 'production', label: 'Production (aktif)' },
  { value: 'passive', label: 'Passive (devre dışı izleme)' },
  { value: 'stock', label: 'Stock (kurulum bekliyor)' },
  { value: 'archived', label: 'Archived (arşiv)' },
]

export default function ActionsTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { isOrgAdmin } = useAuthStore()
  const canWrite = isOrgAdmin()

  const [nextLifecycle, setNextLifecycle] = useState<string>((device as any).lifecycle_status || 'production')

  const refresh = () => qc.invalidateQueries({ queryKey: ['device', device.id] })

  const testMut = useMutation({
    mutationFn: () => devicesApi.testConnection(device.id),
    onSuccess: (d: any) => message.success(d?.success ? `Bağlantı OK (${d?.latency_ms ?? '?'} ms)` : `Hata: ${d?.message || d?.error}`),
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Test başarısız'),
  })
  const infoMut = useMutation({
    mutationFn: () => devicesApi.fetchInfo(device.id),
    onSuccess: () => { message.success('Cihaz bilgisi güncellendi'); refresh() },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Bilgi çekilemedi'),
  })
  const lifecycleMut = useMutation({
    mutationFn: (state: string) => devicesApi.updateLifecycle(device.id, state),
    onSuccess: () => { message.success('Yaşam döngüsü güncellendi'); refresh() },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Güncellenemedi'),
  })
  const deleteMut = useMutation({
    mutationFn: () => devicesApi.delete(device.id),
    onSuccess: () => {
      message.success('Cihaz silindi')
      qc.invalidateQueries({ queryKey: ['devices'] })
      navigate('/devices')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silinemedi'),
  })

  const ident = (
    <Space size={4}>
      <Tag color="blue" style={{ fontFamily: 'var(--font-mono, monospace)' }}>{device.hostname}</Tag>
      <code style={{ fontSize: 11 }}>{device.ip_address}</code>
    </Space>
  )

  return (
    <div style={{ padding: '8px 0 16px', maxWidth: 880 }}>
      {!canWrite && (
        <Alert
          type="info" showIcon style={{ marginBottom: 16, fontSize: 12 }}
          message="Salt-okunur. Aksiyon (test/bilgi-çek/lifecycle/sil) için org_admin+ rolü gerekir."
        />
      )}

      <Card size="small" title="Çalıştırma" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Tooltip title="SSH/SNMP üzerinden hızlı ping/bağlantı testi.">
            <Button icon={<ApiOutlined />} loading={testMut.isPending} onClick={() => testMut.mutate()}>
              Bağlantı Testi
            </Button>
          </Tooltip>
          <Tooltip title="Cihazdan hostname/vendor/os/model/serial gibi temel bilgileri yenile.">
            <Button icon={<SyncOutlined />} disabled={!canWrite} loading={infoMut.isPending} onClick={() => infoMut.mutate()}>
              Bilgi Çek
            </Button>
          </Tooltip>
          <Tooltip title="Manuel backup (Config Backup sekmesinde de var).">
            <Button icon={<HeartOutlined />} onClick={() => navigate(`?tab=backup`)}>
              Backup Sekmesi
            </Button>
          </Tooltip>
        </Space>
      </Card>

      <Card size="small" title="Yaşam Döngüsü" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            value={nextLifecycle}
            onChange={(v) => setNextLifecycle(v)}
            options={LIFECYCLE_OPTIONS}
            style={{ width: 280 }}
            disabled={!canWrite}
          />
          <Popconfirm
            title={<span>{ident} → <strong>{nextLifecycle}</strong> olarak güncellensin mi?</span>}
            okText="Güncelle" onConfirm={() => lifecycleMut.mutate(nextLifecycle)}
            disabled={!canWrite || nextLifecycle === (device as any).lifecycle_status}
          >
            <Button type="primary" disabled={!canWrite || nextLifecycle === (device as any).lifecycle_status} loading={lifecycleMut.isPending}>
              Uygula
            </Button>
          </Popconfirm>
        </Space>
      </Card>

      <Card size="small" title="Yer / Arşiv" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Tooltip title="Lokasyon taşı işlemi cihaz listesindeki 'Lokasyona Taşı' modal'ı ile yapılır.">
            <Button icon={<EnvironmentOutlined />} disabled={!canWrite}
              onClick={() => message.info('Devices listesinde "Lokasyona Taşı" işlemini kullanın')}>
              Lokasyona Taşı
            </Button>
          </Tooltip>
          <Popconfirm
            title={<span>{ident} arşive alınsın mı? (Listede gizlenir, geri çıkarılabilir.)</span>}
            okText="Arşive Al" onConfirm={() => lifecycleMut.mutate('archived')}
            disabled={!canWrite}
          >
            <Button icon={<InboxOutlined />} disabled={!canWrite}>Arşive Al</Button>
          </Popconfirm>
        </Space>
      </Card>

      <Card size="small" title={<span style={{ color: '#cf1322' }}>Tehlikeli Bölge</span>}
        styles={{ header: { background: '#fff1f0' } }} style={{ marginBottom: 16 }}>
        <Space wrap>
          <Tooltip title="Gerçek port kapatma / quarantine C5 (approval + kill-switch) ile gelecek. Şu an UI placeholder.">
            <Button icon={<PoweroffOutlined />} disabled>
              Port Shutdown / Quarantine
            </Button>
          </Tooltip>
          <Popconfirm
            title={<span>{ident} <strong>kalıcı olarak silinsin</strong> mi? Bu işlem geri alınamaz.</span>}
            okText="Sil" okButtonProps={{ danger: true }}
            onConfirm={() => deleteMut.mutate()}
            disabled={!canWrite}
          >
            <Button icon={<DeleteOutlined />} danger disabled={!canWrite} loading={deleteMut.isPending}>
              Cihazı Sil
            </Button>
          </Popconfirm>
          <Button icon={<ReloadOutlined />} onClick={refresh}>
            Sayfayı Yenile
          </Button>
        </Space>
      </Card>
    </div>
  )
}
