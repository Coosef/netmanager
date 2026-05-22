// NocAgents — T8.4 NOC design Agents page (mockup pages-rest.jsx AgentsPage).
// Faithful copy of the design (nm-page / nm-statbar / agent card grid with
// nm-gauge CPU/RAM + 4-stat block) wired to REAL data. Previous AgentsPage
// (full mgmt: create/delete/detail drawer/security) is preserved in git +
// still mounted from index via the "Yönet" action drawer is out-of-scope here;
// this is the inventory/overview surface the mockup specifies.
import { useMemo, useState } from 'react'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { App, Modal, Input, Button, Typography } from 'antd'
import { agentsApi, type Agent } from '@/api/agents'
import { devicesApi } from '@/api/devices'
import { RobotOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)
const { Text } = Typography

const hb = (iso: string | null) => (iso ? dayjs(iso).fromNow(true) : '—')

export default function NocAgents() {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [createdKey, setCreatedKey] = useState<{ name: string; id: string; agent_key: string } | null>(null)
  const createMut = useMutation({
    mutationFn: (name: string) => agentsApi.create({ name }),
    onSuccess: (a) => {
      setCreatedKey({ name: a.name, id: a.id, agent_key: a.agent_key })
      setCreateOpen(false); setNewName('')
      qc.invalidateQueries({ queryKey: ['agents-list'] })
      message.success('Ajan oluşturuldu')
    },
    onError: () => message.error('Ajan oluşturulamadı'),
  })

  const { data: agents = [] } = useQuery({ queryKey: ['agents-list'], queryFn: agentsApi.list, refetchInterval: 30000 })
  const { data: devicesData } = useQuery({ queryKey: ['devices-for-agents'], queryFn: () => devicesApi.list({ limit: 2000 }) })
  const { data: latencyMap = [] } = useQuery({ queryKey: ['agents-latency-map'], queryFn: agentsApi.getLatencyMap, refetchInterval: 60000 })
  const { data: versionData } = useQuery({ queryKey: ['agent-current-version'], queryFn: agentsApi.getCurrentVersion })

  // Per-agent live metrics (cpu/ram/queue) — only for online agents.
  const liveQueries = useQueries({
    queries: agents.filter((a) => a.status === 'online').map((a) => ({
      queryKey: ['agent-live', a.id],
      queryFn: () => agentsApi.getLiveMetrics(a.id),
      refetchInterval: 30000,
      retry: 0,
    })),
  })
  const liveById = useMemo(() => {
    const m: Record<string, { cpu: number | null; ram: number | null; queue: number }> = {}
    const online = agents.filter((a) => a.status === 'online')
    liveQueries.forEach((q, i) => {
      const id = online[i]?.id
      if (id && q.data) m[id] = {
        cpu: q.data.metrics?.cpu_percent ?? null,
        ram: q.data.metrics?.memory_percent ?? null,
        queue: q.data.metrics?.queue_size ?? 0,
      }
    })
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, liveQueries.map((q) => q.dataUpdatedAt).join(',')])

  const latById = useMemo(() => {
    const m: Record<string, number | null> = {}
    latencyMap.forEach((e) => { m[e.agent_id] = e.latency_ms })
    return m
  }, [latencyMap])

  const deviceCountById = useMemo(() => {
    const m: Record<string, number> = {}
    for (const d of devicesData?.items ?? []) {
      const aid = (d as { agent_id?: string | null }).agent_id
      if (aid) m[aid] = (m[aid] ?? 0) + 1
    }
    return m
  }, [devicesData])

  const online = agents.filter((a) => a.status === 'online').length
  const slow = agents.filter((a) => (latById[a.id] ?? 0) > 100).length
  const totalDevices = agents.reduce((s, a) => s + (deviceCountById[a.id] ?? 0), 0)
  const lats = agents.map((a) => latById[a.id]).filter((v): v is number => v != null)
  const avgLat = lats.length ? Math.round(lats.reduce((s, v) => s + v, 0) / lats.length) : 0
  const totalQueue = agents.reduce((s, a) => s + (liveById[a.id]?.queue ?? 0), 0)
  const verShort = (versionData?.version ?? '—').replace(/^v?/, 'v').split('.').slice(0, 2).join('.')

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Envanter</span><span>Ajanlar</span></div>
          <h1 className="nm-page-title">
            Proxy Ajanlar
            <span className="nm-pill mono">{agents.length} ajan</span>
            <span className="nm-pill ok">{online} online</span>
          </h1>
          <div className="nm-page-sub">Dağıtık WebSocket ajanları — NAT arkası SSH/SNMP erişimi, syslog toplama, synthetic probes.</div>
        </div>
        <div className="nm-page-actions">
          <button className="nm-btn ghost">Gecikme Haritası</button>
          <button className="nm-btn ghost">Vault Yenile</button>
          <button className="nm-btn primary" onClick={() => setCreateOpen(true)}>+ Ajan Kur</button>
        </div>
      </div>

      {/* Create agent modal (real: agentsApi.create) */}
      <Modal open={createOpen} title="Yeni Ajan Kur" onCancel={() => setCreateOpen(false)}
        onOk={() => newName.trim() && createMut.mutate(newName.trim())}
        confirmLoading={createMut.isPending} okText="Oluştur" cancelText="İptal">
        <Input placeholder="Ajan adı (örn. agent-branch-ist)" value={newName}
          onChange={(e) => setNewName(e.target.value)} onPressEnter={() => newName.trim() && createMut.mutate(newName.trim())} />
      </Modal>

      {/* One-time agent key after creation */}
      <Modal open={!!createdKey} title="Ajan Anahtarı (tek seferlik)" footer={null} onCancel={() => setCreatedKey(null)}>
        <div style={{ fontSize: 13, marginBottom: 10 }}>
          <strong>{createdKey?.name}</strong> oluşturuldu. Bu anahtarı kaydedin — tekrar gösterilmeyecek:
        </div>
        <Text code copyable style={{ wordBreak: 'break-all', display: 'block' }}>{createdKey?.agent_key}</Text>
        <div style={{ textAlign: 'right', marginTop: 16 }}>
          <Button type="primary" onClick={() => setCreatedKey(null)}>Tamam</Button>
        </div>
      </Modal>

      <div className="nm-statbar">
        <div className="nm-stat ok"><div className="nm-stat-label">Online</div><div className="nm-stat-val">{online}<small>/ {agents.length}</small></div></div>
        <div className="nm-stat warn"><div className="nm-stat-label">Yavaş</div><div className="nm-stat-val">{slow}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Toplam Cihaz</div><div className="nm-stat-val">{totalDevices}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Ort. Gecikme</div><div className="nm-stat-val">{avgLat}<small>ms</small></div></div>
        <div className="nm-stat warn"><div className="nm-stat-label">Offline Kuyruğu</div><div className="nm-stat-val">{totalQueue}</div></div>
        <div className="nm-stat"><div className="nm-stat-label">Versiyon</div><div className="nm-stat-val mono" style={{ fontSize: 18 }}>{verShort}</div></div>
      </div>

      {agents.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>
          <RobotOutlined style={{ fontSize: 28, opacity: 0.4 }} /><div style={{ marginTop: 10 }}>Henüz ajan yok</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 14 }}>
          {agents.map((a: Agent) => {
            const live = liveById[a.id]
            const cpu = live?.cpu ?? null
            const ram = live?.ram ?? null
            const lat = latById[a.id]
            const queue = live?.queue ?? 0
            const devices = deviceCountById[a.id] ?? 0
            const ok = a.status === 'online'
            return (
              <div key={a.id} className="nm-card">
                <div className="nm-card-hd">
                  <h3>
                    <span className={`nm-status-dot ${ok ? 'ok' : 'crit'}`}></span>
                    {a.name}
                    {a.version && <span className="nm-pill mono" style={{ fontSize: 9.5 }}>{a.version}</span>}
                  </h3>
                </div>
                <div style={{ padding: '6px 18px 18px' }}>
                  <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: 'var(--fg-2)', marginBottom: 14, flexWrap: 'wrap' }}>
                    <span>{a.platform || 'bilinmeyen OS'}</span>
                    <span>·</span>
                    <span>{a.machine_hostname || a.last_ip || '—'}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                    <Gauge label="CPU" value={cpu} warnAt={60} />
                    <Gauge label="RAM" value={ram} warnAt={70} />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, padding: '10px 0', borderTop: '1px solid var(--line-soft)' }}>
                    <Stat label="CİHAZ" value={devices} />
                    <Stat label="GECİKME" value={lat != null ? lat : '—'} unit={lat != null ? 'ms' : ''} warn={lat != null && lat > 100} />
                    <Stat label="HEARTBEAT" value={hb(a.last_heartbeat)} />
                    <Stat label="KUYRUK" value={queue} warn={queue > 0} dim={queue === 0} />
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 12, flexWrap: 'wrap' }}>
                    {['SSH Akışı', 'SNMP', 'Keşif', 'Syslog'].map((c) => (
                      <button key={c} className="nm-btn ghost" style={{ height: 26, fontSize: 11, padding: '0 10px' }}>{c}</button>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Gauge({ label, value, warnAt }: { label: string; value: number | null; warnAt: number }) {
  const v = value ?? 0
  const cls = value == null ? '' : v > warnAt ? 'warn' : 'ok'
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className={`nm-gauge ${cls}`} style={{ flex: 1 }}><span style={{ width: `${v}%` }}></span></div>
        <span className="mono" style={{ fontSize: 11, width: 34, textAlign: 'right' }}>{value == null ? '—' : `${Math.round(v)}%`}</span>
      </div>
    </div>
  )
}

function Stat({ label, value, unit, warn, dim }: { label: string; value: string | number; unit?: string; warn?: boolean; dim?: boolean }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-3)', textTransform: 'uppercase' }}>{label}</div>
      <div className="mono" style={{ fontSize: 16, marginTop: 2, color: warn ? 'var(--warn)' : dim ? 'var(--fg-3)' : 'var(--fg-0)' }}>
        {value}{unit && <small style={{ fontSize: 10, color: 'var(--fg-3)' }}>{unit}</small>}
      </div>
    </div>
  )
}
