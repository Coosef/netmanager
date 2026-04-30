import { useState } from 'react'
import {
  Badge, Button, Collapse, Descriptions, Drawer, Form, Input,
  message, Modal, Popconfirm, Progress, Select, Space,
  Steps, Table, Tag, Tooltip, Typography,
} from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined, CodeOutlined, DeleteOutlined,
  ExclamationCircleOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined,
  RollbackOutlined, SendOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { changeRolloutsApi, type ChangeRollout } from '@/api/changeRollouts'
import { configTemplatesApi } from '@/api/configTemplates'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import dayjs from 'dayjs'

const { Text } = Typography
const { TextArea } = Input

const CHANGE_CSS = `
@keyframes changeRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.change-row-running td { background: rgba(59,130,246,0.04) !important; }
.change-row-failed  td { background: rgba(239,68,68,0.03) !important; }
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

const STATUS_HEX: Record<string, string> = {
  draft: '#64748b', pending_approval: '#f59e0b', approved: '#22c55e',
  running: '#3b82f6', done: '#22c55e', partial: '#f59e0b',
  failed: '#ef4444', rolled_back: '#8b5cf6',
}
const STATUS_COLOR: Record<string, 'default' | 'processing' | 'success' | 'error' | 'warning'> = {
  draft: 'default', pending_approval: 'warning', approved: 'success',
  running: 'processing', done: 'success', partial: 'warning',
  failed: 'error', rolled_back: 'default',
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Taslak',
  pending_approval: 'Onay Bekliyor',
  approved: 'Onaylandı',
  running: 'Çalışıyor',
  done: 'Tamamlandı',
  partial: 'Kısmi',
  failed: 'Başarısız',
  rolled_back: 'Geri Alındı',
}

// ─── Status step index ───────────────────────────────────────────────────────
const STATUS_STEP: Record<string, number> = {
  draft: 0,
  pending_approval: 1,
  approved: 2,
  running: 3,
  done: 4,
  partial: 4,
  failed: 4,
  rolled_back: 4,
}

export default function ChangeManagement() {
  const user = useAuthStore((s) => s.user)
  const qc = useQueryClient()
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const [statusFilter, setStatusFilter] = useState<string | undefined>()
  const [createOpen, setCreateOpen] = useState(false)
  const [detailRollout, setDetailRollout] = useState<ChangeRollout | null>(null)
  const [form] = Form.useForm()
  const [commandMode, setCommandMode] = useState<'template' | 'raw'>('template')
  const [rejectModalId, setRejectModalId] = useState<number | null>(null)
  const [rejectNote, setRejectNote] = useState('')

  const isAdmin = user?.role === 'super_admin' || user?.role === 'admin'

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['change-rollouts', statusFilter],
    queryFn: () => changeRolloutsApi.list({ status: statusFilter, limit: 100 }),
    refetchInterval: 8000,
  })

  const { data: templates = [] } = useQuery({
    queryKey: ['config-templates'],
    queryFn: () => configTemplatesApi.list(),
  })

  const { data: devices = [] } = useQuery({
    queryKey: ['devices-simple', activeSite],
    queryFn: () => devicesApi.list({ limit: 2000, site: activeSite || undefined }).then((r: any) => r.items || r),
  })

  // ── Detail auto-refresh when running ──────────────────────────────────────
  const { data: liveDetail } = useQuery({
    queryKey: ['change-rollout-detail', detailRollout?.id],
    queryFn: () => changeRolloutsApi.get(detailRollout!.id),
    enabled: !!detailRollout && detailRollout.status === 'running',
    refetchInterval: 3000,
  })
  const displayedRollout = liveDetail || detailRollout

  // ── Mutations ──────────────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (vals: any) => {
      const payload: any = {
        name: vals.name,
        description: vals.description,
        device_ids: vals.device_ids,
      }
      if (commandMode === 'template') {
        payload.template_id = vals.template_id
        payload.template_variables = vals.template_variables || {}
      } else {
        payload.raw_commands = vals.raw_commands
          .split('\n')
          .map((l: string) => l.trim())
          .filter(Boolean)
      }
      return changeRolloutsApi.create(payload)
    },
    onSuccess: () => {
      message.success('Değişiklik talebi oluşturuldu')
      setCreateOpen(false)
      form.resetFields()
      qc.invalidateQueries({ queryKey: ['change-rollouts'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const submitMutation = useMutation({
    mutationFn: (id: number) => changeRolloutsApi.submit(id),
    onSuccess: () => { message.success('Onaya gönderildi'); qc.invalidateQueries({ queryKey: ['change-rollouts'] }) },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const approveMutation = useMutation({
    mutationFn: (id: number) => changeRolloutsApi.approve(id),
    onSuccess: (r) => {
      message.success('Onaylandı')
      qc.invalidateQueries({ queryKey: ['change-rollouts'] })
      setDetailRollout(r)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) => changeRolloutsApi.reject(id, note),
    onSuccess: (r) => {
      message.success('Reddedildi')
      setRejectModalId(null)
      qc.invalidateQueries({ queryKey: ['change-rollouts'] })
      setDetailRollout(r)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const startMutation = useMutation({
    mutationFn: (id: number) => changeRolloutsApi.start(id),
    onSuccess: () => {
      message.success('Rollout başlatıldı')
      qc.invalidateQueries({ queryKey: ['change-rollouts'] })
      if (detailRollout) setDetailRollout({ ...detailRollout, status: 'running' })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const rollbackMutation = useMutation({
    mutationFn: (id: number) => changeRolloutsApi.rollback(id),
    onSuccess: () => {
      message.success('Rollback başlatıldı')
      qc.invalidateQueries({ queryKey: ['change-rollouts'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => changeRolloutsApi.delete(id),
    onSuccess: () => {
      message.success('Silindi')
      qc.invalidateQueries({ queryKey: ['change-rollouts'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  // ── Derived stats ─────────────────────────────────────────────────────────
  const allItems = data?.items || []
  const statCards = [
    { label: 'Toplam', value: allItems.length, color: '#3b82f6' },
    { label: 'Onay Bekliyor', value: allItems.filter((r) => r.status === 'pending_approval').length, color: '#f59e0b' },
    { label: 'Çalışıyor', value: allItems.filter((r) => r.status === 'running').length, color: '#3b82f6' },
    { label: 'Başarısız', value: allItems.filter((r) => r.status === 'failed').length, color: '#ef4444' },
    { label: 'Tamamlandı', value: allItems.filter((r) => r.status === 'done').length, color: '#22c55e' },
  ]

  // ── Helpers ────────────────────────────────────────────────────────────────
  const columns = [
    {
      title: 'Değişiklik Adı',
      dataIndex: 'name',
      render: (name: string, row: ChangeRollout) => (
        <a style={{ color: '#3b82f6', fontWeight: 600 }} onClick={() => setDetailRollout(row)}>{name}</a>
      ),
    },
    {
      title: 'Durum',
      dataIndex: 'status',
      render: (s: string) => {
        const hex = STATUS_HEX[s] || '#64748b'
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: hex, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: C.text }}>{STATUS_LABEL[s] || s}</span>
          </span>
        )
      },
    },
    {
      title: 'Cihaz',
      render: (_: any, r: ChangeRollout) => (
        <span style={{ fontSize: 12, color: C.text }}>
          <span style={{ color: '#22c55e', fontWeight: 600 }}>{r.success_devices}</span>
          <span style={{ color: C.dim }}>/{r.total_devices}</span>
          {r.failed_devices > 0 && <Tag style={{ marginLeft: 4, fontSize: 10, color: '#ef4444', borderColor: '#ef444450', background: '#ef444418' }}>{r.failed_devices} hata</Tag>}
        </span>
      ),
    },
    {
      title: 'Oluşturan',
      dataIndex: 'created_by',
      render: (v: string) => <span style={{ fontSize: 12, color: C.muted }}>{v}</span>,
    },
    {
      title: 'Tarih',
      dataIndex: 'created_at',
      render: (d: string) => <span style={{ fontSize: 12, color: C.muted }}>{dayjs(d).format('DD.MM.YY HH:mm')}</span>,
    },
    {
      title: 'İşlemler',
      render: (_: any, r: ChangeRollout) => (
        <Space size="small">
          {r.status === 'draft' && (
            <Tooltip title="Onaya Gönder">
              <Button size="small" icon={<SendOutlined />}
                loading={submitMutation.isPending}
                onClick={() => submitMutation.mutate(r.id)} />
            </Tooltip>
          )}
          {r.status === 'pending_approval' && isAdmin && (
            <>
              <Tooltip title="Onayla">
                <Button size="small" type="primary" icon={<CheckCircleOutlined />}
                  loading={approveMutation.isPending}
                  onClick={() => approveMutation.mutate(r.id)} />
              </Tooltip>
              <Tooltip title="Reddet">
                <Button size="small" danger icon={<CloseCircleOutlined />}
                  onClick={() => { setRejectModalId(r.id); setRejectNote('') }} />
              </Tooltip>
            </>
          )}
          {r.status === 'approved' && (
            <Tooltip title="Başlat">
              <Button size="small" type="primary" icon={<PlayCircleOutlined />}
                loading={startMutation.isPending}
                onClick={() => startMutation.mutate(r.id)} />
            </Tooltip>
          )}
          {['done', 'partial', 'failed'].includes(r.status) && (
            <Tooltip title="Geri Al (Rollback)">
              <Popconfirm title="Cihazları yedekten geri yüklemek istediğinize emin misiniz?"
                onConfirm={() => rollbackMutation.mutate(r.id)}
                okText="Evet" cancelText="Hayır">
                <Button size="small" danger icon={<RollbackOutlined />}
                  loading={rollbackMutation.isPending} />
              </Popconfirm>
            </Tooltip>
          )}
          {['draft', 'rolled_back', 'done', 'partial', 'failed'].includes(r.status) && (
            <Popconfirm title="Silinsin mi?" onConfirm={() => deleteMutation.mutate(r.id)}
              okText="Evet" cancelText="Hayır">
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{CHANGE_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#8b5cf620' : C.border}`,
        borderLeft: '4px solid #8b5cf6',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#8b5cf620', border: '1px solid #8b5cf630',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <CodeOutlined style={{ color: '#8b5cf6', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>Değişiklik Yönetimi</div>
            <div style={{ color: C.muted, fontSize: 12 }}>Onay tabanlı config değişikliği rollout'ları — 8s otomatik yenileme</div>
          </div>
        </div>
        <Space>
          <Select
            placeholder="Durum filtrele"
            allowClear
            size="small"
            style={{ width: 180 }}
            options={Object.entries(STATUS_LABEL).map(([v, l]) => ({ value: v, label: l }))}
            onChange={(v) => setStatusFilter(v)}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()} />
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            Yeni Değişiklik
          </Button>
        </Space>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {statCards.map((s) => (
          <div key={s.label} style={{
            flex: 1, minWidth: 100,
            background: isDark ? `linear-gradient(135deg, ${s.color}0d 0%, ${C.bg} 60%)` : C.bg,
            border: `1px solid ${isDark ? s.color + '28' : C.border}`,
            borderTop: `2px solid ${s.color}`,
            borderRadius: 10, padding: '10px 16px',
          }}>
            <div style={{ color: s.color, fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{s.value}</div>
            <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <Table
          dataSource={data?.items || []}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          pagination={{ pageSize: 20 }}
          size="small"
          rowClassName={(r: ChangeRollout) =>
            r.status === 'running' ? 'change-row-running' :
            r.status === 'failed' ? 'change-row-failed' : ''
          }
          onRow={() => ({ style: { animation: 'changeRowIn 0.2s ease-out' } })}
        />
      </div>

      {/* ── Create Modal ───────────────────────────────────────────────── */}
      <Modal
        title={<Space><CodeOutlined style={{ color: '#8b5cf6' }} /><span style={{ color: C.text }}>Yeni Değişiklik Talebi</span></Space>}
        open={createOpen}
        onCancel={() => { setCreateOpen(false); form.resetFields() }}
        onOk={() => form.submit()}
        confirmLoading={createMutation.isPending}
        okText="Oluştur (Taslak)"
        width={600}
        styles={{ content: { background: C.bg, border: `1px solid ${C.border}` }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}
      >
        <Form form={form} layout="vertical" onFinish={createMutation.mutate}>
          <Form.Item name="name" label="Değişiklik Adı" rules={[{ required: true }]}>
            <Input placeholder="örn: NTP sunucu ekleme — Tüm core cihazlar" />
          </Form.Item>
          <Form.Item name="description" label="Açıklama">
            <TextArea rows={2} />
          </Form.Item>

          <Form.Item label="Komut Kaynağı">
            <Select
              value={commandMode}
              onChange={setCommandMode}
              options={[
                { label: 'Hazır Şablondan', value: 'template' },
                { label: 'Doğrudan Komutlar', value: 'raw' },
              ]}
            />
          </Form.Item>

          {commandMode === 'template' && (
            <>
              <Form.Item name="template_id" label="Şablon" rules={[{ required: true }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="Şablon seç"
                  options={(templates as any[]).map((t: any) => ({ label: t.name, value: t.id }))}
                />
              </Form.Item>
              <Form.Item name="template_variables" label="Şablon Değişkenleri (JSON)">
                <TextArea rows={3} placeholder={'{"community": "netmanager", "ntp_server": "10.0.0.1"}'} />
              </Form.Item>
            </>
          )}

          {commandMode === 'raw' && (
            <Form.Item name="raw_commands" label="Komutlar (her satır bir komut)" rules={[{ required: true }]}>
              <TextArea rows={5} placeholder={'ntp server 10.0.0.1\nlogging host 10.0.0.2'} />
            </Form.Item>
          )}

          <Form.Item name="device_ids" label="Hedef Cihazlar" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="Cihaz seç"
              maxTagCount="responsive"
              options={devices.map((d: any) => ({
                label: `${d.hostname} (${d.ip_address})`,
                value: d.id,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Reject Modal ───────────────────────────────────────────────── */}
      <Modal
        title={<span style={{ color: C.text }}>Reddet — Gerekçe</span>}
        open={rejectModalId !== null}
        onCancel={() => setRejectModalId(null)}
        onOk={() => rejectModalId !== null && rejectMutation.mutate({ id: rejectModalId, note: rejectNote })}
        confirmLoading={rejectMutation.isPending}
        okText="Reddet" okButtonProps={{ danger: true }}
        styles={{ content: { background: C.bg, border: `1px solid ${C.border}` }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}
      >
        <Input.TextArea
          rows={3}
          placeholder="Reddetme gerekçesi…"
          value={rejectNote}
          onChange={(e) => setRejectNote(e.target.value)}
        />
      </Modal>

      {/* ── Detail Drawer ───────────────────────────────────────────────── */}
      {displayedRollout && (
        <Drawer
          title={<span style={{ color: C.text }}>{displayedRollout.name}</span>}
          open={!!detailRollout}
          onClose={() => setDetailRollout(null)}
          width={720}
          styles={{ body: { background: C.bg }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}
          extra={
            <Space>
              {displayedRollout.status === 'draft' && (
                <Button type="primary" icon={<SendOutlined />}
                  loading={submitMutation.isPending}
                  onClick={() => submitMutation.mutate(displayedRollout.id)}>
                  Onaya Gönder
                </Button>
              )}
              {displayedRollout.status === 'pending_approval' && isAdmin && (
                <>
                  <Button type="primary" icon={<CheckCircleOutlined />}
                    loading={approveMutation.isPending}
                    onClick={() => approveMutation.mutate(displayedRollout.id)}>
                    Onayla
                  </Button>
                  <Button danger icon={<CloseCircleOutlined />}
                    onClick={() => { setRejectModalId(displayedRollout.id); setRejectNote('') }}>
                    Reddet
                  </Button>
                </>
              )}
              {displayedRollout.status === 'approved' && (
                <Button type="primary" icon={<PlayCircleOutlined />}
                  loading={startMutation.isPending}
                  onClick={() => startMutation.mutate(displayedRollout.id)}>
                  Başlat
                </Button>
              )}
              {['done', 'partial', 'failed'].includes(displayedRollout.status) && (
                <Popconfirm
                  title="Başarılı cihazlar yedekten geri yüklenecek. Devam?"
                  onConfirm={() => rollbackMutation.mutate(displayedRollout.id)}
                  okText="Evet" cancelText="Hayır">
                  <Button danger icon={<RollbackOutlined />} loading={rollbackMutation.isPending}>
                    Rollback
                  </Button>
                </Popconfirm>
              )}
            </Space>
          }
        >
          {/* Status steps */}
          <Steps
            size="small"
            current={STATUS_STEP[displayedRollout.status] ?? 0}
            status={['failed', 'partial'].includes(displayedRollout.status) ? 'error' : 'process'}
            style={{ marginBottom: 24 }}
            items={[
              { title: 'Taslak' },
              { title: 'Onay Bekliyor' },
              { title: 'Onaylandı' },
              { title: 'Çalışıyor' },
              { title: STATUS_LABEL[displayedRollout.status] || 'Bitti' },
            ]}
          />

          {displayedRollout.rejection_note && (
            <div style={{ marginBottom: 16, padding: '8px 12px', background: '#fff1f0', border: '1px solid #ffa39e', borderRadius: 6 }}>
              <ExclamationCircleOutlined style={{ color: '#f5222d', marginRight: 8 }} />
              <Text type="danger">Reddedildi: {displayedRollout.rejection_note}</Text>
            </div>
          )}

          <Descriptions bordered size="small" column={2} style={{ marginBottom: 16 }}>
            <Descriptions.Item label="Durum" span={2}>
              <Badge status={STATUS_COLOR[displayedRollout.status] as any} text={STATUS_LABEL[displayedRollout.status]} />
            </Descriptions.Item>
            <Descriptions.Item label="Oluşturan">{displayedRollout.created_by}</Descriptions.Item>
            <Descriptions.Item label="Onaylayan">{displayedRollout.approved_by ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Başlangıç">
              {displayedRollout.started_at ? dayjs(displayedRollout.started_at).format('DD.MM.YY HH:mm:ss') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Bitiş">
              {displayedRollout.completed_at ? dayjs(displayedRollout.completed_at).format('DD.MM.YY HH:mm:ss') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Cihazlar" span={2}>
              <Space>
                <Tag color="default">{displayedRollout.total_devices} toplam</Tag>
                {displayedRollout.success_devices > 0 && <Tag color="success">{displayedRollout.success_devices} başarılı</Tag>}
                {displayedRollout.failed_devices > 0 && <Tag color="error">{displayedRollout.failed_devices} hatalı</Tag>}
                {displayedRollout.rolled_back_devices > 0 && <Tag color="purple">{displayedRollout.rolled_back_devices} geri alındı</Tag>}
              </Space>
            </Descriptions.Item>
          </Descriptions>

          {/* Progress bar during run */}
          {displayedRollout.status === 'running' && (
            <Progress
              percent={displayedRollout.total_devices > 0
                ? Math.round(((displayedRollout.success_devices + displayedRollout.failed_devices) / displayedRollout.total_devices) * 100)
                : 0}
              status="active"
              style={{ marginBottom: 16 }}
            />
          )}

          {/* Per-device results */}
          {displayedRollout.device_results && (
            <Collapse
              size="small"
              items={Object.entries(displayedRollout.device_results).map(([devId, res]) => {
                const icon = res.status === 'success'
                  ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  : res.status === 'rolled_back'
                    ? <RollbackOutlined style={{ color: '#722ed1' }} />
                    : <CloseCircleOutlined style={{ color: '#f5222d' }} />

                return {
                  key: devId,
                  label: (
                    <Space>
                      {icon}
                      <strong>{res.hostname}</strong>
                      <Text type="secondary" style={{ fontSize: 12 }}>{res.ip}</Text>
                      <Tag color={res.status === 'success' ? 'success' : res.status === 'rolled_back' ? 'purple' : 'error'}>
                        {res.status}
                      </Tag>
                      {res.backup_id && <Tag color="blue">Yedek #{res.backup_id}</Tag>}
                    </Space>
                  ),
                  children: (
                    <div style={{ fontSize: 12 }}>
                      {res.output && (
                        <pre style={{ background: '#0d1117', color: '#e6edf3', padding: 10, borderRadius: 4, overflow: 'auto', maxHeight: 200 }}>
                          {res.output}
                        </pre>
                      )}
                      {res.error && <Text type="danger">{res.error}</Text>}
                      {res.rollback_error && (
                        <div><Text type="warning">Rollback hatası: {res.rollback_error}</Text></div>
                      )}
                      {res.diff && res.diff.length > 0 && (
                        <details style={{ marginTop: 8 }}>
                          <summary style={{ cursor: 'pointer', color: '#1677ff' }}>
                            Config Diff ({res.diff.length} satır)
                          </summary>
                          <pre style={{ background: '#0d1117', color: '#e6edf3', padding: 10, borderRadius: 4, overflow: 'auto', maxHeight: 300, fontSize: 11 }}>
                            {res.diff.map((line, i) => {
                              const color = line.startsWith('+') && !line.startsWith('+++') ? '#3fb950'
                                : line.startsWith('-') && !line.startsWith('---') ? '#f85149'
                                : '#8b949e'
                              return <span key={i} style={{ color }}>{line}{'\n'}</span>
                            })}
                          </pre>
                        </details>
                      )}
                    </div>
                  ),
                }
              })}
            />
          )}
        </Drawer>
      )}
    </div>
  )
}
