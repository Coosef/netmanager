import { useState } from 'react'
import {
  Table, Tag, Button, Space, Select, Tooltip, Drawer,
  Spin, Badge, Descriptions, Timeline,
  Empty, Segmented, Alert,
} from 'antd'
import {
  AlertOutlined, ReloadOutlined, FileTextOutlined,
  PrinterOutlined,
} from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  incidentsApi,
  type IncidentSummary, type IncidentRCA,
  type IncidentState, type IncidentSeverity,
} from '@/api/incidents'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import duration from 'dayjs/plugin/duration'

dayjs.extend(relativeTime)
dayjs.extend(duration)

// ── Visual constants ──────────────────────────────────────────────────────────

const STATE_COLOR: Record<IncidentState, string> = {
  OPEN:       'error',
  DEGRADED:   'error',
  RECOVERING: 'warning',
  CLOSED:     'success',
  SUPPRESSED: 'default',
}

const STATE_LABEL: Record<IncidentState, string> = {
  OPEN:       'Açık',
  DEGRADED:   'Ağırlaştı',
  RECOVERING: 'Kurtarılıyor',
  CLOSED:     'Kapandı',
  SUPPRESSED: 'Baskılandı',
}

const SEV_COLOR: Record<string, string> = {
  critical: '#ef4444',
  warning:  '#f59e0b',
  info:     '#3b82f6',
}

const SOURCE_LABEL: Record<string, string> = {
  snmp_trap:    'SNMP Trap',
  syslog:       'Syslog',
  synthetic:    'Synthetic Probe',
  ping_check:   'Ping',
  agent_health: 'Agent Health',
  manual:       'Manuel',
}

function fmtDuration(secs: number | null): string {
  if (secs == null) return '—'
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}d ${secs % 60}s`
  return `${Math.floor(secs / 3600)}s ${Math.floor((secs % 3600) / 60)}d`
}

// ── State timeline ────────────────────────────────────────────────────────────
function IncidentTimeline({ rca }: { rca: IncidentRCA }) {
  const items = rca.timeline.map((t) => ({
    color: t.state === 'OPEN' ? '#ef4444'
      : t.state === 'DEGRADED' ? '#dc2626'
      : t.state === 'RECOVERING' ? '#f59e0b'
      : t.state === 'CLOSED' ? '#22c55e'
      : '#94a3b8',
    label: <span style={{ fontSize: 11, color: '#888' }}>{dayjs(t.ts).format('DD.MM HH:mm:ss')}</span>,
    children: (
      <div>
        <Tag color={STATE_COLOR[t.state as IncidentState]}>{STATE_LABEL[t.state as IncidentState] ?? t.state}</Tag>
        <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{t.reason}</div>
      </div>
    ),
  }))

  if (!items.length) {
    return <div style={{ color: '#888', fontSize: 13, padding: '8px 0' }}>Zaman çizelgesi verisi yok.</div>
  }

  return <Timeline mode="left" items={items} style={{ marginTop: 8 }} />
}

// ── Source breakdown ──────────────────────────────────────────────────────────
function SourceBreakdown({ rca }: { rca: IncidentRCA }) {
  const total = rca.sources.length
  if (!total) return <div style={{ color: '#888', fontSize: 13 }}>Kaynak kaydı yok.</div>

  const bySource = rca.source_summary
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 4 }}>
      {Object.entries(bySource).map(([src, cnt]) => (
        <div key={src} style={{
          background: '#f8fafc', border: '1px solid #e2e8f0',
          borderRadius: 6, padding: '4px 10px', fontSize: 12,
        }}>
          <span style={{ fontWeight: 600 }}>{SOURCE_LABEL[src] ?? src}</span>
          <span style={{ color: '#888', marginLeft: 6 }}>×{cnt}</span>
        </div>
      ))}
      {rca.sources.slice(0, 8).map((s, i) => (
        <Tooltip key={i} title={`Güven: ${(s.confidence * 100).toFixed(0)}% · ${dayjs(s.ts).format('HH:mm:ss')}`}>
          <Tag color="blue" style={{ fontSize: 11, cursor: 'default' }}>
            {SOURCE_LABEL[s.source] ?? s.source}
          </Tag>
        </Tooltip>
      ))}
    </div>
  )
}

// ── RCA Drawer ────────────────────────────────────────────────────────────────
function RCADrawer({ incidentId, onClose }: { incidentId: number | null; onClose: () => void }) {
  const { data: rca, isLoading } = useQuery({
    queryKey: ['incident-rca', incidentId],
    queryFn: () => incidentsApi.get(incidentId!),
    enabled: incidentId != null,
    staleTime: 60_000,
  })

  const handlePrint = () => {
    if (!rca) return
    const win = window.open('', '_blank')
    if (!win) return
    win.document.write(buildPrintHTML(rca))
    win.document.close()
    setTimeout(() => { win.print() }, 400)
  }

  return (
    <Drawer
      open={incidentId != null}
      onClose={onClose}
      width={720}
      title={
        rca ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertOutlined style={{ color: SEV_COLOR[rca.severity] }} />
            <span style={{ fontWeight: 700 }}>{rca.event_type.replace(/_/g, ' ').toUpperCase()}</span>
            {rca.device_hostname && <Tag>{rca.device_hostname}</Tag>}
            <Tag color={STATE_COLOR[rca.state]}>{STATE_LABEL[rca.state]}</Tag>
          </div>
        ) : 'Incident RCA'
      }
      extra={
        <Button icon={<PrinterOutlined />} onClick={handlePrint} disabled={!rca}>
          PDF İndir
        </Button>
      }
      styles={{ body: { padding: '16px 24px' } }}
    >
      {isLoading && <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>}
      {rca && <RCAContent rca={rca} />}
    </Drawer>
  )
}

function RCAContent({ rca }: { rca: IncidentRCA }) {
  const [activeTab, setActiveTab] = useState<string>('timeline')

  return (
    <div>
      {/* ── Summary header ─── */}
      <Descriptions size="small" column={2} style={{ marginBottom: 16 }}
        items={[
          { label: 'ID', children: <code style={{ fontSize: 11 }}>#{rca.id}</code> },
          { label: 'Parmak İzi', children: <code style={{ fontSize: 11 }}>{rca.fingerprint}</code> },
          { label: 'Bileşen', children: rca.component || '—' },
          { label: 'Şiddet', children: <Tag color={rca.severity === 'critical' ? 'error' : rca.severity === 'warning' ? 'warning' : 'blue'}>{rca.severity.toUpperCase()}</Tag> },
          { label: 'Açılış', children: rca.opened_at ? dayjs(rca.opened_at).format('DD.MM.YYYY HH:mm:ss') : '—' },
          { label: 'Süre', children: fmtDuration(rca.duration_secs) },
          { label: 'Kaynak Sayısı', children: rca.sources.length },
          { label: 'IP', children: rca.device_ip || '—' },
        ]}
      />

      {rca.suppressed_by_detail && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12, fontSize: 12 }}
          message={
            <span>
              Bu incident <strong>{rca.suppressed_by_detail.device_hostname || `#${rca.suppressed_by_detail.id}`}</strong> cihazındaki
              upstream incident (<strong>#{rca.suppressed_by_detail.id}</strong> · {rca.suppressed_by_detail.event_type}) tarafından baskılandı.
            </span>
          }
        />
      )}

      {/* ── Tabs ─── */}
      <Segmented
        value={activeTab}
        onChange={(v) => setActiveTab(v as string)}
        options={[
          { label: `Zaman Çizelgesi (${rca.timeline.length})`, value: 'timeline' },
          { label: `Kaynaklar (${rca.sources.length})`, value: 'sources' },
          { label: `Olaylar (${rca.related_events.length})`, value: 'events' },
          { label: `Synthetic (${rca.synthetic_correlations.length})`, value: 'synthetic' },
          { label: `Topoloji (${rca.topology_neighbors.length})`, value: 'topology' },
          ...(rca.suppressed_children.length ? [{ label: `Baskılanan (${rca.suppressed_children.length})`, value: 'suppressed' }] : []),
        ]}
        style={{ marginBottom: 16, flexWrap: 'wrap' }}
        size="small"
      />

      {activeTab === 'timeline' && <IncidentTimeline rca={rca} />}

      {activeTab === 'sources' && <SourceBreakdown rca={rca} />}

      {activeTab === 'events' && (
        rca.related_events.length === 0 ? (
          <Empty description="Bu pencerede kayıtlı ağ olayı yok." />
        ) : (
          <Table
            dataSource={rca.related_events}
            rowKey="id"
            size="small"
            pagination={false}
            columns={[
              { title: 'Olay', dataIndex: 'event_type', width: 140,
                render: (v: string) => <span style={{ fontSize: 12, fontFamily: 'monospace' }}>{v}</span> },
              { title: 'Şiddet', dataIndex: 'severity', width: 80,
                render: (v: string) => <Tag color={v === 'critical' ? 'error' : v === 'warning' ? 'warning' : 'blue'} style={{ fontSize: 11 }}>{v}</Tag> },
              { title: 'Başlık', dataIndex: 'title',
                render: (v: string) => <Tooltip title={v}><span style={{ fontSize: 12 }}>{v.length > 55 ? v.slice(0, 55) + '…' : v}</span></Tooltip> },
              { title: 'Zaman', dataIndex: 'created_at', width: 120,
                render: (v: string) => <span style={{ fontSize: 11, color: '#888' }}>{dayjs(v).format('HH:mm:ss')}</span> },
            ]}
          />
        )
      )}

      {activeTab === 'synthetic' && (
        rca.synthetic_correlations.length === 0 ? (
          <Empty description="Bu pencerede synthetic probe sonucu yok." />
        ) : (
          <Table
            dataSource={rca.synthetic_correlations}
            rowKey={(r) => `${r.probe_id}-${r.measured_at}`}
            size="small"
            pagination={false}
            columns={[
              { title: 'Probe', dataIndex: 'probe_name', width: 130,
                render: (v: string, r) => (
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{v}</div>
                    <Tag color={{ icmp: 'blue', tcp: 'orange', http: 'green', dns: 'purple' }[r.probe_type] || 'default'} style={{ fontSize: 10 }}>{r.probe_type.toUpperCase()}</Tag>
                  </div>
                ) },
              { title: 'Sonuç', dataIndex: 'success', width: 80,
                render: (v: boolean) => v
                  ? <Badge status="success" text={<span style={{ fontSize: 11, color: '#22c55e' }}>✓</span>} />
                  : <Badge status="error"   text={<span style={{ fontSize: 11, color: '#ef4444' }}>✗</span>} /> },
              { title: 'Gecikme', dataIndex: 'latency_ms', width: 80,
                render: (v: number | null) => v != null ? <span style={{ fontSize: 11, color: '#888' }}>{v.toFixed(1)} ms</span> : '—' },
              { title: 'Zaman', dataIndex: 'measured_at', width: 120,
                render: (v: string) => <span style={{ fontSize: 11, color: '#888' }}>{dayjs(v).format('HH:mm:ss')}</span> },
            ]}
          />
        )
      )}

      {activeTab === 'topology' && (
        rca.topology_neighbors.length === 0 ? (
          <Empty description="Topoloji komşusu kaydı yok." />
        ) : (
          <Table
            dataSource={rca.topology_neighbors}
            rowKey={(r) => `${r.device_id}-${r.local_port}`}
            size="small"
            pagination={false}
            columns={[
              { title: 'Komşu', dataIndex: 'hostname', width: 140,
                render: (v: string, r) => (
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{v}</div>
                    {r.neighbor_type && <Tag style={{ fontSize: 10 }}>{r.neighbor_type}</Tag>}
                  </div>
                ) },
              { title: 'Port', key: 'ports', width: 160,
                render: (_: unknown, r) => (
                  <span style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>
                    {r.local_port} → {r.neighbor_port}
                  </span>
                ) },
              { title: 'Incident', key: 'incident',
                render: (_: unknown, r) => r.active_incident ? (
                  <Space size={4}>
                    <Tag color="error" style={{ fontSize: 11 }}>{r.active_incident.event_type}</Tag>
                    <Tag color={STATE_COLOR[r.active_incident.state as IncidentState] || 'default'} style={{ fontSize: 10 }}>
                      {STATE_LABEL[r.active_incident.state as IncidentState] ?? r.active_incident.state}
                    </Tag>
                  </Space>
                ) : <Badge status="success" text={<span style={{ fontSize: 11, color: '#22c55e' }}>Normal</span>} /> },
            ]}
          />
        )
      )}

      {activeTab === 'suppressed' && (
        rca.suppressed_children.length === 0 ? (
          <Empty description="Baskılanan alt incident yok." />
        ) : (
          <Table
            dataSource={rca.suppressed_children}
            rowKey="id"
            size="small"
            pagination={false}
            columns={[
              { title: '#', dataIndex: 'id', width: 60, render: (v: number) => <code style={{ fontSize: 11 }}>#{v}</code> },
              { title: 'Cihaz', dataIndex: 'device_hostname', width: 130,
                render: (v: string | null) => v || '—' },
              { title: 'Olay', dataIndex: 'event_type',
                render: (v: string) => <span style={{ fontSize: 12, fontFamily: 'monospace' }}>{v}</span> },
              { title: 'Şiddet', dataIndex: 'severity', width: 80,
                render: (v: string) => <Tag color={v === 'critical' ? 'error' : 'warning'} style={{ fontSize: 11 }}>{v}</Tag> },
              { title: 'Açılış', dataIndex: 'opened_at', width: 120,
                render: (v: string | null) => v ? <span style={{ fontSize: 11, color: '#888' }}>{dayjs(v).format('DD.MM HH:mm')}</span> : '—' },
            ]}
          />
        )
      )}
    </div>
  )
}

// ── PDF print helper ──────────────────────────────────────────────────────────
function buildPrintHTML(rca: IncidentRCA): string {
  const ts = (s: string | null) => s ? dayjs(s).format('DD.MM.YYYY HH:mm:ss') : '—'
  const tlRows = rca.timeline.map(t =>
    `<tr><td>${ts(t.ts)}</td><td>${t.state}</td><td>${t.reason}</td></tr>`
  ).join('')
  const srcRows = rca.sources.map(s =>
    `<tr><td>${SOURCE_LABEL[s.source] ?? s.source}</td><td>${(s.confidence * 100).toFixed(0)}%</td><td>${ts(s.ts)}</td></tr>`
  ).join('')

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Incident #${rca.id} RCA Raporu</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1a1a1a; margin: 24px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 14px; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 20px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { background: #f1f5f9; padding: 5px 8px; text-align: left; font-size: 11px; }
  td { padding: 4px 8px; border-bottom: 1px solid #f0f0f0; font-size: 11px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; margin: 12px 0; }
  .meta span { font-size: 12px; } .meta strong { color: #555; }
  @media print { body { margin: 0; } }
</style></head><body>
<h1>🔴 Incident #${rca.id} — RCA Raporu</h1>
<div style="color:#888; font-size:11px">Oluşturulma: ${dayjs().format('DD.MM.YYYY HH:mm')}</div>
<div class="meta">
  <span><strong>Olay Tipi:</strong> ${rca.event_type}</span>
  <span><strong>Cihaz:</strong> ${rca.device_hostname ?? '—'} (${rca.device_ip ?? '—'})</span>
  <span><strong>Şiddet:</strong> ${rca.severity.toUpperCase()}</span>
  <span><strong>Durum:</strong> ${STATE_LABEL[rca.state]}</span>
  <span><strong>Açılış:</strong> ${ts(rca.opened_at)}</span>
  <span><strong>Süre:</strong> ${fmtDuration(rca.duration_secs)}</span>
  <span><strong>Bileşen:</strong> ${rca.component ?? '—'}</span>
  <span><strong>Parmak İzi:</strong> ${rca.fingerprint}</span>
</div>
${rca.suppressed_by_detail ? `<p style="background:#fef9c3;padding:6px 10px;border-radius:4px;font-size:12px">
  ⚠️ Bu incident <b>#${rca.suppressed_by_detail.id}</b> (${rca.suppressed_by_detail.device_hostname ?? '?'}) tarafından baskılandı.</p>` : ''}
<h2>Durum Zaman Çizelgesi</h2>
<table><thead><tr><th>Zaman</th><th>Durum</th><th>Neden</th></tr></thead><tbody>${tlRows}</tbody></table>
<h2>Katkıda Bulunan Kaynaklar</h2>
<table><thead><tr><th>Kaynak</th><th>Güven</th><th>Zaman</th></tr></thead><tbody>${srcRows}</tbody></table>
<h2>Bağlı Cihazlar (${rca.topology_neighbors.length})</h2>
<table><thead><tr><th>Komşu</th><th>Port</th><th>Aktif Incident</th></tr></thead><tbody>
${rca.topology_neighbors.map(n =>
  `<tr><td>${n.hostname}</td><td>${n.local_port}→${n.neighbor_port}</td><td>${n.active_incident ? n.active_incident.event_type : 'Normal'}</td></tr>`
).join('')}
</tbody></table>
</body></html>`
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function IncidentsPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [filterState, setFilterState] = useState<string | undefined>()
  const [filterSev, setFilterSev] = useState<string | undefined>()
  const [filterHours, setFilterHours] = useState<number>(168)
  const [page, setPage] = useState(0)
  const limit = 20

  const { data, isLoading } = useQuery({
    queryKey: ['incidents', filterState, filterSev, filterHours, page],
    queryFn: () => incidentsApi.list({
      state: filterState as IncidentState | undefined,
      severity: filterSev as IncidentSeverity | undefined,
      hours: filterHours,
      limit,
      offset: page * limit,
    }),
    staleTime: 30_000,
  })

  const columns = [
    {
      title: 'Durum', dataIndex: 'state', width: 110,
      render: (s: IncidentState) => (
        <Tag color={STATE_COLOR[s]} style={{ fontWeight: 600, fontSize: 12 }}>
          {STATE_LABEL[s]}
        </Tag>
      ),
    },
    {
      title: 'Şiddet', dataIndex: 'severity', width: 90,
      render: (s: string) => (
        <Tag color={s === 'critical' ? 'error' : s === 'warning' ? 'warning' : 'blue'} style={{ fontSize: 11 }}>
          {s.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Cihaz', key: 'device', width: 150,
      render: (_: unknown, r: IncidentSummary) => (
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{r.device_hostname || '—'}</div>
          {r.device_ip && <div style={{ color: '#888', fontSize: 11, fontFamily: 'monospace' }}>{r.device_ip}</div>}
        </div>
      ),
    },
    {
      title: 'Olay Tipi', dataIndex: 'event_type', width: 160,
      render: (v: string) => (
        <div>
          <span style={{ fontSize: 12, fontFamily: 'monospace' }}>{v}</span>
          {undefined}
        </div>
      ),
    },
    {
      title: 'Bileşen', dataIndex: 'component', width: 110,
      render: (v: string | null) => v
        ? <code style={{ fontSize: 11, color: '#666' }}>{v}</code>
        : <span style={{ color: '#ccc' }}>—</span>,
    },
    {
      title: 'Kaynaklar', dataIndex: 'source_count', width: 80, align: 'center' as const,
      render: (v: number) => (
        <Badge count={v} style={{ backgroundColor: v > 1 ? '#6366f1' : '#94a3b8' }} showZero />
      ),
    },
    {
      title: 'Açılış', dataIndex: 'opened_at', width: 130,
      render: (v: string | null) => v ? (
        <Tooltip title={dayjs(v).format('DD.MM.YYYY HH:mm:ss')}>
          <span style={{ fontSize: 12, color: '#888' }}>{dayjs(v).fromNow()}</span>
        </Tooltip>
      ) : '—',
    },
    {
      title: 'Süre', dataIndex: 'duration_secs', width: 90,
      render: (v: number | null) => <span style={{ fontSize: 12, color: '#888' }}>{fmtDuration(v)}</span>,
    },
    {
      title: 'RCA', key: 'rca', width: 70, align: 'center' as const,
      render: (_: unknown, r: IncidentSummary) => (
        <Tooltip title="RCA Detayını Görüntüle">
          <Button
            size="small" type="text" icon={<FileTextOutlined />}
            onClick={() => setSelectedId(r.id)}
          />
        </Tooltip>
      ),
    },
  ]

  const HOURS_OPTIONS = [
    { value: 24, label: 'Son 24 saat' },
    { value: 72, label: 'Son 3 gün' },
    { value: 168, label: 'Son 7 gün' },
    { value: 720, label: 'Son 30 gün' },
  ]

  return (
    <div style={{ padding: '0 0 24px' }}>
      {/* ── Header ─── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Incident RCA</h2>
          <div style={{ color: '#888', fontSize: 13, marginTop: 2 }}>
            Kök neden analizi — durum zaman çizelgesi, kaynak dağılımı, topoloji
          </div>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => qc.invalidateQueries({ queryKey: ['incidents'] })}>
          Yenile
        </Button>
      </div>

      {/* ── Filters ─── */}
      <Space style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <Select
          allowClear placeholder="Tüm Durumlar" style={{ width: 150 }}
          value={filterState}
          onChange={(v) => { setFilterState(v); setPage(0) }}
          options={[
            { value: 'OPEN',       label: 'Açık' },
            { value: 'DEGRADED',   label: 'Ağırlaştı' },
            { value: 'RECOVERING', label: 'Kurtarılıyor' },
            { value: 'CLOSED',     label: 'Kapandı' },
            { value: 'SUPPRESSED', label: 'Baskılandı' },
          ]}
        />
        <Select
          allowClear placeholder="Tüm Şiddetler" style={{ width: 140 }}
          value={filterSev}
          onChange={(v) => { setFilterSev(v); setPage(0) }}
          options={[
            { value: 'critical', label: 'Critical' },
            { value: 'warning',  label: 'Warning' },
            { value: 'info',     label: 'Info' },
          ]}
        />
        <Select
          style={{ width: 150 }}
          value={filterHours}
          onChange={(v) => { setFilterHours(v); setPage(0) }}
          options={HOURS_OPTIONS}
        />
      </Space>

      {/* ── Table ─── */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
      ) : (
        <Table
          dataSource={data?.items ?? []}
          rowKey="id"
          columns={columns}
          size="middle"
          loading={isLoading}
          pagination={{
            current: page + 1,
            pageSize: limit,
            total: data?.total ?? 0,
            showTotal: (t) => `${t} incident`,
            onChange: (p) => setPage(p - 1),
            hideOnSinglePage: true,
          }}
          onRow={(r: IncidentSummary) => ({
            onClick: () => setSelectedId(r.id),
            style: { cursor: 'pointer' },
          })}
          locale={{ emptyText: (
            <div style={{ padding: '48px 0', color: '#888' }}>
              <AlertOutlined style={{ fontSize: 32, marginBottom: 8, display: 'block', color: '#22c55e' }} />
              <div style={{ fontSize: 15 }}>Seçili pencerede incident kaydı yok.</div>
            </div>
          ) }}
          rowClassName={(r: IncidentSummary) =>
            r.state === 'OPEN' || r.state === 'DEGRADED' ? 'incident-row-active' : ''
          }
        />
      )}

      {/* ── RCA Drawer ─── */}
      <RCADrawer incidentId={selectedId} onClose={() => setSelectedId(null)} />

      <style>{`
        .incident-row-active td:first-child {
          border-left: 3px solid #ef4444;
        }
        .ant-table-row.incident-row-active:hover td {
          background: rgba(239,68,68,0.04) !important;
        }
      `}</style>
    </div>
  )
}
