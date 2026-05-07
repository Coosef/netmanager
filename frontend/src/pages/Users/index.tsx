import { useState } from 'react'
import {
  App, Button, Drawer, Form, Input, Popconfirm, Select,
  Space, Table, Tag, Switch, Avatar, Badge, Modal, Tooltip,
  Divider, Empty, Tabs,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  TeamOutlined, UserOutlined, SafetyOutlined, ApartmentOutlined,
  KeyOutlined, EnvironmentOutlined, MinusCircleOutlined,
  MailOutlined, LinkOutlined, StopOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { usersApi } from '@/api/users'
import { tenantsApi } from '@/api/tenants'
import { locationsApi } from '@/api/locations'
import { invitesApi, type Invite } from '@/api/invites'
import { useTheme } from '@/contexts/ThemeContext'
import type { User } from '@/types'
import { ROLE_OPTIONS, LOC_ROLE_OPTIONS } from '@/types'
import { useAuthStore } from '@/store/auth'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'

const USERS_CSS = `
@keyframes usersRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.users-row-inactive td { opacity: 0.55; }
`

const ROLE_HEX: Record<string, string> = {
  super_admin: '#ef4444',
  admin: '#f97316',
  org_viewer: '#8b5cf6',
  location_manager: '#06b6d4',
  location_operator: '#3b82f6',
  location_viewer: '#22c55e',
  operator: '#3b82f6',
  viewer: '#22c55e',
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'SUPER ADMIN',
  admin: 'ADMIN',
  org_viewer: 'ORG VIEWER',
  location_manager: 'LOC. MANAGER',
  location_operator: 'LOC. OPERATOR',
  location_viewer: 'LOC. VIEWER',
  operator: 'OPERATOR',
  viewer: 'VIEWER',
}

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

function RoleStatCard({ role, count, isDark }: { role: string; count: number; isDark: boolean }) {
  const hex = ROLE_HEX[role] || '#64748b'
  const C = mkC(isDark)
  return (
    <div style={{
      background: isDark ? `${hex}12` : C.bg,
      border: `1px solid ${isDark ? hex + '28' : C.border}`,
      borderTop: `2px solid ${hex}60`,
      borderRadius: 10, padding: '12px 16px',
      display: 'flex', alignItems: 'center', gap: 10,
      flex: 1, minWidth: 120,
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: 8,
        background: isDark ? `${hex}20` : `${hex}15`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <SafetyOutlined style={{ color: hex, fontSize: 14 }} />
      </div>
      <div>
        <div style={{ color: hex, fontSize: 18, fontWeight: 800, lineHeight: 1 }}>{count}</div>
        <div style={{ color: C.muted, fontSize: 10, marginTop: 2, letterSpacing: 0.5 }}>{ROLE_LABEL[role]}</div>
      </div>
    </div>
  )
}

export default function UsersPage() {
  const { message } = App.useApp()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { user: currentUser, isSuperAdmin } = useAuthStore()
  const { isDark } = useTheme()
  const C = mkC(isDark)
  const isSA = isSuperAdmin()

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerTab, setDrawerTab] = useState('general')
  const [editUser, setEditUser] = useState<User | null>(null)
  const [resetUser, setResetUser] = useState<User | null>(null)
  const [resetForm] = Form.useForm()

  // Invite state
  const [inviteModalOpen, setInviteModalOpen] = useState(false)
  const [inviteForm] = Form.useForm()
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null)

  const { data: invites, refetch: refetchInvites } = useQuery({
    queryKey: ['invites'],
    queryFn: invitesApi.list,
  })

  const createInviteMutation = useMutation({
    mutationFn: ({ email, role, expires_hours }: { email: string; role: string; expires_hours: number }) =>
      invitesApi.create(email, role, expires_hours),
    onSuccess: (data) => {
      const link = `${window.location.origin}/invite?token=${data.token}`
      setLastInviteLink(link)
      navigator.clipboard?.writeText(link).catch(() => {})
      refetchInvites()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Davet oluşturulamadı'),
  })

  const revokeInviteMutation = useMutation({
    mutationFn: (id: number) => invitesApi.revoke(id),
    onSuccess: () => refetchInvites(),
    onError: () => message.error('Davet iptal edilemedi'),
  })

  const handleCreateInvite = async () => {
    const vals = await inviteForm.validateFields()
    createInviteMutation.mutate(vals)
  }

  // Location assignments (now inside the main drawer)
  const [locAssignments, setLocAssignments] = useState<{ location_id: number; loc_role: string }[]>([])
  const [addLocId, setAddLocId] = useState<number | null>(null)
  const [addLocRole, setAddLocRole] = useState('location_viewer')

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
  })

  const { data: tenants } = useQuery({
    queryKey: ['tenants'],
    queryFn: tenantsApi.list,
    enabled: isSA,
  })

  const { data: locationsData } = useQuery({
    queryKey: ['locations'],
    queryFn: () => locationsApi.list(),
    enabled: drawerOpen,
  })

  const tenantOptions = (tenants || []).map((t) => ({ label: t.name, value: t.id }))
  const locationOptions = (locationsData?.items || []).map((l) => ({ label: l.name, value: l.id }))

  const createMutation = useMutation({
    mutationFn: usersApi.create,
    onError: (e: any) => {
      const d = e?.response?.data?.detail
      message.error(typeof d === 'string' ? d : Array.isArray(d) ? d.map((x: any) => x.msg).join(', ') : t('users.create_error'))
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) => usersApi.update(id, data),
    onError: (e: any) => message.error(e?.response?.data?.detail || t('users.create_error')),
  })

  const deleteMutation = useMutation({
    mutationFn: usersApi.delete,
    onSuccess: () => { message.success(t('users.deleted')); queryClient.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e: any) => {
      const d = e?.response?.data?.detail
      message.error(typeof d === 'string' ? d : 'Kullanıcı silinemedi')
    },
  })

  const resetPasswordMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) => usersApi.resetPassword(id, password),
    onSuccess: () => { message.success(t('users.password_reset_success')); setResetUser(null); resetForm.resetFields() },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('users.password_reset_error')),
  })

  const openDrawer = (user?: User, tab = 'general') => {
    setEditUser(user ?? null)
    setLocAssignments((user?.locations || []).map((l) => ({ location_id: l.location_id, loc_role: l.loc_role })))
    setAddLocId(null)
    setAddLocRole('location_viewer')
    setDrawerTab(tab)
    setDrawerOpen(true)
  }

  const onSubmit = async (values: Record<string, unknown>) => {
    try {
      let userId: number
      let updatedUser: any = null
      if (editUser) {
        updatedUser = await updateMutation.mutateAsync({ id: editUser.id, data: values })
        userId = editUser.id
      } else {
        const newUser = await createMutation.mutateAsync(values)
        userId = (newUser as any).id
      }
      try {
        await usersApi.setLocations(userId, locAssignments)
      } catch (locErr: any) {
        const d = locErr?.response?.data?.detail
        message.error(typeof d === 'string' ? d : 'Lokasyon atamaları kaydedilemedi')
        return
      }
      // If the current user edited their own profile, refresh the auth store
      if (editUser && editUser.id === currentUser?.id && updatedUser) {
        const { setAuth, token } = useAuthStore.getState()
        setAuth(token!, { id: updatedUser.id, username: updatedUser.username, role: updatedUser.role, tenant_id: updatedUser.tenant_id })
      }
      message.success(editUser ? t('users.updated') : t('users.created'))
      setDrawerOpen(false)
      queryClient.invalidateQueries({ queryKey: ['users'] })
    } catch {
      // errors shown by mutation onError handlers
    }
  }

  const addLocAssignment = () => {
    if (!addLocId) return
    const exists = locAssignments.find((a) => a.location_id === addLocId)
    if (exists) { message.warning('Bu lokasyon zaten eklenmiş'); return }
    setLocAssignments([...locAssignments, { location_id: addLocId, loc_role: addLocRole }])
    setAddLocId(null)
    setAddLocRole('location_viewer')
  }

  const removeLocAssignment = (locId: number) => {
    setLocAssignments(locAssignments.filter((a) => a.location_id !== locId))
  }

  const updateLocRole = (locId: number, newRole: string) => {
    setLocAssignments(locAssignments.map((a) => a.location_id === locId ? { ...a, loc_role: newRole } : a))
  }

  const userList = users || []
  const roleCounts: Record<string, number> = {}
  for (const u of userList) {
    roleCounts[u.role] = (roleCounts[u.role] || 0) + 1
  }

  const ROLE_OPTIONS_FILTERED = isSA
    ? ROLE_OPTIONS
    : ROLE_OPTIONS.filter((o) => o.value !== 'super_admin' && o.value !== 'admin')

  const locNameMap = Object.fromEntries(
    (locationsData?.items || []).map((l) => [l.id, l.name])
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{USERS_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#3b82f620' : C.border}`,
        borderLeft: '4px solid #3b82f6',
        borderRadius: 12, padding: '16px 20px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: '#3b82f620', border: '1px solid #3b82f630',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <TeamOutlined style={{ color: '#3b82f6', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>
              {t('users.title')}
              <span style={{ color: C.dim, fontSize: 13, fontWeight: 400, marginLeft: 8 }}>
                ({userList.length})
              </span>
            </div>
            <div style={{ color: C.muted, fontSize: 12 }}>{t('users.subtitle')}</div>
          </div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer()}>
          {t('users.add')}
        </Button>
      </div>

      {/* Role stat cards — show top 4 most useful */}
      {userList.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {(['super_admin', 'admin', 'location_manager', 'location_operator', 'org_viewer', 'viewer'] as const)
            .filter((r) => (roleCounts[r] || 0) > 0)
            .map((role) => (
              <RoleStatCard key={role} role={role} count={roleCounts[role] || 0} isDark={isDark} />
            ))}
        </div>
      )}

      {/* Table */}
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <Table<User>
          dataSource={userList}
          rowKey="id"
          loading={isLoading}
          size="small"
          rowClassName={(r) => !r.is_active ? 'users-row-inactive' : ''}
          onRow={() => ({ style: { animation: 'usersRowIn 0.2s ease-out' } })}
          pagination={false}
          columns={[
            {
              title: '',
              width: 44,
              render: (_, r) => {
                const hex = ROLE_HEX[r.role] || '#64748b'
                return (
                  <Avatar size={28} style={{ background: isDark ? `${hex}30` : `${hex}20`, color: hex, fontSize: 12, border: `1px solid ${hex}40` }}>
                    {r.username?.[0]?.toUpperCase()}
                  </Avatar>
                )
              },
            },
            {
              title: t('users.col_username'),
              dataIndex: 'username',
              render: (v, r) => (
                <div>
                  <span style={{ fontWeight: 600, color: C.text, fontSize: 13 }}>{v}</span>
                  {r.id === currentUser?.id && (
                    <Tag style={{ marginLeft: 6, fontSize: 10, color: '#3b82f6', borderColor: '#3b82f640', background: '#3b82f615' }}>me</Tag>
                  )}
                  {!r.is_active && (
                    <Tag style={{ marginLeft: 4, fontSize: 10, color: C.dim, borderColor: C.border, background: C.bg2 }}>inactive</Tag>
                  )}
                  {/* Show location count badge for location-scoped users */}
                  {r.locations && r.locations.length > 0 && (
                    <Tag style={{ marginLeft: 4, fontSize: 10, color: '#06b6d4', borderColor: '#06b6d440', background: '#06b6d415' }}>
                      <EnvironmentOutlined style={{ marginRight: 2 }} />{r.locations.length}
                    </Tag>
                  )}
                </div>
              ),
            },
            {
              title: t('users.col_role'),
              dataIndex: 'role',
              width: 150,
              render: (v) => {
                const hex = ROLE_HEX[v] || '#64748b'
                return (
                  <Tag style={{ color: hex, borderColor: hex + '50', background: hex + '18', fontSize: 11 }}>
                    {ROLE_LABEL[v] || v}
                  </Tag>
                )
              },
            },
            ...(isSA ? [{
              title: t('users.organization'),
              dataIndex: 'tenant_name',
              width: 160,
              render: (v: string | null) => v
                ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 12 }}>
                    <ApartmentOutlined style={{ fontSize: 11 }} />
                    {v}
                  </span>
                )
                : <span style={{ color: C.dim, fontSize: 12 }}>—</span>,
            }] : []),
            {
              title: t('users.col_active'),
              dataIndex: 'is_active',
              width: 80,
              render: (v) => (
                <Badge
                  status={v ? 'success' : 'error'}
                  text={<span style={{ fontSize: 12, color: C.muted }}>{v ? t('users.active') : t('users.inactive')}</span>}
                />
              ),
            },
            {
              title: t('users.col_last_login'),
              dataIndex: 'last_login',
              width: 130,
              render: (v) => v
                ? <span style={{ fontSize: 12, color: C.muted }}>{dayjs(v).format('DD.MM.YY HH:mm')}</span>
                : <span style={{ color: C.dim }}>—</span>,
            },
            {
              title: '',
              width: 130,
              render: (_, r) => (
                <Space size={4}>
                  <Tooltip title={t('common.edit')}>
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      style={{ color: C.muted, borderColor: C.border }}
                      onClick={() => openDrawer(r, 'general')}
                    />
                  </Tooltip>
                  <Tooltip title="Organizasyon & Lokasyonlar">
                    <Button
                      size="small"
                      icon={<EnvironmentOutlined />}
                      style={{ color: '#06b6d4', borderColor: '#06b6d440' }}
                      onClick={() => openDrawer(r, 'locations')}
                    />
                  </Tooltip>
                  <Button
                    size="small"
                    icon={<KeyOutlined />}
                    style={{ color: '#f59e0b', borderColor: '#f59e0b50' }}
                    onClick={() => { setResetUser(r); resetForm.resetFields() }}
                    title={t('users.reset_password')}
                  />
                  <Popconfirm
                    title={t('users.delete_confirm', { name: r.username })}
                    disabled={r.id === currentUser?.id || (!isSA && (r.role === 'admin' || r.role === 'super_admin'))}
                    onConfirm={() => deleteMutation.mutate(r.id)}
                  >
                    <Button
                      size="small" icon={<DeleteOutlined />} danger
                      disabled={r.id === currentUser?.id || (!isSA && (r.role === 'admin' || r.role === 'super_admin'))}
                    />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>

      {/* Password Reset Modal */}
      <Modal
        open={!!resetUser}
        onCancel={() => { setResetUser(null); resetForm.resetFields() }}
        title={<span style={{ color: C.text }}>{t('users.reset_password_for', { name: resetUser?.username })}</span>}
        footer={null}
        styles={{ content: { background: C.bg }, header: { background: C.bg } }}
      >
        <Form
          form={resetForm}
          layout="vertical"
          onFinish={(v) => resetPasswordMutation.mutate({ id: resetUser!.id, password: v.new_password })}
        >
          <Form.Item
            label={t('users.new_password')}
            name="new_password"
            rules={[{ required: true, min: 8, message: t('header.password_min_length') }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item
            label={t('users.new_password_confirm')}
            name="confirm"
            dependencies={['new_password']}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                  return Promise.reject(t('users.passwords_mismatch'))
                },
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={resetPasswordMutation.isPending} icon={<KeyOutlined />}>
              {t('users.reset_btn')}
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      {/* User Create/Edit Drawer */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={<span style={{ color: C.text }}>{editUser ? t('users.edit_title') : t('users.new_title')}</span>}
        width={460}
        destroyOnHidden
        styles={{
          body: { background: C.bg, padding: 0 },
          header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
        }}
      >
        <Form
          layout="vertical"
          initialValues={editUser
            ? { email: editUser.email, full_name: editUser.full_name, role: editUser.role, is_active: editUser.is_active, tenant_id: editUser.tenant_id }
            : { role: 'viewer', is_active: true }
          }
          onFinish={onSubmit}
        >
          <Tabs
            activeKey={drawerTab}
            onChange={setDrawerTab}
            size="small"
            style={{ paddingTop: 4 }}
            tabBarStyle={{ paddingInline: 20, marginBottom: 0 }}
            items={[
              {
                key: 'general',
                label: <span><UserOutlined style={{ marginRight: 6 }} />Genel</span>,
                children: (
                  <div style={{ padding: '16px 20px' }}>
                    {!editUser && (
                      <Form.Item label={t('users.form_username')} name="username" rules={[{ required: true }]}>
                        <Input prefix={<UserOutlined style={{ color: C.muted }} />} />
                      </Form.Item>
                    )}
                    {!editUser && (
                      <Form.Item label="E-posta" name="email" rules={[{ required: true, type: 'email', message: 'Geçerli bir e-posta girin' }]}>
                        <Input prefix={<MailOutlined style={{ color: C.muted }} />} />
                      </Form.Item>
                    )}
                    {!editUser && (
                      <Form.Item label={t('users.form_password')} name="password" rules={[{ required: true, min: 8 }]}>
                        <Input.Password />
                      </Form.Item>
                    )}
                    <Form.Item label={t('users.form_role')} name="role" rules={[{ required: true }]}>
                      <Select options={ROLE_OPTIONS_FILTERED} />
                    </Form.Item>
                    <Form.Item label={t('users.form_active')} name="is_active" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                  </div>
                ),
              },
              {
                key: 'locations',
                label: (
                  <span>
                    <EnvironmentOutlined style={{ marginRight: 6, color: '#06b6d4' }} />
                    Org & Lokasyonlar
                    {locAssignments.length > 0 && (
                      <Tag style={{ marginLeft: 6, fontSize: 10, padding: '0 4px', lineHeight: '16px' }} color="cyan">
                        {locAssignments.length}
                      </Tag>
                    )}
                  </span>
                ),
                children: (
                  <div style={{ padding: '16px 20px' }}>
                    {isSA && (
                      <>
                        <div style={{ color: C.muted, fontSize: 12, marginBottom: 6 }}>Organizasyon</div>
                        <Form.Item name="tenant_id" style={{ marginBottom: 16 }}>
                          <Select options={tenantOptions} allowClear placeholder={t('users.tenant_placeholder')} />
                        </Form.Item>
                        <Divider style={{ margin: '0 0 16px', borderColor: C.border }} />
                      </>
                    )}
                    <div style={{ color: C.muted, fontSize: 12, marginBottom: 10 }}>
                      Kullanıcının erişebileceği lokasyonları ve rolünü belirleyin.
                      <br />
                      <span style={{ color: '#f59e0b' }}>Admin ve Org Viewer rolleri tüm lokasyonlara otomatik erişir.</span>
                    </div>

                    {/* Add location */}
                    <div style={{
                      background: isDark ? '#0f172a' : '#f8fafc',
                      border: `1px solid ${C.border}`,
                      borderRadius: 8, padding: 12, marginBottom: 14,
                    }}>
                      <div style={{ color: C.text, fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Lokasyon Ekle</div>
                      <Select
                        placeholder="Lokasyon seç"
                        style={{ width: '100%', marginBottom: 8 }}
                        value={addLocId}
                        onChange={setAddLocId}
                        options={locationOptions.filter((l) => !locAssignments.find((a) => a.location_id === l.value))}
                        showSearch
                        filterOption={(input, opt) => (opt?.label as string)?.toLowerCase().includes(input.toLowerCase())}
                      />
                      <Space style={{ width: '100%' }}>
                        <Select
                          value={addLocRole}
                          onChange={setAddLocRole}
                          style={{ minWidth: 180 }}
                          options={LOC_ROLE_OPTIONS}
                        />
                        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={addLocAssignment} disabled={!addLocId}>
                          Ekle
                        </Button>
                      </Space>
                    </div>

                    <div style={{ color: C.muted, fontSize: 12, marginBottom: 8 }}>
                      Atanmış Lokasyonlar ({locAssignments.length})
                    </div>
                    {locAssignments.length === 0 ? (
                      <Empty description="Henüz lokasyon atanmamış" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {locAssignments.map((a) => {
                          const locName = locNameMap[a.location_id] || `Lokasyon #${a.location_id}`
                          const roleHex = a.loc_role === 'location_manager' ? '#06b6d4' : a.loc_role === 'location_operator' ? '#3b82f6' : '#22c55e'
                          return (
                            <div key={a.location_id} style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              background: isDark ? '#0f172a' : '#f8fafc',
                              border: `1px solid ${C.border}`,
                              borderRadius: 6, padding: '7px 10px',
                            }}>
                              <EnvironmentOutlined style={{ color: roleHex, flexShrink: 0 }} />
                              <span style={{ flex: 1, color: C.text, fontSize: 13, fontWeight: 500 }}>{locName}</span>
                              <Select
                                value={a.loc_role}
                                onChange={(v) => updateLocRole(a.location_id, v)}
                                size="small"
                                style={{ width: 155 }}
                                options={LOC_ROLE_OPTIONS}
                              />
                              <Button size="small" type="text" danger icon={<MinusCircleOutlined />}
                                onClick={() => removeLocAssignment(a.location_id)} />
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ),
              },
            ]}
          />

          <div style={{ padding: '12px 20px', borderTop: `1px solid ${C.border}` }}>
            <Button type="primary" htmlType="submit" loading={createMutation.isPending || updateMutation.isPending} block>
              {editUser ? t('common.save') : t('common.add')}
            </Button>
          </div>
        </Form>
      </Drawer>

      {/* ── Invite Management ──────────────────────────────────────────── */}
      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <MailOutlined style={{ color: '#3b82f6' }} />
            <span style={{ color: C.text, fontWeight: 600, fontSize: 14 }}>Davet Linkleri</span>
            <span style={{ color: C.muted, fontSize: 12 }}>— Kullanıcıları e-posta yerine link ile davet edin</span>
          </div>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { inviteForm.resetFields(); setLastInviteLink(null); setInviteModalOpen(true) }}>
            Davet Oluştur
          </Button>
        </div>
        <Table<Invite>
          size="small"
          dataSource={invites ?? []}
          rowKey="id"
          pagination={false}
          locale={{ emptyText: 'Henüz davet oluşturulmamış' }}
          columns={[
            {
              title: 'E-posta',
              dataIndex: 'email',
              render: (email: string) => <span style={{ fontSize: 13 }}>{email}</span>,
            },
            {
              title: 'Rol',
              dataIndex: 'role',
              width: 130,
              render: (role: string) => (
                <Tag style={{ fontSize: 11, color: ROLE_HEX[role] || '#94a3b8', borderColor: (ROLE_HEX[role] || '#94a3b8') + '40', background: (ROLE_HEX[role] || '#94a3b8') + '15' }}>
                  {ROLE_LABEL[role] || role.toUpperCase()}
                </Tag>
              ),
            },
            {
              title: 'Bitiş',
              dataIndex: 'expires_at',
              width: 130,
              render: (v: string) => <span style={{ fontSize: 12, color: C.muted }}>{dayjs(v).format('DD.MM.YYYY HH:mm')}</span>,
            },
            {
              title: 'Durum',
              width: 110,
              render: (_: unknown, rec: Invite) => rec.is_used
                ? <Tag icon={<CheckCircleOutlined />} color="success" style={{ fontSize: 11 }}>Kullanıldı</Tag>
                : rec.is_expired
                  ? <Tag color="default" style={{ fontSize: 11 }}>Süresi Doldu</Tag>
                  : <Tag color="processing" style={{ fontSize: 11 }}>Aktif</Tag>,
            },
            {
              title: '',
              width: 80,
              render: (_: unknown, rec: Invite) => (
                <Space size={4}>
                  {!rec.is_used && !rec.is_expired && (
                    <Tooltip title="Linki Kopyala">
                      <Button
                        size="small" type="text"
                        icon={<LinkOutlined />}
                        onClick={() => {
                          message.info('Token güvenlik amacıyla saklanmıyor — yeni davet oluşturun')
                        }}
                      />
                    </Tooltip>
                  )}
                  <Popconfirm title="Daveti iptal et?" onConfirm={() => revokeInviteMutation.mutate(rec.id)}>
                    <Tooltip title="İptal Et">
                      <Button size="small" type="text" danger icon={<StopOutlined />} />
                    </Tooltip>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>

      {/* Create invite modal */}
      <Modal
        title={<span style={{ color: C.text }}><MailOutlined style={{ marginRight: 8, color: '#3b82f6' }} />Davet Linki Oluştur</span>}
        open={inviteModalOpen}
        onOk={lastInviteLink ? () => setInviteModalOpen(false) : handleCreateInvite}
        onCancel={() => setInviteModalOpen(false)}
        okText={lastInviteLink ? 'Tamam' : 'Davet Oluştur'}
        cancelText="İptal"
        confirmLoading={createInviteMutation.isPending}
        width={480}
        styles={{ body: { background: C.bg }, header: { background: C.bg } }}
      >
        {lastInviteLink ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ background: isDark ? '#071224' : '#f0f9ff', border: `1px solid ${isDark ? '#1a3458' : '#bae6fd'}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ color: '#22c55e', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>✓ Davet linki panoya kopyalandı</div>
              <div style={{ fontSize: 11, color: C.muted, wordBreak: 'break-all', fontFamily: 'monospace' }}>{lastInviteLink}</div>
            </div>
            <div style={{ color: C.muted, fontSize: 12 }}>Bu linki davette bulunmak istediğiniz kişiyle paylaşın. Link tek kullanımlıktır.</div>
          </div>
        ) : (
          <Form form={inviteForm} layout="vertical" style={{ marginTop: 16 }} initialValues={{ role: 'viewer', expires_hours: 72 }}>
            <Form.Item label="E-posta Adresi" name="email" rules={[{ required: true, type: 'email', message: 'Geçerli bir e-posta girin' }]}>
              <Input placeholder="kullanici@sirket.com" />
            </Form.Item>
            <Form.Item label="Rol" name="role" rules={[{ required: true }]}>
              <Select options={ROLE_OPTIONS.filter((r) => r.value !== 'super_admin')} />
            </Form.Item>
            <Form.Item label="Geçerlilik Süresi" name="expires_hours" rules={[{ required: true }]}>
              <Select options={[
                { label: '24 saat', value: 24 },
                { label: '3 gün', value: 72 },
                { label: '7 gün', value: 168 },
                { label: '30 gün', value: 720 },
              ]} />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  )
}
