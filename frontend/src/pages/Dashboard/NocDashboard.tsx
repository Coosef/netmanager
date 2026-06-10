// NocDashboard — T8.4 NOC design dashboard (mockup `dashboard.jsx`).
// Real data on the design's nm-card / nm-grid widget system. The previous
// TV-style dashboard lives in git history (replaced by this).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CloseOutlined, HolderOutlined } from '@ant-design/icons'
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { monitorApi, type NetworkEvent } from '@/api/monitor'
import { tasksApi } from '@/api/tasks'
import { agentsApi } from '@/api/agents'
import { slaApi } from '@/api/sla'
import { intelligenceApi } from '@/api/intelligence'
import { servicesApi } from '@/api/services'
import { approvalsApi } from '@/api/approvals'
import { backupSchedulesApi } from '@/api/backupSchedules'
import { devicesApi } from '@/api/devices'
import { useEventStream } from '@/hooks/useEventStream'
import { useQueryClient } from '@tanstack/react-query'
import { useSite } from '@/contexts/SiteContext'
import { useCustomize, ALL_WIDGETS } from '@/contexts/CustomizeContext'
import { useAuthStore } from '@/store/auth'
import { useHasHydrated } from '@/hooks/useHasHydrated'
import CountUp from '@/components/CountUp'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { useTranslation, Trans } from 'react-i18next'

dayjs.extend(relativeTime)

// ── primitives ──────────────────────────────────────────────────────────────
function MiniSpark({ data, color = 'var(--accent)', w = 130, h = 36 }: { data: number[]; color?: string; w?: number; h?: number }) {
  if (!data || data.length < 2) return null
  const max = Math.max(...data, 1), min = Math.min(...data, 0)
  const span = max - min || 1
  const step = w / (data.length - 1)
  const pts = data.map((v, i) => `${i * step},${h - ((v - min) / span) * (h - 4) - 2}`).join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  )
}

function Kpi({ label, value, unit, delta, dir, status, spark, sparkColor, pulse, decimals }: {
  label: string; value: string | number; unit?: string; delta?: string
  dir?: 'up' | 'down' | 'flat'; status?: 'crit' | 'ok' | 'info'; spark?: number[]; sparkColor?: string
  pulse?: boolean
  decimals?: number  // CountUp ondalık (örn. SLA için 1)
}) {
  const accent = status === 'crit' ? 'var(--crit)' : status === 'ok' ? 'var(--ok)' : status === 'info' ? 'var(--info)' : 'var(--fg-0)'
  const isNum = typeof value === 'number'
  // T8.4 — status class'ı eklendi (CSS gradient bg + hover glow için).
  // 'pulse=true' ise crit-pulse ile birlikte güçlü halo animasyon.
  const statusClass = status === 'crit' ? 'crit' : status === 'ok' ? 'ok' : status === 'info' ? 'info' : ''
  return (
    <div className={`nm-kpi ${statusClass} ${pulse ? 'crit-pulse' : ''}`}
      style={{ borderTop: `2px solid ${accent}` }}>
      <div className="nm-kpi-label">{label}</div>
      <div className="nm-kpi-value" style={{ color: accent }}>
        {isNum
          ? <CountUp value={value as number} decimals={decimals} unit={unit} />
          : <>{value}{unit && <small>{unit}</small>}</>}
      </div>
      {delta && (
        <div className="nm-kpi-delta">
          {dir && <span className={`arrow ${dir}`}>{dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'}</span>}
          {delta}
        </div>
      )}
      {spark && spark.length > 1 && (
        <div className="nm-kpi-spark"><MiniSpark data={spark} color={sparkColor || accent} /></div>
      )}
    </div>
  )
}

function Card({ title, pill, children, span = 'span-4', onTitle }: {
  title: string; pill?: { label: string; kind?: string }; children: React.ReactNode; span?: string; onTitle?: () => void
}) {
  return (
    <div className={span}>
      {/* T8.4 — height:100% kaldırıldı; .nm-dashboard-grid içinde Card
          yüksekliği content'a göre belirlenir (CSS'te grid-auto-rows:
          min-content + .nm-card { height: auto }). Diğer grid'lerde
          height: 100% gerekirse override edilir. */}
      <div className="nm-card">
        <div className="nm-card-hd">
          <h3 onClick={onTitle} style={{ cursor: onTitle ? 'pointer' : undefined }}>
            {title}{pill && <span className={`nm-pill ${pill.kind || ''}`}>{pill.label}</span>}
          </h3>
        </div>
        <div className="nm-card-bd">{children}</div>
      </div>
    </div>
  )
}

function Donut({ value, label, color = 'var(--ok)' }: { value: number; label: string; color?: string }) {
  const r = 34, c = 2 * Math.PI * r, off = c - (value / 100) * c
  return (
    <div style={{ position: 'relative', width: 96, height: 96 }}>
      <svg width="96" height="96" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={r} fill="none" stroke="var(--bg-3)" strokeWidth="8" />
        <circle cx="48" cy="48" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 48 48)" />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>{Math.round(value)}%</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
        </div>
      </div>
    </div>
  )
}

const sevPill = (s: string) => (s === 'critical' ? 'crit' : s === 'warning' ? 'warn' : s === 'info' ? 'info' : 'ok')

// ── page ──────────────────────────────────────────────────────────────────
// Span per widget id — Dashboard grid (12 cols). Tutarlı görünüm için
// sabit map; user reorder etse de span'lar widget'a göre sabit.
const WIDGET_SPAN: Record<string, string> = {
  topo: 'span-5',
  events: 'span-4',
  services: 'span-3',
  worst: 'span-4',
  approvals: 'span-4',
  agents: 'span-4',
  risk: 'span-4',
  sla: 'span-4',
  anomalies: 'span-4',
  drift: 'span-4',
  probes: 'span-4',
  vendors: 'span-4',
  // T8.4 — full-width activity heatmap; 24 hücre yatay görünsün diye 12 kolon.
  activity: 'span-12',
}

export default function NocDashboard() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { t } = useTranslation()
  const { activeSite } = useSite()
  const { editMode, widgetHidden, widgetOrder, setWidgetOrder, toggleWidget, viewVariant } = useCustomize()
  const [liveEvents, setLiveEvents] = useState<NetworkEvent[]>([])
  // DASHBOARD-REFRESH-LOGOUT-HOTFIX (PR #41) + AUTH-PERSIST-HYDRATION-HOTFIX
  // (PR #47) — useEventStream WebSocket'i auth rehydrate edilmeden başlatma.
  // `hydrated` artık Zustand persist'in kendi flag'inden okunur.
  const hydrated = useHasHydrated()
  const token = useAuthStore((s) => s.token)
  const eventStreamEnabled = hydrated && !!token

  // Live polling: refetchInterval düşürüldü (30s → 10s on critical queries)
  // + refetchOnWindowFocus default true → kullanıcı sayfaya geri dönünce
  // hemen güncelliyor. Ayrıca aşağıdaki SSE subscriber'ı device_online/
  // device_offline event'lerinde monitor-stats'ı invalidate ediyor —
  // böylece polling beklemeden cihaz sayısı anında değişiyor.
  const { data: s } = useQuery({ queryKey: ['monitor-stats', activeSite], queryFn: () => monitorApi.getStats({ site: activeSite || undefined }), refetchInterval: 10000 })
  const { data: tasksData } = useQuery({ queryKey: ['tasks-recent'], queryFn: () => tasksApi.list({ limit: 6 }), refetchInterval: 10000 })
  const { data: agentsData } = useQuery({ queryKey: ['agents-list'], queryFn: agentsApi.list, refetchInterval: 10000 })
  const { data: slaFleet } = useQuery({ queryKey: ['sla-fleet-summary'], queryFn: () => slaApi.getFleetSummary(30), refetchInterval: 60000 })
  const { data: fleetRisk } = useQuery({ queryKey: ['fleet-risk'], queryFn: () => intelligenceApi.getFleetRisk(10), refetchInterval: 60000 })
  const { data: fleetImpact } = useQuery({ queryKey: ['fleet-impact-summary'], queryFn: servicesApi.getFleetImpact, refetchInterval: 30000 })
  const { data: anomalyData } = useQuery({ queryKey: ['behavior-anomalies'], queryFn: () => intelligenceApi.getAnomalies(24, 30), refetchInterval: 30000 })
  const { data: approvalCount } = useQuery({ queryKey: ['approval-pending-count'], queryFn: approvalsApi.pendingCount, refetchInterval: 15000 })
  const { data: driftReport } = useQuery({ queryKey: ['dashboard-drift'], queryFn: () => backupSchedulesApi.driftReport({ limit: 6 }), refetchInterval: 60000 })
  const { data: devicesData } = useQuery({ queryKey: ['dashboard-devices-vendors'], queryFn: () => devicesApi.list({ limit: 1000 }), refetchInterval: 60000 })

  useEventStream({
    enabled: eventStreamEnabled,
    onEvent: (ev: NetworkEvent) => {
      setLiveEvents((prev) => [ev, ...prev].slice(0, 30))
      // Cihaz durumu değişen event'lerde stat query'lerini hemen invalidate
      // → polling beklemeden ÇEVRİMİÇİ/ÇEVRİMDIŞI sayısı güncellenir.
      const type = ev.event_type
      if (type === 'device_offline' || type === 'device_online' || type === 'agent_outage'
          || type === 'agent_online' || type === 'agent_offline') {
        qc.invalidateQueries({ queryKey: ['monitor-stats'] })
        qc.invalidateQueries({ queryKey: ['agents-list'] })
      }
      if (type === 'config_drift' || type === 'backup_failure') {
        qc.invalidateQueries({ queryKey: ['dashboard-drift'] })
      }
      // Her event monitor-stats events_24h sayacını arttırır → sayaç da live.
      qc.invalidateQueries({ queryKey: ['monitor-stats'] })
    },
  })

  const now = useClock()
  const eventsTrend = useMemo(() => liveEvents.slice(0, 20).map((_, i) => i + 1), [liveEvents])

  const online = s?.devices.online ?? 0
  const offline = s?.devices.offline ?? 0
  const total = s?.devices.total ?? 0
  const events24h = s?.events_24h.total ?? 0
  const unacked = s?.events_24h.unacknowledged ?? 0
  const availPct = s?.fleet_availability_24h != null ? Math.round(s.fleet_availability_24h * 100) : null
  const expPct = s?.fleet_experience_score != null ? Math.round(s.fleet_experience_score * 100) : null

  const risk = fleetRisk as any
  const impact = fleetImpact as any
  const anom = anomalyData as any
  const agents = (agentsData as any[]) || []
  const sla = slaFleet as any
  const tasks = (tasksData as any)?.items || []

  // ── View variant dispatch ─────────────────────────────────────────────
  // Mockup'taki 3 layout: workspace (default modüler grid), mission (NOC
  // duvarı 3-col), editorial (günlük brief 3-col). Aynı queries kullanılır;
  // sadece görsel düzen farklı.
  if (viewVariant === 'mission') {
    return <MissionVariant ctx={{ navigate, online, offline, total, events24h, liveEvents,
      impact, risk, agents, sla, anom, approvalCount, driftReport, devicesData, tasks, now, t }} />
  }
  if (viewVariant === 'editorial') {
    return <EditorialVariant ctx={{ navigate, online, offline, total, events24h, liveEvents,
      impact, risk, agents, sla, anom, approvalCount, driftReport, devicesData, tasks, now, t }} />
  }

  // Default: workspace variant — mevcut nm-grid widget düzeni
  return (
    <div style={{ padding: 2 }} data-testid="dashboard-page">
      {/* live ticker — sürekli akan ticker (noc.css nm-tick animation),
          olay olduğunda kaydırır; yoksa sabit "olay yok" mesajı. */}
      <div className="nm-ticker">
        <div className="nm-ticker-label">
          <span className="nm-status-dot ok pulse"></span>
          {t('dashboard.ticker.label')}
        </div>
        <div className="nm-ticker-track" style={liveEvents.length === 0 ? { animation: 'none' } : undefined}>
          {liveEvents.length === 0 ? (
            <span className="nm-ticker-item"><span style={{ color: 'var(--fg-3)' }}>{t('dashboard.ticker.empty')}</span></span>
          ) : (
            <>
              {liveEvents.slice(0, 12).map((e, i) => (
                <span key={i} className="nm-ticker-item">
                  <span className="ts" style={{ color: 'var(--fg-3)' }}>{dayjs(e.created_at).format('HH:mm:ss')}</span>
                  <span className={`sev ${sevPill(e.severity)}`}>{(e.severity || '').toUpperCase()}</span>
                  <span className="host" style={{ color: 'var(--fg-1)' }}>{e.device_hostname || '—'}</span>
                  <span className="msg" style={{ color: 'var(--fg-2)' }}>{e.title}</span>
                </span>
              ))}
              {/* loop için ikinci kopya (translateX -50% nm-tick) */}
              {liveEvents.slice(0, 12).map((e, i) => (
                <span key={`dup-${i}`} className="nm-ticker-item">
                  <span className="ts" style={{ color: 'var(--fg-3)' }}>{dayjs(e.created_at).format('HH:mm:ss')}</span>
                  <span className={`sev ${sevPill(e.severity)}`}>{(e.severity || '').toUpperCase()}</span>
                  <span className="host" style={{ color: 'var(--fg-1)' }}>{e.device_hostname || '—'}</span>
                  <span className="msg" style={{ color: 'var(--fg-2)' }}>{e.title}</span>
                </span>
              ))}
            </>
          )}
        </div>
      </div>

      {/* KPI hero */}
      <div className="nm-hero">
        <Kpi label={t('dashboard.kpi.online')} value={online} unit={`/ ${total}`} status="ok"
          delta={t('dashboard.kpi.online_delta', { count: offline })} dir={offline > 0 ? 'down' : 'flat'}
          spark={eventsTrend} sparkColor="var(--ok)" />
        <Kpi label={t('dashboard.kpi.alert')} value={unacked} status={unacked > 0 ? 'crit' : 'ok'}
          delta={t('dashboard.kpi.alert_delta')} dir="flat" pulse={unacked > 0} />
        <Kpi label={t('dashboard.kpi.events_24h')} value={events24h} delta={t('dashboard.kpi.events_24h_delta')} dir="down"
          spark={eventsTrend} sparkColor="var(--accent)" />
        <Kpi label={t('dashboard.kpi.availability')} value={availPct ?? '—'} unit={availPct != null ? '%' : ''} status="ok"
          delta={t('dashboard.kpi.availability_delta')} dir="up" />
        <Kpi label={t('dashboard.kpi.experience')} value={expPct ?? '—'} unit={expPct != null ? '/100' : ''} status="info"
          delta={t('dashboard.kpi.experience_delta')} dir="up" />
      </div>

      {/* widget grid — data-driven, drag-drop edit mode */}
      <DashboardGrid
        editMode={editMode}
        order={widgetOrder}
        hidden={widgetHidden}
        setOrder={setWidgetOrder}
        toggleWidget={toggleWidget}
        render={(id) => renderWidget(id, {
          navigate, online, offline, total, events24h, liveEvents,
          impact, risk, agents, sla, anom, approvalCount, driftReport,
          devicesData, tasks, now, t,
        })}
      />
    </div>
  )
}

// ── Sortable widget grid ─────────────────────────────────────────────────
interface WidgetRenderCtx {
  navigate: (path: string) => void
  online: number; offline: number; total: number; events24h: number
  liveEvents: NetworkEvent[]
  impact: any; risk: any; agents: any[]; sla: any; anom: any
  approvalCount: any; driftReport: any; devicesData: any
  tasks: any[]; now: string
  t: (key: string, opts?: Record<string, unknown>) => string
}

function DashboardGrid({ editMode, order, hidden, setOrder, toggleWidget, render }: {
  editMode: boolean
  order: string[]
  hidden: string[]
  setOrder: (next: string[]) => void
  toggleWidget: (id: string) => void
  render: (id: string) => React.ReactNode
}) {
  const { t } = useTranslation()
  // ALL_WIDGETS dışı id'leri at, hidden'da olanları çıkar.
  const validIds = ALL_WIDGETS.map((w) => w.id)
  const visibleIds = order.filter((id) => validIds.includes(id) && !hidden.includes(id))

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = order.indexOf(String(active.id))
    const to = order.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    setOrder(arrayMove(order, from, to))
  }

  // T8.4 — VIEW mode: CSS multi-column masonry (kartlar boşluksuz akar).
  //         EDIT mode: sortable CSS Grid (dnd-kit absolute positioning ile
  //         column-flow uyumsuz olduğu için).
  if (editMode) {
    return (
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
          <div className="nm-grid cols-12 nm-dashboard-grid" style={{ gap: 'var(--gap)', marginTop: 'var(--gap)' }}>
            {visibleIds.map((id) => (
              <SortableWidget key={id} id={id} span={WIDGET_SPAN[id] || 'span-4'}
                editMode={editMode}
                onRemove={() => toggleWidget(id)}>
                {render(id)}
              </SortableWidget>
            ))}
            {visibleIds.length === 0 && (
              <div className="span-12" style={{
                padding: 48, textAlign: 'center', color: 'var(--fg-3)',
                border: '1px dashed var(--line)', borderRadius: 10,
              }}>
                {t('dashboard.empty_grid')}
              </div>
            )}
          </div>
        </SortableContext>
      </DndContext>
    )
  }
  // VIEW mode — Pinterest tarzı column masonry. Boş alanlar otomatik
  // kapanır; kartlar içeriğine göre yükseklik alır. span-12 (büyük)
  // kartlar tüm sütunları kaplar (column-span:all).
  return (
    <div className="nm-dashboard-masonry">
      {visibleIds.map((id) => {
        const fullWidth = (WIDGET_SPAN[id] || 'span-4') === 'span-12'
        return (
          <div key={id} className={`nm-masonry-item ${fullWidth ? 'span-full' : ''}`}>
            {render(id)}
          </div>
        )
      })}
      {visibleIds.length === 0 && (
        <div style={{
          padding: 48, textAlign: 'center', color: 'var(--fg-3)',
          border: '1px dashed var(--line)', borderRadius: 10,
        }}>
          Tüm widget'lar gizli. Özelleştir → Widget Görünürlüğü'nden seçim yap.
        </div>
      )}
    </div>
  )
}

// dnd-kit sortable wrapper — edit mode'da grip + × overlay gösterir.
function SortableWidget({ id, span, editMode, onRemove, children }: {
  id: string; span: string; editMode: boolean
  onRemove: () => void; children: React.ReactNode
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    cursor: editMode ? 'grab' : undefined,
  }
  return (
    <div ref={setNodeRef} className={span} style={style}>
      <div style={{ position: 'relative', height: '100%' }}>
        {editMode && (
          <>
            <button
              {...attributes} {...listeners}
              title={t('dashboard.widget_drag')}
              style={{
                position: 'absolute', top: 8, right: 36, zIndex: 5,
                width: 26, height: 26, borderRadius: 6,
                background: 'var(--accent)', color: '#000', border: 'none',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'grab', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              }}>
              <HolderOutlined />
            </button>
            <button onClick={onRemove} title={t('dashboard.widget_hide')}
              style={{
                position: 'absolute', top: 8, right: 8, zIndex: 5,
                width: 26, height: 26, borderRadius: 6,
                background: 'var(--crit)', color: '#fff', border: 'none',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              }}>
              <CloseOutlined />
            </button>
          </>
        )}
        {children}
      </div>
    </div>
  )
}

// Widget id → JSX render. Tüm queries parent'tan ctx ile geçiyor.
function renderWidget(id: string, ctx: WidgetRenderCtx): React.ReactNode {
  const { navigate, online, offline, total, events24h, liveEvents,
    impact, risk, agents, sla, anom, approvalCount, driftReport, devicesData, t } = ctx

  switch (id) {
    case 'topo':
      return (
        <Card title={t('dashboard.card.topo_title')} pill={{ label: t('dashboard.card.topo_pill_down', { count: offline }), kind: offline ? 'crit' : 'ok' }} span="span-12" onTitle={() => navigate('/topology-next')}>
          <TopoMini online={online} offline={offline} total={total} devices={devicesData?.items}
            onSelectDevice={(did) => navigate(`/devices/${did}`)} />
        </Card>
      )
    case 'activity':
      // T8.4 — 24h saat-bazında event yoğunluğu (heatmap strip)
      return (
        <Card title={t('dashboard.card.activity_title')} pill={{ label: t('dashboard.card.activity_pill') }} span="span-12" onTitle={() => navigate('/monitor')}>
          <ActivityHeatStrip liveEvents={liveEvents} events24h={events24h} />
        </Card>
      )
    case 'events':
      return (
        <Card title={t('dashboard.card.events_title')} pill={{ label: t('dashboard.card.events_pill', { count: events24h }), kind: 'accent' }} span="span-12" onTitle={() => navigate('/monitor')}>
          {liveEvents.length === 0 ? <Empty>{t('dashboard.ticker.empty')}</Empty> :
            liveEvents.slice(0, 7).map((e, i) => (
              // nm-fadein → yeni olay geldikçe yumuşak fade-in
              <div key={e.id || i} className="nm-row nm-fadein" style={{ gridTemplateColumns: 'auto auto 1fr auto' }}>
                <span className="mono" style={{ color: 'var(--fg-3)', fontSize: 10.5 }}>{dayjs(e.created_at).format('HH:mm:ss')}</span>
                <span className={`nm-pill ${sevPill(e.severity)}`}>{e.severity}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-0)' }}>{e.device_hostname || '—'}</span>
                  <span style={{ color: 'var(--fg-2)', marginLeft: 8, fontSize: 11.5 }}>{e.title}</span>
                </span>
                {/* Kritik açık olay → LED blink (sağda küçük yanıp sönen) */}
                {e.severity === 'critical' && !e.acknowledged && <span className="nm-led-crit" title="kritik" />}
              </div>
            ))}
        </Card>
      )
    case 'services':
      return (
        <Card title={t('dashboard.card.services_title')} pill={impact?.critical_count ? { label: t('dashboard.card.services_pill_critical', { count: impact.critical_count }), kind: 'crit' } : undefined} span="span-12" onTitle={() => navigate('/services')}>
          {!impact?.affected_services?.length ? <Empty>{t('dashboard.card.services_empty')}</Empty> :
            impact.affected_services.slice(0, 6).map((svc: any) => {
              const st = svc.impact_level === 'critical' ? 'crit' : svc.impact_level === 'high' ? 'warn' : svc.impact_level === 'medium' ? 'warn' : 'ok'
              return (
                <div key={svc.service_id} className="nm-row" style={{ gridTemplateColumns: 'auto 1fr auto auto' }}>
                  <span className="nm-pill" style={{ background: 'var(--bg-3)', color: 'var(--fg-1)' }}>{svc.priority || 'P?'}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="host" style={{ fontSize: 12 }}>{svc.service_name}</div>
                    <div className="ip">{t('dashboard.card.services_device_count', { count: svc.total_device_count })}</div>
                  </div>
                  {svc.impact_pct > 0 ? <span className={`nm-chip ${st}`}>{t('dashboard.card.services_impact_pct', { pct: svc.impact_pct })}</span> : <span className="nm-chip ok">{t('dashboard.card.services_stable')}</span>}
                  {/* Etkilenen servis → kırmızı pulse; stabil → yeşil pulse */}
                  <span className={`nm-status-dot ${svc.impact_pct > 0 ? `${st} pulse` : 'ok pulse'}`} />
                </div>
              )
            })}
        </Card>
      )
    case 'worst':
      return (
        <Card title={t('dashboard.card.worst_title')} pill={{ label: t('dashboard.card.worst_pill') }} span="span-12" onTitle={() => navigate('/intelligence')}>
          {!risk?.top_risky?.length ? <Empty>{t('dashboard.card.worst_empty')}</Empty> :
            risk.top_risky.slice(0, 5).map((d: any) => {
              const sc = Math.round(d.risk_score ?? 0)
              const cls = sc >= 80 ? 'crit' : sc >= 60 ? 'warn' : 'ok'
              return (
                <div key={d.hostname} className="nm-row" style={{ gridTemplateColumns: '1fr auto auto' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="host" style={{ fontSize: 12 }}>{d.hostname}</div>
                    <div className="ip">{d.ip_address || d.ip || ''} {d.vendor ? `· ${d.vendor}` : ''}</div>
                  </div>
                  <div className="nm-bar"><div style={{ width: `${sc}%`, background: `var(--${cls})` }} /></div>
                  <span className={`nm-pill ${cls}`}>{sc}</span>
                </div>
              )
            })}
        </Card>
      )
    case 'approvals':
      return (
        <Card title={t('dashboard.card.approvals_title')} pill={(approvalCount?.count ?? 0) > 0 ? { label: String(approvalCount?.count), kind: 'warn' } : undefined} span="span-12" onTitle={() => navigate('/approvals')}>
          {(approvalCount?.count ?? 0) === 0 ? <Empty>{t('dashboard.card.approvals_empty')}</Empty> : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 0' }}>
              <div className="mono" style={{ fontSize: 40, color: 'var(--warn)' }}>{approvalCount?.count}</div>
              <div style={{ color: 'var(--fg-2)', fontSize: 12 }}>{t('dashboard.card.approvals_caption')}</div>
              <button className="nm-pill warn" style={{ cursor: 'pointer', border: 'none' }} onClick={() => navigate('/approvals')}>{t('dashboard.card.approvals_button')}</button>
            </div>
          )}
        </Card>
      )
    case 'agents':
      return (
        <Card title={t('dashboard.card.agents_title')} pill={{ label: t('dashboard.card.agents_pill', { count: agents.filter((a: any) => a.status === 'online').length }), kind: 'ok' }} span="span-12" onTitle={() => navigate('/agents')}>
          {!agents.length ? <Empty>{t('dashboard.card.agents_empty')}</Empty> :
            agents.slice(0, 5).map((a: any) => (
              <div key={a.name || a.id} className="nm-row" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
                {/* Online status → pulse halo (canlı sinyal) */}
                <span className={`nm-status-dot ${a.status === 'online' ? 'ok pulse' : 'crit'}`} />
                <div style={{ minWidth: 0 }}>
                  <div className="host" style={{ fontSize: 12 }}>{a.name || a.hostname}</div>
                  <div className="ip">{t('dashboard.card.agents_device_count', { count: a.managed_device_count ?? a.device_count ?? 0 })}</div>
                </div>
                <span className={`nm-pill ${a.status === 'online' ? 'ok' : 'crit'}`}>{a.status}</span>
              </div>
            ))}
        </Card>
      )
    case 'risk':
      return (
        <Card title={t('dashboard.card.risk_title')} pill={{ label: t('dashboard.card.risk_pill', { count: risk?.summary?.total_devices ?? total }) }} span="span-12">
          <RiskDist summary={risk?.summary} />
        </Card>
      )
    case 'sla':
      return (
        <Card title={t('dashboard.card.sla_title')} pill={sla?.avg_uptime_pct >= 99 ? { label: t('dashboard.card.sla_pill_good'), kind: 'ok' } : undefined} span="span-12" onTitle={() => navigate('/sla')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 14, alignItems: 'center' }}>
            <Donut value={sla?.avg_uptime_pct ?? 0} label={t('dashboard.card.sla_donut_label')} color={(sla?.avg_uptime_pct ?? 0) >= 99 ? 'var(--ok)' : (sla?.avg_uptime_pct ?? 0) >= 95 ? 'var(--warn)' : 'var(--crit)'} />
            <div style={{ fontSize: 11, color: 'var(--fg-2)', lineHeight: 2 }}>
              <div>≥99%: <span className="mono" style={{ color: 'var(--ok)' }}>{sla?.above_99 ?? 0}</span></div>
              <div>95–99%: <span className="mono" style={{ color: 'var(--warn)' }}>{sla?.above_95 ?? 0}</span></div>
              <div>&lt;95%: <span className="mono" style={{ color: 'var(--crit)' }}>{sla?.below_95 ?? 0}</span></div>
            </div>
          </div>
        </Card>
      )
    case 'anomalies': {
      // T8.4 — kaynak fallback:
      //   1) anom.events varsa onları kullan (intelligence anomaly stream)
      //   2) yoksa risk.top_risky'den (risk skoruyla cihazlar) sıralı liste
      //   3) ikisi de yoksa empty state
      // Skor bar her satırda; öğeyi tıklayınca cihaz sayfasına gider.
      const fromAnom = (anom?.events || []).map((e: any) => ({
        kind: 'anomaly' as const,
        hostname: e.device_hostname || '—',
        device_id: e.device_id,
        label: e.anomaly_type || e.type || t('dashboard.card.anomalies_fallback_label'),
        detail: e.description || e.detail || '',
        score: Math.round(e.score ?? e.risk_score ?? 0),
        ago: e.detected_at ? dayjs(e.detected_at).fromNow(true) : '',
      }))
      const fromRisk = (risk?.top_risky || []).map((d: any) => ({
        kind: 'risk' as const,
        hostname: d.hostname,
        device_id: d.device_id ?? d.id,
        label: d.top_reason || t('dashboard.card.anomalies_fallback_risk'),
        detail: d.ip_address ? `${d.ip_address}${d.vendor ? ' · ' + d.vendor : ''}` : (d.vendor || ''),
        score: Math.round(d.risk_score ?? 0),
        ago: '',
      }))
      const items = fromAnom.length > 0 ? fromAnom : fromRisk
      const totalLabel = anom?.total ?? risk?.top_risky?.length ?? 0
      return (
        <Card title={t('dashboard.card.anomalies_title')}
          pill={totalLabel ? { label: `${totalLabel} ${fromAnom.length > 0 ? t('dashboard.card.anomalies_pill_anom') : t('dashboard.card.anomalies_pill_risk')}`, kind: 'warn' } : undefined}
          span="span-12"
          onTitle={() => navigate('/intelligence')}>
          {items.length === 0 ? <Empty>{t('dashboard.card.anomalies_empty')}</Empty> :
            items.slice(0, 5).map((it: any, i: number) => {
              const cls = it.score >= 80 ? 'crit' : it.score >= 60 ? 'warn' : it.score >= 40 ? 'info' : 'ok'
              return (
                <div key={i} className="nm-row" style={{ gridTemplateColumns: '1fr auto auto', cursor: it.device_id ? 'pointer' : 'default' }}
                  onClick={() => it.device_id && navigate(`/devices/${it.device_id}`)}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className={`nm-pill ${cls}`} style={{ fontSize: 9.5 }}>{it.label}</span>
                      <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.hostname}</span>
                    </div>
                    {it.detail && <div className="ip" style={{ marginTop: 2 }}>{it.detail}</div>}
                  </div>
                  {it.score > 0 ? (
                    <div className="nm-bar" style={{ width: 60 }}>
                      <div style={{ width: `${Math.min(100, it.score)}%`, background: `var(--${cls})` }} />
                    </div>
                  ) : <span />}
                  <span className="mono" style={{ fontSize: 10.5, color: `var(--${cls})`, fontWeight: 600, minWidth: 28, textAlign: 'right' }}>
                    {it.score > 0 ? it.score : (it.ago || '—')}
                  </span>
                </div>
              )
            })}
        </Card>
      )
    }
    case 'drift':
      return (
        <Card title={t('dashboard.card.drift_title')} pill={driftReport?.drift_count ? { label: t('dashboard.card.drift_pill_warn', { count: driftReport.drift_count }), kind: 'warn' } : { label: t('dashboard.card.drift_pill_ok'), kind: 'ok' }} span="span-12" onTitle={() => navigate('/config-drift')}>
          {!driftReport?.items?.length ? <Empty>{t('dashboard.card.drift_empty')}</Empty> :
            driftReport.items.slice(0, 5).map((r: any) => (
              <div key={r.device_id} className="nm-row" style={{ gridTemplateColumns: '1fr auto' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="host" style={{ fontSize: 12 }}>{r.hostname}</div>
                  <div className="ip">{r.ip || ''} {r.vendor ? `· ${r.vendor}` : ''}</div>
                </div>
                <span className={`nm-pill ${r.reason === 'no_backup' ? 'crit' : 'warn'}`}>
                  {r.reason === 'no_backup' ? t('dashboard.card.drift_no_backup') : t('dashboard.card.drift_changed')}
                </span>
              </div>
            ))}
        </Card>
      )
    case 'probes':
      // Probes endpoint yok; placeholder + sayfaya yönlendir
      return (
        <Card title={t('dashboard.card.probes_title')} pill={{ label: t('dashboard.card.probes_pill') }} span="span-12" onTitle={() => navigate('/synthetic-probes')}>
          <div style={{ padding: '14px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 8 }}>
              {t('dashboard.card.probes_caption')}
            </div>
            <button className="nm-pill accent" style={{ cursor: 'pointer', border: 'none' }} onClick={() => navigate('/synthetic-probes')}>
              {t('dashboard.card.probes_button')}
            </button>
          </div>
        </Card>
      )
    case 'vendors': {
      const items = (devicesData?.items as any[]) || []
      const vendors = items.reduce<Record<string, number>>((acc, d) => {
        const v = (d.vendor || t('dashboard.card.vendors_unknown')).toLowerCase()
        acc[v] = (acc[v] || 0) + 1
        return acc
      }, {})
      const sorted = Object.entries(vendors).sort((a, b) => b[1] - a[1]).slice(0, 6)
      const totalCount = items.length || 1
      return (
        <Card title={t('dashboard.card.vendors_title')} pill={{ label: t('dashboard.card.vendors_pill', { count: items.length }) }} span="span-12" onTitle={() => navigate('/devices')}>
          {sorted.length === 0 ? <Empty>{t('dashboard.card.vendors_empty')}</Empty> :
            sorted.map(([vendor, count]) => {
              const pct = Math.round((count / totalCount) * 100)
              return (
                <div key={vendor} className="nm-row" style={{ gridTemplateColumns: '1fr auto auto' }}>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--fg-1)', textTransform: 'capitalize' }}>{vendor}</span>
                  <div className="nm-bar"><div style={{ width: `${pct}%`, background: 'var(--accent)' }} /></div>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>{count} · {pct}%</span>
                </div>
              )
            })}
        </Card>
      )
    }
    default:
      return null
  }
}

// ── small helpers ───────────────────────────────────────────────────────────
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '18px 0', textAlign: 'center', color: 'var(--fg-3)', fontSize: 12 }}>{children}</div>
}

function useClock() {
  const [t, setT] = useState(() => dayjs().format('HH:mm:ss'))
  const ref = useRef<ReturnType<typeof setInterval>>()
  useEffect(() => {
    ref.current = setInterval(() => setT(dayjs().format('HH:mm:ss')), 1000)
    return () => clearInterval(ref.current)
  }, [])
  return t
}

function TopoMini({ online, offline, total, devices, onSelectDevice }: {
  online: number; offline: number; total: number
  devices?: any[]   // Device[] — varsa gerçek diagram; yoksa placeholder
  onSelectDevice?: (deviceId: number) => void  // T8.4 — node click → navigate
}) {
  const { t } = useTranslation()
  // T8.4 — eski 10x7 grid ("yeşil/kırmızı kutucuklar") yerine
  // network-topology-vari katmanlı SVG diagram:
  //   CORE  (2-3 node, üstte, kalın bağlantı)
  //   DIST  (4-6 node, ortada, distribution layer)
  //   ACCS  (8-12 node, altta, access switch'leri)
  // Cihazlar `layer` alanına göre kategorize (yoksa rol heuristic'i:
  // hostname'de "core/bb/back" → core, "dist/agg" → dist, diğer → access).
  // Status renkli node + offline'da pulse + SVG bağlantı çizgileri.
  const items = (devices || [])
  if (items.length === 0) {
    return (
      <div className="nm-topo" style={{ minHeight: 200 }}>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div className="mono" style={{ fontSize: 34, color: 'var(--accent)' }}>{total}</div>
            <div style={{ fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>
              {t('dashboard.topo.summary_short', { online, offline })}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Tier sınıflandırma — DB'de `layer` varsa onu kullan; yoksa hostname/role.
  const layerOf = (d: any): 'core' | 'dist' | 'access' => {
    const layer = String(d.layer || '').toLowerCase()
    if (layer === 'core' || layer === 'distribution' || layer === 'access') {
      return layer === 'distribution' ? 'dist' : layer as any
    }
    const host = String(d.hostname || '').toLowerCase()
    if (/^(core|bb|back|cr)/.test(host) || /(_|-)(core|bb)/.test(host)) return 'core'
    if (/^(dist|agg|dr)/.test(host) || /(_|-)(dist|agg)/.test(host)) return 'dist'
    return 'access'
  }
  const colorOf = (d: any): string => {
    const s = (d.status || '').toLowerCase()
    if (s === 'offline' || s === 'down') return 'var(--crit)'
    if (s === 'unreachable' || s === 'unknown') return 'var(--warn)'
    return 'var(--ok)'
  }
  const isDownN = (d: any) => {
    const s = (d.status || '').toLowerCase()
    return s === 'offline' || s === 'down'
  }

  const cores = items.filter((d) => layerOf(d) === 'core').slice(0, 3)
  const dists = items.filter((d) => layerOf(d) === 'dist').slice(0, 6)
  const access = items.filter((d) => layerOf(d) === 'access').slice(0, 14)
  // Eğer hiç core/dist yoksa (heuristic tutmadı) ilk 2'yi core, sonraki 4'ü
  // dist olarak göster — sayfanın boş görünmesini engelle.
  if (cores.length === 0 && dists.length === 0) {
    const head = items.slice(0, 2); const mid = items.slice(2, 6); const rest = items.slice(6, 20)
    cores.push(...head); dists.push(...mid); access.length = 0; access.push(...rest)
  }

  // SVG koordinatları — viewBox 600x220, 3 katman: y=40 / y=110 / y=180
  const W = 600, H = 220
  const layerY = { core: 38, dist: 110, access: 184 }
  const layout = (arr: any[], y: number) => arr.map((d, i) => ({
    d, x: ((i + 1) * W) / (arr.length + 1), y,
  }))
  const coreP = layout(cores, layerY.core)
  const distP = layout(dists, layerY.dist)
  const accessP = layout(access, layerY.access)

  // Bağlantılar — core ↔ dist tam mesh, dist ↔ access yakın eşleştirme
  const links: { x1: number; y1: number; x2: number; y2: number; down: boolean }[] = []
  for (const c of coreP) for (const d of distP) {
    links.push({ x1: c.x, y1: c.y, x2: d.x, y2: d.y,
      down: isDownN(c.d) || isDownN(d.d) })
  }
  // Her access'i en yakın dist'e bağla
  for (const a of accessP) {
    if (distP.length === 0) continue
    const nearest = distP.reduce((p, q) => Math.abs(q.x - a.x) < Math.abs(p.x - a.x) ? q : p)
    links.push({ x1: nearest.x, y1: nearest.y, x2: a.x, y2: a.y,
      down: isDownN(nearest.d) || isDownN(a.d) })
  }

  return (
    <div className="nm-topo" style={{ minHeight: 220, padding: 8, position: 'relative' }}>
      {/* Sol-üst özet */}
      <div style={{
        position: 'absolute', top: 8, left: 12, zIndex: 2,
        fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-3)',
        background: 'rgba(15,23,42,0.7)', padding: '2px 8px', borderRadius: 4,
      }}>
        {t('dashboard.topo.summary_long', { online, total, offline })}
      </div>
      {/* Sağ-üst layer count */}
      <div style={{
        position: 'absolute', top: 8, right: 12, zIndex: 2,
        fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)',
        background: 'rgba(15,23,42,0.7)', padding: '2px 8px', borderRadius: 4,
      }}>
        {t('dashboard.topo.layers_count', { cores: cores.length, dists: dists.length, access: access.length })}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', height: '100%', display: 'block', marginTop: 6 }}>
        {/* Tier guide lines */}
        {[layerY.core, layerY.dist, layerY.access].map((y) => (
          <line key={y} x1={0} y1={y} x2={W} y2={y}
            stroke="var(--line-soft)" strokeWidth="0.5" strokeDasharray="2 4" opacity="0.5" />
        ))}
        {/* Tier labels */}
        <text x={8} y={layerY.core - 12} fill="var(--fg-3)" fontSize="9" fontFamily="var(--font-mono)" letterSpacing="0.06em">{t('dashboard.topo.layer_core')}</text>
        <text x={8} y={layerY.dist - 12} fill="var(--fg-3)" fontSize="9" fontFamily="var(--font-mono)" letterSpacing="0.06em">{t('dashboard.topo.layer_dist')}</text>
        <text x={8} y={layerY.access - 12} fill="var(--fg-3)" fontSize="9" fontFamily="var(--font-mono)" letterSpacing="0.06em">{t('dashboard.topo.layer_access')}</text>

        {/* Links */}
        {links.map((l, i) => (
          <line key={i}
            x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke={l.down ? 'var(--crit)' : 'var(--accent)'}
            strokeWidth={l.down ? 1.4 : 0.9}
            opacity={l.down ? 0.7 : 0.35}
            strokeDasharray={l.down ? '4 3' : 'none'} />
        ))}

        {/* Nodes — render order: links arkada, sonra düğümler.
            T8.4 — node click → device sayfasına navigate (etkileşim). */}
        {[...coreP, ...distP, ...accessP].map(({ d, x, y }) => {
          const color = colorOf(d)
          const down = isDownN(d)
          const r = layerOf(d) === 'core' ? 9 : layerOf(d) === 'dist' ? 7 : 5
          const clickable = !!onSelectDevice && !!d.id
          return (
            <g key={d.id ?? d.hostname}
              style={{ cursor: clickable ? 'pointer' : 'default' }}
              onClick={() => { if (clickable && d.id) onSelectDevice(d.id) }}>
              <title>{`${d.hostname || '—'} (${d.status || '?'})${d.ip_address ? ' · ' + d.ip_address : ''}${clickable ? ' — ' + t('dashboard.topo.click_hint') : ''}`}</title>
              {/* Outer glow ring (sadece online/down ışıltısı için) */}
              {down ? (
                <circle cx={x} cy={y} r={r + 4} fill="none" stroke={color}
                  strokeWidth="1" opacity="0.5">
                  <animate attributeName="r" values={`${r + 2};${r + 7};${r + 2}`} dur="1.8s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.7;0;0.7" dur="1.8s" repeatCount="indefinite" />
                </circle>
              ) : (
                <circle cx={x} cy={y} r={r + 2} fill="none" stroke={color}
                  strokeWidth="0.6" opacity="0.4" />
              )}
              {/* Hover'da büyüyen hit-area + node */}
              <circle cx={x} cy={y} r={r + 6} fill="transparent" />
              <circle cx={x} cy={y} r={r}
                fill={color}
                stroke="var(--bg-1)" strokeWidth="1.5">
                {clickable && (
                  <>
                    <animate attributeName="r"
                      values={`${r};${r};${r}`}
                      keyTimes="0;0.99;1"
                      dur="0.001s" begin="mouseover"
                      fill="freeze" />
                  </>
                )}
              </circle>
            </g>
          )
        })}
      </svg>

      <div className="nm-legend" style={{ position: 'absolute', left: 12, bottom: 8 }}>
        <span><span className="dot" style={{ background: 'var(--ok)' }} />{t('dashboard.topo.legend_online')}</span>
        <span><span className="dot" style={{ background: 'var(--warn)' }} />{t('dashboard.topo.legend_unknown')}</span>
        <span><span className="dot" style={{ background: 'var(--crit)' }} />{t('dashboard.topo.legend_offline')}</span>
      </div>
    </div>
  )
}

// ── T8.4 — 24h Activity Heat Strip ──────────────────────────────────────────
// liveEvents (son 200 olay) saat-bazında group by; her saat = bir hücre.
// Severity ağırlık: critical=3, warning=2, info=1. Renk yoğunluğu intensity'ye
// göre (sessiz=koyu mavi → ateşli=kırmızı). 'O an' kolonu pulse.
function ActivityHeatStrip({ liveEvents, events24h }: { liveEvents: any[]; events24h: number }) {
  const { t } = useTranslation()
  const now = dayjs()
  // 24 saat × 1 saatlik kova. liveEvents son ~30 dakika veriyor olabilir
  // (refetchInterval=10s, polling penceresi), o yüzden tam saat dağılımı
  // her zaman dolmaz. Mevcut event'leri timestamp'a göre kovaya at.
  const buckets = Array(24).fill(0).map(() => ({ total: 0, crit: 0, warn: 0, info: 0 }))
  for (const e of liveEvents || []) {
    if (!e.created_at) continue
    const hoursAgo = now.diff(dayjs(e.created_at), 'hour')
    if (hoursAgo < 0 || hoursAgo > 23) continue
    const idx = 23 - hoursAgo  // 0 = 24sa önce, 23 = şimdi
    buckets[idx].total += 1
    const sev = (e.severity || '').toLowerCase()
    if (sev === 'critical') buckets[idx].crit += 1
    else if (sev === 'warning') buckets[idx].warn += 1
    else buckets[idx].info += 1
  }
  const maxTotal = Math.max(1, ...buckets.map(b => b.total))
  const cellColor = (b: { total: number; crit: number; warn: number }) => {
    if (b.total === 0) return 'var(--bg-3)'
    if (b.crit > 0) return 'var(--crit)'
    if (b.warn > 0) return 'var(--warn)'
    return 'var(--info)'
  }
  const cellAlpha = (b: { total: number }) => {
    if (b.total === 0) return 0.35
    return 0.4 + 0.6 * (b.total / maxTotal)
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 3, height: 36, alignItems: 'stretch' }}>
        {buckets.map((b, i) => {
          const isNow = i === 23
          const isCrit = b.crit > 0 && isNow
          return (
            <div key={i}
              title={t('dashboard.activity.cell_tooltip', { hours: 23 - i, total: b.total, crit: b.crit, warn: b.warn, info: b.info })}
              style={{
                flex: 1,
                background: cellColor(b),
                opacity: cellAlpha(b),
                borderRadius: 3,
                animation: isCrit ? 'nmKpiCritPulse 1.4s ease-in-out infinite' : isNow ? 'nm-pulse 2s ease-in-out infinite' : undefined,
                border: isNow ? '1px solid var(--accent)' : 'none',
                cursor: 'help',
              }} />
          )
        })}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-3)',
        marginTop: 6, letterSpacing: '0.06em',
      }}>
        <span>{t('dashboard.activity.axis_24h')}</span>
        <span>{t('dashboard.activity.axis_18h')}</span>
        <span>{t('dashboard.activity.axis_12h')}</span>
        <span>{t('dashboard.activity.axis_6h')}</span>
        <span style={{ color: 'var(--accent)' }}>{t('dashboard.activity.axis_now')}</span>
      </div>
      <div style={{
        marginTop: 10, display: 'flex', gap: 18, fontSize: 11, color: 'var(--fg-2)',
        alignItems: 'center',
      }}>
        <span><Trans i18nKey="dashboard.activity.events_24h_summary" values={{ count: events24h }} components={{ s: <strong style={{ color: 'var(--fg-0)' }} /> }} /></span>
        <span>·</span>
        <span><Trans i18nKey="dashboard.activity.peak_hour" values={{ count: maxTotal }} components={{ s: <strong style={{ color: 'var(--fg-1)' }} /> }} /></span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, background: 'var(--info)', borderRadius: 2 }} /> {t('dashboard.activity.legend_info')}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, background: 'var(--warn)', borderRadius: 2 }} /> {t('dashboard.activity.legend_warn')}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, background: 'var(--crit)', borderRadius: 2 }} /> {t('dashboard.activity.legend_crit')}
          </span>
        </span>
      </div>
    </div>
  )
}

function RiskDist({ summary }: { summary?: any }) {
  const { t } = useTranslation()
  const buckets = [
    { key: 'critical', label: t('dashboard.risk_dist.critical'), count: summary?.critical ?? 0, color: 'var(--crit)', range: '80-100' },
    { key: 'high', label: t('dashboard.risk_dist.high'), count: summary?.high ?? 0, color: 'var(--warn)', range: '60-79' },
    { key: 'medium', label: t('dashboard.risk_dist.medium'), count: summary?.medium ?? 0, color: 'var(--info)', range: '40-59' },
    { key: 'low', label: t('dashboard.risk_dist.low'), count: summary?.low ?? 0, color: 'var(--ok)', range: '0-39' },
  ]
  const tot = buckets.reduce((a, b) => a + b.count, 0)
  return (
    <div>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 12, background: 'var(--bg-3)' }}>
        {buckets.map((b) => <div key={b.key} style={{ flex: b.count || 0.01, background: b.color }} />)}
      </div>
      {buckets.map((b) => (
        <div key={b.key} className="nm-row" style={{ gridTemplateColumns: 'auto 1fr auto auto' }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: b.color, display: 'inline-block' }} />
          <span style={{ fontSize: 12 }}>{b.label}</span>
          <span className="mono" style={{ color: 'var(--fg-3)', fontSize: 10 }}>{b.range}</span>
          <span className="mono" style={{ color: 'var(--fg-0)', fontWeight: 500 }}>{b.count}</span>
        </div>
      ))}
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--fg-2)' }}>
        <span>{t('dashboard.risk_dist.total_label')}</span>
        <span className="mono" style={{ color: 'var(--fg-0)' }}>{t('dashboard.risk_dist.total_value', { count: tot })}</span>
      </div>
    </div>
  )
}

// ── Mission variant (NOC duvarı, 3-column) ─────────────────────────────
// Mockup VariantMission: sol vital signs + risk; orta strip + map + alt
// widget şeridi; sağ event rail. Sayfa flush (border'sız, full-bleed).
function MissionVariant({ ctx }: { ctx: WidgetRenderCtx }) {
  const { online, offline, total, events24h, liveEvents, anom, risk, sla, impact, t } = ctx
  const unacked = anom?.unacked ?? 0
  const critIncidents = impact?.critical_count ?? 0
  return (
    <div className="variant-mission" style={{ height: '100%' }} data-testid="dashboard-page">
      <div className="nm-mc-grid" style={{
        display: 'grid', gridTemplateColumns: '360px 1fr 320px', height: '100%', minHeight: 600,
      }}>
        {/* SOL: Vital signs */}
        <div style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ overflow: 'auto', flex: 1 }}>
            <VitalSign label={t('dashboard.mission.vital_online')} value={online} unit={`/ ${total}`}
              foot={<><span style={{ color: 'var(--ok)' }}>{t('dashboard.mission.vital_online_active', { count: online })}</span> · {t('dashboard.mission.vital_online_offline', { count: offline })}</>}
              kind="ok" />
            <VitalSign label={t('dashboard.mission.vital_incident')} value={critIncidents || 0}
              foot={<>{critIncidents > 0 ? <><span style={{ color: 'var(--crit)' }}>{t('dashboard.mission.vital_incident_open', { count: critIncidents })}</span> · {t('dashboard.mission.vital_incident_service_affected')}</> : t('dashboard.mission.vital_incident_none')}</>}
              kind={critIncidents > 0 ? 'crit' : 'ok'} />
            <VitalSign label={t('dashboard.mission.vital_events')} value={events24h}
              foot={<><span style={{ color: 'var(--fg-2)' }}>{t('dashboard.mission.vital_events_live')}</span> {t('dashboard.mission.vital_events_new', { count: liveEvents.length })}</>}
              kind="info" />
            <VitalSign label={t('dashboard.mission.vital_avail')} value={(sla?.avg_uptime_pct ?? 0).toFixed(1)} unit="%"
              foot={<><span style={{ color: (sla?.avg_uptime_pct ?? 0) >= 99 ? 'var(--ok)' : 'var(--warn)' }}>
                {t('dashboard.mission.vital_avail_target')}</span> {t('dashboard.mission.vital_avail_30d')}</>}
              kind={(sla?.avg_uptime_pct ?? 0) >= 99 ? 'ok' : 'warn'} />
            <div style={{ padding: '16px 18px', borderTop: '1px solid var(--line)' }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-2)',
                textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12,
              }}>{t('dashboard.mission.risk_section', { count: risk?.summary?.total_devices ?? total })}</div>
              <RiskDist summary={risk?.summary} />
            </div>
          </div>
        </div>

        {/* ORTA: Strip + Map + Alt widget şeridi */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <div className="nm-mc-strip">
            <div>
              <div className="nm-mc-strip-label">{t('dashboard.mission.strip_events')}</div>
              <div className="nm-mc-strip-val">{events24h}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>{t('dashboard.mission.strip_events_live', { count: liveEvents.length })}</div>
            </div>
            <div>
              <div className="nm-mc-strip-label">{t('dashboard.mission.strip_unacked')}</div>
              <div className="nm-mc-strip-val" style={{ color: unacked > 0 ? 'var(--crit)' : 'var(--ok)' }}>
                {unacked}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>{t('dashboard.mission.strip_unacked_caption')}</div>
            </div>
            <div>
              <div className="nm-mc-strip-label">{t('dashboard.mission.strip_sla')}</div>
              <div className="nm-mc-strip-val" style={{ color: (sla?.avg_uptime_pct ?? 0) >= 99 ? 'var(--ok)' : 'var(--warn)' }}>
                {(sla?.avg_uptime_pct ?? 0).toFixed(1)}<small style={{ fontSize: 11, color: 'var(--fg-3)' }}>%</small>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>{t('dashboard.mission.strip_sla_target')}</div>
            </div>
            <div>
              <div className="nm-mc-strip-label">{t('dashboard.mission.strip_service')}</div>
              <div className="nm-mc-strip-val">
                {impact ? `${(impact.total_services ?? 0) - (impact.critical_count ?? 0)}/${impact.total_services ?? 0}` : '—'}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: critIncidents > 0 ? 'var(--crit)' : 'var(--fg-3)', marginTop: 4 }}>
                {critIncidents > 0 ? t('dashboard.mission.strip_service_outage', { count: critIncidents }) : t('dashboard.mission.strip_service_stable')}
              </div>
            </div>
          </div>

          {/* Map yer tutucu — gerçek bir harita olmadığından TopoMini'yi büyüt */}
          <div style={{ flex: 1, position: 'relative', minHeight: 240, borderBottom: '1px solid var(--line)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <TopoMini online={online} offline={offline} total={total} />
          </div>

          {/* Alt widget şeridi: Drift / Approvals / Agents */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', borderTop: '1px solid var(--line)' }}>
            <MiniWidget title={t('dashboard.mission.mini_drift')} value={ctx.driftReport?.drift_count ?? 0}
              note={t('dashboard.mission.mini_drift_no_backup', { count: ctx.driftReport?.no_backup_count ?? 0 })}
              kind={ctx.driftReport?.drift_count ? 'warn' : 'ok'} />
            <MiniWidget title={t('dashboard.mission.mini_approvals')} value={ctx.approvalCount?.count ?? 0}
              note={t('dashboard.mission.mini_approvals_caption')}
              kind={(ctx.approvalCount?.count ?? 0) > 0 ? 'warn' : 'ok'} />
            <MiniWidget title={t('dashboard.mission.mini_agents')}
              value={`${ctx.agents.filter((a: any) => a.status === 'online').length}/${ctx.agents.length}`}
              note={t('dashboard.mission.mini_agents_caption')} kind="ok" />
          </div>
        </div>

        {/* SAĞ: Event rail */}
        <div style={{ borderLeft: '1px solid var(--line)', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-2)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              <span className="nm-status-dot ok pulse" style={{ marginRight: 6 }} />
              {t('dashboard.mission.rail_label', { count: liveEvents.length })}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
            {liveEvents.length === 0 ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--fg-3)', fontSize: 11 }}>
                {t('dashboard.mission.rail_empty')}
              </div>
            ) : liveEvents.slice(0, 30).map((e, i) => (
              <div key={e.id || i} className="nm-fadein"
                style={{ padding: '8px 10px', borderBottom: '1px solid var(--line-soft)', fontSize: 11 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="mono" style={{ color: 'var(--fg-3)', fontSize: 10 }}>{dayjs(e.created_at).format('HH:mm')}</span>
                  <span className={`nm-pill ${sevPill(e.severity)}`}>{e.severity}</span>
                  {e.severity === 'critical' && !e.acknowledged && <span className="nm-led-crit" />}
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--fg-1)', marginTop: 2 }}>{e.device_hostname || '—'}</div>
                <div style={{ fontSize: 11, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function VitalSign({ label, value, unit, foot, kind }:
  { label: string; value: string | number; unit?: string; foot?: React.ReactNode; kind?: 'ok' | 'warn' | 'crit' | 'info' }) {
  const color = kind === 'crit' ? 'var(--crit)' : kind === 'warn' ? 'var(--warn)' : kind === 'ok' ? 'var(--ok)' : kind === 'info' ? 'var(--info)' : 'var(--fg-0)'
  const isNum = typeof value === 'number'
  return (
    <div style={{ padding: '18px 18px 16px', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-2)',
        textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 44, fontWeight: 500, lineHeight: 1, color }}>
        {isNum
          ? <CountUp value={value as number} unit={unit} />
          : <>{value}{unit && <small style={{ fontSize: 16, color: 'var(--fg-3)' }}>{unit}</small>}</>}
      </div>
      {foot && <div style={{ fontSize: 11, color: 'var(--fg-2)', marginTop: 8 }}>{foot}</div>}
    </div>
  )
}

function MiniWidget({ title, value, note, kind }:
  { title: string; value: string | number; note: string; kind?: 'ok' | 'warn' | 'crit' }) {
  const color = kind === 'crit' ? 'var(--crit)' : kind === 'warn' ? 'var(--warn)' : kind === 'ok' ? 'var(--ok)' : 'var(--fg-0)'
  return (
    <div style={{ padding: '14px 16px', borderRight: '1px solid var(--line)' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-3)',
        textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 24, fontWeight: 500, color }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>{note}</div>
    </div>
  )
}

// ── Editorial variant (günlük brief) ───────────────────────────────────
// Mockup VariantEditorial: 3 sütun (kicker + headline + figures · numbers ·
// brief). Operasyonel özet metinleri gerçek veriden türetiliyor.
function EditorialVariant({ ctx }: { ctx: WidgetRenderCtx }) {
  const { online, offline, total, events24h, risk, sla, anom, impact, agents,
    approvalCount, driftReport, now, t } = ctx
  const expPct = ctx.risk?.summary?.experience_score ?? null
  const criticalEvents = anom?.total ?? 0
  const offlinePct = total > 0 ? Math.round((offline / total) * 100 * 10) / 10 : 0
  return (
    <div className="variant-editorial" style={{ height: '100%' }} data-testid="dashboard-page">
      <div className="nm-edit-wrap" style={{
        display: 'grid', gridTemplateColumns: '1fr 1px 1fr 1px 1fr', gap: 24,
        padding: '28px 32px', height: '100%', overflow: 'auto', alignItems: 'start',
      }}>
        {/* SOL: Operasyonel anlatı */}
        <div className="nm-edit-col">
          <div className="nm-edit-kicker">{t('dashboard.editorial.kicker_status', { now })}</div>
          <div className="nm-edit-headline" style={{ fontSize: 26, fontWeight: 500, lineHeight: 1.2, margin: '12px 0 20px' }}>
            {offline === 0
              ? t('dashboard.editorial.headline_stable')
              : offline <= 3
              ? t('dashboard.editorial.headline_few')
              : t('dashboard.editorial.headline_many')}
          </div>
          <div className="nm-edit-deck" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em', marginTop: 14 }}>
            {t('dashboard.editorial.deck_offline')}
          </div>
          <div className={`nm-edit-bigfig ${offline > 0 ? 'crit' : 'ok'}`}
            style={{ fontSize: 92, fontWeight: 500, color: offline > 0 ? 'var(--crit)' : 'var(--ok)', lineHeight: 1, fontFamily: 'var(--font-mono)' }}>
            {offline}<small style={{ fontSize: 18, color: 'var(--fg-3)' }}>/ {total}</small>
          </div>
          <div className="nm-edit-body" style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.6, margin: '12px 0 20px' }}>
            <Trans i18nKey="dashboard.editorial.body_active" values={{ online, fill: (100 - offlinePct).toFixed(1) }} components={{ s: <strong /> }} />
            {(impact?.critical_count ?? 0) > 0 && <> <Trans i18nKey="dashboard.editorial.body_critical" values={{ count: impact.critical_count }} components={{ s: <strong style={{ color: 'var(--crit)' }} /> }} /></>}
            {' '}<Trans i18nKey="dashboard.editorial.body_events" values={{ count: events24h }} components={{ s: <strong /> }} />
          </div>
          <div className="nm-edit-deck" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
            {t('dashboard.editorial.deck_24h')}
          </div>
          <div className="nm-edit-bigfig" style={{ fontSize: 72, fontWeight: 500, color: 'var(--fg-0)', lineHeight: 1, fontFamily: 'var(--font-mono)' }}>
            {events24h}<small style={{ fontSize: 14, color: 'var(--fg-3)' }}>{t('dashboard.editorial.bigfig_olay')}</small>
          </div>
          <div className="nm-edit-meta" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--fg-3)', marginTop: 20, fontFamily: 'var(--font-mono)' }}>
            <span>{t('dashboard.editorial.meta_summary')}</span><span>·</span><span>Charon Intelligence</span>
            <span style={{ marginLeft: 'auto' }}>{t('dashboard.editorial.meta_live')}</span>
          </div>
        </div>

        <div className="nm-edit-rule" style={{ background: 'var(--line)', height: '100%' }}></div>

        {/* ORTA: Rakamlar */}
        <div className="nm-edit-col">
          <div className="nm-edit-kicker">{t('dashboard.editorial.kicker_numbers')}</div>
          <EditStat label={t('dashboard.editorial.stat_incident')} value={impact?.critical_count ?? 0}
            note={(impact?.critical_count ?? 0) > 0
              ? t('dashboard.editorial.stat_incident_open', { count: impact.critical_count, name: impact?.affected_services?.[0]?.service_name || '—' })
              : t('dashboard.editorial.stat_incident_none')} />
          <EditStat label={t('dashboard.editorial.stat_avail')} value={(sla?.avg_uptime_pct ?? 0).toFixed(1)} unit="%"
            note={t('dashboard.editorial.stat_avail_note', { state: (sla?.avg_uptime_pct ?? 0) >= 99 ? t('dashboard.editorial.stat_avail_above') : t('dashboard.editorial.stat_avail_below'), hostname: sla?.worst_devices?.[0]?.hostname || '—', pct: sla?.worst_devices?.[0]?.uptime_pct?.toFixed(1) || '—' })} />
          <EditStat label={t('dashboard.editorial.stat_experience')} value={expPct != null ? Math.round(expPct * 100) : '—'} unit={expPct != null ? '/100' : ''}
            note={t('dashboard.editorial.stat_experience_note')} />
          <EditStat label={t('dashboard.editorial.stat_risk')} value={(risk?.summary?.high ?? 0) + (risk?.summary?.critical ?? 0)}
            note={t('dashboard.editorial.stat_risk_note', { critical: risk?.summary?.critical ?? 0, high: risk?.summary?.high ?? 0, hostname: risk?.top_risky?.[0]?.hostname || '—' })} />
          <EditStat label={t('dashboard.editorial.stat_anomaly')} value={criticalEvents}
            note={criticalEvents > 0 ? t('dashboard.editorial.stat_anomaly_with') : t('dashboard.editorial.stat_anomaly_none')} />
        </div>

        <div className="nm-edit-rule" style={{ background: 'var(--line)', height: '100%' }}></div>

        {/* SAĞ: Brief */}
        <div className="nm-edit-col">
          <div className="nm-edit-kicker">{t('dashboard.editorial.kicker_brief')}</div>
          <div style={{ marginBottom: 22 }}>
            <div className="nm-edit-deck" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 10 }}>
              {t('dashboard.editorial.brief_service_status')}
            </div>
            {!impact?.affected_services?.length ? (
              <div style={{ fontSize: 12, color: 'var(--fg-2)', padding: '14px 16px', border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
                {t('dashboard.editorial.brief_service_none')}
              </div>
            ) : (
              <div style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
                {impact.affected_services.slice(0, 4).map((svc: any) => (
                  <div key={svc.service_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--line-soft)' }}>
                    <span className={`nm-status-dot ${svc.impact_pct > 0 ? 'crit pulse' : 'ok pulse'}`} />
                    <div style={{ flex: 1, fontSize: 12 }}>{svc.service_name}</div>
                    <span className="mono" style={{ fontSize: 11, color: svc.impact_pct > 0 ? 'var(--crit)' : 'var(--ok)' }}>
                      {svc.impact_pct > 0 ? t('dashboard.editorial.brief_service_impact', { pct: svc.impact_pct }) : t('dashboard.editorial.brief_service_stable')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ marginBottom: 22 }}>
            <div className="nm-edit-deck" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 10 }}>
              {t('dashboard.editorial.brief_attention')}
            </div>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: 'var(--fg-1)' }}>
              {(risk?.top_risky?.[0]) && (
                <li><Trans i18nKey="dashboard.editorial.brief_attention_risk" values={{ hostname: risk.top_risky[0].hostname, score: Math.round(risk.top_risky[0].risk_score ?? 0) }} components={{ s: <strong style={{ color: 'var(--fg-0)' }} /> }} /></li>
              )}
              {(impact?.affected_services?.[0]) && impact.affected_services[0].impact_pct > 0 && (
                <li><Trans i18nKey="dashboard.editorial.brief_attention_service" values={{ name: impact.affected_services[0].service_name, pct: impact.affected_services[0].impact_pct }} components={{ s: <strong style={{ color: 'var(--fg-0)' }} /> }} /></li>
              )}
              {(approvalCount?.count ?? 0) > 0 && (
                <li><Trans i18nKey="dashboard.editorial.brief_attention_approvals" values={{ count: approvalCount.count }} components={{ s: <strong style={{ color: 'var(--fg-0)' }} /> }} /></li>
              )}
              {(driftReport?.drift_count ?? 0) > 0 && (
                <li><Trans i18nKey="dashboard.editorial.brief_attention_drift" values={{ count: driftReport.drift_count }} components={{ s: <strong style={{ color: 'var(--fg-0)' }} /> }} /></li>
              )}
              {(agents.filter((a: any) => a.status !== 'online').length > 0) && (
                <li><Trans i18nKey="dashboard.editorial.brief_attention_agents" values={{ count: agents.filter((a: any) => a.status !== 'online').length }} components={{ s: <strong style={{ color: 'var(--fg-0)' }} /> }} /></li>
              )}
              {/* Hiçbir madde yoksa */}
              {(risk?.top_risky?.length ?? 0) === 0 &&
                (impact?.affected_services?.[0]?.impact_pct ?? 0) === 0 &&
                (approvalCount?.count ?? 0) === 0 &&
                (driftReport?.drift_count ?? 0) === 0 && (
                <li style={{ color: 'var(--fg-3)' }}>{t('dashboard.editorial.brief_attention_none')}</li>
              )}
            </ol>
          </div>
          <div>
            <div className="nm-edit-deck" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 10 }}>
              {t('dashboard.editorial.brief_summary')}
            </div>
            <div style={{ display: 'flex', gap: 18, fontSize: 12, color: 'var(--fg-2)' }}>
              <div><strong style={{ color: 'var(--ok)' }}>{online}</strong> {t('dashboard.editorial.summary_online')}</div>
              <div><strong style={{ color: offline > 0 ? 'var(--crit)' : 'var(--fg-0)' }}>{offline}</strong> {t('dashboard.editorial.summary_offline')}</div>
              <div><strong style={{ color: 'var(--fg-0)' }}>{total}</strong> {t('dashboard.editorial.summary_total')}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function EditStat({ label, value, unit, note }:
  { label: string; value: string | number; unit?: string; note: string }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)',
        textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 48, fontWeight: 500, color: 'var(--fg-0)', lineHeight: 1, fontFamily: 'var(--font-mono)' }}>
        {value}{unit && <small style={{ fontSize: 13, color: 'var(--fg-3)' }}>{unit}</small>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.55, marginTop: 8 }}>{note}</div>
    </div>
  )
}
