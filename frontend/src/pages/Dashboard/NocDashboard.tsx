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
import { useSite } from '@/contexts/SiteContext'
import { useCustomize, ALL_WIDGETS } from '@/contexts/CustomizeContext'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

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

function Kpi({ label, value, unit, delta, dir, status, spark, sparkColor, pulse }: {
  label: string; value: string | number; unit?: string; delta?: string
  dir?: 'up' | 'down' | 'flat'; status?: 'crit' | 'ok' | 'info'; spark?: number[]; sparkColor?: string
  pulse?: boolean  // kritik durumda kart kenarı pulse animasyonu
}) {
  const accent = status === 'crit' ? 'var(--crit)' : status === 'ok' ? 'var(--ok)' : status === 'info' ? 'var(--info)' : 'var(--fg-0)'
  return (
    <div className={`nm-kpi ${pulse ? 'crit-pulse' : ''}`}
      style={{ borderTop: `2px solid ${accent}` }}>
      <div className="nm-kpi-label">{label}</div>
      <div className="nm-kpi-value" style={{ color: accent }}>
        {value}{unit && <small>{unit}</small>}
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
      <div className="nm-card" style={{ height: '100%' }}>
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
}

export default function NocDashboard() {
  const navigate = useNavigate()
  const { activeSite } = useSite()
  const { editMode, widgetHidden, widgetOrder, setWidgetOrder, toggleWidget, viewVariant } = useCustomize()
  const [liveEvents, setLiveEvents] = useState<NetworkEvent[]>([])

  const { data: s } = useQuery({ queryKey: ['monitor-stats', activeSite], queryFn: () => monitorApi.getStats({ site: activeSite || undefined }), refetchInterval: 30000 })
  const { data: tasksData } = useQuery({ queryKey: ['tasks-recent'], queryFn: () => tasksApi.list({ limit: 6 }), refetchInterval: 15000 })
  const { data: agentsData } = useQuery({ queryKey: ['agents-list'], queryFn: agentsApi.list, refetchInterval: 30000 })
  const { data: slaFleet } = useQuery({ queryKey: ['sla-fleet-summary'], queryFn: () => slaApi.getFleetSummary(30), refetchInterval: 300000 })
  const { data: fleetRisk } = useQuery({ queryKey: ['fleet-risk'], queryFn: () => intelligenceApi.getFleetRisk(10), refetchInterval: 300000 })
  const { data: fleetImpact } = useQuery({ queryKey: ['fleet-impact-summary'], queryFn: servicesApi.getFleetImpact, refetchInterval: 120000 })
  const { data: anomalyData } = useQuery({ queryKey: ['behavior-anomalies'], queryFn: () => intelligenceApi.getAnomalies(24, 30), refetchInterval: 120000 })
  const { data: approvalCount } = useQuery({ queryKey: ['approval-pending-count'], queryFn: approvalsApi.pendingCount, refetchInterval: 30000 })
  // Drift / probes / vendors — yeni widget'lar için
  const { data: driftReport } = useQuery({ queryKey: ['dashboard-drift'], queryFn: () => backupSchedulesApi.driftReport({ limit: 6 }), refetchInterval: 300000 })
  const { data: devicesData } = useQuery({ queryKey: ['dashboard-devices-vendors'], queryFn: () => devicesApi.list({ limit: 1000 }), refetchInterval: 120000 })

  useEventStream({
    onEvent: (ev: NetworkEvent) => setLiveEvents((prev) => [ev, ...prev].slice(0, 30)),
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
      impact, risk, agents, sla, anom, approvalCount, driftReport, devicesData, tasks, now }} />
  }
  if (viewVariant === 'editorial') {
    return <EditorialVariant ctx={{ navigate, online, offline, total, events24h, liveEvents,
      impact, risk, agents, sla, anom, approvalCount, driftReport, devicesData, tasks, now }} />
  }

  // Default: workspace variant — mevcut nm-grid widget düzeni
  return (
    <div style={{ padding: 2 }}>
      {/* live ticker — sürekli akan ticker (noc.css nm-tick animation),
          olay olduğunda kaydırır; yoksa sabit "olay yok" mesajı. */}
      <div className="nm-ticker">
        <div className="nm-ticker-label">
          <span className="nm-status-dot ok pulse"></span>
          CANLI AKIŞ
        </div>
        <div className="nm-ticker-track" style={liveEvents.length === 0 ? { animation: 'none' } : undefined}>
          {liveEvents.length === 0 ? (
            <span className="nm-ticker-item"><span style={{ color: 'var(--fg-3)' }}>Son 30 dakikada olay yok</span></span>
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
        <Kpi label="ÇEVRİMİÇİ" value={online} unit={`/ ${total}`} status="ok"
          delta={`${offline} çevrimdışı`} dir={offline > 0 ? 'down' : 'flat'}
          spark={eventsTrend} sparkColor="var(--ok)" />
        <Kpi label="AKTİF UYARI" value={unacked} status={unacked > 0 ? 'crit' : 'ok'}
          delta="onaylanmamış" dir="flat" pulse={unacked > 0} />
        <Kpi label="24SA OLAY" value={events24h} delta="son 24 saat" dir="down"
          spark={eventsTrend} sparkColor="var(--accent)" />
        <Kpi label="AVAILABILITY" value={availPct ?? '—'} unit={availPct != null ? '%' : ''} status="ok"
          delta="24h ort. uptime" dir="up" />
        <Kpi label="EXPERIENCE" value={expPct ?? '—'} unit={expPct != null ? '/100' : ''} status="info"
          delta="deneyim skoru" dir="up" />
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
          devicesData, tasks, now,
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
}

function DashboardGrid({ editMode, order, hidden, setOrder, toggleWidget, render }: {
  editMode: boolean
  order: string[]
  hidden: string[]
  setOrder: (next: string[]) => void
  toggleWidget: (id: string) => void
  render: (id: string) => React.ReactNode
}) {
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

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
        <div className="nm-grid cols-12" style={{ gap: 'var(--gap)', marginTop: 'var(--gap)' }}>
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
              Tüm widget'lar gizli. Özelleştir → Widget Görünürlüğü'nden seçim yap.
            </div>
          )}
        </div>
      </SortableContext>
    </DndContext>
  )
}

// dnd-kit sortable wrapper — edit mode'da grip + × overlay gösterir.
function SortableWidget({ id, span, editMode, onRemove, children }: {
  id: string; span: string; editMode: boolean
  onRemove: () => void; children: React.ReactNode
}) {
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
              title="Sürükle"
              style={{
                position: 'absolute', top: 8, right: 36, zIndex: 5,
                width: 26, height: 26, borderRadius: 6,
                background: 'var(--accent)', color: '#000', border: 'none',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'grab', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              }}>
              <HolderOutlined />
            </button>
            <button onClick={onRemove} title="Gizle"
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
    impact, risk, agents, sla, anom, approvalCount, driftReport, devicesData } = ctx

  switch (id) {
    case 'topo':
      return (
        <Card title="Topoloji Önizleme" pill={{ label: `${offline} down`, kind: offline ? 'crit' : 'ok' }} span="span-12" onTitle={() => navigate('/topology-next')}>
          <TopoMini online={online} offline={offline} total={total} />
        </Card>
      )
    case 'events':
      return (
        <Card title="Olay Akışı" pill={{ label: `24sa · ${events24h}`, kind: 'accent' }} span="span-12" onTitle={() => navigate('/monitor')}>
          {liveEvents.length === 0 ? <Empty>Son 30 dakikada olay yok</Empty> :
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
        <Card title="Servis Etkisi" pill={impact?.critical_count ? { label: `${impact.critical_count} kesinti`, kind: 'crit' } : undefined} span="span-12" onTitle={() => navigate('/services')}>
          {!impact?.affected_services?.length ? <Empty>Etkilenen servis yok</Empty> :
            impact.affected_services.slice(0, 6).map((svc: any) => {
              const st = svc.impact_level === 'critical' ? 'crit' : svc.impact_level === 'high' ? 'warn' : svc.impact_level === 'medium' ? 'warn' : 'ok'
              return (
                <div key={svc.service_id} className="nm-row" style={{ gridTemplateColumns: 'auto 1fr auto auto' }}>
                  <span className="nm-pill" style={{ background: 'var(--bg-3)', color: 'var(--fg-1)' }}>{svc.priority || 'P?'}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="host" style={{ fontSize: 12 }}>{svc.service_name}</div>
                    <div className="ip">{svc.total_device_count} cihaz</div>
                  </div>
                  {svc.impact_pct > 0 ? <span className={`nm-chip ${st}`}>{svc.impact_pct}% etki</span> : <span className="nm-chip ok">stabil</span>}
                  {/* Etkilenen servis → kırmızı pulse; stabil → yeşil pulse */}
                  <span className={`nm-status-dot ${svc.impact_pct > 0 ? `${st} pulse` : 'ok pulse'}`} />
                </div>
              )
            })}
        </Card>
      )
    case 'worst':
      return (
        <Card title="En Sorunlu Cihazlar" pill={{ label: 'son 7g' }} span="span-12" onTitle={() => navigate('/intelligence')}>
          {!risk?.top_risky?.length ? <Empty>Risk verisi yok</Empty> :
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
        <Card title="Onay Bekleyenler" pill={(approvalCount?.count ?? 0) > 0 ? { label: String(approvalCount?.count), kind: 'warn' } : undefined} span="span-12" onTitle={() => navigate('/approvals')}>
          {(approvalCount?.count ?? 0) === 0 ? <Empty>Bekleyen onay yok</Empty> : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 0' }}>
              <div className="mono" style={{ fontSize: 40, color: 'var(--warn)' }}>{approvalCount?.count}</div>
              <div style={{ color: 'var(--fg-2)', fontSize: 12 }}>komut onayı bekliyor</div>
              <button className="nm-pill warn" style={{ cursor: 'pointer', border: 'none' }} onClick={() => navigate('/approvals')}>İncele →</button>
            </div>
          )}
        </Card>
      )
    case 'agents':
      return (
        <Card title="Agent Filosu" pill={{ label: `${agents.filter((a: any) => a.status === 'online').length} online`, kind: 'ok' }} span="span-12" onTitle={() => navigate('/agents')}>
          {!agents.length ? <Empty>Agent yok</Empty> :
            agents.slice(0, 5).map((a: any) => (
              <div key={a.name || a.id} className="nm-row" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
                {/* Online status → pulse halo (canlı sinyal) */}
                <span className={`nm-status-dot ${a.status === 'online' ? 'ok pulse' : 'crit'}`} />
                <div style={{ minWidth: 0 }}>
                  <div className="host" style={{ fontSize: 12 }}>{a.name || a.hostname}</div>
                  <div className="ip">{a.managed_device_count ?? a.device_count ?? 0} cihaz</div>
                </div>
                <span className={`nm-pill ${a.status === 'online' ? 'ok' : 'crit'}`}>{a.status}</span>
              </div>
            ))}
        </Card>
      )
    case 'risk':
      return (
        <Card title="Cihaz Risk Dağılımı" pill={{ label: `${risk?.summary?.total_devices ?? total} cihaz` }} span="span-12">
          <RiskDist summary={risk?.summary} />
        </Card>
      )
    case 'sla':
      return (
        <Card title="SLA Compliance" pill={sla?.avg_uptime_pct >= 99 ? { label: 'hedef üstü', kind: 'ok' } : undefined} span="span-12" onTitle={() => navigate('/sla')}>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 14, alignItems: 'center' }}>
            <Donut value={sla?.avg_uptime_pct ?? 0} label="Fleet SLA" color={(sla?.avg_uptime_pct ?? 0) >= 99 ? 'var(--ok)' : (sla?.avg_uptime_pct ?? 0) >= 95 ? 'var(--warn)' : 'var(--crit)'} />
            <div style={{ fontSize: 11, color: 'var(--fg-2)', lineHeight: 2 }}>
              <div>≥99%: <span className="mono" style={{ color: 'var(--ok)' }}>{sla?.above_99 ?? 0}</span></div>
              <div>95–99%: <span className="mono" style={{ color: 'var(--warn)' }}>{sla?.above_95 ?? 0}</span></div>
              <div>&lt;95%: <span className="mono" style={{ color: 'var(--crit)' }}>{sla?.below_95 ?? 0}</span></div>
            </div>
          </div>
        </Card>
      )
    case 'anomalies':
      return (
        <Card title="Anormal Davranış" pill={anom?.total ? { label: `${anom.total} son 24sa`, kind: 'warn' } : undefined} span="span-12" onTitle={() => navigate('/intelligence')}>
          {!anom?.events?.length ? <Empty>Anomali yok</Empty> :
            anom.events.slice(0, 5).map((evt: any, i: number) => (
              <div key={i} className="nm-row" style={{ gridTemplateColumns: '1fr auto' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--warn)' }}>{evt.anomaly_type || evt.type || 'anomali'}</span>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-0)' }}>{evt.device_hostname || '—'}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-2)' }}>{evt.description || evt.detail || ''}</div>
                </div>
                <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>{evt.detected_at ? dayjs(evt.detected_at).fromNow(true) : ''}</span>
              </div>
            ))}
        </Card>
      )
    case 'drift':
      return (
        <Card title="Config Drift" pill={driftReport?.drift_count ? { label: `${driftReport.drift_count} sapma`, kind: 'warn' } : { label: 'temiz', kind: 'ok' }} span="span-12" onTitle={() => navigate('/config-drift')}>
          {!driftReport?.items?.length ? <Empty>Drift tespit edilmedi</Empty> :
            driftReport.items.slice(0, 5).map((r: any) => (
              <div key={r.device_id} className="nm-row" style={{ gridTemplateColumns: '1fr auto' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="host" style={{ fontSize: 12 }}>{r.hostname}</div>
                  <div className="ip">{r.ip || ''} {r.vendor ? `· ${r.vendor}` : ''}</div>
                </div>
                <span className={`nm-pill ${r.reason === 'no_backup' ? 'crit' : 'warn'}`}>
                  {r.reason === 'no_backup' ? 'backup yok' : 'config değişti'}
                </span>
              </div>
            ))}
        </Card>
      )
    case 'probes':
      // Probes endpoint yok; placeholder + sayfaya yönlendir
      return (
        <Card title="Synthetic Probes" pill={{ label: 'her 60s' }} span="span-12" onTitle={() => navigate('/synthetic-probes')}>
          <div style={{ padding: '14px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 8 }}>
              Probe sonuçları için dedike sayfaya bak
            </div>
            <button className="nm-pill accent" style={{ cursor: 'pointer', border: 'none' }} onClick={() => navigate('/synthetic-probes')}>
              Probe'lara git →
            </button>
          </div>
        </Card>
      )
    case 'vendors': {
      const items = (devicesData?.items as any[]) || []
      const vendors = items.reduce<Record<string, number>>((acc, d) => {
        const v = (d.vendor || 'bilinmeyen').toLowerCase()
        acc[v] = (acc[v] || 0) + 1
        return acc
      }, {})
      const sorted = Object.entries(vendors).sort((a, b) => b[1] - a[1]).slice(0, 6)
      const totalCount = items.length || 1
      return (
        <Card title="Vendor Dağılımı" pill={{ label: `${items.length} cihaz` }} span="span-12" onTitle={() => navigate('/devices')}>
          {sorted.length === 0 ? <Empty>Vendor verisi yok</Empty> :
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

function TopoMini({ online, offline, total }: { online: number; offline: number; total: number }) {
  return (
    <div className="nm-topo" style={{ minHeight: 200 }}>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="mono" style={{ fontSize: 34, color: 'var(--accent)' }}>{total}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-3)', letterSpacing: '0.06em' }}>NODE · {online} online · {offline} down</div>
        </div>
      </div>
      <div className="nm-legend" style={{ position: 'absolute', left: 8, bottom: 8 }}>
        <span><span className="dot" style={{ background: 'var(--accent)' }} />core</span>
        <span><span className="dot" style={{ background: 'var(--info)' }} />dist</span>
        <span><span className="dot" style={{ background: 'var(--fg-1)' }} />access</span>
        <span><span className="dot" style={{ background: 'var(--crit)' }} />down</span>
      </div>
    </div>
  )
}

function RiskDist({ summary }: { summary?: any }) {
  const buckets = [
    { label: 'KRİTİK', count: summary?.critical ?? 0, color: 'var(--crit)', range: '80-100' },
    { label: 'YÜKSEK', count: summary?.high ?? 0, color: 'var(--warn)', range: '60-79' },
    { label: 'ORTA', count: summary?.medium ?? 0, color: 'var(--info)', range: '40-59' },
    { label: 'DÜŞÜK', count: summary?.low ?? 0, color: 'var(--ok)', range: '0-39' },
  ]
  const tot = buckets.reduce((a, b) => a + b.count, 0)
  return (
    <div>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 12, background: 'var(--bg-3)' }}>
        {buckets.map((b) => <div key={b.label} style={{ flex: b.count || 0.01, background: b.color }} />)}
      </div>
      {buckets.map((b) => (
        <div key={b.label} className="nm-row" style={{ gridTemplateColumns: 'auto 1fr auto auto' }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: b.color, display: 'inline-block' }} />
          <span style={{ fontSize: 12 }}>{b.label}</span>
          <span className="mono" style={{ color: 'var(--fg-3)', fontSize: 10 }}>{b.range}</span>
          <span className="mono" style={{ color: 'var(--fg-0)', fontWeight: 500 }}>{b.count}</span>
        </div>
      ))}
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--fg-2)' }}>
        <span>Toplam değerlendirilen</span>
        <span className="mono" style={{ color: 'var(--fg-0)' }}>{tot} cihaz</span>
      </div>
    </div>
  )
}

// ── Mission variant (NOC duvarı, 3-column) ─────────────────────────────
// Mockup VariantMission: sol vital signs + risk; orta strip + map + alt
// widget şeridi; sağ event rail. Sayfa flush (border'sız, full-bleed).
function MissionVariant({ ctx }: { ctx: WidgetRenderCtx }) {
  const { online, offline, total, events24h, liveEvents, anom, risk, sla, impact } = ctx
  const unacked = anom?.unacked ?? 0
  const critIncidents = impact?.critical_count ?? 0
  return (
    <div className="variant-mission" style={{ height: '100%' }}>
      <div className="nm-mc-grid" style={{
        display: 'grid', gridTemplateColumns: '360px 1fr 320px', height: '100%', minHeight: 600,
      }}>
        {/* SOL: Vital signs */}
        <div style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ overflow: 'auto', flex: 1 }}>
            <VitalSign label="ÇEVRİMİÇİ CİHAZ" value={online} unit={`/ ${total}`}
              foot={<><span style={{ color: 'var(--ok)' }}>{online} aktif</span> · {offline} çevrimdışı</>}
              kind="ok" />
            <VitalSign label="AKTİF KRİTİK INCIDENT" value={critIncidents || 0}
              foot={<>{critIncidents > 0 ? <><span style={{ color: 'var(--crit)' }}>{critIncidents} OPEN</span> · servis etkili</> : 'açık incident yok'}</>}
              kind={critIncidents > 0 ? 'crit' : 'ok'} />
            <VitalSign label="SON 24SA OLAY" value={events24h}
              foot={<><span style={{ color: 'var(--fg-2)' }}>live</span> {liveEvents.length} new</>}
              kind="info" />
            <VitalSign label="FLEET AVAILABILITY" value={(sla?.avg_uptime_pct ?? 0).toFixed(1)} unit="%"
              foot={<><span style={{ color: (sla?.avg_uptime_pct ?? 0) >= 99 ? 'var(--ok)' : 'var(--warn)' }}>
                hedef 99.0%</span> 30 günlük</>}
              kind={(sla?.avg_uptime_pct ?? 0) >= 99 ? 'ok' : 'warn'} />
            <div style={{ padding: '16px 18px', borderTop: '1px solid var(--line)' }}>
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-2)',
                textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 12,
              }}>RİSK DAĞILIMI · {risk?.summary?.total_devices ?? total} CİHAZ</div>
              <RiskDist summary={risk?.summary} />
            </div>
          </div>
        </div>

        {/* ORTA: Strip + Map + Alt widget şeridi */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <div className="nm-mc-strip">
            <div>
              <div className="nm-mc-strip-label">EVENTS / 24SA</div>
              <div className="nm-mc-strip-val">{events24h}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>{liveEvents.length} live</div>
            </div>
            <div>
              <div className="nm-mc-strip-label">UNACKED</div>
              <div className="nm-mc-strip-val" style={{ color: unacked > 0 ? 'var(--crit)' : 'var(--ok)' }}>
                {unacked}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>onay bekliyor</div>
            </div>
            <div>
              <div className="nm-mc-strip-label">SLA · 30G</div>
              <div className="nm-mc-strip-val" style={{ color: (sla?.avg_uptime_pct ?? 0) >= 99 ? 'var(--ok)' : 'var(--warn)' }}>
                {(sla?.avg_uptime_pct ?? 0).toFixed(1)}<small style={{ fontSize: 11, color: 'var(--fg-3)' }}>%</small>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>HEDEF 99.0%</div>
            </div>
            <div>
              <div className="nm-mc-strip-label">SERVİS DURUMU</div>
              <div className="nm-mc-strip-val">
                {impact ? `${(impact.total_services ?? 0) - (impact.critical_count ?? 0)}/${impact.total_services ?? 0}` : '—'}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: critIncidents > 0 ? 'var(--crit)' : 'var(--fg-3)', marginTop: 4 }}>
                {critIncidents > 0 ? `${critIncidents} KESİNTİ` : 'stabil'}
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
            <MiniWidget title="CONFIG DRIFT" value={ctx.driftReport?.drift_count ?? 0}
              note={`${ctx.driftReport?.no_backup_count ?? 0} yedek yok`}
              kind={ctx.driftReport?.drift_count ? 'warn' : 'ok'} />
            <MiniWidget title="ONAY BEKLEYEN" value={ctx.approvalCount?.count ?? 0}
              note="komut onayı"
              kind={(ctx.approvalCount?.count ?? 0) > 0 ? 'warn' : 'ok'} />
            <MiniWidget title="AGENT FİLOSU"
              value={`${ctx.agents.filter((a: any) => a.status === 'online').length}/${ctx.agents.length}`}
              note="online ajan" kind="ok" />
          </div>
        </div>

        {/* SAĞ: Event rail */}
        <div style={{ borderLeft: '1px solid var(--line)', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-2)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              <span className="nm-status-dot ok pulse" style={{ marginRight: 6 }} />
              CANLI EVENT RAIL · {liveEvents.length}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
            {liveEvents.length === 0 ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--fg-3)', fontSize: 11 }}>
                Son 30 dakikada olay yok
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
  return (
    <div style={{ padding: '18px 18px 16px', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-2)',
        textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 44, fontWeight: 500, lineHeight: 1, color }}>
        {value}{unit && <small style={{ fontSize: 16, color: 'var(--fg-3)' }}>{unit}</small>}
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
    approvalCount, driftReport, now } = ctx
  const expPct = ctx.risk?.summary?.experience_score ?? null
  const criticalEvents = anom?.total ?? 0
  const offlinePct = total > 0 ? Math.round((offline / total) * 100 * 10) / 10 : 0
  return (
    <div className="variant-editorial" style={{ height: '100%' }}>
      <div className="nm-edit-wrap" style={{
        display: 'grid', gridTemplateColumns: '1fr 1px 1fr 1px 1fr', gap: 24,
        padding: '28px 32px', height: '100%', overflow: 'auto', alignItems: 'start',
      }}>
        {/* SOL: Operasyonel anlatı */}
        <div className="nm-edit-col">
          <div className="nm-edit-kicker">OPERASYONEL DURUM · {now}</div>
          <div className="nm-edit-headline" style={{ fontSize: 26, fontWeight: 500, lineHeight: 1.2, margin: '12px 0 20px' }}>
            {offline === 0
              ? 'Filo bugün stabil; tüm cihazlar çevrimiçi.'
              : offline <= 3
              ? 'Filo büyük ölçüde stabil; az sayıda cihaz izlemede.'
              : 'Filoda dikkat gerektiren çevrimdışı cihazlar var.'}
          </div>
          <div className="nm-edit-deck" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em', marginTop: 14 }}>
            ÇEVRİMDIŞI CİHAZ
          </div>
          <div className={`nm-edit-bigfig ${offline > 0 ? 'crit' : 'ok'}`}
            style={{ fontSize: 92, fontWeight: 500, color: offline > 0 ? 'var(--crit)' : 'var(--ok)', lineHeight: 1, fontFamily: 'var(--font-mono)' }}>
            {offline}<small style={{ fontSize: 18, color: 'var(--fg-3)' }}>/ {total}</small>
          </div>
          <div className="nm-edit-body" style={{ fontSize: 13, color: 'var(--fg-1)', lineHeight: 1.6, margin: '12px 0 20px' }}>
            {online} cihaz aktif · filo doluluğu <strong>%{(100 - offlinePct).toFixed(1)}</strong>.
            {(impact?.critical_count ?? 0) > 0 && <> Kritik etki altında <strong style={{ color: 'var(--crit)' }}>{impact.critical_count} servis</strong>.</>}
            {' '}Son 24 saatte <strong>{events24h} olay</strong> kaydedildi.
          </div>
          <div className="nm-edit-deck" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
            SON 24 SAAT
          </div>
          <div className="nm-edit-bigfig" style={{ fontSize: 72, fontWeight: 500, color: 'var(--fg-0)', lineHeight: 1, fontFamily: 'var(--font-mono)' }}>
            {events24h}<small style={{ fontSize: 14, color: 'var(--fg-3)' }}>olay</small>
          </div>
          <div className="nm-edit-meta" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--fg-3)', marginTop: 20, fontFamily: 'var(--font-mono)' }}>
            <span>Otomatik özet</span><span>·</span><span>NetManager Intelligence</span>
            <span style={{ marginLeft: 'auto' }}>▲ canlı</span>
          </div>
        </div>

        <div className="nm-edit-rule" style={{ background: 'var(--line)', height: '100%' }}></div>

        {/* ORTA: Rakamlar */}
        <div className="nm-edit-col">
          <div className="nm-edit-kicker">RAKAMLAR</div>
          <EditStat label="AKTİF INCIDENT" value={impact?.critical_count ?? 0}
            note={(impact?.critical_count ?? 0) > 0
              ? `${impact.critical_count} OPEN, servis etkili. En kritik servis: ${impact?.affected_services?.[0]?.service_name || '—'}.`
              : 'Açık incident yok; tüm servisler stabil seyrediyor.'} />
          <EditStat label="FLEET AVAILABILITY" value={(sla?.avg_uptime_pct ?? 0).toFixed(1)} unit="%"
            note={`30 günlük pencerede ${(sla?.avg_uptime_pct ?? 0) >= 99 ? 'hedefin üstünde' : 'hedefin altında'} (99.0%). En kötü cihaz: ${sla?.worst_devices?.[0]?.hostname || '—'} · %${sla?.worst_devices?.[0]?.uptime_pct?.toFixed(1) || '—'}.`} />
          <EditStat label="EXPERIENCE SCORE" value={expPct != null ? Math.round(expPct * 100) : '—'} unit={expPct != null ? '/100' : ''}
            note="Synthetic probe + uptime + paket kaybı bileşeni." />
          <EditStat label="RİSK · YÜKSEK VEYA ÜZERİ" value={(risk?.summary?.high ?? 0) + (risk?.summary?.critical ?? 0)}
            note={`${risk?.summary?.critical ?? 0} kritik, ${risk?.summary?.high ?? 0} yüksek. En riskli cihaz: ${risk?.top_risky?.[0]?.hostname || '—'}.`} />
          <EditStat label="ANORMAL DAVRANIŞ · 24SA" value={criticalEvents}
            note={criticalEvents > 0 ? 'Behavior analytics anomali tespit etti.' : 'Anomali yok; filo davranışı normal.'} />
        </div>

        <div className="nm-edit-rule" style={{ background: 'var(--line)', height: '100%' }}></div>

        {/* SAĞ: Brief */}
        <div className="nm-edit-col">
          <div className="nm-edit-kicker">BRIEF</div>
          <div style={{ marginBottom: 22 }}>
            <div className="nm-edit-deck" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 10 }}>
              SERVİS DURUMU
            </div>
            {!impact?.affected_services?.length ? (
              <div style={{ fontSize: 12, color: 'var(--fg-2)', padding: '14px 16px', border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
                Etkilenen servis yok — tüm servisler stabil.
              </div>
            ) : (
              <div style={{ border: '1px solid var(--line)', background: 'var(--bg-1)' }}>
                {impact.affected_services.slice(0, 4).map((svc: any) => (
                  <div key={svc.service_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--line-soft)' }}>
                    <span className={`nm-status-dot ${svc.impact_pct > 0 ? 'crit pulse' : 'ok pulse'}`} />
                    <div style={{ flex: 1, fontSize: 12 }}>{svc.service_name}</div>
                    <span className="mono" style={{ fontSize: 11, color: svc.impact_pct > 0 ? 'var(--crit)' : 'var(--ok)' }}>
                      {svc.impact_pct > 0 ? `${svc.impact_pct}% etki` : 'stabil'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ marginBottom: 22 }}>
            <div className="nm-edit-deck" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 10 }}>
              DİKKAT EDİLECEKLER
            </div>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: 'var(--fg-1)' }}>
              {(risk?.top_risky?.[0]) && (
                <li><strong style={{ color: 'var(--fg-0)' }}>{risk.top_risky[0].hostname}</strong> — risk skoru {Math.round(risk.top_risky[0].risk_score ?? 0)}, kontrol önerilir.</li>
              )}
              {(impact?.affected_services?.[0]) && impact.affected_services[0].impact_pct > 0 && (
                <li><strong style={{ color: 'var(--fg-0)' }}>{impact.affected_services[0].service_name}</strong> servisi şu an %{impact.affected_services[0].impact_pct} etkide.</li>
              )}
              {(approvalCount?.count ?? 0) > 0 && (
                <li><strong style={{ color: 'var(--fg-0)' }}>{approvalCount.count} onay</strong> operatörler tarafından bekletiliyor.</li>
              )}
              {(driftReport?.drift_count ?? 0) > 0 && (
                <li><strong style={{ color: 'var(--fg-0)' }}>{driftReport.drift_count} cihazda</strong> config drift tespit edildi.</li>
              )}
              {(agents.filter((a: any) => a.status !== 'online').length > 0) && (
                <li><strong style={{ color: 'var(--fg-0)' }}>{agents.filter((a: any) => a.status !== 'online').length} ajan</strong> çevrimdışı.</li>
              )}
              {/* Hiçbir madde yoksa */}
              {(risk?.top_risky?.length ?? 0) === 0 &&
                (impact?.affected_services?.[0]?.impact_pct ?? 0) === 0 &&
                (approvalCount?.count ?? 0) === 0 &&
                (driftReport?.drift_count ?? 0) === 0 && (
                <li style={{ color: 'var(--fg-3)' }}>Bugün için kayda değer bir dikkat noktası yok.</li>
              )}
            </ol>
          </div>
          <div>
            <div className="nm-edit-deck" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 10 }}>
              FİLO ÖZETİ
            </div>
            <div style={{ display: 'flex', gap: 18, fontSize: 12, color: 'var(--fg-2)' }}>
              <div><strong style={{ color: 'var(--ok)' }}>{online}</strong> online</div>
              <div><strong style={{ color: offline > 0 ? 'var(--crit)' : 'var(--fg-0)' }}>{offline}</strong> çevrimdışı</div>
              <div><strong style={{ color: 'var(--fg-0)' }}>{total}</strong> toplam</div>
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
