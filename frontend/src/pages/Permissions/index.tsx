import { useMemo, useState } from 'react'
import {
  Select, Tag, Button, Modal, Checkbox, Space, Tooltip,
  message, Spin, Typography, Divider, Popconfirm,
} from 'antd'
import {
  UserOutlined, SafetyOutlined, CheckCircleFilled, CloseCircleFilled,
  EditOutlined, PlusOutlined, SaveOutlined, DeleteOutlined,
  TeamOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { orgAdminApi, type OrgUser } from '@/api/orgAdmin'
import { locationsApi } from '@/api/locations'
import type { PermissionSet, Permissions } from '@/types'
import { useAuthStore } from '@/store/auth'
import { useTheme } from '@/contexts/ThemeContext'

const { Text } = Typography

function usePageTheme() {
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
    tableRow:    isDark ? 'transparent' : 'transparent',
    tableStripe: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
  }
}

// ─── Definitions ──────────────────────────────────────────────────────────────

const MODULES: { key: string; label: string; actions: { key: string; label: string }[] }[] = [
  { key: 'devices',          label: 'Cihazlar',           actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'edit', label: 'Düzenle' }, { key: 'delete', label: 'Sil' }, { key: 'ssh', label: 'SSH' }] },
  { key: 'config_backups',   label: 'Yedekler',           actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'edit', label: 'Düzenle' }, { key: 'delete', label: 'Sil' }] },
  { key: 'tasks',            label: 'Görevler',           actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'create', label: 'Oluştur' }, { key: 'cancel', label: 'İptal' }] },
  { key: 'playbooks',        label: 'Playbooklar',        actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'run', label: 'Çalıştır' }, { key: 'edit', label: 'Düzenle' }, { key: 'delete', label: 'Sil' }] },
  { key: 'topology',         label: 'Topoloji',           actions: [{ key: 'view', label: 'Görüntüle' }] },
  { key: 'monitoring',       label: 'İzleme',             actions: [{ key: 'view', label: 'Görüntüle' }] },
  { key: 'ipam',             label: 'IPAM',               actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'edit', label: 'Düzenle' }, { key: 'delete', label: 'Sil' }] },
  { key: 'audit_logs',       label: 'Denetim Logları',    actions: [{ key: 'view', label: 'Görüntüle' }] },
  { key: 'reports',          label: 'Raporlar',           actions: [{ key: 'view', label: 'Görüntüle' }] },
  { key: 'users',            label: 'Kullanıcılar',       actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'edit', label: 'Düzenle' }, { key: 'delete', label: 'Sil' }, { key: 'invite', label: 'Davet' }] },
  { key: 'locations',        label: 'Lokasyonlar',        actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'edit', label: 'Düzenle' }, { key: 'delete', label: 'Sil' }] },
  // Agent Management / Agent Yönetimi — five-verb catalogue. The
  // legacy `edit` toggle is migrated into `update` server-side; the
  // PermissionEngine alias map keeps either verb granting access
  // during the rolling cutover so editing this group in the UI does
  // not require coordinated backend + frontend rollout.
  { key: 'agents',           label: 'Ajan Yönetimi',      actions: [
    { key: 'view',               label: 'Görüntüle' },
    { key: 'install',            label: 'Kur' },
    { key: 'download_installer', label: 'Kurulum Paketi İndir' },
    { key: 'update',             label: 'Güncelle' },
    { key: 'remove',             label: 'Kaldır' },
  ] },
  { key: 'settings',         label: 'Ayarlar',            actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'edit', label: 'Düzenle' }] },
  { key: 'driver_templates', label: 'Sürücü Şablonları',  actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'edit', label: 'Düzenle' }] },
]

const ALL_ACTIONS = [
  'view', 'edit', 'delete', 'create', 'ssh', 'run', 'cancel', 'invite',
  // Agent Management catalogue (location-agent-permissions work)
  'install', 'download_installer', 'update', 'remove',
]

function getPermValue(perms: Permissions | null | undefined, mod: string, action: string): boolean {
  return !!(perms?.modules?.[mod] as Record<string, boolean> | undefined)?.[action]
}

function setPermValue(perms: Permissions, mod: string, action: string, val: boolean): Permissions {
  const next = JSON.parse(JSON.stringify(perms)) as Permissions
  if (!next.modules[mod]) next.modules[mod] = {}
  ;(next.modules[mod] as Record<string, boolean>)[action] = val
  return next
}

// ─── Permission Matrix Editor ─────────────────────────────────────────────────

function PermMatrix({
  permissions,
  onChange,
  readOnly,
}: {
  permissions: Permissions
  onChange?: (p: Permissions) => void
  readOnly?: boolean
}) {
  const t = usePageTheme()

  const toggle = (mod: string, action: string) => {
    if (readOnly || !onChange) return
    onChange(setPermValue(permissions, mod, action, !getPermValue(permissions, mod, action)))
  }

  const toggleAll = (mod: string, val: boolean) => {
    if (readOnly || !onChange) return
    let p = permissions
    const modDef = MODULES.find(m => m.key === mod)
    for (const a of modDef?.actions ?? []) {
      p = setPermValue(p, mod, a.key, val)
    }
    onChange(p)
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: t.tableHead }}>
            <th style={{ textAlign: 'left', padding: '8px 10px', color: t.textSec, fontWeight: 600, borderBottom: `1px solid ${t.border}`, width: 150 }}>Modül</th>
            {ALL_ACTIONS.map(a => (
              <th key={a} style={{ textAlign: 'center', padding: '8px 4px', color: t.textMuted, fontWeight: 500, borderBottom: `1px solid ${t.border}`, minWidth: 58, fontSize: 11 }}>
                {a === 'view' ? 'Görüntüle' : a === 'edit' ? 'Düzenle' : a === 'delete' ? 'Sil' :
                  a === 'create' ? 'Oluştur' : a === 'ssh' ? 'SSH' : a === 'run' ? 'Çalıştır' :
                  a === 'cancel' ? 'İptal' : a === 'invite' ? 'Davet' : a}
              </th>
            ))}
            {!readOnly && (
              <th style={{ textAlign: 'center', padding: '8px 4px', color: t.textMuted, fontSize: 11, borderBottom: `1px solid ${t.border}`, minWidth: 58 }}>Tümü</th>
            )}
          </tr>
        </thead>
        <tbody>
          {MODULES.map((mod, idx) => {
            const allGranted = mod.actions.every(a => getPermValue(permissions, mod.key, a.key))
            return (
              <tr
                key={mod.key}
                style={{ background: idx % 2 === 0 ? 'transparent' : t.tableStripe }}
              >
                <td style={{ padding: '6px 10px', color: t.textPrimary, fontWeight: 500, fontSize: 12 }}>{mod.label}</td>
                {ALL_ACTIONS.map(action => {
                  const hasDef = mod.actions.some(a => a.key === action)
                  const val = hasDef ? getPermValue(permissions, mod.key, action) : null
                  return (
                    <td key={action} style={{ textAlign: 'center', padding: '6px 0' }}>
                      {val === null ? (
                        <span style={{ color: t.border, fontSize: 16 }}>—</span>
                      ) : readOnly ? (
                        val
                          ? <CheckCircleFilled style={{ color: '#22c55e', fontSize: 16 }} />
                          : <CloseCircleFilled style={{ color: t.isDark ? '#374151' : '#cbd5e1', fontSize: 16 }} />
                      ) : (
                        <Checkbox
                          checked={val}
                          onChange={() => toggle(mod.key, action)}
                        />
                      )}
                    </td>
                  )
                })}
                {!readOnly && (
                  <td style={{ textAlign: 'center' }}>
                    <Button
                      size="small"
                      type={allGranted ? 'primary' : 'default'}
                      danger={allGranted}
                      style={{ fontSize: 10, padding: '0 6px', height: 22 }}
                      onClick={() => toggleAll(mod.key, !allGranted)}
                    >
                      {allGranted ? 'Kaldır' : 'Tümü'}
                    </Button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PermissionsPage() {
  const qc = useQueryClient()
  const { isOrgAdmin } = useAuthStore()
  const canEdit = isOrgAdmin()
  const t = usePageTheme()

  const [selectedUser, setSelectedUser] = useState<OrgUser | null>(null)
  const [editingPermSet, setEditingPermSet] = useState<PermissionSet | null>(null)
  const [editedPerms, setEditedPerms] = useState<Permissions | null>(null)
  const [editName, setEditName] = useState('')
  const [newSetModal, setNewSetModal] = useState(false)
  const [newSetName, setNewSetName] = useState('')
  const [cloneFromId, setCloneFromId] = useState<number | null>(null)
  const [assignModal, setAssignModal] = useState(false)
  const [assignPsId, setAssignPsId] = useState<number | null>(null)
  const [assignLocId, setAssignLocId] = useState<number | null>(null)

  const { data: locationsData } = useQuery({
    queryKey: ['perm-page-locations'],
    queryFn: () => locationsApi.list(),
  })

  const { data: usersData, isLoading: usersLoading, isError: usersError } = useQuery({
    queryKey: ['perm-page-users'],
    queryFn: () => orgAdminApi.listUsers(1, 200),
    retry: false,
  })

  const { data: permSetsData, isError: permSetsError } = useQuery({
    queryKey: ['perm-page-sets'],
    queryFn: orgAdminApi.listPermSets,
    retry: false,
  })

  const { data: userPermsData } = useQuery({
    queryKey: ['user-perms', selectedUser?.id],
    queryFn: () => orgAdminApi.getUserPermissions(selectedUser!.id),
    enabled: !!selectedUser,
  })

  const updatePermSetMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => orgAdminApi.updatePermSet(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['perm-page-sets'] })
      setEditingPermSet(null)
      message.success('Yetki seti güncellendi')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Güncelleme hatası'),
  })

  const createPermSetMut = useMutation({
    mutationFn: (data: any) => orgAdminApi.createPermSet(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['perm-page-sets'] })
      setNewSetModal(false)
      setNewSetName('')
      setCloneFromId(null)
      message.success('Yetki seti oluşturuldu')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const deletePermSetMut = useMutation({
    mutationFn: orgAdminApi.deletePermSet,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['perm-page-sets'] }); message.success('Silindi') },
  })

  const assignPermMut = useMutation({
    mutationFn: ({ userId, psId, locId }: { userId: number; psId: number; locId: number | null }) =>
      orgAdminApi.assignPermission(userId, { user_id: userId, location_id: locId, permission_set_id: psId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-perms', selectedUser?.id] })
      setAssignModal(false)
      message.success('Yetki atandı')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const removeAssignMut = useMutation({
    mutationFn: ({ userId, ulpId }: { userId: number; ulpId: number }) =>
      orgAdminApi.removePermission(userId, ulpId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['user-perms', selectedUser?.id] }) },
  })

  const users = usersData?.users ?? []
  const permSets = permSetsData?.permission_sets ?? []
  const orgPermSets = permSets.filter(p => p.org_id !== null)
  const globalPermSets = permSets.filter(p => p.org_id === null)
  const locations = locationsData?.items ?? []
  const assignments = userPermsData?.assignments ?? []

  // Find effective permission set for selected user (org-wide default)
  const defaultAssignment = assignments.find(a => a.location_id === null)
  const effectivePs = defaultAssignment
    ? permSets.find(p => p.id === defaultAssignment.permission_set_id)
    : null

  const openEdit = (ps: PermissionSet) => {
    setEditingPermSet(ps)
    setEditedPerms(JSON.parse(JSON.stringify(ps.permissions)))
    setEditName(ps.name)
  }

  // RBAC F4 — 4-role colour/label map; aligned with SYSTEM_ROLE_OPTIONS
  // in @/types. Legacy aliases (admin, location_*, org_viewer, operator,
  // member) point at the same colour as their normalised target so older
  // rows still render correctly.
  const ROLE_COLOR: Record<string, string> = {
    super_admin:    '#ef4444',
    org_admin:      '#f97316',  admin:             '#f97316',
    location_admin: '#06b6d4',  location_manager:  '#06b6d4',  location_operator: '#06b6d4',
    viewer:         '#22c55e',  location_viewer:   '#22c55e',  org_viewer:        '#22c55e',
                                operator:          '#22c55e',  member:            t.isDark ? '#475569' : '#64748b',
  }
  const ROLE_LABEL: Record<string, string> = {
    super_admin:    'Süper Admin',
    org_admin:      'Org Admin',         admin:             'Org Admin',
    location_admin: 'Lokasyon Admin',    location_manager:  'Lokasyon Admin',
                                         location_operator: 'Lokasyon Admin',
    viewer:         'Görüntüleyici',     location_viewer:   'Görüntüleyici',
    org_viewer:     'Görüntüleyici',     operator:          'Görüntüleyici',
    member:         'Üye',  // pre-Faz7 alias — legacy data only
  }

  // The 4 roles that get all permissions automatically via system_role —
  // permission_set assignments are only meaningful for the rest.
  const isFullAccessRole = (r?: string) => r === 'super_admin' || r === 'org_admin'
  // Roles that need explicit per-location permission_set assignments to do
  // anything beyond their default read scope.
  const isManagedRole = (r?: string) => r === 'location_admin' || r === 'viewer'

  // ── Real-data stats for the NOC stat bar ──────────────────────────────
  // Managed roles with NO assignment = "yetkisiz" — they cannot reach
  // anything beyond defaults in their org. Super + org admins bypass the
  // permission set system entirely (full-access info pill).
  const stats = useMemo(() => {
    const totalUsers = users.length
    const managed = users.filter((u) => isManagedRole(u.system_role)).length
    const fullAccess = users.filter((u) => isFullAccessRole(u.system_role)).length
    return {
      totalUsers,
      members: managed,   // kept name for stat-bar binding below
      fullAccess,
      orgSets: orgPermSets.length,
      globalTemplates: globalPermSets.length,
      totalSets: permSets.length,
    }
  }, [users, orgPermSets.length, globalPermSets.length, permSets.length])

  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      {/* NOC header */}
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Yönetim</span><span>Yetki Yönetimi</span></div>
          <h1 className="nm-page-title">
            Yetki Yönetimi
            <span className="nm-pill mono">{stats.totalSets} set</span>
          </h1>
          <div className="nm-page-sub">
            Yetki setleri (permission sets) tan&#x131;mlay&#x131;n, kullan&#x131;c&#x131;lara organizasyon ya da lokasyon baz&#x131;nda atay&#x131;n.
            Süper admin + org admin tüm yetkileri otomatik al&#x131;r.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canEdit && (
            <Button type="primary" icon={<PlusOutlined />}
              onClick={() => { setNewSetName(''); setCloneFromId(null); setNewSetModal(true) }}>
              Yeni Yetki Seti
            </Button>
          )}
        </div>
      </div>

      {/* NOC stat bar — 6 real KPIs */}
      <div className="nm-statbar">
        <div className="nm-stat">
          <div className="nm-stat-label">TOPLAM KULLANICI</div>
          <div className="nm-stat-val">{stats.totalUsers}</div>
          <div className="nm-stat-delta">{stats.members} üye</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">YETKİ SETİ</div>
          <div className="nm-stat-val">{stats.totalSets}</div>
          <div className="nm-stat-delta">tüm setler</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">ORG SETİ</div>
          <div className="nm-stat-val">{stats.orgSets}</div>
          <div className="nm-stat-delta">organizasyona özel</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">GLOBAL ŞABLON</div>
          <div className="nm-stat-val">{stats.globalTemplates}</div>
          <div className="nm-stat-delta">salt-okunur</div>
        </div>
        <div className="nm-stat">
          <div className="nm-stat-label">OTOMATİK TAM YETKİ</div>
          <div className="nm-stat-val">{stats.fullAccess}</div>
          <div className="nm-stat-delta">süper + org admin</div>
        </div>
        <div className={`nm-stat ${selectedUser && isManagedRole(selectedUser.system_role) && assignments.length === 0 ? 'crit' : ''}`}>
          <div className="nm-stat-label">SEÇİLİ KULLANICI</div>
          <div className="nm-stat-val" style={{ fontSize: selectedUser ? 14 : 22 }}>
            {selectedUser ? selectedUser.username : '—'}
          </div>
          <div className="nm-stat-delta">
            {selectedUser
              ? (isFullAccessRole(selectedUser.system_role)
                  ? 'rol-tabanlı tam yetki'
                  : `${assignments.length} atama`)
              : 'soldan seçin'}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 14, flex: 1, alignItems: 'start' }}>

        {/* ── Left: User list ── */}
        <div className="nm-card" style={{
          padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
          position: 'sticky', top: 8, maxHeight: 'calc(100vh - 160px)',
        }}>
          <div className="nm-card-hd">
            <h3><TeamOutlined /> Kullanıcılar</h3>
            <span className="nm-pill mono">{users.length}</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {usersLoading ? (
              <div style={{ padding: 24, textAlign: 'center' }}><Spin /></div>
            ) : usersError ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: '#ef4444', fontSize: 13 }}>
                Kullanıcılar yüklenemedi.<br />
                <span style={{ color: t.textMuted, fontSize: 11 }}>Backend bağlantısını kontrol edin.</span>
              </div>
            ) : users.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: t.textMuted, fontSize: 13 }}>
                Henüz kullanıcı yok
              </div>
            ) : users.map((u, idx) => {
              const isSelected = selectedUser?.id === u.id
              return (
                <div
                  key={u.id}
                  onClick={() => setSelectedUser(u)}
                  style={{
                    cursor: 'pointer',
                    padding: '10px 16px',
                    borderBottom: idx < users.length - 1 ? `1px solid ${t.borderLight}` : 'none',
                    borderLeft: `3px solid ${isSelected ? '#3b82f6' : 'transparent'}`,
                    background: isSelected ? t.rowSelected : t.cardBg,
                    display: 'flex', alignItems: 'center', gap: 10,
                    transition: 'background 0.12s',
                  }}
                  onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = t.rowHover }}
                  onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = t.cardBg }}
                >
                  <div style={{
                    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    background: isSelected ? '#1d4ed840' : t.avatarBg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 700, color: isSelected ? '#3b82f6' : t.textMuted,
                  }}>
                    {u.username[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      color: isSelected ? t.textPrimary : t.textSec,
                      fontWeight: isSelected ? 600 : 400, fontSize: 13,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{u.username}</div>
                    <div style={{ color: t.textMuted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                  </div>
                  <div style={{
                    flexShrink: 0, fontSize: 10, fontWeight: 600,
                    color: ROLE_COLOR[u.system_role] ?? t.textMuted,
                    background: `${ROLE_COLOR[u.system_role] ?? t.textMuted}18`,
                    padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap',
                  }}>
                    {ROLE_LABEL[u.system_role] ?? u.system_role}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Right: Selected user + perm sets ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* User permissions panel */}
          {selectedUser && (
            <div className="nm-card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <Text style={{ color: t.textPrimary, fontWeight: 700, fontSize: 16 }}>{selectedUser.username}</Text>
                  <Text style={{ color: t.textMuted, fontSize: 12, marginLeft: 8 }}>{selectedUser.email}</Text>
                </div>
                {canEdit && isManagedRole(selectedUser.system_role) && (
                  <Button
                    type="primary"
                    icon={<SafetyOutlined />}
                    size="small"
                    onClick={() => { setAssignPsId(defaultAssignment?.permission_set_id ?? null); setAssignModal(true) }}
                  >
                    Yetki Set Ata
                  </Button>
                )}
              </div>

              {isFullAccessRole(selectedUser.system_role) ? (
                <div style={{ background: t.cardBg2, borderRadius: 8, padding: '12px 16px', border: `1px solid ${t.border}` }}>
                  <CheckCircleFilled style={{ color: '#f59e0b', marginRight: 8 }} />
                  <Text style={{ color: '#f59e0b' }}>
                    {selectedUser.system_role === 'super_admin'
                      ? 'Süper Admin — platform genelinde tüm yetkiler otomatik (RLS bypass)'
                      : 'Org Admin — kendi organizasyonu içinde tüm yetkiler otomatik'}
                  </Text>
                </div>
              ) : !isManagedRole(selectedUser.system_role) ? (
                <div style={{ background: t.cardBg2, borderRadius: 8, padding: '12px 16px', border: `1px solid ${t.border}` }}>
                  <Text style={{ color: t.textMuted }}>
                    Bilinmeyen rol: <code>{selectedUser.system_role}</code> — bu kullanıcı için yetki seti yönetilemiyor.
                  </Text>
                </div>
              ) : (
                <>
                  {/* Assignments */}
                  <div style={{ marginBottom: 12 }}>
                    {assignments.length === 0 ? (
                      <div style={{ color: '#ef4444', padding: '8px 0', fontSize: 13 }}>
                        Hiç yetki seti atanmamış — erişim yok
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {assignments.map(a => {
                          const ps = permSets.find(p => p.id === a.permission_set_id)
                          return (
                            <Tag
                              key={a.id}
                              color="blue"
                              closable={canEdit}
                              onClose={() => removeAssignMut.mutate({ userId: selectedUser.id, ulpId: a.id })}
                              style={{ fontSize: 12 }}
                            >
                              {ps?.name ?? `Set #${a.permission_set_id}`}
                              {a.location_id
                                ? ` — ${locations.find(l => l.id === a.location_id)?.name ?? `Lok. ${a.location_id}`}`
                                : ' — Tüm Org'}
                            </Tag>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Effective permissions matrix */}
                  {effectivePs && (
                    <>
                      <Divider style={{ borderColor: t.border, margin: '12px 0' }} />
                      <Text style={{ color: t.textSec, fontSize: 12, display: 'block', marginBottom: 8 }}>
                        Aktif yetki seti: <strong style={{ color: '#3b82f6' }}>{effectivePs.name}</strong>
                      </Text>
                      <PermMatrix permissions={effectivePs.permissions} readOnly />
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {!selectedUser && (
            <div className="nm-card" style={{ padding: '40px 30px', textAlign: 'center' }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: 'var(--bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 14px', border: '1px solid var(--border-0)',
              }}>
                <UserOutlined style={{ fontSize: 24, color: 'var(--accent)' }} />
              </div>
              <div style={{ color: 'var(--fg-1)', fontSize: 14 }}>Soldaki listeden bir kullan&#x131;c&#x131; seçin</div>
              <div style={{ color: 'var(--fg-3)', fontSize: 12, marginTop: 4 }}>Kullan&#x131;c&#x131;n&#x131;n mevcut yetkilerini görüntüleyin ve düzenleyin</div>
            </div>
          )}

          {/* ── Permission sets manager ── */}
          <div className="nm-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="nm-card-hd">
              <h3><SafetyOutlined /> Yetki Setleri</h3>
              <span className="nm-pill mono">{permSets.length}</span>
              {canEdit && (
                <Button
                  size="small"
                  type="primary"
                  icon={<PlusOutlined />}
                  style={{ marginLeft: 'auto' }}
                  onClick={() => { setNewSetName(''); setCloneFromId(null); setNewSetModal(true) }}
                >
                  Yeni Set
                </Button>
              )}
            </div>

            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {globalPermSets.length > 0 && (
                <Text style={{ color: t.textMuted, fontSize: 11, marginBottom: 4, letterSpacing: '0.05em' }}>GLOBAL ŞABLONLAR (salt okunur)</Text>
              )}
              {globalPermSets.map(ps => (
                <PermSetCard key={ps.id} ps={ps} onView={() => openEdit(ps)} readOnly />
              ))}

              {orgPermSets.length > 0 && (
                <Text style={{ color: t.textMuted, fontSize: 11, marginTop: 8, marginBottom: 4, letterSpacing: '0.05em' }}>ORGANİZASYON YETKİ SETLERİ</Text>
              )}
              {orgPermSets.map(ps => (
                <PermSetCard
                  key={ps.id}
                  ps={ps}
                  onView={() => openEdit(ps)}
                  onDelete={canEdit ? () => deletePermSetMut.mutate(ps.id) : undefined}
                  readOnly={!canEdit}
                />
              ))}

              {permSetsError && (
                <div style={{ padding: '24px 0', textAlign: 'center', color: '#ef4444', fontSize: 13 }}>
                  Yetki setleri yüklenemedi
                </div>
              )}
              {!permSetsError && permSets.length === 0 && (
                <div style={{ padding: '32px 0', textAlign: 'center' }}>
                  <SafetyOutlined style={{ fontSize: 32, color: t.border, display: 'block', marginBottom: 12 }} />
                  <Text style={{ color: t.textMuted, fontSize: 13, display: 'block' }}>Henüz yetki seti yok</Text>
                  {canEdit && (
                    <Text style={{ color: '#3b82f6', fontSize: 12, marginTop: 4, display: 'block', cursor: 'pointer' }}
                      onClick={() => { setNewSetName(''); setCloneFromId(null); setNewSetModal(true) }}>
                      + İlk yetki setini oluştur
                    </Text>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Edit permission set modal ── */}
      <Modal
        title={
          <Space>
            <SafetyOutlined style={{ color: '#8b5cf6' }} />
            <span>{editingPermSet?.org_id === null ? 'Yetki Seti İncele' : 'Yetki Setini Düzenle'}</span>
            {editingPermSet?.org_id === null && <Tag color="purple">Global</Tag>}
          </Space>
        }
        open={!!editingPermSet}
        onCancel={() => setEditingPermSet(null)}
        width={1000}
        style={{ maxWidth: '95vw' }}
        footer={
          editingPermSet?.org_id !== null && canEdit ? (
            <Space>
              <Button onClick={() => setEditingPermSet(null)}>İptal</Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={updatePermSetMut.isPending}
                onClick={() => {
                  if (!editingPermSet || !editedPerms) return
                  updatePermSetMut.mutate({ id: editingPermSet.id, data: { name: editName, permissions: editedPerms } })
                }}
              >
                Kaydet
              </Button>
            </Space>
          ) : (
            <Button onClick={() => setEditingPermSet(null)}>Kapat</Button>
          )
        }
      >
        {editingPermSet && editedPerms && (
          <>
            {editingPermSet.org_id !== null && canEdit ? (
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                style={{
                  width: '100%', marginBottom: 16, padding: '6px 10px',
                  background: t.inputBg, border: `1px solid ${t.border}`, borderRadius: 6,
                  color: t.textPrimary, fontSize: 14,
                }}
              />
            ) : (
              <Text style={{ color: t.textPrimary, fontWeight: 700, fontSize: 16, display: 'block', marginBottom: 12 }}>
                {editingPermSet.name}
              </Text>
            )}
            <PermMatrix
              permissions={editedPerms}
              onChange={editingPermSet.org_id !== null && canEdit ? setEditedPerms : undefined}
              readOnly={editingPermSet.org_id === null || !canEdit}
            />
          </>
        )}
      </Modal>

      {/* ── New permission set modal ── */}
      <Modal
        title="Yeni Yetki Seti"
        open={newSetModal}
        onCancel={() => setNewSetModal(false)}
        onOk={() => {
          if (!newSetName.trim()) { message.warning('İsim zorunlu'); return }
          createPermSetMut.mutate({ name: newSetName.trim(), cloned_from_id: cloneFromId ?? undefined })
        }}
        confirmLoading={createPermSetMut.isPending}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Text style={{ color: t.textSec, fontSize: 12 }}>Yetki Seti Adı</Text>
            <input
              value={newSetName}
              onChange={e => setNewSetName(e.target.value)}
              placeholder="örn: Okuma Yetkisi"
              style={{
                width: '100%', marginTop: 4, padding: '8px 10px',
                background: t.inputBg, border: `1px solid ${t.border}`, borderRadius: 6,
                color: t.textPrimary, fontSize: 14,
              }}
            />
          </div>
          <div>
            <Text style={{ color: t.textSec, fontSize: 12 }}>Global Şablondan Kopyala (isteğe bağlı)</Text>
            <Select
              allowClear
              placeholder="Şablon seç"
              style={{ width: '100%', marginTop: 4 }}
              value={cloneFromId}
              onChange={v => setCloneFromId(v ?? null)}
              options={[
                ...globalPermSets.map(p => ({ label: `${p.name} (Global)`, value: p.id })),
                ...orgPermSets.map(p => ({ label: p.name, value: p.id })),
              ]}
            />
          </div>
        </div>
      </Modal>

      {/* ── Assign permission set modal ── */}
      <Modal
        title={`${selectedUser?.username} — Yetki Seti Ata`}
        open={assignModal}
        onCancel={() => setAssignModal(false)}
        onOk={() => {
          if (!selectedUser || !assignPsId) { message.warning('Yetki seti seçin'); return }
          assignPermMut.mutate({ userId: selectedUser.id, psId: assignPsId, locId: assignLocId })
        }}
        confirmLoading={assignPermMut.isPending}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Text style={{ color: t.textSec, fontSize: 12 }}>Yetki Seti</Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              placeholder="Seçin"
              value={assignPsId}
              onChange={v => setAssignPsId(v)}
              options={permSets.map(p => ({
                label: `${p.name}${p.org_id === null ? ' (Global)' : ''}`,
                value: p.id,
              }))}
            />
          </div>
          <div>
            <Text style={{ color: t.textSec, fontSize: 12 }}>Lokasyon (boş = tüm organizasyon için geçerli)</Text>
            <Select
              allowClear
              placeholder="Tüm organizasyon"
              style={{ width: '100%', marginTop: 4 }}
              value={assignLocId}
              onChange={v => setAssignLocId(v ?? null)}
              options={[
                ...locations.map(l => ({ label: l.name, value: l.id })),
              ]}
            />
          </div>
          {/* Preview selected permission set */}
          {assignPsId && (() => {
            const ps = permSets.find(p => p.id === assignPsId)
            return ps ? (
              <>
                <Divider style={{ margin: '4px 0', borderColor: t.border }} />
                <Text style={{ color: t.textMuted, fontSize: 12 }}>Önizleme:</Text>
                <PermMatrix permissions={ps.permissions} readOnly />
              </>
            ) : null
          })()}
        </div>
      </Modal>
    </div>
  )
}

// ─── Permission Set Card ──────────────────────────────────────────────────────

function PermSetCard({
  ps,
  onView,
  onDelete,
  readOnly,
}: {
  ps: PermissionSet
  onView: () => void
  onDelete?: () => void
  readOnly?: boolean
}) {
  const grantedCount = Object.values(ps.permissions?.modules ?? {}).reduce((sum, mod) => {
    return sum + Object.values(mod as Record<string, boolean>).filter(Boolean).length
  }, 0)

  const totalCount = MODULES.reduce((sum, m) => sum + m.actions.length, 0)
  const coverage = grantedCount / totalCount
  const barColor = grantedCount === 0 ? 'var(--fg-3)'
    : coverage >= 0.7 ? 'var(--ok)'
    : coverage >= 0.4 ? 'var(--accent)'
    : 'var(--warn)'

  return (
    <div style={{
      background: 'var(--bg-2)', border: '1px solid var(--border-0)', borderRadius: 6,
      padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10,
      transition: 'border-color 0.15s, background 0.15s',
    }}
      onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.borderColor = barColor}
      onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-0)'}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--fg-0)', fontWeight: 600, fontSize: 13 }}>{ps.name}</span>
          {ps.org_id === null && (
            <span className="nm-pill" style={{ fontSize: 9.5, color: '#a78bfa', borderColor: '#a78bfa66' }}>GLOBAL</span>
          )}
          {ps.is_default && (
            <span className="nm-pill" style={{ fontSize: 9.5, color: 'var(--accent)', borderColor: 'var(--accent)' }}>VARSAYILAN</span>
          )}
        </div>
        {ps.description && (
          <div style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 2 }}>{ps.description}</div>
        )}
        {/* Coverage micro-bar */}
        <div style={{
          marginTop: 6, height: 3, background: 'var(--bg-1)', borderRadius: 2, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', width: `${(coverage * 100).toFixed(0)}%`,
            background: barColor, transition: 'width 0.2s',
          }} />
        </div>
      </div>
      <Tooltip title={`${grantedCount}/${totalCount} izin verilmiş`}>
        <span className="nm-pill mono" style={{
          color: barColor, borderColor: barColor + '55',
          background: barColor + '15', flexShrink: 0,
        }}>
          {grantedCount}/{totalCount}
        </span>
      </Tooltip>
      <Space size={4}>
        <Button size="small" icon={<EditOutlined />} onClick={onView} style={{ fontSize: 11 }}>
          {readOnly ? 'İncele' : 'Düzenle'}
        </Button>
        {onDelete && (
          <Popconfirm title="Bu yetki setini sil?" onConfirm={onDelete}>
            <Button size="small" danger icon={<DeleteOutlined />} style={{ fontSize: 11 }} />
          </Popconfirm>
        )}
      </Space>
    </div>
  )
}
