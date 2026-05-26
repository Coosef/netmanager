// T9 Tur 8 — Firmware management page.
// Tabs: Catalog (artifacts) | Install Jobs (state-machine view).
import { useEffect, useMemo, useState } from 'react'
import {
  Alert, App, Button, Card, Col, Drawer, Form, Input,
  Modal, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Tooltip,
  Typography, Upload, type UploadFile,
} from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined, CloudUploadOutlined,
  DeleteOutlined, FileTextOutlined, LinkOutlined,
  LoadingOutlined, RocketOutlined, SafetyOutlined,
  SyncOutlined, ThunderboltOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  firmwareApi, type FirmwareArtifact, type FirmwareInstallJob,
  type InstallStatus,
} from '@/api/firmware'
import { devicesApi } from '@/api/devices'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuthStore } from '@/store/auth'
import type { Device } from '@/types'
import dayjs from 'dayjs'

const { Text } = Typography

function mkC(isDark: boolean) {
  return {
    bg: isDark ? '#1e293b' : '#ffffff',
    bg2: isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text: isDark ? '#f1f5f9' : '#1e293b',
    muted: isDark ? '#64748b' : '#94a3b8',
    dim: isDark ? '#475569' : '#cbd5e1',
  }
}

const SEVERITY_COLOR: Record<string, string> = {
  maintenance: 'default', major: 'orange', critical_cve: 'red',
}

const STATUS_COLOR: Record<InstallStatus, string> = {
  pending: 'default', transferring: 'processing', transferred: 'blue',
  awaiting_reload: 'gold', reloading: 'processing', verifying: 'processing',
  success: 'green', failed: 'red', cancelled: 'default',
}

const STATUS_LABEL: Record<InstallStatus, string> = {
  pending: 'Bekliyor', transferring: 'Aktarılıyor', transferred: 'Aktarıldı',
  awaiting_reload: 'Reload onayı bekliyor', reloading: 'Yeniden başlatılıyor',
  verifying: 'Doğrulanıyor', success: 'Başarılı', failed: 'Başarısız',
  cancelled: 'İptal',
}

// ─── Upload modal ─────────────────────────────────────────────────────────

function UploadArtifactModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [file, setFile] = useState<UploadFile | null>(null)

  const mut = useMutation({
    mutationFn: async (vals: any) => {
      if (!file?.originFileObj) throw new Error('Dosya seçilmedi')
      const fd = new FormData()
      fd.append('file', file.originFileObj as Blob, file.name)
      Object.entries(vals).forEach(([k, v]) => {
        if (v !== undefined && v !== null) fd.append(k, String(v))
      })
      return firmwareApi.uploadArtifact(fd)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['firmware-artifacts'] })
      message.success('Firmware yüklendi')
      setFile(null)
      onClose()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || e?.message || 'Yükleme başarısız', 6),
  })

  return (
    <Modal
      open={open}
      onCancel={() => { setFile(null); onClose() }}
      title={<Space><CloudUploadOutlined />Firmware Yükle</Space>}
      onOk={() => form.submit()}
      confirmLoading={mut.isPending}
      okText="Yükle"
      width={560}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={(v) => mut.mutate(v)}>
        <Form.Item label="Dosya" required>
          <Upload
            beforeUpload={(f) => { setFile({ uid: '-1', name: f.name, originFileObj: f as any }); return false }}
            onRemove={() => setFile(null)}
            fileList={file ? [file] : []}
            maxCount={1}
            accept=".bin,.img,.tar,.swi,.upg,.zip"
          >
            <Button icon={<CloudUploadOutlined />}>Dosya seç</Button>
          </Upload>
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="name" label="Ad" rules={[{ required: true }]}>
              <Input placeholder="Cisco IOS 15.2(4)E10" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="version" label="Versiyon" rules={[{ required: true }]}>
              <Input placeholder="15.2(4)E10" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="vendor" label="Vendor" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'cisco', label: 'Cisco' },
                  { value: 'aruba', label: 'Aruba' },
                  { value: 'ruijie', label: 'Ruijie' },
                  { value: 'hp', label: 'HP / HPE' },
                  { value: 'comware', label: 'H3C / Comware' },
                ]}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="os_type" label="OS Type" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'cisco_ios', label: 'cisco_ios' },
                  { value: 'cisco_xe', label: 'cisco_xe' },
                  { value: 'cisco_nxos', label: 'cisco_nxos' },
                  { value: 'aruba_osswitch', label: 'aruba_osswitch' },
                  { value: 'aruba_aoscx', label: 'aruba_aoscx' },
                  { value: 'hp_procurve', label: 'hp_procurve' },
                  { value: 'ruijie_os', label: 'ruijie_os' },
                  { value: 'comware', label: 'comware' },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="model" label="Model (ops.)">
              <Input placeholder="Catalyst 2960X" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="severity" label="Önem" initialValue="maintenance">
              <Select
                options={[
                  { value: 'maintenance', label: 'Maintenance' },
                  { value: 'major', label: 'Major' },
                  { value: 'critical_cve', label: 'Critical / CVE' },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="release_notes_url" label="Release Notes URL">
          <Input placeholder="https://…" />
        </Form.Item>
        <Form.Item name="notes" label="Notlar">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─── URL artifact modal ───────────────────────────────────────────────────

function UrlArtifactModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const [form] = Form.useForm()

  const mut = useMutation({
    mutationFn: (vals: any) => firmwareApi.createUrlArtifact(vals),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['firmware-artifacts'] })
      message.success('URL artifact kataloglandı')
      onClose()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata', 6),
  })

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={<Space><LinkOutlined />URL ile Katalogla</Space>}
      onOk={() => form.submit()}
      confirmLoading={mut.isPending}
      okText="Ekle"
      width={560}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        message="Cihaz, install sırasında bu URL'den çeker."
        description="HTTP/TFTP/SCP destekli. Backend disk'inde dosya saklanmaz."
        style={{ marginBottom: 12 }}
      />
      <Form form={form} layout="vertical" onFinish={(v) => mut.mutate(v)}>
        <Form.Item name="source_url" label="Kaynak URL" rules={[{ required: true }]}>
          <Input placeholder="tftp://10.0.0.50/c2960-universal.bin" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="name" label="Ad" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="version" label="Versiyon" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="vendor" label="Vendor" rules={[{ required: true }]}>
              <Select
                options={['cisco','aruba','ruijie','hp','comware'].map((v) => ({ value: v, label: v }))}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="os_type" label="OS Type" rules={[{ required: true }]}>
              <Select
                options={['cisco_ios','cisco_xe','cisco_nxos','aruba_osswitch','aruba_aoscx','hp_procurve','ruijie_os','comware']
                  .map((v) => ({ value: v, label: v }))}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="model" label="Model (ops.)">
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="severity" label="Önem" initialValue="maintenance">
              <Select
                options={[
                  { value: 'maintenance', label: 'Maintenance' },
                  { value: 'major', label: 'Major' },
                  { value: 'critical_cve', label: 'Critical / CVE' },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="sha256" label="SHA256 (ops. — vendor sayfasından)">
          <Input placeholder="64 hex karakter" maxLength={64} />
        </Form.Item>
        <Form.Item name="notes" label="Notlar">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─── Install modal ────────────────────────────────────────────────────────

function InstallStartModal({
  open, onClose, artifact,
}: { open: boolean; onClose: () => void; artifact: FirmwareArtifact | null }) {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [method, setMethod] = useState<'scp' | 'tftp' | 'agent'>('scp')

  useEffect(() => { if (open) { setDeviceId(null); setMethod('scp') } }, [open])

  const { data: devicesData } = useQuery({
    queryKey: ['devices-for-firmware', artifact?.os_type],
    queryFn: () => devicesApi.list({ limit: 500 }),
    enabled: open,
  })

  const candidates = useMemo(() => {
    if (!artifact || !devicesData) return [] as Device[]
    return (devicesData.items || []).filter((d: Device) => d.os_type === artifact.os_type)
  }, [artifact, devicesData])

  const mut = useMutation({
    mutationFn: () => firmwareApi.startInstall(artifact!.id, deviceId!, method, true),
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: ['firmware-jobs'] })
      message.success(`Install başlatıldı — job #${job.id}`)
      onClose()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata', 6),
  })

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <Space>
          <RocketOutlined style={{ color: '#3b82f6' }} />
          Firmware Install — {artifact?.name}
        </Space>
      }
      onOk={() => mut.mutate()}
      okButtonProps={{ disabled: !deviceId || !artifact, loading: mut.isPending }}
      okText="Install Başlat"
      width={620}
      destroyOnClose
    >
      <Alert
        type="warning"
        showIcon
        icon={<SafetyOutlined />}
        message="Reload onayı ayrı bir adımdır."
        description="Worker; dosyayı kopyalar, boot image set eder, save komutunu çalıştırır ve durur. Reload için kuyruktan operatör onayı gerekir."
        style={{ marginBottom: 12 }}
      />
      <Form layout="vertical">
        <Form.Item label="Hedef cihaz" required>
          <Select
            showSearch
            placeholder="Aynı OS-type'tan cihaz seçin"
            value={deviceId ?? undefined}
            onChange={(v) => setDeviceId(v)}
            options={candidates.map((d) => ({
              value: d.id,
              label: `${d.hostname} — ${d.ip_address} (${d.os_type})`,
              disabled: d.status === 'offline',
            }))}
            optionFilterProp="label"
          />
          {artifact && candidates.length === 0 && (
            <Text style={{ color: '#ef4444', fontSize: 12 }}>
              {artifact.os_type} OS-type'a sahip aktif cihaz yok.
            </Text>
          )}
        </Form.Item>
        <Form.Item label="Transfer yöntemi">
          <Select
            value={method}
            onChange={(v) => setMethod(v)}
            options={[
              { value: 'scp', label: 'SCP (önerilen — şifreli)' },
              { value: 'tftp', label: 'TFTP (eski cihazlar)' },
              { value: 'agent', label: 'Agent ile transfer' },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─── Job detail drawer ────────────────────────────────────────────────────

function JobDetailDrawer({
  jobId, open, onClose, isDark,
}: { jobId: number | null; open: boolean; onClose: () => void; isDark: boolean }) {
  const C = mkC(isDark)
  const qc = useQueryClient()
  const { message } = App.useApp()
  const canPush = useAuthStore((s) => s.can('config_backups', 'edit'))

  const { data: job } = useQuery({
    queryKey: ['firmware-job', jobId],
    queryFn: () => firmwareApi.getJob(jobId!),
    enabled: open && jobId !== null,
    refetchInterval: (q) => {
      const s = (q.state.data as { status?: InstallStatus } | undefined)?.status
      return s && ['transferring', 'transferred', 'reloading', 'verifying'].includes(s) ? 3000 : 8000
    },
  })

  const approve = useMutation({
    mutationFn: () => firmwareApi.approveReload(jobId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['firmware-job', jobId] })
      qc.invalidateQueries({ queryKey: ['firmware-jobs'] })
      message.success('Reload onaylandı — worker devam ediyor')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata', 6),
  })

  const cancel = useMutation({
    mutationFn: () => firmwareApi.cancelJob(jobId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['firmware-job', jobId] })
      qc.invalidateQueries({ queryKey: ['firmware-jobs'] })
      message.success('Job iptal edildi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata', 6),
  })

  if (!job) return null

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={760}
      title={
        <Space>
          <RocketOutlined style={{ color: '#3b82f6' }} />
          <Text strong>Install Job #{job.id}</Text>
          <Tag color={STATUS_COLOR[job.status] as any}>{STATUS_LABEL[job.status]}</Tag>
        </Space>
      }
      extra={
        <Space>
          {job.status === 'awaiting_reload' && canPush && (
            <Popconfirm
              title="Cihaz reboot edilsin mi?"
              description="Cihaz birkaç dakika kapanır. Trafik etkilenir."
              onConfirm={() => approve.mutate()}
              okButtonProps={{ danger: true }}
            >
              <Button danger type="primary" icon={<ThunderboltOutlined />} loading={approve.isPending}>
                Reload'ı Onayla
              </Button>
            </Popconfirm>
          )}
          {!['success', 'failed', 'cancelled'].includes(job.status) && canPush && (
            <Popconfirm title="Job iptal edilsin mi?" onConfirm={() => cancel.mutate()}>
              <Button icon={<CloseCircleOutlined />}>İptal</Button>
            </Popconfirm>
          )}
        </Space>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 12 }}>
        <Card size="small" style={{ background: C.bg2, border: `1px solid ${C.border}` }}>
          <Text style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>PRE-VERSION</Text>
          <div style={{ fontSize: 13, color: C.text, fontFamily: 'monospace' }}>
            {job.pre_version || '—'}
          </div>
        </Card>
        <Card size="small" style={{ background: C.bg2, border: `1px solid ${C.border}` }}>
          <Text style={{ fontSize: 10, color: C.muted, fontWeight: 600 }}>POST-VERSION</Text>
          <div style={{ fontSize: 13, color: job.post_version ? '#22c55e' : C.text, fontFamily: 'monospace' }}>
            {job.post_version || '—'}
          </div>
        </Card>
      </div>

      {job.error && (
        <Alert type="error" showIcon message={job.error} style={{ marginBottom: 12 }} />
      )}

      <Text strong style={{ color: C.text }}>Log</Text>
      <div style={{
        background: isDark ? '#0d1117' : '#f8fafc',
        border: `1px solid ${C.border}`,
        borderRadius: 6, padding: 8,
        maxHeight: 500, overflowY: 'auto',
        marginTop: 6,
        fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6,
      }}>
        {(job.log || []).map((entry, i) => {
          const color = entry.level === 'error' ? '#ef4444'
            : entry.level === 'warn' ? '#f59e0b'
            : entry.level === 'cmd' ? '#22c55e' : C.muted
          return (
            <div key={i} style={{ color }}>
              <Text style={{ color: C.dim, fontSize: 10 }}>
                {dayjs(entry.ts).format('HH:mm:ss')}
              </Text>
              <Text style={{ color, marginLeft: 8 }}>[{entry.stage}]</Text>
              <Text style={{ color, marginLeft: 8 }}>{entry.message}</Text>
            </div>
          )
        })}
        {(job.log || []).length === 0 && (
          <Text style={{ color: C.dim }}>Henüz log yok…</Text>
        )}
      </div>
    </Drawer>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function FirmwarePage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const { message } = App.useApp()
  const qc = useQueryClient()
  const canPush = useAuthStore((s) => s.can('config_backups', 'edit'))

  const [uploadOpen, setUploadOpen] = useState(false)
  const [urlOpen, setUrlOpen] = useState(false)
  const [installArtifact, setInstallArtifact] = useState<FirmwareArtifact | null>(null)
  const [drilldownJobId, setDrilldownJobId] = useState<number | null>(null)

  const { data: artifacts = [] } = useQuery({
    queryKey: ['firmware-artifacts'],
    queryFn: () => firmwareApi.listArtifacts(),
  })
  const { data: jobs = [] } = useQuery({
    queryKey: ['firmware-jobs'],
    queryFn: () => firmwareApi.listJobs({ limit: 100 }),
    refetchInterval: 5000,
  })
  const { data: devicesData } = useQuery({
    queryKey: ['devices-for-fw-page'],
    queryFn: () => devicesApi.list({ limit: 500 }),
    staleTime: 60_000,
  })
  const devicesById = useMemo(
    () => Object.fromEntries((devicesData?.items || []).map((d: Device) => [d.id, d])),
    [devicesData],
  )

  const delMut = useMutation({
    mutationFn: firmwareApi.deleteArtifact,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['firmware-artifacts'] })
      message.success('Artifact silindi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata', 6),
  })

  const artifactCols = [
    {
      title: 'Firmware', dataIndex: 'name',
      render: (v: string, r: FirmwareArtifact) => (
        <div>
          <Text strong style={{ color: C.text }}>{v}</Text>
          <div style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>
            v{r.version}{r.model ? ` · ${r.model}` : ''}
          </div>
        </div>
      ),
    },
    { title: 'Vendor', dataIndex: 'vendor', width: 100,
      render: (v: string, r: FirmwareArtifact) => (
        <Space size={4} direction="vertical" style={{ gap: 0 }}>
          <Tag>{v}</Tag>
          <Text style={{ fontSize: 10, color: C.dim }}>{r.os_type}</Text>
        </Space>
      ) },
    {
      title: 'Önem', dataIndex: 'severity', width: 110,
      render: (v: string) => <Tag color={SEVERITY_COLOR[v] || 'default'}>{v}</Tag>,
    },
    {
      title: 'Kaynak', dataIndex: 'source_type', width: 130,
      render: (v: string, r: FirmwareArtifact) => v === 'uploaded' ? (
        <Space size={4}>
          <CloudUploadOutlined style={{ color: '#22c55e' }} />
          <Text style={{ fontSize: 11 }}>{r.file_size_bytes ? `${(r.file_size_bytes / 1024 / 1024).toFixed(1)} MB` : '—'}</Text>
        </Space>
      ) : (
        <Tooltip title={r.source_url || ''}>
          <Space size={4}>
            <LinkOutlined style={{ color: '#3b82f6' }} />
            <Text style={{ fontSize: 11 }}>URL</Text>
          </Space>
        </Tooltip>
      ),
    },
    {
      title: 'SHA256', dataIndex: 'sha256', width: 140,
      render: (v: string | null, r: FirmwareArtifact) => v ? (
        <Tooltip title={v}>
          <Space size={4}>
            {r.checksum_verified
              ? <CheckCircleOutlined style={{ color: '#22c55e' }} />
              : <WarningOutlined style={{ color: '#f59e0b' }} />}
            <Text style={{ fontSize: 10, fontFamily: 'monospace' }}>{v.slice(0, 12)}…</Text>
          </Space>
        </Tooltip>
      ) : <Text style={{ color: C.dim }}>—</Text>,
    },
    {
      title: '', width: 140,
      render: (_: unknown, r: FirmwareArtifact) => (
        <Space size={4}>
          <Tooltip title="Cihaza Install">
            <Button
              size="small"
              type="primary"
              icon={<RocketOutlined />}
              disabled={!canPush}
              onClick={() => setInstallArtifact(r)}
            >
              Install
            </Button>
          </Tooltip>
          {canPush && (
            <Popconfirm title="Artifact silinsin mi?" onConfirm={() => delMut.mutate(r.id)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  const jobCols = [
    { title: '#', dataIndex: 'id', width: 60 },
    {
      title: 'Cihaz', dataIndex: 'device_id', width: 220,
      render: (id: number) => {
        const d = devicesById[id]
        return d
          ? <div><Text strong>{d.hostname}</Text><div style={{ fontSize: 11, color: C.muted }}>{d.ip_address}</div></div>
          : <Text style={{ color: C.dim }}>#{id}</Text>
      },
    },
    {
      title: 'Firmware', dataIndex: 'artifact_id', width: 220,
      render: (id: number) => {
        const a = artifacts.find((x) => x.id === id)
        return a ? <div><Text>{a.name}</Text><div style={{ fontSize: 11, color: C.muted }}>v{a.version}</div></div> : `#${id}`
      },
    },
    {
      title: 'Durum', dataIndex: 'status', width: 180,
      render: (v: InstallStatus) => (
        <Tag color={STATUS_COLOR[v] as any} icon={
          ['transferring','transferred','reloading','verifying'].includes(v) ? <LoadingOutlined /> :
          v === 'success' ? <CheckCircleOutlined /> :
          v === 'failed' ? <CloseCircleOutlined /> :
          v === 'awaiting_reload' ? <ThunderboltOutlined /> : undefined
        }>{STATUS_LABEL[v]}</Tag>
      ),
    },
    {
      title: 'Versiyon', width: 220,
      render: (_: unknown, r: FirmwareInstallJob) => (
        <Text style={{ fontFamily: 'monospace', fontSize: 11 }}>
          {r.pre_version || '?'} → {r.post_version || '?'}
        </Text>
      ),
    },
    {
      title: 'Başladı', dataIndex: 'created_at', width: 130,
      render: (v: string) => <Text style={{ fontSize: 11, color: C.muted }}>{dayjs(v).format('DD.MM HH:mm')}</Text>,
    },
    {
      title: '', width: 80,
      render: (_: unknown, r: FirmwareInstallJob) => (
        <Button size="small" icon={<FileTextOutlined />} onClick={() => setDrilldownJobId(r.id)}>
          Log
        </Button>
      ),
    },
  ]

  const activeJobs = jobs.filter((j) => !['success','failed','cancelled'].includes(j.status))

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Ağ Operasyonları</span><span>Firmware</span></div>
          <h1 className="nm-page-title">
            Firmware Yönetimi
            <span className="nm-pill mono">{artifacts.length} artifact</span>
            <span className="nm-pill mono">{activeJobs.length} aktif job</span>
            <Tag color="purple" style={{ fontSize: 10, fontWeight: 600 }}>T9 Tur 8</Tag>
          </h1>
          <div className="nm-page-sub">
            Firmware kataloğu (upload + URL) · per-cihaz manuel push · reload operatör onaylı.
          </div>
        </div>
        <Space>
          <Button icon={<LinkOutlined />} onClick={() => setUrlOpen(true)} disabled={!canPush}>
            URL Katalogla
          </Button>
          <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => setUploadOpen(true)} disabled={!canPush}>
            Dosya Yükle
          </Button>
        </Space>
      </div>

      <Tabs
        defaultActiveKey="catalog"
        items={[
          {
            key: 'catalog',
            label: <Space size={4}><CloudUploadOutlined />Katalog ({artifacts.length})</Space>,
            children: (
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                <Table
                  dataSource={artifacts}
                  rowKey="id"
                  columns={artifactCols}
                  size="small"
                  pagination={{ pageSize: 50, showSizeChanger: false }}
                  locale={{ emptyText: 'Henüz firmware artifact yok. Dosya yükleyin veya URL kataloglayın.' }}
                />
              </div>
            ),
          },
          {
            key: 'jobs',
            label: (
              <Space size={4}>
                <SyncOutlined />
                Install Jobs ({jobs.length})
                {activeJobs.length > 0 && <Tag color="processing" style={{ fontSize: 10, margin: 0 }}>{activeJobs.length}</Tag>}
              </Space>
            ),
            children: (
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                <Table
                  dataSource={jobs}
                  rowKey="id"
                  columns={jobCols}
                  size="small"
                  pagination={{ pageSize: 50, showSizeChanger: false }}
                  locale={{ emptyText: 'Henüz install job yok.' }}
                />
              </div>
            ),
          },
        ]}
      />

      <UploadArtifactModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
      <UrlArtifactModal open={urlOpen} onClose={() => setUrlOpen(false)} />
      <InstallStartModal
        open={installArtifact !== null}
        onClose={() => setInstallArtifact(null)}
        artifact={installArtifact}
      />
      <JobDetailDrawer
        jobId={drilldownJobId}
        open={drilldownJobId !== null}
        onClose={() => setDrilldownJobId(null)}
        isDark={isDark}
      />
    </div>
  )
}
