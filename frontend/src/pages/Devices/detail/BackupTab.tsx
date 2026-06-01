/**
 * T10 C7 Dalga 1 — Device Detail > Config Backup sekmesi (alt-tab refactor).
 *
 * Üstte iki alt-tab:
 *  - "Canlı"    → <LiveConfigTab>   running-config + kopyala + Güvenlik Tarama
 *  - "Yedekler" → backup tarihçesi + drift alert + content preview + 2-way diff
 *
 * Yedekler genişletmesi:
 *  - Drift alert (devicesApi.getConfigDrift) — header banner
 *  - Satır click → content preview Drawer (devicesApi.getBackupContent)
 *  - Multi-select + 2 backup seçili ise "Diff" buton → DiffViewerDrawer (lazy-load)
 *
 * Kaynaklar:
 *  - devicesApi.getBackups(id) · downloadBackup · takeBackup · setGoldenBackup
 *  - devicesApi.getConfigDrift(id) · getBackupContent · getConfigDiff
 *
 * Viewer: tablo + indirme; takeBackup/setGolden gizli.
 */
import { useState, lazy, Suspense } from 'react'
import {
  Table, Tag, Button, Space, Typography, Popconfirm, Tabs, Alert, Drawer, Spin, App,
  Modal, Progress,
} from 'antd'
import {
  ReloadOutlined, DownloadOutlined, SaveOutlined, StarOutlined, StarFilled,
  DiffOutlined, ThunderboltOutlined, WarningOutlined, FileTextOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Device, ConfigBackup } from '@/types'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'
import dayjs from 'dayjs'
import LiveConfigTab from './LiveConfigTab'

// Lazy-load: react-diff-viewer-continued (~30KB gzip) yalnız Drawer açılınca indirilir.
const DiffViewerDrawer = lazy(() => import('./DiffViewerDrawer'))

const { Text } = Typography

function fmtSize(b: number) {
  if (!b) return '—'
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(1)}MB`
}

export default function BackupTab({ device }: { device: Device }) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const { isOrgAdmin } = useAuthStore()
  const canWrite = isOrgAdmin()
  const [activeMode, setActiveMode] = useState<'live' | 'backups'>('backups')
  const [selectedKeys, setSelectedKeys] = useState<number[]>([])
  const [previewBackup, setPreviewBackup] = useState<ConfigBackup | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffFrom, setDiffFrom] = useState<ConfigBackup | null>(null)
  const [diffTo, setDiffTo] = useState<ConfigBackup | null>(null)
  // Backup snapshot üzerinde Güvenlik Tarama (backend genişlemesi: backup_id param)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [policyBackup, setPolicyBackup] = useState<ConfigBackup | null>(null)

  const q = useQuery({
    queryKey: ['device-backups', device.id],
    queryFn: () => devicesApi.getBackups(device.id),
    enabled: device.id > 0 && activeMode === 'backups',
    staleTime: 30_000,
  })

  const driftQ = useQuery({
    queryKey: ['device-config-drift', device.id],
    queryFn: () => devicesApi.getConfigDrift(device.id),
    enabled: device.id > 0 && activeMode === 'backups',
    staleTime: 60_000,
  })

  const previewQ = useQuery({
    queryKey: ['backup-content', device.id, previewBackup?.id],
    queryFn: () => devicesApi.getBackupContent(device.id, previewBackup!.id),
    enabled: !!previewBackup,
    staleTime: 5 * 60_000,
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['device-backups', device.id] })
    qc.invalidateQueries({ queryKey: ['device-config-drift', device.id] })
  }

  const takeMut = useMutation({
    mutationFn: () => devicesApi.takeBackup(device.id),
    onSuccess: () => {
      message.success('Backup alındı')
      invalidate()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Backup başarısız'),
  })

  const goldenMut = useMutation({
    mutationFn: (backupId: number) => devicesApi.setGoldenBackup(device.id, backupId),
    onSuccess: () => {
      message.success('Altın backup işaretlendi')
      invalidate()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'İşaretleme başarısız'),
  })

  // Backup snapshot üzerinde policy check — backend backup_id paramini destekliyor.
  const checkBackupPolicyMut = useMutation({
    mutationFn: (backupId: number) => devicesApi.checkConfigPolicy(device.id, backupId),
    onSuccess: () => setPolicyOpen(true),
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Politika kontrolü başarısız'),
  })

  const triggerPolicyCheck = (b: ConfigBackup) => {
    setPolicyBackup(b)
    checkBackupPolicyMut.mutate(b.id)
  }

  const items = q.data ?? []

  const openDiff = () => {
    if (selectedKeys.length !== 2) return
    const a = items.find((i) => i.id === selectedKeys[0])
    const b = items.find((i) => i.id === selectedKeys[1])
    if (!a || !b) return
    // Eski → Yeni sırası (created_at küçük olan = from)
    const sorted = dayjs(a.created_at).isBefore(b.created_at) ? [a, b] : [b, a]
    setDiffFrom(sorted[0])
    setDiffTo(sorted[1])
    setDiffOpen(true)
  }

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
    { title: 'Aksiyon', key: 'a', width: 280,
      render: (_: any, r: ConfigBackup) => (
        <Space size="small" onClick={(e) => e.stopPropagation()}>
          <Button size="small" icon={<FileTextOutlined />} onClick={() => setPreviewBackup(r)}>
            İçerik
          </Button>
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
      <Tabs
        activeKey={activeMode}
        onChange={(k) => setActiveMode(k as 'live' | 'backups')}
        items={[
          {
            key: 'live',
            label: <span><ThunderboltOutlined /> Canlı</span>,
            children: <LiveConfigTab device={device} />,
          },
          {
            key: 'backups',
            label: <span><SaveOutlined /> Yedekler ({items.length})</span>,
            children: (
              <div>
                {/* Wave 2 #2 F4 — Drift alert mockup pages-devices.jsx:435-460 paterni
                    (warn-soft background, ⚠ ikonu, vurgulu başlık). */}
                {driftQ.data?.drift_detected && (
                  <div style={{
                    padding: '10px 14px',
                    background: 'var(--warn-soft)',
                    border: '1px solid oklch(from var(--warn) l c h / 0.35)',
                    borderRadius: 8,
                    marginBottom: 14,
                    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  }}>
                    <WarningOutlined style={{ color: 'var(--warn)', fontSize: 18 }} />
                    <strong style={{ color: 'var(--warn)' }}>Config drift tespit edildi</strong>
                    <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                      Cihazın güncel konfigürasyonu altın baseline'dan farklı:
                    </span>
                    <span className="nm-pill ok">+{driftQ.data.lines_added ?? 0} satır</span>
                    <span className="nm-pill crit">−{driftQ.data.lines_removed ?? 0} satır</span>
                    {driftQ.data.golden_created_at && (
                      <span style={{ fontSize: 11.5, color: 'var(--fg-3)', marginLeft: 'auto' }}>
                        Altın: {dayjs(driftQ.data.golden_created_at).format('YYYY-MM-DD HH:mm')}
                      </span>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                  <Text strong>Config Backup tarihçesi</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{items.length} kayıt</Text>
                  {selectedKeys.length > 0 && (
                    <Tag color="blue">{selectedKeys.length} seçili</Tag>
                  )}
                  <Space style={{ marginLeft: 'auto' }} wrap>
                    {selectedKeys.length === 2 && (
                      <Button type="primary" icon={<DiffOutlined />} onClick={openDiff}>
                        Diff Görüntüle
                      </Button>
                    )}
                    {selectedKeys.length > 0 && selectedKeys.length !== 2 && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        Diff için tam 2 backup seçin
                      </Text>
                    )}
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
                    <Button icon={<ReloadOutlined />} onClick={invalidate} loading={q.isLoading}>
                      Yenile
                    </Button>
                  </Space>
                </div>

                <Table
                  size="small" rowKey="id" columns={columns as any} dataSource={items}
                  loading={q.isLoading}
                  pagination={{ pageSize: 25, showSizeChanger: false, hideOnSinglePage: true }}
                  locale={{ emptyText: 'Backup yok' }}
                  rowSelection={{
                    selectedRowKeys: selectedKeys,
                    onChange: (keys) => setSelectedKeys(keys as number[]),
                    type: 'checkbox',
                    columnWidth: 36,
                    preserveSelectedRowKeys: false,
                  }}
                  onRow={(r) => ({
                    onClick: () => setPreviewBackup(r),
                    style: { cursor: 'pointer' },
                  })}
                />

                {!canWrite && (
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                    Backup alma ve altın işaretleme için org_admin+ rolü gerekir; indirme + içerik görüntüleme + diff herkese açık.
                  </Text>
                )}
              </div>
            ),
          },
        ]}
      />

      {/* Content preview drawer */}
      <Drawer
        title={previewBackup
          ? <Space size={8}>
              <span>Backup #{previewBackup.id}</span>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {dayjs(previewBackup.created_at).format('YYYY-MM-DD HH:mm')}
              </Text>
              {previewBackup.is_golden && <Tag color="gold"><StarFilled /> Altın</Tag>}
            </Space>
          : ''}
        open={!!previewBackup}
        onClose={() => setPreviewBackup(null)}
        width={Math.min(900, typeof window !== 'undefined' ? window.innerWidth - 60 : 900)}
        extra={previewBackup && (
          <Space>
            <Button
              icon={<SafetyCertificateOutlined />}
              loading={checkBackupPolicyMut.isPending && policyBackup?.id === previewBackup.id}
              onClick={() => triggerPolicyCheck(previewBackup)}
              disabled={!previewQ.data?.config}
            >
              Güvenlik Tarama
            </Button>
            <Button icon={<DownloadOutlined />}
              onClick={() => devicesApi.downloadBackup(device.id, previewBackup.id)}>
              İndir
            </Button>
          </Space>
        )}
      >
        <Spin spinning={previewQ.isLoading}>
          {previewQ.data?.config ? (
            <pre style={{
              background: 'var(--bg-1, #0d1117)',
              color: 'var(--fg-0, #c9d1d9)',
              border: '1px solid var(--line-soft, #1e2a3a)',
              borderRadius: 6,
              padding: 12,
              fontSize: 12,
              fontFamily: 'var(--font-mono, ui-monospace, "JetBrains Mono", monospace)',
              maxHeight: 'calc(100vh - 200px)',
              overflow: 'auto',
              margin: 0,
              whiteSpace: 'pre',
            }}>{previewQ.data.config}</pre>
          ) : !previewQ.isLoading ? (
            <Text type="secondary">İçerik boş veya alınamadı.</Text>
          ) : null}
        </Spin>
      </Drawer>

      {/* Diff Viewer (lazy) */}
      {diffOpen && (
        <Suspense fallback={null}>
          <DiffViewerDrawer
            open={diffOpen}
            onClose={() => setDiffOpen(false)}
            device={device}
            fromBackup={diffFrom}
            toBackup={diffTo}
          />
        </Suspense>
      )}

      {/* Backup snapshot — Güvenlik Politika Kontrolü modal */}
      <Modal
        title={
          <Space>
            <SafetyCertificateOutlined /> Güvenlik Politika Kontrolü
            {policyBackup && (
              <Text type="secondary" style={{ fontSize: 13 }}>
                — Backup #{policyBackup.id} ({dayjs(policyBackup.created_at).format('YYYY-MM-DD HH:mm')})
              </Text>
            )}
          </Space>
        }
        open={policyOpen}
        onCancel={() => setPolicyOpen(false)}
        footer={<Button onClick={() => setPolicyOpen(false)}>Kapat</Button>}
        width={640}
      >
        {checkBackupPolicyMut.data && (() => {
          const d = checkBackupPolicyMut.data
          const scoreColor = d.policy_score >= 80 ? '#52c41a' : d.policy_score >= 60 ? '#faad14' : '#ff4d4f'
          return (
            <>
              <Alert
                type="info" showIcon style={{ marginBottom: 12, fontSize: 12 }}
                message={`Tarama kaynağı: ${d.source}`}
                description="Bu backup snapshot'ı üzerinde yapılan offline policy taraması — canlı cihaz erişimi gerekmez."
              />
              <div style={{ textAlign: 'center', marginBottom: 20 }}>
                <div style={{ fontSize: 48, fontWeight: 700, color: scoreColor, lineHeight: 1 }}>
                  {d.policy_score}
                </div>
                <div style={{ color: '#888', marginBottom: 8 }}>Politika Puanı / 100</div>
                <Progress
                  percent={d.policy_score}
                  strokeColor={scoreColor}
                  showInfo={false}
                  style={{ maxWidth: 300, margin: '0 auto' }}
                />
                <Space style={{ marginTop: 8 }}>
                  {d.critical_count > 0 && <Tag color="red">{d.critical_count} Kritik</Tag>}
                  {d.violation_count > 0 && <Tag color="orange">{d.violation_count} İhlal</Tag>}
                  {d.violation_count === 0 && <Tag color="green">Tüm kurallar geçti</Tag>}
                </Space>
              </div>
              {d.violations.length > 0 && (
                <Table
                  dataSource={d.violations}
                  rowKey="rule_id"
                  size="small"
                  pagination={false}
                  columns={[
                    {
                      title: 'Önem', dataIndex: 'severity', width: 90,
                      render: (v: string) => (
                        <Tag color={v === 'critical' ? 'red' : v === 'warning' ? 'orange' : 'default'} icon={<WarningOutlined />}>
                          {v}
                        </Tag>
                      ),
                    },
                    { title: 'Kural', dataIndex: 'rule_id', width: 160 },
                    { title: 'Açıklama', dataIndex: 'description' },
                  ]}
                />
              )}
            </>
          )
        })()}
      </Modal>
    </div>
  )
}
