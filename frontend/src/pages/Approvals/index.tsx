import { useState } from 'react'
import {
  Button, Modal, Popconfirm, Select, Space,
  Table, Tag, Tooltip, Input, message,
} from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined, StopOutlined,
  ExclamationCircleOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { approvalsApi, type ApprovalRequest } from '@/api/approvals'
import { useTheme } from '@/contexts/ThemeContext'
import dayjs from 'dayjs'


const APPROVALS_CSS = `
@keyframes aprRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.apr-row-pending td { background: rgba(245,158,11,0.04) !important; }
`

function mkC(isDark: boolean) {
  return {
    bg:     isDark ? '#1e293b' : '#ffffff',
    bg2:    isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text:   isDark ? '#f1f5f9' : '#1e293b',
    muted:  isDark ? '#64748b' : '#94a3b8',
    dim:    isDark ? '#475569' : '#cbd5e1',
  }
}

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
  const C = mkC(isDark)
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

  const pendingItems = data?.items.filter(r => r.status === 'pending') ?? []
  const items = data?.items ?? []

  const columns = [
    {
      title: 'Risk',
      dataIndex: 'risk_level',
      width: 90,
      render: (v: string) => {
        const hex = RISK_HEX[v] || '#64748b'
        return <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>{v.toUpperCase()}</Tag>
      },
    },
    {
      title: 'Durum',
      dataIndex: 'status',
      width: 120,
      render: (s: string) => {
        const hex = STATUS_HEX[s] || '#64748b'
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: hex, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: C.text }}>{STATUS_LABEL[s] ?? s}</span>
          </span>
        )
      },
    },
    {
      title: 'Cihaz',
      dataIndex: 'device_hostname',
      width: 160,
      render: (v: string) => <span style={{ fontWeight: 600, fontSize: 12, color: C.text }}>{v}</span>,
    },
    {
      title: 'Komut',
      dataIndex: 'command',
      render: (v: string) => (
        <code style={{ fontSize: 12, background: isDark ? '#0f172a' : '#f0fdfa', color: isDark ? '#4ec9b0' : '#0d9488', padding: '2px 6px', borderRadius: 3, border: `1px solid ${isDark ? '#134e4a' : '#99f6e4'}` }}>
          {v}
        </code>
      ),
    },
    {
      title: 'Talep Eden',
      dataIndex: 'requester_username',
      width: 120,
      render: (v: string) => <span style={{ fontSize: 12, color: C.muted }}>{v}</span>,
    },
    {
      title: 'Tarih',
      dataIndex: 'created_at',
      width: 130,
      render: (v: string) => <span style={{ fontSize: 12, color: C.muted }}>{dayjs(v).format('DD.MM HH:mm')}</span>,
    },
    {
      title: 'Bitiş',
      dataIndex: 'expires_at',
      width: 130,
      render: (v: string) => {
        const expired = dayjs(v).isBefore(dayjs())
        return <span style={{ fontSize: 12, color: expired ? '#ef4444' : C.muted }}>{dayjs(v).format('DD.MM HH:mm')}</span>
      },
    },
    {
      title: 'İşlemler',
      width: 180,
      render: (_: unknown, r: ApprovalRequest) => (
        <Space>
          {r.status === 'pending' && (
            <>
              <Tooltip title="Onayla ve çalıştır">
                <Popconfirm
                  title={<>Komut cihazda çalıştırılacak:<br /><code>{r.command}</code></>}
                  onConfirm={() => approveMutation.mutate(r.id)}
                  okText="Onayla"
                  cancelText="Vazgeç"
                >
                  <Button size="small" type="primary" icon={<CheckCircleOutlined />}
                    loading={approveMutation.isPending} />
                </Popconfirm>
              </Tooltip>
              <Tooltip title="Reddet">
                <Button size="small" danger icon={<CloseCircleOutlined />}
                  onClick={() => { setRejectTarget(r); setRejectNote('') }} />
              </Tooltip>
              <Tooltip title="İptal (talep sahibi)">
                <Button size="small" icon={<StopOutlined />}
                  loading={cancelMutation.isPending}
                  onClick={() => cancelMutation.mutate(r.id)} />
              </Tooltip>
            </>
          )}
          <Button size="small" onClick={() => setDetailModal(r)}>Detay</Button>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{APPROVALS_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#f59e0b20' : C.border}`,
        borderLeft: '4px solid #f59e0b',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#f59e0b20', border: '1px solid #f59e0b30',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <CheckCircleOutlined style={{ color: '#f59e0b', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>
              Onay Talepleri
              {pendingItems.length > 0 && (
                <Tag style={{ marginLeft: 8, fontSize: 11, color: '#ef4444', borderColor: '#ef444450', background: '#ef444418' }}>
                  {pendingItems.length} bekliyor
                </Tag>
              )}
            </div>
            <div style={{ color: C.muted, fontSize: 12 }}>Komut onay kuyruğu — 15s otomatik yenileme</div>
          </div>
        </div>
        <Space>
          <Select
            allowClear
            placeholder="Durum filtrele"
            style={{ width: 160 }}
            value={statusFilter}
            onChange={setStatusFilter}
            size="small"
            options={[
              { label: 'Bekliyor', value: 'pending' },
              { label: 'Çalıştırıldı', value: 'executed' },
              { label: 'Reddedildi', value: 'rejected' },
              { label: 'İptal', value: 'cancelled' },
              { label: 'Süresi Doldu', value: 'expired' },
            ]}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()}>Yenile</Button>
        </Space>
      </div>

      {pendingItems.length > 0 && (
        <div style={{
          background: isDark ? '#1e293b' : '#fffbeb',
          border: `1px solid ${isDark ? '#78350f' : '#fde68a'}`,
          borderLeft: '3px solid #f59e0b',
          borderRadius: 8, padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <ExclamationCircleOutlined style={{ color: '#f59e0b' }} />
          <span style={{ fontSize: 13, color: C.text }}>
            <strong style={{ color: '#f59e0b' }}>{pendingItems.length}</strong> onay bekleyen komut var. Aşağıdan inceleyip onaylayabilir veya reddedebilirsiniz.
          </span>
        </div>
      )}

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <Table
          dataSource={items}
          rowKey="id"
          loading={isLoading}
          columns={columns}
          size="small"
          pagination={{ pageSize: 20 }}
          rowClassName={(r) => r.status === 'pending' ? 'apr-row-pending' : ''}
          onRow={() => ({ style: { animation: 'aprRowIn 0.2s ease-out' } })}
        />
      </div>

      {/* Reject Modal */}
      <Modal
        title={<Space><CloseCircleOutlined style={{ color: '#ef4444' }} /><span style={{ color: C.text }}>Talebi Reddet</span></Space>}
        open={!!rejectTarget}
        onCancel={() => setRejectTarget(null)}
        onOk={() => rejectTarget && rejectMutation.mutate({ id: rejectTarget.id, note: rejectNote })}
        confirmLoading={rejectMutation.isPending}
        okText="Reddet"
        okButtonProps={{ danger: true }}
        styles={{ content: { background: C.bg, border: `1px solid ${C.border}` }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}
      >
        <div style={{ marginBottom: 8 }}>
          <code style={{ background: isDark ? '#0f172a' : '#f0fdfa', color: isDark ? '#4ec9b0' : '#0d9488', padding: '2px 8px', borderRadius: 3, border: `1px solid ${isDark ? '#134e4a' : '#99f6e4'}` }}>
            {rejectTarget?.command}
          </code>
        </div>
        <div style={{ marginBottom: 8, color: C.muted, fontSize: 13 }}>Reddetme nedeni (opsiyonel):</div>
        <Input.TextArea
          rows={3}
          value={rejectNote}
          onChange={(e) => setRejectNote(e.target.value)}
          placeholder="Neden reddedildi?"
        />
      </Modal>

      {/* Detail Modal */}
      <Modal
        title={<span style={{ color: C.text }}>Onay Talebi Detayı</span>}
        open={!!detailModal}
        onCancel={() => setDetailModal(null)}
        footer={<Button onClick={() => setDetailModal(null)}>Kapat</Button>}
        width={700}
        styles={{ content: { background: C.bg, border: `1px solid ${C.border}` }, header: { background: C.bg, borderBottom: `1px solid ${C.border}` } }}
      >
        {detailModal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              {[
                { label: 'Durum', node: (() => { const hex = STATUS_HEX[detailModal.status] || '#64748b'; return <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: hex }} /><span style={{ fontSize: 12, color: C.text }}>{STATUS_LABEL[detailModal.status] ?? detailModal.status}</span></span> })() },
                { label: 'Risk', node: (() => { const hex = RISK_HEX[detailModal.risk_level] || '#64748b'; return <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>{detailModal.risk_level.toUpperCase()}</Tag> })() },
                { label: 'Cihaz', node: <span style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>{detailModal.device_hostname}</span> },
              ].map(({ label, node }) => (
                <div key={label} style={{ flex: 1, background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px' }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{label}</div>
                  {node}
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Komut</div>
              <code style={{ fontSize: 13, background: isDark ? '#0f172a' : '#f0fdfa', color: isDark ? '#4ec9b0' : '#0d9488', padding: '4px 10px', borderRadius: 4, display: 'inline-block', border: `1px solid ${isDark ? '#134e4a' : '#99f6e4'}` }}>
                {detailModal.command}
              </code>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>Talep Eden</div>
                <span style={{ color: C.text }}>{detailModal.requester_username}</span>
              </div>
              {detailModal.reviewer_username && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>İnceleyen</div>
                  <span style={{ color: C.text }}>{detailModal.reviewer_username}</span>
                </div>
              )}
            </div>
            {detailModal.review_note && (
              <div>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>Not</div>
                <span style={{ color: C.text }}>{detailModal.review_note}</span>
              </div>
            )}
            {detailModal.result_output && (
              <div>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Komut Çıktısı</div>
                <pre style={{ background: '#0f172a', color: detailModal.result_success ? '#d4d4d4' : '#f48771', padding: '8px 12px', borderRadius: 4, fontSize: 11, maxHeight: 200, overflow: 'auto', margin: 0, border: '1px solid #1e293b' }}>
                  {detailModal.result_output}
                </pre>
              </div>
            )}
            {detailModal.result_error && !detailModal.result_output && (
              <div>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Hata</div>
                <pre style={{ background: '#0f172a', color: '#f48771', padding: '8px 12px', borderRadius: 4, fontSize: 11, margin: 0, border: '1px solid #1e293b' }}>
                  {detailModal.result_error}
                </pre>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
