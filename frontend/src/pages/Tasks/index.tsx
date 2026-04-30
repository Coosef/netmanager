import { useState, useEffect, useRef } from 'react'
import {
  App, Button, Col, Form, Input, Modal, Popconfirm, Progress, Row,
  Select, Space, Table, Tag,
} from 'antd'
import { useTranslation } from 'react-i18next'
import {
  PlusOutlined, EyeOutlined, StopOutlined,
  ThunderboltOutlined, ClockCircleOutlined,
  SyncOutlined, PlayCircleOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { tasksApi } from '@/api/tasks'
import { devicesApi } from '@/api/devices'
import { useTheme } from '@/contexts/ThemeContext'
import type { Task, Device } from '@/types'
import { buildWsUrl } from '@/utils/ws'
import { TASK_TYPE_OPTIONS } from '@/types'
import dayjs from 'dayjs'

const TASKS_CSS = `
@keyframes tasksRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes tasksPulseBlue {
  0%, 100% { box-shadow: 0 0 0 0 #3b82f630; }
  50%       { box-shadow: 0 0 0 4px #3b82f618; }
}
@keyframes tasksTermBlink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
@keyframes tasksLogIn {
  from { opacity: 0; transform: translateX(-6px); }
  to   { opacity: 1; transform: translateX(0); }
}
.tasks-row-running td { background: rgba(59,130,246,0.04) !important; }
.tasks-row-running:hover td { background: rgba(59,130,246,0.08) !important; }
.tasks-row-failed td { background: rgba(239,68,68,0.03) !important; }
`

const STATUS_HEX: Record<string, string> = {
  pending: '#64748b', running: '#3b82f6', success: '#22c55e',
  partial: '#f59e0b', failed: '#ef4444', cancelled: '#475569',
}

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

interface ProgressEvent {
  task_id: number
  completed: number
  failed: number
  depth?: number
  ip?: string
  hostname?: string
  found?: number
  error?: string
  status?: string
}

function TaskProgressModal({ task, onClose, isDark }: { task: Task; onClose: () => void; isDark: boolean }) {
  const [liveTask, setLiveTask] = useState<Task>(task)
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const queryClient = useQueryClient()
  const eventsEndRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()
  const C = mkC(isDark)

  useEffect(() => {
    if (!['pending', 'running'].includes(task.status)) return
    const wsUrl = buildWsUrl(`/api/v1/ws/tasks/${task.id}`)
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    ws.onmessage = (e) => {
      try {
        const data: ProgressEvent = JSON.parse(e.data)
        setLiveTask((prev) => ({
          ...prev,
          completed_devices: data.completed ?? prev.completed_devices,
          failed_devices: data.failed ?? prev.failed_devices,
          status: (data.status || prev.status) as Task['status'],
        }))
        setEvents((prev) => [...prev.slice(-99), data])
        if (data.status === 'success' || data.status === 'failed') {
          queryClient.invalidateQueries({ queryKey: ['tasks'] })
        }
        eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      } catch {}
    }
    ws.onerror = () => {}
    return () => ws.close()
  }, [task.id])

  const percent = liveTask.total_devices
    ? Math.round(((liveTask.completed_devices + liveTask.failed_devices) / liveTask.total_devices) * 100)
    : 0
  const isActive = ['pending', 'running'].includes(liveTask.status)
  const statusHex = STATUS_HEX[liveTask.status] || '#64748b'

  const statItems = [
    { label: t('tasks.devices_total'), value: liveTask.total_devices, color: '#3b82f6' },
    { label: t('tasks.devices_done'), value: liveTask.completed_devices, color: '#22c55e' },
    { label: t('tasks.devices_failed'), value: liveTask.failed_devices, color: '#ef4444' },
  ]

  return (
    <Modal
      open
      onCancel={onClose}
      footer={null}
      title={
        <Space>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusHex, boxShadow: `0 0 6px ${statusHex}` }} />
          <span style={{ color: C.text }}>{task.name}</span>
        </Space>
      }
      width={700}
      styles={{
        content: { background: C.bg, border: `1px solid ${C.border}` },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        {/* Status + type */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Tag style={{ color: statusHex, borderColor: statusHex + '50', background: statusHex + '18', fontSize: 12 }}>
            {liveTask.status.toUpperCase()}
          </Tag>
          <Tag style={{ color: C.muted, borderColor: C.border, background: C.bg2, fontSize: 11 }}>
            {liveTask.type}
          </Tag>
          {liveTask.status === 'running' && (
            <span style={{ fontSize: 12, color: '#3b82f6', animation: 'tasksPulseBlue 2s ease-in-out infinite' }}>
              <SyncOutlined spin style={{ marginRight: 4 }} />
              {liveTask.completed_devices + liveTask.failed_devices} / {liveTask.total_devices}
            </span>
          )}
        </div>

        {/* Progress */}
        <div style={{
          background: C.bg2, border: `1px solid ${C.border}`,
          borderRadius: 8, padding: '10px 14px',
        }}>
          <Progress
            percent={percent}
            status={liveTask.status === 'failed' ? 'exception' : liveTask.status === 'success' ? 'success' : isActive ? 'active' : undefined}
            strokeColor={isActive ? '#3b82f6' : undefined}
            style={{ marginBottom: 4 }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.muted }}>
            <span>%{percent} tamamlandı</span>
            {liveTask.created_at && <span>{dayjs(liveTask.created_at).format('DD.MM HH:mm')}</span>}
          </div>
        </div>

        {/* Stat cards */}
        <Row gutter={12}>
          {statItems.map((s) => (
            <Col span={8} key={s.label}>
              <div style={{
                background: isDark ? `${s.color}12` : `${s.color}08`,
                border: `1px solid ${s.color}30`,
                borderTop: `2px solid ${s.color}60`,
                borderRadius: 8, padding: '10px 14px', textAlign: 'center',
              }}>
                <div style={{ color: C.muted, fontSize: 11, marginBottom: 4 }}>{s.label}</div>
                <div style={{ color: s.color, fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{s.value}</div>
              </div>
            </Col>
          ))}
        </Row>

        {/* Live terminal log */}
        {events.length > 0 && (
          <div style={{
            background: '#0a0f1e',
            border: '1px solid #1e3a5f',
            borderRadius: 8,
            padding: '10px 14px',
            maxHeight: 220,
            overflowY: 'auto',
          }}>
            <div style={{ color: '#3b82f6', fontSize: 10, fontWeight: 700, letterSpacing: 2, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6', animation: 'tasksPulseBlue 1.5s ease-in-out infinite' }} />
              {t('tasks.live_progress')}
            </div>
            {events.slice(-30).map((ev, i) => (
              <div key={i} style={{
                fontFamily: 'monospace', fontSize: 11,
                color: ev.error ? '#f87171' : ev.found ? '#34d399' : '#94a3b8',
                padding: '1px 0',
                animation: 'tasksLogIn 0.15s ease-out',
              }}>
                <span style={{ color: '#475569', marginRight: 8 }}>{String(i).padStart(3, '0')}</span>
                {ev.error
                  ? <span style={{ color: '#f87171' }}>✗ {ev.ip || ev.hostname || `#${ev.task_id}`} — {ev.error.slice(0, 60)}</span>
                  : <span>
                      <span style={{ color: '#22c55e' }}>✓</span>
                      {' '}{ev.ip || ev.hostname || `#${ev.task_id}`}
                      {ev.depth !== undefined && <span style={{ color: '#6366f1', marginLeft: 8 }}>hop:{ev.depth}</span>}
                      {ev.found !== undefined && ev.found > 0 && <span style={{ color: '#34d399', marginLeft: 8 }}>+{ev.found} switch</span>}
                    </span>
                }
              </div>
            ))}
            <div ref={eventsEndRef} />
          </div>
        )}

        {isActive && events.length === 0 && (
          <div style={{
            background: '#0a0f1e', border: '1px solid #1e3a5f',
            borderRadius: 8, padding: '16px 14px',
            fontFamily: 'monospace', fontSize: 12, color: '#3b82f6',
          }}>
            <span style={{ animation: 'tasksTermBlink 1s infinite', marginRight: 4 }}>▌</span>
            Görev başlatılıyor...
          </div>
        )}
      </Space>
    </Modal>
  )
}

export default function TasksPage() {
  const { message } = App.useApp()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [taskType, setTaskType] = useState<string>()
  const [page, setPage] = useState(1)
  const pageSize = 20

  const { data: tasksData, isLoading } = useQuery({
    queryKey: ['tasks', page],
    queryFn: () => tasksApi.list({ skip: (page - 1) * pageSize, limit: pageSize }),
    refetchInterval: 5000,
  })

  const { data: devicesData } = useQuery({
    queryKey: ['devices-all'],
    queryFn: () => devicesApi.list({ limit: 2000 }),
  })

  const createMutation = useMutation({
    mutationFn: tasksApi.create,
    onSuccess: () => {
      message.success(t('tasks.started'))
      setCreateOpen(false)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (err: any) => message.error(err?.response?.data?.detail || t('common.error')),
  })

  const cancelMutation = useMutation({
    mutationFn: (id: number) => tasksApi.cancel(id),
    onSuccess: () => {
      message.success(t('tasks.cancelled'))
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (err: any) => message.error(err?.response?.data?.detail || t('tasks.cancel_error')),
  })

  const deviceOptions = (devicesData?.items || []).map((d: Device) => ({
    label: `${d.hostname} (${d.ip_address})`,
    value: d.id,
  }))

  const runningCount = tasksData?.items.filter((t) => t.status === 'running').length ?? 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{TASKS_CSS}</style>

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
            <PlayCircleOutlined style={{ color: '#3b82f6', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>
              {t('tasks.title')}
              {runningCount > 0 && (
                <Tag style={{ marginLeft: 8, fontSize: 11, color: '#3b82f6', borderColor: '#3b82f650', background: '#3b82f618', animation: 'tasksPulseBlue 2s infinite' }}>
                  <SyncOutlined spin style={{ marginRight: 4 }} />{runningCount} çalışıyor
                </Tag>
              )}
            </div>
            <div style={{ color: C.muted, fontSize: 12 }}>Otomasyon görevleri ve konfigürasyon işlemleri</div>
          </div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {t('tasks.create')}
        </Button>
      </div>

      {/* Table */}
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <Table<Task>
          dataSource={tasksData?.items || []}
          rowKey="id"
          loading={isLoading}
          size="small"
          rowClassName={(r) =>
            r.status === 'running' ? 'tasks-row-running'
            : r.status === 'failed' ? 'tasks-row-failed' : ''
          }
          onRow={() => ({
            style: { animation: 'tasksRowIn 0.2s ease-out' },
          })}
          pagination={{
            total: tasksData?.total, pageSize, current: page, onChange: setPage,
            showTotal: (n) => <span style={{ color: C.muted }}>{n} görev</span>,
          }}
          columns={[
            {
              title: t('tasks.col_name'),
              dataIndex: 'name',
              ellipsis: true,
              render: (v) => <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>{v}</span>,
            },
            {
              title: t('tasks.col_type'),
              dataIndex: 'type',
              render: (v) => (
                <Tag style={{ fontSize: 11, color: C.muted, borderColor: C.border, background: C.bg2 }}>{v}</Tag>
              ),
            },
            {
              title: t('tasks.col_status'),
              dataIndex: 'status',
              width: 110,
              render: (v) => {
                const hex = STATUS_HEX[v] || '#64748b'
                return (
                  <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>
                    {v === 'running' && <SyncOutlined spin style={{ marginRight: 4 }} />}
                    {v.toUpperCase()}
                  </Tag>
                )
              },
            },
            {
              title: t('tasks.col_progress'),
              width: 160,
              render: (_, r) => (
                <Progress
                  percent={r.total_devices ? Math.round(((r.completed_devices + r.failed_devices) / r.total_devices) * 100) : 0}
                  size="small"
                  status={r.status === 'failed' ? 'exception' : r.status === 'success' ? 'success' : r.status === 'running' ? 'active' : 'normal'}
                  strokeColor={r.status === 'running' ? '#3b82f6' : r.status === 'partial' ? '#f59e0b' : undefined}
                />
              ),
            },
            {
              title: t('tasks.col_devices'),
              width: 80,
              render: (_, r) => (
                <span style={{ fontSize: 12, color: C.muted, fontFamily: 'monospace' }}>
                  <span style={{ color: '#22c55e' }}>{r.completed_devices}</span>
                  <span style={{ color: C.dim }}>/{r.total_devices}</span>
                </span>
              ),
            },
            {
              title: t('tasks.col_created'),
              dataIndex: 'created_at',
              width: 110,
              render: (v) => (
                <span style={{ fontSize: 12, color: C.muted }}>
                  <ClockCircleOutlined style={{ marginRight: 4, fontSize: 10 }} />
                  {dayjs(v).format('DD.MM HH:mm')}
                </span>
              ),
            },
            {
              title: '',
              width: 90,
              render: (_, r) => (
                <Space size={4}>
                  <Button
                    size="small"
                    icon={<EyeOutlined />}
                    onClick={() => setSelectedTask(r)}
                    style={{ color: C.muted, borderColor: C.border }}
                  />
                  {(r.status === 'pending' || r.status === 'running') && (
                    <Popconfirm
                      title={t('tasks.cancel_task')}
                      description={t('tasks.cancel_confirm')}
                      onConfirm={() => cancelMutation.mutate(r.id)}
                      okButtonProps={{ danger: true }}
                    >
                      <Button size="small" danger icon={<StopOutlined />} loading={cancelMutation.isPending} />
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </div>

      {/* Create modal */}
      <Modal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        title={<span style={{ color: C.text }}>{t('tasks.create_title')}</span>}
        footer={null}
        width={600}
        destroyOnHidden
        styles={{
          content: { background: C.bg, border: `1px solid ${C.border}` },
          header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
        }}
      >
        <Form layout="vertical" onFinish={(values) => createMutation.mutate(values)}>
          <Form.Item label={t('tasks.task_name')} name="name" rules={[{ required: true }]}>
            <Input placeholder={t('tasks.task_name_placeholder')} />
          </Form.Item>
          <Form.Item label={t('tasks.task_type')} name="type" rules={[{ required: true }]}>
            <Select options={TASK_TYPE_OPTIONS} onChange={setTaskType} />
          </Form.Item>
          <Form.Item label={t('tasks.devices_label')} name="device_ids" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              options={deviceOptions}
              showSearch
              filterOption={(input, opt) =>
                (opt?.label as string)?.toLowerCase().includes(input.toLowerCase())
              }
              placeholder={t('tasks.all_devices')}
              maxTagCount={5}
            />
          </Form.Item>
          {taskType === 'bulk_command' && (
            <Form.Item label="Commands" name={['parameters', 'commands']}>
              <Input.TextArea rows={4} placeholder="show version&#10;show interfaces" style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </Form.Item>
          )}
          {taskType === 'bulk_password_change' && (
            <Form.Item label={t('devices.ssh_password')} name={['parameters', 'new_password']} rules={[{ required: true }]}>
              <Input.Password />
            </Form.Item>
          )}
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={createMutation.isPending} block icon={<ThunderboltOutlined />}>
              {t('tasks.create_btn')}
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      {selectedTask && (
        <TaskProgressModal task={selectedTask} onClose={() => setSelectedTask(null)} isDark={isDark} />
      )}
    </div>
  )
}
