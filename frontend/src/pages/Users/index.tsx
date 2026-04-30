import { useState } from 'react'
import {
  App, Button, Drawer, Form, Input, Popconfirm, Select,
  Space, Table, Tag, Switch, Avatar, Badge, Modal,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  TeamOutlined, UserOutlined, SafetyOutlined, ApartmentOutlined, KeyOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { usersApi } from '@/api/users'
import { tenantsApi } from '@/api/tenants'
import { useTheme } from '@/contexts/ThemeContext'
import type { User } from '@/types'
import { ROLE_OPTIONS } from '@/types'
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
  super_admin: '#ef4444', admin: '#f97316', operator: '#3b82f6', viewer: '#22c55e',
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: 'SUPER ADMIN', admin: 'ADMIN', operator: 'OPERATOR', viewer: 'VIEWER',
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
      borderRadius: 10,
      padding: '12px 16px',
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
  const [editUser, setEditUser] = useState<User | null>(null)
  const [resetUser, setResetUser] = useState<User | null>(null)
  const [resetForm] = Form.useForm()

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
  })

  const { data: tenants } = useQuery({
    queryKey: ['tenants'],
    queryFn: tenantsApi.list,
    enabled: isSA,
  })

  const tenantOptions = (tenants || []).map((t) => ({ label: t.name, value: t.id }))

  const createMutation = useMutation({
    mutationFn: usersApi.create,
    onSuccess: () => { message.success(t('users.created')); setDrawerOpen(false); queryClient.invalidateQueries({ queryKey: ['users'] }) },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('users.create_error')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) => usersApi.update(id, data),
    onSuccess: () => { message.success(t('users.updated')); setDrawerOpen(false); queryClient.invalidateQueries({ queryKey: ['users'] }) },
  })

  const deleteMutation = useMutation({
    mutationFn: usersApi.delete,
    onSuccess: () => { message.success(t('users.deleted')); queryClient.invalidateQueries({ queryKey: ['users'] }) },
  })

  const resetPasswordMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) => usersApi.resetPassword(id, password),
    onSuccess: () => { message.success(t('users.password_reset_success')); setResetUser(null); resetForm.resetFields() },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('users.password_reset_error')),
  })

  const onSubmit = (values: Record<string, unknown>) => {
    if (editUser) updateMutation.mutate({ id: editUser.id, data: values })
    else createMutation.mutate(values)
  }

  const userList = users || []
  const roleCounts: Record<string, number> = {}
  for (const u of userList) {
    roleCounts[u.role] = (roleCounts[u.role] || 0) + 1
  }

  const ROLE_OPTIONS_FILTERED = isSA
    ? ROLE_OPTIONS
    : ROLE_OPTIONS.filter((o) => o.value !== 'super_admin')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <style>{USERS_CSS}</style>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#3b82f620' : C.border}`,
        borderLeft: '4px solid #3b82f6',
        borderRadius: 12,
        padding: '16px 20px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
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
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditUser(null); setDrawerOpen(true) }}>
          {t('users.add')}
        </Button>
      </div>

      {/* Role stat cards */}
      {userList.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {(['super_admin', 'admin', 'operator', 'viewer'] as const).map((role) => (
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
                </div>
              ),
            },
            {
              title: t('users.col_role'),
              dataIndex: 'role',
              width: 130,
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
              title: t('users.col_created'),
              dataIndex: 'created_at',
              width: 100,
              render: (v) => v
                ? <span style={{ fontSize: 12, color: C.dim }}>{dayjs(v).format('DD.MM.YY')}</span>
                : <span style={{ color: C.dim }}>—</span>,
            },
            {
              title: '',
              width: 110,
              render: (_, r) => (
                <Space size={4}>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    style={{ color: C.muted, borderColor: C.border }}
                    onClick={() => { setEditUser(r); setDrawerOpen(true) }}
                  />
                  <Button
                    size="small"
                    icon={<KeyOutlined />}
                    style={{ color: '#f59e0b', borderColor: '#f59e0b50' }}
                    onClick={() => { setResetUser(r); resetForm.resetFields() }}
                    title={t('users.reset_password')}
                  />
                  <Popconfirm
                    title={t('users.delete_confirm', { name: r.username })}
                    disabled={r.id === currentUser?.id}
                    onConfirm={() => deleteMutation.mutate(r.id)}
                  >
                    <Button size="small" icon={<DeleteOutlined />} danger disabled={r.id === currentUser?.id} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>

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
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={resetPasswordMutation.isPending}
              icon={<KeyOutlined />}
            >
              {t('users.reset_btn')}
            </Button>
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={<span style={{ color: C.text }}>{editUser ? t('users.edit_title') : t('users.new_title')}</span>}
        width={400}
        destroyOnHidden
        styles={{
          body: { background: C.bg },
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
          {!editUser && (
            <Form.Item label={t('users.form_username')} name="username" rules={[{ required: true }]}>
              <Input prefix={<UserOutlined style={{ color: C.muted }} />} />
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
          {isSA && (
            <Form.Item label={t('users.organization')} name="tenant_id">
              <Select
                options={tenantOptions}
                allowClear
                placeholder={t('users.tenant_placeholder')}
              />
            </Form.Item>
          )}
          <Form.Item label={t('users.form_active')} name="is_active" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={createMutation.isPending || updateMutation.isPending}
              block
            >
              {editUser ? t('common.save') : t('common.add')}
            </Button>
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  )
}
