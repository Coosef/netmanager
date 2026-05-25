// Canlı İzleme — real-time NOC view (Netmanager/pages-monitor.jsx port).
//
// Tasarım dosyasında olup atlanan tek büyük sayfaydı: /monitor zaten Uyarılar
// (alert kartları) için kullanıldığından bu sayfa hiç yapılmamıştı. Burası
// olay akışı: WebSocket'ten gelen her network event'i canlı log'a düşer +
// 6 KPI stat bar + sağ panelde Açık Incident'lar + Synthetic Probes.
//
// Veri yolu (hepsi gerçek):
//   - useEventStream  → /ws/events kanalı; yeni event geldikçe log'un başına
//   - monitorApi      → ilk 80 olay seed + 6 KPI istatistiği (poll 15s)
//   - incidentsApi    → açık incident listesi (poll 30s)
//   - syntheticApi    → probe listesi (poll 60s)
//
// Pause: WS açık kalır ama append durur; karşılaştırma için snapshot tutar.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Tooltip } from 'antd'
import {
  PauseOutlined, CaretRightOutlined, HistoryOutlined,
  FullscreenOutlined, ThunderboltOutlined, AlertOutlined,
  AimOutlined, ApartmentOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import dayjs from 'dayjs'
import { monitorApi, type NetworkEvent } from '@/api/monitor'
import { incidentsApi } from '@/api/incidents'
import { syntheticApi } from '@/api/synthetic'
import { useEventStream } from '@/hooks/useEventStream'
import NmEmpty from '@/components/NmEmpty'

type SevKey = 'critical' | 'warning' | 'info'
const SEV_ORDER: SevKey[] = ['critical', 'warning', 'info']
const SEV_LABEL: Record<SevKey, string> = {
  critical: 'CRIT',
  warning:  'WARN',
  info:     'INFO',
}

// ── Live frame normaliser ────────────────────────────────────────────────────
//
// The backend ws frame and the REST event row use the same NetworkEvent
// shape with one nuance: ws frames may arrive before the row hits the DB,
// so `id` can be missing. We synthesise a key so the log render stays
// stable and React doesn't dupe-render adjacent frames.
type LogRow = {
  key: string
  ts: number            // ms epoch for sorting + dedupe
  severity: SevKey
  host: string
  event_type: string
  message: string
}

function toLogRow(ev: NetworkEvent): LogRow {
  const ts = new Date(ev.created_at).getTime() || Date.now()
  return {
    key: `${ev.id ?? ts}-${ev.event_type}-${ev.device_id ?? 'x'}`,
    ts,
    severity: (SEV_ORDER.includes(ev.severity as SevKey) ? ev.severity : 'info') as SevKey,
    host: ev.device_hostname ?? '—',
    event_type: ev.event_type,
    message: ev.message ?? ev.title ?? '—',
  }
}

// WS frame → only treat ones that look like a NetworkEvent payload as live
// log lines. Other frames (topology_*, agent_*, etc.) ride the same socket
// but go to other consumers.
function isNetworkEventFrame(raw: unknown): raw is NetworkEvent {
  if (typeof raw !== 'object' || raw === null) return false
  const f = raw as Record<string, unknown>
  // Backend dispatches `{event_type, severity, device_id, device_hostname,
  // message, created_at, ...}` for network events. Reject topology_* /
  // agent_status_* / task_* etc.
  if (typeof f.severity !== 'string') return false
  if (typeof f.event_type !== 'string') return false
  if (f.event_type.startsWith('topology_')) return false
  if (f.event_type.startsWith('agent_')) return false
  if (f.event_type.startsWith('task_')) return false
  return true
}

const MAX_LOG = 80

export default function LiveMonitorPage() {
  const [paused, setPaused] = useState(false)
  const [sevFilter, setSevFilter] = useState<Set<SevKey>>(new Set(SEV_ORDER))
  const [log, setLog] = useState<LogRow[]>([])
  // Pause snapshot — when the user pauses we freeze a copy of the current
  // log so what they see can't shift under their cursor while they read.
  const pauseSnapshotRef = useRef<LogRow[] | null>(null)

  // ── Seed buffer from REST + keep a slow safety poll ────────────────────────
  const seedQuery = useQuery({
    queryKey: ['monitor-events-seed'],
    queryFn: () => monitorApi.getEvents({ limit: 80, hours: 24 }),
    refetchInterval: 30_000,     // safety net if WS drops
    staleTime: 15_000,
  })
  useEffect(() => {
    if (paused || !seedQuery.data) return
    const seed = seedQuery.data.items
      .slice()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map(toLogRow)
    // Merge: keep any in-memory live rows newer than the most recent seed.
    setLog((prev) => {
      const newest = seed[0]?.ts ?? 0
      const liveOnly = prev.filter((r) => r.ts > newest)
      return [...liveOnly, ...seed].slice(0, MAX_LOG)
    })
  }, [seedQuery.data, paused])

  // ── Live WS append ─────────────────────────────────────────────────────────
  const { connected } = useEventStream({
    enabled: true,
    onEvent: (frame) => {
      if (paused) return
      if (!isNetworkEventFrame(frame)) return
      const row = toLogRow(frame)
      setLog((prev) => {
        // Dedup against the most recent 8 — protects against a re-broadcast
        // where the same event lands twice via different relays.
        for (let i = 0; i < Math.min(prev.length, 8); i++) {
          if (prev[i].key === row.key) return prev
        }
        return [row, ...prev].slice(0, MAX_LOG)
      })
    },
  })

  // Pause snapshot capture / release.
  useEffect(() => {
    if (paused) pauseSnapshotRef.current = log
    else        pauseSnapshotRef.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused])

  // ── Stats ───────────────────────────────────────────────────────────────────
  const statsQuery = useQuery({
    queryKey: ['monitor-stats-live'],
    queryFn: () => monitorApi.getStats(),
    refetchInterval: 15_000,
  })
  // events/min from the actual log rate over the last 60 s (live signal)
  const eventsPerMin = useMemo(() => {
    if (log.length === 0) return 0
    const cutoff = Date.now() - 60_000
    const count = log.filter((r) => r.ts >= cutoff).length
    return count   // already a 1-minute rate
  }, [log])

  const incidentsQuery = useQuery({
    queryKey: ['live-open-incidents'],
    queryFn: () => incidentsApi.list({ state: 'OPEN', limit: 5 }),
    refetchInterval: 30_000,
  })
  const probesQuery = useQuery({
    queryKey: ['live-probes'],
    queryFn: () => syntheticApi.list(),
    refetchInterval: 60_000,
  })

  // ── Render ──────────────────────────────────────────────────────────────────
  const visibleLog = (pauseSnapshotRef.current ?? log).filter((r) => sevFilter.has(r.severity))
  const stats = statsQuery.data
  const incidents = incidentsQuery.data?.items ?? []
  const probes    = probesQuery.data ?? []
  const probeFailCount = probes.filter((p) => p.sla_enabled && p.sla_status?.compliant === false).length

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      {/* NOC header */}
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Genel</span><span>Canlı İzleme</span></div>
          <h1 className="nm-page-title">
            Canlı İzleme
            <span className="nm-pill mono" style={{
              color: connected ? 'var(--ok)' : 'var(--warn)',
              borderColor: connected ? 'var(--ok)' : 'var(--warn)',
            }}>
              {connected ? 'REAL-TIME' : 'BAĞLANIYOR…'}
            </span>
            {paused && (
              <span className="nm-pill mono" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>
                DURAKLATILDI
              </span>
            )}
          </h1>
          <div className="nm-page-sub">
            Tüm filodan canlı olay ak&#x131;&#x15F;&#x131; — periyodik SSH polling, agent heartbeat ve SNMP triggers.
            WebSocket aç&#x131;k oldu&#x11F;u sürece event'ler an&#x131;nda akar.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Tooltip title="Geçmiş olaylar — /monitor sayfas&#x131;na git">
            <Link to="/monitor">
              <Button icon={<HistoryOutlined />}>Geçmişe Bak</Button>
            </Link>
          </Tooltip>
          <Tooltip title="Tam ekran NOC modu">
            <Button icon={<FullscreenOutlined />}
              onClick={() => document.documentElement.requestFullscreen?.()}>
              NOC Modu
            </Button>
          </Tooltip>
          <Button
            type={paused ? 'primary' : 'default'}
            icon={paused ? <CaretRightOutlined /> : <PauseOutlined />}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? 'Devam' : 'Duraklat'}
          </Button>
        </div>
      </div>

      {/* 6 KPI stat bar — gerçek verilerden türetilmiş */}
      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">OLAY / DAKİKA</div>
          <div className="nm-stat-val">{eventsPerMin}</div>
          <div className="nm-stat-delta">son 60 sn</div>
        </div>
        <div className={`nm-stat ${(stats?.events_24h.by_severity.critical ?? 0) > 0 ? 'crit' : ''}`}>
          <div className="nm-stat-label">KRİTİK · 24SA</div>
          <div className="nm-stat-val">{stats?.events_24h.by_severity.critical ?? 0}</div>
          <div className="nm-stat-delta">
            {stats?.events_24h.unacknowledged ?? 0} unacked
          </div>
        </div>
        <div className={`nm-stat ${incidents.length > 0 ? 'crit' : 'ok'}`}>
          <div className="nm-stat-label">AÇIK INCIDENT</div>
          <div className="nm-stat-val">{incidents.length}</div>
          <div className="nm-stat-delta">
            {incidents[0]?.opened_at ? `en eski ${dayjs(incidents[0].opened_at).fromNow(true)}` : 'sakin'}
          </div>
        </div>
        <div className={`nm-stat ${probeFailCount > 0 ? 'warn' : 'ok'}`}>
          <div className="nm-stat-label">AKTİF PROBE</div>
          <div className="nm-stat-val">
            {probes.filter((p) => p.enabled).length}<small>/{probes.length}</small>
          </div>
          <div className="nm-stat-delta">{probeFailCount} SLA ihlali</div>
        </div>
        <div className={`nm-stat ${(stats?.devices.offline ?? 0) > 0 ? 'crit' : 'ok'}`}>
          <div className="nm-stat-label">CİHAZ ONLINE</div>
          <div className="nm-stat-val">
            {stats?.devices.online ?? 0}<small>/{stats?.devices.total ?? 0}</small>
          </div>
          <div className="nm-stat-delta">{stats?.devices.offline ?? 0} offline</div>
        </div>
        <div className={`nm-stat ${(stats?.fleet_availability_24h ?? 100) < 99 ? 'warn' : 'ok'}`}>
          <div className="nm-stat-label">FİLO SLA · 24SA</div>
          <div className="nm-stat-val">
            {stats?.fleet_availability_24h != null ? `${stats.fleet_availability_24h.toFixed(2)}%` : '—'}
          </div>
          <div className="nm-stat-delta">
            health {stats?.health_score ?? '—'}
          </div>
        </div>
      </div>

      {/* Two-column live area */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 360px', gap: 14, flex: 1, minHeight: 0 }}>
        {/* LEFT — event stream */}
        <div className="nm-card" style={{ padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="nm-card-hd" style={{ alignItems: 'center' }}>
            <h3><AlertOutlined /> Olay Akışı</h3>
            <span className="nm-pill mono">{visibleLog.length} olay</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
              {SEV_ORDER.map((s) => {
                const on = sevFilter.has(s)
                const color = s === 'critical' ? 'var(--crit)' : s === 'warning' ? 'var(--warn)' : 'var(--accent)'
                return (
                  <button
                    key={s}
                    onClick={() => setSevFilter((prev) => {
                      const next = new Set(prev)
                      if (next.has(s)) next.delete(s); else next.add(s)
                      return next
                    })}
                    className="nm-pill mono"
                    style={{
                      cursor: 'pointer',
                      padding: '2px 8px',
                      color: on ? color : 'var(--fg-3)',
                      borderColor: on ? color : 'var(--border-0)',
                      background: on ? 'transparent' : 'var(--bg-2)',
                    }}
                  >
                    {SEV_LABEL[s]}
                  </button>
                )
              })}
              <span style={{
                marginLeft: 10, fontSize: 11,
                color: paused ? 'var(--warn)' : connected ? 'var(--ok)' : 'var(--fg-3)',
                display: 'inline-flex', alignItems: 'center', gap: 5,
              }}>
                {paused ? (
                  <><PauseOutlined /> DURDU</>
                ) : connected ? (
                  <>
                    <span className="nm-status-dot ok pulse" />
                    AKIYOR
                  </>
                ) : (
                  <>● Yeniden bağlanıyor</>
                )}
              </span>
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {visibleLog.length === 0 ? (
              <NmEmpty
                icon={<ThunderboltOutlined />}
                title="Henüz olay yok"
                description="Backend canl&#x131; ak&#x131;&#x15F;a ba&#x11F;lan&#x131;r ba&#x11F;lanmaz buraya d&#x131;&#x15F;er. Filtreleri kontrol edin ya da sonraki sweep'i bekleyin."
                tone="ok"
                compact
              />
            ) : visibleLog.map((r) => (
              <div key={r.key} style={{
                display: 'grid',
                gridTemplateColumns: '78px 56px 140px 1fr',
                gap: 12, padding: '8px 14px',
                borderBottom: '1px solid var(--border-0)',
                alignItems: 'center',
                fontSize: 12.5,
                animation: 'nm-fadein 0.4s ease-out',
              }}>
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>
                  {new Date(r.ts).toLocaleTimeString('tr-TR', { hour12: false })}
                </span>
                <span className={`nm-pill mono`} style={{
                  textAlign: 'center', minWidth: 44,
                  color: r.severity === 'critical' ? 'var(--crit)' : r.severity === 'warning' ? 'var(--warn)' : 'var(--accent)',
                  borderColor: r.severity === 'critical' ? 'var(--crit)' : r.severity === 'warning' ? 'var(--warn)' : 'var(--accent)',
                }}>
                  {SEV_LABEL[r.severity]}
                </span>
                <span className="mono" style={{ fontSize: 11.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.host}
                </span>
                <span style={{ color: 'var(--fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.event_type}<span style={{ color: 'var(--fg-3)' }}> · {r.message}</span>
                </span>
              </div>
            ))}
            {visibleLog.length > 0 && (
              <div style={{ padding: 14, textAlign: 'center', color: 'var(--fg-3)', fontSize: 11 }} className="mono">
                · daha eski olaylar i&#xE7;in{' '}
                <Link to="/monitor" style={{ color: 'var(--accent)' }}>Geçmişe Bak</Link>{' '}·
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — side panels */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
          {/* Open incidents */}
          <div className="nm-card" style={{ padding: 0 }}>
            <div className="nm-card-hd">
              <h3><AimOutlined /> Açık Incident'lar</h3>
              <span className={`nm-pill ${incidents.length > 0 ? '' : 'mono'}`} style={{
                color: incidents.length > 0 ? 'var(--crit)' : 'var(--fg-3)',
                borderColor: incidents.length > 0 ? 'var(--crit)' : 'var(--border-0)',
              }}>{incidents.length}</span>
            </div>
            <div style={{ padding: '0 14px 8px' }}>
              {incidents.length === 0 ? (
                <NmEmpty
                  title="Açık incident yok"
                  description="Sakin liman — RCA gerektiren bir &#x15F;ey çağırm&#x131;yor."
                  tone="ok" compact
                />
              ) : incidents.map((inc, i) => (
                <div key={inc.id} style={{
                  padding: '10px 0',
                  borderBottom: i < incidents.length - 1 ? '1px solid var(--border-0)' : 0,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="nm-pill mono" style={{
                      color: inc.severity === 'critical' ? 'var(--crit)' : 'var(--warn)',
                      borderColor: inc.severity === 'critical' ? 'var(--crit)' : 'var(--warn)',
                    }}>
                      {inc.state}
                    </span>
                    <span className="mono" style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {inc.device_hostname ?? `incident #${inc.id}`}
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fg-3)' }} className="mono">
                      {dayjs(inc.opened_at ?? new Date().toISOString()).fromNow(true)}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-2)', marginTop: 4 }}>
                    {inc.event_type}
                    {inc.source_count > 1 && <> · <span className="mono" style={{ color: 'var(--accent)' }}>{inc.source_count} kaynak</span></>}
                  </div>
                </div>
              ))}
              {incidents.length > 0 && (
                <div style={{ paddingTop: 8 }}>
                  <Link to="/incidents" style={{ fontSize: 11, color: 'var(--accent)' }}>
                    Tüm incident'lar →
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* Synthetic probes */}
          <div className="nm-card" style={{ padding: 0 }}>
            <div className="nm-card-hd">
              <h3><ApartmentOutlined /> Synthetic Probes</h3>
              <Link to="/synthetic-probes" style={{ fontSize: 11, color: 'var(--accent)', marginLeft: 'auto' }}>
                Yönet →
              </Link>
            </div>
            <div style={{ padding: '0 14px 12px' }}>
              {probes.length === 0 ? (
                <NmEmpty
                  title="Henüz probe yok"
                  description="Sentetik ICMP/TCP/HTTP probe'lar&#x131;yla SLA takip et."
                  tone="neutral" compact
                />
              ) : probes.slice(0, 5).map((p) => {
                const breach = p.sla_enabled && p.sla_status?.compliant === false
                return (
                  <div key={p.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
                    borderBottom: '1px solid var(--border-0)',
                  }}>
                    <span className={`nm-status-dot ${breach ? 'crit pulse' : p.enabled ? 'ok' : ''}`} />
                    <span style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {p.name}
                    </span>
                    <span className="nm-pill mono" style={{ fontSize: 9.5 }}>
                      {p.probe_type.toUpperCase()}
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: breach ? 'var(--crit)' : 'var(--fg-3)' }}>
                      {p.interval_secs}s
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Inline fade-in keyframe for newly-arrived rows */}
      <style>{`@keyframes nm-fadein {
        from { background: oklch(from var(--accent) l c h / 0.12); }
        to   { background: transparent; }
      }`}</style>
    </div>
  )
}
