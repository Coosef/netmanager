/**
 * T10 C7.D — Device Detail > Config Backup sekmesi.
 *
 * Kaynaklar:
 *  - devicesApi.getBackups(id)          → cihaz backup tarihçesi
 *  - devicesApi.downloadBackup          → blob indir
 *  - devicesApi.takeBackup              → tetikle (org_admin+)
 *  - devicesApi.setGoldenBackup         → altın işaretle (org_admin+)
 *
 * Viewer: tablo + indirme; takeBackup/setGolden gizli.
 */
import { Table, Tag, Button, Space, Typography, message, Popconfirm } from 'antd'
import { ReloadOutlined, DownloadOutlined, SaveOutlined, StarOutlined, StarFilled } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Device, ConfigBackup } from '@/types'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'
import dayjs from 'dayjs'

const { Text } = Typography

function fmtSize(b: number) {
  if (!b) return '—'
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(1)}MB`
}

export default function BackupTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const { isOrgAdmin } = useAuthStore()
  const canWrite = isOrgAdmin()

  const q = useQuery({
    queryKey: ['device-backups', device.id],
    queryFn: () => devicesApi.getBackups(device.id),
    enabled: device.id > 0,
    staleTime: 30_000,
  })

  const takeMut = useMutation({
    mutationFn: () => devicesApi.takeBackup(device.id),
    onSuccess: () => {
      message.success('Backup alındı')
      qc.invalidateQueries({ queryKey: ['device-backups', device.id] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Backup başarısız'),
  })

  const goldenMut = useMutation({
    mutationFn: (backupId: number) => devicesApi.setGoldenBackup(device.id, backupId),
    onSuccess: () => {
      message.success('Altın backup işaretlendi')
      qc.invalidateQueries({ queryKey: ['device-backups', device.id] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'İşaretleme başarısız'),
  })

  const items = q.data ?? []

  const columns = [
    { title: '', key: 'g', width: 36,
      render: (_: any, r: ConfigBackup) => r.is_golden
        ? <StarFilled style={{ color: '#faad14' }} title="Altın backup" />
        : null },
    { title: 'Tarih', dataIndex: 'created_at', key: 'd', width: 170,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
    { title: 'Boyut', dataIndex: 'size_bytes', key: 's', width: 90,
      render: (b: number) => fmtSize(b) },
    { title: 'Hash', dataIndex: 'config_hash', key: 'h', width: 180,
      render: (v: string) => <code style={{ fontSize: 11 }}>{v?.slice(0, 12) || '—'}</code> },
    { title: 'Notlar', dataIndex: 'notes', key: 'n', ellipsis: true,
      render: (v?: string) => v || '—' },
    { title: 'Aksiyon', key: 'a', width: 220,
      render: (_: any, r: ConfigBackup) => (
        <Space size="small">
          <Button size="small" icon={<DownloadOutlined />} onClick={() => devicesApi.downloadBackup(device.id, r.id)}>
            İndir
          </Button>
          {canWrite && !r.is_golden && (
            <Button size="small" icon={<StarOutlined />} loading={goldenMut.isPending}
              onClick={() => goldenMut.mutate(r.id)}>
              Altın yap
            </Button>
          )}
        </Space>
      ) },
  ]

  return (
    <div style={{ padding: '8px 0 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Text strong>Config Backup tarihçesi</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{items.length} kayıt</Text>
        <Space style={{ marginLeft: 'auto' }}>
          {canWrite && (
            <Popconfirm
              title="Yeni backup al?"
              description={<span><Tag>{device.hostname}</Tag> üzerinde çalışır.</span>}
              okText="Al" onConfirm={() => takeMut.mutate()}
            >
              <Button type="primary" icon={<SaveOutlined />} loading={takeMut.isPending}>
                Şimdi Backup Al
              </Button>
            </Popconfirm>
          )}
          <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries({ queryKey: ['device-backups', device.id] })} loading={q.isLoading}>
            Yenile
          </Button>
        </Space>
      </div>

      <Table
        size="small" rowKey="id" columns={columns as any} dataSource={items}
        loading={q.isLoading}
        pagination={{ pageSize: 25, showSizeChanger: false, hideOnSinglePage: true }}
        locale={{ emptyText: 'Backup yok' }}
      />

      {!canWrite && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          Backup alma ve altın işaretleme için org_admin+ rolü gerekir; indirme herkese açık.
        </Text>
      )}
    </div>
  )
}
