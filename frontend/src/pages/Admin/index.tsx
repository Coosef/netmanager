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
import { orgAdminApi, type OrgUser } from '@/api/orgAdmin'
import { locationsApi } from '@/api/locations'
import { useAuthStore } from '@/store/auth'
import { useTheme } from '@/contexts/ThemeContext'
import client from '@/api/client'

const { Text, Title } = Typography

// ─── Theme hook ───────────────────────────────────────────────────────────────

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
    tableStripe: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface AdminOrg {
  id: number
  name: string
  slug: string
  description?: string
  is_active: boolean
  contact_email?: string | null
  trial_ends_at?: string | null
  subscription_ends_at?: string | null
  plan?: { id: number; name: string; slug: string; max_devices: number; max_users: number; max_locations: number } | null
  user_count: number
}

interface AdminPlan {
  id: number
  name: string
  slug: string
  max_devices: number
  max_users: number
  max_locations: number
  max_agents: number
  price_monthly?: number | null
  features?: Record<string, boolean> | null
}

interface AdminUser extends OrgUser {
  tenant_id?: number | null
  role?: string
}

const ROLE_COLOR: Record<string, string> = {
  super_admin: '#ef4444', org_admin: '#3b82f6', member: '#64748b',
}
const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Süper Admin', org_admin: 'Org Admin', member: 'Üye',
}

// ─── API ──────────────────────────────────────────────────────────────────────

const saApi = {
  listOrgs: () =>
    client.get<AdminOrg[]>('/superadmin/organizations').then(r => r.data),

  listPlans: () =>
    client.get<AdminPlan[]>('/superadmin/plans').then(r => r.data),

  listOrgUsers: (orgId: number) =>
    client.get<AdminUser[]>(`/superadmin/organizations/${orgId}/users`).then(r => r.data),

  updateOrgPlan: (orgId: number, data: { plan_id?: number; is_active?: boolean; trial_ends_at?: string; subscription_ends_at?: string }) =>
    client.patch(`/superadmin/organizations/${orgId}/plan`, data).then(r => r.data),

  updateUser: (userId: number, data: Partial<AdminUser>) =>
    client.patch<AdminUser>(`/superadmin/users/${userId}`, data).then(r => r.data),
}

// ─── User Edit Panel ──────────────────────────────────────────────────────────

function UserEditPanel({
  user, orgId, isSA, onClose, onSaved,
}: {
  user: AdminUser; orgId?: number; isSA: boolean
  onClose: () => void; onSaved: () => void
}) {
  const t = useT()
  const qc = useQueryClient()
  const [sysRole, setSysRole] = useState(user.system_role)
  const [active, setActive]   = useState(user.is_active)
  const [assignPs, setAssignPs]   = useState<number | null>(null)
  const [assignLoc, setAssignLoc] = useState<number | null>(null)
  const [showAssign, setShowAssign] = useState(false)

  const permsQ = useQuery({
    queryKey: ['admin-user-perms', user.id],
    queryFn: () => orgAdminApi.getUserPermissions(user.id),
  })
  const permSetsQ = useQuery({
    queryKey: ['admin-perm-sets'],
    queryFn: orgAdminApi.listPermSets,
  })
  const locsQ = useQuery({
    queryKey: ['admin-locs'],
    queryFn: () => locationsApi.list(),
  })

  const assignments = permsQ.data?.assignments ?? []
  const permSets    = permSetsQ.data?.permission_sets ?? []
  const locations   = locsQ.data?.items ?? []

  const saveMut = useMutation({
    mutationFn: (data: Partial<AdminUser>) =>
      isSA ? saApi.updateUser(user.id, data) : orgAdminApi.updateUser(user.id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users', orgId] })
      message.success('Kaydedildi')
      onSaved()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const removeMut = useMutation({
    mutationFn: () => orgAdminApi.removeUser(user.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users', orgId] })
      message.success('Kullanıcı kaldırıldı')
      onClose()
    },
  })

  const assignMut = useMutation({
    mutationFn: () => orgAdminApi.assignPermission(user.id, {
      user_id: user.id, location_id: assignLoc, permission_set_id: assignPs!,
    }),
    onSuccess: () => { permsQ.refetch(); setShowAssign(false); message.success('Yetki atandı') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const removeAssignMut = useMutation({
    mutationFn: (ulpId: number) => orgAdminApi.removePermission(user.id, ulpId),
    onSuccess: () => permsQ.refetch(),
  })

  const isAdmin = user.system_role === 'super_admin' || user.system_role === 'org_admin'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
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
          <div style={{ color: t.textMuted, fontSize: 12 }}><MailOutlined style={{ fontSize: 11, marginRight: 4 }} />{user.email}</div>
        </div>
        <Button size="small" icon={<CloseOutlined />} type="text" onClick={onClose} />
      </div>

      <Divider style={{ borderColor: t.border, margin: 0 }} />

      {/* System role */}
      <div>
        <Text style={{ color: t.textSec, fontSize: 12, display: 'block', marginBottom: 6 }}>Sistem Rolü</Text>
        <Select
          value={sysRole} onChange={setSysRole} style={{ width: '100%' }}
          disabled={user.system_role === 'super_admin' && !isSA}
          options={[
            { label: 'Üye', value: 'member' },
            { label: 'Org Admin', value: 'org_admin' },
            ...(isSA ? [{ label: 'Süper Admin', value: 'super_admin' }] : []),
          ]}
        />
      </div>

      {/* Active */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: t.textSec, fontSize: 12 }}>Hesap Aktif</Text>
        <Switch checked={active} onChange={setActive} size="small" />
      </div>

      {/* Permissions */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <Text style={{ color: t.textSec, fontSize: 12 }}>Yetki Atamaları</Text>
          {!isAdmin && (
            <Button size="small" type="link" icon={<PlusOutlined />} style={{ fontSize: 11, padding: 0 }}
              onClick={() => setShowAssign(!showAssign)}>Ekle</Button>
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
          <div style={{ color: '#ef4444', fontSize: 12, padding: '4px 0' }}>Yetki atanmamış — erişim yok</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {assignments.map(a => {
              const ps  = permSets.find(p => p.id === a.permission_set_id)
              const loc = locations.find(l => l.id === a.location_id)
              return (
                <Tag key={a.id} color="blue" closable onClose={() => removeAssignMut.mutate(a.id)} style={{ fontSize: 11 }}>
                  {ps?.name ?? `Set #${a.permission_set_id}`}
                  {a.location_id ? ` — ${loc?.name ?? a.location_id}` : ' — Tüm Org'}
                </Tag>
              )
            })}
          </div>
        )}

        {showAssign && (
          <div style={{ marginTop: 10, background: t.cardBg2, borderRadius: 8, padding: 12, border: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Select placeholder="Yetki seti seç" value={assignPs} onChange={setAssignPs} style={{ width: '100%' }}
              options={permSets.map(p => ({ label: `${p.name}${p.org_id === null ? ' (Global)' : ''}`, value: p.id }))} />
            <Select allowClear placeholder="Lokasyon (boş = tüm org)" value={assignLoc} onChange={v => setAssignLoc(v ?? null)} style={{ width: '100%' }}
              options={locations.map(l => ({ label: l.name, value: l.id }))} />
            <Button type="primary" size="small" loading={assignMut.isPending} disabled={!assignPs} onClick={() => assignMut.mutate()}>Ata</Button>
          </div>
        )}
      </div>

      <Divider style={{ borderColor: t.border, margin: 0 }} />

      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="primary" icon={<SaveOutlined />} loading={saveMut.isPending} style={{ flex: 1 }}
          onClick={() => saveMut.mutate({ system_role: sysRole, is_active: active })}>
          Kaydet
        </Button>
        <Popconfirm title="Kullanıcıyı organizasyondan kaldır?" onConfirm={() => removeMut.mutate()}>
          <Button danger icon={<DeleteOutlined />} loading={removeMut.isPending} />
        </Popconfirm>
      </div>
    </div>
  )
}

// ─── Plan Panel ───────────────────────────────────────────────────────────────

function PlanPanel({ org }: { org: AdminOrg }) {
  const t = useT()
  const qc = useQueryClient()
  const [planId, setPlanId]         = useState(org.plan?.id ?? null)
  const [isActive, setIsActive]     = useState(org.is_active)
  const [trialEnd, setTrialEnd]     = useState(org.trial_ends_at?.split('T')[0] ?? '')
  const [subEnd, setSubEnd]         = useState(org.subscription_ends_at?.split('T')[0] ?? '')

  const plansQ = useQuery({ queryKey: ['admin-plans'], queryFn: saApi.listPlans })
  const plans  = plansQ.data ?? []
  const chosen = plans.find(p => p.id === planId)

  const saveMut = useMutation({
    mutationFn: () => saApi.updateOrgPlan(org.id, {
      plan_id: planId ?? undefined,
      is_active: isActive,
      trial_ends_at: trialEnd || undefined,
      subscription_ends_at: subEnd || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-orgs'] })
      message.success('Plan güncellendi')
    },
  })

  const dateInput = (label: string, val: string, onChange: (v: string) => void) => (
    <div>
      <Text style={{ color: t.textSec, fontSize: 12, display: 'block', marginBottom: 4 }}>{label}</Text>
      <input type="date" value={val} onChange={e => onChange(e.target.value)}
        style={{ background: t.inputBg, border: `1px solid ${t.border}`, borderRadius: 6, color: t.textPrimary, fontSize: 13, padding: '6px 10px', width: '100%' }} />
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Usage */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {[
          { label: 'Kullanıcı', val: org.user_count, max: org.plan?.max_users },
          { label: 'Maks. Cihaz', val: null, max: org.plan?.max_devices },
        ].map(({ label, val, max }) => (
          <div key={label} style={{ background: t.cardBg2, border: `1px solid ${t.border}`, borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ color: t.textMuted, fontSize: 11 }}>{label}</div>
            <div style={{ color: t.textPrimary, fontWeight: 700, fontSize: 18 }}>
              {val ?? '—'}<span style={{ color: t.textMuted, fontSize: 12, fontWeight: 400 }}>/{max ?? '∞'}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Plan select */}
      <div>
        <Text style={{ color: t.textSec, fontSize: 12, display: 'block', marginBottom: 6 }}>Plan</Text>
        <Select
          value={planId} onChange={setPlanId} style={{ width: '100%' }} allowClear
          placeholder="Plan seç"
          options={plans.map(p => ({
            label: `${p.name} (${p.max_users} kullanıcı, ${p.max_devices} cihaz${p.price_monthly ? ` — ${(p.price_monthly / 100).toFixed(0)}$/ay` : ''})`,
            value: p.id,
          }))}
        />
        {chosen && (
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Object.entries(chosen.features ?? {}).filter(([,v]) => v).map(([k]) => (
              <Tag key={k} color="blue" style={{ fontSize: 10 }}>{k}</Tag>
            ))}
          </div>
        )}
      </div>

      {/* Active */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: t.textSec, fontSize: 12 }}>Organizasyon Aktif</Text>
        <Switch checked={isActive} onChange={setIsActive} size="small" />
      </div>

      {dateInput('Deneme Süresi Bitiş', trialEnd, setTrialEnd)}
      {dateInput('Abonelik Bitiş', subEnd, setSubEnd)}

      <Button type="primary" icon={<SaveOutlined />} loading={saveMut.isPending} onClick={() => saveMut.mutate()}>
        Kaydet
      </Button>
    </div>
  )
}

// ─── Org Detail ───────────────────────────────────────────────────────────────

function OrgDetail({
  org, isSA, onSelectUser,
}: {
  org: AdminOrg; isSA: boolean; onSelectUser: (u: AdminUser) => void
}) {
  const t = useT()
  const qc = useQueryClient()
  const [search, setSearch]       = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole]   = useState('member')
  const [showInvite, setShowInvite]   = useState(false)

  const usersQ = useQuery({
    queryKey: ['admin-users', org.id],
    queryFn: () => isSA ? saApi.listOrgUsers(org.id) : orgAdminApi.listUsers(1, 200).then(d => d.users as AdminUser[]),
  })

  const inviteMut = useMutation({
    mutationFn: () => orgAdminApi.invite({ email: inviteEmail, system_role: inviteRole }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users', org.id] })
      setShowInvite(false); setInviteEmail('')
      message.success('Davet gönderildi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const users = (usersQ.data ?? []).filter(u =>
    !search || u.username.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase())
  )

  const userTab = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <Input placeholder="Kullanıcı ara..." prefix={<UserOutlined style={{ color: t.textMuted }} />}
          value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1 }} />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowInvite(!showInvite)}>Davet</Button>
      </div>

      {showInvite && (
        <div style={{ background: t.cardBg2, border: `1px solid ${t.border}`, borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input placeholder="E-posta" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
            style={{ background: t.inputBg, border: `1px solid ${t.border}`, borderRadius: 6, color: t.textPrimary, fontSize: 13, padding: '6px 10px', width: '100%' }} />
          <Select value={inviteRole} onChange={setInviteRole} style={{ width: '100%' }}
            options={[{ label: 'Üye', value: 'member' }, { label: 'Org Admin', value: 'org_admin' }]} />
          <Button type="primary" size="small" loading={inviteMut.isPending} disabled={!inviteEmail.trim()} onClick={() => inviteMut.mutate()}>Gönder</Button>
        </div>
      )}

      {usersQ.isLoading ? (
        <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
      ) : users.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: t.textMuted, fontSize: 13 }}>
          {search ? 'Sonuç yok' : 'Bu organizasyonda henüz kullanıcı yok'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {users.map((u, idx) => (
            <div key={u.id} onClick={() => onSelectUser(u)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                borderRadius: 8, cursor: 'pointer', border: `1px solid ${t.borderLight}`,
                background: idx % 2 === 0 ? 'transparent' : t.tableStripe, transition: 'background 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = t.rowHover}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = idx % 2 === 0 ? 'transparent' : t.tableStripe}
            >
              <div style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                background: t.avatarBg, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 700, color: ROLE_COLOR[u.system_role] ?? t.textMuted,
              }}>{u.username[0].toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: t.textPrimary, fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.username}</div>
                <div style={{ color: t.textMuted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
              </div>
              <div style={{
                fontSize: 10, fontWeight: 600, flexShrink: 0,
                color: ROLE_COLOR[u.system_role] ?? t.textMuted,
                background: `${ROLE_COLOR[u.system_role] ?? t.textMuted}18`,
                padding: '2px 7px', borderRadius: 4,
              }}>{ROLE_LABEL[u.system_role] ?? u.system_role}</div>
              <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: u.is_active ? '#22c55e' : '#ef4444' }} />
              <EditOutlined style={{ color: t.textMuted, fontSize: 13 }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )

  const tabs = [
    { key: 'users', label: <span><TeamOutlined /> Kullanıcılar</span>, children: userTab },
    ...(isSA ? [{ key: 'plan', label: <span><SettingOutlined /> Paket</span>, children: <PlanPanel org={org} /> }] : []),
  ]

  return (
    <div>
      {/* Org header */}
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
          <div style={{ color: t.textPrimary, fontWeight: 700, fontSize: 17 }}>{org.name}</div>
          <div style={{ color: t.textMuted, fontSize: 12 }}>{org.slug}</div>
        </div>
        {org.plan && (
          <Tag color="blue" style={{ fontSize: 11, fontWeight: 600 }}>{org.plan.name}</Tag>
        )}
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: org.is_active ? '#22c55e' : '#ef4444' }} />
      </div>

      <Tabs items={tabs} size="small" />
    </div>
  )
}

// ─── Org Tree ─────────────────────────────────────────────────────────────────

function OrgUserList({
  orgId, isSA, selectedUserId, onSelectUser, t,
}: {
  orgId: number; isSA: boolean; selectedUserId: number | null
  onSelectUser: (u: AdminUser) => void; t: ReturnType<typeof useT>
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', orgId],
    queryFn: () => isSA ? saApi.listOrgUsers(orgId) : orgAdminApi.listUsers(1, 200).then(d => d.users as AdminUser[]),
  })

  if (isLoading) return <div style={{ padding: '4px 0 4px 36px' }}><Spin size="small" /></div>

  return (
    <div style={{ paddingLeft: 36, paddingBottom: 4, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {(data ?? []).map(u => {
        const isSel = selectedUserId === u.id
        return (
          <div key={u.id} onClick={() => onSelectUser(u)}
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
              fontSize: 10, fontWeight: 700, color: isSel ? '#3b82f6' : ROLE_COLOR[u.system_role] ?? t.textMuted,
              flexShrink: 0,
            }}>{u.username[0].toUpperCase()}</div>
            <span style={{ flex: 1, color: isSel ? t.textPrimary : t.textSec, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {u.username}
            </span>
            <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: u.is_active ? '#22c55e' : '#ef4444' }} />
          </div>
        )
      })}
      {(data ?? []).length === 0 && (
        <div style={{ color: t.textMuted, fontSize: 11, padding: '4px 0', fontStyle: 'italic' }}>Kullanıcı yok</div>
      )}
    </div>
  )
}

function OrgTree({
  orgs, isSA, selectedOrgId, selectedUserId, onSelectOrg, onSelectUser,
}: {
  orgs: AdminOrg[]; isSA: boolean
  selectedOrgId: number | null; selectedUserId: number | null
  onSelectOrg: (o: AdminOrg) => void
  onSelectUser: (u: AdminUser, orgId: number) => void
}) {
  const t = useT()
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(orgs.map(o => o.id)))

  const toggle = (id: number) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {orgs.map(org => {
        const isSel = selectedOrgId === org.id
        const isExp = expanded.has(org.id)
        return (
          <div key={org.id}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px',
              borderRadius: 7, cursor: 'pointer',
              background: isSel ? t.rowSelected : 'transparent',
              borderLeft: `3px solid ${isSel ? '#3b82f6' : 'transparent'}`,
              transition: 'background 0.1s',
            }}
              onMouseEnter={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = t.rowHover }}
              onMouseLeave={e => { if (!isSel) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span onClick={() => toggle(org.id)} style={{ color: t.textMuted, fontSize: 10, width: 12, flexShrink: 0 }}>
                {isExp ? <DownOutlined /> : <RightOutlined />}
              </span>
              <ApartmentOutlined style={{ color: isSel ? '#3b82f6' : t.textMuted, fontSize: 14, flexShrink: 0 }} />
              <span onClick={() => onSelectOrg(org)} style={{
                flex: 1, color: isSel ? t.textPrimary : t.textSec, fontWeight: isSel ? 600 : 400,
                fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{org.name}</span>
              <span style={{ color: t.textMuted, fontSize: 10, flexShrink: 0 }}>{org.user_count}</span>
              <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: org.is_active ? '#22c55e' : '#ef4444' }} />
            </div>

            {isExp && (
              <OrgUserList
                orgId={org.id} isSA={isSA}
                selectedUserId={selectedUserId}
                onSelectUser={u => onSelectUser(u, org.id)}
                t={t}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const t = useT()
  const { isSuperAdmin } = useAuthStore()
  const isSA = isSuperAdmin()

  const [selectedOrg,  setSelectedOrg]  = useState<AdminOrg | null>(null)
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null)
  const [selectedUserOrgId, setSelectedUserOrgId] = useState<number | undefined>()

  const orgsQ = useQuery({
    queryKey: ['admin-orgs'],
    queryFn: () => isSA ? saApi.listOrgs() : orgAdminApi.getOrg().then(o => [{
      id: o.id, name: o.name, slug: o.slug, is_active: o.is_active,
      description: o.description, contact_email: o.contact_email,
      plan: o.plan ? { id: 0, name: o.plan.name, slug: '', max_devices: o.plan.max_devices, max_users: o.plan.max_users, max_locations: o.plan.max_locations } : null,
      user_count: o.usage.users,
    } as AdminOrg]),
  })

  const orgs = orgsQ.data ?? []

  const handleSelectOrg = useCallback((org: AdminOrg) => {
    setSelectedOrg(org); setSelectedUser(null)
  }, [])

  const handleSelectUser = useCallback((user: AdminUser, orgId?: number) => {
    setSelectedUser(user); setSelectedUserOrgId(orgId); setSelectedOrg(null)
  }, [])

  return (
    <div style={{ padding: 24, background: t.pageBg, minHeight: '100vh' }}>
      <Title level={4} style={{ color: t.textPrimary, marginBottom: 4 }}>Admin Paneli</Title>
      <Text style={{ color: t.textMuted, marginBottom: 20, display: 'block' }}>
        Organizasyonlar, kullanıcılar ve paket yönetimi
      </Text>

      {orgsQ.isLoading ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16, alignItems: 'start' }}>

          {/* Left: Org Tree */}
          <div style={{
            background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 10,
            overflow: 'hidden', position: 'sticky', top: 24,
            maxHeight: 'calc(100vh - 120px)', display: 'flex', flexDirection: 'column',
            boxShadow: t.isDark ? 'none' : '0 1px 4px rgba(0,0,0,0.06)',
          }}>
            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <ApartmentOutlined style={{ color: '#3b82f6' }} />
              <Text style={{ color: t.textPrimary, fontWeight: 600, fontSize: 13 }}>Organizasyonlar</Text>
              <span style={{ marginLeft: 'auto', background: '#1d4ed8', color: '#fff', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>
                {orgs.length}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
              <OrgTree
                orgs={orgs} isSA={isSA}
                selectedOrgId={selectedOrg?.id ?? null}
                selectedUserId={selectedUser?.id ?? null}
                onSelectOrg={handleSelectOrg}
                onSelectUser={handleSelectUser}
              />
            </div>
          </div>

          {/* Right: Detail */}
          <div style={{
            background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 10,
            padding: 20, minHeight: 400,
            boxShadow: t.isDark ? 'none' : '0 1px 4px rgba(0,0,0,0.06)',
          }}>
            {selectedUser ? (
              <UserEditPanel
                user={selectedUser} orgId={selectedUserOrgId} isSA={isSA}
                onClose={() => setSelectedUser(null)} onSaved={() => {}}
              />
            ) : selectedOrg ? (
              <OrgDetail org={selectedOrg} isSA={isSA} onSelectUser={u => handleSelectUser(u, selectedOrg.id)} />
            ) : (
              <div style={{ padding: '60px 40px', textAlign: 'center' }}>
                <div style={{
                  width: 56, height: 56, borderRadius: '50%', background: t.avatarBg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
                }}>
                  <ApartmentOutlined style={{ fontSize: 24, color: '#3b82f6' }} />
                </div>
                <Text style={{ color: t.textSec, fontSize: 14, display: 'block' }}>Soldaki ağaçtan bir organizasyon veya kullanıcı seçin</Text>
                <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 4, display: 'block' }}>Organizasyon → kullanıcılar ve paket</Text>
                <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 2, display: 'block' }}>Kullanıcı → yetki, rol ve hesap ayarları</Text>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
