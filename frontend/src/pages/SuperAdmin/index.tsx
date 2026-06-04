import { useState } from 'react'
import {
  App, Button, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select,
  Segmented, Space, Spin, Table, Tag, Tooltip, Typography,
} from 'antd'
import {
  CrownOutlined, LaptopOutlined, TeamOutlined, EnvironmentOutlined,
  AlertOutlined, ReloadOutlined, PoweroffOutlined, EditOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined,
  GlobalOutlined, SwapOutlined, RobotOutlined, PlusOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  superadminApi,
  type SystemStats,
  type ResourceDevice,
  type ResourceAgent,
  type OrganizationWithCounts,
} from '@/api/superadmin'
import { locationsApi } from '@/api/locations'
import { useTheme } from '@/contexts/ThemeContext'

const { Text, Title } = Typography

const PLAN_COLOR: Record<string, string> = {
  free: '#64748b', starter: '#3b82f6', pro: '#8b5cf6', enterprise: '#f97316',
  no_plan: '#475569',
}

function StatCard({
  icon, label, value, sub, color,
}: {
  icon: React.ReactNode; label: string; value: number | string; sub?: string; color: string
}) {
  const { isDark } = useTheme()
  const cardBg = isDark ? '#0e1e38' : '#ffffff'
  const border = isDark ? '#1a3458' : '#e2e8f0'
  return (
    <div style={{
      background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: '16px 20px',
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10,
        background: `${color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <span style={{ color, fontSize: 20 }}>{icon}</span>
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 11 }}>{label}</Text>
        <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.2, color: isDark ? '#f1f5f9' : '#1e293b' }}>
          {value}
        </div>
        {sub && <div style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8' }}>{sub}</div>}
      </div>
    </div>
  )
}

function UsageBar({ used, max, color }: { used: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((used / max) * 100, 100) : 0
  const warn = pct >= 80
  const { isDark } = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 4, background: isDark ? '#0e1e38' : '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: warn ? '#ef4444' : color, borderRadius: 2, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 10, color: warn ? '#ef4444' : color, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {used}/{max}
      </span>
    </div>
  )
}

// ── Assign Modal ─────────────────────────────────────────────────────────────

function AssignModal({
  open,
  onClose,
  resourceType,
  selectedIds,
  orgs,
  onAssign,
  loading,
}: {
  open: boolean
  onClose: () => void
  resourceType: 'device' | 'agent'
  selectedIds: (number | string)[]
  orgs: OrganizationWithCounts[]
  onAssign: (orgId: number, locationId: number | null) => void
  loading: boolean
}) {
  const [targetOrgId, setTargetOrgId] = useState<number | null>(null)
  // QF-7 — optional location move within the target org. If the user picks
  // a location it's sent to the backend; otherwise the org-only transfer
  // path (backward-compatible) is used.
  const [targetLocationId, setTargetLocationId] = useState<number | null>(null)

  const { data: locData, isFetching: locFetching } = useQuery({
    queryKey: ['sa-locations-for-org', targetOrgId],
    queryFn: () => locationsApi.list({ organization_id: targetOrgId! }),
    enabled: open && targetOrgId != null,
  })

  const reset = () => { setTargetOrgId(null); setTargetLocationId(null) }

  // Drop stale location when org changes
  const onOrgChange = (v: number | null) => {
    setTargetOrgId(v)
    setTargetLocationId(null)
  }

  return (
    <Modal
      open={open}
      onCancel={() => { reset(); onClose() }}
      onOk={() => { if (targetOrgId) onAssign(targetOrgId, targetLocationId) }}
      okText="Taşı"
      cancelText="İptal"
      okButtonProps={{ disabled: !targetOrgId, loading }}
      title={
        <Space>
          <SwapOutlined style={{ color: '#3b82f6' }} />
          {`${selectedIds.length} ${resourceType === 'device' ? 'Cihaz' : 'Agent'} Taşı`}
        </Space>
      }
      width={460}
      afterClose={reset}
    >
      <div style={{ marginTop: 16 }}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          Hedef organizasyon
        </Text>
        <Select
          placeholder="Organizasyonu seçin..."
          style={{ width: '100%' }}
          value={targetOrgId}
          onChange={onOrgChange}
          showSearch
          optionFilterProp="label"
          options={orgs.map((o) => ({
            label: `${o.name} (${o.slug})`,
            value: o.id,
          }))}
        />

        <Text
          type="secondary"
          style={{ display: 'block', marginTop: 16, marginBottom: 8 }}
        >
          Hedef lokasyon <Text type="secondary" style={{ fontSize: 11 }}>(opsiyonel)</Text>
        </Text>
        <Select
          placeholder={
            targetOrgId == null
              ? 'Önce organizasyon seçin'
              : 'Aynı lokasyonda kalsın (boş bırak)'
          }
          style={{ width: '100%' }}
          value={targetLocationId}
          onChange={(v) => setTargetLocationId(v ?? null)}
          disabled={targetOrgId == null}
          loading={locFetching}
          allowClear
          showSearch
          optionFilterProp="label"
          options={(locData?.items ?? []).map((l) => ({
            label: l.name,
            value: l.id,
          }))}
        />
        <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 11 }}>
          Lokasyon seçilirse seçili {resourceType === 'agent' ? 'agent\'lar' : 'cihazlar'} bu
          lokasyona taşınır. {resourceType === 'agent'
            ? 'Agent WS oturumları otomatik yeniden başlatılır.'
            : 'Boş bırakırsanız yalnız organizasyon güncellenir.'}
        </Text>
      </div>
    </Modal>
  )
}

// ── Resource Assignment Tab ───────────────────────────────────────────────────

function ResourceAssignTab({ orgs }: { orgs: OrganizationWithCounts[] }) {
  const { isDark } = useTheme()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const cardBg = isDark ? '#0e1e38' : '#ffffff'
  const border = isDark ? '#1a3458' : '#e2e8f0'

  const [resourceType, setResourceType] = useState<'device' | 'agent'>('device')
  const [filterOrgId, setFilterOrgId] = useState<number | null>(null)
  const [showUnassigned, setShowUnassigned] = useState(false)
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<number[]>([])
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [assignOpen, setAssignOpen] = useState(false)
  const [singleAssignId, setSingleAssignId] = useState<number | string | null>(null)

  const { data: devData, isLoading: devLoading, refetch: refetchDevices } = useQuery({
    queryKey: ['sa-devices', filterOrgId, showUnassigned],
    queryFn: () => superadminApi.listDevices({
      org_id: filterOrgId ?? undefined,
      unassigned: showUnassigned || undefined,
      limit: 500,
    }),
    enabled: resourceType === 'device',
  })

  const { data: agentData, isLoading: agentLoading, refetch: refetchAgents } = useQuery({
    queryKey: ['sa-agents', showUnassigned],
    queryFn: () => superadminApi.listAgents({ unassigned: showUnassigned || undefined }),
    enabled: resourceType === 'agent',
  })

  const assignMut = useMutation({
    mutationFn: (
      { ids, orgId, locationId }:
      { ids: (number | string)[]; orgId: number; locationId: number | null }
    ) => superadminApi.assignResources(resourceType, ids, orgId, locationId),
    onSuccess: (res) => {
      const tail = res.location_name ? ` / "${res.location_name}" lokasyonuna` : ''
      message.success(`${res.assigned} kaynak "${res.org_name}" organizasyonuna${tail} taşındı`)
      setAssignOpen(false)
      setSingleAssignId(null)
      setSelectedDeviceIds([])
      setSelectedAgentIds([])
      qc.invalidateQueries({ queryKey: ['sa-devices'] })
      qc.invalidateQueries({ queryKey: ['sa-agents'] })
      qc.invalidateQueries({ queryKey: ['orgs-with-counts'] })
      qc.invalidateQueries({ queryKey: ['superadmin-stats'] })
    },
    onError: () => message.error('Taşıma başarısız'),
  })

  const activeIds: (number | string)[] = singleAssignId !== null
    ? [singleAssignId]
    : resourceType === 'device' ? selectedDeviceIds : selectedAgentIds

  const openBulkAssign = () => { setSingleAssignId(null); setAssignOpen(true) }
  const openSingleAssign = (id: number | string) => { setSingleAssignId(id); setAssignOpen(true) }

  const orgTag = (orgName: string | null) =>
    orgName
      ? <Tag color="blue" style={{ fontSize: 11 }}>{orgName}</Tag>
      : <Tag color="warning" style={{ fontSize: 11 }}>Atanmamış</Tag>

  const deviceCols = [
    { title: 'Cihaz', dataIndex: 'hostname', key: 'hostname', render: (h: string, r: ResourceDevice) => (
      <div><Text strong style={{ fontSize: 13 }}>{h}</Text><div style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8' }}>{r.ip_address}{r.site ? ` · ${r.site}` : ''}</div></div>
    )},
    { title: 'Durum', dataIndex: 'status', key: 'status', width: 90,
      render: (s: string) => <Tag color={s === 'online' ? 'success' : 'default'} style={{ fontSize: 11 }}>{s}</Tag>,
    },
    { title: 'Organizasyon', key: 'org', width: 160,
      render: (_: unknown, r: ResourceDevice) => orgTag(r.org_name),
    },
    { title: '', key: 'action', width: 70,
      render: (_: unknown, r: ResourceDevice) => (
        <Tooltip title="Taşı">
          <Button size="small" type="text" icon={<SwapOutlined />} onClick={() => openSingleAssign(r.id)} />
        </Tooltip>
      ),
    },
  ]

  const agentCols = [
    { title: 'Agent', dataIndex: 'name', key: 'name', render: (n: string, r: ResourceAgent) => (
      <div><Text strong style={{ fontSize: 13 }}>{n}</Text><div style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8' }}>{r.platform ?? ''}{r.version ? ` v${r.version}` : ''}</div></div>
    )},
    { title: 'Durum', dataIndex: 'status', key: 'status', width: 90,
      render: (s: string) => <Tag color={s === 'online' ? 'success' : 'default'} style={{ fontSize: 11 }}>{s}</Tag>,
    },
    { title: 'Organizasyon', key: 'org', width: 160,
      render: (_: unknown, r: ResourceAgent) => orgTag(r.org_name),
    },
    { title: '', key: 'action', width: 70,
      render: (_: unknown, r: ResourceAgent) => (
        <Tooltip title="Taşı">
          <Button size="small" type="text" icon={<SwapOutlined />} onClick={() => openSingleAssign(r.id)} />
        </Tooltip>
      ),
    },
  ]

  const hasSelection = resourceType === 'device' ? selectedDeviceIds.length > 0 : selectedAgentIds.length > 0

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <Segmented
          value={resourceType}
          onChange={(v) => { setResourceType(v as 'device' | 'agent'); setSelectedDeviceIds([]); setSelectedAgentIds([]) }}
          options={[
            { label: <Space><LaptopOutlined />Cihazlar</Space>, value: 'device' },
            { label: <Space><RobotOutlined />Agentlar</Space>, value: 'agent' },
          ]}
        />
        {resourceType === 'device' && (
          <Select
            allowClear
            placeholder="Organizasyona göre filtrele..."
            style={{ width: 220 }}
            value={filterOrgId}
            onChange={setFilterOrgId}
            showSearch
            optionFilterProp="label"
            options={orgs.map((o) => ({ label: o.name, value: o.id }))}
          />
        )}
        <Button
          type={showUnassigned ? 'primary' : 'default'}
          size="small"
          onClick={() => setShowUnassigned(!showUnassigned)}
        >
          Atanmamışlar
        </Button>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => resourceType === 'device' ? refetchDevices() : refetchAgents()}
        />
        {hasSelection && (
          <Button
            type="primary"
            icon={<SwapOutlined />}
            onClick={openBulkAssign}
          >
            {resourceType === 'device' ? selectedDeviceIds.length : selectedAgentIds.length} Seçiliyi Taşı
          </Button>
        )}
      </div>

      <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden' }}>
        {resourceType === 'device' ? (
          <Table
            columns={deviceCols}
            dataSource={devData?.devices ?? []}
            rowKey="id"
            loading={devLoading}
            size="small"
            pagination={{ pageSize: 50, showSizeChanger: false }}
            locale={{ emptyText: 'Cihaz bulunamadı' }}
            rowSelection={{
              selectedRowKeys: selectedDeviceIds,
              onChange: (keys) => setSelectedDeviceIds(keys as number[]),
            }}
            footer={() => devData ? (
              <Text type="secondary" style={{ fontSize: 11 }}>Toplam {devData.total} cihaz</Text>
            ) : null}
          />
        ) : (
          <Table
            columns={agentCols}
            dataSource={agentData?.agents ?? []}
            rowKey="id"
            loading={agentLoading}
            size="small"
            pagination={{ pageSize: 50, showSizeChanger: false }}
            locale={{ emptyText: 'Agent bulunamadı' }}
            rowSelection={{
              selectedRowKeys: selectedAgentIds,
              onChange: (keys) => setSelectedAgentIds(keys as string[]),
            }}
            footer={() => agentData ? (
              <Text type="secondary" style={{ fontSize: 11 }}>Toplam {agentData.agents.length} agent</Text>
            ) : null}
          />
        )}
      </div>

      <AssignModal
        open={assignOpen}
        onClose={() => { setAssignOpen(false); setSingleAssignId(null) }}
        resourceType={resourceType}
        selectedIds={activeIds}
        orgs={orgs}
        onAssign={(orgId, locationId) => assignMut.mutate({ ids: activeIds, orgId, locationId })}
        loading={assignMut.isPending}
      />
    </div>
  )
}

// ── T8.4 — LiveSessionsTab ──────────────────────────────────────────────────
// Super admin için aktif oturumları listeler; tek tıkla revoke (force logout).
// Polling 8 saniyede bir; "Kapat" tuşu Popconfirm ile onaylı. Kendi oturumunu
// kapatamasın diye buton disabled (backend de bunu reddediyor).

function LiveSessionsTab() {
  const { isDark } = useTheme()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [includeRevoked, setIncludeRevoked] = useState(false)

  // Mevcut kullanıcı id'sini auth store yerine /auth/me query'sini reuse
  // ederek alıyoruz — superadmin sayfasının import'larıyla uyumlu.
  const { data: me } = useQuery({
    queryKey: ['auth-me-for-sessions'],
    queryFn: () => import('@/api/auth').then(m => m.authApi.me()),
    staleTime: 60_000,
  })

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['live-sessions', includeRevoked],
    queryFn: () => superadminApi.listSessions({ include_revoked: includeRevoked, limit: 200 }),
    refetchInterval: 8000,
  })

  const revokeMut = useMutation({
    mutationFn: (id: number) => superadminApi.revokeSession(id),
    onSuccess: () => {
      message.success('Oturum kapatıldı')
      qc.invalidateQueries({ queryKey: ['live-sessions'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Kapatma başarısız'),
  })

  // User-Agent parse — basit: "Chrome on Mac" gibi etiket çıkar.
  const parseUA = (ua: string | null): string => {
    if (!ua) return '—'
    let browser = 'Bilinmeyen'
    let os = ''
    if (/Edg\//.test(ua)) browser = 'Edge'
    else if (/Chrome\//.test(ua)) browser = 'Chrome'
    else if (/Firefox\//.test(ua)) browser = 'Firefox'
    else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'Safari'
    if (/Mac OS X/.test(ua)) os = 'Mac'
    else if (/Windows NT/.test(ua)) os = 'Windows'
    else if (/Linux/.test(ua)) os = 'Linux'
    else if (/Android/.test(ua)) os = 'Android'
    else if (/iPhone|iPad/.test(ua)) os = 'iOS'
    return os ? `${browser} · ${os}` : browser
  }

  const fromNow = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime()
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}sn önce`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}dk önce`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}sa önce`
    const d = Math.floor(h / 24)
    return `${d}g önce`
  }

  const items = data?.items ?? []
  const activeCount = items.filter(s => !s.revoked_at && !s.expired).length

  const cardBg = isDark ? '#0e1e38' : '#ffffff'
  const border = isDark ? '#1a3458' : '#e2e8f0'

  return (
    <div>
      <div style={{
        background: cardBg, border: `1px solid ${border}`, borderRadius: 10,
        padding: '12px 16px', marginBottom: 14,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <Text strong style={{ fontSize: 14 }}>
          <PoweroffOutlined style={{ color: '#22c55e', marginRight: 6 }} />
          Canlı Oturumlar
        </Text>
        <Tag color="green">{activeCount} aktif</Tag>
        {items.length !== activeCount && (
          <Tag>{items.length} toplam</Tag>
        )}
        <Text type="secondary" style={{ fontSize: 11 }}>
          {isFetching ? 'Güncelleniyor…' : '8 saniyede bir otomatik yenilenir'}
        </Text>
        <Space style={{ marginLeft: 'auto' }}>
          <Button size="small"
            type={includeRevoked ? 'primary' : 'default'}
            onClick={() => setIncludeRevoked(v => !v)}>
            {includeRevoked ? '✓ Kapatılanları göster' : 'Kapatılanları göster'}
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()}>
            Yenile
          </Button>
        </Space>
      </div>

      <Table
        size="small"
        loading={isLoading}
        dataSource={items}
        rowKey="id"
        pagination={{ pageSize: 25, showSizeChanger: false, showTotal: (n) => `${n} oturum` }}
        rowClassName={(r) => r.revoked_at ? 'session-row-revoked' : ''}
        columns={[
          {
            title: 'Kullanıcı',
            key: 'user',
            render: (_: unknown, r: any) => (
              <div>
                <div style={{ fontWeight: 600, fontFamily: 'monospace' }}>{r.username}</div>
                {r.full_name && <div style={{ fontSize: 11, color: '#94a3b8' }}>{r.full_name}</div>}
              </div>
            ),
          },
          {
            title: 'Rol',
            dataIndex: 'role',
            width: 140,
            render: (r: string) => (
              <Tag color={r === 'super_admin' ? 'purple' : r === 'org_admin' ? 'red' : r === 'location_admin' ? 'orange' : 'green'}>
                {r === 'super_admin' ? 'Süper Yönetici'
                  : r === 'org_admin' ? 'Org Yöneticisi'
                  : r === 'location_admin' ? 'Lokasyon Yöneticisi'
                  : r === 'viewer' ? 'Görüntüleyici' : r}
              </Tag>
            ),
          },
          { title: 'IP', dataIndex: 'ip', width: 130,
            render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v || '—'}</span> },
          { title: 'Tarayıcı / OS', dataIndex: 'user_agent', width: 160,
            render: (v: string) => <Tooltip title={v || ''}><span style={{ fontSize: 12 }}>{parseUA(v)}</span></Tooltip> },
          {
            title: 'Giriş',
            dataIndex: 'created_at',
            width: 110,
            render: (v: string) => (
              <Tooltip title={new Date(v).toLocaleString('tr-TR')}>
                <span style={{ fontSize: 12 }}>{fromNow(v)}</span>
              </Tooltip>
            ),
          },
          {
            title: 'Son Aktivite',
            dataIndex: 'last_activity',
            width: 130,
            render: (v: string, r: any) => {
              const ms = Date.now() - new Date(v).getTime()
              const stale = ms > 5 * 60 * 1000  // 5 dk
              return (
                <Tooltip title={new Date(v).toLocaleString('tr-TR')}>
                  <span style={{ fontSize: 12, color: stale ? '#f59e0b' : '#22c55e' }}>
                    {fromNow(v)}
                    {!r.revoked_at && !r.expired && !stale && ' 🟢'}
                  </span>
                </Tooltip>
              )
            },
          },
          {
            title: 'Durum',
            key: 'status',
            width: 100,
            render: (_: unknown, r: any) => {
              if (r.revoked_at) return <Tag color="red">Kapatıldı</Tag>
              if (r.expired) return <Tag>Süresi Doldu</Tag>
              return <Tag color="green">Aktif</Tag>
            },
          },
          {
            title: '',
            key: 'actions',
            width: 110,
            render: (_: unknown, r: any) => {
              const isSelf = me && r.user_id === me.id
              if (r.revoked_at || r.expired) return <span style={{ color: '#94a3b8' }}>—</span>
              if (isSelf) return <Tooltip title="Kendi oturumunuzu buradan kapatamazsınız"><span style={{ color: '#94a3b8', fontSize: 11 }}>Bu sizsiniz</span></Tooltip>
              return (
                <Popconfirm
                  title="Oturumu kapat?"
                  description={`${r.username} hemen logout olur.`}
                  onConfirm={() => revokeMut.mutate(r.id)}
                  okText="Kapat"
                  cancelText="İptal"
                  okButtonProps={{ danger: true }}>
                  <Button size="small" danger icon={<PoweroffOutlined />}
                    loading={revokeMut.isPending && revokeMut.variables === r.id}>
                    Kapat
                  </Button>
                </Popconfirm>
              )
            },
          },
        ]}
      />
      <style>{`
        .session-row-revoked { opacity: 0.55; }
      `}</style>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SuperAdminPage() {
  const { isDark } = useTheme()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState<'overview' | 'assign' | 'sessions'>('overview')
  const [quotaModal, setQuotaModal] = useState<OrganizationWithCounts | null>(null)
  const [quotaForm] = Form.useForm()

  const cardBg = isDark ? '#0e1e38' : '#ffffff'
  const border = isDark ? '#1a3458' : '#e2e8f0'
  const textSub = isDark ? '#64748b' : '#94a3b8'

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery<SystemStats>({
    queryKey: ['superadmin-stats'],
    queryFn: superadminApi.getSystemStats,
    refetchInterval: 60000,
  })

  const { data: orgsData, isLoading: orgsLoading, refetch: refetchOrgs } = useQuery({
    queryKey: ['orgs-with-counts'],
    queryFn: () => superadminApi.listOrgsWithCounts({ per_page: 500 }),
    refetchInterval: 60000,
  })

  const orgs: OrganizationWithCounts[] = orgsData?.orgs ?? []

  const updateOrgMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Parameters<typeof superadminApi.updateOrg>[1] }) =>
      superadminApi.updateOrg(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orgs-with-counts'] })
      qc.invalidateQueries({ queryKey: ['superadmin-stats'] })
      setQuotaModal(null)
    },
  })

  // RBAC F5 — create organization (super-admin only, atomic with first admin)
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const createOrgMutation = useMutation({
    mutationFn: (payload: Parameters<typeof superadminApi.createOrg>[0]) =>
      superadminApi.createOrg(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orgs-with-counts'] })
      qc.invalidateQueries({ queryKey: ['superadmin-stats'] })
      message.success('Organizasyon ve ilk admin oluşturuldu')
      createForm.resetFields()
      setCreateOpen(false)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Organizasyon oluşturulamadı'),
  })

  const handleCreateOrg = async () => {
    const vals = await createForm.validateFields()
    createOrgMutation.mutate(vals)
  }

  // Auto-derive slug from name (lowercase, replace spaces, strip non-allowed).
  const onNameChange = (name: string) => {
    const current = createForm.getFieldValue('slug')
    // Only overwrite if the user hasn't manually edited the slug.
    if (!current || current === (createForm.getFieldValue('_lastAutoSlug') ?? '')) {
      const slug = name.toLowerCase()
        .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ç/g, 'c')
        .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
      createForm.setFieldsValue({ slug, _lastAutoSlug: slug })
    }
  }

  const toggleOrgStatus = (org: OrganizationWithCounts) => {
    const next = org.status === 'active' ? 'suspended' : 'active'
    updateOrgMutation.mutate({ id: org.id, payload: { status: next } })
  }

  const openQuotaModal = (o: OrganizationWithCounts) => {
    setQuotaModal(o)
    quotaForm.setFieldsValue({
      max_devices: o.quota.max_devices,
      max_users: o.quota.max_users,
      max_locations: o.quota.max_locations,
      max_agents: o.quota.max_agents,
    })
  }

  const handleQuotaSave = async () => {
    const vals = await quotaForm.validateFields()
    if (!quotaModal) return
    updateOrgMutation.mutate({ id: quotaModal.id, payload: vals })
  }

  const columns = [
    {
      title: 'Organizasyon',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, rec: OrganizationWithCounts) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{name}</Text>
          <div style={{ fontSize: 11, color: textSub }}>
            <code style={{ fontSize: 10 }}>{rec.slug}</code>
            {rec.contact_email && <span style={{ marginLeft: 6 }}>{rec.contact_email}</span>}
          </div>
        </div>
      ),
    },
    {
      title: 'Plan',
      key: 'plan',
      width: 110,
      render: (_: unknown, rec: OrganizationWithCounts) => {
        const color = PLAN_COLOR[rec.plan_tier] ?? PLAN_COLOR.no_plan
        return (
          <Tag
            icon={<CrownOutlined />}
            style={{ fontSize: 11, color, borderColor: color + '50', background: color + '18' }}
          >
            {rec.plan_tier.toUpperCase()}
          </Tag>
        )
      },
    },
    {
      title: 'Cihaz',
      key: 'devices',
      width: 130,
      render: (_: unknown, rec: OrganizationWithCounts) => (
        <UsageBar used={rec.device_count} max={rec.quota.max_devices} color="#3b82f6" />
      ),
    },
    {
      title: 'Kullanıcı',
      key: 'users',
      width: 110,
      render: (_: unknown, rec: OrganizationWithCounts) => (
        <UsageBar used={rec.user_count} max={rec.quota.max_users} color="#22c55e" />
      ),
    },
    {
      title: 'Lokasyon',
      key: 'loc',
      width: 100,
      render: (_: unknown, rec: OrganizationWithCounts) => (
        <Space size={4}>
          <EnvironmentOutlined />
          <span>{rec.location_count}/{rec.quota.max_locations}</span>
        </Space>
      ),
    },
    {
      title: 'Durum',
      key: 'status',
      width: 100,
      render: (_: unknown, rec: OrganizationWithCounts) => rec.status === 'active'
        ? <Tag icon={<CheckCircleOutlined />} color="success">Aktif</Tag>
        : <Tag icon={<CloseCircleOutlined />} color={rec.status === 'suspended' ? 'error' : 'default'}>{rec.status}</Tag>,
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_: unknown, rec: OrganizationWithCounts) => (
        <Space size={4}>
          <Tooltip title="Kotayı Düzenle">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openQuotaModal(rec)} />
          </Tooltip>
          <Popconfirm
            title={rec.status === 'active' ? 'Organizasyonu askıya al?' : 'Organizasyonu aktif et?'}
            onConfirm={() => toggleOrgStatus(rec)}
            okButtonProps={{ danger: rec.status === 'active' }}
          >
            <Tooltip title={rec.status === 'active' ? 'Askıya Al' : 'Aktif Et'}>
              <Button
                size="small" type="text"
                danger={rec.status === 'active'}
                icon={<PoweroffOutlined />}
                loading={updateOrgMutation.isPending}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const s = stats

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            <GlobalOutlined style={{ marginRight: 8, color: '#f97316' }} />
            Platform Yönetim Paneli
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            Tüm organizasyonların sistem geneli görünümü — yalnızca super_admin erişimi
          </Text>
        </div>
        <Space>
          <Segmented
            value={activeTab}
            onChange={(v) => setActiveTab(v as 'overview' | 'assign' | 'sessions')}
            options={[
              { label: <Space><GlobalOutlined />Genel Bakış</Space>, value: 'overview' },
              { label: <Space><SwapOutlined />Kaynak Atama</Space>, value: 'assign' },
              { label: <Space><PoweroffOutlined />Canlı Oturumlar</Space>, value: 'sessions' },
            ]}
          />
          {activeTab === 'overview' && (
            <Button
              icon={<ReloadOutlined />}
              onClick={() => { refetchStats(); refetchOrgs() }}
            >
              Yenile
            </Button>
          )}
        </Space>
      </div>

      {activeTab === 'overview' ? (
        <>
          {/* System stat cards */}
          {statsLoading ? (
            <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
          ) : s && (
            <>
              <Row gutter={[14, 14]} style={{ marginBottom: 20 }}>
                <Col xs={12} sm={8} lg={4}>
                  <StatCard icon={<CrownOutlined />} label="Organizasyonlar" value={s.organizations.total} sub={`${s.organizations.active} aktif`} color="#f97316" />
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <StatCard icon={<TeamOutlined />} label="Toplam Kullanıcı" value={s.users.total} color="#8b5cf6" />
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <StatCard icon={<LaptopOutlined />} label="Toplam Cihaz" value={s.devices.total} sub={`${s.devices.online} online`} color="#3b82f6" />
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <StatCard icon={<EnvironmentOutlined />} label="Lokasyonlar" value={s.locations.total} color="#22c55e" />
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <StatCard icon={<AlertOutlined />} label="Olaylar (24h)" value={s.events_24h.total} sub={`${s.events_24h.critical} kritik`} color="#ef4444" />
                </Col>
                <Col xs={12} sm={8} lg={4}>
                  <StatCard icon={<ThunderboltOutlined />} label="Çalışan Görev" value={s.tasks.running} color="#06b6d4" />
                </Col>
              </Row>

              <Row gutter={[14, 14]} style={{ marginBottom: 20 }}>
                <Col xs={24} md={10}>
                  <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 16 }}>
                    <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>Plan Dağılımı</Text>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {Object.entries(s.organizations.by_plan).map(([plan, count]) => {
                        const color = PLAN_COLOR[plan] ?? PLAN_COLOR.no_plan
                        return (
                          <div key={plan} style={{
                            background: color + '18', border: `1px solid ${color}40`,
                            borderRadius: 8, padding: '10px 16px', textAlign: 'center',
                          }}>
                            <div style={{ fontSize: 22, fontWeight: 800, color }}>{count}</div>
                            <div style={{ fontSize: 11, color, fontWeight: 600, textTransform: 'uppercase' }}>{plan}</div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </Col>
                <Col xs={24} md={14}>
                  <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 16 }}>
                    <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>En Fazla Cihaza Sahip Organizasyonlar</Text>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {s.top_organizations_by_devices.slice(0, 6).map((t) => {
                        const color = PLAN_COLOR[t.plan_tier] ?? PLAN_COLOR.no_plan
                        return (
                          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Tag style={{ fontSize: 10, color, borderColor: color + '40', background: color + '15', margin: 0 }}>
                              {t.plan_tier}
                            </Tag>
                            <Text style={{ flex: 1, fontSize: 13 }}>{t.name}</Text>
                            <Tag icon={<LaptopOutlined />} color="blue">{t.device_count}</Tag>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </Col>
              </Row>
            </>
          )}

          {/* Organizations table */}
          <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div>
                <Text strong>Tüm Organizasyonlar</Text>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>{orgs.length} toplam</Text>
              </div>
              <Button type="primary" icon={<PlusOutlined />}
                onClick={() => { createForm.resetFields(); createForm.setFieldsValue({ trial_days: 14 }); setCreateOpen(true) }}>
                Yeni Organizasyon
              </Button>
            </div>
            <Table
              columns={columns}
              dataSource={orgs}
              rowKey="id"
              loading={orgsLoading}
              pagination={false}
              size="small"
              locale={{ emptyText: 'Organizasyon bulunamadı' }}
            />
          </div>
        </>
      ) : activeTab === 'assign' ? (
        <ResourceAssignTab orgs={orgs} />
      ) : (
        <LiveSessionsTab />
      )}

      {/* Quota edit modal */}
      <Modal
        title={`Kotayı Düzenle — ${quotaModal?.name ?? ''}`}
        open={!!quotaModal}
        onOk={handleQuotaSave}
        onCancel={() => setQuotaModal(null)}
        okText="Kaydet"
        cancelText="İptal"
        confirmLoading={updateOrgMutation.isPending}
        width={420}
      >
        <Form form={quotaForm} layout="vertical" style={{ marginTop: 16 }}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="Maks. Cihaz" name="max_devices" rules={[{ required: true }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="Maks. Kullanıcı" name="max_users" rules={[{ required: true }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="Maks. Lokasyon" name="max_locations" rules={[{ required: true }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="Maks. Agent" name="max_agents" rules={[{ required: true }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* RBAC F5 — create-organization modal (super-admin only).
          Form mirrors the OrgCreate Pydantic schema; the backend
          provisions the org + its first admin user atomically. */}
      <Modal
        title={<Space><PlusOutlined /> Yeni Organizasyon</Space>}
        open={createOpen}
        onOk={handleCreateOrg}
        onCancel={() => setCreateOpen(false)}
        okText="Oluştur"
        cancelText="İptal"
        confirmLoading={createOrgMutation.isPending}
        width={560}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 12 }} initialValues={{ trial_days: 14 }}>
          <Row gutter={12}>
            <Col span={14}>
              <Form.Item label="Organizasyon Adı" name="name" rules={[{ required: true, message: 'Zorunlu' }]}>
                <Input placeholder="örn. Acme Networks A.Ş."
                  onChange={(e) => onNameChange(e.target.value)} />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item label="Slug" name="slug"
                rules={[
                  { required: true, message: 'Zorunlu' },
                  { pattern: /^[a-z0-9-]+$/, message: 'Yalnız küçük harf · rakam · tire' },
                ]}
                extra="URL'lerde kullanılır — değişmez">
                <Input placeholder="acme-networks" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="Açıklama" name="description">
            <Input.TextArea rows={2} placeholder="İsteğe bağlı" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={14}>
              <Form.Item label="İletişim E-postası" name="contact_email"
                rules={[{ type: 'email', message: 'Geçerli e-posta' }]}>
                <Input placeholder="ops@acme-networks.com" />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item label="Deneme süresi (gün)" name="trial_days"
                rules={[{ required: true }]}>
                <InputNumber min={0} max={365} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <div style={{ margin: '4px 0 12px', padding: '6px 10px',
            background: isDark ? '#0c2040' : '#eff6ff',
            border: `1px solid ${isDark ? '#1a3458' : '#bfdbfe'}`,
            borderRadius: 6, fontSize: 12,
            color: isDark ? '#94a3b8' : '#475569',
          }}>
            <CrownOutlined style={{ marginRight: 6, color: '#f97316' }} />
            <strong>İlk Org Admin</strong> — bu organizasyona ilk giriş yapacak hesap.
            Org Admin sadece bu organizasyonun lokasyon ve kaynaklarına erişebilir.
          </div>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="Admin kullanıcı adı" name="admin_username"
                rules={[{ required: true, message: 'Zorunlu' }, { min: 3, max: 32 }]}>
                <Input placeholder="acme.admin" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="Admin tam adı" name="admin_full_name">
                <Input placeholder="Ali Veli" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={14}>
              <Form.Item label="Admin e-posta" name="admin_email"
                rules={[{ required: true, type: 'email', message: 'Geçerli e-posta' }]}>
                <Input placeholder="admin@acme-networks.com" />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item label="İlk şifre" name="admin_password"
                rules={[{ required: true, min: 8, message: 'En az 8 karakter' }]}>
                <Input.Password placeholder="••••••••" />
              </Form.Item>
            </Col>
          </Row>
          {/* Hidden — used by onNameChange auto-slug heuristic */}
          <Form.Item name="_lastAutoSlug" noStyle hidden><Input type="hidden" /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
