import { useState, useCallback } from 'react'
import {
  Button, Select, Tag, Spin, message, Popconfirm,
  Typography, Divider, Tabs, Input, Switch,
} from 'antd'
import {
  TeamOutlined, ApartmentOutlined, UserOutlined,
  EditOutlined, DeleteOutlined, PlusOutlined,
  SettingOutlined, CheckCircleFilled,
  DownOutlined, RightOutlined,
  SaveOutlined, CloseOutlined, MailOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { tenantsApi, type Tenant } from '@/api/tenants'
import { orgAdminApi, type OrgUser } from '@/api/orgAdmin'
import { locationsApi } from '@/api/locations'
import { useAuthStore } from '@/store/auth'
import { useTheme } from '@/contexts/ThemeContext'
import client from '@/api/client'

const { Text, Title } = Typography

// ─── Theme hook ──────────────────────────────────────────────────────────────

function useT() {
  const { isDark } = useTheme()
  return {
    isDark,
    pageBg:      isDark ? '#030c1e' : '#f1f5f9',
    cardBg:      isDark ? '#0e1e38' : '#ffffff',
    cardBg2:     isDark ? '#071a2e' : '#f8fafc',
    border:      isDark ? '#1a3458' : '#e2e8f0',
    borderLight: isDark ? '#112240' : '#f1f5f9',
    textPrimary: isDark ? '#f1f5f9' : '#1e293b',
    textSec:     isDark ? '#94a3b8' : '#64748b',
    textMuted:   isDark ? '#64748b' : '#94a3b8',
    rowHover:    isDark ? '#ffffff08' : '#f8fafc',
    rowSelected: isDark ? '#1d4ed815' : '#eff6ff',
    avatarBg:    isDark ? '#1a3458' : '#e2e8f0',
    inputBg:     isDark ? '#071a2e' : '#f8fafc',
    tableHead:   isDark ? '#071a2e' : '#f1f5f9',
    tableStripe: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminUser extends OrgUser {
  tenant_id?: number | null
  role?: string
}

const SYSTEM_ROLE_COLOR: Record<string, string> = {
  super_admin: '#ef4444',
  org_admin:   '#3b82f6',
  member:      '#64748b',
}
const SYSTEM_ROLE_LABEL: Record<string, string> = {
  super_admin: 'Süper Admin',
  org_admin:   'Org Admin',
  member:      'Üye',
}

const PLAN_COLORS: Record<string, string> = {
  free: '#64748b', starter: '#3b82f6', pro: '#8b5cf6', enterprise: '#f59e0b',
}

// ─── Superadmin API helpers ───────────────────────────────────────────────────

const saApi = {
  listTenantUsers: (tenantId: number) =>
    client.get<AdminUser[]>(`/superadmin/tenants/${tenantId}/users`).then(r => r.data),

  updateUser: (userId: number, data: Partial<AdminUser>) =>
    client.patch<AdminUser>(`/superadmin/users/${userId}`, data).then(r => r.data),

  updatePlan: (tenantId: number, tier: string, maxDevices: number, maxUsers: number) =>
    client.patch(`/superadmin/tenants/${tenantId}/plan`, null, {
      params: { plan_tier: tier, max_devices: maxDevices, max_users: maxUsers },
    }).then(r => r.data),
}

// ─── User Edit Panel ──────────────────────────────────────────────────────────

function UserEditPanel({
  user,
  tenantId,
  isSA,
  onClose,
  onSaved,
}: {
  user: AdminUser
  tenantId?: number
  isSA: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const qc = useQueryClient()

  const [sysRole, setSysRole]   = useState(user.system_role)
  const [active, setActive]     = useState(user.is_active)
  const [assignPs, setAssignPs] = useState<number | null>(null)
  const [assignLoc, setAssignLoc] = useState<number | null>(null)
  const [showAssign, setShowAssign] = useState(false)

  const { data: userPermsData, refetch: refetchPerms } = useQuery({
    queryKey: ['admin-user-perms', user.id],
    queryFn: () => orgAdminApi.getUserPermissions(user.id),
  })

  const { data: permSetsData } = useQuery({
    queryKey: ['admin-perm-sets', tenantId],
    queryFn: orgAdminApi.listPermSets,
  })

  const { data: locsData } = useQuery({
    queryKey: ['admin-locs'],
    queryFn: () => locationsApi.list(),
  })

  const assignments  = userPermsData?.assignments ?? []
  const permSets     = permSetsData?.permission_sets ?? []
  const locations    = locsData?.items ?? []

  const updateMut = useMutation({
    mutationFn: (data: Partial<AdminUser>) =>
      isSA ? saApi.updateUser(user.id, data) : orgAdminApi.updateUser(user.id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      message.success('Kaydedildi')
      onSaved()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const removeMut = useMutation({
    mutationFn: () => orgAdminApi.removeUser(user.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      message.success('Kullanıcı kaldırıldı')
      onClose()
    },
  })

  const assignMut = useMutation({
    mutationFn: () => orgAdminApi.assignPermission(user.id, {
      user_id: user.id,
      location_id: assignLoc,
      permission_set_id: assignPs!,
    }),
    onSuccess: () => {
      refetchPerms()
      setShowAssign(false)
      message.success('Yetki atandı')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const removeAssignMut = useMutation({
    mutationFn: (ulpId: number) => orgAdminApi.removePermission(user.id, ulpId),
    onSuccess: () => refetchPerms(),
  })

  const isAdmin = user.system_role === 'super_admin' || user.system_role === 'org_admin'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 44, height: 44, borderRadius: '50%', background: '#1d4ed820',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, fontWeight: 700, color: '#3b82f6', flexShrink: 0,
        }}>
          {user.username[0].toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: t.textPrimary, fontWeight: 700, fontSize: 15 }}>{user.username}</div>
          <div style={{ color: t.textMuted, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <MailOutlined style={{ fontSize: 11 }} /> {user.email}
          </div>
        </div>
        <Button size="small" icon={<CloseOutlined />} type="text" onClick={onClose} />
      </div>

      <Divider style={{ borderColor: t.border, margin: '0' }} />

      {/* System role */}
      <div>
        <Text style={{ color: t.textSec, fontSize: 12, display: 'block', marginBottom: 6 }}>Sistem Rolü</Text>
        <Select
          value={sysRole}
          onChange={setSysRole}
          style={{ width: '100%' }}
          disabled={user.system_role === 'super_admin' && !isSA}
          options={[
            { label: 'Üye', value: 'member' },
            { label: 'Org Admin', value: 'org_admin' },
            ...(isSA ? [{ label: 'Süper Admin', value: 'super_admin' }] : []),
          ]}
        />
      </div>

      {/* Active toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: t.textSec, fontSize: 12 }}>Hesap Aktif</Text>
        <Switch checked={active} onChange={setActive} size="small" />
      </div>

      {/* Permission assignments */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <Text style={{ color: t.textSec, fontSize: 12 }}>Yetki Atamaları</Text>
          {!isAdmin && (
            <Button
              size="small" type="link" icon={<PlusOutlined />}
              style={{ fontSize: 11, padding: 0 }}
              onClick={() => setShowAssign(!showAssign)}
            >
              Ekle
            </Button>
          )}
        </div>

        {isAdmin ? (
          <div style={{ background: t.cardBg2, borderRadius: 6, padding: '8px 12px', border: `1px solid ${t.border}` }}>
            <CheckCircleFilled style={{ color: '#f59e0b', marginRight: 6 }} />
            <Text style={{ color: '#f59e0b', fontSize: 12 }}>
              {user.system_role === 'super_admin' ? 'Süper Admin — tüm yetkiler' : 'Org Admin — tüm yetkiler'}
            </Text>
          </div>
        ) : assignments.length === 0 ? (
          <div style={{ color: '#ef4444', fontSize: 12, padding: '4px 0' }}>
            Yetki atanmamış — erişim yok
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {assignments.map(a => {
              const ps  = permSets.find(p => p.id === a.permission_set_id)
              const loc = locations.find(l => l.id === a.location_id)
              return (
                <Tag
                  key={a.id}
                  color="blue"
                  closable
                  onClose={() => removeAssignMut.mutate(a.id)}
                  style={{ fontSize: 11 }}
                >
                  {ps?.name ?? `Set #${a.permission_set_id}`}
                  {a.location_id ? ` — ${loc?.name ?? a.location_id}` : ' — Tüm Org'}
                </Tag>
              )
            })}
          </div>
        )}

        {showAssign && (
          <div style={{ marginTop: 10, background: t.cardBg2, borderRadius: 8, padding: 12, border: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Select
              placeholder="Yetki seti seç"
              value={assignPs}
              onChange={setAssignPs}
              style={{ width: '100%' }}
              options={permSets.map(p => ({ label: `${p.name}${p.org_id === null ? ' (Global)' : ''}`, value: p.id }))}
            />
            <Select
              allowClear
              placeholder="Lokasyon (boş = tüm org)"
              value={assignLoc}
              onChange={v => setAssignLoc(v ?? null)}
              style={{ width: '100%' }}
              options={locations.map(l => ({ label: l.name, value: l.id }))}
            />
            <Button
              type="primary" size="small"
              loading={assignMut.isPending}
              disabled={!assignPs}
              onClick={() => assignMut.mutate()}
            >
              Ata
            </Button>
          </div>
        )}
      </div>

      <Divider style={{ borderColor: t.border, margin: '0' }} />

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          type="primary" icon={<SaveOutlined />}
          loading={updateMut.isPending}
          style={{ flex: 1 }}
          onClick={() => updateMut.mutate({ system_role: sysRole, is_active: active })}
        >
          Kaydet
        </Button>
        <Popconfirm
          title="Kullanıcıyı organizasyondan kaldır?"
          onConfirm={() => removeMut.mutate()}
        >
          <Button danger icon={<DeleteOutlined />} loading={removeMut.isPending} />
        </Popconfirm>
      </div>
    </div>
  )
}

// ─── Plan Panel (super_admin only) ───────────────────────────────────────────

function PlanPanel({ tenant }: { tenant: Tenant }) {
  const t = useT()
  const qc = useQueryClient()

  const [tier, setTier]         = useState(tenant.plan_tier)
  const [maxDev, setMaxDev]     = useState(tenant.max_devices)
  const [maxUsr, setMaxUsr]     = useState(tenant.max_users)

  const saveMut = useMutation({
    mutationFn: () => saApi.updatePlan(tenant.id, tier, maxDev, maxUsr),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-tenants'] })
      message.success('Plan güncellendi')
    },
  })

  const field = (label: string, node: React.ReactNode) => (
    <div>
      <Text style={{ color: t.textSec, fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</Text>
      {node}
    </div>
  )

  const numInput = (val: number, onChange: (n: number) => void) => (
    <input
      type="number" value={val}
      onChange={e => onChange(Number(e.target.value))}
      style={{ background: t.inputBg, border: `1px solid ${t.border}`, borderRadius: 6, color: t.textPrimary, fontSize: 13, padding: '6px 10px', width: '100%' }}
    />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Current usage */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        {[
          { label: 'Kullanıcı', val: tenant.user_count, max: tenant.max_users },
          { label: 'Cihaz', val: tenant.device_count, max: tenant.max_devices },
          { label: 'Lokasyon', val: tenant.location_count, max: 999 },
        ].map(({ label, val, max }) => (
          <div key={label} style={{ background: t.cardBg2, border: `1px solid ${t.border}`, borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ color: t.textMuted, fontSize: 11 }}>{label}</div>
            <div style={{ color: t.textPrimary, fontWeight: 700, fontSize: 18 }}>{val}<span style={{ color: t.textMuted, fontSize: 12, fontWeight: 400 }}>/{max === 999 ? '∞' : max}</span></div>
          </div>
        ))}
      </div>

      {field('Plan Tieri',
        <Select value={tier} onChange={setTier} style={{ width: '100%' }}
          options={['free','starter','pro','enterprise'].map(v => ({ label: v.charAt(0).toUpperCase() + v.slice(1), value: v }))}
        />
      )}
      {field('Maks. Cihaz', numInput(maxDev, setMaxDev))}
      {field('Maks. Kullanıcı', numInput(maxUsr, setMaxUsr))}

      <Button type="primary" icon={<SaveOutlined />} loading={saveMut.isPending} onClick={() => saveMut.mutate()}>
        Planı Kaydet
      </Button>
    </div>
  )
}

// ─── Org Detail (right panel when org selected) ───────────────────────────────

function OrgDetail({
  tenant,
  isSA,
  onSelectUser,
}: {
  tenant: Tenant
  isSA: boolean
  onSelectUser: (u: AdminUser) => void
}) {
  const t = useT()
  const [search, setSearch] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole]   = useState('member')
  const [showInvite, setShowInvite]   = useState(false)
  const qc = useQueryClient()

  const usersQ = useQuery({
    queryKey: ['admin-users', tenant.id, isSA],
    queryFn: () => isSA
      ? saApi.listTenantUsers(tenant.id)
      : orgAdminApi.listUsers(1, 200).then(d => d.users as AdminUser[]),
  })

  const inviteMut = useMutation({
    mutationFn: () => orgAdminApi.invite({ email: inviteEmail, system_role: inviteRole }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users', tenant.id] })
      setShowInvite(false)
      setInviteEmail('')
      message.success('Davet gönderildi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const users = (usersQ.data ?? []).filter(u =>
    !search || u.username.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase())
  )

  const tabs = [
    {
      key: 'users',
      label: <span><TeamOutlined /> Kullanıcılar</span>,
      children: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <Input
              placeholder="Kullanıcı ara..."
              prefix={<UserOutlined style={{ color: t.textMuted }} />}
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1 }}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowInvite(!showInvite)}>
              Davet
            </Button>
          </div>

          {showInvite && (
            <div style={{ background: t.cardBg2, border: `1px solid ${t.border}`, borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                placeholder="E-posta adresi"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                style={{ background: t.inputBg, border: `1px solid ${t.border}`, borderRadius: 6, color: t.textPrimary, fontSize: 13, padding: '6px 10px', width: '100%' }}
              />
              <Select
                value={inviteRole}
                onChange={setInviteRole}
                style={{ width: '100%' }}
                options={[{ label: 'Üye', value: 'member' }, { label: 'Org Admin', value: 'org_admin' }]}
              />
              <Button type="primary" size="small" loading={inviteMut.isPending} onClick={() => inviteMut.mutate()} disabled={!inviteEmail.trim()}>
                Davet Gönder
              </Button>
            </div>
          )}

          {usersQ.isLoading ? (
            <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
          ) : users.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: t.textMuted }}>Kullanıcı yok</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {users.map((u, idx) => (
                <div
                  key={u.id}
                  onClick={() => onSelectUser(u)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                    background: idx % 2 === 0 ? 'transparent' : t.tableStripe,
                    border: `1px solid ${t.borderLight}`,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = t.rowHover}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = idx % 2 === 0 ? 'transparent' : t.tableStripe}
                >
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%', background: t.avatarBg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 700, color: SYSTEM_ROLE_COLOR[u.system_role] ?? t.textMuted,
                    flexShrink: 0,
                  }}>
                    {u.username[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: t.textPrimary, fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.username}</div>
                    <div style={{ color: t.textMuted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                  </div>
                  <div style={{
                    fontSize: 10, fontWeight: 600, flexShrink: 0,
                    color: SYSTEM_ROLE_COLOR[u.system_role] ?? t.textMuted,
                    background: `${SYSTEM_ROLE_COLOR[u.system_role] ?? t.textMuted}18`,
                    padding: '2px 7px', borderRadius: 4,
                  }}>
                    {SYSTEM_ROLE_LABEL[u.system_role] ?? u.system_role}
                  </div>
                  <div style={{
                    width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                    background: u.is_active ? '#22c55e' : '#ef4444',
                  }} />
                  <EditOutlined style={{ color: t.textMuted, fontSize: 13 }} />
                </div>
              ))}
            </div>
          )}
        </div>
      ),
    },
    ...(isSA ? [{
      key: 'plan',
      label: <span><SettingOutlined /> Paket</span>,
      children: <PlanPanel tenant={tenant} />,
    }] : []),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Org header card */}
      <div style={{
        background: t.cardBg2, border: `1px solid ${t.border}`, borderRadius: 10,
        padding: '16px 20px', marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 10, background: '#1d4ed820',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <ApartmentOutlined style={{ color: '#3b82f6', fontSize: 22 }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: t.textPrimary, fontWeight: 700, fontSize: 17 }}>{tenant.name}</div>
          <div style={{ color: t.textMuted, fontSize: 12 }}>{tenant.slug}</div>
        </div>
        <Tag color={PLAN_COLORS[tenant.plan_tier] ?? 'default'} style={{ fontSize: 11, fontWeight: 600 }}>
          {tenant.plan_tier.toUpperCase()}
        </Tag>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: tenant.is_active ? '#22c55e' : '#ef4444' }} />
      </div>

      <Tabs items={tabs} size="small" />
    </div>
  )
}

// ─── Org Tree (left panel) ────────────────────────────────────────────────────

function OrgTree({
  tenants,
  isSA,
  selectedOrgId,
  selectedUserId,
  onSelectOrg,
  onSelectUser,
}: {
  tenants: Tenant[]
  isSA: boolean
  selectedOrgId: number | null
  selectedUserId: number | null
  onSelectOrg: (t: Tenant) => void
  onSelectUser: (u: AdminUser, tenantId: number) => void
}) {
  const t = useT()
  const [expanded, setExpanded] = useState<Set<number>>(new Set(tenants.map(t => t.id)))

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {tenants.map(tenant => {
        const isOrgSelected = selectedOrgId === tenant.id
        const isExp = expanded.has(tenant.id)
        return (
          <div key={tenant.id}>
            {/* Org row */}
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
                borderRadius: 7, cursor: 'pointer',
                background: isOrgSelected ? t.rowSelected : 'transparent',
                borderLeft: `3px solid ${isOrgSelected ? '#3b82f6' : 'transparent'}`,
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => { if (!isOrgSelected) (e.currentTarget as HTMLElement).style.background = t.rowHover }}
              onMouseLeave={e => { if (!isOrgSelected) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span
                onClick={() => toggle(tenant.id)}
                style={{ color: t.textMuted, fontSize: 11, width: 12, flexShrink: 0 }}
              >
                {isExp ? <DownOutlined /> : <RightOutlined />}
              </span>
              <ApartmentOutlined style={{ color: isOrgSelected ? '#3b82f6' : t.textMuted, fontSize: 14, flexShrink: 0 }} />
              <span
                style={{ flex: 1, color: isOrgSelected ? t.textPrimary : t.textSec, fontWeight: isOrgSelected ? 600 : 400, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                onClick={() => onSelectOrg(tenant)}
              >
                {tenant.name}
              </span>
              <Tag color={PLAN_COLORS[tenant.plan_tier] ?? 'default'} style={{ fontSize: 9, margin: 0, padding: '0 5px', lineHeight: '16px' }}>
                {tenant.plan_tier}
              </Tag>
            </div>

            {/* User rows (expanded) */}
            {isExp && (
              <OrgUserList
                tenantId={tenant.id}
                isSA={isSA}
                selectedUserId={selectedUserId}
                onSelectUser={u => onSelectUser(u, tenant.id)}
                t={t}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function OrgUserList({
  tenantId, isSA, selectedUserId, onSelectUser, t,
}: {
  tenantId: number
  isSA: boolean
  selectedUserId: number | null
  onSelectUser: (u: AdminUser) => void
  t: ReturnType<typeof useT>
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', tenantId, isSA],
    queryFn: () => isSA
      ? saApi.listTenantUsers(tenantId)
      : orgAdminApi.listUsers(1, 200).then(d => d.users as AdminUser[]),
  })

  if (isLoading) return <div style={{ padding: '4px 0 4px 32px' }}><Spin size="small" /></div>

  return (
    <div style={{ paddingLeft: 32, paddingBottom: 4, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {(data ?? []).map(u => {
        const isSel = selectedUserId === u.id
        return (
          <div
            key={u.id}
            onClick={() => onSelectUser(u)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
              borderRadius: 6, cursor: 'pointer',
              background: isSel ? t.rowSelected : 'transparent',
              borderLeft: `2px solid ${isSel ? '#3b82f6' : 'transparent'}`,
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = t.rowHover }}
            onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <div style={{
              width: 22, height: 22, borderRadius: '50%',
              background: isSel ? '#1d4ed830' : t.avatarBg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700, color: isSel ? '#3b82f6' : t.textMuted, flexShrink: 0,
            }}>
              {u.username[0].toUpperCase()}
            </div>
            <span style={{ flex: 1, color: isSel ? t.textPrimary : t.textSec, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {u.username}
            </span>
            <div style={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: u.is_active ? '#22c55e' : '#ef4444',
            }} />
          </div>
        )
      })}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const t = useT()
  const { isSuperAdmin, isOrgAdmin } = useAuthStore()
  const isSA = isSuperAdmin()
  const isOA = isOrgAdmin()

  const [selectedOrg,  setSelectedOrg]  = useState<Tenant | null>(null)
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null)
  const [selectedUserTenant, setSelectedUserTenant] = useState<number | undefined>()

  const tenantsQ = useQuery({
    queryKey: ['admin-tenants'],
    queryFn: tenantsApi.list,
  })

  const ownOrgQ = useQuery({
    queryKey: ['admin-own-org'],
    queryFn: orgAdminApi.getOrg,
    enabled: !isSA && isOA,
  })

  const tenants: Tenant[] = isSA
    ? (tenantsQ.data ?? [])
    : ownOrgQ.data
      ? [{
          id: ownOrgQ.data.id,
          name: ownOrgQ.data.name,
          slug: ownOrgQ.data.slug,
          is_active: ownOrgQ.data.is_active,
          plan_tier: ownOrgQ.data.plan?.name ?? 'pro',
          max_devices: ownOrgQ.data.plan?.max_devices ?? 0,
          max_users: ownOrgQ.data.plan?.max_users ?? 0,
          contact_email: ownOrgQ.data.contact_email,
          created_at: '',
          device_count: 0,
          user_count: ownOrgQ.data.usage.users,
          location_count: 0,
          description: ownOrgQ.data.description,
        } as Tenant]
      : []

  const handleSelectOrg = useCallback((tenant: Tenant) => {
    setSelectedOrg(tenant)
    setSelectedUser(null)
  }, [])

  const handleSelectUser = useCallback((user: AdminUser, tenantId?: number) => {
    setSelectedUser(user)
    setSelectedUserTenant(tenantId)
    setSelectedOrg(null)
  }, [])

  const isLoading = isSA ? tenantsQ.isLoading : ownOrgQ.isLoading

  return (
    <div style={{ padding: 24, background: t.pageBg, minHeight: '100vh' }}>
      <Title level={4} style={{ color: t.textPrimary, marginBottom: 4 }}>Admin Paneli</Title>
      <Text style={{ color: t.textMuted, marginBottom: 20, display: 'block' }}>
        Organizasyonlar, kullanıcılar ve yetki yönetimi
      </Text>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16, alignItems: 'start' }}>

          {/* ── Left: Org Tree ── */}
          <div style={{
            background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 10,
            overflow: 'hidden', position: 'sticky', top: 24,
            maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column',
            boxShadow: t.isDark ? 'none' : '0 1px 4px rgba(0,0,0,0.06)',
          }}>
            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <ApartmentOutlined style={{ color: '#3b82f6' }} />
              <Text style={{ color: t.textPrimary, fontWeight: 600, fontSize: 13 }}>Organizasyonlar</Text>
              <span style={{
                marginLeft: 'auto', background: '#1d4ed8', color: '#fff',
                borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 600,
              }}>{tenants.length}</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
              <OrgTree
                tenants={tenants}
                isSA={isSA}
                selectedOrgId={selectedOrg?.id ?? null}
                selectedUserId={selectedUser?.id ?? null}
                onSelectOrg={handleSelectOrg}
                onSelectUser={handleSelectUser}
              />
            </div>
          </div>

          {/* ── Right: Detail ── */}
          <div style={{
            background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 10,
            padding: 20, minHeight: 400,
            boxShadow: t.isDark ? 'none' : '0 1px 4px rgba(0,0,0,0.06)',
          }}>
            {selectedUser ? (
              <UserEditPanel
                user={selectedUser}
                tenantId={selectedUserTenant}
                isSA={isSA}
                onClose={() => setSelectedUser(null)}
                onSaved={() => {}}
              />
            ) : selectedOrg ? (
              <OrgDetail
                tenant={selectedOrg}
                isSA={isSA}
                onSelectUser={u => handleSelectUser(u, selectedOrg.id)}
              />
            ) : (
              <div style={{ padding: '60px 40px', textAlign: 'center' }}>
                <div style={{
                  width: 56, height: 56, borderRadius: '50%',
                  background: t.avatarBg, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 16px',
                }}>
                  <ApartmentOutlined style={{ fontSize: 24, color: '#3b82f6' }} />
                </div>
                <Text style={{ color: t.textSec, fontSize: 14, display: 'block' }}>Soldaki ağaçtan bir organizasyon veya kullanıcı seçin</Text>
                <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 4, display: 'block' }}>Organizasyon: kullanıcılar ve plan detayları</Text>
                <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 2, display: 'block' }}>Kullanıcı: yetki, rol ve hesap ayarları</Text>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
