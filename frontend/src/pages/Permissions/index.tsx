import { useState } from 'react'
import {
  Select, Tag, Button, Modal, Checkbox, Space, Tooltip,
  message, Spin, Typography, Divider, Popconfirm,
} from 'antd'
import {
  UserOutlined, SafetyOutlined, CheckCircleFilled, CloseCircleFilled,
  EditOutlined, PlusOutlined, SaveOutlined, DeleteOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { orgAdminApi, type OrgUser } from '@/api/orgAdmin'
import type { PermissionSet, Permissions } from '@/types'
import { useAuthStore } from '@/store/auth'
import { useTheme } from '@/contexts/ThemeContext'

const { Title, Text } = Typography

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
  { key: 'agents',           label: 'Ajanlar',            actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'edit', label: 'Düzenle' }] },
  { key: 'settings',         label: 'Ayarlar',            actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'edit', label: 'Düzenle' }] },
  { key: 'driver_templates', label: 'Sürücü Şablonları',  actions: [{ key: 'view', label: 'Görüntüle' }, { key: 'edit', label: 'Düzenle' }] },
]

const ALL_ACTIONS = ['view', 'edit', 'delete', 'create', 'ssh', 'run', 'cancel', 'invite']

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
            <th style={{ textAlign: 'left', padding: '8px 12px', color: t.textSec, fontWeight: 600, borderBottom: `1px solid ${t.border}`, width: 180 }}>Modül</th>
            {ALL_ACTIONS.map(a => (
              <th key={a} style={{ textAlign: 'center', padding: '8px 8px', color: t.textMuted, fontWeight: 500, borderBottom: `1px solid ${t.border}`, minWidth: 72, fontSize: 11 }}>
                {a === 'view' ? 'Görüntüle' : a === 'edit' ? 'Düzenle' : a === 'delete' ? 'Sil' :
                  a === 'create' ? 'Oluştur' : a === 'ssh' ? 'SSH' : a === 'run' ? 'Çalıştır' :
                  a === 'cancel' ? 'İptal' : a === 'invite' ? 'Davet' : a}
              </th>
            ))}
            {!readOnly && (
              <th style={{ textAlign: 'center', padding: '8px 8px', color: t.textMuted, fontSize: 11, borderBottom: `1px solid ${t.border}` }}>Tümü</th>
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
                <td style={{ padding: '7px 12px', color: t.textPrimary, fontWeight: 500 }}>{mod.label}</td>
                {ALL_ACTIONS.map(action => {
                  const hasDef = mod.actions.some(a => a.key === action)
                  const val = hasDef ? getPermValue(permissions, mod.key, action) : null
                  return (
                    <td key={action} style={{ textAlign: 'center', padding: '7px 0' }}>
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
                      style={{ fontSize: 11, padding: '0 8px', height: 24 }}
                      onClick={() => toggleAll(mod.key, !allGranted)}
                    >
                      {allGranted ? 'Kaldır' : 'Tümünü Ver'}
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

  const ROLE_COLOR: Record<string, string> = {
    super_admin: '#ef4444',
    org_admin: '#3b82f6',
    member: t.isDark ? '#475569' : '#64748b',
  }
  const ROLE_LABEL: Record<string, string> = {
    super_admin: 'Süper Admin',
    org_admin: 'Yönetici',
    member: 'Üye',
  }

  return (
    <div style={{ padding: 24, background: t.pageBg, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Title level={4} style={{ color: t.textPrimary, marginBottom: 4 }}>Yetki Yönetimi</Title>
      <Text style={{ color: t.textMuted, marginBottom: 16, display: 'block' }}>
        Yetki setlerini düzenle, kullanıcılara ata
      </Text>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, flex: 1, alignItems: 'start' }}>

        {/* ── Left: User list ── */}
        <div style={{
          background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 10,
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
          position: 'sticky', top: 24,
          maxHeight: 'calc(100vh - 120px)',
          boxShadow: t.isDark ? 'none' : '0 1px 4px rgba(0,0,0,0.06)',
        }}>
          <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, background: t.cardBg }}>
            <UserOutlined style={{ color: '#3b82f6' }} />
            <Text style={{ color: t.textPrimary, fontWeight: 600, fontSize: 13 }}>Kullanıcılar</Text>
            {users.length > 0 && (
              <span style={{
                marginLeft: 'auto', background: '#1d4ed8', color: '#fff',
                borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 600,
              }}>{users.length}</span>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', background: t.cardBg }}>
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
            <div style={{ background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 10, padding: 20, boxShadow: t.isDark ? 'none' : '0 1px 4px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div>
                  <Text style={{ color: t.textPrimary, fontWeight: 700, fontSize: 16 }}>{selectedUser.username}</Text>
                  <Text style={{ color: t.textMuted, fontSize: 12, marginLeft: 8 }}>{selectedUser.email}</Text>
                </div>
                {canEdit && selectedUser.system_role === 'member' && (
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

              {selectedUser.system_role !== 'member' ? (
                <div style={{ background: t.cardBg2, borderRadius: 8, padding: '12px 16px', border: `1px solid ${t.border}` }}>
                  <CheckCircleFilled style={{ color: '#f59e0b', marginRight: 8 }} />
                  <Text style={{ color: '#f59e0b' }}>
                    {selectedUser.system_role === 'super_admin' ? 'Süper Admin — tüm yetkiler otomatik' : 'Org Yöneticisi — tüm yetkiler otomatik'}
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
                              {a.location_id ? ` (Lok. ${a.location_id})` : ' — Tüm Org'}
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
            <div style={{ background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 10, padding: '48px 40px', textAlign: 'center', boxShadow: t.isDark ? 'none' : '0 1px 4px rgba(0,0,0,0.06)' }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: t.avatarBg, display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 16px',
              }}>
                <UserOutlined style={{ fontSize: 24, color: '#3b82f6' }} />
              </div>
              <Text style={{ color: t.textSec, fontSize: 14, display: 'block' }}>Soldaki listeden bir kullanıcı seçin</Text>
              <Text style={{ color: t.textMuted, fontSize: 12, marginTop: 4, display: 'block' }}>Kullanıcının mevcut yetkilerini görüntüleyin ve düzenleyin</Text>
            </div>
          )}

          {/* ── Permission sets manager ── */}
          <div style={{ background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 10, overflow: 'hidden', boxShadow: t.isDark ? 'none' : '0 1px 4px rgba(0,0,0,0.06)' }}>
            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
              <SafetyOutlined style={{ color: '#8b5cf6' }} />
              <Text style={{ color: t.textPrimary, fontWeight: 600 }}>Yetki Setleri</Text>
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

            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
        width={820}
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
            <Text style={{ color: t.textSec, fontSize: 12 }}>Lokasyon ID (boş = tüm org için geçerli)</Text>
            <input
              type="number"
              placeholder="Boş bırak = tüm organizasyon"
              value={assignLocId ?? ''}
              onChange={e => setAssignLocId(e.target.value ? Number(e.target.value) : null)}
              style={{
                width: '100%', marginTop: 4, padding: '8px 10px',
                background: t.inputBg, border: `1px solid ${t.border}`, borderRadius: 6,
                color: t.textPrimary, fontSize: 14,
              }}
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
  const t = usePageTheme()

  const grantedCount = Object.values(ps.permissions?.modules ?? {}).reduce((sum, mod) => {
    return sum + Object.values(mod as Record<string, boolean>).filter(Boolean).length
  }, 0)

  const totalCount = MODULES.reduce((sum, m) => sum + m.actions.length, 0)

  return (
    <div style={{
      background: t.cardBg2, border: `1px solid ${t.border}`, borderRadius: 8,
      padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
      transition: 'border-color 0.15s',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: t.textPrimary, fontWeight: 600, fontSize: 13 }}>{ps.name}</Text>
          {ps.org_id === null && <Tag color="purple" style={{ fontSize: 10 }}>Global</Tag>}
          {ps.is_default && <Tag color="blue" style={{ fontSize: 10 }}>Varsayılan</Tag>}
        </div>
        {ps.description && <Text style={{ color: t.textMuted, fontSize: 11 }}>{ps.description}</Text>}
      </div>
      <Tooltip title={`${grantedCount}/${totalCount} izin verilmiş`}>
        <div style={{
          background: grantedCount === 0 ? t.border : grantedCount >= totalCount * 0.7 ? '#22c55e20' : '#3b82f620',
          color: grantedCount === 0 ? t.textMuted : grantedCount >= totalCount * 0.7 ? '#22c55e' : '#3b82f6',
          padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, flexShrink: 0,
        }}>
          {grantedCount}/{totalCount}
        </div>
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
