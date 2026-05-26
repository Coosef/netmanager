import React, { useEffect, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import { useTaskProgress } from '@/hooks/useTaskProgress'
import {
  App, Button, Card, Col, Form, Input, Modal, Popconfirm, Progress, Row, Select, Space,
  Tag, Tooltip, Drawer, Alert, Radio,
} from 'antd'
import {
  PlusOutlined, ThunderboltOutlined, DeleteOutlined, EditOutlined, InboxOutlined, ApiOutlined,
  EyeOutlined, ReloadOutlined, KeyOutlined, CheckCircleFilled,
  CloseCircleFilled, QuestionCircleFilled, ExclamationCircleFilled,
  SaveOutlined, RobotOutlined, SyncOutlined, TagOutlined, InfoCircleOutlined,
  ApartmentOutlined,
  DatabaseOutlined, UploadOutlined, DownloadOutlined, FileTextOutlined,
  CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined,
  SwapOutlined, CodeOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import { useAuthStore } from '@/store/auth'
import { agentsApi } from '@/api/agents'
import { snmpApi } from '@/api/snmp'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import type { Device } from '@/types'
import { DEVICE_TYPE_OPTIONS } from '@/types'
import { useTranslation } from 'react-i18next'
import DeviceForm from './DeviceForm'
import MoveDeviceModal from './MoveDeviceModal'
import DeviceDetail from './DeviceDetail'
import OnboardingWizard from './OnboardingWizard'
import AutoGroupingModal from './AutoGroupingModal'
import { apiErr } from '@/utils/apiError'
import GroupProfileModal from './GroupProfileModal'
import dayjs from 'dayjs'


const { Search } = Input

const DEVICES_CSS = `
@keyframes devLedPulse {
  0%, 100% { box-shadow: 0 0 4px 1px #22c55e60; }
  50%       { box-shadow: 0 0 9px 2px #22c55e90; }
}
@keyframes devCardIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
`

const VENDOR_HEX: Record<string, string> = {
  cisco: '#1d6fa4', aruba: '#ff8300', ruijie: '#e4002b',
  fortinet: '#ee3124', paloalto: '#fa5b1b', mikrotik: '#0073a8',
  juniper: '#84b135', ubiquiti: '#0559c9', h3c: '#d10024',
  apc: '#6ab04c', other: '#64748b',
}

const STATUS_CONFIG: Record<string, { badge: 'success' | 'error' | 'default' | 'warning'; color: string; icon: React.ReactNode }> = {
  online:      { badge: 'success', color: '#52c41a', icon: <CheckCircleFilled style={{ color: '#52c41a' }} /> },
  offline:     { badge: 'error',   color: '#f5222d', icon: <CloseCircleFilled style={{ color: '#f5222d' }} /> },
  unknown:     { badge: 'default', color: '#8c8c8c', icon: <QuestionCircleFilled style={{ color: '#8c8c8c' }} /> },
  unreachable: { badge: 'warning', color: '#fa8c16', icon: <ExclamationCircleFilled style={{ color: '#fa8c16' }} /> },
}

const DEVICE_TYPE_COLOR: Record<string, string> = {
  switch: 'blue', router: 'green', firewall: 'red',
  ap: 'purple', ups: 'gold', server: 'cyan', other: 'default',
}

// T9 Tur 4 #7+#14 — Lifecycle state badge yardımcısı
const LIFECYCLE_CONFIG: Record<string, { label: string; color: string }> = {
  production: { label: 'Üretim',  color: '#16a34a' },
  passive:    { label: 'Pasif',   color: '#94a3b8' },
  stock:      { label: 'Stok',    color: '#0ea5e9' },
  archived:   { label: 'Arşiv',   color: '#64748b' },
}

function LifecycleBadge({ status }: { status?: string }) {
  const cfg = LIFECYCLE_CONFIG[status || 'production'] || LIFECYCLE_CONFIG.production
  return (
    <Tag color={cfg.color} style={{ fontSize: 10, lineHeight: '16px', padding: '0 6px', borderColor: 'transparent' }}>
      {cfg.label}
    </Tag>
  )
}

function DeviceCard({ device, isDark, onDetail, onEdit, onTest, onDelete, onArchive, utilization }: {
  device: Device
  isDark: boolean
  onDetail: () => void
  onEdit: () => void
  onTest: () => void
  onDelete: () => void
  onArchive: () => void
  utilization?: { maxPct: number; inPct: number; outPct: number }
}) {
  const accent = VENDOR_HEX[device.vendor?.toLowerCase() ?? ''] ?? VENDOR_HEX.other
  const statusColor = STATUS_CONFIG[device.status]?.color ?? '#8c8c8c'
  const isOnline = device.status === 'online'
  const cardBg = isDark
    ? `linear-gradient(135deg, ${accent}0a 0%, ${isDark ? '#1e293b' : '#fff'} 60%)`
    : '#ffffff'
  const borderColor = isDark ? `${accent}30` : '#e2e8f0'
  const textColor  = isDark ? '#f1f5f9' : '#1e293b'
  const mutedColor = isDark ? '#64748b' : '#94a3b8'
  const subColor   = isDark ? '#475569' : '#64748b'

  return (
    <div
      style={{
        background: cardBg,
        border: `1px solid ${borderColor}`,
        borderTop: `3px solid ${accent}`,
        borderRadius: 10,
        padding: '14px 16px 12px',
        position: 'relative',
        overflow: 'hidden',
        animation: 'devCardIn 0.35s ease-out',
        cursor: 'pointer',
        transition: 'box-shadow 0.2s, border-color 0.2s',
        boxShadow: isDark ? `0 2px 12px ${accent}0d` : '0 1px 4px rgba(0,0,0,0.06)',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement
        el.style.boxShadow = isDark ? `0 4px 20px ${accent}25` : `0 4px 16px rgba(0,0,0,0.1)`
        el.style.borderColor = accent + '60'
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement
        el.style.boxShadow = isDark ? `0 2px 12px ${accent}0d` : '0 1px 4px rgba(0,0,0,0.06)'
        el.style.borderColor = borderColor
      }}
      onClick={onDetail}
    >
      {/* Ambient glow */}
      {isDark && (
        <div style={{
          position: 'absolute', top: -20, right: -20,
          width: 100, height: 100, borderRadius: '50%',
          background: `radial-gradient(circle, ${accent}12, transparent 70%)`,
          pointerEvents: 'none',
        }} />
      )}

      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            {/* Status LED */}
            <div style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: statusColor,
              animation: isOnline ? 'devLedPulse 2.5s ease-in-out infinite' : undefined,
            }} />
            <span style={{ color: textColor, fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {device.hostname}
            </span>
            {/* T9 Tur 4 — Lifecycle badge */}
            {device.lifecycle_status && device.lifecycle_status !== 'production' && (
              <LifecycleBadge status={device.lifecycle_status} />
            )}
          </div>
          {device.alias && (
            <div style={{ color: mutedColor, fontSize: 11, marginLeft: 14 }}>{device.alias}</div>
          )}
        </div>
        <div style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: accent,
          textTransform: 'uppercase', flexShrink: 0, marginLeft: 6,
        }}>
          {device.vendor}
        </div>
      </div>

      {/* IP */}
      <div style={{
        fontFamily: 'monospace', fontSize: 12, color: isDark ? '#94a3b8' : '#64748b',
        background: isDark ? '#0f172a80' : '#f8fafc',
        border: `1px solid ${isDark ? '#1e2a3a' : '#e2e8f0'}`,
        borderRadius: 4, padding: '2px 6px', display: 'inline-block', marginBottom: 8,
      }}>
        {device.ip_address}
      </div>

      {/* Info rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
        {device.model && (
          <div style={{ fontSize: 11, color: subColor }}>
            <span style={{ color: mutedColor }}>Model: </span>{device.model}
          </div>
        )}
        {device.location && (
          <div style={{ fontSize: 11, color: subColor }}>
            <span style={{ color: mutedColor }}>Konum: </span>{device.location}
          </div>
        )}
        <div style={{ fontSize: 11, color: subColor }}>
          <span style={{ color: mutedColor }}>Son görülme: </span>
          {device.last_seen ? dayjs(device.last_seen).fromNow() : 'Hiç görülmedi'}
        </div>
      </div>

      {/* Tags row */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
        <Tag color={DEVICE_TYPE_COLOR[device.device_type] || 'default'} style={{ fontSize: 10, margin: 0 }}>
          {device.device_type?.toUpperCase()}
        </Tag>
        <Tag
          style={{ fontSize: 10, margin: 0, background: `${accent}15`, borderColor: `${accent}40`, color: accent }}
        >
          {device.os_type}
        </Tag>
        {device.tags?.split(',').filter(Boolean).slice(0, 2).map(t => (
          <Tag key={t} style={{ fontSize: 10, margin: 0 }}>{t.trim()}</Tag>
        ))}
      </div>

      {/* Bandwidth bar */}
      {utilization && (
        <div style={{ marginBottom: 8 }}>
          {(() => {
            const color = utilization.maxPct >= 80 ? '#ef4444' : utilization.maxPct >= 50 ? '#f59e0b' : '#22c55e'
            return (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ color: mutedColor, fontSize: 10, fontWeight: 600, letterSpacing: 0.5 }}>BANT</span>
                  <span style={{ color, fontSize: 10, fontWeight: 700 }}>{utilization.maxPct}%</span>
                </div>
                <div style={{ background: isDark ? '#0f172a80' : '#f1f5f9', borderRadius: 3, height: 4, overflow: 'hidden' }}>
                  <div style={{
                    background: `linear-gradient(90deg, ${color}80, ${color})`,
                    width: `${utilization.maxPct}%`, height: '100%', borderRadius: 3,
                    boxShadow: `0 0 6px ${color}50`,
                    transition: 'width 1s ease-out',
                  }} />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
                  <span style={{ color: mutedColor, fontSize: 10 }}>↓ {utilization.inPct}%</span>
                  <span style={{ color: mutedColor, fontSize: 10 }}>↑ {utilization.outPct}%</span>
                </div>
              </>
            )
          })()}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 4, borderTop: `1px solid ${isDark ? '#1e2a3a' : '#f1f5f9'}`, paddingTop: 8 }}
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip title="Detay"><Button size="small" type="text" icon={<EyeOutlined />} onClick={onDetail} /></Tooltip>
        <Tooltip title="Bağlantı Test"><Button size="small" type="text" icon={<ThunderboltOutlined style={{ color: '#faad14' }} />} onClick={onTest} /></Tooltip>
        <Tooltip title="Düzenle"><Button size="small" type="text" icon={<EditOutlined style={{ color: '#1677ff' }} />} onClick={onEdit} /></Tooltip>
        {/* T9 Tur 4 #8 — Port Yönetimi sayfası */}
        <Tooltip title="Port Yönetimi">
          <RouterLink to={`/devices/${device.id}/ports`} onClick={(e) => e.stopPropagation()}>
            <Button size="small" type="text" icon={<ApiOutlined style={{ color: '#06b6d4' }} />} />
          </RouterLink>
        </Tooltip>
        {/* T9 Tur 4 — Arşive Al (archived state'ine geçirir; super_admin geri açar) */}
        {device.lifecycle_status !== 'archived' && (
          <Popconfirm
            title="Arşive al"
            description="Cihaz arşive taşınır (geri yükleme yalnız super_admin). Devam edilsin mi?"
            onConfirm={onArchive}
            okButtonProps={{ danger: false }}
            okText="Arşive Al" cancelText="İptal"
          >
            <Tooltip title="Arşive Al">
              <Button size="small" type="text" icon={<InboxOutlined style={{ color: '#64748b' }} />} />
            </Tooltip>
          </Popconfirm>
        )}
        <Popconfirm title="Cihaz silinsin mi?" onConfirm={onDelete} okButtonProps={{ danger: true }}>
          <Button size="small" type="text" icon={<DeleteOutlined style={{ color: '#f5222d' }} />} />
        </Popconfirm>
      </div>
    </div>
  )
}

function BulkCredentialModal({
  selectedIds, onClose, onSuccess,
}: { selectedIds: number[]; onClose: () => void; onSuccess: () => void }) {
  const [form] = Form.useForm()
  const [mode, setMode] = useState<'source' | 'manual'>('source')
  const { t } = useTranslation()

  const { data: devicesData } = useQuery({
    queryKey: ['devices-all-for-cred'],
    queryFn: () => devicesApi.list({ limit: 2000 }),
  })

  const { message } = App.useApp()
  const mutation = useMutation({
    mutationFn: devicesApi.bulkUpdateCredentials,
    onSuccess: (res) => { message.success(t('devices.cred_updated', { count: res.updated })); onSuccess() },
    onError: (err: any) => message.error(apiErr(err, t('devices.cred_update_error'))),
  })

  const onFinish = (values: any) => {
    if (mode === 'source') {
      mutation.mutate({ device_ids: selectedIds, source_device_id: values.source_device_id })
    } else {
      mutation.mutate({ device_ids: selectedIds, ssh_username: values.ssh_username, ssh_password: values.ssh_password, enable_secret: values.enable_secret })
    }
  }

  const deviceOptions = (devicesData?.items || [])
    .filter((d: Device) => !selectedIds.includes(d.id))
    .map((d: Device) => ({ label: `${d.hostname} (${d.ip_address})`, value: d.id }))

  return (
    <Modal open onCancel={onClose} title={t('devices.cred_update_title', { count: selectedIds.length })} footer={null} width={500} destroyOnHidden>
      <Alert type="info" message={t('devices.cred_update_info')} style={{ marginBottom: 16, fontSize: 12 }} showIcon />
      <Radio.Group value={mode} onChange={(e) => { setMode(e.target.value); form.resetFields() }} style={{ marginBottom: 16 }}>
        <Radio.Button value="source">{t('devices.cred_source')}</Radio.Button>
        <Radio.Button value="manual">{t('devices.cred_manual')}</Radio.Button>
      </Radio.Group>
      <Form form={form} layout="vertical" onFinish={onFinish}>
        {mode === 'source' ? (
          <Form.Item label={t('devices.source_device')} name="source_device_id" rules={[{ required: true }]}>
            <Select showSearch options={deviceOptions} filterOption={(i, o) => (o?.label as string)?.toLowerCase().includes(i.toLowerCase())} placeholder={t('devices.source_device_placeholder')} />
          </Form.Item>
        ) : (
          <>
            <Form.Item label={t('devices.ssh_username')} name="ssh_username" rules={[{ required: true }]}>
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item label={t('devices.ssh_password')} name="ssh_password" rules={[{ required: true }]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item label={t('devices.enable_secret')} name="enable_secret">
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </>
        )}
        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" loading={mutation.isPending} block>{t('devices.cred_update_title', { count: selectedIds.length })}</Button>
        </Form.Item>
      </Form>
    </Modal>
  )
}

function BulkAgentModal({
  selectedIds, onClose, onSuccess,
}: { selectedIds: number[]; onClose: () => void; onSuccess: () => void }) {
  const [agentId, setAgentId] = useState<string>('')
  const { message } = App.useApp()
  const { t } = useTranslation()

  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })

  const mutation = useMutation({
    mutationFn: () => devicesApi.bulkUpdateAgent(selectedIds, agentId || null),
    onSuccess: (res) => {
      message.success(t('devices.agent_updated', { count: res.updated }))
      onSuccess()
    },
    onError: (err: any) => message.error(apiErr(err, t('common.error'))),
  })

  const agentOptions = [
    { label: `— ${t('devices.no_agent')} (direkt SSH) —`, value: '' },
    ...agents.map((a) => ({
      label: (
        <Space size={4}>
          <RobotOutlined style={{ color: a.status === 'online' ? '#52c41a' : '#f5222d' }} />
          {a.name}
          <Tag color={a.status === 'online' ? 'success' : 'error'} style={{ fontSize: 10 }}>{a.status}</Tag>
        </Space>
      ),
      value: a.id,
    })),
  ]

  return (
    <Modal
      open
      onCancel={onClose}
      title={<Space><RobotOutlined />{t('devices.bulk_agent_title', { count: selectedIds.length })}</Space>}
      onOk={() => mutation.mutate()}
      confirmLoading={mutation.isPending}
      okText={t('common.save')}
    >
      <Alert type="info" showIcon message={t('devices.bulk_agent_info')} style={{ marginBottom: 16, fontSize: 12 }} />
      <Select
        style={{ width: '100%' }}
        value={agentId}
        onChange={setAgentId}
        options={agentOptions}
        placeholder={t('devices.select_agent')}
      />
    </Modal>
  )
}

// ── BulkFetchProgressModal ─────────────────────────────────────────────────────

interface FetchResult {
  device_id: number
  hostname: string
  success: boolean
  error?: string
  updates?: Record<string, string>
  progress: number
  total: number
}

function BulkFetchProgressModal({
  deviceIds,
  onClose,
}: {
  deviceIds: number[]
  onClose: () => void
}) {
  const { isDark } = useTheme()
  const [results, setResults] = React.useState<FetchResult[]>([])
  const [done, setDone] = React.useState(false)
  const [summary, setSummary] = React.useState<{ succeeded: number; failed: number } | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const total = deviceIds.length
  const progress = results.length

  React.useEffect(() => {
    const controller = new AbortController()
    const token = useAuthStore.getState().token

    const run = async () => {
      try {
        const res = await fetch(devicesApi.bulkFetchInfoStream, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ device_ids: deviceIds }),
          signal: controller.signal,
        })
        if (!res.ok) {
          const text = await res.text()
          setError(`Sunucu hatası: ${res.status} — ${text}`)
          setDone(true)
          return
        }
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done: streamDone, value } = await reader.read()
          if (streamDone) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const data = JSON.parse(line.slice(6))
              if (data.done) {
                setSummary({ succeeded: data.succeeded, failed: data.failed })
                setDone(true)
              } else {
                setResults(prev => [...prev, data as FetchResult])
              }
            } catch {
              // malformed SSE line — skip
            }
          }
        }
      } catch (e: any) {
        if (e?.name !== 'AbortError') {
          setError(e?.message || 'Bağlantı kesildi')
          setDone(true)
        }
      }
    }
    run()
    return () => controller.abort()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const C = {
    bg: isDark ? '#1e293b' : '#ffffff',
    bg2: isDark ? '#0f172a' : '#f8fafc',
    border: isDark ? '#334155' : '#e2e8f0',
    text: isDark ? '#f1f5f9' : '#1e293b',
    muted: isDark ? '#64748b' : '#94a3b8',
  }

  const pct = total > 0 ? Math.round((progress / total) * 100) : 0
  const succeeded = summary?.succeeded ?? results.filter(r => r.success).length
  const failed = summary?.failed ?? results.filter(r => !r.success).length

  return (
    <Modal
      open
      title={
        <Space>
          <SyncOutlined spin={!done} style={{ color: '#1677ff' }} />
          <span style={{ color: C.text }}>Toplu Bilgi Güncelleme</span>
        </Space>
      }
      onCancel={done ? onClose : undefined}
      closable={done}
      maskClosable={false}
      footer={
        done ? (
          <Button type="primary" onClick={onClose}>Kapat</Button>
        ) : null
      }
      width={580}
      styles={{
        content: { background: C.bg },
        header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: C.muted, marginBottom: 4 }}>
          <span>{done ? 'Tamamlandı' : 'İşleniyor…'}</span>
          <span>{progress} / {total} cihaz</span>
        </div>
        <Progress
          percent={pct}
          status={done ? (failed > 0 ? 'exception' : 'success') : 'active'}
          strokeColor={done && failed === 0 ? '#22c55e' : undefined}
          showInfo={false}
        />
        {done && summary && (
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12 }}>
            <span style={{ color: '#22c55e' }}>
              <CheckCircleOutlined style={{ marginRight: 4 }} />{succeeded} başarılı
            </span>
            {failed > 0 && (
              <span style={{ color: '#ef4444' }}>
                <CloseCircleOutlined style={{ marginRight: 4 }} />{failed} başarısız
              </span>
            )}
          </div>
        )}
        {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
      </div>

      <div style={{
        maxHeight: 320, overflowY: 'auto',
        background: C.bg2, border: `1px solid ${C.border}`,
        borderRadius: 8, padding: '4px 0',
      }}>
        {results.length === 0 && !done && (
          <div style={{ textAlign: 'center', padding: '24px 0', color: C.muted, fontSize: 12 }}>
            <LoadingOutlined style={{ marginRight: 6 }} />Cihazlara bağlanılıyor…
          </div>
        )}
        {results.map((r) => (
          <div
            key={r.device_id}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '6px 14px',
              borderBottom: `1px solid ${C.border}`,
            }}
          >
            <span style={{ marginTop: 1, flexShrink: 0 }}>
              {r.success
                ? <CheckCircleOutlined style={{ color: '#22c55e' }} />
                : <CloseCircleOutlined style={{ color: '#ef4444' }} />
              }
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600, fontSize: 12, color: C.text }}>{r.hostname}</span>
              {r.success && r.updates && Object.keys(r.updates).length > 0 && (
                <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>
                  {Object.entries(r.updates).map(([k, v]) => (
                    <Tag key={k} style={{ fontSize: 10, marginRight: 4, marginTop: 2 }}>
                      {k}: {v}
                    </Tag>
                  ))}
                </div>
              )}
              {r.success && (!r.updates || Object.keys(r.updates).length === 0) && (
                <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>Yeni bilgi bulunamadı</div>
              )}
              {!r.success && (
                <div style={{ fontSize: 11, color: '#ef4444', marginTop: 1 }}>{r.error}</div>
              )}
            </div>
          </div>
        ))}
        {done && results.length === 0 && (
          <div style={{ textAlign: 'center', padding: '16px 0', color: C.muted, fontSize: 12 }}>Sonuç yok</div>
        )}
      </div>
    </Modal>
  )
}

export default function DevicesPage() {
  const { message } = App.useApp()
  const { isDark } = useTheme()
  const { t } = useTranslation()
  const { activeSite } = useSite()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState(searchParams.get('search') || '')

  useEffect(() => {
    const s = searchParams.get('search')
    if (s) setSearch(s)
  }, [searchParams])
  const [vendor, setVendor] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [deviceTypeFilter, setDeviceTypeFilter] = useState<string>()
  const [tag, setTag] = useState<string>()
  const [page, setPage] = useState(1)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editDevice, setEditDevice] = useState<Device | null>(null)
  const [detailDevice, setDetailDevice] = useState<Device | null>(null)
  // RBAC F9 — single source for mutating action visibility. Mirrors backend
  // `device:*` grant map (SYSTEM_ROLE_PERMISSIONS). Viewer sees no
  // mutating button at all; location_admin sees edit/connect/move but
  // not delete; org_admin/super_admin see everything.
  const can = useAuthStore((s) => s.can)
  const canEdit    = useAuthStore((s) => s.can('devices', 'edit'))
  const canCreate  = useAuthStore((s) => s.can('devices', 'create'))
  const canDelete  = useAuthStore((s) => s.can('devices', 'delete'))
  const canConnect = useAuthStore((s) => s.can('devices', 'connect'))
  const canMoveDevice = useAuthStore((s) => s.can('devices', 'move'))
  // Bulk operations (CSV import, sihirbaz, group profile, bulk fetch) —
  // mutate many devices at once; gate on the strictest verb (`edit`).
  const canBulk = canEdit
  // `can` is referenced from inside JSX too (drawer actions); silence the
  // unused-var warning while keeping the destructured handle.
  void can
  const [moveDevice, setMoveDevice] = useState<Device | null>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [bulkCredOpen, setBulkCredOpen] = useState(false)
  const [bulkAgentOpen, setBulkAgentOpen] = useState(false)
  const [bulkFetchOpen, setBulkFetchOpen] = useState(false)
  const [backupTaskId, setBackupTaskId] = useState<number | null>(null)
  const [csvImportOpen, setCsvImportOpen] = useState(false)
  const [csvFile, setCsvFile] = useState<File | null>(null)
  const [csvResult, setCsvResult] = useState<{ created: number; updated: number; total_rows: number; errors: { row: number; ip?: string; error: string }[] } | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [autoGroupOpen, setAutoGroupOpen] = useState(false)
  const [groupProfileOpen, setGroupProfileOpen] = useState(false)
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table')
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  const [bulkTagValue, setBulkTagValue] = useState('')
  const [bulkTagAction, setBulkTagAction] = useState<'add' | 'remove'>('add')
  const pageSize = 50

  useTaskProgress(backupTaskId, {
    title: 'Toplu Yedek',
    invalidateKeys: [['devices'], ['devices-stats']],
    onDone: () => setBackupTaskId(null),
  })

  const { data, isLoading } = useQuery({
    queryKey: ['devices', search, vendor, status, deviceTypeFilter, tag, page, activeSite],
    queryFn: () => devicesApi.list({ search: search || undefined, vendor, status, device_type: deviceTypeFilter, tag, skip: (page - 1) * pageSize, limit: pageSize, site: activeSite || undefined }),
    refetchInterval: 30000,
  })

  // Stats — fetch all for counters
  const { data: allData } = useQuery({
    queryKey: ['devices-stats', activeSite],
    queryFn: () => devicesApi.list({ limit: 2000, site: activeSite || undefined }),
    staleTime: 30000,
  })

  const stats = React.useMemo(() => {
    const items: Device[] = allData?.items || []
    return {
      total: allData?.total || 0,
      online: items.filter(d => d.status === 'online').length,
      offline: items.filter(d => d.status === 'offline').length,
      unknown: items.filter(d => d.status === 'unknown' || d.status === 'unreachable').length,
    }
  }, [allData])

  // SNMP utilization data for inline bandwidth bars
  const { data: snmpTopData } = useQuery({
    queryKey: ['devices-snmp-utilization'],
    queryFn: () => snmpApi.getTopInterfaces({ limit: 500, threshold: 0 }),
    staleTime: 60000,
    refetchInterval: 120000,
  })

  const utilizationMap = React.useMemo(() => {
    const map = new Map<number, { maxPct: number; inPct: number; outPct: number }>()
    for (const iface of snmpTopData?.items ?? []) {
      const existing = map.get(iface.device_id)
      if (!existing || iface.max_pct > existing.maxPct) {
        map.set(iface.device_id, {
          maxPct: Math.round(iface.max_pct),
          inPct:  Math.round(iface.in_pct),
          outPct: Math.round(iface.out_pct),
        })
      }
    }
    return map
  }, [snmpTopData])

  // Collect unique tags from all devices for the tag filter dropdown
  const allTags = React.useMemo(() => {
    const tagSet = new Set<string>()
    ;(allData?.items || []).forEach((d: Device) => {
      if (d.tags) d.tags.split(',').forEach(t => { const trimmed = t.trim(); if (trimmed) tagSet.add(trimmed) })
    })
    return Array.from(tagSet).sort().map(t => ({ label: t, value: t }))
  }, [allData])

  const deleteMutation = useMutation({
    mutationFn: devicesApi.delete,
    onSuccess: () => { message.success(t('devices.deleted')); queryClient.invalidateQueries({ queryKey: ['devices'] }); queryClient.invalidateQueries({ queryKey: ['devices-stats'] }) },
    onError: (err: any) => message.error(apiErr(err, t('devices.delete_error'))),
  })

  // T9 Tur 4 #7+#14 — Lifecycle state transition (archived dahil)
  const lifecycleMutation = useMutation({
    mutationFn: ({ id, state, reason }: { id: number; state: string; reason?: string }) =>
      devicesApi.updateLifecycle(id, state, reason),
    onSuccess: (d) => {
      message.success(`${d.hostname}: ${LIFECYCLE_CONFIG[d.lifecycle_status || 'production']?.label || d.lifecycle_status}`)
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      queryClient.invalidateQueries({ queryKey: ['devices-stats'] })
    },
    onError: (err: any) => message.error(apiErr(err, 'Yaşam döngüsü değiştirilemedi')),
  })

  const bulkDeleteMutation = useMutation({
    mutationFn: devicesApi.bulkDelete,
    onSuccess: () => {
      message.success(t('common.success'))
      setSelectedRowKeys([])
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      queryClient.invalidateQueries({ queryKey: ['devices-stats'] })
    },
    onError: (err: any) => message.error(apiErr(err, t('devices.bulk_delete_error'))),
  })

  const bulkTagMutation = useMutation({
    mutationFn: ({ tag, action }: { tag: string; action: 'add' | 'remove' }) =>
      devicesApi.bulkTag(selectedRowKeys as number[], tag, action),
    onSuccess: (res) => {
      message.success(`${res.updated} cihaz güncellendi — etiket "${res.tag}" ${res.action === 'add' ? 'eklendi' : 'kaldırıldı'}`)
      setBulkTagOpen(false)
      setBulkTagValue('')
      setSelectedRowKeys([])
      queryClient.invalidateQueries({ queryKey: ['devices'] })
    },
    onError: (err: any) => message.error(apiErr(err, t('common.error'))),
  })

  const bulkBackupMutation = useMutation({
    mutationFn: devicesApi.bulkBackup,
    onSuccess: (res) => {
      setBackupTaskId(res.task_id)
      setSelectedRowKeys([])
    },
    onError: (err: any) => message.error(apiErr(err, t('common.error'))),
  })

  const testMutation = useMutation({
    mutationFn: devicesApi.testConnection,
    onSuccess: (result) => {
      if (result.success) message.success(`${result.hostname} — Bağlantı başarılı (${result.latency_ms?.toFixed(0)}ms)`)
      else message.error(`${result.hostname} — ${result.message}`)
    },
  })

  const fetchInfoMutation = useMutation({
    mutationFn: devicesApi.fetchInfo,
    onSuccess: (device) => {
      message.success(`${device.hostname} — bilgiler güncellendi`)
      queryClient.invalidateQueries({ queryKey: ['devices'] })
    },
    onError: (err: any) => message.error(apiErr(err, t('common.error'))),
  })


  const csvImportMutation = useMutation({
    mutationFn: (file: File) => devicesApi.importCsv(file),
    onSuccess: (res) => {
      setCsvResult(res)
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      queryClient.invalidateQueries({ queryKey: ['devices-stats'] })
    },
    onError: (err: any) => message.error(apiErr(err, 'CSV import hatası')),
  })

  const exportCsv = () => {
    const items: Device[] = allData?.items || []
    if (items.length === 0) { message.warning('Dışa aktarılacak cihaz yok'); return }
    const HEADERS = ['id','hostname','ip_address','vendor','os_type','device_type','model','serial_number','layer','site','building','floor','status','last_seen','snmp_enabled','snmp_version','location','description','tags']
    const escape = (v: unknown) => {
      const s = v == null ? '' : String(v)
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
    }
    const rows = [HEADERS.join(','), ...items.map(d => HEADERS.map(h => escape((d as any)[h])).join(','))]
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `devices-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click()
    document.body.removeChild(a); URL.revokeObjectURL(url)
    message.success(`${items.length} cihaz dışa aktarıldı`)
  }

  const hasSelection = selectedRowKeys.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Page header (NOC design) */}
      <div className="nm-page-hd">
        <div>
          <div className="nm-crumbs"><span>Envanter</span><span>Cihazlar</span></div>
          <h1 className="nm-page-title">
            {t('devices.title')}
            <span className="nm-pill accent mono">{stats.total} {t('devices.records', 'kayıt')}</span>
          </h1>
          <div className="nm-page-sub">{t('devices.subtitle', 'Multi-vendor envanter — SSH bağlantı testi, otomatik yedek, vendor algılama ve agent ataması.')}</div>
        </div>
      </div>

      {/* Stat bar (NOC design) */}
      <div className="nm-statbar">
        <div className="nm-stat ok">
          <div className="nm-stat-label">{t('devices.stat_online')}</div>
          <div className="nm-stat-val">{stats.online}<small>/ {stats.total}</small></div>
          <div className="nm-stat-delta">{stats.total ? Math.round(stats.online / stats.total * 100) : 0}% filo</div>
        </div>
        <div className="nm-stat crit">
          <div className="nm-stat-label">{t('devices.stat_offline')}</div>
          <div className="nm-stat-val">{stats.offline}</div>
          <div className="nm-stat-delta">çevrimdışı</div>
        </div>
        <div className="nm-stat warn">
          <div className="nm-stat-label">{t('devices.stat_unknown')}</div>
          <div className="nm-stat-val">{stats.unknown}</div>
          <div className="nm-stat-delta">unreachable</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('devices.stat_total')}</div>
          <div className="nm-stat-val">{stats.total}</div>
          <div className="nm-stat-delta">yönetilen cihaz</div>
        </div>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <Space wrap>
          {hasSelection && canBulk && (
            <>
              <Tag color="blue" style={{ padding: '4px 10px', fontSize: 13 }}>{t('devices.selected', { count: selectedRowKeys.length })}</Tag>
              <Button icon={<TagOutlined />} onClick={() => setBulkTagOpen(true)} style={{ borderColor: '#13c2c2', color: '#008080' }}>
                Etiket İşlemi
              </Button>
              <Button icon={<RobotOutlined />} onClick={() => setBulkAgentOpen(true)} style={{ borderColor: '#722ed1', color: '#531dab' }}>
                {t('devices.bulk_agent')}
              </Button>
              <Button icon={<KeyOutlined />} onClick={() => setBulkCredOpen(true)} style={{ borderColor: '#faad14', color: '#d46b08' }}>
                {t('devices.cred_update')}
              </Button>
              <Popconfirm
                title={t('devices.bulk_backup_confirm', { count: selectedRowKeys.length })}
                onConfirm={() => bulkBackupMutation.mutate(selectedRowKeys as number[])}
              >
                <Button icon={<SaveOutlined />} loading={bulkBackupMutation.isPending} style={{ borderColor: '#52c41a', color: '#389e0d' }}>
                  {t('devices.bulk_backup')}
                </Button>
              </Popconfirm>
              <Button
                icon={<InfoCircleOutlined />}
                onClick={() => setBulkFetchOpen(true)}
                style={{ borderColor: '#1677ff', color: '#0958d9' }}
              >
                {t('devices.bulk_fetch_info')}
              </Button>
              <Popconfirm
                title={t('devices.bulk_delete_confirm', { count: selectedRowKeys.length })}
                description={t('devices.bulk_delete_desc')}
                onConfirm={() => bulkDeleteMutation.mutate(selectedRowKeys as number[])}
                okButtonProps={{ danger: true }}
              >
                <Button danger icon={<DeleteOutlined />} loading={bulkDeleteMutation.isPending}>
                  {t('devices.bulk_delete')}
                </Button>
              </Popconfirm>
            </>
          )}
        </Space>
        <Space wrap>
          <Search placeholder={t('devices.search_placeholder')} allowClear style={{ width: 220 }} onSearch={setSearch} onChange={(e) => !e.target.value && setSearch('')} />
          <Select placeholder={t('devices.filter_tag')} allowClear style={{ width: 130 }} value={tag} onChange={setTag}
            options={allTags}
            showSearch
            suffixIcon={<TagOutlined />}
          />
          <Select placeholder="Cihaz Tipi" allowClear style={{ width: 130 }} onChange={setDeviceTypeFilter}
            options={DEVICE_TYPE_OPTIONS}
          />
          <Select placeholder="Vendor" allowClear style={{ width: 110 }} onChange={setVendor}
            options={[
              { label: 'Cisco', value: 'cisco' }, { label: 'Aruba', value: 'aruba' },
              { label: 'Ruijie', value: 'ruijie' }, { label: 'Fortinet', value: 'fortinet' },
              { label: 'Palo Alto', value: 'paloalto' }, { label: 'MikroTik', value: 'mikrotik' },
              { label: 'Juniper', value: 'juniper' }, { label: 'Ubiquiti', value: 'ubiquiti' },
              { label: 'H3C / HPE', value: 'h3c' }, { label: 'APC', value: 'apc' },
              { label: 'Diğer', value: 'other' },
            ]}
          />
          <Select placeholder="Durum" allowClear style={{ width: 110 }} onChange={setStatus}
            options={[{ label: 'Online', value: 'online' }, { label: 'Offline', value: 'offline' }, { label: 'Bilinmiyor', value: 'unknown' }]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => { queryClient.invalidateQueries({ queryKey: ['devices'] }); queryClient.invalidateQueries({ queryKey: ['devices-stats'] }) }} />
          <Tooltip title="Tüm cihazları CSV olarak indir">
            <Button icon={<DownloadOutlined />} onClick={exportCsv}>
              CSV Dışa Aktar
            </Button>
          </Tooltip>
          {canBulk && (
            <Tooltip title="CSV ile Toplu İçe Aktar">
              <Button icon={<UploadOutlined />} onClick={() => { setCsvFile(null); setCsvResult(null); setCsvImportOpen(true) }}>
                CSV İçe Aktar
              </Button>
            </Tooltip>
          )}
          {canCreate && (
            <Tooltip title="Adım adım rehberli ekleme">
              <Button icon={<ThunderboltOutlined />} onClick={() => setWizardOpen(true)}>Sihirbaz</Button>
            </Tooltip>
          )}
          {canBulk && (
            <Tooltip title="Site/katman/topolojiye göre otomatik grup önerileri">
              <Button icon={<ApartmentOutlined />} onClick={() => setAutoGroupOpen(true)}>Otomatik Grupla</Button>
            </Tooltip>
          )}
          {canBulk && (
            <Tooltip title="Gruptaki tüm cihazlara toplu credential profil ata">
              <Button icon={<KeyOutlined />} onClick={() => setGroupProfileOpen(true)}>Gruba Profil Ata</Button>
            </Tooltip>
          )}
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditDevice(null); setDrawerOpen(true) }}>{t('devices.add')}</Button>
          )}
          <Button.Group>
            <Tooltip title="Tablo Görünümü">
              <Button
                icon={<DatabaseOutlined />}
                type={viewMode === 'table' ? 'primary' : 'default'}
                onClick={() => setViewMode('table')}
              />
            </Tooltip>
            <Tooltip title="Kart Görünümü">
              <Button
                icon={<ApartmentOutlined />}
                type={viewMode === 'grid' ? 'primary' : 'default'}
                onClick={() => setViewMode('grid')}
              />
            </Tooltip>
          </Button.Group>
        </Space>
      </div>

      <style>{DEVICES_CSS}</style>

      {/* ── Card / Grid view ── */}
      {viewMode === 'grid' && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 14,
        }}>
          {(data?.items || []).map((device: Device) => (
            <DeviceCard
              key={device.id}
              device={device}
              isDark={isDark}
              onDetail={() => setDetailDevice(device)}
              onEdit={() => { setEditDevice(device); setDrawerOpen(true) }}
              onTest={() => testMutation.mutate(device.id)}
              onDelete={() => deleteMutation.mutate(device.id)}
              onArchive={() => lifecycleMutation.mutate({ id: device.id, state: 'archived' })}
              utilization={utilizationMap.get(device.id)}
            />
          ))}
        </div>
      )}

      {viewMode === 'table' && (
        <NocDeviceTable
          items={data?.items || []}
          total={data?.total ?? 0}
          loading={isLoading}
          page={page}
          pageSize={pageSize}
          onPage={setPage}
          selected={selectedRowKeys as number[]}
          onSelect={(ids) => setSelectedRowKeys(ids)}
          onDetail={(d) => setDetailDevice(d)}
          onEdit={(d) => { setEditDevice(d); setDrawerOpen(true) }}
          onTest={(d) => testMutation.mutate(d.id)}
          onMove={(d) => setMoveDevice(d)}
          onFetchInfo={(d) => fetchInfoMutation.mutate(d.id)}
          onDelete={(d) => deleteMutation.mutate(d.id)}
          testingId={testMutation.isPending ? (testMutation.variables as number | undefined) : undefined}
          fetchingId={fetchInfoMutation.isPending ? (fetchInfoMutation.variables as number | undefined) : undefined}
          canMove={canMoveDevice}
          canEdit={canEdit}
          canDelete={canDelete}
          canConnect={canConnect}
        />
      )}

      <Drawer title={editDevice ? t('devices.edit') : t('devices.add_new')} open={drawerOpen} onClose={() => setDrawerOpen(false)} width={520} destroyOnHidden>
        <DeviceForm device={editDevice} onSuccess={() => { setDrawerOpen(false); queryClient.invalidateQueries({ queryKey: ['devices'] }); queryClient.invalidateQueries({ queryKey: ['devices-stats'] }) }} />
      </Drawer>

      {/* Faz 8 Phase G — audited device-location move */}
      {moveDevice && (
        <MoveDeviceModal device={moveDevice} onClose={() => setMoveDevice(null)} />
      )}

      <OnboardingWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onSuccess={() => {
          setWizardOpen(false)
          queryClient.invalidateQueries({ queryKey: ['devices'] })
          queryClient.invalidateQueries({ queryKey: ['devices-stats'] })
        }}
      />

      <AutoGroupingModal
        open={autoGroupOpen}
        onClose={() => setAutoGroupOpen(false)}
      />

      <GroupProfileModal
        open={groupProfileOpen}
        onClose={() => setGroupProfileOpen(false)}
      />

      <Modal
        open={!!detailDevice}
        onCancel={() => setDetailDevice(null)}
        footer={null}
        width="90vw"
        style={{ top: 20, maxWidth: 1400 }}
        styles={{ body: { padding: '12px 16px', minHeight: '70vh' } }}
        title={
          <Space>
            <EyeOutlined />
            <span style={{ fontWeight: 700 }}>{detailDevice?.hostname}</span>
            {detailDevice && (
              <code style={{ background: isDark ? '#0f172a' : '#f5f5f5', padding: '1px 6px', borderRadius: 4, fontSize: 12 }}>
                {detailDevice.ip_address}
              </code>
            )}
          </Space>
        }
        destroyOnHidden
      >
        {detailDevice && <DeviceDetail device={detailDevice} />}
      </Modal>

      {bulkAgentOpen && (
        <BulkAgentModal
          selectedIds={selectedRowKeys as number[]}
          onClose={() => setBulkAgentOpen(false)}
          onSuccess={() => { setBulkAgentOpen(false); setSelectedRowKeys([]); queryClient.invalidateQueries({ queryKey: ['devices'] }) }}
        />
      )}

      {bulkCredOpen && (
        <BulkCredentialModal
          selectedIds={selectedRowKeys as number[]}
          onClose={() => setBulkCredOpen(false)}
          onSuccess={() => { setBulkCredOpen(false); setSelectedRowKeys([]); queryClient.invalidateQueries({ queryKey: ['devices'] }) }}
        />
      )}

      {bulkFetchOpen && (
        <BulkFetchProgressModal
          deviceIds={selectedRowKeys as number[]}
          onClose={() => {
            setBulkFetchOpen(false)
            setSelectedRowKeys([])
            queryClient.invalidateQueries({ queryKey: ['devices'] })
            queryClient.invalidateQueries({ queryKey: ['devices-stats'] })
          }}
        />
      )}

      {/* CSV Import Modal */}
      <Modal
        open={csvImportOpen}
        onCancel={() => setCsvImportOpen(false)}
        title={<Space><UploadOutlined style={{ color: '#1677ff' }} /><span>CSV ile Toplu Cihaz İçe Aktar</span></Space>}
        width={560}
        footer={
          csvResult ? (
            <Button type="primary" onClick={() => setCsvImportOpen(false)}>Kapat</Button>
          ) : (
            <Space>
              <Button onClick={() => setCsvImportOpen(false)}>İptal</Button>
              <Button
                type="primary"
                icon={<UploadOutlined />}
                disabled={!csvFile}
                loading={csvImportMutation.isPending}
                onClick={() => csvFile && csvImportMutation.mutate(csvFile)}
              >
                İçe Aktar
              </Button>
            </Space>
          )
        }
        destroyOnHidden
      >
        {!csvResult ? (
          <>
            <Alert
              type="info" showIcon style={{ marginBottom: 16, fontSize: 12 }}
              message="CSV dosyası ile yüzlerce cihazı tek seferde ekleyin veya güncelleyin."
              description="ip_address üzerinden eşleşme yapılır — aynı IP'ye sahip cihazlar güncellenir, yeni IP'ler eklenir."
            />
            <div style={{ marginBottom: 12 }}>
              <Button
                icon={<DownloadOutlined />} size="small" type="dashed"
                onClick={() => devicesApi.downloadImportTemplate()}
              >
                Şablon CSV İndir
              </Button>
              <span style={{ marginLeft: 8, fontSize: 11, color: '#8c8c8c' }}>
                (hostname, ip_address, vendor, os_type, ssh_username, ssh_password…)
              </span>
            </div>
            <div
              style={{
                border: '2px dashed #d9d9d9',
                borderRadius: 8,
                padding: '24px',
                textAlign: 'center',
                cursor: 'pointer',
                background: csvFile ? '#f6ffed' : undefined,
                borderColor: csvFile ? '#52c41a' : undefined,
              }}
              onClick={() => document.getElementById('csv-file-input')?.click()}
            >
              <input
                id="csv-file-input"
                type="file"
                accept=".csv,text/csv"
                style={{ display: 'none' }}
                onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
              />
              {csvFile ? (
                <Space direction="vertical" size={4}>
                  <FileTextOutlined style={{ fontSize: 32, color: '#52c41a' }} />
                  <div style={{ fontWeight: 600, color: '#52c41a' }}>{csvFile.name}</div>
                  <div style={{ fontSize: 11, color: '#8c8c8c' }}>{(csvFile.size / 1024).toFixed(1)} KB</div>
                </Space>
              ) : (
                <Space direction="vertical" size={4}>
                  <UploadOutlined style={{ fontSize: 32, color: '#bfbfbf' }} />
                  <div>CSV dosyasını buraya sürükleyin veya tıklayın</div>
                  <div style={{ fontSize: 11, color: '#8c8c8c' }}>UTF-8 veya Excel CSV desteklenir</div>
                </Space>
              )}
            </div>
          </>
        ) : (
          <>
            <Alert
              type={csvResult.errors.length === 0 ? 'success' : 'warning'}
              showIcon
              style={{ marginBottom: 16 }}
              message={`İçe aktarma tamamlandı: ${csvResult.created} oluşturuldu, ${csvResult.updated} güncellendi, ${csvResult.errors.length} hata`}
            />
            <Row gutter={12} style={{ marginBottom: 16 }}>
              {[
                { label: 'Oluşturulan', value: csvResult.created, color: '#22c55e' },
                { label: 'Güncellenen', value: csvResult.updated, color: '#3b82f6' },
                { label: 'Hata', value: csvResult.errors.length, color: '#ef4444' },
              ].map(s => (
                <Col span={8} key={s.label}>
                  <Card size="small" style={{ textAlign: 'center', border: `1px solid ${s.color}33` }}>
                    <div style={{ fontSize: 24, fontWeight: 700, color: s.color }}>{s.value}</div>
                    <div style={{ fontSize: 11 }}>{s.label}</div>
                  </Card>
                </Col>
              ))}
            </Row>
            {csvResult.errors.length > 0 && (
              <div style={{ maxHeight: 200, overflow: 'auto' }}>
                {csvResult.errors.map((e, i) => (
                  <Alert
                    key={i} type="error" style={{ marginBottom: 4, fontSize: 11 }}
                    message={`Satır ${e.row}${e.ip ? ` (${e.ip})` : ''}: ${e.error}`}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </Modal>

      {/* Bulk Tag Modal */}
      <Modal
        title={`Toplu Etiket İşlemi — ${selectedRowKeys.length} cihaz`}
        open={bulkTagOpen}
        onCancel={() => { setBulkTagOpen(false); setBulkTagValue('') }}
        onOk={() => bulkTagValue.trim() && bulkTagMutation.mutate({ tag: bulkTagValue.trim(), action: bulkTagAction })}
        okText={bulkTagAction === 'add' ? 'Ekle' : 'Kaldır'}
        confirmLoading={bulkTagMutation.isPending}
        okButtonProps={{ disabled: !bulkTagValue.trim() }}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          <Radio.Group
            value={bulkTagAction}
            onChange={(e) => setBulkTagAction(e.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="add">Etiket Ekle</Radio.Button>
            <Radio.Button value="remove">Etiket Kaldır</Radio.Button>
          </Radio.Group>
          <Select
            mode="tags"
            style={{ width: '100%' }}
            placeholder="Etiket girin veya mevcut etiketlerden seçin"
            options={allTags}
            value={bulkTagValue ? [bulkTagValue] : []}
            onChange={(vals) => setBulkTagValue(vals[vals.length - 1] || '')}
            maxCount={1}
            tokenSeparators={[',']}
          />
          <div style={{ fontSize: 12, color: '#8c8c8c' }}>
            {bulkTagAction === 'add'
              ? `Seçili ${selectedRowKeys.length} cihaza bu etiket eklenecek`
              : `Seçili ${selectedRowKeys.length} cihazdan bu etiket kaldırılacak`}
          </div>
        </Space>
      </Modal>
    </div>
  )
}

// ── NocDeviceTable — mockup-faithful nm-table inner content (T8.4) ─────────
//
// Replaces the previous antd <Table> while keeping every existing action
// wired through to the page's mutations. No new features — only the visual
// shell from pages-devices.jsx (`nm-table` columns: Hostname / Durum /
// Vendor·Model / Firmware / Katman / Lokasyon / Tag / Agent / Uptime /
// Actions). "Risk" and "24sa events" mockup columns are NOT added because
// our backend doesn't compute them — Uptime (availability_24h) and the
// status-cell `last_seen` cover the same intent with REAL data.

const STATUS_PILL: Record<string, { dot: 'ok' | 'warn' | 'crit' | ''; cls: 'ok' | 'warn' | 'crit' | ''; label: string }> = {
  online:      { dot: 'ok',   cls: 'ok',   label: 'Çevrimiçi' },
  offline:     { dot: 'crit', cls: 'crit', label: 'Çevrimdışı' },
  unreachable: { dot: 'warn', cls: 'warn', label: 'Ulaşılamıyor' },
  unknown:     { dot: '',     cls: '',     label: 'Bilinmiyor' },
}

function parseTags(raw?: string): string[] {
  if (!raw) return []
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
}

function NocDeviceTable({
  items, total, loading, page, pageSize, onPage,
  selected, onSelect,
  onDetail, onEdit, onTest, onMove, onFetchInfo, onDelete,
  testingId, fetchingId, canMove, canEdit, canDelete, canConnect,
}: {
  items: Device[]
  total: number
  loading: boolean
  page: number
  pageSize: number
  onPage: (p: number) => void
  selected: number[]
  onSelect: (ids: number[]) => void
  onDetail: (d: Device) => void
  onEdit: (d: Device) => void
  onTest: (d: Device) => void
  onMove: (d: Device) => void
  onFetchInfo: (d: Device) => void
  onDelete: (d: Device) => void
  testingId?: number
  fetchingId?: number
  // RBAC F9 — visibility flags per action verb. Viewer gets all false;
  // location_admin gets edit+connect+move (NOT delete); org_admin /
  // super_admin get all true. Mirrors backend SYSTEM_ROLE_PERMISSIONS.
  canMove: boolean
  canEdit: boolean
  canDelete: boolean
  canConnect: boolean
}) {
  const selectedSet = new Set(selected)
  const allChecked = items.length > 0 && items.every((d) => selectedSet.has(d.id))
  const toggleAll = () => {
    if (allChecked) onSelect(selected.filter((id) => !items.some((d) => d.id === id)))
    else onSelect(Array.from(new Set([...selected, ...items.map((d) => d.id)])))
  }
  const toggleOne = (id: number) => {
    if (selectedSet.has(id)) onSelect(selected.filter((x) => x !== id))
    else onSelect([...selected, id])
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="nm-table-wrap">
      <div className="nm-table-toolbar">
        {selected.length > 0 ? (
          <>
            <span className="count"><em>{selected.length}</em> cihaz seçildi</span>
            <span style={{ color: 'var(--fg-3)' }}>·</span>
            <span className="bulk" onClick={() => onSelect([])} style={{ cursor: 'pointer', marginLeft: 'auto' }}>Seçimi temizle</span>
          </>
        ) : (
          <>
            <span className="count"><em>{items.length}</em> kayıt gösteriliyor · <em>{total}</em> toplam</span>
            <span style={{ color: 'var(--fg-3)', marginLeft: 'auto', fontSize: 11 }}>{loading ? 'Yükleniyor…' : ' '}</span>
          </>
        )}
      </div>

      <div style={{ overflow: 'auto' }}>
        <table className="nm-table">
          <thead>
            <tr>
              <th className="col-check">
                <span className={`nm-checkbox ${allChecked ? 'on' : ''}`} onClick={toggleAll}>
                  <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8.5L6 11.5L13 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </th>
              <th>Hostname</th>
              <th>Durum</th>
              <th>Vendor / Model</th>
              <th>Firmware</th>
              <th>Katman</th>
              <th>Lokasyon</th>
              <th>Tag</th>
              <th>Agent</th>
              <th style={{ textAlign: 'right' }}>Uptime 24sa</th>
              <th className="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => {
              const st = STATUS_PILL[d.status] || STATUS_PILL.unknown
              const tags = parseTags(d.tags)
              const sel = selectedSet.has(d.id)
              const up = d.availability_24h
              return (
                <tr key={d.id} className={sel ? 'selected' : ''} style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    const t = e.target as HTMLElement
                    if (t.closest('.nm-checkbox') || t.closest('.nm-rowact')) return
                    onDetail(d)
                  }}>
                  <td className="col-check">
                    <span className={`nm-checkbox ${sel ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); toggleOne(d.id) }}>
                      <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                        <path d="M3 8.5L6 11.5L13 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  </td>
                  <td>
                    <div className="nm-host">{d.hostname}</div>
                    <div className="nm-host-ip">{d.ip_address}{d.alias && <> · <span style={{ color: 'var(--fg-2)' }}>{d.alias}</span></>}</div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      {/* Online → yeşil pulse, crit → kırmızı pulse (1.2s hızlı) */}
                      <span className={`nm-status-dot ${st.dot}${st.dot === 'ok' || st.dot === 'crit' ? ' pulse' : ''}`}></span>
                      <div>
                        <div style={{ fontSize: 11.5, color: st.cls ? `var(--${st.cls})` : 'var(--fg-1)' }}>{st.label}</div>
                        <div style={{ fontSize: 10, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
                          {d.last_seen ? `${dayjs(d.last_seen).fromNow(true)} önce` : '—'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div style={{ fontSize: 11.5, color: VENDOR_HEX[d.vendor] || 'var(--fg-0)', fontWeight: 500, textTransform: 'capitalize' }}>{d.vendor || '—'}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>{d.model || '—'}</div>
                  </td>
                  <td className="mono" style={{ fontSize: 11.5, color: 'var(--fg-1)' }}>{d.firmware_version || '—'}</td>
                  <td>{d.layer ? <span className="nm-tag">{d.layer}</span> : <span style={{ color: 'var(--fg-3)' }}>—</span>}</td>
                  <td style={{ fontSize: 11.5 }}>{d.site || d.location || '—'}</td>
                  <td>
                    {tags.slice(0, 2).map((tg) => <span key={tg} className="nm-tag">{tg}</span>)}
                    {tags.length > 2 && <span style={{ fontSize: 10, color: 'var(--fg-3)', marginLeft: 4 }}>+{tags.length - 2}</span>}
                    {tags.length === 0 && <span style={{ color: 'var(--fg-3)' }}>—</span>}
                  </td>
                  <td className="mono" style={{ fontSize: 10.5, color: d.agent_id ? 'var(--fg-1)' : 'var(--fg-3)' }}>
                    {d.agent_id ? d.agent_id.slice(0, 8) : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {up == null ? <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>—</span> : (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <div className="nm-bar" style={{ width: 50 }}>
                          <div style={{ width: `${Math.max(0, Math.min(100, up))}%`,
                            background: up >= 99 ? 'var(--ok)' : up >= 95 ? 'var(--warn)' : 'var(--crit)' }}></div>
                        </div>
                        <span className="mono" style={{ fontSize: 11, width: 38, textAlign: 'right' }}>{up.toFixed(1)}%</span>
                      </div>
                    )}
                  </td>
                  <td className="col-actions">
                    <span className="nm-rowact" onClick={(e) => e.stopPropagation()}>
                      <Tooltip title="Detay"><button onClick={() => onDetail(d)}><EyeOutlined /></button></Tooltip>
                      {canConnect && (
                        <Tooltip title="SSH Terminal (yeni sekme)">
                          <button onClick={() => window.open(`/ssh/${d.id}?hostname=${encodeURIComponent(d.hostname)}&ip=${encodeURIComponent(d.ip_address)}`, '_blank', 'noopener,noreferrer')}>
                            <CodeOutlined style={{ color: 'var(--ok)' }} />
                          </button>
                        </Tooltip>
                      )}
                      {canConnect && (
                        <Tooltip title="SSH Bağlantı Testi">
                          <button onClick={() => onTest(d)} disabled={testingId === d.id}><ThunderboltOutlined /></button>
                        </Tooltip>
                      )}
                      {canConnect && (
                        <Tooltip title="Cihazdan Bilgi Çek">
                          <button onClick={() => onFetchInfo(d)} disabled={fetchingId === d.id}><ReloadOutlined /></button>
                        </Tooltip>
                      )}
                      {canEdit && (
                        <Tooltip title="Düzenle"><button onClick={() => onEdit(d)}><EditOutlined /></button></Tooltip>
                      )}
                      {canMove && (
                        <Tooltip title="Lokasyon Taşı"><button onClick={() => onMove(d)}><SwapOutlined /></button></Tooltip>
                      )}
                      {canDelete && (
                        <Popconfirm title="Cihaz silinsin mi?" okText="Sil" cancelText="İptal" okButtonProps={{ danger: true }} onConfirm={() => onDelete(d)}>
                          <button title="Sil"><DeleteOutlined /></button>
                        </Popconfirm>
                      )}
                    </span>
                  </td>
                </tr>
              )
            })}
            {!loading && items.length === 0 && (
              <tr><td colSpan={11} style={{ textAlign: 'center', padding: 30, color: 'var(--fg-3)' }}>Sonuç yok</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="nm-table-foot">
        <span>Sayfa <strong style={{ color: 'var(--fg-0)' }}>{page}</strong> / {totalPages}</span>
        <span style={{ color: 'var(--fg-3)' }}>·</span>
        <span>{(page - 1) * pageSize + (items.length > 0 ? 1 : 0)}–{(page - 1) * pageSize + items.length} / {total}</span>
        <div className="pager">
          <button disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button>
          <button className="active">{page}</button>
          <button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>›</button>
        </div>
      </div>
    </div>
  )
}
