import { useState, useMemo, useEffect, useRef } from 'react'
import {
  Button, Drawer, Form, Input, InputNumber, Select, Switch, Table, Tag, Tooltip,
  Popconfirm, message, Space, Badge, Segmented, Progress, Tabs, Collapse, notification,
} from 'antd'
import {
  AlertOutlined, PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleOutlined,
  ClockCircleOutlined, FireOutlined, ExclamationCircleOutlined, CheckOutlined,
  BranchesOutlined,
} from '@ant-design/icons'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, Cell,
} from 'recharts'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { alertRulesApi, type AlertRule, type AlertRulePayload, METRIC_OPTIONS, SEVERITY_OPTIONS } from '@/api/alertRules'
import { monitorApi, type NetworkEvent } from '@/api/monitor'
import { devicesApi } from '@/api/devices'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import dayjs from 'dayjs'

// ── Constants ────────────────────────────────────────────────────────────────

function mkC(isDark: boolean) {
  return {
    bg:     isDark ? '#0e1e38' : '#ffffff',
    bg2:    isDark ? '#071224' : '#f8fafc',
    border: isDark ? '#1a3458' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
    dim:    isDark ? '#334155' : '#cbd5e1',
    grid:   isDark ? '#1a3458' : '#f1f5f9',
  }
}

const EVENT_INFO: Record<string, { label: string; color: string; icon: string; desc: string }> = {
  threshold_alert:      { label: 'Eşik İhlali',       color: '#f59e0b', icon: '📊', desc: 'SNMP utilization / hata oranı eşiği aşıldı' },
  device_offline:       { label: 'Cihaz Çevrimdışı',  color: '#ef4444', icon: '🔴', desc: 'SSH bağlantısı kesildi' },
  device_online:        { label: 'Cihaz Çevrimiçi',   color: '#22c55e', icon: '🟢', desc: 'Bağlantı yeniden kuruldu' },
  device_flapping:      { label: 'Flapping',           color: '#f97316', icon: '⚡', desc: 'Saatte 4+ durum değişimi tespit edildi' },
  correlation_incident: { label: 'Zincirleme Olay',   color: '#dc2626', icon: '🔗', desc: '3+ cihaz eş zamanlı çevrimdışı — muhtemel upstream arızası' },
  stp_anomaly:          { label: 'STP Anomalisi',      color: '#8b5cf6', icon: '🌐', desc: 'Spanning Tree topologi değişikliği veya döngü koruma tetiklendi' },
  loop_detected:        { label: 'Döngü / Fırtına',   color: '#dc2626', icon: '🔄', desc: 'MAC flapping, duplicate MAC veya storm control' },
  port_change:          { label: 'Port Değişimi',      color: '#6366f1', icon: '🔌', desc: 'Fiziksel port up/down geçişi' },
  new_device_connected: { label: 'Yeni Cihaz',         color: '#3b82f6', icon: '📱', desc: 'Topolojide daha önce görülmemiş LLDP komşusu' },
}

const METRIC_LABEL: Record<string, string> = {
  max_util_pct: 'Maks. Util.', in_util_pct: 'In Util.', out_util_pct: 'Out Util.', error_rate: 'Hata/dk',
}
const METRIC_UNIT: Record<string, string> = {
  max_util_pct: '%', in_util_pct: '%', out_util_pct: '%', error_rate: '/dk',
}
const SEV_COLOR: Record<string, string> = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' }

const HOURS_OPTIONS = [
  { label: 'Son 24s', value: 24 },
  { label: 'Son 7 gün', value: 168 },
  { label: 'Son 30 gün', value: 720 },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function groupByTimeWindow(events: NetworkEvent[], windowMs: number) {
  if (!events.length) return []
  const sorted = [...events].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
  const groups: NetworkEvent[][] = []
  let current: NetworkEvent[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const diff = +new Date(sorted[i].created_at) - +new Date(current[0].created_at)
    if (diff <= windowMs) {
      current.push(sorted[i])
    } else {
      groups.push(current)
      current = [sorted[i]]
    }
  }
  groups.push(current)
  return groups
}

function uniqueDevices(events: NetworkEvent[]) {
  return new Set(events.map((e) => e.device_hostname).filter(Boolean)).size
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}dk`
  return `${(m / 60).toFixed(1)}s`
}

// ── Sub-components ───────────────────────────────────────────────────────────

function EventTypeBadge({ type }: { type: string }) {
  const info = EVENT_INFO[type]
  if (!info) return <Tag style={{ fontSize: 11 }}>{type}</Tag>
  return (
    <Tag style={{ color: info.color, borderColor: info.color + '50', background: info.color + '15', fontSize: 11 }}>
      {info.icon} {info.label}
    </Tag>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function AlertRulesPage() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null)
  const [histHours, setHistHours] = useState(24)
  const [histType, setHistType] = useState<string | undefined>()
  const [histSev, setHistSev] = useState<string | undefined>()
  const [form] = Form.useForm()
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = mkC(isDark)
  const qc = useQueryClient()

  // ── WebSocket live events ──────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [lastWsEvent, setLastWsEvent] = useState<NetworkEvent | null>(null)
  const [wsNewCount, setWsNewCount] = useState(0)

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = window.location.hostname
    const port = import.meta.env.DEV ? '8000' : window.location.port
    const token = localStorage.getItem('token')
    const url = `${proto}://${host}:${port}/api/v1/ws/events${token ? `?token=${token}` : ''}`

    const connect = () => {
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onopen = () => setWsConnected(true)
      ws.onclose = () => { setWsConnected(false); setTimeout(connect, 5000) }
      ws.onerror = () => ws.close()
      ws.onmessage = (e) => {
        try {
          const evt: NetworkEvent = JSON.parse(e.data)
          setLastWsEvent(evt)
          setWsNewCount((n) => n + 1)
          qc.invalidateQueries({ queryKey: ['live-events'] })
          if (evt.severity === 'critical') {
            const info = EVENT_INFO[evt.event_type]
            notification.error({
              message: `${info?.icon ?? '⚠️'} ${info?.label ?? evt.event_type}`,
              description: `${evt.device_hostname ?? '—'}: ${evt.title}`,
              duration: 8,
              placement: 'bottomRight',
            })
          }
        } catch { /* ignore parse errors */ }
      }
    }
    connect()
    return () => wsRef.current?.close()
  }, [])

  // ── Queries ────────────────────────────────────────────────────────────────
  const { data: rules = [], isLoading: rulesLoading } = useQuery({
    queryKey: ['alert-rules'],
    queryFn: alertRulesApi.list,
  })

  const { data: allEventsPage, isLoading: eventsLoading } = useQuery({
    queryKey: ['all-events', histHours],
    queryFn: () => monitorApi.getEvents({ hours: histHours, limit: 1000 }),
    refetchInterval: 60000,
  })
  const allEvents: NetworkEvent[] = allEventsPage?.items ?? []

  const { data: liveEventsPage } = useQuery({
    queryKey: ['live-events'],
    queryFn: () => monitorApi.getEvents({ unacked_only: true, limit: 200 }),
    refetchInterval: 30000,
  })
  const liveEvents: NetworkEvent[] = liveEventsPage?.items ?? []

  const { data: devicesPage } = useQuery({
    queryKey: ['devices-all-min', activeSite],
    queryFn: () => devicesApi.list({ skip: 0, limit: 500, site: activeSite || undefined }),
  })
  const devices = devicesPage?.items ?? []

  // ── Computed ───────────────────────────────────────────────────────────────
  const totalRules = rules.length
  const enabledRules = rules.filter((r) => r.enabled).length
  const critLive = liveEvents.filter((e) => e.severity === 'critical').length
  const unacked = liveEvents.length

  // Fire counts per rule from allEvents
  const fireCounts = useMemo(() => {
    const m = new Map<number, number>()
    for (const e of allEvents) {
      const rid = (e.details as any)?.rule_id as number | undefined
      if (rid != null) m.set(rid, (m.get(rid) ?? 0) + 1)
    }
    return m
  }, [allEvents])

  // Correlation: group all events by 5-min window; flag incidents
  const incidents = useMemo(() => {
    const groups = groupByTimeWindow(allEvents, 5 * 60 * 1000)
    return groups
      .filter((g) => g.length >= 3 && uniqueDevices(g) >= 2)
      .sort((a, b) => +new Date(b[0].created_at) - +new Date(a[0].created_at))
      .slice(0, 20)
  }, [allEvents])

  // Top devices by event count
  const topDevices = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of allEvents) {
      const h = e.device_hostname ?? '—'
      m.set(h, (m.get(h) ?? 0) + 1)
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }))
  }, [allEvents])

  // Event type distribution
  const typeDistrib = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of allEvents) m.set(e.event_type, (m.get(e.event_type) ?? 0) + 1)
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, label: EVENT_INFO[type]?.label ?? type, count, color: EVENT_INFO[type]?.color ?? '#64748b' }))
  }, [allEvents])

  // Hourly distribution
  const hourlyData = useMemo(() => {
    const m = new Map<number, number>()
    for (let h = 0; h < 24; h++) m.set(h, 0)
    for (const e of allEvents.filter((e) => e.event_type !== 'device_online')) {
      m.set(dayjs(e.created_at).hour(), (m.get(dayjs(e.created_at).hour()) ?? 0) + 1)
    }
    return [...m.entries()].map(([hour, count]) => ({ hour: `${hour}:00`, count }))
  }, [allEvents])

  // Live events grouped by type
  const liveByType = useMemo(() => {
    const m = new Map<string, NetworkEvent[]>()
    for (const e of liveEvents) {
      if (!m.has(e.event_type)) m.set(e.event_type, [])
      m.get(e.event_type)!.push(e)
    }
    return [...m.entries()]
      .sort((a, b) => {
        const sevOrder = { critical: 0, warning: 1, info: 2 }
        const aMax = Math.min(...a[1].map((e) => sevOrder[e.severity as keyof typeof sevOrder] ?? 3))
        const bMax = Math.min(...b[1].map((e) => sevOrder[e.severity as keyof typeof sevOrder] ?? 3))
        return aMax - bMax
      })
  }, [liveEvents])

  // Filtered history
  const filteredHist = useMemo(() =>
    allEvents.filter(
      (e) => (!histType || e.event_type === histType) && (!histSev || e.severity === histSev)
    ),
    [allEvents, histType, histSev],
  )

  // Device uptime timeline from offline/online events
  const timelineData = useMemo(() => {
    const now = Date.now()
    const windowStart = now - histHours * 60 * 60 * 1000
    const relEvents = allEvents.filter(
      (e) => e.event_type === 'device_offline' || e.event_type === 'device_online'
    )
    const deviceNames = [...new Set(relEvents.map((e) => e.device_hostname).filter(Boolean))] as string[]

    return deviceNames.map((hostname) => {
      const devEvents = relEvents
        .filter((e) => e.device_hostname === hostname)
        .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))

      const inWindow = devEvents.filter((e) => +new Date(e.created_at) >= windowStart)
      const beforeWindow = devEvents.filter((e) => +new Date(e.created_at) < windowStart)

      let cur: 'online' | 'offline' = 'online'
      if (beforeWindow.length > 0) {
        cur = beforeWindow[beforeWindow.length - 1].event_type === 'device_offline' ? 'offline' : 'online'
      } else if (inWindow.length > 0) {
        cur = inWindow[0].event_type === 'device_offline' ? 'online' : 'offline'
      }

      const segments: { start: number; end: number; state: 'online' | 'offline' }[] = []
      let segStart = windowStart

      for (const evt of inWindow) {
        const t = +new Date(evt.created_at)
        if (t > segStart) segments.push({ start: segStart, end: t, state: cur })
        cur = evt.event_type === 'device_offline' ? 'offline' : 'online'
        segStart = t
      }
      segments.push({ start: segStart, end: now, state: cur })

      const totalMs = now - windowStart
      const onlineMs = segments.filter((s) => s.state === 'online').reduce((a, s) => a + s.end - s.start, 0)
      return { hostname, segments, uptime_pct: Math.round((onlineMs / totalMs) * 100) }
    }).sort((a, b) => a.uptime_pct - b.uptime_pct)
  }, [allEvents, histHours])

  // ── Mutations ──────────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: alertRulesApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alert-rules'] }); closeDrawer(); message.success('Kural oluşturuldu') },
    onError: () => message.error('Oluşturulamadı'),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<AlertRulePayload> }) => alertRulesApi.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alert-rules'] }); closeDrawer(); message.success('Güncellendi') },
    onError: () => message.error('Güncellenemedi'),
  })
  const deleteMut = useMutation({
    mutationFn: alertRulesApi.delete,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alert-rules'] }); message.success('Silindi') },
  })
  const ackMut = useMutation({
    mutationFn: monitorApi.acknowledge,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['live-events', 'all-events'] }) },
  })
  const ackAllMut = useMutation({
    mutationFn: monitorApi.acknowledgeAll,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['live-events', 'all-events'] }); message.success('Tümü onaylandı') },
  })

  // ── Drawer helpers ─────────────────────────────────────────────────────────
  function openAdd() {
    setEditingRule(null)
    form.resetFields()
    form.setFieldsValue({ metric: 'max_util_pct', severity: 'warning', threshold_value: 80, consecutive_count: 2, cooldown_minutes: 60, enabled: true })
    setDrawerOpen(true)
  }
  function openEdit(rule: AlertRule) { setEditingRule(rule); form.setFieldsValue({ ...rule }); setDrawerOpen(true) }
  function closeDrawer() { setDrawerOpen(false); setEditingRule(null); form.resetFields() }
  function handleSubmit(vals: AlertRulePayload) {
    if (editingRule) updateMut.mutate({ id: editingRule.id, data: vals })
    else createMut.mutate(vals)
  }
  function toggleEnabled(rule: AlertRule) { updateMut.mutate({ id: rule.id, data: { enabled: !rule.enabled } }) }

  const deviceOptions = devices.map((d) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id }))
  const typeOptions = Object.entries(EVENT_INFO).map(([k, v]) => ({ label: `${v.icon} ${v.label}`, value: k }))

  // ── Tab: Kurallar ──────────────────────────────────────────────────────────
  const rulesColumns = [
    {
      title: 'Kural',
      dataIndex: 'name',
      ellipsis: true,
      render: (v: string, r: AlertRule) => {
        const count = fireCounts.get(r.id) ?? 0
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>{v}</span>
            {count > 0 && <Badge count={count} size="small" style={{ backgroundColor: SEV_COLOR[r.severity] ?? '#64748b' }} />}
          </div>
        )
      },
    },
    {
      title: 'Cihaz',
      dataIndex: 'device_id',
      width: 150,
      render: (v: number | null) => v
        ? <span style={{ fontSize: 12, color: C.text }}>{devices.find((d) => d.id === v)?.hostname ?? `#${v}`}</span>
        : <Tag style={{ fontSize: 10, color: C.muted, borderColor: C.dim, background: 'transparent' }}>Tüm</Tag>,
    },
    {
      title: 'Pattern',
      dataIndex: 'if_name_pattern',
      width: 130,
      render: (v: string | null) => v
        ? <code style={{ fontSize: 11, background: isDark ? '#071224' : '#f1f5f9', padding: '2px 5px', borderRadius: 3, color: '#3b82f6' }}>{v}</code>
        : <span style={{ color: C.muted }}>—</span>,
    },
    {
      title: 'Metrik · Eşik',
      width: 150,
      render: (_: unknown, r: AlertRule) => (
        <span style={{ fontSize: 12 }}>
          <span style={{ color: C.muted }}>{METRIC_LABEL[r.metric] ?? r.metric}</span>
          {' > '}
          <span style={{ fontWeight: 700, color: SEV_COLOR[r.severity] }}>{r.threshold_value}{METRIC_UNIT[r.metric] ?? ''}</span>
        </span>
      ),
    },
    {
      title: 'Ciddiyet',
      dataIndex: 'severity',
      width: 100,
      render: (v: string) => (
        <Tag color={v === 'critical' ? 'red' : 'orange'} style={{ fontSize: 11 }}>
          {v === 'critical' ? '🔴 Kritik' : '🟡 Uyarı'}
        </Tag>
      ),
    },
    {
      title: 'Art.·Soğuma',
      width: 100,
      render: (_: unknown, r: AlertRule) => (
        <span style={{ fontSize: 11, color: C.muted }}>{r.consecutive_count}× · {r.cooldown_minutes}dk</span>
      ),
    },
    {
      title: 'Aktif',
      dataIndex: 'enabled',
      width: 65,
      render: (v: boolean, r: AlertRule) => (
        <Switch size="small" checked={v} onChange={() => toggleEnabled(r)} loading={updateMut.isPending} />
      ),
    },
    {
      title: '',
      width: 70,
      render: (_: unknown, r: AlertRule) => (
        <Space size={0}>
          <Tooltip title="Düzenle"><Button size="small" icon={<EditOutlined />} type="text" onClick={() => openEdit(r)} /></Tooltip>
          <Popconfirm title="Silinsin mi?" onConfirm={() => deleteMut.mutate(r.id)} okText="Sil" cancelText="İptal">
            <Tooltip title="Sil"><Button size="small" icon={<DeleteOutlined />} type="text" danger /></Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  // ── Tab: Geçmiş columns ────────────────────────────────────────────────────
  const histColumns = [
    {
      title: 'Tip',
      dataIndex: 'event_type',
      width: 160,
      render: (v: string) => <EventTypeBadge type={v} />,
    },
    {
      title: 'Cihaz / Arayüz',
      render: (_: unknown, e: NetworkEvent) => {
        const d = e.details as any
        return (
          <div>
            <div style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>{e.device_hostname ?? '—'}</div>
            {d?.if_name && <code style={{ fontSize: 11, color: '#3b82f6' }}>{d.if_name}</code>}
          </div>
        )
      },
    },
    {
      title: 'Başlık',
      dataIndex: 'title',
      ellipsis: true,
      render: (v: string) => <span style={{ fontSize: 12, color: C.muted }}>{v}</span>,
    },
    {
      title: 'Değer',
      width: 130,
      render: (_: unknown, e: NetworkEvent) => {
        const d = e.details as any
        if (!d?.value) return null
        const pct = d.threshold ? Math.min(100, Math.round((d.value / d.threshold) * 100)) : 100
        return (
          <div>
            <span style={{ fontWeight: 700, color: SEV_COLOR[e.severity] ?? C.text, fontSize: 13 }}>
              {d.value}{d.unit ?? '%'}
            </span>
            <span style={{ color: C.muted, fontSize: 11 }}> / {d.threshold}{d.unit ?? '%'}</span>
            <Progress percent={pct} size="small" showInfo={false} strokeColor={SEV_COLOR[e.severity] ?? '#3b82f6'} style={{ margin: 0 }} />
          </div>
        )
      },
    },
    {
      title: 'Sev.',
      dataIndex: 'severity',
      width: 75,
      render: (v: string) => <Tag color={v === 'critical' ? 'red' : v === 'warning' ? 'orange' : 'blue'} style={{ fontSize: 10 }}>{v}</Tag>,
    },
    {
      title: 'Zaman',
      dataIndex: 'created_at',
      width: 120,
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}>
          <span style={{ fontSize: 12, color: C.muted }}>{dayjs(v).fromNow()}</span>
        </Tooltip>
      ),
    },
    {
      title: '',
      width: 50,
      render: (_: unknown, e: NetworkEvent) =>
        !e.acknowledged && (
          <Tooltip title="Onayla">
            <Button size="small" icon={<CheckOutlined />} type="text" loading={ackMut.isPending} onClick={() => ackMut.mutate(e.id)} />
          </Tooltip>
        ),
    },
  ]

  // ── Card helper ────────────────────────────────────────────────────────────
  function Card({ title, children, extra }: { title: React.ReactNode; children: React.ReactNode; extra?: React.ReactNode }) {
    return (
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', marginBottom: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: C.text, fontWeight: 600, fontSize: 14 }}>{title}</span>
          {extra}
        </div>
        <div>{children}</div>
      </div>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#ef444420' : C.border}`,
        borderLeft: '4px solid #ef4444',
        borderRadius: 12, padding: '16px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ef444420', border: '1px solid #ef444430', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <AlertOutlined style={{ color: '#ef4444', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>Alarm Merkezi</div>
            <div style={{ color: C.muted, fontSize: 12 }}>9 alarm tipi · korelasyon analizi · gerçek zamanlı izleme</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: wsConnected ? '#22c55e' : '#6b7280',
              boxShadow: wsConnected ? '0 0 7px #22c55e' : undefined,
              transition: 'all 0.3s',
            }} />
            <span style={{ color: C.muted, fontSize: 11 }}>{wsConnected ? 'Canlı' : 'Bağlanıyor...'}</span>
          </div>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>Yeni Kural</Button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        {[
          { label: 'Toplam Kural', value: totalRules, color: '#3b82f6', icon: <AlertOutlined /> },
          { label: 'Aktif Kural',  value: enabledRules, color: '#22c55e', icon: <CheckCircleOutlined /> },
          { label: 'Onay Bekleyen', value: unacked, color: '#f59e0b', icon: <ClockCircleOutlined /> },
          { label: 'Kritik Aktif', value: critLive, color: '#ef4444', icon: <ExclamationCircleOutlined /> },
          { label: 'Olay Grubu', value: incidents.length, color: '#8b5cf6', icon: <BranchesOutlined /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} style={{ background: isDark ? C.bg : '#f8fafc', border: `1px solid ${isDark ? color + '20' : C.border}`, borderTop: `3px solid ${color}`, borderRadius: 10, padding: '12px 16px' }}>
            <div style={{ color, fontSize: 24, fontWeight: 700, lineHeight: 1 }}>{value}</div>
            <div style={{ color: C.muted, fontSize: 11, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>{icon} {label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <Tabs
        defaultActiveKey="live"
        size="small"
        items={[

          // ── TAB: Canlı Alarmlar ──────────────────────────────────────────
          {
            key: 'live',
            label: (
              <span>
                Canlı Alarmlar
                {unacked > 0 && <Badge count={unacked} size="small" style={{ marginLeft: 6, backgroundColor: critLive > 0 ? '#ef4444' : '#f59e0b' }} />}
                {wsNewCount > 0 && <Badge count={wsNewCount} size="small" style={{ marginLeft: 4, backgroundColor: '#22c55e' }} />}
              </span>
            ),
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Last WS event ticker */}
                {lastWsEvent && (
                  <div style={{
                    background: isDark ? C.bg2 : '#f8fafc',
                    border: `1px solid ${EVENT_INFO[lastWsEvent.event_type]?.color ?? '#64748b'}40`,
                    borderLeft: `3px solid ${EVENT_INFO[lastWsEvent.event_type]?.color ?? '#64748b'}`,
                    borderRadius: 8, padding: '7px 14px',
                    display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
                    cursor: 'default',
                  }}>
                    <span style={{ color: C.muted, fontSize: 11, whiteSpace: 'nowrap' }}>Son olay (WS):</span>
                    <EventTypeBadge type={lastWsEvent.event_type} />
                    <span style={{ fontWeight: 600, color: C.text, whiteSpace: 'nowrap' }}>{lastWsEvent.device_hostname ?? '—'}</span>
                    <span style={{ color: C.muted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastWsEvent.title}</span>
                    <span style={{ color: C.muted, fontSize: 11, whiteSpace: 'nowrap' }}>{dayjs(lastWsEvent.created_at).fromNow()}</span>
                  </div>
                )}
                {unacked === 0 ? (
                  <div style={{ padding: '48px 20px', textAlign: 'center', color: C.muted, background: C.bg, borderRadius: 12, border: `1px solid ${C.border}` }}>
                    <CheckCircleOutlined style={{ fontSize: 36, color: '#22c55e', display: 'block', marginBottom: 10 }} />
                    <div style={{ fontWeight: 600, color: C.text }}>Bekleyen alarm yok</div>
                    <div style={{ fontSize: 12, marginTop: 4 }}>Tüm alarmlar onaylandı</div>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Popconfirm title={`${unacked} alarm onaylansın mı?`} onConfirm={() => ackAllMut.mutate()} okText="Evet" cancelText="İptal">
                        <Button icon={<CheckOutlined />} loading={ackAllMut.isPending}>Tümünü Onayla ({unacked})</Button>
                      </Popconfirm>
                    </div>
                    {liveByType.map(([type, events]) => {
                      const info = EVENT_INFO[type]
                      const sevs = events.map((e) => e.severity)
                      const topSev = sevs.includes('critical') ? 'critical' : sevs.includes('warning') ? 'warning' : 'info'
                      return (
                        <div key={type} style={{ background: C.bg, border: `1px solid ${info?.color ?? '#64748b'}30`, borderLeft: `4px solid ${info?.color ?? '#64748b'}`, borderRadius: 12, overflow: 'hidden' }}>
                          <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 20 }}>{info?.icon ?? '⚠️'}</span>
                            <div style={{ flex: 1 }}>
                              <span style={{ fontWeight: 600, color: C.text }}>{info?.label ?? type}</span>
                              <span style={{ color: C.muted, fontSize: 12, marginLeft: 8 }}>{info?.desc}</span>
                            </div>
                            <Badge count={events.length} style={{ backgroundColor: SEV_COLOR[topSev] }} />
                          </div>
                          <Table<NetworkEvent>
                            dataSource={events}
                            rowKey="id"
                            size="small"
                            pagination={false}
                            showHeader={false}
                            columns={[
                              {
                                title: 'Dev',
                                render: (_: unknown, e: NetworkEvent) => {
                                  const d = e.details as any
                                  return (
                                    <div style={{ padding: '4px 0' }}>
                                      <span style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>{e.device_hostname ?? '—'}</span>
                                      {d?.if_name && <code style={{ fontSize: 11, color: '#3b82f6', marginLeft: 8 }}>{d.if_name}</code>}
                                      {d?.value && <span style={{ color: SEV_COLOR[e.severity], fontWeight: 700, marginLeft: 8, fontSize: 13 }}>{d.value}{d.unit ?? '%'}</span>}
                                      {d?.value && d?.threshold && <span style={{ color: C.muted, fontSize: 11 }}> / {d.threshold}{d.unit ?? '%'}</span>}
                                      <span style={{ color: C.muted, fontSize: 11, marginLeft: 8 }}>{dayjs(e.created_at).fromNow()}</span>
                                    </div>
                                  )
                                },
                              },
                              {
                                title: 'Ack',
                                width: 50,
                                render: (_: unknown, e: NetworkEvent) => (
                                  <Button size="small" icon={<CheckOutlined />} type="text" loading={ackMut.isPending} onClick={() => ackMut.mutate(e.id)} />
                                ),
                              },
                            ]}
                          />
                        </div>
                      )
                    })}
                  </>
                )}
              </div>
            ),
          },

          // ── TAB: Korelasyon ──────────────────────────────────────────────
          {
            key: 'correlation',
            label: <span><BranchesOutlined /> Korelasyon</span>,
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                {/* Time range */}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Segmented
                    size="small"
                    options={HOURS_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
                    value={histHours}
                    onChange={(v) => setHistHours(v as number)}
                  />
                </div>

                {/* Charts row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

                  {/* Event type distribution */}
                  <Card title="Alarm Tipi Dağılımı">
                    <div style={{ padding: 16 }}>
                      {typeDistrib.length === 0
                        ? <div style={{ textAlign: 'center', color: C.muted, padding: 24 }}>Veri yok</div>
                        : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {typeDistrib.map(({ type, label, count, color }) => {
                              const max = typeDistrib[0].count
                              return (
                                <div key={type}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                                    <span style={{ fontSize: 12, color: C.text }}>{EVENT_INFO[type]?.icon} {label}</span>
                                    <span style={{ fontSize: 12, fontWeight: 700, color }}>{count}</span>
                                  </div>
                                  <div style={{ background: C.dim, borderRadius: 4, height: 6, overflow: 'hidden' }}>
                                    <div style={{ background: color, width: `${(count / max) * 100}%`, height: '100%', transition: 'width 0.8s' }} />
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )
                      }
                    </div>
                  </Card>

                  {/* Top devices */}
                  <Card title="En Çok Alarm Üretenler">
                    <div style={{ padding: 16 }}>
                      {topDevices.length === 0
                        ? <div style={{ textAlign: 'center', color: C.muted, padding: 24 }}>Veri yok</div>
                        : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {topDevices.map(({ name, count }, i) => (
                              <div key={name}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                                  <span style={{ fontSize: 12, color: C.text }}>
                                    <span style={{ color: C.muted, marginRight: 6 }}>#{i + 1}</span>{name}
                                  </span>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? '#ef4444' : i < 3 ? '#f59e0b' : '#3b82f6' }}>{count}</span>
                                </div>
                                <div style={{ background: C.dim, borderRadius: 4, height: 5, overflow: 'hidden' }}>
                                  <div style={{
                                    background: i === 0 ? '#ef4444' : i < 3 ? '#f59e0b' : '#3b82f6',
                                    width: `${(count / topDevices[0].count) * 100}%`,
                                    height: '100%', transition: 'width 0.8s',
                                  }} />
                                </div>
                              </div>
                            ))}
                          </div>
                        )
                      }
                    </div>
                  </Card>
                </div>

                {/* Hourly heatmap */}
                <Card title="Saatlik Alarm Yoğunluğu">
                  <div style={{ padding: '16px 8px' }}>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={hourlyData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                        <XAxis dataKey="hour" tick={{ fill: C.muted, fontSize: 11 }} tickLine={false} axisLine={false} interval={1} />
                        <YAxis tick={{ fill: C.muted, fontSize: 11 }} tickLine={false} axisLine={false} />
                        <RTooltip contentStyle={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text }} />
                        <Bar dataKey="count" name="Alarm" radius={[3, 3, 0, 0]}>
                          {hourlyData.map((entry, idx) => (
                            <Cell key={idx} fill={entry.count > 5 ? '#ef4444' : entry.count > 2 ? '#f59e0b' : '#3b82f6'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Card>

                {/* Correlation incidents */}
                <Card
                  title={
                    <span>
                      Olay Kümeleri
                      <Tooltip title="5 dakika içinde 2+ cihazı etkileyen eş zamanlı alarmlar — muhtemel upstream/cascade arıza belirtisi">
                        <span style={{ color: C.muted, fontSize: 12, fontWeight: 400, marginLeft: 8 }}>(?)</span>
                      </Tooltip>
                    </span>
                  }
                  extra={<span style={{ color: C.muted, fontSize: 12 }}>{incidents.length} grup</span>}
                >
                  {incidents.length === 0 ? (
                    <div style={{ padding: '32px 20px', textAlign: 'center', color: C.muted }}>
                      <CheckCircleOutlined style={{ fontSize: 28, color: '#22c55e', display: 'block', marginBottom: 8 }} />
                      Olay kümesi tespit edilmedi
                    </div>
                  ) : (
                    <Collapse
                      size="small"
                      ghost
                      items={incidents.map((group, gi) => {
                        const devs = [...new Set(group.map((e) => e.device_hostname).filter(Boolean))]
                        const types = [...new Set(group.map((e) => e.event_type))]
                        const hasCrit = group.some((e) => e.severity === 'critical')
                        const ts = dayjs(group[0].created_at)
                        return {
                          key: gi,
                          label: (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ fontSize: 16 }}>{hasCrit ? '🔴' : '🟡'}</span>
                              <span style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>
                                {devs.slice(0, 3).join(', ')}{devs.length > 3 ? ` +${devs.length - 3}` : ''} — {group.length} alarm
                              </span>
                              <span style={{ color: C.muted, fontSize: 12 }}>{ts.format('DD.MM HH:mm')}</span>
                              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                                {types.map((t) => <EventTypeBadge key={t} type={t} />)}
                              </div>
                            </div>
                          ),
                          children: (
                            <div style={{ paddingLeft: 8 }}>
                              {group.map((e) => (
                                <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: `1px solid ${C.border}` }}>
                                  <span style={{ fontSize: 14 }}>{EVENT_INFO[e.event_type]?.icon ?? '⚠️'}</span>
                                  <span style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{e.device_hostname ?? '—'}</span>
                                  <span style={{ fontSize: 12, color: C.muted, flex: 1 }}>{e.title}</span>
                                  <Tag color={e.severity === 'critical' ? 'red' : 'orange'} style={{ fontSize: 10 }}>{e.severity}</Tag>
                                  <span style={{ fontSize: 11, color: C.muted }}>{dayjs(e.created_at).format('HH:mm:ss')}</span>
                                </div>
                              ))}
                            </div>
                          ),
                        }
                      })}
                    />
                  )}
                </Card>

                {/* Backend correlation incidents (cascade) */}
                {allEvents.filter((e) => e.event_type === 'correlation_incident').length > 0 && (
                  <Card title="⚠️ Zincirleme Arıza Olayları" extra={<Tag color="red">{allEvents.filter((e) => e.event_type === 'correlation_incident').length} adet</Tag>}>
                    {allEvents
                      .filter((e) => e.event_type === 'correlation_incident')
                      .slice(0, 10)
                      .map((e) => {
                        const d = e.details as any
                        return (
                          <div key={e.id} style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                            <span style={{ fontSize: 22, flexShrink: 0 }}>🔗</span>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>{e.title}</div>
                              {d?.affected_count && (
                                <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
                                  {d.affected_count} cihaz etkilendi
                                  {d.affected_devices && (
                                    <span style={{ marginLeft: 8 }}>
                                      {(d.affected_devices as any[]).slice(0, 4).map((dd: any) => dd.hostname).join(', ')}
                                      {d.affected_devices.length > 4 && ` +${d.affected_devices.length - 4}`}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            <div style={{ textAlign: 'right', flexShrink: 0 }}>
                              <div style={{ fontSize: 11, color: C.muted }}>{dayjs(e.created_at).fromNow()}</div>
                              {!e.acknowledged && (
                                <Button size="small" icon={<CheckOutlined />} type="text" style={{ marginTop: 4 }} onClick={() => ackMut.mutate(e.id)} />
                              )}
                            </div>
                          </div>
                        )
                      })}
                  </Card>
                )}

            {/* Uptime Gantt */}
            <Card
              title={
                <span>
                  📊 Cihaz Erişilebilirlik Zaman Çizelgesi
                  <Tooltip title="device_offline / device_online olaylarından oluşturulan uptime görselleştirmesi">
                    <span style={{ color: C.muted, fontSize: 12, fontWeight: 400, marginLeft: 8 }}>(?)</span>
                  </Tooltip>
                </span>
              }
              extra={
                timelineData.length > 0
                  ? <span style={{ color: C.muted, fontSize: 12 }}>{timelineData.length} cihaz · {timelineData.filter((d) => d.uptime_pct < 100).length} kesinti yaşadı</span>
                  : null
              }
            >
              {timelineData.length === 0 ? (
                <div style={{ padding: '32px 20px', textAlign: 'center', color: C.muted }}>
                  <CheckCircleOutlined style={{ fontSize: 28, color: '#22c55e', display: 'block', marginBottom: 8 }} />
                  Seçili dönemde kesinti olayı tespit edilmedi
                </div>
              ) : (
                <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {/* Header row */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 160, fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Cihaz</div>
                    <div style={{ flex: 1, fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Zaman Çizelgesi ({histHours < 48 ? `Son ${histHours}s` : `Son ${histHours / 24}g`})</div>
                    <div style={{ width: 55, textAlign: 'right', fontSize: 10, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Uptime</div>
                  </div>
                  {timelineData.map(({ hostname, segments, uptime_pct }) => {
                    const totalMs = histHours * 3600000
                    return (
                      <div key={hostname} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 24 }}>
                        <div style={{
                          width: 160, fontSize: 12, color: C.text, fontWeight: 500,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}>
                          {hostname}
                        </div>
                        <div style={{ flex: 1, height: 16, display: 'flex', borderRadius: 3, overflow: 'hidden', background: C.dim, flexShrink: 0, minWidth: 0 }}>
                          {segments.map((seg, i) => {
                            const w = Math.max(0, ((seg.end - seg.start) / totalMs) * 100)
                            if (w < 0.05) return null
                            const duration = fmtDur(seg.end - seg.start)
                            return (
                              <Tooltip
                                key={i}
                                title={
                                  <div style={{ fontSize: 11, lineHeight: 1.7 }}>
                                    <div>{seg.state === 'online' ? '🟢 Çevrimiçi' : '🔴 Çevrimdışı'}</div>
                                    <div>{dayjs(seg.start).format('DD.MM HH:mm')} — {dayjs(seg.end).format('HH:mm')}</div>
                                    <div>Süre: {duration}</div>
                                  </div>
                                }
                              >
                                <div style={{
                                  width: `${Math.min(100, w)}%`,
                                  background: seg.state === 'online' ? '#22c55e' : '#ef4444',
                                  flexShrink: 0,
                                  opacity: seg.state === 'offline' ? 1 : 0.65,
                                  cursor: 'default',
                                }} />
                              </Tooltip>
                            )
                          })}
                        </div>
                        <div style={{
                          width: 55, textAlign: 'right', fontSize: 12, fontWeight: 700, flexShrink: 0,
                          color: uptime_pct >= 99 ? '#22c55e' : uptime_pct >= 90 ? '#f59e0b' : '#ef4444',
                        }}>
                          {uptime_pct}%
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>

            </div>
            ),
          },

          // ── TAB: Kurallar ────────────────────────────────────────────────
          {
            key: 'rules',
            label: <span><FireOutlined /> Kurallar ({totalRules})</span>,
            children: (
              <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                <Table<AlertRule>
                  dataSource={rules}
                  columns={rulesColumns}
                  rowKey="id"
                  loading={rulesLoading}
                  size="small"
                  pagination={{ pageSize: 20 }}
                  locale={{ emptyText: '"Yeni Kural" ile SNMP eşik kuralı oluşturun.' }}
                />
              </div>
            ),
          },

          // ── TAB: Geçmiş ──────────────────────────────────────────────────
          {
            key: 'history',
            label: <span><ClockCircleOutlined /> Geçmiş</span>,
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Segmented
                    size="small"
                    options={HOURS_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
                    value={histHours}
                    onChange={(v) => setHistHours(v as number)}
                  />
                  <Select size="small" allowClear placeholder="Alarm tipi" style={{ width: 170 }} value={histType} onChange={setHistType} options={typeOptions} />
                  <Select size="small" allowClear placeholder="Ciddiyet" style={{ width: 120 }} value={histSev} onChange={setHistSev}
                    options={[{ label: '🔴 Kritik', value: 'critical' }, { label: '🟡 Uyarı', value: 'warning' }, { label: '🔵 Bilgi', value: 'info' }]}
                  />
                  <span style={{ color: C.muted, fontSize: 12 }}>{filteredHist.length} kayıt</span>
                </div>
                <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                  <Table<NetworkEvent>
                    dataSource={filteredHist}
                    columns={histColumns}
                    rowKey="id"
                    loading={eventsLoading}
                    size="small"
                    pagination={{ pageSize: 30 }}
                    locale={{ emptyText: 'Seçilen dönemde alarm yok.' }}
                    onRow={(r) => ({ style: { background: r.acknowledged ? undefined : (isDark ? '#f59e0b08' : '#fffbf0') } })}
                  />
                </div>
              </div>
            ),
          },

        ]}
      />

      {/* Add / Edit Drawer */}
      <Drawer
        title={editingRule ? `Düzenle — ${editingRule.name}` : 'Yeni Alert Kuralı'}
        open={drawerOpen}
        onClose={closeDrawer}
        width={480}
        extra={<Button type="primary" loading={createMut.isPending || updateMut.isPending} onClick={() => form.submit()}>{editingRule ? 'Güncelle' : 'Oluştur'}</Button>}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} size="small">
          <Form.Item name="name" label="Kural Adı" rules={[{ required: true, message: 'Gerekli' }]}>
            <Input placeholder="örn. Core Switch Yüksek Utilization" />
          </Form.Item>
          <Form.Item name="device_id" label="Cihaz">
            <Select allowClear showSearch placeholder="Boş = tüm cihazlar" options={deviceOptions}
              filterOption={(input, opt) => (opt?.label as string)?.toLowerCase().includes(input.toLowerCase())} />
          </Form.Item>
          <Form.Item name="if_name_pattern" label="Arayüz Pattern" extra="Boş = tüm. Örn: GigabitEthernet* veya Te0/*">
            <Input placeholder="GigabitEthernet*" />
          </Form.Item>
          <Form.Item name="metric" label="Metrik" rules={[{ required: true }]}>
            <Select options={METRIC_OPTIONS} />
          </Form.Item>
          <Form.Item name="threshold_value" label="Eşik" rules={[{ required: true }]} extra="Bu değer aşılırsa sayaç artar">
            <InputNumber min={0} max={100} step={1} style={{ width: '100%' }} addonAfter="%" />
          </Form.Item>
          <Form.Item name="consecutive_count" label="Art Arda Kaç Ölçüm" extra="Tek seferlik spike'ları filtreler">
            <InputNumber min={1} max={20} style={{ width: '100%' }} addonAfter="×" />
          </Form.Item>
          <Form.Item name="severity" label="Ciddiyet" rules={[{ required: true }]}>
            <Select options={SEVERITY_OPTIONS} />
          </Form.Item>
          <Form.Item name="cooldown_minutes" label="Soğuma Süresi" extra="Tekrar uyarı göndermeden önceki minimum süre">
            <InputNumber min={1} max={1440} style={{ width: '100%' }} addonAfter="dk" />
          </Form.Item>
          <Form.Item name="enabled" label="Aktif" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>

    </div>
  )
}
