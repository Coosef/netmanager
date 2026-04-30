import { useState, useMemo, useEffect } from 'react'
import { Modal, Select, Button, Tag, Typography, Spin, Space, Divider, Alert, Tooltip } from 'antd'
import { DiffOutlined, SwapOutlined, FileTextOutlined, HistoryOutlined, ClockCircleOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import type { Device, ConfigBackup } from '@/types'
import { useTheme } from '@/contexts/ThemeContext'
import dayjs from 'dayjs'

const { Text } = Typography

// ── Myers / LCS diff ──────────────────────────────────────────────────────────
type DiffEntry = { type: 'same' | 'added' | 'removed'; text: string; lineA: number | null; lineB: number | null }

function diffLines(a: string[], b: string[]): DiffEntry[] {
  const MAX = 1200
  const aS = a.slice(0, MAX)
  const bS = b.slice(0, MAX)
  const m = aS.length, n = bS.length

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = aS[i - 1] === bS[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])

  const raw: { type: 'same' | 'added' | 'removed'; text: string }[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aS[i - 1] === bS[j - 1]) {
      raw.unshift({ type: 'same', text: aS[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.unshift({ type: 'added', text: bS[j - 1] })
      j--
    } else {
      raw.unshift({ type: 'removed', text: aS[i - 1] })
      i--
    }
  }
  for (let k = m; k < a.length; k++) raw.push({ type: 'removed', text: a[k] })
  for (let k = n; k < b.length; k++) raw.push({ type: 'added', text: b[k] })

  let lineA = 0, lineB = 0
  return raw.map((r) => {
    if (r.type === 'same')    { lineA++; lineB++; return { ...r, lineA, lineB } }
    if (r.type === 'removed') { lineA++;           return { ...r, lineA, lineB: null } }
    lineB++;                                        return { ...r, lineA: null, lineB }
  })
}

// ── Device + Version selector ─────────────────────────────────────────────────
function DeviceVersionSelector({
  devices,
  deviceId,
  backupId,
  onDeviceChange,
  onBackupChange,
  label,
  isDark,
}: {
  devices: Device[]
  deviceId: number | undefined
  backupId: number | undefined
  onDeviceChange: (id: number) => void
  onBackupChange: (id: number) => void
  label: string
  isDark: boolean
}) {
  const border = isDark ? '#1a3458' : '#e2e8f0'
  const muted = isDark ? '#64748b' : '#94a3b8'

  const { data: backups } = useQuery<ConfigBackup[]>({
    queryKey: ['backup-list', deviceId],
    queryFn: () => devicesApi.getBackups(deviceId!),
    enabled: !!deviceId,
    staleTime: 30_000,
  })

  // Auto-select latest backup when device changes
  useEffect(() => {
    if (backups && backups.length > 0 && !backupId) {
      onBackupChange(backups[0].id)
    }
  }, [backups, backupId])

  const selectedBackup = backups?.find((b) => b.id === backupId)

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <Text style={{ color: muted, fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 4 }}>
        {label}
      </Text>
      <Select
        showSearch
        placeholder="Cihaz seçin"
        style={{ width: '100%', marginBottom: 6 }}
        value={deviceId}
        onChange={(v) => { onDeviceChange(v); onBackupChange(undefined as unknown as number) }}
        options={devices.map((d) => ({ value: d.id, label: `${d.hostname} (${d.ip_address})` }))}
        filterOption={(input, opt) => String(opt?.label).toLowerCase().includes(input.toLowerCase())}
      />
      {deviceId && (
        <>
          {backups && backups.length > 0 ? (
            <Select
              style={{ width: '100%' }}
              value={backupId}
              onChange={onBackupChange}
              placeholder="Versiyon seçin"
              options={backups.map((b, idx) => ({
                value: b.id,
                label: (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ClockCircleOutlined style={{ color: muted, fontSize: 11 }} />
                    <span style={{ fontSize: 12 }}>{dayjs(b.created_at).format('DD.MM.YYYY HH:mm')}</span>
                    <span style={{ fontSize: 11, color: muted }}>· {Math.round((b.size_bytes || 0) / 1024)} KB</span>
                    {idx === 0 && <Tag style={{ fontSize: 10, margin: 0, lineHeight: '16px' }} color="blue">son</Tag>}
                  </div>
                ),
              }))}
            />
          ) : backups ? (
            <Text style={{ color: muted, fontSize: 11 }}>Bu cihazın yedeği yok</Text>
          ) : null}
          {selectedBackup && (
            <div style={{
              marginTop: 5, fontSize: 11, color: muted,
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 8px', background: isDark ? '#0e1e38' : '#f8fafc',
              border: `1px solid ${border}`, borderRadius: 4,
            }}>
              <FileTextOutlined />
              <span>{dayjs(selectedBackup.created_at).format('DD.MM.YYYY HH:mm:ss')}</span>
              <span>·</span>
              <span>{Math.round((selectedBackup.size_bytes || 0) / 1024)} KB</span>
              {selectedBackup.notes && <><span>·</span><span style={{ fontStyle: 'italic' }}>{selectedBackup.notes}</span></>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Diff line ─────────────────────────────────────────────────────────────────
function DiffLine({ line, isDark }: { line: DiffEntry & { hidden?: boolean }; isDark: boolean }) {
  const addBg  = isDark ? 'rgba(34,197,94,0.13)'  : 'rgba(34,197,94,0.10)'
  const remBg  = isDark ? 'rgba(239,68,68,0.13)'  : 'rgba(239,68,68,0.10)'
  const addBar = '#22c55e'
  const remBar = '#ef4444'
  const lineNumColor = isDark ? '#2a3f5a' : '#cbd5e1'
  const lineNumText  = isDark ? '#4b6280' : '#94a3b8'
  const sameTxt      = isDark ? '#94a3b8' : '#475569'

  const bg  = line.type === 'added' ? addBg : line.type === 'removed' ? remBg : 'transparent'
  const bar = line.type === 'added' ? addBar : line.type === 'removed' ? remBar : 'transparent'
  const signColor = line.type === 'added' ? addBar : line.type === 'removed' ? remBar : 'transparent'

  return (
    <div style={{ display: 'flex', background: bg, borderLeft: `3px solid ${bar}` }}>
      {/* Line number A */}
      <div style={{
        width: 40, flexShrink: 0, textAlign: 'right',
        padding: '0 6px', color: lineNumText, fontSize: 10,
        userSelect: 'none', borderRight: `1px solid ${lineNumColor}`,
        background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.03)',
      }}>
        {line.lineA ?? ''}
      </div>
      {/* Line number B */}
      <div style={{
        width: 40, flexShrink: 0, textAlign: 'right',
        padding: '0 6px', color: lineNumText, fontSize: 10,
        userSelect: 'none', borderRight: `1px solid ${lineNumColor}`,
        background: isDark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.03)',
      }}>
        {line.lineB ?? ''}
      </div>
      {/* Sign */}
      <div style={{ width: 18, flexShrink: 0, textAlign: 'center', color: signColor, fontWeight: 700, userSelect: 'none' }}>
        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
      </div>
      {/* Content */}
      <span style={{ color: line.type === 'same' ? sameTxt : undefined, whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, padding: '0 4px' }}>
        {line.text || ' '}
      </span>
    </div>
  )
}

// ── Main Modal ────────────────────────────────────────────────────────────────
export default function ConfigDiffModal({
  open,
  onClose,
  devices,
}: {
  open: boolean
  onClose: () => void
  devices: Device[]
}) {
  const { isDark } = useTheme()
  const [deviceA, setDeviceA] = useState<number | undefined>()
  const [backupA, setBackupA] = useState<number | undefined>()
  const [deviceB, setDeviceB] = useState<number | undefined>()
  const [backupB, setBackupB] = useState<number | undefined>()
  const [comparing, setComparing] = useState(false)
  const [diffResult, setDiffResult] = useState<DiffEntry[] | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [showContext, setShowContext] = useState(true)

  const border = isDark ? '#1a3458' : '#e2e8f0'
  const bgCode = isDark ? '#071224' : '#fafafa'
  const muted  = isDark ? '#64748b' : '#94a3b8'

  const devA = devices.find((d) => d.id === deviceA)
  const devB = devices.find((d) => d.id === deviceB)

  const handleCompare = async () => {
    if (!deviceA || !deviceB || !backupA || !backupB) return
    setComparing(true)
    setDiffResult(null)
    setErrorMsg(null)
    try {
      const [contentA, contentB] = await Promise.all([
        devicesApi.getBackupContent(deviceA, backupA),
        devicesApi.getBackupContent(deviceB, backupB),
      ])
      const linesA = contentA.config.split('\n')
      const linesB = contentB.config.split('\n')
      setDiffResult(diffLines(linesA, linesB))
    } catch {
      setErrorMsg('Yedek içeriği yüklenemedi')
    }
    setComparing(false)
  }

  const reset = () => {
    setDiffResult(null)
    setDeviceA(undefined); setBackupA(undefined)
    setDeviceB(undefined); setBackupB(undefined)
    setErrorMsg(null)
  }

  const stats = useMemo(() => {
    if (!diffResult) return null
    const added   = diffResult.filter((l) => l.type === 'added').length
    const removed = diffResult.filter((l) => l.type === 'removed').length
    const same    = diffResult.filter((l) => l.type === 'same').length
    return { added, removed, same }
  }, [diffResult])

  const visibleLines = useMemo(() => {
    if (!diffResult) return []
    if (showContext) return diffResult
    const changed = new Set<number>()
    diffResult.forEach((l, i) => {
      if (l.type !== 'same') {
        for (let k = Math.max(0, i - 3); k <= Math.min(diffResult.length - 1, i + 3); k++)
          changed.add(k)
      }
    })
    return diffResult.filter((_, i) => changed.has(i))
  }, [diffResult, showContext])

  const canCompare = !!(deviceA && deviceB && backupA && backupB &&
    !(deviceA === deviceB && backupA === backupB))
  const sameBackup = deviceA === deviceB && backupA === backupB && backupA !== undefined

  return (
    <Modal
      open={open}
      onCancel={() => { onClose(); reset() }}
      title={
        <Space>
          <DiffOutlined style={{ color: '#3b82f6' }} />
          Config Karşılaştırma
          <Tag style={{ fontSize: 10, margin: 0 }} color="blue" icon={<HistoryOutlined />}>Versiyon Geçmişi</Tag>
        </Space>
      }
      width={960}
      footer={null}
      styles={{ body: { padding: '16px 20px' } }}
    >
      {/* Device + Version selectors */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
        <DeviceVersionSelector
          devices={devices}
          deviceId={deviceA}
          backupId={backupA}
          onDeviceChange={(v) => { setDeviceA(v); setBackupA(undefined); setDiffResult(null) }}
          onBackupChange={(v) => { setBackupA(v); setDiffResult(null) }}
          label="Cihaz A — Eski / Referans Versiyon"
          isDark={isDark}
        />
        <div style={{ paddingTop: 24, flexShrink: 0 }}>
          <SwapOutlined style={{ color: muted, fontSize: 18 }} />
        </div>
        <DeviceVersionSelector
          devices={devices}
          deviceId={deviceB}
          backupId={backupB}
          onDeviceChange={(v) => { setDeviceB(v); setBackupB(undefined); setDiffResult(null) }}
          onBackupChange={(v) => { setBackupB(v); setDiffResult(null) }}
          label="Cihaz B — Yeni / Karşılaştırılan Versiyon"
          isDark={isDark}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <Button
          type="primary"
          icon={<DiffOutlined />}
          disabled={!canCompare}
          loading={comparing}
          onClick={handleCompare}
        >
          Karşılaştır
        </Button>
        {sameBackup && (
          <Text type="secondary" style={{ fontSize: 12 }}>Aynı yedek seçili — farklı versiyon seçin</Text>
        )}
        {!deviceA || !deviceB ? (
          <Text style={{ color: muted, fontSize: 12 }}>İki cihaz / versiyon seçin</Text>
        ) : null}
        {deviceA && deviceA === deviceB && (
          <Tag color="purple" style={{ fontSize: 11 }}>
            <HistoryOutlined style={{ marginRight: 4 }} />
            Aynı cihazın farklı versiyonları karşılaştırılıyor
          </Tag>
        )}
      </div>

      {errorMsg && <Alert type="error" message={errorMsg} showIcon style={{ marginBottom: 12 }} />}
      {comparing && <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="Karşılaştırılıyor…" /></div>}

      {/* Diff result */}
      {diffResult && stats && (
        <>
          <Divider style={{ margin: '8px 0', borderColor: border }} />

          {/* Stats header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <Text style={{ fontWeight: 600, fontSize: 13 }}>
              {devA?.hostname} → {devB?.hostname}
            </Text>
            <Tag color="green">+{stats.added} eklendi</Tag>
            <Tag color="red">-{stats.removed} silindi</Tag>
            <Tag color="default">{stats.same} aynı</Tag>
            {stats.added === 0 && stats.removed === 0 && (
              <Tag color="blue" icon={<FileTextOutlined />}>Konfigürasyonlar özdeş</Tag>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <Tooltip title="Değişen satırlar etrafında 3 satır bağlam göster">
                <Button
                  size="small"
                  type={showContext ? 'default' : 'primary'}
                  onClick={() => setShowContext((v) => !v)}
                >
                  {showContext ? 'Sadece Değişiklikler' : 'Tümünü Göster'}
                </Button>
              </Tooltip>
            </div>
          </div>

          {/* Column headers */}
          <div style={{
            display: 'flex',
            background: isDark ? '#0a1628' : '#f1f5f9',
            borderRadius: '6px 6px 0 0',
            border: `1px solid ${border}`,
            borderBottom: 'none',
            fontFamily: 'monospace',
            fontSize: 10,
            color: muted,
            userSelect: 'none',
          }}>
            <div style={{ width: 40, textAlign: 'center', padding: '4px 0', borderRight: `1px solid ${border}` }}>A#</div>
            <div style={{ width: 40, textAlign: 'center', padding: '4px 0', borderRight: `1px solid ${border}` }}>B#</div>
            <div style={{ width: 18 }} />
            <div style={{ flex: 1, padding: '4px 6px' }}>
              {devA?.hostname} → {devB?.hostname}
            </div>
          </div>

          {/* Diff output */}
          <div style={{
            fontFamily: 'monospace',
            fontSize: 12,
            lineHeight: '20px',
            border: `1px solid ${border}`,
            borderRadius: '0 0 6px 6px',
            overflow: 'hidden',
            maxHeight: 500,
            overflowY: 'auto',
            background: bgCode,
          }}>
            {visibleLines.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: muted }}>
                Gösterilecek değişiklik yok
              </div>
            ) : (
              visibleLines.map((line, idx) => (
                <DiffLine key={idx} line={line} isDark={isDark} />
              ))
            )}
          </div>

          <div style={{ marginTop: 6, fontSize: 11, color: muted, display: 'flex', gap: 12 }}>
            <span>Toplam {diffResult.length} satır</span>
            {!showContext && <span>· {visibleLines.length} satır gösteriliyor</span>}
          </div>
        </>
      )}
    </Modal>
  )
}
