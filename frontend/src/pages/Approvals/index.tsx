// Approvals — NOC redesign (T8.4 B1.4).
// Table → card grid: her onay talebi 'incident' boyutunda bir nesne; komut +
// gerekçe + son tarih kartta nefes alıyor. /monitor Uyarılar sayfasıyla aynı
// görsel dilde (severity stripe + sol border + body + action footer).
import { useMemo, useState } from 'react'
import {
  Button, Modal, Popconfirm, Select, Space,
  Tooltip, Input, message,
} from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined, StopOutlined,
  ReloadOutlined, ClockCircleOutlined,
  CodeOutlined, UserOutlined, EyeOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { approvalsApi, type ApprovalRequest } from '@/api/approvals'
import { useAuthStore } from '@/store/auth'
import { useTheme } from '@/contexts/ThemeContext'
import dayjs from 'dayjs'

const RISK_HEX: Record<string, string> = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' }
const STATUS_HEX: Record<string, string> = {
  pending: '#f59e0b', executed: '#22c55e', rejected: '#ef4444',
  cancelled: '#64748b', expired: '#475569',
}
const STATUS_LABEL: Record<string, string> = {
  pending: 'Bekliyor',
  executed: 'Çalıştırıldı',
  rejected: 'Reddedildi',
  cancelled: 'İptal',
  expired: 'Süresi Doldu',
}

export default function ApprovalsPage() {
  const qc = useQueryClient()
  const { isDark } = useTheme()
  // RBAC F10 — viewer + location_admin görür ama review edemez. Backend
  // 'approval:review' permission'ı org_admin + location_admin verir, ama
  // location_admin sadece atandığı lokasyondaki istekleri görür (RLS).
  const canReview = useAuthStore((s) => s.can('approvals', 'review'))
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
  const [detailModal, setDetailModal] = useState<ApprovalRequest | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const [rejectTarget, setRejectTarget] = useState<ApprovalRequest | null>(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['approvals', statusFilter],
    queryFn: () => approvalsApi.list({ status: statusFilter }),
    refetchInterval: 15000,
  })

  const approveMutation = useMutation({
    mutationFn: (id: number) => approvalsApi.approve(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['approvals'] })
      if (result.result_success) message.success('Komut onaylandı ve çalıştırıldı')
      else message.warning(`Komut çalıştırıldı ancak hata döndü: ${result.result_error}`)
      setDetailModal(result)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Onaylama başarısız'),
  })

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) => approvalsApi.reject(id, note),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] })
      message.success('Talep reddedildi')
      setRejectTarget(null)
      setRejectNote('')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Reddetme başarısız'),
  })

  const cancelMutation = useMutation({
    mutationFn: (id: number) => approvalsApi.cancel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] })
      message.success('Talep iptal edildi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'İptal başarısız'),
  })

  const items = data?.items ?? []

  // ── Real-data stats — pulled from the filtered + un-filtered list
  // (status filter changes the list; bekleyen/bugun stats use the active list
  // so the bar mirrors what the user is actually looking at). Avg response is
  // (reviewed_at - created_at) over items that have reviewed_at.
  const stats = useMemo(() => {
    const today = dayjs().startOf('day')
    const now = dayjs()
    const pending = items.filter((r) => r.status === 'pending').length
    const approvedToday = items.filter((r) =>
      r.status === 'executed' && r.reviewed_at && dayjs(r.reviewed_at).isAfter(today),
    ).length
    const rejectedToday = items.filter((r) =>
      r.status === 'rejected' && r.reviewed_at && dayjs(r.reviewed_at).isAfter(today),
    ).length
    const highRiskPending = items.filter((r) => r.status === 'pending' && r.risk_level === 'high').length
    const expiringSoon = items.filter((r) =>
      r.status === 'pending' && dayjs(r.expires_at).diff(now, 'minute') < 60,
    ).length

    // Avg response (dakika) for items with both timestamps in the visible list
    const responded = items.filter((r) => r.reviewed_at)
    const avgMs = responded.length === 0 ? 0
      : responded.reduce((s, r) => s + (dayjs(r.reviewed_at!).valueOf() - dayjs(r.created_at).valueOf()), 0) / responded.length
    const avgMin = Math.round(avgMs / 60_000)

    return { pending, approvedToday, rejectedToday, highRiskPending, expiringSoon, avgMin, total: items.length }
  }, [items])

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      {/* NOC header */}
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Yönetim</span><span>Onay Talepleri</span></div>
          <h1 className="nm-page-title">
            Onay Talepleri
            {stats.pending > 0 && (
              <span className="nm-pill mono" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>
                {stats.pending} bekliyor
              </span>
            )}
            <span className="nm-pill mono">{stats.total} toplam</span>
          </h1>
          <div className="nm-page-sub">
            Komut onay kuyruğu · 15s otomatik yenileme · talep eden bekliyor, gözden geç + uygula.
          </div>
        </div>
        <Space>
          <Select
            allowClear
            placeholder="Durum filtrele"
            style={{ width: 170 }}
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { label: 'Bekliyor', value: 'pending' },
              { label: 'Çalıştırıldı', value: 'executed' },
              { label: 'Reddedildi', value: 'rejected' },
              { label: 'İptal', value: 'cancelled' },
              { label: 'Süresi Doldu', value: 'expired' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>Yenile</Button>
        </Space>
      </div>

      {/* NOC stat bar — 6 real KPIs */}
      <div className="nm-statbar">
        <div className={`nm-stat ${stats.pending > 0 ? 'warn' : 'ok'}`}>
          <div className="nm-stat-label">BEKLEYEN</div>
          <div className="nm-stat-val">{stats.pending}</div>
          <div className="nm-stat-delta">onay kuyruğu</div>
        </div>
        <div className={`nm-stat ${stats.highRiskPending > 0 ? 'crit' : ''}`}>
          <div className="nm-stat-label">YÜKSEK RİSK</div>
          <div className="nm-stat-val">{stats.highRiskPending}</div>
          <div className="nm-stat-delta">pending · risk=high</div>
        </div>
        <div className={`nm-stat ${stats.expiringSoon > 0 ? 'warn' : ''}`}>
          <div className="nm-stat-label">YAKIN SÜRESİ DOLAN</div>
          <div className="nm-stat-val">{stats.expiringSoon}</div>
          <div className="nm-stat-delta">&lt; 60 dk</div>
        </div>
        <div className="nm-stat ok">
          <div className="nm-stat-label">BUGÜN ONAYLANAN</div>
          <div className="nm-stat-val">{stats.approvedToday}</div>
          <div className="nm-stat-delta">başarılı çalıştı</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">BUGÜN REDDEDİLEN</div>
          <div className="nm-stat-val">{stats.rejectedToday}</div>
          <div className="nm-stat-delta">manuel red</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">ORT. YANIT</div>
          <div className="nm-stat-val mono">{stats.avgMin > 0 ? `${stats.avgMin}` : '—'}</div>
          <div className="nm-stat-delta">{stats.avgMin > 0 ? 'dakika' : 'henüz veri yok'}</div>
        </div>
      </div>

      {/* Approval cards */}
      <div className="nm-card" style={{ padding: 0 }}>
        <div className="nm-card-hd">
          <h3><CheckCircleOutlined /> Talepler</h3>
          <span className="nm-pill mono">{items.length}</span>
        </div>
        <div style={{ padding: 12 }}>
          {isLoading && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--fg-3)' }}>Yükleniyor…</div>
          )}
          {!isLoading && items.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-3)' }}>
              <CheckCircleOutlined style={{ fontSize: 32, opacity: 0.4, display: 'block', margin: '0 auto 8px' }} />
              {statusFilter
                ? `'${STATUS_LABEL[statusFilter] ?? statusFilter}' durumunda talep yok`
                : 'Onay talebi yok — sakin liman'}
            </div>
          )}
          {!isLoading && items.length > 0 && (
            <div className="nm-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }}>
              {items.map((r) => (
                <ApprovalCard
                  key={r.id}
                  r={r}
                  onApprove={() => approveMutation.mutate(r.id)}
                  onReject={() => { setRejectTarget(r); setRejectNote('') }}
                  onCancel={() => cancelMutation.mutate(r.id)}
                  onDetail={() => setDetailModal(r)}
                  approveLoading={approveMutation.isPending}
                  cancelLoading={cancelMutation.isPending}
                  canReview={canReview}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Reject Modal */}
      <Modal
        title={<Space><CloseCircleOutlined style={{ color: 'var(--crit)' }} /><span>Talebi Reddet</span></Space>}
        open={!!rejectTarget}
        onCancel={() => setRejectTarget(null)}
        onOk={() => rejectTarget && rejectMutation.mutate({ id: rejectTarget.id, note: rejectNote })}
        confirmLoading={rejectMutation.isPending}
        okText="Reddet"
        okButtonProps={{ danger: true }}
      >
        <div style={{ marginBottom: 10 }}>
          <CommandCode command={rejectTarget?.command || ''} isDark={isDark} />
        </div>
        <div style={{ marginBottom: 8, color: 'var(--fg-2)', fontSize: 13 }}>Reddetme nedeni (opsiyonel):</div>
        <Input.TextArea
          rows={3}
          value={rejectNote}
          onChange={(e) => setRejectNote(e.target.value)}
          placeholder="Neden reddedildi?"
        />
      </Modal>

      {/* Detail Modal */}
      <Modal
        title="Onay Talebi Detayı"
        open={!!detailModal}
        onCancel={() => setDetailModal(null)}
        footer={<Button onClick={() => setDetailModal(null)}>Kapat</Button>}
        width={700}
      >
        {detailModal && <DetailBody r={detailModal} isDark={isDark} />}
      </Modal>
    </div>
  )
}

// ─── Approval card ───────────────────────────────────────────────────────────

function ApprovalCard({
  r, onApprove, onReject, onCancel, onDetail, approveLoading, cancelLoading, canReview,
}: {
  r: ApprovalRequest
  onApprove: () => void
  onReject: () => void
  onCancel: () => void
  onDetail: () => void
  approveLoading: boolean
  cancelLoading: boolean
  // RBAC F10 — false ⇒ Onayla / Reddet / İptal buttons hidden; viewer
  // only sees Detay.
  canReview: boolean
}) {
  const riskColor = RISK_HEX[r.risk_level] || 'var(--fg-3)'
  const statusColor = STATUS_HEX[r.status] || 'var(--fg-3)'
  const isPending = r.status === 'pending'
  const now = dayjs()
  const expiresIn = dayjs(r.expires_at).diff(now, 'minute')
  const expired = expiresIn < 0
  const expiringSoon = isPending && !expired && expiresIn < 60

  return (
    <div className="nm-card" style={{
      padding: 0, position: 'relative', overflow: 'hidden',
      borderLeft: `3px solid ${isPending ? riskColor : statusColor}`,
    }}>
      {/* Header bar: status dot + status label + risk pill (right) */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px', borderBottom: '1px solid var(--border-0)',
        background: isPending ? `${riskColor}08` : 'transparent',
      }}>
        <span className={`nm-status-dot ${isPending ? 'warn pulse' : ''}`}
          style={{ background: statusColor, boxShadow: isPending ? `0 0 8px ${statusColor}` : 'none' }} />
        <span style={{ fontSize: 12, color: 'var(--fg-1)', fontWeight: 500 }}>
          {STATUS_LABEL[r.status] ?? r.status}
        </span>
        <span style={{ flex: 1 }} />
        <span className="nm-pill mono" style={{
          color: riskColor, borderColor: riskColor + '88', background: riskColor + '15',
        }}>
          {r.risk_level.toUpperCase()}
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: 12 }}>
        {/* Device + ID */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-0)' }} className="mono">
            {r.device_hostname}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--fg-3)' }} className="mono">#{r.id}</span>
        </div>

        {/* Command */}
        <CommandCode command={r.command} />

        {/* Meta row: requester · created · expires countdown */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          marginTop: 10, fontSize: 11, color: 'var(--fg-3)',
        }}>
          <span><UserOutlined style={{ marginRight: 4 }} />{r.requester_username}</span>
          <span><ClockCircleOutlined style={{ marginRight: 4 }} />{dayjs(r.created_at).format('DD.MM HH:mm')}</span>
          {isPending && (
            <span style={{ color: expired ? 'var(--crit)' : expiringSoon ? 'var(--warn)' : 'var(--fg-3)' }}>
              <ClockCircleOutlined style={{ marginRight: 4 }} />
              {expired ? 'süresi doldu' : `${expiresIn} dk içinde dolar`}
            </span>
          )}
          {!isPending && r.reviewer_username && (
            <span>İnceleyen: <strong style={{ color: 'var(--fg-1)' }}>{r.reviewer_username}</strong></span>
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 12px', borderTop: '1px solid var(--border-0)',
        background: 'var(--bg-2)',
      }}>
        {isPending && canReview && (
          <>
            <Popconfirm
              title={<>Komut cihazda çalıştırılacak.<br />Onaylıyor musunuz?</>}
              onConfirm={onApprove}
              okText="Onayla" cancelText="Vazgeç"
            >
              <Button size="small" type="primary" icon={<CheckCircleOutlined />}
                loading={approveLoading}>
                Onayla
              </Button>
            </Popconfirm>
            <Button size="small" danger icon={<CloseCircleOutlined />} onClick={onReject}>
              Reddet
            </Button>
            <Tooltip title="İptal (talep sahibi)">
              <Button size="small" icon={<StopOutlined />}
                loading={cancelLoading} onClick={onCancel} />
            </Tooltip>
          </>
        )}
        {isPending && !canReview && (
          <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>
            Onaylama yetkiniz yok — sadece görüntüleme.
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Button size="small" type="text" icon={<EyeOutlined />} onClick={onDetail}>
          Detay
        </Button>
      </div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function CommandCode({ command, isDark }: { command: string; isDark?: boolean }) {
  return (
    <code style={{
      display: 'block', padding: '8px 10px', borderRadius: 4,
      fontSize: 12, fontFamily: 'IBM Plex Mono, monospace',
      background: isDark === false ? '#f0fdfa' : 'var(--bg-2)',
      color: isDark === false ? '#0d9488' : 'var(--accent-2, var(--accent))',
      border: '1px solid var(--border-0)', wordBreak: 'break-all', lineHeight: 1.5,
    }}>
      <CodeOutlined style={{ marginRight: 6, opacity: 0.6 }} />{command}
    </code>
  )
}

function DetailBody({ r, isDark }: { r: ApprovalRequest; isDark: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        <FieldChip label="Durum">
          <span className="nm-status-dot" style={{ background: STATUS_HEX[r.status], marginRight: 6 }} />
          {STATUS_LABEL[r.status] ?? r.status}
        </FieldChip>
        <FieldChip label="Risk">
          <span className="nm-pill mono" style={{
            color: RISK_HEX[r.risk_level], borderColor: RISK_HEX[r.risk_level] + '88',
            background: RISK_HEX[r.risk_level] + '15',
          }}>
            {r.risk_level.toUpperCase()}
          </span>
        </FieldChip>
        <FieldChip label="Cihaz">
          <span className="mono" style={{ fontWeight: 600 }}>{r.device_hostname}</span>
        </FieldChip>
      </div>
      <div>
        <FieldLabel>Komut</FieldLabel>
        <CommandCode command={r.command} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FieldChip label="Talep Eden">{r.requester_username}</FieldChip>
        {r.reviewer_username && (
          <FieldChip label="İnceleyen">{r.reviewer_username}</FieldChip>
        )}
        <FieldChip label="Oluşturuldu">
          <span className="mono">{dayjs(r.created_at).format('DD.MM.YYYY HH:mm')}</span>
        </FieldChip>
        <FieldChip label="Bitiş">
          <span className="mono" style={{ color: dayjs(r.expires_at).isBefore(dayjs()) ? 'var(--crit)' : undefined }}>
            {dayjs(r.expires_at).format('DD.MM.YYYY HH:mm')}
          </span>
        </FieldChip>
      </div>
      {r.review_note && (
        <div>
          <FieldLabel>İnceleme Notu</FieldLabel>
          <div style={{ color: 'var(--fg-1)' }}>{r.review_note}</div>
        </div>
      )}
      {r.result_output && (
        <div>
          <FieldLabel>Komut Çıktısı</FieldLabel>
          <pre style={{
            background: '#0f172a', color: r.result_success ? '#d4d4d4' : '#f48771',
            padding: '8px 12px', borderRadius: 4, fontSize: 11, maxHeight: 220,
            overflow: 'auto', margin: 0, border: '1px solid #1e293b',
          }}>{r.result_output}</pre>
        </div>
      )}
      {r.result_error && !r.result_output && (
        <div>
          <FieldLabel>Hata</FieldLabel>
          <pre style={{
            background: '#0f172a', color: '#f48771',
            padding: '8px 12px', borderRadius: 4, fontSize: 11,
            margin: 0, border: '1px solid #1e293b',
          }}>{r.result_error}</pre>
        </div>
      )}
      {/* Suppress isDark unused-warning when there are no themed children */}
      <span style={{ display: 'none' }}>{String(isDark)}</span>
    </div>
  )
}

function FieldChip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-2)', border: '1px solid var(--border-0)',
      borderRadius: 6, padding: '8px 12px',
    }}>
      <FieldLabel>{label}</FieldLabel>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, color: 'var(--fg-3)', letterSpacing: 0.5,
      textTransform: 'uppercase',
    }}>{children}</div>
  )
}
