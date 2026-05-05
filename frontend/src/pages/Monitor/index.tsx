import { useEffect, useRef, useState } from 'react'
import {
  App, Row, Col, Card, Table, Tag, Button, Space, Select, Typography,
  Badge, Tooltip, Popconfirm, Segmented, Modal, Descriptions, Divider,
} from 'antd'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  SyncOutlined, CheckOutlined, BellOutlined, FilterOutlined,
  ThunderboltOutlined, CloseCircleOutlined, WarningOutlined,
  InfoCircleOutlined, CheckCircleFilled, AlertOutlined,
  UnorderedListOutlined, MenuOutlined, ClearOutlined,
  ApiOutlined, ApartmentOutlined, BranchesOutlined,
  DisconnectOutlined, LineChartOutlined, RobotOutlined,
  TableOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { monitorApi } from '@/api/monitor'
import { devicesApi } from '@/api/devices'
import type { NetworkEvent } from '@/api/monitor'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import { buildWsUrl } from '@/utils/ws'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

const { Title, Text } = Typography

const SEV_HEX: Record<string, string> = {
  critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6',
}
const SEV_ICON: Record<string, React.ReactNode> = {
  critical: <CloseCircleOutlined style={{ color: '#ef4444' }} />,
  warning:  <WarningOutlined     style={{ color: '#f59e0b' }} />,
  info:     <InfoCircleOutlined  style={{ color: '#3b82f6' }} />,
}

const MONITOR_CSS = `
  @keyframes monitorCritGlow {
    0%,100% { box-shadow: 0 2px 16px rgba(239,68,68,0.18), 0 0 0 1px #ef444420; }
    50%      { box-shadow: 0 2px 26px rgba(239,68,68,0.35), 0 0 0 1px #ef444440; }
  }
  @keyframes monitorWarnGlow {
    0%,100% { box-shadow: 0 2px 14px rgba(245,158,11,0.15), 0 0 0 1px #f59e0b20; }
    50%      { box-shadow: 0 2px 22px rgba(245,158,11,0.30), 0 0 0 1px #f59e0b35; }
  }
  @keyframes monitorLivePing {
    0%   { transform: scale(1);   opacity: 0.9; }
    70%  { transform: scale(2.4); opacity: 0;   }
    100% { transform: scale(2.4); opacity: 0;   }
  }
  @keyframes tlSlideIn {
    from { opacity: 0; transform: translateY(-10px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes tlNewFlash {
    0%,100% { box-shadow: none; }
    30%     { box-shadow: 0 0 0 2px var(--tl-sev); }
  }
  .mon-row-crit td         { background: rgba(239,68,68,0.05) !important; }
  .mon-row-crit:hover td   { background: rgba(239,68,68,0.09) !important; }
  .mon-row-warn td         { background: rgba(245,158,11,0.04) !important; }
  .mon-row-warn:hover td   { background: rgba(245,158,11,0.07) !important; }
  .tl-new { animation: tlSlideIn 0.32s cubic-bezier(.22,1,.36,1) both, tlNewFlash 1.2s ease 0.3s; }
`

// ── Timeline view ─────────────────────────────────────────────────────────────
function TimelineView({
  events, newIds, isDark, onAck,
}: {
  events: NetworkEvent[]
  newIds: Set<number>
  isDark: boolean
  onAck: (id: number) => void
}) {
  const bg = isDark ? '#0e1e38' : '#ffffff'
  const border = isDark ? '#1a3458' : '#e2e8f0'
  const text = isDark ? '#e2e8f0' : '#1e293b'
  const muted = isDark ? '#475569' : '#94a3b8'

  if (events.length === 0) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center', color: muted }}>
        <CheckCircleFilled style={{ fontSize: 32, color: '#22c55e', display: 'block', marginBottom: 10 }} />
        Aktif olay yok
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {events.map((ev) => {
        const sevColor = SEV_HEX[ev.severity] || '#3b82f6'
        const isNew = newIds.has(ev.id)
        return (
          <div
            key={ev.id}
            className={isNew ? 'tl-new' : undefined}
            style={{
              display: 'flex',
              borderBottom: `1px solid ${border}`,
              background: bg,
              transition: 'background 0.15s',
              // CSS custom prop for tlNewFlash animation color
              ['--tl-sev' as string]: `${sevColor}60`,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = isDark ? '#122040' : '#f8fafc' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = bg }}
          >
            {/* Severity bar */}
            <div style={{ width: 3, flexShrink: 0, background: sevColor, borderRadius: '2px 0 0 2px' }} />

            {/* Icon */}
            <div style={{ width: 36, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 15 }}>{SEV_ICON[ev.severity]}</span>
            </div>

            {/* Main content */}
            <div style={{ flex: 1, minWidth: 0, padding: '9px 8px' }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ev.title}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                {ev.device_hostname && (
                  <Tag color="geekblue" style={{ fontSize: 10, margin: 0 }}>{ev.device_hostname}</Tag>
                )}
                <Tag
                  style={{ fontSize: 10, margin: 0 }}
                  color={ev.event_type?.includes('offline') ? 'red' : ev.event_type === 'threshold_alert' ? 'volcano' : ev.event_type === 'device_online' ? 'green' : 'blue'}
                >
                  {TYPE_LABELS[ev.event_type] || ev.event_type}
                </Tag>
                {isNew && (
                  <Tag color={sevColor} style={{ fontSize: 9, margin: 0, padding: '0 5px' }}>YENİ</Tag>
                )}
              </div>
            </div>

            {/* Time — right-aligned, fixed width so long Turkish strings don't overflow */}
            <div style={{
              flexShrink: 0, width: 108,
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
              padding: '0 10px',
              borderLeft: `1px solid ${border}`,
            }}>
              <Tooltip title={dayjs(ev.created_at).format('DD.MM.YYYY HH:mm:ss')}>
                <span style={{ fontSize: 11, color: muted, whiteSpace: 'nowrap', cursor: 'default', textAlign: 'right' }}>
                  {dayjs(ev.created_at).fromNow()}
                </span>
              </Tooltip>
            </div>

            {/* Ack action */}
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 10px', borderLeft: `1px solid ${border}` }}>
              {ev.acknowledged ? (
                <CheckCircleFilled style={{ color: '#52c41a', fontSize: 15 }} />
              ) : (
                <Tooltip title="Okundu işaretle">
                  <Button size="small" type="text" icon={<CheckOutlined />} onClick={() => onAck(ev.id)} />
                </Tooltip>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SevCard({ label, value, color, isDark, glow }: {
  label: string; value: number; color: string; isDark: boolean; glow?: boolean
}) {
  return (
    <div style={{
      background: isDark
        ? `linear-gradient(135deg, ${color}10 0%, #1e293b 100%)`
        : '#ffffff',
      border: `1px solid ${color}22`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 10,
      padding: '14px 18px',
      position: 'relative',
      overflow: 'hidden',
      animation: glow && value > 0
        ? color === '#ef4444' ? 'monitorCritGlow 2.5s ease-in-out infinite'
        : 'monitorWarnGlow 3s ease-in-out infinite'
        : undefined,
      boxShadow: isDark
        ? `0 2px 12px rgba(0,0,0,0.3)`
        : `0 2px 8px rgba(0,0,0,0.06), 0 0 0 1px ${color}10`,
      transition: 'box-shadow 0.2s',
    }}>
      <div style={{
        position: 'absolute', top: -20, right: -20,
        width: 72, height: 72, borderRadius: '50%',
        background: `radial-gradient(circle, ${color}20, transparent 70%)`,
        pointerEvents: 'none',
      }} />
      <div style={{
        color: isDark ? '#475569' : '#94a3b8',
        fontSize: 10, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.08em',
        marginBottom: 10,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 32, fontWeight: 800,
        color, fontFamily: 'monospace', lineHeight: 1,
      }}>
        {value}
      </div>
    </div>
  )
}

const TYPE_LABELS: Record<string, string> = {
  device_offline:        'Cihaz Offline',
  device_online:         'Cihaz Online',
  stp_anomaly:           'STP Anomali',
  loop_detected:         'Loop Tespit',
  port_change:           'Port Değişimi',
  new_device_connected:  'Yeni Cihaz Bağlandı',
  threshold_alert:       'Eşik Alarmı (SNMP)',
  high_cpu:              'Yüksek CPU',
  config_change:         'Config Değişimi',
  backup_failed:         'Yedek Hatası',
  mac_loop_suspicion:    'MAC Döngü Şüphesi',
  mac_anomaly:           'MAC Anomalisi',
  traffic_spike:         'Trafik Artışı',
  vlan_anomaly:          'VLAN Anomalisi',
  device_flapping:       'Cihaz Flapping',
  agent_outage:          'Agent Kesintisi',
  correlation_incident:  'Kök Neden Analizi',
}

// ── Event detail modal helpers ────────────────────────────────────────────────

interface EventDetail {
  icon: React.ReactNode
  what: string                           // 1-line explanation
  rows: { label: string; value: React.ReactNode }[]  // key-value detail rows
  links: { label: string; path: string; icon: React.ReactNode }[]
}

function buildEventDetail(ev: NetworkEvent): EventDetail {
  const d = (ev.details || {}) as Record<string, any>
  const devSearch = ev.device_hostname
    ? `/devices?search=${encodeURIComponent(ev.device_hostname)}`
    : '/devices'

  switch (ev.event_type) {
    case 'mac_loop_suspicion':
      return {
        icon: <SyncOutlined style={{ color: '#faad14' }} />,
        what: 'Aynı MAC adresi birden fazla portta görüldü — ağ döngüsü riski var.',
        rows: [
          { label: 'MAC Adresi', value: <Tag color="orange">{d.mac ?? '—'}</Tag> },
          { label: 'Port Sayısı', value: <Tag color="red">{d.port_count ?? '—'} farklı port</Tag> },
          { label: 'Öneri',      value: 'Spanning Tree durumunu ve port bağlantılarını kontrol edin.' },
        ],
        links: [
          { label: 'MAC / ARP Tablosu', path: '/mac-arp',  icon: <TableOutlined /> },
          { label: 'Cihaza Git',        path: devSearch,   icon: <ApiOutlined /> },
          { label: 'Topoloji',          path: '/topology', icon: <ApartmentOutlined /> },
        ],
      }

    case 'loop_detected':
    case 'stp_anomaly':
      return {
        icon: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
        what: ev.event_type === 'stp_anomaly'
          ? 'Spanning Tree anomalisi tespit edildi — port döngüsü veya topoloji değişimi olabilir.'
          : 'Cihaz log\'unda döngü/flap pattern\'i bulundu.',
        rows: [
          { label: 'Pattern', value: d.pattern ? <Tag color="red">{d.pattern}</Tag> : '—' },
          ...(d.snippet ? [{ label: 'Log Satırı', value: (
            <Text code style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {String(d.snippet).slice(0, 400)}
            </Text>
          )}] : []),
          { label: 'Öneri', value: 'Terminal\'den "show spanning-tree" çalıştırın ve port durumlarını inceleyin.' },
        ],
        links: [
          { label: 'Cihaza Git',  path: devSearch,   icon: <ApiOutlined /> },
          { label: 'Topoloji',    path: '/topology', icon: <ApartmentOutlined /> },
        ],
      }

    case 'device_offline':
      return {
        icon: <DisconnectOutlined style={{ color: '#ff4d4f' }} />,
        what: 'Cihaza SSH bağlantısı kurulamıyor — erişilemiyor olabilir.',
        rows: [
          { label: 'Hata', value: ev.message || '—' },
          { label: 'Öneri', value: 'Güç kaynağını, kablo bağlantısını ve routing\'i kontrol edin.' },
        ],
        links: [
          { label: 'Cihaza Git', path: devSearch,   icon: <ApiOutlined /> },
          { label: 'Topoloji',   path: '/topology', icon: <ApartmentOutlined /> },
        ],
      }

    case 'device_flapping':
      return {
        icon: <WarningOutlined style={{ color: '#ff4d4f' }} />,
        what: 'Cihaz kısa sürede defalarca online/offline döngüsüne giriyor.',
        rows: [
          { label: 'Detay', value: ev.message || '—' },
          { label: 'Öneri', value: 'Güç kaynağı, NIC veya uplink kablosunu kontrol edin. Bireysel olaylar bastırılmış olabilir.' },
        ],
        links: [
          { label: 'Cihaza Git', path: devSearch, icon: <ApiOutlined /> },
        ],
      }

    case 'agent_outage':
      return {
        icon: <RobotOutlined style={{ color: '#ff4d4f' }} />,
        what: 'Proxy agent bağlantısı kesildi — aynı segmentteki cihazlar etkileniyor.',
        rows: [
          { label: 'Detay', value: ev.message || '—' },
          { label: 'Öneri', value: 'Agent servisini yeniden başlatın veya agent\'ın ağ bağlantısını kontrol edin.' },
        ],
        links: [
          { label: 'Agent Yönetimi', path: '/agents', icon: <RobotOutlined /> },
          { label: 'Topoloji',       path: '/topology', icon: <ApartmentOutlined /> },
        ],
      }

    case 'correlation_incident':
      return {
        icon: <ApartmentOutlined style={{ color: '#ff4d4f' }} />,
        what: 'Kök neden analizi: tek cihaz arızası cascade etkisi yarattı.',
        rows: [
          { label: 'Etkilenen Cihaz Sayısı', value: <Tag color="red">{d.affected_count ?? '—'}</Tag> },
          ...(d.affected_devices?.length ? [{ label: 'Etkilenen Cihazlar', value: (
            <Space wrap size={4}>
              {(d.affected_devices as any[]).map((x: any) => (
                <Tag key={x.id} color="orange">{x.hostname}</Tag>
              ))}
            </Space>
          )}] : []),
          { label: 'Öneri', value: 'Topoloji haritasında kök cihazdan itibaren cascade\'i takip edin.' },
        ],
        links: [
          { label: 'Topoloji',    path: '/topology', icon: <ApartmentOutlined /> },
          { label: 'Kök Cihaza Git', path: devSearch, icon: <ApiOutlined /> },
        ],
      }

    case 'mac_anomaly':
      return {
        icon: <TableOutlined style={{ color: '#faad14' }} />,
        what: 'MAC tablosu boyutu normalin çok üstünde — olağandışı trafik veya MAC flood saldırısı olabilir.',
        rows: [
          { label: 'Şu Anki MAC Sayısı', value: <Tag color="red">{d.current ?? '—'}</Tag> },
          { label: 'Normal Baseline',    value: <Tag color="blue">{d.baseline ?? '—'}</Tag> },
          { label: 'Öneri',              value: 'MAC/ARP tablosunu inceleyin, port güvenliği (port-security) konfigürasyonunu kontrol edin.' },
        ],
        links: [
          { label: 'MAC / ARP Tablosu', path: '/mac-arp', icon: <TableOutlined /> },
          { label: 'Cihaza Git',        path: devSearch,  icon: <ApiOutlined /> },
        ],
      }

    case 'traffic_spike':
      return {
        icon: <LineChartOutlined style={{ color: '#faad14' }} />,
        what: `${d.direction === 'gelen' ? 'Gelen' : 'Giden'} trafik baseline'ın 2 katına ulaştı.`,
        rows: [
          { label: 'Yön',      value: <Tag>{d.direction === 'gelen' ? '↓ Gelen' : '↑ Giden'}</Tag> },
          { label: 'Kullanım', value: <Tag color="red">%{d.current_pct ?? '—'}</Tag> },
          { label: 'Baseline', value: <Tag color="blue">%{d.baseline_pct ?? '—'}</Tag> },
          { label: 'Öneri',    value: 'Bant genişliği grafiğini inceleyip trafik kaynağını belirleyin.' },
        ],
        links: [
          { label: 'Bant Genişliği', path: '/bandwidth', icon: <LineChartOutlined /> },
          { label: 'Cihaza Git',     path: devSearch,    icon: <ApiOutlined /> },
        ],
      }

    case 'vlan_anomaly':
      return {
        icon: <BranchesOutlined style={{ color: '#faad14' }} />,
        what: 'Cihazda daha önce görülmemiş VLAN\'lar tespit edildi.',
        rows: [
          { label: 'Yeni VLAN\'lar', value: (
            <Space wrap size={4}>
              {(d.new_vlans || []).map((v: number) => <Tag key={v} color="orange">VLAN {v}</Tag>)}
            </Space>
          )},
          { label: 'Bilinen VLAN\'lar', value: (
            <Space wrap size={4}>
              {(d.known_vlans || []).slice(0, 10).map((v: number) => <Tag key={v}>{v}</Tag>)}
              {(d.known_vlans || []).length > 10 && <Tag>+{(d.known_vlans || []).length - 10}</Tag>}
            </Space>
          )},
          { label: 'Öneri', value: 'Yetkisiz VLAN eklenip eklenmediğini kontrol edin.' },
        ],
        links: [
          { label: 'VLAN Yönetimi', path: '/vlan',    icon: <BranchesOutlined /> },
          { label: 'Cihaza Git',    path: devSearch,  icon: <ApiOutlined /> },
        ],
      }

    case 'port_change':
      return {
        icon: <DisconnectOutlined style={{ color: '#faad14' }} />,
        what: 'Port durum değişikliği log\'da tespit edildi.',
        rows: [
          { label: 'Log Satırı', value: (
            <Text code style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {d.log_line || ev.message || '—'}
            </Text>
          )},
        ],
        links: [
          { label: 'Cihaza Git', path: devSearch, icon: <ApiOutlined /> },
        ],
      }

    default:
      return {
        icon: <AlertOutlined style={{ color: '#faad14' }} />,
        what: ev.message || 'Detay için ilgili sayfaları kontrol edin.',
        rows: [
          ...(ev.message ? [{ label: 'Mesaj', value: ev.message }] : []),
          ...(Object.keys(d).length > 0 ? [{ label: 'Detaylar', value: (
            <Text code style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(d, null, 2)}
            </Text>
          )}] : []),
        ],
        links: [
          ...(ev.device_hostname ? [{ label: 'Cihaza Git', path: devSearch, icon: <ApiOutlined /> }] : []),
        ],
      }
  }
}

export default function MonitorPage() {
  const { message } = App.useApp()
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const wsRef = useRef<WebSocket | null>(null)
  const [liveCount, setLiveCount] = useState(0)
  const [viewMode, setViewMode] = useState<'table' | 'timeline'>('timeline')
  const [newIds, setNewIds] = useState<Set<number>>(new Set())
  const prevIdsRef = useRef<Set<number>>(new Set())
  const [severityFilter, setSeverityFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [deviceFilter, setDeviceFilter] = useState<number | undefined>()
  const [unackedOnly, setUnackedOnly] = useState(false)
  const [hours, setHours] = useState(24)
  const [page, setPage] = useState(1)
  const [selectedEvent, setSelectedEvent] = useState<NetworkEvent | null>(null)
  const pageSize = 50

  const { data: eventsData, isFetching, refetch } = useQuery({
    queryKey: ['monitor-events', severityFilter, typeFilter, deviceFilter, hours, unackedOnly, page, activeSite],
    queryFn: () =>
      monitorApi.getEvents({
        skip: (page - 1) * pageSize,
        limit: pageSize,
        severity: severityFilter !== 'all' ? severityFilter : undefined,
        event_type: typeFilter || undefined,
        device_id: deviceFilter,
        hours,
        unacked_only: unackedOnly,
        site: activeSite || undefined,
      }),
    refetchInterval: 15000,
  })

  const { data: statsData, refetch: refetchStats } = useQuery({
    queryKey: ['monitor-stats', activeSite],
    queryFn: () => monitorApi.getStats({ site: activeSite || undefined }),
    refetchInterval: 30000,
  })

  const { data: devicesData } = useQuery({
    queryKey: ['devices-all'],
    queryFn: () => devicesApi.list({ limit: 2000 }),
  })

  // Live WebSocket — count new events
  useEffect(() => {
    const url = buildWsUrl('/api/v1/ws/events')

    const connect = () => {
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onmessage = () => {
        setLiveCount((n) => n + 1)
        refetch()
      }
      ws.onclose = () => setTimeout(connect, 5000)
      ws.onerror = () => ws.close()
    }
    connect()
    return () => wsRef.current?.close()
  }, [])

  const handleAck = async (id: number) => {
    await monitorApi.acknowledge(id)
    qc.invalidateQueries({ queryKey: ['monitor-events'] })
    qc.invalidateQueries({ queryKey: ['monitor-stats'] })
  }

  const handleAckAll = async () => {
    await monitorApi.acknowledgeAll()
    message.success(t('monitor.bulk_acked'))
    qc.invalidateQueries({ queryKey: ['monitor-events'] })
    qc.invalidateQueries({ queryKey: ['monitor-stats'] })
    refetchStats()
  }

  const handleScan = async () => {
    await monitorApi.triggerScan()
    message.success(t('monitor.scan_queued'))
  }

  const handlePurgeNoise = async () => {
    const res = await monitorApi.purgeNoise(1)
    message.success(`${res.deleted} gürültü olayı silindi (flapping, correlation, agent_outage)`)
    qc.invalidateQueries({ queryKey: ['monitor-events'] })
    qc.invalidateQueries({ queryKey: ['monitor-stats'] })
    refetchStats()
  }

  const s = statsData
  const events = eventsData?.items || []
  const total = eventsData?.total || 0
  const unacked = s?.events_24h.unacknowledged ?? 0

  // Track new event IDs for slide-in animation
  useEffect(() => {
    const currentIds = new Set(events.map(e => e.id))
    const added = new Set([...currentIds].filter(id => !prevIdsRef.current.has(id)))
    if (added.size > 0 && prevIdsRef.current.size > 0) {
      setNewIds(added)
      const timer = setTimeout(() => setNewIds(new Set()), 2000)
      return () => clearTimeout(timer)
    }
    prevIdsRef.current = currentIds
  }, [events])

  const deviceOptions = (devicesData?.items || []).map((d) => ({
    label: `${d.hostname} (${d.ip_address})`,
    value: d.id,
  }))

  const columns = [
    {
      title: '',
      dataIndex: 'severity',
      width: 36,
      render: (v: string) => <Tooltip title={v}>{SEV_ICON[v]}</Tooltip>,
    },
    {
      title: t('monitor.col_message'),
      dataIndex: 'title',
      ellipsis: true,
      render: (v: string, r: NetworkEvent) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{v}</Text>
          {r.message && (
            <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>{r.message}</div>
          )}
        </div>
      ),
    },
    {
      title: t('monitor.col_type'),
      dataIndex: 'event_type',
      width: 130,
      render: (v: string) => (
        <Tag color={
          v.includes('offline') || v.includes('loop') ? 'red'
          : v === 'threshold_alert' ? 'volcano'
          : v.includes('stp') ? 'orange'
          : v === 'device_online' ? 'green'
          : 'blue'
        }>
          {TYPE_LABELS[v] || v}
        </Tag>
      ),
    },
    {
      title: t('monitor.col_severity'),
      dataIndex: 'severity',
      width: 90,
      render: (v: string) => <Tag color={SEV_HEX[v] || 'default'}>{v}</Tag>,
    },
    {
      title: t('monitor.col_device'),
      dataIndex: 'device_hostname',
      width: 140,
      ellipsis: true,
      render: (v: string | null) => v ? <Tag color="geekblue">{v}</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: t('monitor.col_time'),
      dataIndex: 'created_at',
      width: 120,
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}>
          <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).fromNow()}</Text>
        </Tooltip>
      ),
    },
    {
      title: '',
      dataIndex: 'acknowledged',
      width: 70,
      render: (v: boolean, r: NetworkEvent) =>
        v ? (
          <CheckCircleFilled style={{ color: '#52c41a', fontSize: 16 }} />
        ) : (
          <Tooltip title={t('monitor.acknowledge')}>
            <Button
              size="small"
              icon={<CheckOutlined />}
              onClick={() => handleAck(r.id)}
            />
          </Tooltip>
        ),
    },
  ]

  return (
    <div>
      <style>{MONITOR_CSS}</style>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>{t('monitor.title')}</Title>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 4 }}>
            {/* Pulsing live dot */}
            <div style={{ position: 'relative', width: 8, height: 8, flexShrink: 0 }}>
              <div style={{
                position: 'absolute', inset: 0,
                borderRadius: '50%', background: '#22c55e',
                animation: 'monitorLivePing 2s ease-out infinite',
              }} />
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: '#22c55e' }} />
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {liveCount > 0
                ? <><Badge count={liveCount} size="small" style={{ marginRight: 5 }} />yeni olay alındı</>
                : t('monitor.live')}
            </Text>
          </div>
        </div>
        <Space>
          <Button.Group size="small">
            <Button
              type={viewMode === 'timeline' ? 'primary' : 'default'}
              icon={<UnorderedListOutlined />}
              onClick={() => setViewMode('timeline')}
            >
              Timeline
            </Button>
            <Button
              type={viewMode === 'table' ? 'primary' : 'default'}
              icon={<MenuOutlined />}
              onClick={() => setViewMode('table')}
            >
              Tablo
            </Button>
          </Button.Group>
          <Button
            icon={<AlertOutlined />}
            onClick={() => { setTypeFilter('threshold_alert'); setHours(168); setPage(1) }}
          >
            Alarm Geçmişi
          </Button>
          <Button
            icon={<ThunderboltOutlined />}
            type="primary"
            onClick={handleScan}
          >
            {t('monitor.scan')}
          </Button>
          {unacked > 0 && (
            <Popconfirm
              title={t('monitor.bulk_ack_confirm', { count: unacked })}
              onConfirm={handleAckAll}
            >
              <Button icon={<CheckOutlined />}>
                {t('monitor.bulk_ack')} ({unacked})
              </Button>
            </Popconfirm>
          )}
          <Popconfirm
            title="Son 1 saatteki flapping / correlation / agent_outage olayları silinsin mi?"
            onConfirm={handlePurgeNoise}
            okText="Sil"
            cancelText="İptal"
          >
            <Button icon={<ClearOutlined />} danger>
              Gürültüyü Temizle
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {/* Stat cards */}
      <Row gutter={[14, 14]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <SevCard label={t('monitor.stat_critical')} value={s?.events_24h.by_severity?.critical ?? 0} color="#ef4444" isDark={isDark} glow />
        </Col>
        <Col xs={12} sm={6}>
          <SevCard label={t('monitor.stat_warning')} value={s?.events_24h.by_severity?.warning ?? 0} color="#f59e0b" isDark={isDark} glow />
        </Col>
        <Col xs={12} sm={6}>
          <SevCard label={t('monitor.stat_total')} value={s?.events_24h.total ?? 0} color="#3b82f6" isDark={isDark} />
        </Col>
        <Col xs={12} sm={6}>
          <SevCard label={t('monitor.stat_unacked')} value={unacked} color={unacked > 0 ? '#ef4444' : '#22c55e'} isDark={isDark} glow={unacked > 0} />
        </Col>
      </Row>

      {/* Filters */}
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        styles={{ body: { padding: '10px 16px' } }}
      >
        <Space wrap>
          <FilterOutlined style={{ color: '#8c8c8c' }} />
          <Segmented
            options={[
              { label: t('monitor.filter_all'), value: 'all' },
              { label: t('monitor.critical'), value: 'critical' },
              { label: t('monitor.warning'), value: 'warning' },
              { label: t('monitor.info'), value: 'info' },
            ]}
            value={severityFilter}
            onChange={(v) => { setSeverityFilter(v as string); setPage(1) }}
            size="small"
          />
          <Select
            placeholder="Olay türü"
            allowClear
            style={{ width: 160 }}
            size="small"
            value={typeFilter || undefined}
            onChange={(v) => { setTypeFilter(v || ''); setPage(1) }}
            options={Object.entries(TYPE_LABELS).map(([k, v]) => ({ value: k, label: v }))}
          />
          <Select
            placeholder="Cihaz filtrele"
            allowClear
            style={{ width: 200 }}
            size="small"
            value={deviceFilter}
            onChange={(v) => { setDeviceFilter(v); setPage(1) }}
            options={deviceOptions}
            showSearch
            filterOption={(input, opt) =>
              String(opt?.label ?? '').toLowerCase().includes(input.toLowerCase())
            }
          />
          <Select
            value={hours}
            onChange={(v) => { setHours(v); setPage(1) }}
            size="small"
            style={{ width: 120 }}
            options={[
              { value: 1, label: 'Son 1 saat' },
              { value: 6, label: 'Son 6 saat' },
              { value: 24, label: 'Son 24 saat' },
              { value: 72, label: 'Son 3 gün' },
              { value: 168, label: 'Son 7 gün' },
            ]}
          />
          <Button
            size="small"
            type={unackedOnly ? 'primary' : 'default'}
            icon={<BellOutlined />}
            onClick={() => { setUnackedOnly((v) => !v); setPage(1) }}
          >
            {t('monitor.unacked_only')}
          </Button>
          <Button
            size="small"
            icon={<SyncOutlined spin={isFetching} />}
            onClick={() => refetch()}
          >
            {t('common.refresh')}
          </Button>
        </Space>
      </Card>

      {/* Events */}
      <Card styles={{ body: { padding: 0 } }}>
        {viewMode === 'timeline' ? (
          <>
            <TimelineView
              events={events}
              newIds={newIds}
              isDark={isDark}
              onAck={handleAck}
            />
            {total > pageSize && (
              <div style={{ padding: '10px 16px', borderTop: `1px solid ${isDark ? '#1a3458' : '#e2e8f0'}`, display: 'flex', justifyContent: 'flex-end' }}>
                <Space>
                  <Button size="small" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Önceki</Button>
                  <span style={{ fontSize: 12, color: isDark ? '#475569' : '#94a3b8' }}>{page} / {Math.ceil(total / pageSize)}</span>
                  <Button size="small" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage(p => p + 1)}>Sonraki →</Button>
                </Space>
              </div>
            )}
          </>
        ) : (
          <Table<NetworkEvent>
            dataSource={events}
            rowKey="id"
            columns={columns}
            size="small"
            loading={isFetching}
            pagination={{
              current: page,
              pageSize,
              total,
              onChange: (p) => setPage(p),
              showTotal: (n) => `${n}`,
              showSizeChanger: false,
            }}
            rowClassName={(r) =>
              `mon-row-${r.severity}${!r.acknowledged ? ' mon-row-unacked' : ''}`
            }
            onRow={(r) => ({
              style: { borderLeft: `3px solid ${SEV_HEX[r.severity] || '#3b82f640'}`, cursor: 'pointer' },
              onClick: () => setSelectedEvent(r),
            })}
            style={{ minHeight: 400 }}
          />
        )}
      </Card>

      {/* ── Event Detail Modal ─────────────────────────────────────────── */}
      {selectedEvent && (() => {
        const ev = selectedEvent
        const detail = buildEventDetail(ev)
        const sevColor = ev.severity === 'critical' ? '#ff4d4f' : ev.severity === 'warning' ? '#faad14' : '#1677ff'
        return (
          <Modal
            open
            onCancel={() => setSelectedEvent(null)}
            footer={null}
            width={560}
            title={
              <Space size={10}>
                {detail.icon}
                <span style={{ fontSize: 15 }}>{ev.title}</span>
                <Tag color={sevColor} style={{ fontSize: 11 }}>{ev.severity}</Tag>
              </Space>
            }
          >
            {/* Meta */}
            <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
              <Descriptions.Item label="Olay Türü">
                <Tag>{TYPE_LABELS[ev.event_type] || ev.event_type}</Tag>
              </Descriptions.Item>
              {ev.device_hostname && (
                <Descriptions.Item label="Cihaz">
                  <Tag color="geekblue">{ev.device_hostname}</Tag>
                </Descriptions.Item>
              )}
              <Descriptions.Item label="Zaman" span={2}>
                {dayjs(ev.created_at).format('DD.MM.YYYY HH:mm:ss')}
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                  ({dayjs(ev.created_at).fromNow()})
                </Text>
              </Descriptions.Item>
            </Descriptions>

            {/* What happened */}
            <div style={{
              background: ev.severity === 'critical' ? '#fff1f0' : ev.severity === 'warning' ? '#fffbe6' : '#e6f4ff',
              border: `1px solid ${sevColor}30`,
              borderRadius: 8, padding: '10px 14px', marginBottom: 14,
            }}>
              <Text style={{ fontSize: 13 }}>{detail.what}</Text>
            </div>

            {/* Detail rows */}
            {detail.rows.length > 0 && (
              <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
                {detail.rows.map((row, i) => (
                  <Descriptions.Item key={i} label={<Text style={{ fontSize: 12 }}>{row.label}</Text>}>
                    {typeof row.value === 'string'
                      ? <Text style={{ fontSize: 12 }}>{row.value}</Text>
                      : row.value}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            )}

            <Divider style={{ margin: '12px 0' }} />

            {/* Navigation links */}
            <div style={{ marginBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>İlgili sayfalar:</Text>
            </div>
            <Space wrap size={8}>
              {detail.links.map((link, i) => (
                <Button
                  key={i}
                  icon={link.icon}
                  onClick={() => { setSelectedEvent(null); navigate(link.path) }}
                >
                  {link.label}
                </Button>
              ))}
              {!ev.acknowledged && (
                <Button
                  icon={<CheckOutlined />}
                  onClick={async () => { await handleAck(ev.id); setSelectedEvent(null) }}
                >
                  Onayla
                </Button>
              )}
            </Space>
          </Modal>
        )
      })()}

    </div>
  )
}
