import { useState } from 'react'
import {
  Button, Card, Col, Collapse, Drawer, Form, Input, InputNumber,
  Modal, Popconfirm, Row, Select, Space, Switch, Table, Tag, Tooltip, Typography, Divider,
  message,
} from 'antd'
import {
  PlusOutlined, PlayCircleOutlined, EditOutlined, DeleteOutlined,
  CheckCircleOutlined, CloseCircleOutlined, CodeOutlined,
  HistoryOutlined, ClockCircleOutlined,
  ExperimentOutlined, AppstoreOutlined, DownloadOutlined, FileTextOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useTheme } from '@/contexts/ThemeContext'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { playbooksApi, type Playbook, type PlaybookRun, type PlaybookTemplate, type StepType } from '@/api/playbooks'
import { devicesApi } from '@/api/devices'
import { notificationsApi } from '@/api/notifications'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
dayjs.extend(relativeTime)

const PLAYBOOKS_CSS = `
@keyframes pbRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.pb-row-running td { background: rgba(59,130,246,0.04) !important; }
.pb-row-failed  td { background: rgba(239,68,68,0.03) !important; }
`

function mkC(isDark: boolean) {
  return {
    bg:     isDark ? '#1e293b' : '#ffffff',
    bg2:    isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
    dim:    isDark ? '#475569' : '#cbd5e1',
  }
}

const TRIGGER_TYPE_COLORS: Record<string, string> = {
  manual: 'default',
  scheduled: 'purple',
  event: 'orange',
}

const TRIGGER_TYPE_LABELS: Record<string, string> = {
  manual: 'Manuel',
  scheduled: 'Zamanlanmış',
  event: 'Olay Bazlı',
}

const SCHEDULE_OPTIONS = [
  { label: 'Devre dışı', value: 0 },
  { label: 'Her 1 saat', value: 1 },
  { label: 'Her 6 saat', value: 6 },
  { label: 'Her 12 saat', value: 12 },
  { label: 'Günlük (24 saat)', value: 24 },
  { label: 'Haftalık (168 saat)', value: 168 },
]

const TRIGGER_TYPES = [
  { label: 'Manuel', value: 'manual' },
  { label: 'Zamanlanmış', value: 'scheduled' },
  { label: 'Olay Bazlı', value: 'event' },
]

const EVENT_TYPES = [
  { label: 'Cihaz Çevrimdışı', value: 'device_offline' },
  { label: 'Kritik Olay', value: 'critical_event' },
  { label: 'Uyarı Olayı', value: 'warning_event' },
  { label: 'Port Down', value: 'port_down' },
  { label: 'Playbook Hatası', value: 'playbook_failure' },
  { label: 'Yedek Hatası', value: 'backup_failure' },
]

const STEP_TYPES: { label: string; value: StepType; icon: string }[] = [
  { label: 'SSH Komutu', value: 'ssh_command', icon: '>' },
  { label: 'Config Yedeği', value: 'backup', icon: '💾' },
  { label: 'Uyumluluk Tarama', value: 'compliance_check', icon: '🔍' },
  { label: 'Bildirim Gönder', value: 'notify', icon: '🔔' },
  { label: 'Bekle (saniye)', value: 'wait', icon: '⏱' },
  { label: 'Koşul Kontrolü', value: 'condition_check', icon: '?' },
]

const { Text } = Typography

const STATUS_HEX: Record<string, string> = {
  pending: '#64748b', running: '#3b82f6', success: '#22c55e',
  partial: '#f59e0b', failed: '#ef4444', dry_run: '#475569',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Bekliyor',
  running: 'Çalışıyor',
  success: 'Başarılı',
  partial: 'Kısmi',
  failed: 'Başarısız',
  dry_run: 'Dry-run',
}

export default function PlaybooksPage() {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const qc = useQueryClient()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Playbook | null>(null)
  const [runsModal, setRunsModal] = useState<Playbook | null>(null)
  const [runDetailModal, setRunDetailModal] = useState<PlaybookRun | null>(null)
  const [templatesModal, setTemplatesModal] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<PlaybookTemplate | null>(null)
  const [triggerType, setTriggerType] = useState<string>('manual')
  const [form] = Form.useForm()
  const [tplForm] = Form.useForm()

  const { data: pbData, isLoading } = useQuery({
    queryKey: ['playbooks'],
    queryFn: playbooksApi.list,
  })
  const playbooks = pbData?.items ?? []

  const { data: groupsData } = useQuery({
    queryKey: ['device-groups'],
    queryFn: devicesApi.listGroups,
  })

  const { data: channelsData } = useQuery({
    queryKey: ['notification-channels'],
    queryFn: notificationsApi.list,
    select: (d) => d.items,
  })

  const { data: templatesData, isLoading: templatesLoading } = useQuery({
    queryKey: ['playbook-templates'],
    queryFn: playbooksApi.listTemplates,
    enabled: templatesModal,
  })

  const { data: runsData, isLoading: runsLoading } = useQuery({
    queryKey: ['playbook-runs', runsModal?.id],
    queryFn: () => playbooksApi.getRuns(runsModal!.id),
    enabled: !!runsModal,
    refetchInterval: (query) => {
      const items = (query.state.data as any)?.items as PlaybookRun[] | undefined
      const hasRunning = items?.some((r) => r.status === 'running' || r.status === 'pending')
      return hasRunning ? 3000 : false
    },
  })

  const saveMutation = useMutation({
    mutationFn: (values: any) => {
      const isScheduled = values.trigger_type === 'scheduled'
      const payload = {
        ...values,
        target_device_ids: [],
        is_scheduled: isScheduled,
        schedule_interval_hours: isScheduled ? (values.schedule_interval_hours || 0) : 0,
        trigger_event_type: values.trigger_type === 'event' ? values.trigger_event_type : null,
      }
      return editTarget
        ? playbooksApi.update(editTarget.id, payload)
        : playbooksApi.create(payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['playbooks'] })
      setDrawerOpen(false)
      setEditTarget(null)
      form.resetFields()
      message.success(editTarget ? 'Playbook güncellendi' : 'Playbook oluşturuldu')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => playbooksApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['playbooks'] })
      message.success('Silindi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silinemedi'),
  })

  const createFromTemplateMutation = useMutation({
    mutationFn: (data: { template_id: string; name: string; target_group_id?: number }) =>
      playbooksApi.createFromTemplate(data),
    onSuccess: (pb) => {
      qc.invalidateQueries({ queryKey: ['playbooks'] })
      setSelectedTemplate(null)
      setTemplatesModal(false)
      tplForm.resetFields()
      message.success(`"${pb.name}" şablondan oluşturuldu`)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Oluşturulamadı'),
  })

  const runMutation = useMutation({
    mutationFn: ({ id, dry_run }: { id: number; dry_run?: boolean }) => playbooksApi.run(id, dry_run),
    onSuccess: (data, { id }) => {
      const label = data.dry_run ? 'Dry-run başlatıldı' : 'Çalışma başlatıldı'
      message.success(`${label} — ${data.device_count} cihaz hedefleniyor`)
      const pb = playbooks.find((p) => p.id === id)
      if (pb) setRunsModal(pb)
      qc.invalidateQueries({ queryKey: ['playbook-runs', id] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Başlatılamadı'),
  })

  const openCreate = () => {
    setEditTarget(null)
    form.resetFields()
    form.setFieldsValue({
      steps: [{ type: 'ssh_command', command: '', description: '', stop_on_error: false }],
      schedule_interval_hours: 0,
      trigger_type: 'manual',
      pre_run_backup: false,
    })
    setTriggerType('manual')
    setDrawerOpen(true)
  }

  const openEdit = (pb: Playbook) => {
    setEditTarget(pb)
    setTriggerType(pb.trigger_type || 'manual')
    form.setFieldsValue({
      name: pb.name,
      description: pb.description,
      target_group_id: pb.target_group_id,
      steps: pb.steps.length > 0 ? pb.steps : [{ type: 'ssh_command', command: '', description: '', stop_on_error: false }],
      trigger_type: pb.trigger_type || 'manual',
      trigger_event_type: pb.trigger_event_type,
      schedule_interval_hours: pb.schedule_interval_hours || 0,
      pre_run_backup: pb.pre_run_backup,
    })
    setDrawerOpen(true)
  }

  const loadTemplateIntoForm = (tpl: PlaybookTemplate) => {
    form.setFieldsValue({
      name: tpl.name,
      description: tpl.description,
      steps: tpl.steps,
      trigger_type: tpl.trigger_type,
      trigger_event_type: tpl.trigger_event_type,
      schedule_interval_hours: tpl.schedule_interval_hours || 0,
      pre_run_backup: tpl.pre_run_backup,
    })
    setTriggerType(tpl.trigger_type)
    setTemplatesModal(false)
    if (!drawerOpen) {
      setEditTarget(null)
      setDrawerOpen(true)
    }
  }

  const downloadRunResult = (run: PlaybookRun, format: 'json' | 'txt') => {
    let content: string
    let filename: string
    let mimeType: string

    if (format === 'json') {
      content = JSON.stringify(run.device_results, null, 2)
      filename = `playbook_run_${run.id}.json`
      mimeType = 'application/json'
    } else {
      const lines: string[] = []
      lines.push(`Playbook Run #${run.id}`)
      lines.push(`Status: ${STATUS_LABEL[run.status] ?? run.status}`)
      lines.push(`Triggered by: ${run.triggered_by_username}`)
      lines.push(`Date: ${dayjs(run.created_at).format('DD.MM.YYYY HH:mm')}`)
      lines.push(`Devices: ${run.success_devices} başarılı / ${run.failed_devices} başarısız / ${run.total_devices} toplam`)
      lines.push('')
      for (const devResult of Object.values(run.device_results ?? {})) {
        lines.push(`${'='.repeat(60)}`)
        lines.push(`Cihaz: ${devResult.hostname} (${devResult.ip}) — ${devResult.ok ? 'BAŞARILI' : 'BAŞARISIZ'}`)
        lines.push(`${'='.repeat(60)}`)
        for (const step of devResult.steps) {
          lines.push(`  Komut: ${step.command}`)
          if (step.description) lines.push(`  Açıklama: ${step.description}`)
          lines.push(`  Sonuç: ${step.success ? 'BAŞARILI' : 'BAŞARISIZ'}`)
          if (step.output) lines.push(`  Çıktı:\n${step.output.split('\n').map(l => '    ' + l).join('\n')}`)
          if (step.error) lines.push(`  Hata: ${step.error}`)
          lines.push('')
        }
      }
      content = lines.join('\n')
      filename = `playbook_run_${run.id}.txt`
      mimeType = 'text/plain'
    }

    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const columns = [
    {
      title: 'Ad',
      dataIndex: 'name',
      render: (name: string, pb: Playbook) => (
        <Space direction="vertical" size={0}>
          <Text strong>{name}</Text>
          {pb.description && <Text type="secondary" style={{ fontSize: 12 }}>{pb.description}</Text>}
        </Space>
      ),
    },
    {
      title: 'Adımlar',
      dataIndex: 'step_count',
      width: 90,
      render: (n: number) => <Tag icon={<CodeOutlined />}>{n} adım</Tag>,
    },
    {
      title: 'Hedef',
      width: 160,
      render: (_: unknown, pb: Playbook) => {
        const group = groupsData?.find((g) => g.id === pb.target_group_id)
        if (group) return <Tag color="blue">{group.name}</Tag>
        if (pb.target_device_ids?.length > 0) return <Tag>{pb.target_device_ids.length} cihaz</Tag>
        return <Tag color="default">Tüm aktif cihazlar</Tag>
      },
    },
    {
      title: 'Tetikleyici',
      width: 170,
      render: (_: unknown, pb: Playbook) => {
        if (pb.trigger_type === 'event') {
          return (
            <Space direction="vertical" size={0}>
              <Tag color="orange" icon={<ThunderboltOutlined />}>Olay Bazlı</Tag>
              {pb.trigger_event_type && (
                <Text type="secondary" style={{ fontSize: 11 }}>{pb.trigger_event_type}</Text>
              )}
            </Space>
          )
        }
        if (pb.trigger_type === 'scheduled' && pb.schedule_interval_hours) {
          const label = SCHEDULE_OPTIONS.find(o => o.value === pb.schedule_interval_hours)?.label
            ?? `Her ${pb.schedule_interval_hours}s`
          return (
            <Space direction="vertical" size={0}>
              <Tag color="purple" icon={<ClockCircleOutlined />}>{label}</Tag>
              {pb.next_run_at && <Text type="secondary" style={{ fontSize: 11 }}>Sonraki: {dayjs(pb.next_run_at).format('DD.MM HH:mm')}</Text>}
            </Space>
          )
        }
        return <Text type="secondary" style={{ fontSize: 12 }}>Manuel</Text>
      },
    },
    {
      title: 'Güncelleme',
      dataIndex: 'updated_at',
      width: 120,
      render: (v: string) => <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).fromNow()}</Text>,
    },
    {
      title: 'İşlemler',
      width: 220,
      render: (_: unknown, pb: Playbook) => (
        <Space>
          <Tooltip title="Çalıştır">
            <Button size="small" type="primary" icon={<PlayCircleOutlined />}
              loading={runMutation.isPending && (runMutation.variables as any)?.id === pb.id}
              onClick={() => runMutation.mutate({ id: pb.id })} />
          </Tooltip>
          <Tooltip title="Dry-run (simülasyon)">
            <Button size="small" icon={<ExperimentOutlined />}
              loading={runMutation.isPending && (runMutation.variables as any)?.id === pb.id}
              onClick={() => runMutation.mutate({ id: pb.id, dry_run: true })} />
          </Tooltip>
          <Tooltip title="Geçmiş">
            <Button size="small" icon={<HistoryOutlined />}
              onClick={() => setRunsModal(pb)} />
          </Tooltip>
          <Tooltip title="Düzenle">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(pb)} />
          </Tooltip>
          <Popconfirm title="Bu playbook silinsin mi?" onConfirm={() => deleteMutation.mutate(pb.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const runColumns = [
    {
      title: 'Durum',
      dataIndex: 'status',
      width: 140,
      render: (s: string, r: PlaybookRun) => {
        const hex = STATUS_HEX[s] || '#64748b'
        return (
          <Space size={4}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: hex, display: 'inline-block', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: C.text }}>{STATUS_LABEL[s] ?? s}</span>
            </span>
            {r.is_dry_run && <Tag style={{ color: '#8b5cf6', borderColor: '#8b5cf640', background: '#8b5cf618', fontSize: 10, margin: 0 }}>dry-run</Tag>}
          </Space>
        )
      },
    },
    {
      title: 'Sonuç',
      width: 120,
      render: (_: unknown, r: PlaybookRun) => (
        <Space>
          <Text style={{ color: '#22c55e' }}><CheckCircleOutlined /> {r.success_devices}</Text>
          <Text style={{ color: '#ef4444' }}><CloseCircleOutlined /> {r.failed_devices}</Text>
          <Text type="secondary">/ {r.total_devices}</Text>
        </Space>
      ),
    },
    {
      title: 'Tetikleyen',
      dataIndex: 'triggered_by_username',
      width: 110,
    },
    {
      title: 'Tarih',
      dataIndex: 'created_at',
      width: 130,
      render: (v: string) => <Text style={{ fontSize: 12 }}>{dayjs(v).format('DD.MM HH:mm')}</Text>,
    },
    {
      title: 'Süre',
      width: 80,
      render: (_: unknown, r: PlaybookRun) => {
        if (!r.started_at || !r.completed_at) return <Text type="secondary">—</Text>
        const ms = dayjs(r.completed_at).diff(dayjs(r.started_at))
        return <Text style={{ fontSize: 12 }}>{(ms / 1000).toFixed(1)}s</Text>
      },
    },
    {
      title: '',
      width: 60,
      render: (_: unknown, r: PlaybookRun) => (
        <Button size="small" onClick={() => setRunDetailModal(r)}>Detay</Button>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{PLAYBOOKS_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#f59e0b20' : C.border}`,
        borderLeft: '4px solid #f59e0b',
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
            background: '#f59e0b20', border: '1px solid #f59e0b30',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <ThunderboltOutlined style={{ color: '#f59e0b', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>
              Playbook'lar
              <span style={{ color: C.dim, fontSize: 13, fontWeight: 400, marginLeft: 8 }}>({playbooks.length})</span>
            </div>
            <div style={{ color: C.muted, fontSize: 12 }}>Otomasyon iş akışları ve zamanlanmış görevler</div>
          </div>
        </div>
        <Space>
          <Button icon={<AppstoreOutlined />} onClick={() => setTemplatesModal(true)}>
            Şablonlar
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            Yeni Playbook
          </Button>
        </Space>
      </div>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <Table
        dataSource={playbooks}
        rowKey="id"
        loading={isLoading}
        columns={columns}
        pagination={{ pageSize: 20 }}
        size="small"
        onRow={() => ({ style: { animation: 'pbRowIn 0.2s ease-out' } })}
        rowClassName={(pb: any) => {
          const lastRun = pb.last_run_status
          if (lastRun === 'running') return 'pb-row-running'
          if (lastRun === 'failed') return 'pb-row-failed'
          return ''
        }}
      />
      </div>

      {/* Create/Edit Drawer */}
      <Drawer
        title={<span style={{ color: C.text }}>{editTarget ? `Düzenle: ${editTarget.name}` : 'Yeni Playbook'}</span>}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditTarget(null) }}
        width={560}
        styles={{
          body: { background: C.bg },
          header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
        }}
        footer={
          <Space>
            <Button type="primary" loading={saveMutation.isPending} onClick={() => form.submit()}>
              Kaydet
            </Button>
            <Button icon={<AppstoreOutlined />} onClick={() => { setSelectedTemplate(null); setTemplatesModal(true) }}>
              Şablondan Yükle
            </Button>
            <Button onClick={() => setDrawerOpen(false)}>İptal</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item name="name" label="Ad" rules={[{ required: true }]}>
            <Input placeholder="VLAN Deploy, Port Hardening..." />
          </Form.Item>
          <Form.Item name="description" label="Açıklama">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="target_group_id" label="Hedef Grup" tooltip="Boş bırakılırsa tüm aktif cihazlarda çalışır">
            <Select
              allowClear
              placeholder="Grup seçin (opsiyonel)"
              options={groupsData?.map((g) => ({ value: g.id, label: g.name })) ?? []}
            />
          </Form.Item>

          <Divider orientation="left" style={{ fontSize: 13 }}>Tetikleyici & Zamanlama</Divider>
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item name="trigger_type" label="Tetikleyici Tipi">
                <Select
                  options={TRIGGER_TYPES}
                  onChange={(v) => setTriggerType(v)}
                />
              </Form.Item>
            </Col>
            {triggerType === 'scheduled' && (
              <Col span={14}>
                <Form.Item name="schedule_interval_hours" label="Çalıştırma Sıklığı">
                  <Select options={SCHEDULE_OPTIONS.filter(o => o.value > 0)} />
                </Form.Item>
              </Col>
            )}
            {triggerType === 'event' && (
              <Col span={14}>
                <Form.Item name="trigger_event_type" label="Tetikleyici Olay" rules={[{ required: true }]}>
                  <Select options={EVENT_TYPES} placeholder="Olay seçin" />
                </Form.Item>
              </Col>
            )}
          </Row>
          <Form.Item name="pre_run_backup" label="Çalıştırmadan Önce Yedek Al (rollback noktası)" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.List name="steps">
            {(fields, { add, remove }) => (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Text strong>Adımlar</Text>
                  <Button size="small" icon={<PlusOutlined />} onClick={() => add({ type: 'ssh_command', command: '', description: '', stop_on_error: false })}>
                    Adım Ekle
                  </Button>
                </div>
                {fields.map(({ key, name, ...rest }) => {
                  const stepType: StepType = form.getFieldValue(['steps', name, 'type']) || 'ssh_command'
                  return (
                    <Card key={key} size="small" style={{ marginBottom: 8 }}
                      extra={<Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(name)} />}
                    >
                      <Form.Item {...rest} name={[name, 'type']} label="Adım Tipi" style={{ marginBottom: 8 }}>
                        <Select
                          options={STEP_TYPES.map(t => ({ value: t.value, label: `${t.icon} ${t.label}` }))}
                          onChange={() => form.setFieldsValue({})}
                        />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, 'description']} label="Açıklama" style={{ marginBottom: 8 }}>
                        <Input placeholder="Bu adımın amacı..." />
                      </Form.Item>
                      {stepType === 'ssh_command' && (
                        <Form.Item {...rest} name={[name, 'command']} label="Komut"
                          rules={[{ required: true, message: 'Komut gerekli' }]}
                          style={{ marginBottom: 8 }}
                        >
                          <Input
                            prefix={<span style={{ fontFamily: 'monospace', color: '#888' }}>#</span>}
                            placeholder="show version"
                            style={{ fontFamily: 'monospace' }}
                          />
                        </Form.Item>
                      )}
                      {stepType === 'wait' && (
                        <Form.Item {...rest} name={[name, 'seconds']} label="Bekleme (saniye)" style={{ marginBottom: 8 }}>
                          <InputNumber min={1} max={300} defaultValue={5} style={{ width: '100%' }} />
                        </Form.Item>
                      )}
                      {stepType === 'notify' && (
                        <>
                          <Form.Item {...rest} name={[name, 'channel_id']} label="Kanal" rules={[{ required: true }]} style={{ marginBottom: 8 }}>
                            <Select
                              placeholder="Bildirim kanalı seçin"
                              options={channelsData?.map(c => ({ value: c.id, label: `${c.name} (${c.type})` })) ?? []}
                            />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'subject']} label="Konu" style={{ marginBottom: 8 }}>
                            <Input placeholder="[NetManager] Playbook çalıştı" />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'message']} label="Mesaj ({hostname} ve {ip} kullanabilirsiniz)" style={{ marginBottom: 8 }}>
                            <Input.TextArea rows={2} placeholder="{hostname} cihazında playbook tamamlandı." />
                          </Form.Item>
                        </>
                      )}
                      {stepType === 'condition_check' && (
                        <>
                          <Form.Item
                            {...rest} name={[name, 'condition']}
                            label="Koşul İfadesi"
                            rules={[{ required: true, message: 'Koşul gerekli' }]}
                            help="Örnek: device.offline_duration_min > 5 veya time.is_business_hours == True"
                            style={{ marginBottom: 8 }}
                          >
                            <Input.TextArea
                              rows={2}
                              placeholder="device.offline_duration_min > 5"
                              style={{ fontFamily: 'monospace', fontSize: 12 }}
                            />
                          </Form.Item>
                          <Form.Item {...rest} name={[name, 'on_false']} label="Koşul Sağlanmazsa" initialValue="skip" style={{ marginBottom: 8 }}>
                            <Select options={[
                              { value: 'skip', label: 'Atla (sonraki adıma geç)' },
                              { value: 'abort', label: 'İptal Et (playbook dur)' },
                            ]} />
                          </Form.Item>
                        </>
                      )}
                      {(stepType === 'ssh_command') && (
                        <Form.Item {...rest} name={[name, 'stop_on_error']} label="Hata durumunda dur"
                          valuePropName="checked" style={{ marginBottom: 0 }}>
                          <Switch size="small" />
                        </Form.Item>
                      )}
                    </Card>
                  )
                })}
              </>
            )}
          </Form.List>
        </Form>
      </Drawer>

      {/* Runs History Modal */}
      <Modal
        title={<Space><HistoryOutlined /> {runsModal?.name} — Çalışma Geçmişi</Space>}
        open={!!runsModal}
        onCancel={() => setRunsModal(null)}
        width={750}
        styles={{ content: { background: C.bg }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}
        footer={[
          <Button key="run" type="primary" icon={<PlayCircleOutlined />}
            loading={runMutation.isPending}
            onClick={() => runsModal && runMutation.mutate({ id: runsModal.id })}>
            Şimdi Çalıştır
          </Button>,
          <Button key="dry" icon={<ExperimentOutlined />}
            loading={runMutation.isPending}
            onClick={() => runsModal && runMutation.mutate({ id: runsModal.id, dry_run: true })}>
            Dry-run
          </Button>,
          <Button key="close" onClick={() => setRunsModal(null)}>Kapat</Button>,
        ]}
      >
        <Table
          dataSource={runsData?.items ?? []}
          rowKey="id"
          loading={runsLoading}
          columns={runColumns}
          size="small"
          pagination={{ pageSize: 10 }}
        />
      </Modal>

      {/* Templates Gallery Modal */}
      <Modal
        title={<Space><AppstoreOutlined /> Hazır Playbook Şablonları</Space>}
        open={templatesModal}
        onCancel={() => { setTemplatesModal(false); setSelectedTemplate(null) }}
        footer={<Button onClick={() => { setTemplatesModal(false); setSelectedTemplate(null) }}>Kapat</Button>}
        width={740}
        styles={{ content: { background: C.bg }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}
      >
        {selectedTemplate ? (
          <div>
            <Button type="link" icon={<AppstoreOutlined />} style={{ padding: 0, marginBottom: 12 }}
              onClick={() => setSelectedTemplate(null)}>← Şablonlara Dön</Button>
            <Card size="small" style={{ marginBottom: 16, background: C.bg2, borderColor: C.border }}>
              <Space direction="vertical" size={4}>
                <Text strong style={{ fontSize: 15 }}>{selectedTemplate.name}</Text>
                <Text type="secondary">{selectedTemplate.description}</Text>
                <Space>
                  <Tag color={TRIGGER_TYPE_COLORS[selectedTemplate.trigger_type]}>
                    {TRIGGER_TYPE_LABELS[selectedTemplate.trigger_type]}
                  </Tag>
                  <Tag icon={<CodeOutlined />}>{selectedTemplate.steps.length} adım</Tag>
                  {selectedTemplate.pre_run_backup && <Tag color="blue">Rollback Yedeği</Tag>}
                </Space>
              </Space>
            </Card>
            <Form
              form={tplForm}
              layout="vertical"
              initialValues={{ name: selectedTemplate.name }}
              onFinish={(v) => createFromTemplateMutation.mutate({
                template_id: selectedTemplate.id,
                name: v.name,
                target_group_id: v.target_group_id,
              })}
            >
              <Form.Item name="name" label="Playbook Adı" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="target_group_id" label="Hedef Grup" tooltip="Boş = tüm aktif cihazlar">
                <Select
                  allowClear
                  placeholder="Grup seçin (opsiyonel)"
                  options={groupsData?.map((g) => ({ value: g.id, label: g.name })) ?? []}
                />
              </Form.Item>
              <Space>
                <Button type="primary" htmlType="submit" loading={createFromTemplateMutation.isPending}>
                  Oluştur
                </Button>
                <Button onClick={() => loadTemplateIntoForm(selectedTemplate)}>
                  Formu Doldur (Düzenleyerek Oluştur)
                </Button>
              </Space>
            </Form>
          </div>
        ) : (
          <Row gutter={[12, 12]}>
            {templatesLoading ? (
              <Col span={24}><Text type="secondary">Yükleniyor...</Text></Col>
            ) : (templatesData ?? []).map((tpl) => (
              <Col span={12} key={tpl.id}>
                <Card
                  size="small"
                  hoverable
                  style={{ cursor: 'pointer', height: '100%' }}
                  onClick={() => { setSelectedTemplate(tpl); tplForm.setFieldsValue({ name: tpl.name }) }}
                >
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Text strong>{tpl.name}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{tpl.description}</Text>
                    <Space style={{ marginTop: 4 }}>
                      <Tag color={TRIGGER_TYPE_COLORS[tpl.trigger_type]} style={{ margin: 0 }}>
                        {TRIGGER_TYPE_LABELS[tpl.trigger_type]}
                      </Tag>
                      <Tag icon={<CodeOutlined />} style={{ margin: 0 }}>{tpl.steps.length} adım</Tag>
                      {tpl.pre_run_backup && <Tag color="blue" style={{ margin: 0, fontSize: 10 }}>rollback</Tag>}
                    </Space>
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Modal>

      {/* Run Detail Modal */}
      <Modal
        title="Çalışma Detayı"
        open={!!runDetailModal}
        onCancel={() => setRunDetailModal(null)}
        width={800}
        styles={{ content: { background: C.bg }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}
        footer={
          <Space>
            {runDetailModal && (
              <>
                <Button
                  icon={<FileTextOutlined />}
                  onClick={() => downloadRunResult(runDetailModal, 'txt')}
                >
                  TXT İndir
                </Button>
                <Button
                  icon={<DownloadOutlined />}
                  onClick={() => downloadRunResult(runDetailModal, 'json')}
                >
                  JSON İndir
                </Button>
              </>
            )}
            <Button onClick={() => setRunDetailModal(null)}>Kapat</Button>
          </Space>
        }
      >
        {runDetailModal && (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              {[
                { label: 'Başarılı', value: runDetailModal.success_devices, color: '#22c55e' },
                { label: 'Başarısız', value: runDetailModal.failed_devices, color: '#ef4444' },
                { label: 'Toplam', value: runDetailModal.total_devices, color: '#3b82f6' },
              ].map((s) => (
                <div key={s.label} style={{
                  background: isDark ? `linear-gradient(135deg, ${s.color}0d 0%, ${C.bg} 60%)` : C.bg,
                  border: `1px solid ${isDark ? s.color + '28' : C.border}`,
                  borderTop: isDark ? `2px solid ${s.color}55` : `2px solid ${s.color}`,
                  borderRadius: 10, padding: '8px 14px', flex: 1,
                }}>
                  <div style={{ color: s.color, fontSize: 20, fontWeight: 700, lineHeight: 1 }}>{s.value}</div>
                  <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>{s.label}</div>
                </div>
              ))}
              <div style={{
                background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 10,
                padding: '8px 14px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
              }}>
                {(() => {
                  const hex = STATUS_HEX[runDetailModal.status] || '#64748b'
                  return <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', margin: 0, display: 'inline-block', width: 'fit-content' }}>{STATUS_LABEL[runDetailModal.status]}</Tag>
                })()}
                <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                  {runDetailModal.triggered_by_username} · {dayjs(runDetailModal.created_at).format('DD.MM HH:mm')}
                </div>
              </div>
            </div>

            <Collapse size="small">
              {Object.entries(runDetailModal.device_results ?? {}).map(([devId, devResult]) => (
                <Collapse.Panel
                  key={devId}
                  header={
                    <Space>
                      {devResult.ok
                        ? <CheckCircleOutlined style={{ color: '#22c55e' }} />
                        : <CloseCircleOutlined style={{ color: '#ef4444' }} />}
                      <strong>{devResult.hostname}</strong>
                      <Text type="secondary" style={{ fontSize: 12 }}>{devResult.ip}</Text>
                    </Space>
                  }
                >
                  {devResult.steps.map((step: any, i: number) => {
                    const stepTypeLabel = STEP_TYPES.find(t => t.value === step.type)?.label ?? 'SSH Komutu'
                    const stepIcon = STEP_TYPES.find(t => t.value === step.type)?.icon ?? '>'
                    return (
                      <div key={i} style={{ marginBottom: 8 }}>
                        <Space>
                          {step.success
                            ? <CheckCircleOutlined style={{ color: '#22c55e' }} />
                            : <CloseCircleOutlined style={{ color: '#ef4444' }} />}
                          <Tag style={{ margin: 0 }}>{stepIcon} {stepTypeLabel}</Tag>
                          {step.command && <code style={{ fontSize: 12 }}>{step.command}</code>}
                          {step.description && <Text type="secondary" style={{ fontSize: 11 }}>— {step.description}</Text>}
                          {step.simulated && <Tag color="purple" style={{ fontSize: 10, margin: 0 }}>simüle</Tag>}
                        </Space>
                        {(step.output || step.error) && (
                          <pre style={{
                            background: '#1e1e1e', color: step.success ? '#d4d4d4' : '#f48771',
                            padding: '6px 10px', borderRadius: 4, fontSize: 11,
                            marginTop: 4, marginBottom: 0, maxHeight: 150, overflow: 'auto',
                          }}>
                            {step.output || step.error}
                          </pre>
                        )}
                      </div>
                    )
                  })}
                </Collapse.Panel>
              ))}
            </Collapse>
          </>
        )}
      </Modal>
    </div>
  )
}
