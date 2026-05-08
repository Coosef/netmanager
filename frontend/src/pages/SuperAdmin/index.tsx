import { useState } from 'react'
import {
  App, Button, Col, Form, InputNumber, Modal, Popconfirm, Row, Select,
  Segmented, Space, Spin, Table, Tag, Tooltip, Typography,
} from 'antd'
import {
  CrownOutlined, LaptopOutlined, TeamOutlined, EnvironmentOutlined,
  AlertOutlined, ReloadOutlined, PoweroffOutlined, EditOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined,
  GlobalOutlined, SwapOutlined, RobotOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { superadminApi, type SystemStats, type ResourceDevice, type ResourceAgent } from '@/api/superadmin'
import { tenantsApi, type Tenant } from '@/api/tenants'
import { useTheme } from '@/contexts/ThemeContext'

const { Text, Title } = Typography

const PLAN_COLOR: Record<string, string> = {
  free: '#64748b', starter: '#3b82f6', pro: '#8b5cf6', enterprise: '#f97316',
}
const PLAN_OPTIONS = [
  { label: 'Free', value: 'free' },
  { label: 'Starter', value: 'starter' },
  { label: 'Pro', value: 'pro' },
  { label: 'Enterprise', value: 'enterprise' },
]

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
  tenants,
  onAssign,
  loading,
}: {
  open: boolean
  onClose: () => void
  resourceType: 'device' | 'agent'
  selectedIds: (number | string)[]
  tenants: Tenant[]
  onAssign: (tenantId: number) => void
  loading: boolean
}) {
  const [targetTenantId, setTargetTenantId] = useState<number | null>(null)
  return (
    <Modal
      open={open}
      onCancel={() => { setTargetTenantId(null); onClose() }}
      onOk={() => { if (targetTenantId) onAssign(targetTenantId) }}
      okText="Taşı"
      cancelText="İptal"
      okButtonProps={{ disabled: !targetTenantId, loading }}
      title={
        <Space>
          <SwapOutlined style={{ color: '#3b82f6' }} />
          {`${selectedIds.length} ${resourceType === 'device' ? 'Cihaz' : 'Agent'} Taşı`}
        </Space>
      }
      width={420}
      afterClose={() => setTargetTenantId(null)}
    >
      <div style={{ marginTop: 16 }}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          Seçilen {selectedIds.length} kaynağı hangi organizasyona taşımak istiyorsunuz?
        </Text>
        <Select
          placeholder="Hedef organizasyonu seçin..."
          style={{ width: '100%' }}
          value={targetTenantId}
          onChange={setTargetTenantId}
          showSearch
          optionFilterProp="label"
          options={tenants.map((t) => ({
            label: `${t.name} (${t.slug})`,
            value: t.id,
          }))}
        />
      </div>
    </Modal>
  )
}

// ── Resource Assignment Tab ───────────────────────────────────────────────────

function ResourceAssignTab({ tenants }: { tenants: Tenant[] }) {
  const { isDark } = useTheme()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const cardBg = isDark ? '#0e1e38' : '#ffffff'
  const border = isDark ? '#1a3458' : '#e2e8f0'

  const [resourceType, setResourceType] = useState<'device' | 'agent'>('device')
  const [filterTenantId, setFilterTenantId] = useState<number | null>(null)
  const [showUnassigned, setShowUnassigned] = useState(false)
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<number[]>([])
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  const [assignOpen, setAssignOpen] = useState(false)
  const [singleAssignId, setSingleAssignId] = useState<number | string | null>(null)

  const { data: devData, isLoading: devLoading, refetch: refetchDevices } = useQuery({
    queryKey: ['sa-devices', filterTenantId, showUnassigned],
    queryFn: () => superadminApi.listDevices({
      tenant_id: filterTenantId ?? undefined,
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
    mutationFn: ({ ids, tenantId }: { ids: (number | string)[]; tenantId: number }) =>
      superadminApi.assignResources(resourceType, ids, tenantId),
    onSuccess: (res) => {
      message.success(`${res.assigned} kaynak "${res.tenant_name}" organizasyonuna taşındı`)
      setAssignOpen(false)
      setSingleAssignId(null)
      setSelectedDeviceIds([])
      setSelectedAgentIds([])
      qc.invalidateQueries({ queryKey: ['sa-devices'] })
      qc.invalidateQueries({ queryKey: ['sa-agents'] })
      qc.invalidateQueries({ queryKey: ['tenants'] })
      qc.invalidateQueries({ queryKey: ['superadmin-stats'] })
    },
    onError: () => message.error('Taşıma başarısız'),
  })

  const activeIds: (number | string)[] = singleAssignId !== null
    ? [singleAssignId]
    : resourceType === 'device' ? selectedDeviceIds : selectedAgentIds

  const openBulkAssign = () => { setSingleAssignId(null); setAssignOpen(true) }
  const openSingleAssign = (id: number | string) => { setSingleAssignId(id); setAssignOpen(true) }

  const tenantTag = (tenantName: string | null) =>
    tenantName
      ? <Tag color="blue" style={{ fontSize: 11 }}>{tenantName}</Tag>
      : <Tag color="warning" style={{ fontSize: 11 }}>Atanmamış</Tag>

  const deviceCols = [
    { title: 'Cihaz', dataIndex: 'hostname', key: 'hostname', render: (h: string, r: ResourceDevice) => (
      <div><Text strong style={{ fontSize: 13 }}>{h}</Text><div style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8' }}>{r.ip_address}{r.site ? ` · ${r.site}` : ''}</div></div>
    )},
    { title: 'Durum', dataIndex: 'status', key: 'status', width: 90,
      render: (s: string) => <Tag color={s === 'online' ? 'success' : 'default'} style={{ fontSize: 11 }}>{s}</Tag>,
    },
    { title: 'Organizasyon', key: 'tenant', width: 160,
      render: (_: unknown, r: ResourceDevice) => tenantTag(r.tenant_name),
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
    { title: 'Organizasyon', key: 'tenant', width: 160,
      render: (_: unknown, r: ResourceAgent) => tenantTag(r.tenant_name),
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
            value={filterTenantId}
            onChange={setFilterTenantId}
            showSearch
            optionFilterProp="label"
            options={tenants.map((t) => ({ label: t.name, value: t.id }))}
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
        tenants={tenants}
        onAssign={(tenantId) => assignMut.mutate({ ids: activeIds, tenantId })}
        loading={assignMut.isPending}
      />
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SuperAdminPage() {
  const { isDark } = useTheme()
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState<'overview' | 'assign'>('overview')
  const [planModal, setPlanModal] = useState<Tenant | null>(null)
  const [planForm] = Form.useForm()

  const cardBg = isDark ? '#0e1e38' : '#ffffff'
  const border = isDark ? '#1a3458' : '#e2e8f0'
  const textSub = isDark ? '#64748b' : '#94a3b8'

  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useQuery<SystemStats>({
    queryKey: ['superadmin-stats'],
    queryFn: superadminApi.getSystemStats,
    refetchInterval: 60000,
  })

  const { data: tenants, isLoading: tenantsLoading, refetch: refetchTenants } = useQuery<Tenant[]>({
    queryKey: ['tenants'],
    queryFn: tenantsApi.list,
    refetchInterval: 60000,
  })

  const toggleActiveMutation = useMutation({
    mutationFn: (id: number) => superadminApi.toggleTenantActive(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants'] })
      qc.invalidateQueries({ queryKey: ['superadmin-stats'] })
    },
  })

  const updatePlanMutation = useMutation({
    mutationFn: ({ id, plan_tier, max_devices, max_users }: { id: number; plan_tier: string; max_devices: number; max_users: number }) =>
      superadminApi.updateTenantPlan(id, plan_tier, max_devices, max_users),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants'] })
      qc.invalidateQueries({ queryKey: ['superadmin-stats'] })
      setPlanModal(null)
    },
  })

  const openPlanModal = (t: Tenant) => {
    setPlanModal(t)
    planForm.setFieldsValue({ plan_tier: t.plan_tier, max_devices: t.max_devices, max_users: t.max_users })
  }

  const handlePlanSave = async () => {
    const vals = await planForm.validateFields()
    if (!planModal) return
    updatePlanMutation.mutate({ id: planModal.id, ...vals })
  }

  const columns = [
    {
      title: 'Organizasyon',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, rec: Tenant) => (
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
      width: 100,
      render: (_: unknown, rec: Tenant) => (
        <Tag
          icon={<CrownOutlined />}
          style={{ fontSize: 11, color: PLAN_COLOR[rec.plan_tier], borderColor: PLAN_COLOR[rec.plan_tier] + '50', background: PLAN_COLOR[rec.plan_tier] + '18' }}
        >
          {rec.plan_tier.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: 'Cihaz',
      key: 'devices',
      width: 130,
      render: (_: unknown, rec: Tenant) => (
        <UsageBar used={rec.device_count} max={rec.max_devices} color="#3b82f6" />
      ),
    },
    {
      title: 'Kullanıcı',
      key: 'users',
      width: 110,
      render: (_: unknown, rec: Tenant) => (
        <UsageBar used={rec.user_count} max={rec.max_users} color="#22c55e" />
      ),
    },
    {
      title: 'Lokasyon',
      dataIndex: 'location_count',
      key: 'loc',
      width: 80,
      render: (n: number) => <Tag icon={<EnvironmentOutlined />} color="default">{n}</Tag>,
    },
    {
      title: 'Durum',
      key: 'status',
      width: 80,
      render: (_: unknown, rec: Tenant) => rec.is_active
        ? <Tag icon={<CheckCircleOutlined />} color="success">Aktif</Tag>
        : <Tag icon={<CloseCircleOutlined />} color="error">Pasif</Tag>,
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_: unknown, rec: Tenant) => (
        <Space size={4}>
          <Tooltip title="Planı Düzenle">
            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openPlanModal(rec)} />
          </Tooltip>
          <Popconfirm
            title={rec.is_active ? 'Organizasyonu pasife al?' : 'Organizasyonu aktif et?'}
            onConfirm={() => toggleActiveMutation.mutate(rec.id)}
            okButtonProps={{ danger: !rec.is_active }}
          >
            <Tooltip title={rec.is_active ? 'Pasife Al' : 'Aktif Et'}>
              <Button
                size="small" type="text"
                danger={rec.is_active}
                icon={<PoweroffOutlined />}
                loading={toggleActiveMutation.isPending}
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
            onChange={(v) => setActiveTab(v as 'overview' | 'assign')}
            options={[
              { label: <Space><GlobalOutlined />Genel Bakış</Space>, value: 'overview' },
              { label: <Space><SwapOutlined />Kaynak Atama</Space>, value: 'assign' },
            ]}
          />
          {activeTab === 'overview' && (
            <Button
              icon={<ReloadOutlined />}
              onClick={() => { refetchStats(); refetchTenants() }}
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
                  <StatCard icon={<CrownOutlined />} label="Organizasyonlar" value={s.tenants.total} sub={`${s.tenants.active} aktif`} color="#f97316" />
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
                      {Object.entries(s.tenants.by_plan).map(([plan, count]) => (
                        <div key={plan} style={{
                          background: PLAN_COLOR[plan] + '18', border: `1px solid ${PLAN_COLOR[plan]}40`,
                          borderRadius: 8, padding: '10px 16px', textAlign: 'center',
                        }}>
                          <div style={{ fontSize: 22, fontWeight: 800, color: PLAN_COLOR[plan] }}>{count}</div>
                          <div style={{ fontSize: 11, color: PLAN_COLOR[plan], fontWeight: 600, textTransform: 'uppercase' }}>{plan}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </Col>
                <Col xs={24} md={14}>
                  <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, padding: 16 }}>
                    <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>En Fazla Cihaza Sahip Organizasyonlar</Text>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {s.top_tenants_by_devices.slice(0, 6).map((t) => (
                        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Tag style={{ fontSize: 10, color: PLAN_COLOR[t.plan_tier], borderColor: PLAN_COLOR[t.plan_tier] + '40', background: PLAN_COLOR[t.plan_tier] + '15', margin: 0 }}>
                            {t.plan_tier}
                          </Tag>
                          <Text style={{ flex: 1, fontSize: 13 }}>{t.name}</Text>
                          <Tag icon={<LaptopOutlined />} color="blue">{t.device_count}</Tag>
                        </div>
                      ))}
                    </div>
                  </div>
                </Col>
              </Row>
            </>
          )}

          {/* Tenants table */}
          <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBottom: `1px solid ${border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text strong>Tüm Organizasyonlar</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{tenants?.length ?? 0} toplam</Text>
            </div>
            <Table
              columns={columns}
              dataSource={tenants ?? []}
              rowKey="id"
              loading={tenantsLoading}
              pagination={false}
              size="small"
              locale={{ emptyText: 'Organizasyon bulunamadı' }}
            />
          </div>
        </>
      ) : (
        <ResourceAssignTab tenants={tenants ?? []} />
      )}

      {/* Plan edit modal */}
      <Modal
        title={`Plan Düzenle — ${planModal?.name}`}
        open={!!planModal}
        onOk={handlePlanSave}
        onCancel={() => setPlanModal(null)}
        okText="Kaydet"
        cancelText="İptal"
        confirmLoading={updatePlanMutation.isPending}
        width={380}
      >
        <Form form={planForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="Plan" name="plan_tier" rules={[{ required: true }]}>
            <Select options={PLAN_OPTIONS} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="Maks. Cihaz" name="max_devices" rules={[{ required: true }]}>
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="Maks. Kullanıcı" name="max_users" rules={[{ required: true }]}>
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
