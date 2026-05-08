import { useState, useMemo, useEffect } from 'react'
import {
  Typography, Table, Tag, Button, Space, Row, Col, Card,
  Checkbox, Alert, Tooltip, Progress, App, Popconfirm, Badge,
  Tabs, Modal, Form, Input, Select, TimePicker, Switch, Checkbox as AntCheckbox,
  Divider,
} from 'antd'
import {
  CloudDownloadOutlined, ThunderboltOutlined, CheckCircleOutlined,
  WarningOutlined, CloseCircleOutlined, SyncOutlined, DownloadOutlined,
  LoadingOutlined, DiffOutlined, DatabaseOutlined, PlusOutlined,
  EditOutlined, DeleteOutlined, ClockCircleOutlined, CalendarOutlined,
  PlayCircleOutlined, SearchOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { reportsApi } from '@/api/reports'
import { devicesApi } from '@/api/devices'
import { tasksApi } from '@/api/tasks'
import { backupSchedulesApi, type BackupSchedule } from '@/api/backupSchedules'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import ConfigDiffModal from './ConfigDiffModal'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

const { Text } = Typography

const BACKUP_CSS = `
@keyframes backupCardIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes backupProgress {
  0%, 100% { box-shadow: 0 0 8px #22c55e20; }
  50%       { box-shadow: 0 0 16px #22c55e35; }
}
.backup-row-never td { border-left: 3px solid rgba(239,68,68,0.4) !important; background: rgba(239,68,68,0.03) !important; }
.backup-row-stale td { border-left: 3px solid rgba(245,158,11,0.4) !important; background: rgba(245,158,11,0.03) !important; }
`

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

function BackupStatCard({ icon, label, value, color, isDark, sub }: {
  icon: React.ReactNode; label: string; value: number | string; color: string; isDark: boolean; sub?: string
}) {
  const C = mkC(isDark)
  return (
    <div style={{
      background: isDark ? `linear-gradient(135deg, ${color}0d 0%, ${C.bg} 60%)` : C.bg,
      border: `1px solid ${isDark ? color + '28' : C.border}`,
      borderTop: isDark ? `2px solid ${color}55` : `2px solid ${color}`,
      borderRadius: 10,
      padding: '12px 16px',
      animation: 'backupCardIn 0.4s ease-out',
      position: 'relative', overflow: 'hidden',
      boxShadow: isDark ? `0 4px 16px ${color}10` : undefined,
    }}>
      {isDark && (
        <div style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(ellipse at top left, ${color}10 0%, transparent 60%)`,
          pointerEvents: 'none',
        }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: isDark ? `${color}20` : `${color}15`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ color, fontSize: 16 }}>{icon}</span>
        </div>
        <div>
          <div style={{ color: C.muted, fontSize: 10, fontWeight: 500, letterSpacing: 0.5, textTransform: 'uppercase' }}>{label}</div>
          <div style={{ color: color, fontSize: 20, fontWeight: 800, lineHeight: 1, marginTop: 1 }}>{value}</div>
          {sub && <div style={{ color: C.dim, fontSize: 10, marginTop: 1 }}>{sub}</div>}
        </div>
      </div>
    </div>
  )
}

interface BackupRow {
  device_id: string
  hostname: string
  ip_address: string
  vendor: string
  status: string
  last_backup: string
  backup_count: number
  backupStatus: 'ok' | 'stale' | 'never'
}

function backupStatus(lastBackup: string, count: number): 'ok' | 'stale' | 'never' {
  if (!lastBackup || count === 0) return 'never'
  const days = dayjs().diff(dayjs(lastBackup), 'day')
  return days > 7 ? 'stale' : 'ok'
}

// ── Schedule label helpers ────────────────────────────────────────────────────

const DAY_LABELS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz']
const DAY_FULL   = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar']

function scheduleLabel(s: BackupSchedule): string {
  const time = `${String(s.run_hour).padStart(2, '0')}:${String(s.run_minute).padStart(2, '0')}`
  if (s.schedule_type === 'interval') return `Her ${s.interval_hours} saatte bir`
  if (s.schedule_type === 'weekly' && s.days_of_week?.length) {
    const days = s.days_of_week.map((d) => DAY_LABELS[d]).join(', ')
    return `Haftalık: ${days} — ${time}`
  }
  return `Her gün ${time}`
}

function filterLabel(f: string, site?: string | null): string {
  if (f === 'all') return 'Tüm cihazlar'
  if (f === 'stale') return 'Eski yedekler (>7g)'
  if (f === 'never') return 'Hiç yedek alınmayanlar'
  if (f === 'site') return `Site: ${site || '—'}`
  return f
}

// ── Schedule Form Modal ───────────────────────────────────────────────────────

interface ScheduleFormValues {
  name: string
  enabled: boolean
  schedule_type: 'daily' | 'weekly' | 'interval'
  run_time: dayjs.Dayjs
  days_of_week: number[]
  interval_hours: number
  device_filter: 'all' | 'stale' | 'never' | 'site'
  site: string
}

function ScheduleModal({
  open,
  onClose,
  schedule,
  isDark,
}: {
  open: boolean
  onClose: () => void
  schedule: BackupSchedule | null
  isDark: boolean
}) {
  const C = mkC(isDark)
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [form] = Form.useForm<ScheduleFormValues>()
  const schedType = Form.useWatch('schedule_type', form)
  const deviceFilter = Form.useWatch('device_filter', form)

  useEffect(() => {
    if (open) {
      if (schedule) {
        form.setFieldsValue({
          name: schedule.name,
          enabled: schedule.enabled,
          schedule_type: schedule.schedule_type,
          run_time: dayjs().hour(schedule.run_hour).minute(schedule.run_minute),
          days_of_week: schedule.days_of_week ?? [0, 1, 2, 3, 4, 5, 6],
          interval_hours: schedule.interval_hours,
          device_filter: schedule.device_filter,
          site: schedule.site ?? '',
        })
      } else {
        form.resetFields()
        form.setFieldsValue({
          enabled: true,
          schedule_type: 'daily',
          run_time: dayjs().hour(2).minute(0),
          days_of_week: [0, 1, 2, 3, 4, 5, 6],
          interval_hours: 24,
          device_filter: 'all',
        })
      }
    }
  }, [open, schedule, form])

  const saveMutation = useMutation({
    mutationFn: async (vals: ScheduleFormValues) => {
      const payload = {
        name: vals.name,
        enabled: vals.enabled ?? true,
        schedule_type: vals.schedule_type,
        run_hour: vals.schedule_type !== 'interval' ? vals.run_time.hour() : 0,
        run_minute: vals.schedule_type !== 'interval' ? vals.run_time.minute() : 0,
        days_of_week: vals.schedule_type === 'weekly' ? (vals.days_of_week ?? null) : null,
        interval_hours: vals.schedule_type === 'interval' ? (vals.interval_hours ?? 24) : 24,
        device_filter: vals.device_filter ?? 'all',
        site: vals.device_filter === 'site' ? (vals.site || null) : null,
      }
      return schedule
        ? backupSchedulesApi.update(schedule.id, payload)
        : backupSchedulesApi.create(payload)
    },
    onSuccess: () => {
      message.success(schedule ? 'Zamanlama güncellendi' : 'Zamanlama oluşturuldu')
      qc.invalidateQueries({ queryKey: ['backup-schedules'] })
      onClose()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Kayıt başarısız'),
  })

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={
        <Space>
          <ClockCircleOutlined style={{ color: '#3b82f6' }} />
          <span style={{ color: C.text }}>{schedule ? 'Zamanlamayı Düzenle' : 'Yeni Zamanlama'}</span>
        </Space>
      }
      onOk={() => form.submit()}
      okText={schedule ? 'Güncelle' : 'Oluştur'}
      cancelText="İptal"
      confirmLoading={saveMutation.isPending}
      styles={{
        content: { background: C.bg, border: `1px solid ${C.border}` },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
      width={520}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => saveMutation.mutate(v)}
        style={{ marginTop: 8 }}
      >
        <Form.Item name="name" label="Zamanlama Adı" rules={[{ required: true, message: 'Ad gerekli' }]}>
          <Input placeholder="örn. Gece Yedekleme" />
        </Form.Item>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="schedule_type" label="Tür">
              <Select options={[
                { value: 'daily', label: 'Her gün' },
                { value: 'weekly', label: 'Haftalık' },
                { value: 'interval', label: 'Her N saatte' },
              ]} />
            </Form.Item>
          </Col>
          <Col span={12}>
            {schedType !== 'interval' ? (
              <Form.Item name="run_time" label="Saat">
                <TimePicker format="HH:mm" minuteStep={5} style={{ width: '100%' }} />
              </Form.Item>
            ) : (
              <Form.Item name="interval_hours" label="Kaç saatte bir">
                <Select options={[1,2,3,4,6,8,12,24,48,72,168].map((h) => ({
                  value: h, label: h < 24 ? `${h} saat` : h === 24 ? 'Günlük' : h === 48 ? '2 gün' : h === 72 ? '3 gün' : '7 gün'
                }))} />
              </Form.Item>
            )}
          </Col>
        </Row>

        {schedType === 'weekly' && (
          <Form.Item name="days_of_week" label="Günler">
            <AntCheckbox.Group>
              <Space wrap>
                {DAY_FULL.map((label, i) => (
                  <AntCheckbox key={i} value={i}>{label}</AntCheckbox>
                ))}
              </Space>
            </AntCheckbox.Group>
          </Form.Item>
        )}

        <Divider style={{ borderColor: C.border, margin: '12px 0' }} />

        <Row gutter={12}>
          <Col span={deviceFilter === 'site' ? 12 : 24}>
            <Form.Item name="device_filter" label="Cihaz Kapsamı">
              <Select options={[
                { value: 'all', label: 'Tüm aktif cihazlar' },
                { value: 'stale', label: 'Eski yedekler (>7g)' },
                { value: 'never', label: 'Hiç yedek alınmayanlar' },
                { value: 'site', label: 'Belirli site' },
              ]} />
            </Form.Item>
          </Col>
          {deviceFilter === 'site' && (
            <Col span={12}>
              <Form.Item name="site" label="Site Adı" rules={[{ required: true, message: 'Site gerekli' }]}>
                <Input placeholder="örn. Istanbul-DC1" />
              </Form.Item>
            </Col>
          )}
        </Row>

        <Form.Item name="enabled" label="Durum" valuePropName="checked">
          <Switch checkedChildren="Aktif" unCheckedChildren="Pasif" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ── Schedules Tab ─────────────────────────────────────────────────────────────

function SchedulesTab({ isDark }: { isDark: boolean }) {
  const C = mkC(isDark)
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<BackupSchedule | null>(null)

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ['backup-schedules'],
    queryFn: backupSchedulesApi.list,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => backupSchedulesApi.delete(id),
    onSuccess: () => {
      message.success('Zamanlama silindi')
      qc.invalidateQueries({ queryKey: ['backup-schedules'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silinemedi'),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      backupSchedulesApi.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-schedules'] }),
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Güncellenemedi'),
  })

  const runNowMutation = useMutation({
    mutationFn: (id: number) => backupSchedulesApi.runNow(id),
    onSuccess: (data) => {
      if (data.status === 'no_devices') message.warning('Kapsam dahilinde cihaz bulunamadı')
      else message.success(`Yedekleme başlatıldı (görev #${data.task_id})`)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Başlatılamadı'),
  })

  const openCreate = () => { setEditing(null); setModalOpen(true) }
  const openEdit = (s: BackupSchedule) => { setEditing(s); setModalOpen(true) }

  const columns = [
    {
      title: 'Zamanlama',
      render: (_: unknown, s: BackupSchedule) => (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontWeight: 600, color: C.text }}>{s.name}</Text>
            {s.is_default && <Tag style={{ fontSize: 10 }} color="blue">Varsayılan</Tag>}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
            <ClockCircleOutlined style={{ marginRight: 4 }} />{scheduleLabel(s)}
          </div>
        </div>
      ),
    },
    {
      title: 'Kapsam',
      width: 200,
      render: (_: unknown, s: BackupSchedule) => (
        <Text style={{ fontSize: 12, color: C.muted }}>{filterLabel(s.device_filter, s.site)}</Text>
      ),
    },
    {
      title: 'Son Çalışma',
      width: 140,
      render: (_: unknown, s: BackupSchedule) => s.last_run_at
        ? <Tooltip title={dayjs(s.last_run_at).format('DD.MM.YYYY HH:mm')}><Text style={{ fontSize: 12 }}>{dayjs(s.last_run_at).fromNow()}</Text></Tooltip>
        : <Text style={{ fontSize: 12, color: C.dim }}>Henüz çalışmadı</Text>,
    },
    {
      title: 'Sonraki Çalışma',
      width: 150,
      render: (_: unknown, s: BackupSchedule) => {
        if (!s.enabled) return <Tag color="default" style={{ fontSize: 11 }}>Pasif</Tag>
        return s.next_run_at
          ? <Tooltip title={dayjs(s.next_run_at).format('DD.MM.YYYY HH:mm')}>
              <Tag color="blue" style={{ fontSize: 11 }}>{dayjs(s.next_run_at).fromNow()}</Tag>
            </Tooltip>
          : <Text style={{ fontSize: 12, color: C.dim }}>—</Text>
      },
    },
    {
      title: 'Durum',
      width: 80,
      render: (_: unknown, s: BackupSchedule) => (
        <Switch
          size="small"
          checked={s.enabled}
          loading={toggleMutation.isPending}
          onChange={(checked) => toggleMutation.mutate({ id: s.id, enabled: checked })}
        />
      ),
    },
    {
      title: '',
      width: 120,
      render: (_: unknown, s: BackupSchedule) => (
        <Space size={4}>
          <Tooltip title="Şimdi Çalıştır">
            <Button
              size="small"
              icon={<PlayCircleOutlined />}
              loading={runNowMutation.isPending}
              onClick={() => runNowMutation.mutate(s.id)}
            />
          </Tooltip>
          <Tooltip title="Düzenle">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(s)} />
          </Tooltip>
          {!s.is_default && (
            <Popconfirm
              title="Bu zamanlamayı sil?"
              onConfirm={() => deleteMutation.mutate(s.id)}
              okText="Sil"
              cancelText="İptal"
              okButtonProps={{ danger: true }}
            >
              <Button size="small" danger icon={<DeleteOutlined />} loading={deleteMutation.isPending} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Info */}
      <Alert
        type="info"
        showIcon
        icon={<CalendarOutlined />}
        message="Zamanlanmış Yedekleme"
        description={
          <span>
            Birden fazla zamanlama oluşturabilirsiniz. Herhangi bir zamanlama tanımlanmazsa sistem varsayılan olarak
            her gece <b>02:00</b>'de tüm cihazları yedekler.
            Zamanlamalar her dakika kontrol edilir.
          </span>
        }
        style={{ borderRadius: 8 }}
      />

      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ color: C.muted, fontSize: 13 }}>{schedules.length} zamanlama tanımlı</Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          Yeni Zamanlama
        </Button>
      </div>

      {/* Table */}
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <Table<BackupSchedule>
          dataSource={schedules}
          rowKey="id"
          columns={columns}
          loading={isLoading}
          size="small"
          pagination={false}
          locale={{ emptyText: 'Zamanlama bulunamadı' }}
        />
      </div>

      <ScheduleModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        schedule={editing}
        isDark={isDark}
      />
    </div>
  )
}

// ── Config Search Tab ─────────────────────────────────────────────────────────

function ConfigSearchTab({ isDark, C }: { isDark: boolean; C: ReturnType<typeof mkC> }) {
  const { Text } = Typography
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')

  const { data, isFetching } = useQuery({
    queryKey: ['config-search', submitted],
    queryFn: () => devicesApi.configSearch(submitted),
    enabled: submitted.length >= 2,
    staleTime: 30_000,
  })

  const handleSearch = () => {
    if (query.trim().length >= 2) setSubmitted(query.trim())
  }

  return (
    <div style={{ padding: '16px 0' }}>
      <Space.Compact style={{ width: '100%', maxWidth: 600, marginBottom: 20 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder="Config içinde ara... örn: 'ospf', 'ip access-list', 'spanning-tree'"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPressEnter={handleSearch}
          style={{ background: isDark ? '#0f172a' : undefined }}
          allowClear
        />
        <Button type="primary" onClick={handleSearch} loading={isFetching} icon={<SearchOutlined />}>
          Ara
        </Button>
      </Space.Compact>

      {submitted && data && (
        <div>
          <Text style={{ color: C.muted, fontSize: 12 }}>
            "{submitted}" için {data.total} cihazda eşleşme bulundu
          </Text>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {data.items.map((item) => (
              <Card
                key={item.device_id}
                size="small"
                style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <Tag color={item.status === 'online' ? 'green' : item.status === 'offline' ? 'red' : 'default'}>
                    {item.status}
                  </Tag>
                  <Text strong style={{ color: C.text }}>{item.hostname}</Text>
                  <Text style={{ color: C.muted, fontSize: 12 }}>{item.ip_address}</Text>
                  <Tag color="blue" style={{ marginLeft: 'auto' }}>{item.match_count} eşleşme</Tag>
                </div>
                {item.snippets.map((snip, i) => (
                  <pre key={i} style={{
                    background: isDark ? '#0d1117' : '#f8fafc',
                    border: `1px solid ${C.border}`,
                    borderRadius: 6,
                    padding: '6px 10px',
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: C.text,
                    margin: '4px 0',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}>
                    {snip}
                  </pre>
                ))}
              </Card>
            ))}
            {data.total === 0 && (
              <Alert type="info" message={`"${submitted}" için config yedeklerinde eşleşme bulunamadı.`} showIcon />
            )}
          </div>
        </div>
      )}
    </div>
  )
}


// ── Main Page ─────────────────────────────────────────────────────────────────

export default function BackupCenterPage() {
  const { message } = App.useApp()
  const qc = useQueryClient()
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [filter, setFilter] = useState<'all' | 'ok' | 'stale' | 'never'>('all')
  const [diffOpen, setDiffOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('backups')

  const { data: allDevicesData } = useQuery({
    queryKey: ['devices-for-diff', activeSite],
    queryFn: () => devicesApi.list({ limit: 500, site: activeSite || undefined }),
    staleTime: 120_000,
  })

  const [activeTaskId, setActiveTaskId] = useState<number | null>(null)

  const { data: backupData, isLoading, refetch } = useQuery({
    queryKey: ['backup-report', activeSite],
    queryFn: () => reportsApi.getBackups({ site: activeSite || undefined }),
    staleTime: 60_000,
  })

  const { data: activeTask } = useQuery({
    queryKey: ['backup-active-task', activeTaskId],
    queryFn: () => tasksApi.get(activeTaskId!),
    enabled: activeTaskId !== null,
    refetchInterval: (q) => {
      const s = (q.state.data as { status?: string } | undefined)?.status
      return s === 'pending' || s === 'running' ? 3000 : false
    },
  })

  useEffect(() => {
    if (!activeTask) return
    const s = activeTask.status
    if (s === 'success' || s === 'partial' || s === 'failed') {
      refetch()
      qc.invalidateQueries({ queryKey: ['backup-report'] })
      if (s === 'success') message.success(`Yedekleme tamamlandı — ${activeTask.completed_devices} cihaz`)
      else if (s === 'partial') message.warning('Yedekleme kısmi tamamlandı')
      else message.error('Yedekleme başarısız')
      setTimeout(() => setActiveTaskId(null), 2000)
    }
  }, [activeTask?.status])

  const bulkBackupMutation = useMutation({
    mutationFn: (ids: number[]) => devicesApi.bulkBackup(ids),
    onSuccess: (res) => {
      message.info(`Yedekleme başlatıldı — ${res.device_count} cihaz`)
      setSelectedIds([])
      setActiveTaskId(res.task_id)
    },
    onError: () => message.error('Yedekleme başlatılamadı'),
  })

  const rows: BackupRow[] = useMemo(() => {
    return (backupData?.items || []).map((item: Record<string, string>) => ({
      device_id: item.device_id,
      hostname: item.hostname,
      ip_address: item.ip_address,
      vendor: item.vendor,
      status: item.status,
      last_backup: item.last_backup,
      backup_count: Number(item.backup_count || 0),
      backupStatus: backupStatus(item.last_backup, Number(item.backup_count || 0)),
    }))
  }, [backupData])

  const filteredRows = useMemo(() => {
    if (filter === 'all') return rows
    return rows.filter((r) => r.backupStatus === filter)
  }, [rows, filter])

  const okCount = rows.filter((r) => r.backupStatus === 'ok').length
  const staleCount = rows.filter((r) => r.backupStatus === 'stale').length
  const neverCount = rows.filter((r) => r.backupStatus === 'never').length
  const coveragePct = rows.length > 0 ? Math.round((okCount / rows.length) * 100) : 0

  const getStaleIds = () =>
    rows
      .filter((r) => r.backupStatus === 'stale' || r.backupStatus === 'never')
      .map((r) => Number(r.device_id))
      .filter((id) => id > 0)

  const getAllNonOkIds = () =>
    rows
      .filter((r) => r.backupStatus !== 'ok')
      .map((r) => Number(r.device_id))
      .filter((id) => id > 0)

  const columns = [
    {
      title: '',
      width: 36,
      render: (_: unknown, r: BackupRow) => (
        <Checkbox
          checked={selectedIds.includes(Number(r.device_id))}
          onChange={(e) =>
            setSelectedIds((prev) =>
              e.target.checked
                ? [...prev, Number(r.device_id)]
                : prev.filter((id) => id !== Number(r.device_id))
            )
          }
        />
      ),
    },
    {
      title: 'Switch',
      width: 220,
      render: (_: unknown, r: BackupRow) => (
        <div>
          <Text style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{r.hostname}</Text>
          <div style={{ fontSize: 11, color: C.muted, fontFamily: 'monospace' }}>{r.ip_address}</div>
        </div>
      ),
    },
    {
      title: 'Vendor',
      dataIndex: 'vendor',
      width: 100,
      render: (v: string) => <Tag style={{ fontSize: 11 }}>{v || '—'}</Tag>,
    },
    {
      title: 'Durum',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => (
        <Badge
          status={v === 'online' ? 'success' : v === 'offline' ? 'error' : 'default'}
          text={<Text style={{ fontSize: 12 }}>{v}</Text>}
        />
      ),
    },
    {
      title: 'Yedek Durumu',
      width: 140,
      sorter: (a: BackupRow, b: BackupRow) => {
        const order = { never: 0, stale: 1, ok: 2 }
        return order[a.backupStatus] - order[b.backupStatus]
      },
      render: (_: unknown, r: BackupRow) => {
        if (r.backupStatus === 'ok') return <Tag icon={<CheckCircleOutlined />} color="green">Güncel</Tag>
        if (r.backupStatus === 'stale') return <Tag icon={<WarningOutlined />} color="orange">Eski (&gt;7g)</Tag>
        return <Tag icon={<CloseCircleOutlined />} color="red">Hiç Yok</Tag>
      },
    },
    {
      title: 'Son Yedek',
      dataIndex: 'last_backup',
      width: 130,
      sorter: (a: BackupRow, b: BackupRow) => {
        if (!a.last_backup) return -1
        if (!b.last_backup) return 1
        return dayjs(a.last_backup).unix() - dayjs(b.last_backup).unix()
      },
      render: (v: string) => v ? (
        <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm')}>
          <Text style={{ fontSize: 12 }}>{dayjs(v).fromNow()}</Text>
        </Tooltip>
      ) : <Text type="secondary">—</Text>,
    },
    {
      title: 'Yedek Sayısı',
      dataIndex: 'backup_count',
      width: 100,
      sorter: (a: BackupRow, b: BackupRow) => a.backup_count - b.backup_count,
      render: (v: number) => <Tag color={v > 5 ? 'blue' : v > 0 ? 'geekblue' : 'default'}>{v} yedek</Tag>,
    },
    {
      title: '',
      width: 80,
      render: (_: unknown, r: BackupRow) => (
        <Tooltip title="Şimdi Yedekle">
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            loading={bulkBackupMutation.isPending && selectedIds.includes(Number(r.device_id))}
            onClick={() => bulkBackupMutation.mutate([Number(r.device_id)])}
          />
        </Tooltip>
      ),
    },
  ]

  const backupsContent = (
    <>
      {/* Active task progress */}
      {activeTask && (activeTask.status === 'pending' || activeTask.status === 'running') && (
        <Alert
          type="info"
          showIcon
          icon={<LoadingOutlined spin />}
          style={{ marginBottom: 12 }}
          message={
            <Space>
              <span>{activeTask.name}</span>
              <Tag color={activeTask.status === 'running' ? 'processing' : 'default'}>
                {activeTask.status === 'running' ? 'Çalışıyor' : 'Bekliyor'}
              </Tag>
            </Space>
          }
          description={
            <Progress
              percent={activeTask.total_devices > 0
                ? Math.round((activeTask.completed_devices + activeTask.failed_devices) / activeTask.total_devices * 100)
                : 0}
              size="small"
              strokeColor="#3b82f6"
              format={(p) => `${activeTask.completed_devices + activeTask.failed_devices} / ${activeTask.total_devices} cihaz (${p}%)`}
            />
          }
        />
      )}

      {/* Stats */}
      <Row gutter={[10, 10]}>
        <Col xs={12} sm={6} lg={4}>
          <BackupStatCard icon={<DatabaseOutlined />} label="Toplam Switch" value={rows.length} color="#3b82f6" isDark={isDark} />
        </Col>
        <Col xs={12} sm={6} lg={4}>
          <BackupStatCard icon={<CheckCircleOutlined />} label="Güncel Yedek" value={okCount} color="#22c55e" isDark={isDark} sub={`${coveragePct}% kapsam`} />
        </Col>
        <Col xs={12} sm={6} lg={4}>
          <BackupStatCard icon={<WarningOutlined />} label="Eski Yedek (>7g)" value={staleCount} color={staleCount > 0 ? '#f59e0b' : '#64748b'} isDark={isDark} />
        </Col>
        <Col xs={12} sm={6} lg={4}>
          <BackupStatCard icon={<CloseCircleOutlined />} label="Hiç Yok" value={neverCount} color={neverCount > 0 ? '#ef4444' : '#64748b'} isDark={isDark} />
        </Col>
        <Col xs={12} sm={6} lg={8}>
          <div style={{
            background: isDark ? `linear-gradient(135deg, ${coveragePct >= 80 ? '#22c55e' : coveragePct >= 50 ? '#f59e0b' : '#ef4444'}0d 0%, ${C.bg} 60%)` : C.bg,
            border: `1px solid ${isDark ? (coveragePct >= 80 ? '#22c55e' : coveragePct >= 50 ? '#f59e0b' : '#ef4444') + '28' : C.border}`,
            borderTop: `2px solid ${coveragePct >= 80 ? '#22c55e55' : coveragePct >= 50 ? '#f59e0b55' : '#ef444455'}`,
            borderRadius: 10,
            padding: '12px 16px',
            animation: 'backupCardIn 0.4s ease-out',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={{ color: C.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Yedek Kapsamı</Text>
              <Text style={{ fontSize: 16, fontWeight: 800, color: coveragePct >= 80 ? '#22c55e' : coveragePct >= 50 ? '#f59e0b' : '#ef4444' }}>
                {coveragePct}%
              </Text>
            </div>
            <Progress
              percent={coveragePct}
              size="small"
              showInfo={false}
              strokeColor={coveragePct >= 80 ? '#22c55e' : coveragePct >= 50 ? '#f59e0b' : '#ef4444'}
              style={{ marginBottom: 4 }}
            />
            <Text style={{ color: C.dim, fontSize: 10 }}>
              Son 7 günde en az 1 yedek = güncel
            </Text>
          </div>
        </Col>
      </Row>

      {/* Actions bar */}
      {(staleCount > 0 || neverCount > 0) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`${staleCount + neverCount} switch güncel yedek yok`}
          description={
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              type="primary"
              style={{ marginTop: 4 }}
              loading={bulkBackupMutation.isPending}
              onClick={() => {
                const ids = getStaleIds()
                if (ids.length === 0) return
                setSelectedIds(ids)
                bulkBackupMutation.mutate(ids)
              }}
            >
              Tümünü Seç ve Yedekle ({staleCount + neverCount})
            </Button>
          }
          action={
            <Popconfirm
              title={`${staleCount + neverCount} cihaz için yedek başlatılsın mı?`}
              onConfirm={() => bulkBackupMutation.mutate(getAllNonOkIds())}
            >
              <Button size="small" danger icon={<CloudDownloadOutlined />} loading={bulkBackupMutation.isPending}>
                Hepsini Şimdi Yedekle
              </Button>
            </Popconfirm>
          }
        />
      )}

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {([
          { key: 'all', label: `Tümü (${rows.length})`, color: '#3b82f6' },
          { key: 'ok', label: `Güncel (${okCount})`, color: '#22c55e' },
          { key: 'stale', label: `Eski (${staleCount})`, color: '#f59e0b' },
          { key: 'never', label: `Hiç Yok (${neverCount})`, color: '#ef4444' },
        ] as { key: typeof filter; label: string; color: string }[]).map((f) => (
          <Button
            key={f.key}
            size="small"
            type={filter === f.key ? 'primary' : 'default'}
            onClick={() => setFilter(f.key)}
            style={filter === f.key ? { background: f.color, borderColor: f.color } : { color: C.muted, borderColor: C.border }}
          >
            {f.label}
          </Button>
        ))}
        {selectedIds.length > 0 && (
          <Button size="small" onClick={() => setSelectedIds([])} style={{ color: C.muted, borderColor: C.border }}>
            Seçimi Temizle ({selectedIds.length})
          </Button>
        )}
      </div>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <Table<BackupRow>
          dataSource={filteredRows}
          rowKey="device_id"
          columns={columns}
          size="small"
          loading={isLoading}
          pagination={{ pageSize: 50, showTotal: (n) => <span style={{ color: C.muted }}>{n} switch</span>, showSizeChanger: false }}
          rowClassName={(r) =>
            r.backupStatus === 'never' ? 'backup-row-never'
            : r.backupStatus === 'stale' ? 'backup-row-stale' : ''
          }
        />
      </div>

      <ConfigDiffModal
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        devices={allDevicesData?.items ?? []}
      />
    </>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{BACKUP_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#3b82f620' : C.border}`,
        borderLeft: '4px solid #3b82f6',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#3b82f620', border: '1px solid #3b82f630',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <DatabaseOutlined style={{ color: '#3b82f6', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>Yedekleme Merkezi</div>
            <div style={{ color: C.muted, fontSize: 12 }}>
              Konfigürasyon yedekleme — manuel ve zamanlı otomatik yedekleme
            </div>
          </div>
        </div>
        <Space wrap>
          <Button icon={<SyncOutlined />} onClick={() => refetch()}>Yenile</Button>
          <Button icon={<DiffOutlined />} onClick={() => setDiffOpen(true)}>Config Karşılaştır</Button>
          <Button icon={<DownloadOutlined />} href={reportsApi.getBackupsCsvUrl()} target="_blank">CSV İndir</Button>
          <Button icon={<DownloadOutlined />} href={reportsApi.getBackupsZipUrl()} target="_blank">ZIP İndir</Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            disabled={selectedIds.length === 0}
            loading={bulkBackupMutation.isPending}
            onClick={() => bulkBackupMutation.mutate(selectedIds)}
          >
            Seçilileri Yedekle ({selectedIds.length})
          </Button>
        </Space>
      </div>

      {/* Tabs */}
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        size="small"
        items={[
          {
            key: 'backups',
            label: <Space size={4}><DatabaseOutlined />Yedekler</Space>,
            children: backupsContent,
          },
          {
            key: 'schedules',
            label: <Space size={4}><ClockCircleOutlined />Zamanlamalar</Space>,
            children: <SchedulesTab isDark={isDark} />,
          },
          {
            key: 'search',
            label: <Space size={4}><SearchOutlined />Config Arama</Space>,
            children: <ConfigSearchTab isDark={isDark} C={C} />,
          },
        ]}
      />
    </div>
  )
}
