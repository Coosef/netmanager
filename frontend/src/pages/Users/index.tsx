import { useMemo, useState } from 'react'
import {
  App, Button, Drawer, Form, Input, Popconfirm, Select,
  Space, Tag, Switch, Avatar, Modal, Tooltip,
  Divider, Empty, Tabs,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  TeamOutlined, UserOutlined, ApartmentOutlined,
  KeyOutlined, EnvironmentOutlined, MinusCircleOutlined,
  MailOutlined, LinkOutlined, StopOutlined, CheckCircleOutlined,
  LockOutlined, UnlockOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { usersApi } from '@/api/users'
import { superadminApi } from '@/api/superadmin'
import { locationsApi } from '@/api/locations'
import { invitesApi, type Invite } from '@/api/invites'
import { useTheme } from '@/contexts/ThemeContext'
import type { User } from '@/types'
import { ROLE_OPTIONS } from '@/types'
import { useAuthStore } from '@/store/auth'
import { useTranslation, Trans } from 'react-i18next'
import dayjs from 'dayjs'

// Drawer içindeki lokasyon ataması artık SADECE "hangi lokasyonları
// görür" sorusunu yanıtlıyor. Gerçek yetki seviyesini `system_role`
// belirliyor (org_admin / location_admin / viewer). Eski per-location
// `loc_role` (manager/operator/viewer) runtime'da hiçbir yerde
// okunmuyordu — UI'dan kaldırdık, schema BC için backend'e default
// 'location_viewer' gönderiyoruz; ince ayar için /permissions matrisi.
const LOC_BC_DEFAULT_ROLE = 'location_viewer'

const USERS_CSS = `
@keyframes usersRowIn {
  from { opacity: 0; transform: translateX(-4px); }
  to   { opacity: 1; transform: translateX(0); }
}
.users-row-inactive td { opacity: 0.55; }
`

// RBAC F2 — 4-role colour map. Legacy keys (admin, org_viewer,
// location_manager, location_operator, location_viewer, operator, member)
// are kept as aliases that point at the same colour as their normalised
// target so OLD invite tokens / persisted state still render correctly
// while the backend setter is migrating values.
//
// KURAL-E1: ROLE_HEX teknik (renk) — module-level kalır. ROLE_LABEL UI
// metni → UsersPage içinde useMemo + t() ile çözülür (aşağı taşındı).
const ROLE_HEX: Record<string, string> = {
  super_admin:    '#ef4444',
  org_admin:      '#f97316',  admin:             '#f97316',
  location_admin: '#06b6d4',  location_manager:  '#06b6d4',  location_operator: '#06b6d4',
  viewer:         '#22c55e',  location_viewer:   '#22c55e',  org_viewer:        '#22c55e',
                              operator:          '#22c55e',  member:            '#22c55e',
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

// Note: bespoke RoleStatCard removed — superseded by the NOC `nm-statbar`
// in the page header which shows 6 KPIs (total/active/MFA/24h/invites/roles).
// `mkC()` is still referenced by drawer/modal styling below, kept for now.

export default function UsersPage() {
  const { message } = App.useApp()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { user: currentUser, isSuperAdmin } = useAuthStore()
  // RBAC F10 — `users` module = org-admin scope. Viewer / location_admin
  // see the list but cannot create / edit / delete / reset / invite.
  const canMutateUsers = useAuthStore((s) => s.canMutate('users'))
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
    onError: () => message.error(t('users.invite.toast_revoke_failed')),
  })

  const handleCreateInvite = async () => {
    const vals = await inviteForm.validateFields()
    createInviteMutation.mutate(vals)
  }

  // Location assignments — sadece location_id listesi tutuyoruz, ekrana
  // yalnızca lokasyon adı çıkıyor. Backend hâlâ {location_id, loc_role}
  // tuple bekliyor (geriye dönük şema); onSubmit'te LOC_BC_DEFAULT_ROLE
  // ile dolduruluyor.
  const [locAssignments, setLocAssignments] = useState<{ location_id: number }[]>([])
  const [addLocId, setAddLocId] = useState<number | null>(null)

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
  })

  // Org list — used in the per-user "Organisation" select (super-admin only).
  // Sourced from /super-admin/orgs (no counts needed for the dropdown).
  const { data: orgsData } = useQuery({
    queryKey: ['users-page-orgs'],
    queryFn: () => superadminApi.listOrgs({ per_page: 500 }),
    enabled: isSA,
  })

  const { data: locationsData } = useQuery({
    queryKey: ['locations'],
    queryFn: () => locationsApi.list(),
    enabled: drawerOpen,
  })

  const tenantOptions = (orgsData?.orgs || []).map((o) => ({ label: o.name, value: o.id }))
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
    setLocAssignments((user?.locations || []).map((l) => ({ location_id: l.location_id })))
    setAddLocId(null)
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
        // BC: backend hâlâ loc_role tuple bekliyor; her satıra default
        // ekliyoruz. Yetki gerçekte system_role tarafından sürülüyor.
        await usersApi.setLocations(
          userId,
          locAssignments.map((a) => ({ ...a, loc_role: LOC_BC_DEFAULT_ROLE })),
        )
      } catch (locErr: any) {
        const d = locErr?.response?.data?.detail
        message.error(typeof d === 'string' ? d : 'Lokasyon atamaları kaydedilemedi')
        return
      }
      // If the current user edited their own profile, refresh the auth store
      if (editUser && editUser.id === currentUser?.id && updatedUser) {
        const { setAuth, token } = useAuthStore.getState()
        setAuth(token!, { id: updatedUser.id, username: updatedUser.username, role: updatedUser.role as any, system_role: (updatedUser as any).system_role ?? 'member', org_id: (updatedUser as any).org_id })
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
    if (exists) { message.warning(t('users.locations.toast_already_added')); return }
    setLocAssignments([...locAssignments, { location_id: addLocId }])
    setAddLocId(null)
  }

  const removeLocAssignment = (locId: number) => {
    setLocAssignments(locAssignments.filter((a) => a.location_id !== locId))
  }

  const userList = users || []
  const roleCounts: Record<string, number> = {}
  for (const u of userList) {
    roleCounts[u.role] = (roleCounts[u.role] || 0) + 1
  }

  // ── Stats for the NOC stat bar (real numbers, never mock) ─────────────
  // 24h = users that logged in within the last 24h. mfa = mfa_enabled column
  // surfaced by UserResponse. activeInvites = invites neither used nor expired.
  const stats = useMemo(() => {
    const now = dayjs()
    const active = userList.filter((u) => u.is_active).length
    const mfa = userList.filter((u) => (u as any).mfa_enabled).length
    const last24h = userList.filter((u) =>
      u.last_login && now.diff(dayjs(u.last_login), 'hour') <= 24,
    ).length
    const pendingInvites = (invites || []).filter((i: any) => !i.is_used && !i.is_expired).length
    const distinctRoles = new Set(userList.map((u) => u.role)).size
    return { total: userList.length, active, mfa, last24h, pendingInvites, distinctRoles }
  }, [userList, invites])

  // KURAL-E1 — ROLE_LABEL hook scope'unda useMemo + t().
  // Legacy alias keys (admin/org_viewer/location_manager/... — aşağıda
  // module-level ROLE_HEX'te listelenenler) yine aynı i18n etiketine
  // map'lenir; eski payload/token'lar doğru render olur.
  const ROLE_LABEL = useMemo<Record<string, string>>(() => ({
    super_admin:       t('users.role.super_admin'),
    org_admin:         t('users.role.org_admin'),         admin:             t('users.role.org_admin'),
    location_admin:    t('users.role.location_admin'),    location_manager:  t('users.role.location_admin'),
                                                          location_operator: t('users.role.location_admin'),
    viewer:            t('users.role.viewer'),            location_viewer:   t('users.role.viewer'),
    org_viewer:        t('users.role.viewer'),            operator:          t('users.role.viewer'),
    member:            t('users.role.viewer'),
  }), [t])

  // Only a super-admin may grant another user the super_admin role; org
  // admins may not create / promote to super_admin or to org_admin.
  // KURAL-E1: ROLE_OPTIONS types/ module'unde TR label ile sabit; burada
  // useMemo ile aktif dilde label override edilir.
  const ROLE_OPTIONS_FILTERED = useMemo(() => {
    const localized = ROLE_OPTIONS.map((o) => ({
      value: o.value,
      label: ROLE_LABEL[o.value] ?? o.label,
    }))
    return isSA
      ? localized
      : localized.filter((o) => o.value !== 'super_admin' && o.value !== 'org_admin')
  }, [ROLE_LABEL, isSA])

  // Invite expiration options — hook scope (KURAL-E1).
  const EXPIRES_OPTIONS = useMemo(() => [
    { label: t('users.invite.expires.24h'), value: 24 },
    { label: t('users.invite.expires.3d'),  value: 72 },
    { label: t('users.invite.expires.7d'),  value: 168 },
    { label: t('users.invite.expires.30d'), value: 720 },
  ], [t])

  const locNameMap = Object.fromEntries(
    (locationsData?.items || []).map((l) => [l.id, l.name])
  )

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <style>{USERS_CSS}</style>

      {/* NOC header */}
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>{t('settings.crumb_admin')}</span><span>{t('users.title')}</span></div>
          <h1 className="nm-page-title">
            {t('users.title')}
            <span className="nm-pill mono">{t('users.users_count', { count: userList.length })}</span>
          </h1>
          <div className="nm-page-sub">
            {t('users.subtitle', 'Kullanıcı kayıtları · rol & lokasyon ataması · davet linkleri ve şifre yönetimi.')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canMutateUsers && (
            <Button icon={<MailOutlined />}
              onClick={() => { inviteForm.resetFields(); setLastInviteLink(null); setInviteModalOpen(true) }}>
              {t('users.invite.btn_new')}
            </Button>
          )}
          {canMutateUsers && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openDrawer()}>
              {t('users.add')}
            </Button>
          )}
        </div>
      </div>

      {/* NOC stat bar — 6 real KPIs */}
      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">{t('users.stat.total')}</div>
          <div className="nm-stat-val">{stats.total}</div>
          <div className="nm-stat-delta">{t('users.stat.distinct_roles', { count: stats.distinctRoles })}</div>
        </div>
        <div className={`nm-stat ${stats.active === stats.total ? 'ok' : ''}`}>
          <div className="nm-stat-label">{t('users.stat.active')}</div>
          <div className="nm-stat-val">{stats.active}</div>
          <div className="nm-stat-delta">{t('users.stat.inactive_count', { count: stats.total - stats.active })}</div>
        </div>
        <div className={`nm-stat ${stats.mfa > 0 ? 'ok' : 'warn'}`}>
          <div className="nm-stat-label">{t('users.stat.mfa_on')}</div>
          <div className="nm-stat-val">{stats.mfa}</div>
          <div className="nm-stat-delta">{t('users.stat.mfa_coverage', { pct: stats.total > 0 ? Math.round((stats.mfa / stats.total) * 100) : 0 })}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('users.stat.login_24h')}</div>
          <div className="nm-stat-val">{stats.last24h}</div>
          <div className="nm-stat-delta">{t('users.stat.activity_window')}</div>
        </div>
        <div className={`nm-stat ${stats.pendingInvites > 0 ? 'warn' : ''}`}>
          <div className="nm-stat-label">{t('users.stat.pending_invite')}</div>
          <div className="nm-stat-val">{stats.pendingInvites}</div>
          <div className="nm-stat-delta">{t('users.stat.active_link')}</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">{t('users.stat.super_admin')}</div>
          <div className="nm-stat-val">{roleCounts['super_admin'] || 0}</div>
          <div className="nm-stat-delta">{t('users.stat.org_admin_count', { count: roleCounts['admin'] || 0 })}</div>
        </div>
      </div>

      {/* Users table — nm-table look */}
      <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="nm-card-hd">
          <h3><TeamOutlined /> {t('users.card_title')}</h3>
          <span className="nm-pill mono">{userList.length}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="nm-table">
            <thead>
              <tr>
                <th style={{ width: 42 }}></th>
                <th>{t('users.col_username')}</th>
                <th style={{ width: 130 }}>{t('users.col_role')}</th>
                {isSA && <th style={{ width: 160 }}>{t('users.organization')}</th>}
                <th style={{ width: 100 }}>{t('users.col_active')}</th>
                <th style={{ width: 90 }}>MFA</th>
                <th style={{ width: 140 }}>{t('users.col_last_login')}</th>
                <th className="col-actions" style={{ width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={isSA ? 8 : 7} style={{ textAlign: 'center', padding: 24, color: 'var(--fg-3)' }}>{t('common.loading')}</td></tr>
              )}
              {!isLoading && userList.length === 0 && (
                <tr><td colSpan={isSA ? 8 : 7} style={{ textAlign: 'center', padding: 30, color: 'var(--fg-3)' }}>{t('users.empty_users')}</td></tr>
              )}
              {!isLoading && userList.map((r) => {
                const hex = ROLE_HEX[r.role] || '#64748b'
                const mfaOn = !!(r as any).mfa_enabled
                const isMe = r.id === currentUser?.id
                // Org admins cannot delete super_admin or other org_admin
                // accounts — only super-admins (platform) can; never delete self.
                const isProtected = isMe || (!isSA && (r.role === 'org_admin' || r.role === 'super_admin'))
                return (
                  <tr key={r.id} className={!r.is_active ? 'users-row-inactive' : ''}>
                    <td>
                      <Avatar size={28} style={{ background: `${hex}25`, color: hex, fontSize: 12, border: `1px solid ${hex}50` }}>
                        {r.username?.[0]?.toUpperCase()}
                      </Avatar>
                    </td>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{r.username}</div>
                      <div style={{ fontSize: 11, color: 'var(--fg-3)', marginTop: 2 }}>
                        {r.email}
                        {isMe && <span className="nm-pill" style={{ marginLeft: 6, padding: '0 6px', fontSize: 9.5, color: 'var(--accent)', borderColor: 'var(--accent)' }}>{t('users.you_pill')}</span>}
                        {r.locations && r.locations.length > 0 && (
                          <span className="nm-pill" style={{ marginLeft: 6, padding: '0 6px', fontSize: 9.5 }}>
                            <EnvironmentOutlined style={{ marginRight: 3 }} />{t('users.locations_short', { count: r.locations.length })}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="nm-pill mono" style={{ color: hex, borderColor: hex + '55', background: hex + '12' }}>
                        {ROLE_LABEL[r.role] || r.role}
                      </span>
                    </td>
                    {isSA && (
                      <td style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                        {r.organization_name ? (
                          <span><ApartmentOutlined style={{ fontSize: 11, marginRight: 4 }} />{r.organization_name}</span>
                        ) : <span style={{ color: 'var(--fg-3)' }}>—</span>}
                      </td>
                    )}
                    <td>
                      <span className={`nm-status-dot ${r.is_active ? 'ok' : 'crit'} pulse`} />
                      <span style={{ fontSize: 12, marginLeft: 6 }}>{r.is_active ? t('users.active') : t('users.inactive')}</span>
                    </td>
                    <td>
                      {mfaOn ? (
                        <span className="nm-pill mono" style={{ color: 'var(--ok)', borderColor: 'var(--ok)', background: 'transparent' }}>
                          <LockOutlined style={{ marginRight: 3 }} />{t('users.mfa_on_short')}
                        </span>
                      ) : (
                        <span className="nm-pill mono" style={{ color: 'var(--fg-3)', borderColor: 'var(--border-0)', background: 'transparent' }}>
                          <UnlockOutlined style={{ marginRight: 3 }} />{t('users.mfa_off_short')}
                        </span>
                      )}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                      {r.last_login
                        ? <span className="mono">{dayjs(r.last_login).format('DD.MM.YY HH:mm')}</span>
                        : <span style={{ color: 'var(--fg-3)' }}>—</span>}
                    </td>
                    <td className="col-actions">
                      {canMutateUsers ? (
                        <span className="nm-rowact" onClick={(e) => e.stopPropagation()}>
                          <Tooltip title={t('common.edit')}>
                            <button onClick={() => openDrawer(r, 'general')}><EditOutlined /></button>
                          </Tooltip>
                          <Tooltip title={t('users.tab.org_locations')}>
                            <button onClick={() => openDrawer(r, 'locations')}><EnvironmentOutlined /></button>
                          </Tooltip>
                          <Tooltip title={t('users.reset_password')}>
                            <button onClick={() => { setResetUser(r); resetForm.resetFields() }}>
                              <KeyOutlined style={{ color: 'var(--warn)' }} />
                            </button>
                          </Tooltip>
                          <Popconfirm
                            title={t('users.delete_confirm', { name: r.username })}
                            disabled={isProtected}
                            onConfirm={() => deleteMutation.mutate(r.id)}
                          >
                            <button disabled={isProtected}>
                              <DeleteOutlined style={{ color: isProtected ? 'var(--fg-3)' : 'var(--crit)' }} />
                            </button>
                          </Popconfirm>
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
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
            ? { email: editUser.email, full_name: editUser.full_name, role: editUser.role, is_active: editUser.is_active, organization_id: editUser.org_id, allowed_ips: editUser.allowed_ips ?? '' }
            : { role: 'viewer', is_active: true, allowed_ips: '' }
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
                label: <span><UserOutlined style={{ marginRight: 6 }} />{t('users.tab.general')}</span>,
                children: (
                  <div style={{ padding: '16px 20px' }}>
                    {!editUser && (
                      <Form.Item label={t('users.form_username')} name="username" rules={[{ required: true }]}>
                        <Input prefix={<UserOutlined style={{ color: C.muted }} />} />
                      </Form.Item>
                    )}
                    {!editUser && (
                      <Form.Item label={t('users.form_email_label')} name="email" rules={[{ required: true, type: 'email', message: t('common.validation.email_invalid') }]}>
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

                    {/* T9 Tur 2 #4 — IP Allowlist */}
                    <Divider style={{ margin: '8px 0 12px', borderColor: C.border }} />
                    <Form.Item
                      label={
                        <span>
                          <LockOutlined style={{ marginRight: 6, color: '#f59e0b' }} />
                          {t('users.ip_allowlist.label')}
                        </span>
                      }
                      name="allowed_ips"
                      tooltip={
                        // KURAL-Trans: HTML embed (<code>) içerikli cümle — Trans component ile parçalama.
                        <Trans i18nKey="users.ip_allowlist.tooltip"
                          values={{ example: '10.0.0.0/8, 192.168.1.5, 1.2.3.4/32' }}
                          components={{ ex: <code /> }}
                        />
                      }
                      extra={
                        <span style={{ fontSize: 11, color: C.muted }}>
                          {t('users.ip_allowlist.extra')}
                        </span>
                      }
                    >
                      <Input
                        placeholder={t('users.ip_allowlist.placeholder')}
                        style={{ fontFamily: 'monospace' }}
                      />
                    </Form.Item>
                  </div>
                ),
              },
              {
                key: 'locations',
                label: (
                  <span>
                    <EnvironmentOutlined style={{ marginRight: 6, color: '#06b6d4' }} />
                    {t('users.tab.org_locations')}
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
                        <div style={{ color: C.muted, fontSize: 12, marginBottom: 6 }}>{t('users.locations.org_label')}</div>
                        <Form.Item name="organization_id" style={{ marginBottom: 16 }}>
                          <Select options={tenantOptions} allowClear placeholder={t('users.locations.org_placeholder')} />
                        </Form.Item>
                        <Divider style={{ margin: '0 0 16px', borderColor: C.border }} />
                      </>
                    )}
                    {/* Açıklama bloku — KURAL-Trans: <strong>/<em> embed; Trans component ile çevrilir. */}
                    <div style={{ color: C.muted, fontSize: 12, marginBottom: 10, lineHeight: 1.6 }}>
                      <Trans i18nKey="users.locations.intro" components={{ s: <strong />, e: <em /> }} />
                      <br />
                      <span style={{ color: '#22c55e' }}>
                        <Trans i18nKey="users.locations.bullet_super_admin" components={{ s: <strong /> }} />
                      </span>
                      <br />
                      <span style={{ color: '#f97316' }}>
                        <Trans i18nKey="users.locations.bullet_org_admin" components={{ s: <strong /> }} />
                      </span>
                      <br />
                      <span style={{ color: '#06b6d4' }}>
                        <Trans i18nKey="users.locations.bullet_location_admin" components={{ s: <strong /> }} />
                      </span>
                    </div>

                    {/* Add location — sadece location seç + Ekle */}
                    <div style={{
                      background: isDark ? '#0f172a' : '#f8fafc',
                      border: `1px solid ${C.border}`,
                      borderRadius: 8, padding: 12, marginBottom: 14,
                    }}>
                      <div style={{ color: C.text, fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t('users.locations.add_section_title')}</div>
                      <Space.Compact style={{ width: '100%' }}>
                        <Select
                          placeholder={t('users.locations.add_placeholder')}
                          style={{ flex: 1 }}
                          value={addLocId}
                          onChange={setAddLocId}
                          options={locationOptions.filter((l) => !locAssignments.find((a) => a.location_id === l.value))}
                          showSearch
                          filterOption={(input, opt) => (opt?.label as string)?.toLowerCase().includes(input.toLowerCase())}
                        />
                        <Button type="primary" icon={<PlusOutlined />} onClick={addLocAssignment} disabled={!addLocId}>
                          {t('common.add')}
                        </Button>
                      </Space.Compact>
                    </div>

                    <div style={{ color: C.muted, fontSize: 12, marginBottom: 8 }}>
                      {t('users.locations.assigned_label', { count: locAssignments.length })}
                    </div>
                    {locAssignments.length === 0 ? (
                      <Empty description={t('users.locations.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {locAssignments.map((a) => {
                          const locName = locNameMap[a.location_id] || t('users.locations.fallback_name', { id: a.location_id })
                          return (
                            <div key={a.location_id} style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              background: isDark ? '#0f172a' : '#f8fafc',
                              border: `1px solid ${C.border}`,
                              borderRadius: 6, padding: '7px 10px',
                            }}>
                              <EnvironmentOutlined style={{ color: '#06b6d4', flexShrink: 0 }} />
                              <span style={{ flex: 1, color: C.text, fontSize: 13, fontWeight: 500 }}>{locName}</span>
                              <Button size="small" type="text" danger icon={<MinusCircleOutlined />}
                                onClick={() => removeLocAssignment(a.location_id)} />
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* İnce ayar köprüsü — modül × eylem matrisine yönlendir */}
                    <Divider style={{ margin: '18px 0 10px', borderColor: C.border }} />
                    <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.6 }}>
                      <Trans
                        i18nKey="users.locations.fine_grained_hint"
                        components={{
                          permLink: (
                            <Link to="/permissions" onClick={() => setDrawerOpen(false)} style={{ color: 'var(--accent)' }} />
                          ),
                        }}
                      />
                    </div>
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
      <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="nm-card-hd">
          <h3><MailOutlined /> {t('users.invite.section_title')}</h3>
          <span className="nm-pill mono">{(invites || []).length}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="nm-table">
            <thead>
              <tr>
                <th>{t('users.invite.col.email')}</th>
                <th style={{ width: 130 }}>{t('users.invite.col.role')}</th>
                <th style={{ width: 150 }}>{t('users.invite.col.expires')}</th>
                <th style={{ width: 110 }}>{t('users.invite.col.status')}</th>
                <th className="col-actions" style={{ width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {(!invites || invites.length === 0) && (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--fg-3)' }}>{t('users.invite.empty')}</td></tr>
              )}
              {(invites || []).map((rec: Invite) => {
                const hex = ROLE_HEX[rec.role] || '#94a3b8'
                return (
                  <tr key={rec.id}>
                    <td style={{ fontSize: 13 }}>{rec.email}</td>
                    <td>
                      <span className="nm-pill mono" style={{ color: hex, borderColor: hex + '55', background: hex + '12' }}>
                        {ROLE_LABEL[rec.role] || rec.role.toUpperCase()}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                      {dayjs(rec.expires_at).format('DD.MM.YYYY HH:mm')}
                    </td>
                    <td>
                      {rec.is_used ? (
                        <span className="nm-pill" style={{ color: 'var(--ok)', borderColor: 'var(--ok)' }}>
                          <CheckCircleOutlined style={{ marginRight: 4 }} />{t('users.invite.status_used')}
                        </span>
                      ) : rec.is_expired ? (
                        <span className="nm-pill" style={{ color: 'var(--fg-3)', borderColor: 'var(--border-0)' }}>{t('users.invite.status_expired')}</span>
                      ) : (
                        <span className="nm-pill" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                          <span className="nm-status-dot ok pulse" style={{ marginRight: 4 }} />{t('users.invite.status_active')}
                        </span>
                      )}
                    </td>
                    <td className="col-actions">
                      {canMutateUsers ? (
                        <span className="nm-rowact" onClick={(e) => e.stopPropagation()}>
                          {!rec.is_used && !rec.is_expired && (
                            <Tooltip title={t('users.invite.tooltip_copy')}>
                              <button onClick={() => message.info(t('users.invite.toast_token_not_stored'))}>
                                <LinkOutlined />
                              </button>
                            </Tooltip>
                          )}
                          <Popconfirm title={t('users.invite.popconfirm_revoke_title')} onConfirm={() => revokeInviteMutation.mutate(rec.id)}>
                            <Tooltip title={t('users.invite.tooltip_revoke')}>
                              <button><StopOutlined style={{ color: 'var(--crit)' }} /></button>
                            </Tooltip>
                          </Popconfirm>
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--fg-3)' }}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create invite modal */}
      <Modal
        title={<span style={{ color: C.text }}><MailOutlined style={{ marginRight: 8, color: '#3b82f6' }} />{t('users.invite.modal.title')}</span>}
        open={inviteModalOpen}
        onOk={lastInviteLink ? () => setInviteModalOpen(false) : handleCreateInvite}
        onCancel={() => setInviteModalOpen(false)}
        okText={lastInviteLink ? t('users.invite.modal.ok_done') : t('users.invite.modal.ok_create')}
        cancelText={t('common.cancel')}
        confirmLoading={createInviteMutation.isPending}
        width={480}
        styles={{ body: { background: C.bg }, header: { background: C.bg } }}
      >
        {lastInviteLink ? (
          <div style={{ marginTop: 16 }}>
            <div style={{ background: isDark ? '#071224' : '#f0f9ff', border: `1px solid ${isDark ? '#1a3458' : '#bae6fd'}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ color: '#22c55e', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>✓ {t('users.invite.modal.success_copied')}</div>
              <div style={{ fontSize: 11, color: C.muted, wordBreak: 'break-all', fontFamily: 'monospace' }}>{lastInviteLink}</div>
            </div>
            <div style={{ color: C.muted, fontSize: 12 }}>{t('users.invite.modal.success_share_hint')}</div>
          </div>
        ) : (
          <Form form={inviteForm} layout="vertical" style={{ marginTop: 16 }} initialValues={{ role: 'viewer', expires_hours: 72 }}>
            <Form.Item label={t('users.invite.form.email_label')} name="email" rules={[{ required: true, type: 'email', message: t('common.validation.email_invalid') }]}>
              <Input placeholder={t('users.invite.form.email_placeholder')} />
            </Form.Item>
            <Form.Item label={t('users.invite.form.role_label')} name="role" rules={[{ required: true }]}>
              <Select options={ROLE_OPTIONS_FILTERED.filter((r) => r.value !== 'super_admin')} />
            </Form.Item>
            <Form.Item label={t('users.invite.form.expires_label')} name="expires_hours" rules={[{ required: true }]}>
              <Select options={EXPIRES_OPTIONS} />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  )
}
