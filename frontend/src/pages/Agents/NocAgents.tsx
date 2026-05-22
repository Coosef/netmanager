// NocAgents — T8.4 NOC design Agents page (mockup pages-rest.jsx AgentsPage).
// Faithful copy of the design (nm-page / nm-statbar / agent card grid with
// nm-gauge CPU/RAM + 4-stat block) wired to REAL data. Previous AgentsPage
// (full mgmt: create/delete/detail drawer/security) is preserved in git +
// still mounted from index via the "Yönet" action drawer is out-of-scope here;
// this is the inventory/overview surface the mockup specifies.
import { useMemo, useState } from 'react'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { App, Modal, Input, Button, Typography, Select, Alert, Descriptions, Space, Popconfirm } from 'antd'
import { agentsApi, type Agent } from '@/api/agents'
import { devicesApi } from '@/api/devices'
import { useSite } from '@/contexts/SiteContext'
import { useTheme } from '@/contexts/ThemeContext'
import { useTranslation } from 'react-i18next'
import { RobotOutlined, CopyOutlined, ConsoleSqlOutlined, WindowsOutlined, DownloadOutlined, DeleteOutlined } from '@ant-design/icons'
import AgentDetailModal from './AgentDetailModal'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)
const { Text } = Typography

const hb = (iso: string | null) => (iso ? dayjs(iso).fromNow(true) : '—')

export default function NocAgents() {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const { locations, activeLocationId } = useSite()
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLoc, setNewLoc] = useState<number | undefined>(undefined)
  const [createdAgent, setCreatedAgent] = useState<(Agent & { agent_key: string }) | null>(null)
  const [detailAgent, setDetailAgent] = useState<Agent | null>(null)
  const [detailTab, setDetailTab] = useState<string | undefined>(undefined)
  const openDetail = (a: Agent, tab?: string) => { setDetailTab(tab); setDetailAgent(a) }
  const createMut = useMutation({
    mutationFn: (vars: { name: string; location_id?: number }) => agentsApi.create(vars),
    onSuccess: (a) => {
      setCreatedAgent(a as Agent & { agent_key: string })
      setCreateOpen(false); setNewName(''); setNewLoc(undefined)
      qc.invalidateQueries({ queryKey: ['agents-list'] })
      message.success('Ajan oluşturuldu')
    },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Ajan oluşturulamadı'),
  })
  const delMut = useMutation({
    mutationFn: (id: string) => agentsApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents-list'] }); message.success('Ajan silindi') },
    onError: (e) => message.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Ajan silinemedi'),
  })
  const submitCreate = () => {
    const name = newName.trim()
    const location_id = newLoc ?? activeLocationId ?? undefined
    if (!name) { message.warning('Ajan adı gerekli'); return }
    if (location_id == null) { message.warning('Lokasyon seçin'); return }
    createMut.mutate({ name, location_id })
  }

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

      {/* Create agent modal (real: agentsApi.create — requires location_id) */}
      <Modal open={createOpen} title="Yeni Ajan Kur" onCancel={() => setCreateOpen(false)}
        onOk={submitCreate} confirmLoading={createMut.isPending} okText="Oluştur" cancelText="İptal"
        okButtonProps={{ disabled: !newName.trim() || (activeLocationId == null && newLoc == null) }}>
        <Input placeholder="Ajan adı (örn. agent-branch-ist)" value={newName} style={{ marginBottom: 12 }}
          onChange={(e) => setNewName(e.target.value)} onPressEnter={submitCreate} />
        <Select placeholder="Lokasyon seç (zorunlu — agent bir lokasyona bağlanır)" value={newLoc}
          onChange={setNewLoc} style={{ width: '100%' }}
          options={locations.map((l) => ({ label: l.name, value: l.id }))} />
        {activeLocationId != null && (
          <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 6 }}>Seçilmezse aktif lokasyon kullanılır.</div>
        )}
      </Modal>

      {/* Install instructions (ported from the original page — platform + one-liner + download) */}
      {createdAgent && <CreatedModal agent={createdAgent} onClose={() => setCreatedAgent(null)} />}

      {/* Detail/management modal (card click) — full per-agent management */}
      {detailAgent && <AgentDetailModal agent={detailAgent} initialTab={detailTab} onClose={() => setDetailAgent(null)} />}

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
              <div key={a.id} className="nm-card" style={{ cursor: 'pointer' }}
                onClick={() => openDetail(a)} title="Detayları aç">
                <div className="nm-card-hd">
                  <h3>
                    <span className={`nm-status-dot ${ok ? 'ok' : 'crit'}`}></span>
                    {a.name}
                    {a.version && <span className="nm-pill mono" style={{ fontSize: 9.5 }}>{a.version}</span>}
                  </h3>
                  <span onClick={(e) => e.stopPropagation()} style={{ marginLeft: 'auto' }}>
                    <Popconfirm title="Ajan silinsin mi?" description="Agent ve atamaları kaldırılır."
                      okText="Sil" cancelText="İptal" okButtonProps={{ danger: true }}
                      onConfirm={() => delMut.mutate(a.id)}>
                      <span className="nm-card-x" style={{ opacity: 1 }} title="Sil">
                        <DeleteOutlined />
                      </span>
                    </Popconfirm>
                  </span>
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
                    {([['SSH Akışı', 'stream'], ['SNMP', 'snmp'], ['Keşif', 'discovery'], ['Syslog', 'syslog']] as const).map(([label, tab]) => (
                      <button key={tab} className="nm-btn ghost" style={{ height: 26, fontSize: 11, padding: '0 10px' }}
                        onClick={(e) => { e.stopPropagation(); openDetail(a, tab) }}>{label}</button>
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

// ── CreatedModal — install instructions (ported verbatim from the original
//    AgentsPage so agent setup actually works: platform select + one-liner +
//    download + server URL). ──────────────────────────────────────────────
function mkC(isDark: boolean) {
  return {
    bg: isDark ? '#1e293b' : '#ffffff',
    bg2: isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text: isDark ? '#f1f5f9' : '#1e293b',
    muted: isDark ? '#64748b' : '#94a3b8',
  }
}

function CreatedModal({ agent, onClose }: { agent: Agent & { agent_key: string }; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const [platform, setPlatform] = useState<'linux' | 'windows' | null>(null)
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [serverUrl, setServerUrl] = useState(window.location.origin)
  const { t } = useTranslation()

  const copy = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text); setter(true); setTimeout(() => setter(false), 2000)
  }
  const base = serverUrl.trim().replace(/\/$/, '') || window.location.origin
  const downloadUrl = platform ? `${base}${agentsApi.downloadUrl(agent.id, agent.agent_key!, platform, base)}` : null
  const installCmd = platform === 'linux'
    ? `curl -fsSL '${downloadUrl}' | sudo bash`
    : platform === 'windows'
    ? `powershell -ExecutionPolicy Bypass -c "iwr -useb '${downloadUrl}' | iex"`
    : null

  return (
    <Modal open onCancel={onClose} footer={null} width={600}
      title={<Space><RobotOutlined style={{ color: '#3b82f6' }} /><span style={{ color: C.text }}>{t('agents.created_title')}</span></Space>}
      styles={{ content: { background: C.bg, border: `1px solid ${C.border}` }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}>
      <Alert type="warning" showIcon message={t('agents.created_warning')} style={{ marginBottom: 16 }} />
      <Descriptions column={1} bordered size="small" style={{ marginBottom: 20 }}>
        <Descriptions.Item label={t('agents.agent_id_label')}>
          <Space><code style={{ background: isDark ? '#0f172a' : '#f5f5f5', padding: '1px 6px', borderRadius: 3 }}>{agent.id}</code>
            <Button size="small" icon={<CopyOutlined />} onClick={() => copy(agent.id, () => {})} /></Space>
        </Descriptions.Item>
        <Descriptions.Item label={t('agents.agent_key_label')}>
          <Space><code style={{ wordBreak: 'break-all', background: isDark ? '#0f172a' : '#f5f5f5', padding: '1px 6px', borderRadius: 3 }}>{agent.agent_key}</code>
            <Button size="small" icon={<CopyOutlined />} onClick={() => copy(agent.agent_key!, () => {})} /></Space>
        </Descriptions.Item>
      </Descriptions>
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ display: 'block', marginBottom: 6, fontSize: 13, color: C.text }}>{t('agents.server_url_label')}</Text>
        <Input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://192.168.1.100:8000" addonBefore="URL" />
        <Text style={{ fontSize: 11, color: C.muted }}>{t('agents.server_url_hint')}</Text>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 12 }}>{t('agents.install_platform')}</div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        {[
          { key: 'linux' as const, icon: <ConsoleSqlOutlined style={{ fontSize: 28, color: '#f97316' }} />, label: t('agents.linux_label'), sub: t('agents.linux_sub') },
          { key: 'windows' as const, icon: <WindowsOutlined style={{ fontSize: 28, color: '#3b82f6' }} />, label: t('agents.windows_label'), sub: t('agents.windows_sub') },
        ].map((p) => {
          const selected = platform === p.key
          return (
            <div key={p.key} onClick={() => setPlatform(p.key)}
              style={{ flex: 1, textAlign: 'center', cursor: 'pointer', border: selected ? '2px solid #3b82f6' : `1px solid ${C.border}`,
                background: selected ? (isDark ? '#3b82f620' : '#eff6ff') : C.bg2, borderRadius: 8, padding: '14px 8px', transition: 'all 0.15s' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>{p.icon}</div>
              <Text strong style={{ color: C.text }}>{p.label}</Text><br />
              <Text style={{ fontSize: 11, color: C.muted }}>{p.sub}</Text>
            </div>
          )
        })}
      </div>
      {platform && installCmd && (
        <>
          <div style={{ marginBottom: 12 }}>
            <Text strong style={{ display: 'block', marginBottom: 6, fontSize: 13, color: C.text }}>{t('agents.oneliner_label')}</Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#0f172a', borderRadius: 8, padding: '10px 12px', border: '1px solid #334155' }}>
              <code style={{ flex: 1, fontSize: 11, color: '#e2e8f0', wordBreak: 'break-all', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{installCmd}</code>
              <Button size="small" icon={<CopyOutlined />} type={copiedCmd ? 'primary' : 'default'} onClick={() => copy(installCmd, setCopiedCmd)} style={{ flexShrink: 0 }}>
                {copiedCmd ? t('agents.copied') : t('agents.copy')}
              </Button>
            </div>
          </div>
          <Alert type="info" showIcon style={{ marginBottom: 12, fontSize: 12 }} message={platform === 'linux' ? t('agents.linux_hint') : t('agents.windows_hint')} />
          <Button type="default" icon={<DownloadOutlined />} block href={downloadUrl!} download>
            {platform === 'linux' ? t('agents.download_linux') : t('agents.download_windows')}
          </Button>
        </>
      )}
    </Modal>
  )
}
