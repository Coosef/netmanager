import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Modal, Spin, Tag, Tooltip } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined, DiffOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { backupSchedulesApi, type DriftDiff, type DriftItem } from '@/api/backupSchedules'
import { useTheme } from '@/contexts/ThemeContext'

// ── Inline diff helpers ───────────────────────────────────────────────────────
type DiffEntry = { type: 'same' | 'added' | 'removed'; text: string; lineA: number | null; lineB: number | null }

function diffLines(a: string[], b: string[]): DiffEntry[] {
  const MAX = 1500
  const aS = a.slice(0, MAX), bS = b.slice(0, MAX)
  const m = aS.length, n = bS.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = aS[i-1] === bS[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1])
  const raw: { type: 'same' | 'added' | 'removed'; text: string }[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aS[i-1] === bS[j-1]) { raw.unshift({ type: 'same', text: aS[i-1] }); i--; j-- }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { raw.unshift({ type: 'added', text: bS[j-1] }); j-- }
    else { raw.unshift({ type: 'removed', text: aS[i-1] }); i-- }
  }
  for (let k = m; k < a.length; k++) raw.push({ type: 'removed', text: a[k] })
  for (let k = n; k < b.length; k++) raw.push({ type: 'added', text: b[k] })
  let lA = 0, lB = 0
  return raw.map((r) => {
    if (r.type === 'same')    { lA++; lB++; return { ...r, lineA: lA, lineB: lB } }
    if (r.type === 'removed') { lA++;        return { ...r, lineA: lA, lineB: null } }
    lB++; return { ...r, lineA: null, lineB: lB }
  })
}

function DiffModal({ open, onClose, diff, hostname, isDark }: {
  open: boolean; onClose: () => void; diff: DriftDiff | null; hostname: string; isDark: boolean
}) {
  const bg   = isDark ? '#0a0f1a' : '#f8fafc'
  const bdr  = isDark ? '#1a3458' : '#e2e8f0'
  const entries = diff
    ? diffLines(diff.golden_text.split('\n'), diff.latest_text.split('\n'))
    : []
  const changed = entries.filter(e => e.type !== 'same')

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={<span style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>Config Drift: {hostname}</span>}
      footer={<Button onClick={onClose}>Kapat</Button>}
      width={900}
      styles={{ body: { padding: 0 } }}
    >
      {!diff ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : (
        <>
          <div style={{ padding: '8px 16px', background: isDark ? '#0d1b2a' : '#f1f5f9', display: 'flex', gap: 24, fontSize: 12, color: isDark ? '#64748b' : '#94a3b8', borderBottom: `1px solid ${bdr}` }}>
            <span>Golden: <b style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>{dayjs(diff.golden_at).format('DD/MM/YYYY HH:mm')}</b></span>
            <span>Son Backup: <b style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>{dayjs(diff.latest_at).format('DD/MM/YYYY HH:mm')}</b></span>
            <span style={{ marginLeft: 'auto' }}><Tag color="error">-{entries.filter(e=>e.type==='removed').length}</Tag><Tag color="success">+{entries.filter(e=>e.type==='added').length}</Tag> satır değişti</span>
          </div>
          <div style={{ overflowY: 'auto', maxHeight: 520, fontFamily: 'monospace', fontSize: 12, background: bg }}>
            {changed.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#22c55e' }}>Hash uyuşmazlığı var ama satır farkı bulunamadı.</div>
            ) : (
              entries.map((e, idx) => {
                if (e.type === 'same') return null
                const bg2 = e.type === 'added'
                  ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)')
                  : (isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)')
                const col = e.type === 'added' ? '#22c55e' : '#ef4444'
                const prefix = e.type === 'added' ? '+' : '-'
                const lineNum = e.type === 'added' ? e.lineB : e.lineA
                return (
                  <div key={idx} style={{ display: 'flex', background: bg2, borderLeft: `3px solid ${col}` }}>
                    <span style={{ width: 42, textAlign: 'right', paddingRight: 8, color: isDark ? '#334155' : '#cbd5e1', userSelect: 'none', flexShrink: 0 }}>{lineNum}</span>
                    <span style={{ color: col, width: 16, flexShrink: 0 }}>{prefix}</span>
                    <span style={{ color: isDark ? '#e2e8f0' : '#1e293b', whiteSpace: 'pre-wrap', wordBreak: 'break-all', flex: 1 }}>{e.text}</span>
                  </div>
                )
              })
            )}
          </div>
        </>
      )}
    </Modal>
  )
}


export default function ConfigDriftPage() {
  const { isDark } = useTheme()
  const [diffDevice, setDiffDevice] = useState<{ id: number; hostname: string } | null>(null)
  const [diffData, setDiffData] = useState<DriftDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  const openDiff = async (item: DriftItem) => {
    setDiffDevice({ id: item.device_id, hostname: item.hostname })
    setDiffData(null)
    setDiffLoading(true)
    try {
      const d = await backupSchedulesApi.driftDiff(item.device_id)
      setDiffData(d)
    } catch { /* modal will show error state */ }
    finally { setDiffLoading(false) }
  }

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['config-drift'],
    queryFn: () => backupSchedulesApi.driftReport({ limit: 500 }),
    staleTime: 60_000,
  })

  const items = data?.items ?? []
  const changed = (data?.drift_count ?? 0) - (data?.no_backup_count ?? 0)

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Operasyon</span><span>Config Drift</span></div>
          <h1 className="nm-page-title">
            Config Drift Raporu
            {data && data.drift_count > 0 && <span className="nm-pill warn">{data.drift_count} sapma</span>}
          </h1>
          <div className="nm-page-sub">
            Altın baseline'dan sapma gösteren cihazlar — config değişmiş veya hiç yedeklenmemiş.
          </div>
        </div>
        <div className="nm-page-actions">
          <button className="nm-btn ghost" onClick={() => refetch()} disabled={isFetching}>
            <ReloadOutlined spin={isFetching} /> Tekrar Tara
          </button>
        </div>
      </div>

      {data && (
        <div className="nm-statbar">
          <div className="nm-stat"><div className="nm-stat-label">Altın Baseline</div><div className="nm-stat-val">{data.total_with_golden}</div><div className="nm-stat-delta">golden işaretli</div></div>
          <div className="nm-stat ok"><div className="nm-stat-label">Temiz</div><div className="nm-stat-val">{data.clean_count}<small>/ {data.total_with_golden}</small></div><div className="nm-stat-delta">drift yok</div></div>
          <div className="nm-stat warn"><div className="nm-stat-label">Config Değişmiş</div><div className="nm-stat-val">{changed}</div><div className="nm-stat-delta">hash mismatch</div></div>
          <div className="nm-stat crit"><div className="nm-stat-label">Backup Yok</div><div className="nm-stat-val">{data.no_backup_count}</div><div className="nm-stat-delta">hiç yedeklenmemiş</div></div>
          <div className="nm-stat warn"><div className="nm-stat-label">Drift Toplam</div><div className="nm-stat-val">{data.drift_count}</div></div>
          <div className="nm-stat"><div className="nm-stat-label">Tarama</div><div className="nm-stat-val mono" style={{ fontSize: 18 }}>{isFetching ? '…' : 'OK'}</div><div className="nm-stat-delta">son: az önce</div></div>
        </div>
      )}

      {isLoading ? (
        <div style={{ padding: 60, textAlign: 'center' }}><Spin size="large" /></div>
      ) : !data || data.total_with_golden === 0 ? (
        <Alert type="info" showIcon style={{ marginTop: 12 }}
          message="Altın baseline yok"
          description="Drift tespiti için cihazların golden config'i işaretlenmiş olması gerekir. Yedekleme Merkezi'nden bir backup'ı 'Golden' olarak işaretleyin." />
      ) : data.drift_count === 0 ? (
        <Alert type="success" showIcon icon={<CheckCircleOutlined />}
          message="Tüm cihazlar temiz — drift tespit edilmedi" style={{ marginTop: 12 }} />
      ) : (
        <div className="nm-table-wrap">
          <div className="nm-table-toolbar">
            <span className="count"><em>{items.length}</em> cihazda config sapması</span>
            <span style={{ color: 'var(--fg-3)', marginLeft: 'auto', fontSize: 11 }}>
              {isFetching ? 'Yükleniyor…' : ' '}
            </span>
          </div>
          <div style={{ overflow: 'auto' }}>
            <table className="nm-table">
              <thead>
                <tr>
                  <th>Cihaz</th>
                  <th>Vendor</th>
                  <th>Lokasyon</th>
                  <th>Durum</th>
                  <th>Sebep</th>
                  <th>Son Backup</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const isHashMismatch = r.reason === 'hash_mismatch'
                  return (
                    <tr key={r.device_id}>
                      <td>
                        <div className="nm-host">{r.hostname}</div>
                        {r.ip && <div className="nm-host-ip">{r.ip}</div>}
                      </td>
                      <td>{r.vendor ? <span className="nm-pill">{r.vendor}</span> : <span style={{ color: 'var(--fg-3)' }}>—</span>}</td>
                      <td style={{ fontSize: 11.5 }}>{r.site || <span style={{ color: 'var(--fg-3)' }}>—</span>}</td>
                      <td>
                        <span className={`nm-pill ${r.device_status === 'online' ? 'ok' : r.device_status === 'offline' ? 'crit' : ''}`}>
                          {r.device_status || '—'}
                        </span>
                      </td>
                      <td>
                        {isHashMismatch ? (
                          <span className="nm-pill warn"><WarningOutlined /> Config Değişmiş</span>
                        ) : (
                          <span className="nm-pill crit"><CloseCircleOutlined /> Backup Yok</span>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                        {r.latest_backup_at ? (
                          <Tooltip title={dayjs(r.latest_backup_at).format('DD.MM.YYYY HH:mm:ss')}>
                            {dayjs(r.latest_backup_at).fromNow()}
                          </Tooltip>
                        ) : 'Hiç yedeklenmemiş'}
                      </td>
                      <td className="col-actions">
                        <span className="nm-rowact" onClick={(e) => e.stopPropagation()}>
                          {isHashMismatch && (
                            <Tooltip title="Diff göster">
                              <button onClick={() => openDiff(r)}><DiffOutlined /></button>
                            </Tooltip>
                          )}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <DiffModal
        open={diffDevice !== null}
        onClose={() => { setDiffDevice(null); setDiffData(null) }}
        diff={diffLoading ? null : diffData}
        hostname={diffDevice?.hostname ?? ''}
        isDark={isDark}
      />
    </div>
  )
}
