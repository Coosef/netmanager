import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Col, Row, Tag, Tooltip, Progress } from 'antd'
import {
  LaptopOutlined, ApartmentOutlined, CheckCircleOutlined,
  WarningOutlined, WifiOutlined, DatabaseOutlined,
  ThunderboltOutlined,
  PlusOutlined, RadarChartOutlined, BarChartOutlined,
  CloseCircleOutlined, InfoCircleOutlined, RightOutlined,
  FireOutlined, RobotOutlined, SwapOutlined, SyncOutlined,
  ExperimentOutlined, EyeInvisibleOutlined, SafetyOutlined, CalendarOutlined, RiseOutlined,
  DashboardOutlined, ArrowUpOutlined, ArrowDownOutlined,
} from '@ant-design/icons'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { monitorApi } from '@/api/monitor'
import { assetLifecycleApi } from '@/api/assetLifecycle'
import { tasksApi } from '@/api/tasks'
import { agentsApi } from '@/api/agents'
import { topologyApi } from '@/api/topology'
import { dashboardApi } from '@/api/dashboard'
import { slaApi } from '@/api/sla'
import { useTranslation } from 'react-i18next'
import type { NetworkEvent, MonitorStats } from '@/api/monitor'
import type { Task } from '@/types'
import { buildWsUrl } from '@/utils/ws'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'

dayjs.extend(relativeTime)

// ── Theme-aware palettes ─────────────────────────────────────────────────────
const C_DARK = {
  page:    '#030c1e',
  card:    'rgba(6, 16, 40, 0.94)',
  card2:   'rgba(3, 9, 26, 0.90)',
  border:  'rgba(0, 195, 255, 0.09)',
  text:    '#d8eeff',
  muted:   '#5a7a9a',
  dim:     '#304560',
  hover:   'rgba(0, 195, 255, 0.06)',
  bgTrack: 'rgba(255,255,255,0.05)',
}
const C_LIGHT = {
  page:    '#f0f5fb',
  card:    'rgba(255, 255, 255, 0.97)',
  card2:   'rgba(248, 250, 253, 0.97)',
  border:  'rgba(59, 130, 246, 0.12)',
  text:    '#1e293b',
  muted:   '#475569',
  dim:     '#94a3b8',
  hover:   'rgba(59, 130, 246, 0.05)',
  bgTrack: 'rgba(0,0,0,0.07)',
}
const N_DARK = {
  cyan:   '#00d4ff',
  green:  '#00e676',
  red:    '#ff3d6a',
  amber:  '#ffb300',
  blue:   '#4488ff',
  purple: '#a78bfa',
  teal:   '#00bfa5',
}
const N_LIGHT = {
  cyan:   '#0284c7',
  green:  '#15803d',
  red:    '#dc2626',
  amber:  '#d97706',
  blue:   '#2563eb',
  purple: '#7c3aed',
  teal:   '#0d9488',
}
type CPalette = typeof C_DARK
type NPalette = typeof N_DARK
const DashCtx = createContext<{ C: CPalette; N: NPalette; isDark: boolean }>({ C: C_DARK, N: N_DARK, isDark: true })
const useDash = () => useContext(DashCtx)

const makeTV_CSS = (isDark: boolean) => `
@keyframes tvCountUp  { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
@keyframes tvFadeIn   { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
@keyframes tvScan     { 0%{left:-40%} 100%{left:140%} }
@keyframes tvTicker   { 0%{transform:translateX(0)} 100%{transform:translateX(-50%)} }
@keyframes tvLed      { 0%,85%,100%{opacity:1} 90%{opacity:0.1} }
@keyframes tvGlowGreen{ 0%,100%{box-shadow:0 0 6px #00e67640} 50%{box-shadow:0 0 18px #00e67680} }
@keyframes tvGlowRed  { 0%,100%{box-shadow:0 0 6px #ff3d6a40} 50%{box-shadow:0 0 18px #ff3d6a80} }
@keyframes tvPulse    { 0%,100%{opacity:0.7} 50%{opacity:1} }
@keyframes tvBorderPulse { 0%,100%{border-color:rgba(0,195,255,0.09)} 50%{border-color:rgba(0,195,255,0.22)} }
.tv-card {
  background: ${isDark ? 'rgba(6,16,40,0.94)' : 'rgba(255,255,255,0.97)'};
  border: 1px solid ${isDark ? 'rgba(0,195,255,0.09)' : 'rgba(59,130,246,0.12)'};
  border-radius: 12px;
  backdrop-filter: blur(10px);
  position: relative;
  overflow: hidden;
  animation: tvFadeIn 0.4s ease-out both;
  transition: border-color 0.25s, box-shadow 0.25s;
}
.tv-card:hover {
  border-color: ${isDark ? 'rgba(0,195,255,0.22)' : 'rgba(59,130,246,0.28)'};
  box-shadow: ${isDark ? '0 4px 28px rgba(0,195,255,0.07)' : '0 4px 28px rgba(59,130,246,0.12)'};
}
.tv-card::after {
  content:'';
  position:absolute;
  inset:0;
  background:${isDark ? 'linear-gradient(135deg, rgba(0,195,255,0.025) 0%, transparent 45%)' : 'linear-gradient(135deg, rgba(59,130,246,0.03) 0%, transparent 45%)'};
  pointer-events:none;
}
.tv-scan {
  position:absolute; top:0; bottom:0; width:22%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,0.012),transparent);
  animation:tvScan 6s linear infinite;
  pointer-events:none;
}
`

// ── Count-up animation hook ───────────────────────────────────────────────────
function useCountUp(target: number, duration = 900) {
  const [val, setVal] = useState(0)
  const rafRef = useRef<number>(0)
  const startRef = useRef<number | null>(null)
  const fromRef = useRef(0)

  useEffect(() => {
    fromRef.current = val
    startRef.current = null
    cancelAnimationFrame(rafRef.current)
    const step = (ts: number) => {
      if (startRef.current === null) startRef.current = ts
      const p = Math.min((ts - startRef.current) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(Math.round(fromRef.current + (target - fromRef.current) * eased))
      if (p < 1) rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target]) // eslint-disable-line react-hooks/exhaustive-deps
  return val
}

// ── Mini sparkline SVG ────────────────────────────────────────────────────────
function MiniSparkline({ data, color, width = 80, height = 28 }: {
  data: number[]; color: string; width?: number; height?: number
}) {
  if (!data || data.length < 2) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - 2 - ((v - min) / range) * (height - 6)
    return [x, y] as [number, number]
  })
  const linePts = pts.map(([x, y]) => `${x},${y}`).join(' ')
  const areaPath = `M${pts[0][0]},${pts[0][1]} ${pts.map(([x, y]) => `L${x},${y}`).join(' ')} L${width},${height} L0,${height} Z`
  const uid = color.replace(/[^a-z0-9]/gi, '')
  return (
    <svg width={width} height={height} style={{ display: 'block', flexShrink: 0 }}>
      <defs>
        <linearGradient id={`sg-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity={0.4} />
          <stop offset="100%" stopColor={color} stopOpacity={0}   />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#sg-${uid})`} />
      <polyline points={linePts} fill="none" stroke={color} strokeWidth={1.5}
        strokeLinecap="round" strokeLinejoin="round"
        style={{ filter: `drop-shadow(0 0 3px ${color}80)` }}
      />
      {/* Last point dot */}
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.5}
        fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
    </svg>
  )
}

// ── Live clock ────────────────────────────────────────────────────────────────
function LiveClock() {
  const { C, N } = useDash()
  const [t, setT] = useState(dayjs())
  useEffect(() => {
    const id = setInterval(() => setT(dayjs()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div style={{ textAlign: 'right', userSelect: 'none' }}>
      <div style={{
        fontFamily: 'monospace', fontSize: 26, fontWeight: 800,
        color: N.cyan, letterSpacing: 3, lineHeight: 1,
        textShadow: `0 0 20px ${N.cyan}60`,
      }}>
        {t.format('HH:mm:ss')}
      </div>
      <div style={{ color: C.dim, fontSize: 10, letterSpacing: 1.5, marginTop: 3 }}>
        {t.format('DD.MM.YYYY  dddd').toUpperCase()}
      </div>
    </div>
  )
}

// ── SVG ring progress ─────────────────────────────────────────────────────────
function RingGauge({ pct, color, size = 96 }: { pct: number; color: string; size?: number }) {
  const r = (size - 14) / 2
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - pct / 100)
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`${color}15`} strokeWidth={7} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={7}
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 1.4s ease-out', filter: `drop-shadow(0 0 5px ${color})` }}
      />
    </svg>
  )
}

// ── Neon stat card ────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, color, onClick, trend }: {
  icon: React.ReactNode; label: string; value: number | string
  sub?: string; color: string; onClick?: () => void; trend?: number[]
}) {
  const { C } = useDash()
  const numVal = typeof value === 'number' ? value : 0
  const animated = useCountUp(numVal)
  const display = typeof value === 'number' ? animated : value

  return (
    <div
      className="tv-card"
      onClick={onClick}
      style={{
        padding: '16px 18px',
        cursor: onClick ? 'pointer' : undefined,
        borderTop: `2px solid ${color}`,
        boxShadow: `0 2px 24px ${color}10, inset 0 1px 0 ${color}15`,
        flex: 1, minWidth: 120,
      }}
    >
      <div className="tv-scan" />
      <div style={{ position: 'absolute', top: 10, right: 12, color, fontSize: 28, opacity: 0.07 }}>{icon}</div>
      <div style={{ position: 'relative' }}>
        <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, letterSpacing: 1.8, textTransform: 'uppercase', marginBottom: 8 }}>
          {label}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 6 }}>
          <div style={{
            color, fontFamily: 'monospace', fontSize: 34, fontWeight: 900, lineHeight: 1,
            textShadow: `0 0 22px ${color}55`,
          }}>
            {display}
          </div>
          {trend && trend.some(v => v > 0) && (
            <MiniSparkline data={trend} color={color} width={76} height={30} />
          )}
        </div>
        {sub && <div style={{ color: C.dim, fontSize: 10, marginTop: 6 }}>{sub}</div>}
      </div>
    </div>
  )
}

// ── Hero status banner ────────────────────────────────────────────────────────
function StatusHero({ s, liveEvents }: { s: MonitorStats | undefined; liveEvents: NetworkEvent[] }) {
  const { C, N, isDark } = useDash()
  const online  = s?.devices.online  ?? 0
  const offline = s?.devices.offline ?? 0
  const total   = s?.devices.total   ?? 0
  const alerts  = s?.events_24h.unacknowledged ?? 0
  const pct     = total > 0 ? Math.round(online / total * 100) : 0
  const color   = pct >= 95 ? N.green : pct >= 75 ? N.amber : N.red
  const statusLabel = pct >= 95 ? 'TÜM SİSTEMLER NORMAL' : pct >= 75 ? 'DİKKAT GEREKİYOR' : 'KRİTİK SORUN'
  const ticker  = liveEvents.slice(0, 14)

  return (
    <div style={{
      background: isDark
        ? `radial-gradient(ellipse at 28% 50%, ${color}0d 0%, transparent 52%),
           radial-gradient(ellipse at 72% 50%, ${N.blue}09 0%, transparent 52%),
           rgba(3, 9, 28, 0.96)`
        : C.card,
      border: `1px solid ${color}22`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 14,
      padding: '20px 26px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div className="tv-scan" />

      <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap', position: 'relative' }}>
        {/* Ring gauge */}
        <div style={{ position: 'relative', width: 96, height: 96, flexShrink: 0 }}>
          <RingGauge pct={pct} color={color} size={96} />
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <span key={pct} style={{
              fontFamily: 'monospace', fontSize: 22, fontWeight: 900,
              color, lineHeight: 1,
              textShadow: `0 0 14px ${color}70`,
              animation: 'tvCountUp 0.7s ease-out',
            }}>{pct}%</span>
            <span style={{ color: C.dim, fontSize: 8, letterSpacing: 1.5, marginTop: 2 }}>ONLİNE</span>
          </div>
        </div>

        {/* Status info */}
        <div style={{ minWidth: 130 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: color, boxShadow: `0 0 8px ${color}`,
              animation: 'tvLed 3s ease-in-out infinite',
            }} />
            <span style={{ color, fontSize: 10, fontWeight: 800, letterSpacing: 2 }}>{statusLabel}</span>
          </div>
          <div style={{ background: C.bgTrack, borderRadius: 4, height: 4, width: 160, overflow: 'hidden', marginBottom: 6 }}>
            <div style={{
              height: '100%', borderRadius: 4, width: `${pct}%`,
              background: `linear-gradient(90deg, ${color}70, ${color})`,
              boxShadow: `0 0 10px ${color}60`,
              transition: 'width 1.4s ease-out',
            }} />
          </div>
          <div style={{ color: C.dim, fontSize: 10, letterSpacing: 0.5 }}>AĞ SAĞLIK DURUMU</div>
        </div>

        {/* Metric counters */}
        <div style={{ display: 'flex', gap: 22 }}>
          {[
            { v: online,  l: 'ONLİNE',  c: N.green  },
            { v: offline, l: 'OFFLİNE', c: N.red    },
            { v: alerts,  l: 'UYARI',   c: N.amber  },
            { v: total,   l: 'TOPLAM',  c: N.blue   },
          ].map(({ v, l, c }) => (
            <div key={l} style={{ textAlign: 'center' }}>
              <div key={v} style={{
                fontFamily: 'monospace', fontSize: 30, fontWeight: 900, lineHeight: 1,
                color: c, textShadow: `0 0 18px ${c}50`,
                animation: 'tvCountUp 0.5s ease-out',
              }}>{v}</div>
              <div style={{ color: C.dim, fontSize: 9, letterSpacing: 1.8, fontWeight: 700, marginTop: 4 }}>{l}</div>
            </div>
          ))}
        </div>

        {/* Live ticker */}
        {ticker.length > 0 && (
          <div style={{ flex: 1, minWidth: 180, overflow: 'hidden', borderLeft: `1px solid ${C.border}`, paddingLeft: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
              <div style={{
                width: 5, height: 5, borderRadius: '50%',
                background: N.cyan, boxShadow: `0 0 6px ${N.cyan}`,
                animation: 'tvLed 1.4s ease-in-out infinite',
              }} />
              <span style={{ color: N.cyan, fontSize: 9, fontWeight: 800, letterSpacing: 3 }}>CANLI OLAYLAR</span>
            </div>
            <div style={{ overflow: 'hidden', height: 18 }}>
              <div style={{
                display: 'flex', whiteSpace: 'nowrap',
                animation: `tvTicker ${Math.max(ticker.length * 5, 18)}s linear infinite`,
              }}>
                {[...ticker, ...ticker].map((ev, i) => (
                  <span key={i} style={{ color: C.muted, fontSize: 11, paddingRight: 50 }}>
                    <span style={{
                      color: ev.severity === 'critical' ? N.red : ev.severity === 'warning' ? N.amber : N.cyan,
                      marginRight: 6,
                    }}>◆</span>
                    {ev.title}
                    {ev.device_hostname && <span style={{ color: C.dim }}> [{ev.device_hostname}]</span>}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Section divider ───────────────────────────────────────────────────────────
function SectionBar({ icon, title }: { icon: React.ReactNode; title: string }) {
  const { N } = useDash()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 2px' }}>
      <span style={{ color: N.cyan, fontSize: 13 }}>{icon}</span>
      <span style={{ color: N.cyan, fontSize: 10, fontWeight: 800, letterSpacing: 2.5, textTransform: 'uppercase' }}>{title}</span>
      <div style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${N.cyan}35, transparent)` }} />
    </div>
  )
}

// ── Card header row ───────────────────────────────────────────────────────────
function CardHead({ icon, title, extra, color }: {
  icon: React.ReactNode; title: string; extra?: React.ReactNode; color?: string
}) {
  const { C, N } = useDash()
  const resolvedColor = color ?? N.cyan
  return (
    <div style={{
      padding: '12px 18px',
      borderBottom: `1px solid ${C.border}`,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: resolvedColor }}>{icon}</span>
        <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>{title}</span>
      </div>
      {extra}
    </div>
  )
}

// ── Mini progress bar ─────────────────────────────────────────────────────────
function MiniBar({ value, total, color }: { value: number; total: number; color: string }) {
  const { C } = useDash()
  const pct = total > 0 ? Math.round(value / total * 100) : 0
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ color: C.muted, fontSize: 11 }}>{value}</span>
        <span style={{ color, fontSize: 11, fontWeight: 700 }}>{pct}%</span>
      </div>
      <div style={{ background: C.bgTrack, borderRadius: 3, height: 4, overflow: 'hidden' }}>
        <div style={{
          background: color, width: `${pct}%`, height: '100%', borderRadius: 3,
          boxShadow: `0 0 6px ${color}60`,
          transition: 'width 1s ease-out',
        }} />
      </div>
    </div>
  )
}

// ── Main dashboard ────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const { t }     = useTranslation()
  const { isDark } = useTheme()
  const { activeSite } = useSite()
  const C = isDark ? C_DARK : C_LIGHT
  const N = isDark ? N_DARK : N_LIGHT
  const wsRef     = useRef<WebSocket | null>(null)
  const [liveEvents, setLiveEvents] = useState<NetworkEvent[]>([])

  const TASK_STATUS_COLOR: Record<string, string> = {
    success: N.green, partial: N.amber, failed: N.red,
    running: N.blue, pending: C.muted, cancelled: C.dim,
  }
  const TASK_STATUS_LABEL: Record<string, string> = {
    success: t('tasks.status_success'), partial: t('tasks.status_partial'),
    failed: t('tasks.status_failed'), running: t('tasks.status_running'),
    pending: t('tasks.status_pending'), cancelled: t('tasks.status_cancelled'),
  }
  const SEV_ICON: Record<string, React.ReactNode> = {
    critical:             <CloseCircleOutlined style={{ color: N.red,   fontSize: 13 }} />,
    warning:              <WarningOutlined     style={{ color: N.amber, fontSize: 13 }} />,
    info:                 <InfoCircleOutlined  style={{ color: N.cyan,  fontSize: 13 }} />,
    new_device_connected: <WifiOutlined        style={{ color: N.blue,  fontSize: 13 }} />,
  }

  // ── Queries ──────────────────────────────────────────────────────────────────
  const { data: stats }       = useQuery<MonitorStats>({ queryKey: ['monitor-stats', activeSite],   queryFn: () => monitorApi.getStats({ site: activeSite || undefined }),   refetchInterval: 30000  })
  const { data: tasksData }   = useQuery({ queryKey: ['tasks-recent'],          queryFn: () => tasksApi.list({ limit: 6 }),  refetchInterval: 15000  })
  const { data: agentsData }  = useQuery({ queryKey: ['agents-list'],           queryFn: agentsApi.list,                     refetchInterval: 30000  })
  const { data: lldpData }    = useQuery({ queryKey: ['lldp-inventory'],        queryFn: () => topologyApi.getLldpInventory(), refetchInterval: 60000 })
  const { data: analytics }   = useQuery({ queryKey: ['dashboard-analytics', activeSite],   queryFn: () => dashboardApi.getAnalytics({ site: activeSite || undefined }),   refetchInterval: 60000  })
  const { data: assetStats }  = useQuery({ queryKey: ['asset-lifecycle','stats'], queryFn: () => assetLifecycleApi.stats(),   refetchInterval: 300000 })
  const { data: slaFleet }    = useQuery({ queryKey: ['sla-fleet-summary'],     queryFn: () => slaApi.getFleetSummary(30),   refetchInterval: 300000 })
  const { data: snmpSummary }  = useQuery({ queryKey: ['dashboard-snmp-summary'], queryFn: dashboardApi.getSnmpSummary,   refetchInterval: 60000  })
  const { data: snmpChart }    = useQuery({ queryKey: ['dashboard-snmp-chart'],  queryFn: dashboardApi.getSnmpChart,     refetchInterval: 300000 })
  const { data: sparklineData} = useQuery({ queryKey: ['dashboard-sparklines'],  queryFn: dashboardApi.getSparklines,    refetchInterval: 60000  })

  // ── WebSocket ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const url = buildWsUrl('/api/v1/ws/events')
    const connect = () => {
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onmessage = (e) => {
        try { setLiveEvents((prev) => [JSON.parse(e.data), ...prev].slice(0, 30)) } catch { /* ignore */ }
      }
      ws.onclose = () => setTimeout(connect, 5000)
      ws.onerror = () => ws.close()
    }
    connect()
    return () => wsRef.current?.close()
  }, [])

  const s            = stats
  const agents       = agentsData || []
  const tasks        = tasksData?.items || []
  const onlineAgents = agents.filter((a: any) => a.status === 'online').length
  const lldpTotal    = lldpData?.total ?? 0

  const snmpDeviceTrend = snmpChart?.points.map(p => p.device_count) ?? []
  const snmpBwTrend     = snmpChart?.points.map(p => +(p.avg_in + p.avg_out).toFixed(1)) ?? []
  const eventsTrend     = sparklineData?.events_24h.map(p => p.count) ?? []

  const topStatCards = [
    { icon: <LaptopOutlined />,       label: t('dashboard.stat_total'),  value: s?.devices.total   ?? 0, color: N.blue,   sub: t('dashboard.sub_managed'),    onClick: () => navigate('/devices'),   trend: snmpDeviceTrend  },
    { icon: <ApartmentOutlined />,    label: t('dashboard.stat_switch'), value: s?.topology.nodes  ?? 0, color: N.purple, sub: t('dashboard.sub_topo_nodes'),  onClick: () => navigate('/topology')                          },
    { icon: <CheckCircleOutlined />,  label: t('dashboard.stat_online'), value: s?.devices.online  ?? 0, color: N.green,  sub: t('dashboard.sub_online'),      onClick: () => navigate('/devices'),   trend: snmpDeviceTrend  },
    { icon: <WarningOutlined />,      label: t('dashboard.stat_alerts'), value: s?.events_24h.unacknowledged ?? 0, color: N.amber, sub: t('dashboard.sub_alerts'), onClick: () => navigate('/monitor'), trend: eventsTrend    },
    { icon: <WifiOutlined />,         label: t('dashboard.stat_lldp'),   value: lldpTotal,           color: N.teal,   sub: t('dashboard.sub_lldp'),        onClick: () => navigate('/discovery')                         },
    { icon: <DatabaseOutlined />,     label: t('dashboard.stat_config'), value: (s?.devices.total ?? 0) - (s?.backups.never ?? 0), color: N.cyan, sub: t('dashboard.sub_config'), onClick: () => navigate('/reports'), trend: snmpBwTrend },
  ]

  // ── Page background wrapper ───────────────────────────────────────────────────
  return (
    <DashCtx.Provider value={{ C, N, isDark }}>
    <div style={{
      minHeight: '100vh',
      background: isDark
        ? `radial-gradient(ellipse at 15% 10%, rgba(0,80,160,0.18) 0%, transparent 45%),
           radial-gradient(ellipse at 85% 90%, rgba(80,0,160,0.12) 0%, transparent 45%),
           ${C.page}`
        : C.page,
      margin: -24,
      padding: 24,
      position: 'relative',
    }}>
      <style>{makeTV_CSS(isDark)}</style>

      {/* Dot-grid overlay */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0,
        backgroundImage: isDark
          ? 'radial-gradient(rgba(0,195,255,0.04) 1px, transparent 1px)'
          : 'radial-gradient(rgba(59,130,246,0.08) 1px, transparent 1px)',
        backgroundSize: '28px 28px',
      }} />

      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Top header bar ──────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 0',
        }}>
          {/* Logo / title */}
          <div>
            <div style={{
              color: N.cyan, fontWeight: 900, fontSize: 20, letterSpacing: 2,
              textShadow: `0 0 24px ${N.cyan}50`,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: N.green, boxShadow: `0 0 10px ${N.green}`,
                animation: 'tvLed 3s ease-in-out infinite',
              }} />
              NETMANAGER
            </div>
            <div style={{ color: C.dim, fontSize: 10, letterSpacing: 2.5, marginTop: 2 }}>
              NETWORK INTELLIGENCE PLATFORM
            </div>
          </div>

          {/* Center: quick actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { icon: <PlusOutlined />,           label: 'Cihaz Ekle',     path: '/devices'   },
              { icon: <RadarChartOutlined />,      label: 'Keşif Başlat',   path: '/topology'  },
              { icon: <ThunderboltOutlined />,     label: 'Tarama',         action: () => monitorApi.triggerScan() },
              { icon: <BarChartOutlined />,        label: 'Raporlar',       path: '/reports'   },
            ].map((item, i) => (
              <div
                key={i}
                onClick={item.action || (() => navigate(item.path!))}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: C.hover,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: '7px 14px', cursor: 'pointer',
                  color: C.muted, fontSize: 12, fontWeight: 500,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  const el = e.currentTarget as HTMLElement
                  el.style.background = isDark ? 'rgba(0,195,255,0.12)' : 'rgba(59,130,246,0.10)'
                  el.style.color = N.cyan
                  el.style.borderColor = isDark ? 'rgba(0,195,255,0.28)' : 'rgba(59,130,246,0.28)'
                }}
                onMouseLeave={(e) => {
                  const el = e.currentTarget as HTMLElement
                  el.style.background = C.hover
                  el.style.color = C.muted
                  el.style.borderColor = C.border
                }}
              >
                <span style={{ fontSize: 13 }}>{item.icon}</span>
                {item.label}
              </div>
            ))}
            <div
              onClick={() => qc.invalidateQueries()}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: C.hover,
                border: `1px solid ${C.border}`,
                borderRadius: 8, padding: '7px 14px', cursor: 'pointer',
                color: C.dim, fontSize: 12,
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => { const el = e.currentTarget as HTMLElement; el.style.color = N.cyan }}
              onMouseLeave={(e) => { const el = e.currentTarget as HTMLElement; el.style.color = C.dim }}
            >
              {t('dashboard.refresh')}
            </div>
          </div>

          {/* Live clock */}
          <LiveClock />
        </div>

        {/* ── Status hero ──────────────────────────────────────────────────────── */}
        <StatusHero s={s} liveEvents={liveEvents} />

        {/* ── Stat cards row ───────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 10 }}>
          {topStatCards.map((c) => <StatCard key={c.label} {...c} />)}
        </div>

        {/* ── Alerts + Tasks  |  Network summary ──────────────────────────────── */}
        <Row gutter={[12, 12]}>
          {/* Left 2/3 */}
          <Col xs={24} lg={16}>
            <Row gutter={[12, 12]}>
              {/* Recent alerts */}
              <Col xs={24}>
                <div className="tv-card">
                  <CardHead
                    icon={<WarningOutlined />}
                    title={t('dashboard.recent_alerts')}
                    color={N.amber}
                    extra={
                      <span
                        onClick={() => navigate('/monitor')}
                        style={{ color: N.cyan, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        {t('dashboard.view_all')} <RightOutlined />
                      </span>
                    }
                  />
                  <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                    {liveEvents.length === 0 ? (
                      <div style={{ padding: '28px 20px', textAlign: 'center', color: C.dim }}>
                        <CheckCircleOutlined style={{ fontSize: 24, color: N.green, display: 'block', marginBottom: 8 }} />
                        <span style={{ fontSize: 13 }}>{t('dashboard.no_events')}</span>
                      </div>
                    ) : liveEvents.slice(0, 8).map((ev, i) => (
                      <div key={i} style={{
                        padding: '9px 18px',
                        borderBottom: i < 7 ? `1px solid ${C.border}` : undefined,
                        display: 'flex', alignItems: 'center', gap: 10,
                        transition: 'background 0.15s',
                      }}
                        onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.background = C.hover}
                        onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                      >
                        <span style={{ flexShrink: 0 }}>{SEV_ICON[ev.severity] || SEV_ICON.info}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: C.text, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ev.title}
                          </div>
                          {ev.device_hostname && <div style={{ color: C.dim, fontSize: 11 }}>{ev.device_hostname}</div>}
                        </div>
                        <span style={{ color: C.dim, fontSize: 11, flexShrink: 0 }}>{dayjs(ev.created_at).fromNow()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Col>

              {/* Recent tasks */}
              <Col xs={24}>
                <div className="tv-card">
                  <CardHead
                    icon={<ThunderboltOutlined />}
                    title={t('dashboard.recent_tasks')}
                    color={N.blue}
                    extra={
                      <span
                        onClick={() => navigate('/tasks')}
                        style={{ color: N.cyan, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        {t('dashboard.view_all')} <RightOutlined />
                      </span>
                    }
                  />
                  {tasks.length === 0 ? (
                    <div style={{ padding: '20px 18px', color: C.dim, fontSize: 13, textAlign: 'center' }}>{t('dashboard.no_tasks')}</div>
                  ) : tasks.map((task: Task, i) => (
                    <div key={task.id} style={{
                      padding: '9px 18px',
                      borderBottom: i < tasks.length - 1 ? `1px solid ${C.border}` : undefined,
                      display: 'flex', alignItems: 'center', gap: 10,
                    }}>
                      <div style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: TASK_STATUS_COLOR[task.status] || C.muted,
                        boxShadow: `0 0 6px ${TASK_STATUS_COLOR[task.status] || C.muted}`,
                        flexShrink: 0,
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: C.text, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.name}</div>
                        <div style={{ color: C.dim, fontSize: 11 }}>{task.completed_devices}/{task.total_devices} cihaz</div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ color: TASK_STATUS_COLOR[task.status] || C.muted, fontSize: 11, fontWeight: 700 }}>
                          {TASK_STATUS_LABEL[task.status] || task.status}
                        </div>
                        <div style={{ color: C.dim, fontSize: 11 }}>{dayjs(task.created_at).format('DD.MM HH:mm')}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </Col>
            </Row>
          </Col>

          {/* Right 1/3 */}
          <Col xs={24} lg={8}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
              {/* Network summary */}
              <div className="tv-card" style={{ padding: '16px 18px', flex: 1 }}>
                <div style={{ color: C.text, fontWeight: 700, fontSize: 14, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <DashboardOutlined style={{ color: N.cyan }} />
                  {t('dashboard.network_summary')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {[
                    { label: t('common.online'),     value: s?.devices.online  ?? 0, total: s?.devices.total ?? 1, color: N.green },
                    { label: t('common.offline'),    value: s?.devices.offline ?? 0, total: s?.devices.total ?? 1, color: N.red   },
                    { label: t('dashboard.backed_up'), value: (s?.devices.total ?? 0) - (s?.backups.never ?? 0), total: s?.devices.total ?? 1, color: N.teal },
                  ].map((item) => (
                    <div key={item.label}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ color: C.muted, fontSize: 12 }}>{item.label}</span>
                      </div>
                      <MiniBar value={item.value} total={item.total} color={item.color} />
                    </div>
                  ))}
                </div>

                <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 14, paddingTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                  {[
                    { v: s?.topology.links ?? 0,       l: t('dashboard.topology_links') },
                    { v: `${onlineAgents}/${agents.length}`, l: t('dashboard.active_agents') },
                    { v: s?.events_24h.total ?? 0,     l: t('dashboard.events_24h')     },
                  ].map(({ v, l }) => (
                    <div key={l} style={{ textAlign: 'center' }}>
                      <div style={{ color: C.text, fontSize: 20, fontWeight: 800, fontFamily: 'monospace' }}>{v}</div>
                      <div style={{ color: C.dim, fontSize: 10 }}>{l}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* SLA summary if available */}
              {slaFleet && slaFleet.total > 0 && (
                <div className="tv-card" style={{ padding: '14px 18px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <RiseOutlined style={{ color: N.teal }} />
                      <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>SLA Uptime — 30 Gün</span>
                    </div>
                    <span
                      style={{
                        fontFamily: 'monospace', fontSize: 18, fontWeight: 900,
                        color: slaFleet.avg_uptime_pct >= 99 ? N.green : slaFleet.avg_uptime_pct >= 95 ? N.amber : N.red,
                      }}
                    >
                      %{slaFleet.avg_uptime_pct}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span style={{ color: N.green }}>≥99%: <strong>{slaFleet.above_99}</strong></span>
                    <span style={{ color: N.amber }}>95–99%: <strong>{slaFleet.above_95}</strong></span>
                    <span style={{ color: N.red }}>&lt;95%: <strong>{slaFleet.below_95}</strong></span>
                  </div>
                </div>
              )}
            </div>
          </Col>
        </Row>

        {/* ── Intelligence section ─────────────────────────────────────────────── */}
        {analytics && (
          <>
            <SectionBar icon={<SafetyOutlined />} title="Operasyonel İstihbarat" />

            <Row gutter={[12, 12]}>
              {/* Top problematic devices */}
              <Col xs={24} md={12} lg={8}>
                <div className="tv-card" style={{ height: '100%' }}>
                  <CardHead icon={<FireOutlined />} title="En Sorunlu Cihazlar" color={N.red}
                    extra={<span style={{ color: C.dim, fontSize: 11 }}>son 7 gün</span>}
                  />
                  {analytics.top_problematic.length === 0 ? (
                    <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12 }}>Sorunlu cihaz yok</div>
                  ) : analytics.top_problematic.slice(0, 6).map((d, i) => (
                    <div key={d.device_id} style={{
                      padding: '8px 18px',
                      borderBottom: `1px solid ${C.border}`,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <span style={{ color: C.dim, fontSize: 10, width: 16, textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: C.text, fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {d.hostname}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <span style={{ background: `${N.red}18`, color: N.red, border: `1px solid ${N.red}30`, borderRadius: 4, fontSize: 10, padding: '2px 6px', display: 'block', marginBottom: 2 }}>
                          {d.critical_count} kritik
                        </span>
                        <span style={{ color: C.dim, fontSize: 10 }}>{d.event_count} olay</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Col>

              {/* Backup compliance */}
              <Col xs={24} md={12} lg={8}>
                <div className="tv-card" style={{ marginBottom: 12 }}>
                  <CardHead icon={<DatabaseOutlined />} title="Backup Uyumu" color={N.teal} />
                  <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {[
                      { label: 'Güncel (7g)',    value: analytics.backup_compliance.ok,    color: N.green },
                      { label: 'Bayat (>7g)',    value: analytics.backup_compliance.stale, color: N.amber },
                      { label: 'Hiç Alınmamış', value: analytics.backup_compliance.never, color: N.red   },
                    ].map((item) => {
                      const pct = analytics.backup_compliance.total > 0
                        ? Math.round(item.value / analytics.backup_compliance.total * 100) : 0
                      return (
                        <div key={item.label}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ color: C.muted, fontSize: 12 }}>{item.label}</span>
                            <span style={{ color: item.color, fontSize: 12, fontWeight: 700 }}>{item.value} ({pct}%)</span>
                          </div>
                          <Progress
                            percent={pct} showInfo={false}
                            strokeColor={item.color}
                            trailColor={C.bgTrack}
                            size="small"
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>

                {analytics.flapping_devices.length > 0 && (
                  <div className="tv-card">
                    <CardHead icon={<SwapOutlined />} title="Flap Yapan Cihazlar" color={N.amber}
                      extra={
                        <span style={{ background: `${N.amber}18`, color: N.amber, border: `1px solid ${N.amber}30`, borderRadius: 10, fontSize: 10, padding: '2px 8px' }}>
                          {analytics.flapping_devices.length}
                        </span>
                      }
                    />
                    {analytics.flapping_devices.map((d, i) => (
                      <div key={d.device_id} style={{
                        padding: '7px 18px',
                        borderBottom: i < analytics.flapping_devices.length - 1 ? `1px solid ${C.border}` : undefined,
                        display: 'flex', justifyContent: 'space-between',
                      }}>
                        <span style={{ color: C.text, fontSize: 12 }}>{d.hostname}</span>
                        <span style={{ color: N.amber, fontSize: 11, fontWeight: 700 }}>{d.flap_count}×/saat</span>
                      </div>
                    ))}
                  </div>
                )}
              </Col>

              {/* Agent health + changes */}
              <Col xs={24} md={12} lg={8}>
                <div className="tv-card" style={{ marginBottom: 12 }}>
                  <CardHead icon={<RobotOutlined />} title="Agent Sağlığı" color={N.blue} />
                  {analytics.agent_health.length === 0 ? (
                    <div style={{ padding: 16, color: C.dim, fontSize: 12 }}>Agent yok</div>
                  ) : analytics.agent_health.map((a) => (
                    <div key={a.id} style={{ padding: '10px 18px', borderBottom: `1px solid ${C.border}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ color: C.text, fontSize: 12, fontWeight: 500 }}>{a.name}</span>
                        <span style={{
                          fontSize: 10, padding: '1px 8px', borderRadius: 10,
                          background: a.status === 'online' ? `${N.green}18` : `${N.red}18`,
                          color: a.status === 'online' ? N.green : N.red,
                          border: `1px solid ${a.status === 'online' ? N.green : N.red}30`,
                        }}>{a.status}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 12 }}>
                        <span style={{ color: C.dim, fontSize: 11 }}>{a.assigned_devices} cihaz</span>
                        {a.last_heartbeat && (
                          <Tooltip title={dayjs(a.last_heartbeat).format('DD.MM HH:mm:ss')}>
                            <span style={{ color: a.warning ? N.amber : C.dim, fontSize: 11 }}>
                              ♥ {dayjs(a.last_heartbeat).fromNow()}
                            </span>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="tv-card">
                  <CardHead icon={<SyncOutlined />} title="Son 24s Değişiklikler" color={N.cyan} />
                  <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                    {analytics.change_summary.recent.length === 0 ? (
                      <div style={{ padding: 12, color: C.dim, fontSize: 12, textAlign: 'center' }}>Değişiklik yok</div>
                    ) : analytics.change_summary.recent.slice(0, 8).map((ch, i) => (
                      <div key={i} style={{ padding: '7px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ color: C.text, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                            <strong style={{ color: N.cyan }}>{ch.username}</strong>
                            <span style={{ color: C.muted }}> → {ch.action.replace(/_/g, ' ')}</span>
                          </span>
                          {ch.resource_name && <span style={{ color: C.dim, fontSize: 10 }}>{ch.resource_name}</span>}
                        </div>
                        <span style={{ color: C.dim, fontSize: 10, flexShrink: 0 }}>{dayjs(ch.created_at).fromNow()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Col>
            </Row>

            {/* Second intelligence row */}
            <Row gutter={[12, 12]}>
              {/* Firmware posture */}
              <Col xs={24} md={12} lg={8}>
                <div className="tv-card">
                  <CardHead icon={<ExperimentOutlined />} title="Firmware Dağılımı" color={N.purple} />
                  <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {analytics.firmware_posture.slice(0, 10).map((fw, i) => (
                      <div key={i} style={{ padding: '7px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ color: fw.firmware === 'Bilinmiyor' ? N.amber : C.text, fontSize: 12, fontWeight: 500 }}>{fw.firmware}</span>
                          <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
                            <Tag color="blue" style={{ fontSize: 10, margin: 0, background: `${N.blue}15`, borderColor: `${N.blue}30`, color: N.blue }}>{fw.vendor}</Tag>
                            {fw.hostnames.slice(0, 2).map(h => <Tag key={h} style={{ fontSize: 10, margin: 0, background: 'rgba(255,255,255,0.04)', borderColor: C.border, color: C.muted }}>{h}</Tag>)}
                          </div>
                        </div>
                        <span style={{ color: C.muted, fontSize: 11, flexShrink: 0 }}>{fw.count} cihaz</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Col>

              {/* Risk by location */}
              <Col xs={24} md={12} lg={8}>
                <div className="tv-card">
                  <CardHead icon={<WarningOutlined />} title="Lokasyon Risk Haritası" color={N.amber} />
                  <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                    {analytics.risk.by_location.length === 0 ? (
                      <div style={{ padding: 16, color: C.dim, fontSize: 12, textAlign: 'center' }}>Lokasyon verisi yok</div>
                    ) : analytics.risk.by_location.slice(0, 8).map((loc, i) => (
                      <div key={i} style={{ padding: '8px 18px', borderBottom: `1px solid ${C.border}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ color: C.text, fontSize: 12 }}>{loc.location}</span>
                          <span style={{
                            fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 700,
                            color: loc.score > 60 ? N.red : loc.score > 30 ? N.amber : N.green,
                            background: loc.score > 60 ? `${N.red}15` : loc.score > 30 ? `${N.amber}15` : `${N.green}15`,
                          }}>
                            Risk: {loc.score}
                          </span>
                        </div>
                        <div style={{ background: C.bgTrack, borderRadius: 3, height: 3, overflow: 'hidden', marginBottom: 4 }}>
                          <div style={{
                            background: loc.score > 60 ? N.red : loc.score > 30 ? N.amber : N.green,
                            width: `${loc.score}%`, height: '100%', borderRadius: 3,
                            boxShadow: `0 0 5px ${loc.score > 60 ? N.red : loc.score > 30 ? N.amber : N.green}50`,
                          }} />
                        </div>
                        <span style={{ color: C.dim, fontSize: 10 }}>{loc.total} cihaz · {loc.offline} offline · {loc.no_backup} backupsız</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Col>

              {/* Never seen */}
              <Col xs={24} md={12} lg={8}>
                <div className="tv-card" style={{ borderColor: analytics.never_seen.length > 0 ? `${N.red}30` : C.border }}>
                  <CardHead
                    icon={<EyeInvisibleOutlined />}
                    title="Uzun Süredir Görünmeyenler"
                    color={analytics.never_seen.length > 0 ? N.red : C.muted}
                    extra={analytics.never_seen.length > 0
                      ? <span style={{ background: `${N.red}18`, color: N.red, border: `1px solid ${N.red}30`, borderRadius: 10, fontSize: 10, padding: '2px 8px' }}>{analytics.never_seen.length}</span>
                      : undefined
                    }
                  />
                  {analytics.never_seen.length === 0 ? (
                    <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12 }}>
                      <CheckCircleOutlined style={{ display: 'block', marginBottom: 6, fontSize: 22, color: N.green }} />
                      Tüm cihazlar son 7 günde görüldü
                    </div>
                  ) : analytics.never_seen.slice(0, 7).map((d, i) => (
                    <div key={d.id} style={{ padding: '8px 18px', borderBottom: i < 6 ? `1px solid ${C.border}` : undefined, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ color: C.text, fontSize: 12, fontWeight: 500 }}>{d.hostname}</div>
                        <code style={{ fontSize: 10, color: C.dim }}>{d.ip}</code>
                      </div>
                      <span style={{ color: N.red, fontSize: 11, fontWeight: 600 }}>
                        {d.last_seen ? dayjs(d.last_seen).fromNow() : 'Hiç görülmedi'}
                      </span>
                    </div>
                  ))}
                </div>
              </Col>
            </Row>

            {/* Config drift */}
            {analytics.config_drift && analytics.config_drift.total_with_golden > 0 && (
              <div className="tv-card" style={{ borderColor: analytics.config_drift.drift_count > 0 ? `${N.amber}30` : `${N.green}20` }}>
                <div style={{ padding: '12px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <SafetyOutlined style={{ color: analytics.config_drift.drift_count > 0 ? N.amber : N.green }} />
                    <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>Config Drift Tespiti</span>
                    {analytics.config_drift.drift_count > 0
                      ? <span style={{ background: `${N.amber}18`, color: N.amber, border: `1px solid ${N.amber}30`, borderRadius: 4, fontSize: 11, padding: '2px 8px' }}>
                          {analytics.config_drift.drift_count} cihazda sapma
                        </span>
                      : <span style={{ background: `${N.green}18`, color: N.green, border: `1px solid ${N.green}30`, borderRadius: 4, fontSize: 11, padding: '2px 8px' }}>
                          Tüm baseline'lar eşleşiyor
                        </span>
                    }
                  </div>
                  <span style={{ color: C.muted, fontSize: 12 }}>
                    {analytics.config_drift.total_with_golden} cihaz · {analytics.config_drift.clean_count} temiz
                  </span>
                </div>
                {analytics.config_drift.drift_count > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 18px' }}>
                    {analytics.config_drift.drift_devices.map((d) => (
                      <Tag key={d.device_id} style={{ background: `${N.amber}15`, borderColor: `${N.amber}30`, color: N.amber, fontSize: 11 }}>
                        {d.hostname}
                      </Tag>
                    ))}
                    {analytics.config_drift.drift_count > analytics.config_drift.drift_devices.length && (
                      <Tag style={{ background: 'rgba(255,255,255,0.05)', borderColor: C.border, color: C.muted, fontSize: 11 }}>
                        +{analytics.config_drift.drift_count - analytics.config_drift.drift_devices.length} daha
                      </Tag>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ── SNMP / Bandwidth ─────────────────────────────────────────────────── */}
        {snmpSummary && snmpSummary.snmp_enabled > 0 && (
          <>
            <SectionBar icon={<DashboardOutlined />} title="Bant Genişliği & SNMP" />

            <Row gutter={[12, 12]}>
              {/* SNMP mini-cards */}
              <Col xs={24} lg={8}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[
                    {
                      label: 'SNMP Aktif Cihaz',
                      value: `${snmpSummary.snmp_enabled} / ${snmpSummary.total_devices}`,
                      color: N.cyan,
                      sub: snmpSummary.last_poll_at ? `Son poll: ${dayjs(snmpSummary.last_poll_at).fromNow()}` : 'Henüz poll yok',
                    },
                    {
                      label: 'Kritik Interface (>80%)',
                      value: snmpSummary.critical_interfaces,
                      color: snmpSummary.critical_interfaces > 0 ? N.red : N.green,
                      sub: `${snmpSummary.warning_interfaces} adet uyarı (>50%)`,
                    },
                    {
                      label: 'Toplam Trafik (24s)',
                      value: (() => {
                        const total = snmpSummary.total_in_bytes_24h + snmpSummary.total_out_bytes_24h
                        if (total >= 1e12) return `${(total / 1e12).toFixed(1)} TB`
                        if (total >= 1e9)  return `${(total / 1e9 ).toFixed(1)} GB`
                        if (total >= 1e6)  return `${(total / 1e6 ).toFixed(1)} MB`
                        return `${(total / 1e3).toFixed(0)} KB`
                      })(),
                      color: N.purple,
                      sub: (() => {
                        const i = snmpSummary.total_in_bytes_24h, o = snmpSummary.total_out_bytes_24h
                        const fmt = (b: number) => b >= 1e9 ? `${(b/1e9).toFixed(1)}G` : b >= 1e6 ? `${(b/1e6).toFixed(0)}M` : `${(b/1e3).toFixed(0)}K`
                        return `↓${fmt(i)} giriş  ↑${fmt(o)} çıkış`
                      })(),
                    },
                  ].map((item) => (
                    <div key={item.label} className="tv-card" style={{
                      padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
                      borderTop: `2px solid ${item.color}`,
                    }}>
                      <div style={{
                        width: 38, height: 38, borderRadius: 8, flexShrink: 0,
                        background: `${item.color}15`,
                        border: `1px solid ${item.color}25`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <DashboardOutlined style={{ color: item.color, fontSize: 17 }} />
                      </div>
                      <div>
                        <div style={{ color: C.muted, fontSize: 11 }}>{item.label}</div>
                        <div style={{ color: item.color, fontSize: 22, fontWeight: 800, fontFamily: 'monospace', lineHeight: 1.2, textShadow: `0 0 14px ${item.color}40` }}>
                          {item.value}
                        </div>
                        <div style={{ color: C.dim, fontSize: 11 }}>{item.sub}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </Col>

              {/* Top busy interfaces */}
              <Col xs={24} lg={8}>
                <div className="tv-card" style={{ height: '100%' }}>
                  <CardHead
                    icon={<BarChartOutlined />} title="En Yoğun Interfaceler"
                    color={N.blue}
                    extra={
                      <span onClick={() => navigate('/bandwidth')} style={{ color: N.cyan, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                        Tümü <RightOutlined />
                      </span>
                    }
                  />
                  {snmpSummary.top_interfaces.length === 0 ? (
                    <div style={{ padding: 20, textAlign: 'center', color: C.dim, fontSize: 12 }}>
                      <CheckCircleOutlined style={{ fontSize: 20, color: N.green, display: 'block', marginBottom: 6 }} />
                      Yüksek kullanım yok
                    </div>
                  ) : snmpSummary.top_interfaces.map((iface, i) => (
                    <div key={`${iface.device_id}-${iface.if_index}`} style={{ padding: '8px 18px', borderBottom: i < snmpSummary.top_interfaces.length - 1 ? `1px solid ${C.border}` : undefined }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ color: C.text, fontSize: 12, fontWeight: 500 }}>{iface.hostname}</span>
                          <span style={{ color: C.dim, fontSize: 11, marginLeft: 6 }}>{iface.if_name || `if${iface.if_index}`}</span>
                        </div>
                        <span style={{
                          fontSize: 11, padding: '2px 8px', borderRadius: 4, flexShrink: 0,
                          color: iface.max_pct >= 80 ? N.red : iface.max_pct >= 50 ? N.amber : N.green,
                          background: iface.max_pct >= 80 ? `${N.red}15` : iface.max_pct >= 50 ? `${N.amber}15` : `${N.green}15`,
                          fontWeight: 700,
                        }}>
                          {iface.max_pct}%
                        </span>
                      </div>
                      <div style={{ background: C.bgTrack, borderRadius: 3, height: 3, overflow: 'hidden', marginBottom: 2 }}>
                        <div style={{
                          background: iface.max_pct >= 80 ? N.red : iface.max_pct >= 50 ? N.amber : N.blue,
                          width: `${Math.min(iface.max_pct, 100)}%`, height: '100%', borderRadius: 3,
                          boxShadow: `0 0 5px ${iface.max_pct >= 80 ? N.red : N.blue}50`,
                        }} />
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <span style={{ color: C.dim, fontSize: 10 }}><ArrowDownOutlined /> {iface.in_pct}%</span>
                        <span style={{ color: C.dim, fontSize: 10 }}><ArrowUpOutlined /> {iface.out_pct}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Col>

              {/* Traffic chart */}
              <Col xs={24} lg={8}>
                <div className="tv-card" style={{ height: '100%' }}>
                  <CardHead icon={<BarChartOutlined />} title="Ortalama Kullanım — Son 24 Saat" color={N.purple} />
                  <div style={{ padding: '12px 8px 4px' }}>
                    {!snmpChart || snmpChart.points.length === 0 ? (
                      <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>
                        Henüz yeterli veri yok
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height={200}>
                        <AreaChart data={snmpChart.points} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                          <defs>
                            <linearGradient id="gradIn2" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%"  stopColor={N.blue}   stopOpacity={0.35} />
                              <stop offset="95%" stopColor={N.blue}   stopOpacity={0}    />
                            </linearGradient>
                            <linearGradient id="gradOut2" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%"  stopColor={N.purple} stopOpacity={0.35} />
                              <stop offset="95%" stopColor={N.purple} stopOpacity={0}    />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,195,255,0.06)" />
                          <XAxis dataKey="hour" tickFormatter={(v) => dayjs(v).format('HH:mm')} tick={{ fontSize: 10, fill: C.dim }} tickLine={false} axisLine={false} />
                          <YAxis tickFormatter={(v) => `${v}%`} tick={{ fontSize: 10, fill: C.dim }} tickLine={false} axisLine={false} domain={[0, 'auto']} />
                          <RTooltip
                            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.text }}
                            labelStyle={{ color: C.text }}
                            labelFormatter={(v) => dayjs(v).format('DD.MM HH:mm')}
                            formatter={(v, name) => [`${Number(v).toFixed(1)}%`, name === 'avg_in' ? 'Giriş' : 'Çıkış']}
                          />
                          <Legend formatter={(v) => v === 'avg_in' ? 'Giriş' : 'Çıkış'} wrapperStyle={{ fontSize: 11, color: C.muted }} />
                          <Area type="monotone" dataKey="avg_in"  stroke={N.blue}   fill="url(#gradIn2)"  strokeWidth={2} dot={false} />
                          <Area type="monotone" dataKey="avg_out" stroke={N.purple} fill="url(#gradOut2)" strokeWidth={2} dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
              </Col>
            </Row>
          </>
        )}

        {/* ── Asset lifecycle ──────────────────────────────────────────────────── */}
        {assetStats && (assetStats.expiring_30d > 0 || assetStats.expiring_90d > 0 || assetStats.expired > 0 || assetStats.eol_count > 0) && (
          <div className="tv-card" style={{ borderColor: `${N.amber}25` }}>
            <div style={{ padding: '12px 18px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CalendarOutlined style={{ color: N.amber }} />
                <span style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>Asset Lifecycle — Yaklaşan Garanti Bitişleri</span>
              </div>
              <span onClick={() => navigate('/asset-lifecycle')} style={{ color: N.cyan, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                Tümünü Gör <RightOutlined />
              </span>
            </div>
            <div style={{ padding: '10px 18px 14px' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {assetStats.expired     > 0 && <Tag style={{ background: `${N.red}15`,   color: N.red,   borderColor: `${N.red}30`,   fontSize: 12 }}>{assetStats.expired} süresi dolmuş</Tag>}
                {assetStats.expiring_30d > 0 && <Tag style={{ background: `${N.amber}15`, color: N.amber, borderColor: `${N.amber}30`, fontSize: 12 }}>{assetStats.expiring_30d} × 30g</Tag>}
                {assetStats.expiring_90d > 0 && <Tag style={{ background: `${N.amber}10`, color: N.amber, borderColor: `${N.amber}20`, fontSize: 12 }}>{assetStats.expiring_90d} × 90g</Tag>}
                {assetStats.eol_count   > 0 && <Tag style={{ background: `${N.red}10`,   color: N.red,   borderColor: `${N.red}20`,   fontSize: 12 }}>{assetStats.eol_count} EOL</Tag>}
              </div>
              {assetStats.upcoming_expirations?.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <tbody>
                    {assetStats.upcoming_expirations.slice(0, 8).map((e: any, i: number) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ padding: '5px 0', fontWeight: 600, color: C.text }}>{e.device_hostname}</td>
                        <td style={{ padding: '5px 8px' }}>
                          <Tag style={{
                            fontSize: 10, margin: 0,
                            background: e.type === 'EOL' ? `${N.red}15` : e.type === 'EOS' ? `${N.purple}15` : `${N.blue}15`,
                            borderColor: e.type === 'EOL' ? `${N.red}30` : e.type === 'EOS' ? `${N.purple}30` : `${N.blue}30`,
                            color: e.type === 'EOL' ? N.red : e.type === 'EOS' ? N.purple : N.blue,
                          }}>{e.type}</Tag>
                        </td>
                        <td style={{ padding: '5px 0', color: C.dim }}>{e.date}</td>
                        <td style={{ padding: '5px 0', textAlign: 'right' }}>
                          <Tag style={{
                            fontSize: 11, margin: 0,
                            background: e.days_left <= 7 ? `${N.red}15` : e.days_left <= 30 ? `${N.amber}15` : 'rgba(255,255,255,0.04)',
                            borderColor: e.days_left <= 7 ? `${N.red}30` : e.days_left <= 30 ? `${N.amber}30` : C.border,
                            color: e.days_left <= 7 ? N.red : e.days_left <= 30 ? N.amber : C.muted,
                          }}>{e.days_left} gün</Tag>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Bottom padding for TV display */}
        <div style={{ height: 16 }} />
      </div>
    </div>
    </DashCtx.Provider>
  )
}
