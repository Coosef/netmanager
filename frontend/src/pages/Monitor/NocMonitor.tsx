// NocMonitor — T8.4 NOC design Uyarılar page (mockup pages-alerts.jsx).
// Mockup chrome: nm-page-hd + 6-stat nm-statbar + severity/state filter
// chips + incident-style event cards (left severity stripe, mockup'taki
// "korelasyon %", "kök neden", "etkilenen servis" alanları backend'de
// olmadığı için EKLENMEDİ — uydurma yok). Tüm aksiyonlar gerçek monitorApi'ya
// bağlı (getEvents, getStats, acknowledge, acknowledgeAll, triggerScan,
// purgeNoise, exportEvents). Detay için antd Modal — eski sayfada da öyle.
//
// Mockup'taki "Uyarı Kuralları / Eskalasyon / Kanallar" tab'ları bizim
// navigasyonda zaten ayrı sayfalar (/alert-rules, /escalation, /notification-
// channels). Burada birleştirilmedi.
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Modal, Select, Popconfirm, Descriptions, Empty } from 'antd'
import { SyncOutlined, BellOutlined, ClearOutlined, DownloadOutlined, CheckOutlined, FilterOutlined } from '@ant-design/icons'
import { monitorApi, type NetworkEvent } from '@/api/monitor'
import { useSite } from '@/contexts/SiteContext'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

type SevKey = 'critical' | 'warning' | 'info'
const SEV_LABEL: Record<SevKey, string> = { critical: 'KRİTİK', warning: 'UYARI', info: 'BİLGİ' }
const SEV_CLS: Record<SevKey, string> = { critical: 'crit', warning: 'warn', info: 'info' }

const PAGE_SIZE = 30

export default function NocMonitor() {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const { activeSite } = useSite()

  // ── filters / state ─────────────────────────────────────────────────────
  const [severityFilter, setSeverityFilter] = useState<'all' | SevKey>('all')
  const [unackedOnly, setUnackedOnly] = useState(false)
  const [hours, setHours] = useState(24)
  const [page, setPage] = useState(1)
  const [selectedEvent, setSelectedEvent] = useState<NetworkEvent | null>(null)

  // ── queries ─────────────────────────────────────────────────────────────
  const { data: statsData, refetch: refetchStats } = useQuery({
    queryKey: ['monitor-stats', activeSite],
    queryFn: () => monitorApi.getStats({ site: activeSite || undefined }),
    refetchInterval: 60000,
  })
  const { data: eventsData, isFetching, refetch } = useQuery({
    queryKey: ['monitor-events-cards', severityFilter, hours, unackedOnly, page, activeSite],
    queryFn: () => monitorApi.getEvents({
      skip: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
      severity: severityFilter === 'all' ? undefined : severityFilter,
      hours,
      unacked_only: unackedOnly || undefined,
      site: activeSite || undefined,
    }),
    refetchInterval: 30000,
  })

  const events = eventsData?.items || []
  const total = eventsData?.total || 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Stats — backend'in events_24h.by_severity'sini kullan; key'leri normalize et
  const sevCounts = useMemo(() => {
    const m = { critical: 0, warning: 0, info: 0 } as Record<SevKey, number>
    const by = statsData?.events_24h?.by_severity ?? {}
    Object.entries(by).forEach(([k, v]) => {
      const key = (k.toLowerCase() === 'crit' ? 'critical'
        : k.toLowerCase() === 'warn' ? 'warning'
        : k.toLowerCase()) as SevKey
      if (key in m) m[key] = (m[key] ?? 0) + (v as number)
    })
    return m
  }, [statsData])
  const total24h = statsData?.events_24h?.total ?? 0
  const unacked = statsData?.events_24h?.unacknowledged ?? 0
  const acked = Math.max(0, total24h - unacked)

  // ── actions ─────────────────────────────────────────────────────────────
  const refresh = () => { refetch(); refetchStats(); message.success('Yenilendi') }
  const ackOne = async (id: number) => {
    try { await monitorApi.acknowledge(id); qc.invalidateQueries({ queryKey: ['monitor-events-cards'] }); refetchStats(); message.success('Onaylandı') }
    catch { message.error('Onaylanamadı') }
  }
  const ackAll = async () => {
    try { await monitorApi.acknowledgeAll(); qc.invalidateQueries({ queryKey: ['monitor-events-cards'] }); refetchStats(); message.success('Hepsi onaylandı') }
    catch { message.error('İşlem başarısız') }
  }
  const triggerScan = async () => {
    try { const r = await monitorApi.triggerScan(); message.success(`Tarama kuyruğa alındı (${r.device_count} cihaz)`) }
    catch { message.error('Tarama başlatılamadı') }
  }
  const purgeNoise = async () => {
    try { const r = await monitorApi.purgeNoise(1); qc.invalidateQueries({ queryKey: ['monitor-events-cards'] }); refetchStats(); message.success(`${r.deleted} gürültü olayı temizlendi`) }
    catch { message.error('Temizleme başarısız') }
  }
  const downloadCsv = async () => {
    try { await monitorApi.exportEvents({ severity: severityFilter === 'all' ? undefined : severityFilter, hours, unacked_only: unackedOnly || undefined, site: activeSite || undefined }); message.success('CSV indirildi') }
    catch { message.error('CSV indirilemedi') }
  }

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Genel</span><span>Uyarılar</span></div>
          <h1 className="nm-page-title">
            Uyarılar &amp; Olaylar
            {unacked > 0 && <span className="nm-pill crit mono">{unacked} açık</span>}
            <span className="nm-pill mono">{total24h} olay · 24sa</span>
          </h1>
          <div className="nm-page-sub">
            Cihaz olayları, SSH/SNMP hataları, link flap, agent online/offline — gerçek-zamanlı olay akışı + onay/triage.
          </div>
        </div>
        <div className="nm-page-actions">
          <button className="nm-btn ghost" onClick={refresh}><SyncOutlined spin={isFetching} /> Yenile</button>
          <button className="nm-btn ghost" onClick={triggerScan}><BellOutlined /> Tara</button>
          <Popconfirm title="Gürültü olaylarını temizle?" description="Son 1 saatteki düşük öncelikli olaylar silinir."
            okText="Temizle" cancelText="İptal" okButtonProps={{ danger: true }} onConfirm={purgeNoise}>
            <button className="nm-btn ghost"><ClearOutlined /> Gürültü Temizle</button>
          </Popconfirm>
          <button className="nm-btn ghost" onClick={downloadCsv}><DownloadOutlined /> CSV</button>
          {unacked > 0 && (
            <Popconfirm title="Tüm olaylar onaylansın mı?" okText="Hepsini Onayla" cancelText="İptal" onConfirm={ackAll}>
              <button className="nm-btn primary"><CheckOutlined /> Hepsini Onayla</button>
            </Popconfirm>
          )}
        </div>
      </div>

      <div className="nm-statbar">
        <div className="nm-stat crit">
          <div className="nm-stat-label">Açık</div>
          <div className="nm-stat-val">{unacked}</div>
          <div className="nm-stat-delta">onay bekliyor</div>
        </div>
        <div className="nm-stat crit">
          <div className="nm-stat-label">Kritik · 24sa</div>
          <div className="nm-stat-val">{sevCounts.critical}</div>
        </div>
        <div className="nm-stat warn">
          <div className="nm-stat-label">Uyarı · 24sa</div>
          <div className="nm-stat-val">{sevCounts.warning}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">Bilgi · 24sa</div>
          <div className="nm-stat-val">{sevCounts.info}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">Toplam · 24sa</div>
          <div className="nm-stat-val">{total24h}</div>
        </div>
        <div className="nm-stat ok">
          <div className="nm-stat-label">Onaylı · 24sa</div>
          <div className="nm-stat-val">{acked}</div>
          <div className="nm-stat-delta">triage tamamlandı</div>
        </div>
      </div>

      {/* Filter chips */}
      <div className="nm-filterbar">
        <span className="label"><FilterOutlined style={{ fontSize: 11 }} /> FİLTRELER</span>
        {(['all', 'critical', 'warning', 'info'] as const).map((s) => {
          const active = severityFilter === s
          const label = s === 'all' ? 'Tümü' : SEV_LABEL[s as SevKey]
          return (
            <span key={s} className="nm-filterchip"
              onClick={() => { setSeverityFilter(s); setPage(1) }}
              style={{
                cursor: 'pointer',
                background: active ? 'var(--accent-soft)' : undefined,
                color: active ? 'var(--accent)' : undefined,
                borderColor: active ? 'var(--accent)' : undefined,
              }}>
              <span>{label}</span>
            </span>
          )
        })}
        <span className="nm-filterchip" onClick={() => { setUnackedOnly(!unackedOnly); setPage(1) }}
          style={{
            cursor: 'pointer',
            background: unackedOnly ? 'var(--accent-soft)' : undefined,
            color: unackedOnly ? 'var(--accent)' : undefined,
            borderColor: unackedOnly ? 'var(--accent)' : undefined,
          }}>
          <span>{unackedOnly ? '✓ Sadece açık' : 'Sadece açık'}</span>
        </span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <span style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>SÜRE</span>
          <Select<number> size="small" value={hours} onChange={(v) => { setHours(v); setPage(1) }} style={{ width: 110 }}
            options={[
              { value: 1, label: 'Son 1 saat' }, { value: 6, label: 'Son 6 saat' },
              { value: 24, label: 'Son 24 saat' }, { value: 72, label: 'Son 3 gün' },
              { value: 168, label: 'Son 7 gün' },
            ]} />
        </div>
      </div>

      {/* Event cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
        {events.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>
            <Empty description={<span style={{ color: 'var(--fg-3)' }}>Filtreye uyan olay bulunamadı</span>} />
          </div>
        ) : (
          events.map((ev) => (
            <EventCard key={ev.id} ev={ev} onDetail={() => setSelectedEvent(ev)} onAck={() => ackOne(ev.id)} />
          ))
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="nm-table-foot" style={{ marginTop: 14 }}>
          <span>Sayfa <strong style={{ color: 'var(--fg-0)' }}>{page}</strong> / {totalPages}</span>
          <span style={{ color: 'var(--fg-3)' }}>·</span>
          <span>{(page - 1) * PAGE_SIZE + (events.length > 0 ? 1 : 0)}–{(page - 1) * PAGE_SIZE + events.length} / {total}</span>
          <div className="pager">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
            <button className="active">{page}</button>
            <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>›</button>
          </div>
        </div>
      )}

      {/* Detail modal */}
      <EventDetailModal ev={selectedEvent} onClose={() => setSelectedEvent(null)}
        onAck={(id) => { ackOne(id); setSelectedEvent(null) }} />
    </div>
  )
}

// ── Single event card (mockup incident-card) ──────────────────────────────
function EventCard({ ev, onDetail, onAck }: { ev: NetworkEvent; onDetail: () => void; onAck: () => void }) {
  const sevKey = (ev.severity in SEV_CLS ? ev.severity : 'info') as SevKey
  const sevCls = SEV_CLS[sevKey]
  const isOpen = !ev.acknowledged
  return (
    <div className="nm-card" onClick={onDetail} style={{ cursor: 'pointer', padding: 0 }}>
      <div style={{ padding: '14px 18px', display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 14, alignItems: 'flex-start' }}>
        {/* Severity stripe — açık olaylar (acked değil) için kritik/uyarı stripe pulse */}
        <div style={{
          width: 4, alignSelf: 'stretch', borderRadius: 2,
          background: `var(--${sevCls})`,
          ...(isOpen && sevCls === 'crit' ? { animation: 'nm-edgepulse 1.5s ease-in-out infinite' } : {}),
        }}></div>

        {/* Body */}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>#{ev.id}</span>
            <span className={`nm-pill ${sevCls}`}>{SEV_LABEL[sevKey]}</span>
            {isOpen ? (
              <span className="nm-pill warn">AÇIK</span>
            ) : (
              <span className="nm-pill ok">ONAYLI</span>
            )}
            <span className="nm-pill mono" style={{ fontSize: 9.5 }}>{ev.event_type}</span>
            <span style={{ fontSize: 10.5, color: 'var(--fg-3)' }} className="mono">
              {dayjs(ev.created_at).fromNow(true)} önce
            </span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 5, color: 'var(--fg-0)' }}>{ev.title}</div>
          {ev.message && (
            <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5, maxWidth: '90ch', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ev.message}
            </div>
          )}
          {ev.device_hostname && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: 11.5, color: 'var(--fg-2)' }}>
              <span>Cihaz: <strong className="mono" style={{ color: 'var(--fg-0)' }}>{ev.device_hostname}</strong></span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="nm-btn ghost" style={{ height: 24, fontSize: 11, padding: '0 10px' }} onClick={onDetail}>Detay</button>
            {isOpen && <button className="nm-btn primary" style={{ height: 24, fontSize: 11, padding: '0 10px' }} onClick={onAck}>Onayla</button>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Detail modal ──────────────────────────────────────────────────────────
function EventDetailModal({ ev, onClose, onAck }:
  { ev: NetworkEvent | null; onClose: () => void; onAck: (id: number) => void }) {
  if (!ev) return null
  const sevKey = (ev.severity in SEV_CLS ? ev.severity : 'info') as SevKey
  const isOpen = !ev.acknowledged
  return (
    <Modal open onCancel={onClose} title={`#${ev.id} — ${ev.title}`} width={720}
      footer={
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button className="nm-btn ghost" onClick={onClose}>Kapat</button>
          {isOpen && <button className="nm-btn primary" onClick={() => onAck(ev.id)}><CheckOutlined /> Onayla</button>}
        </div>
      }>
      <Descriptions column={2} bordered size="small" style={{ marginBottom: 12 }}>
        <Descriptions.Item label="Olay Türü"><code>{ev.event_type}</code></Descriptions.Item>
        <Descriptions.Item label="Önem">
          <span className={`nm-pill ${SEV_CLS[sevKey]}`}>{SEV_LABEL[sevKey]}</span>
        </Descriptions.Item>
        <Descriptions.Item label="Cihaz">{ev.device_hostname || '—'}</Descriptions.Item>
        <Descriptions.Item label="Cihaz ID" className="mono">{ev.device_id ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="Oluştu" span={2}>{dayjs(ev.created_at).format('YYYY-MM-DD HH:mm:ss')} · {dayjs(ev.created_at).fromNow()}</Descriptions.Item>
        <Descriptions.Item label="Durum" span={2}>
          {isOpen ? <span className="nm-pill warn">AÇIK</span> : <span className="nm-pill ok">ONAYLI</span>}
        </Descriptions.Item>
      </Descriptions>
      {ev.message && (
        <>
          <div style={{ fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Mesaj</div>
          <div style={{ fontSize: 13, color: 'var(--fg-0)', padding: '10px 12px', background: 'var(--bg-2)', border: '1px solid var(--line-soft)', borderRadius: 6, marginBottom: 12 }}>
            {ev.message}
          </div>
        </>
      )}
      {ev.details && Object.keys(ev.details).length > 0 && (
        <>
          <div style={{ fontSize: 11, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Ek Bilgi</div>
          <pre style={{ fontSize: 11.5, color: 'var(--fg-1)', padding: '10px 12px', background: 'var(--bg-2)', border: '1px solid var(--line-soft)', borderRadius: 6, overflow: 'auto', maxHeight: 260 }}>
            {JSON.stringify(ev.details, null, 2)}
          </pre>
        </>
      )}
    </Modal>
  )
}
