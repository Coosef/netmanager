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

function Kpi({ label, value, unit, delta, dir, status, spark, sparkColor }: {
  label: string; value: string | number; unit?: string; delta?: string
  dir?: 'up' | 'down' | 'flat'; status?: 'crit' | 'ok' | 'info'; spark?: number[]; sparkColor?: string
}) {
  const accent = status === 'crit' ? 'var(--crit)' : status === 'ok' ? 'var(--ok)' : status === 'info' ? 'var(--info)' : 'var(--fg-0)'
  return (
    <div className="nm-kpi" style={{ borderTop: `2px solid ${accent}` }}>
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
  const { editMode, widgetHidden, widgetOrder, setWidgetOrder, toggleWidget } = useCustomize()
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

  return (
    <div style={{ padding: 2 }}>
      {/* live ticker */}
      <div className="nm-ticker">
        <div className="nm-ticker-label">CANLI AKIŞ</div>
        <div className="nm-ticker-track" style={{ animation: 'none' }}>
          {liveEvents.length === 0 ? (
            <span className="nm-ticker-item"><span style={{ color: 'var(--fg-3)' }}>Son 30 dakikada olay yok</span></span>
          ) : liveEvents.slice(0, 12).map((e, i) => (
            <span key={i} className="nm-ticker-item">
              <span className="ts" style={{ color: 'var(--fg-3)' }}>{dayjs(e.created_at).format('HH:mm:ss')}</span>
              <span className={`sev ${sevPill(e.severity)}`}>{(e.severity || '').toUpperCase()}</span>
              <span className="host" style={{ color: 'var(--fg-1)' }}>{e.device_hostname || '—'}</span>
              <span className="msg" style={{ color: 'var(--fg-2)' }}>{e.title}</span>
            </span>
          ))}
        </div>
      </div>

      {/* KPI hero */}
      <div className="nm-hero">
        <Kpi label="ÇEVRİMDIŞI" value={offline} unit={`/ ${total}`} status="crit"
          delta={`${online} online`} dir="flat" spark={eventsTrend} sparkColor="var(--crit)" />
        <Kpi label="AKTİF UYARI" value={unacked} status="crit"
          delta="onaylanmamış" dir="flat" />
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
              <div key={i} className="nm-row" style={{ gridTemplateColumns: 'auto auto 1fr' }}>
                <span className="mono" style={{ color: 'var(--fg-3)', fontSize: 10.5 }}>{dayjs(e.created_at).format('HH:mm:ss')}</span>
                <span className={`nm-pill ${sevPill(e.severity)}`}>{e.severity}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-0)' }}>{e.device_hostname || '—'}</span>
                  <span style={{ color: 'var(--fg-2)', marginLeft: 8, fontSize: 11.5 }}>{e.title}</span>
                </span>
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
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: svc.impact_pct > 0 ? `var(--${st})` : 'var(--ok)' }} />
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
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.status === 'online' ? 'var(--ok)' : 'var(--crit)', boxShadow: `0 0 6px var(--${a.status === 'online' ? 'ok' : 'crit'})` }} />
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
