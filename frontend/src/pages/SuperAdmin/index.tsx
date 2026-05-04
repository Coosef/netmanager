import { useState } from 'react'
import {
  Button, Col, Form, InputNumber, Modal, Popconfirm, Row, Select,
  Space, Spin, Table, Tag, Tooltip, Typography,
} from 'antd'
import {
  CrownOutlined, LaptopOutlined, TeamOutlined, EnvironmentOutlined,
  AlertOutlined, ReloadOutlined, PoweroffOutlined, EditOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ThunderboltOutlined,
  GlobalOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { superadminApi, type SystemStats } from '@/api/superadmin'
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

export default function SuperAdminPage() {
  const { isDark } = useTheme()
  const qc = useQueryClient()
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
        <Button
          icon={<ReloadOutlined />}
          onClick={() => { refetchStats(); refetchTenants() }}
        >
          Yenile
        </Button>
      </div>

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

          {/* Plan distribution */}
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
