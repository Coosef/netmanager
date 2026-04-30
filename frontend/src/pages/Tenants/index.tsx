import { useState } from 'react'
import {
  App, Button, Drawer, Form, Input, Popconfirm, Select,
  Space, Tag, Badge, Switch, Divider,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  ApartmentOutlined, TeamOutlined, LaptopOutlined, UserAddOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { tenantsApi, type Tenant } from '@/api/tenants'
import { usersApi } from '@/api/users'
import { useTheme } from '@/contexts/ThemeContext'
import type { User } from '@/types'

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

export default function TenantsPage() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const { isDark } = useTheme()
  const C = mkC(isDark)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editTenant, setEditTenant] = useState<Tenant | null>(null)
  const [assignDrawerOpen, setAssignDrawerOpen] = useState(false)
  const [assignTenant, setAssignTenant] = useState<Tenant | null>(null)

  const { data: tenants } = useQuery({
    queryKey: ['tenants'],
    queryFn: tenantsApi.list,
  })

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
  })

  const { data: tenantUsers } = useQuery({
    queryKey: ['tenant-users', assignTenant?.id],
    queryFn: () => tenantsApi.listUsers(assignTenant!.id),
    enabled: !!assignTenant,
  })

  const createMutation = useMutation({
    mutationFn: tenantsApi.create,
    onSuccess: () => {
      message.success('Organizasyon oluşturuldu')
      setDrawerOpen(false)
      queryClient.invalidateQueries({ queryKey: ['tenants'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Oluşturma hatası'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => tenantsApi.update(id, data),
    onSuccess: () => {
      message.success('Organizasyon güncellendi')
      setDrawerOpen(false)
      queryClient.invalidateQueries({ queryKey: ['tenants'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: tenantsApi.delete,
    onSuccess: () => {
      message.success('Organizasyon silindi')
      queryClient.invalidateQueries({ queryKey: ['tenants'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Silme hatası'),
  })

  const assignMutation = useMutation({
    mutationFn: ({ tenantId, userId }: { tenantId: number; userId: number }) =>
      tenantsApi.assignUser(tenantId, userId),
    onSuccess: () => {
      message.success('Kullanıcı atandı')
      queryClient.invalidateQueries({ queryKey: ['tenant-users', assignTenant?.id] })
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Atama hatası'),
  })

  const onSubmit = (values: any) => {
    if (editTenant) {
      updateMutation.mutate({ id: editTenant.id, data: values })
    } else {
      // auto-slug from name if not provided
      if (!values.slug) {
        values.slug = values.name
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9-]/g, '')
          .slice(0, 64)
      }
      createMutation.mutate(values)
    }
  }

  const tenantList = tenants || []
  const unassignedUsers = (allUsers || []).filter((u: User) => !u.tenant_id)

  const usersNotInTenant = (allUsers || []).filter(
    (u: User) => assignTenant && u.tenant_id !== assignTenant.id
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{
        background: isDark ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : C.bg,
        border: `1px solid ${isDark ? '#8b5cf620' : C.border}`,
        borderLeft: '4px solid #8b5cf6',
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
            background: '#8b5cf620', border: '1px solid #8b5cf630',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <ApartmentOutlined style={{ color: '#8b5cf6', fontSize: 20 }} />
          </div>
          <div>
            <div style={{ color: C.text, fontWeight: 700, fontSize: 16 }}>
              Organizasyonlar
              <span style={{ color: C.dim, fontSize: 13, fontWeight: 400, marginLeft: 8 }}>
                ({tenantList.length})
              </span>
            </div>
            <div style={{ color: C.muted, fontSize: 12 }}>Multi-tenant izolasyonu ve erişim yönetimi</div>
          </div>
        </div>
        <Space>
          {unassignedUsers.length > 0 && (
            <Tag color="orange" style={{ cursor: 'default' }}>
              {unassignedUsers.length} atanmamış kullanıcı
            </Tag>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditTenant(null); setDrawerOpen(true) }}>
            Yeni Organizasyon
          </Button>
        </Space>
      </div>

      {/* Tenant Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {tenantList.map((tenant) => (
          <div key={tenant.id} style={{
            background: C.bg,
            border: `1px solid ${tenant.is_active ? (isDark ? '#8b5cf630' : C.border) : C.border}`,
            borderTop: `2px solid ${tenant.is_active ? '#8b5cf6' : C.dim}`,
            borderRadius: 12,
            padding: '16px',
            opacity: tenant.is_active ? 1 : 0.6,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <div style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{tenant.name}</div>
                <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
                  <code style={{ background: isDark ? '#0f172a' : '#f1f5f9', padding: '1px 6px', borderRadius: 4, fontSize: 10 }}>
                    {tenant.slug}
                  </code>
                </div>
              </div>
              <Space size={4}>
                <Button
                  size="small"
                  icon={<UserAddOutlined />}
                  style={{ color: '#8b5cf6', borderColor: '#8b5cf640' }}
                  onClick={() => { setAssignTenant(tenant); setAssignDrawerOpen(true) }}
                />
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  style={{ color: C.muted, borderColor: C.border }}
                  onClick={() => { setEditTenant(tenant); setDrawerOpen(true) }}
                />
                <Popconfirm
                  title={`"${tenant.name}" organizasyonunu silmek istediğinizden emin misiniz?`}
                  onConfirm={() => deleteMutation.mutate(tenant.id)}
                >
                  <Button size="small" icon={<DeleteOutlined />} danger />
                </Popconfirm>
              </Space>
            </div>

            {tenant.description && (
              <div style={{ color: C.muted, fontSize: 12, marginBottom: 12 }}>{tenant.description}</div>
            )}

            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <LaptopOutlined style={{ color: '#3b82f6', fontSize: 13 }} />
                <span style={{ color: C.muted, fontSize: 12 }}>{tenant.device_count} cihaz</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <TeamOutlined style={{ color: '#22c55e', fontSize: 13 }} />
                <span style={{ color: C.muted, fontSize: 12 }}>{tenant.user_count} kullanıcı</span>
              </div>
              <div style={{ marginLeft: 'auto' }}>
                <Badge
                  status={tenant.is_active ? 'success' : 'error'}
                  text={<span style={{ color: C.dim, fontSize: 11 }}>{tenant.is_active ? 'Aktif' : 'Pasif'}</span>}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Create/Edit Drawer */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={<span style={{ color: C.text }}>{editTenant ? 'Organizasyon Düzenle' : 'Yeni Organizasyon'}</span>}
        width={400}
        destroyOnHidden
        styles={{
          body: { background: C.bg },
          header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
        }}
      >
        <Form
          layout="vertical"
          initialValues={editTenant
            ? { name: editTenant.name, description: editTenant.description, is_active: editTenant.is_active }
            : { is_active: true }
          }
          onFinish={onSubmit}
        >
          <Form.Item label="Organizasyon Adı" name="name" rules={[{ required: true, message: 'Ad gerekli' }]}>
            <Input placeholder="Örn: Şube A" />
          </Form.Item>
          {!editTenant && (
            <Form.Item
              label="Slug (URL)"
              name="slug"
              help="Boş bırakılırsa otomatik oluşturulur"
            >
              <Input placeholder="sube-a" />
            </Form.Item>
          )}
          <Form.Item label="Açıklama" name="description">
            <Input.TextArea rows={2} placeholder="Opsiyonel açıklama" />
          </Form.Item>
          <Form.Item label="Aktif" name="is_active" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={createMutation.isPending || updateMutation.isPending}
              block
            >
              {editTenant ? 'Kaydet' : 'Oluştur'}
            </Button>
          </Form.Item>
        </Form>
      </Drawer>

      {/* Assign Users Drawer */}
      <Drawer
        open={assignDrawerOpen}
        onClose={() => { setAssignDrawerOpen(false); setAssignTenant(null) }}
        title={
          <span style={{ color: C.text }}>
            <ApartmentOutlined style={{ marginRight: 8, color: '#8b5cf6' }} />
            {assignTenant?.name} — Kullanıcı Yönetimi
          </span>
        }
        width={460}
        destroyOnHidden
        styles={{
          body: { background: C.bg },
          header: { background: C.bg, borderBottom: `1px solid ${C.border}` },
        }}
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ color: C.muted, fontSize: 12, marginBottom: 8 }}>Başka bir kullanıcıyı bu organizasyona ata:</div>
          <Select
            style={{ width: '100%' }}
            placeholder="Kullanıcı seç..."
            showSearch
            filterOption={(input, option) =>
              (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
            }
            options={usersNotInTenant.map((u: User) => ({
              label: `${u.username} (${u.role})`,
              value: u.id,
            }))}
            onChange={(userId) => {
              if (assignTenant) {
                assignMutation.mutate({ tenantId: assignTenant.id, userId })
              }
            }}
          />
        </div>

        <Divider style={{ borderColor: C.border, margin: '16px 0' }} />

        <div style={{ color: C.text, fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
          Bu organizasyondaki kullanıcılar ({tenantUsers?.length ?? 0})
        </div>

        {(tenantUsers || []).map((u) => (
          <div key={u.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px', borderRadius: 8,
            border: `1px solid ${C.border}`, marginBottom: 6,
            background: C.bg2,
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: 6, background: '#3b82f620',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#3b82f6', fontWeight: 700, fontSize: 13,
            }}>
              {u.username[0].toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: C.text, fontSize: 13, fontWeight: 500 }}>{u.username}</div>
              <div style={{ color: C.muted, fontSize: 11 }}>{u.email}</div>
            </div>
            <Tag style={{ fontSize: 10, margin: 0 }}>{u.role}</Tag>
          </div>
        ))}

        {tenantUsers?.length === 0 && (
          <div style={{ color: C.dim, fontSize: 12, textAlign: 'center', padding: '16px 0' }}>
            Bu organizasyonda henüz kullanıcı yok
          </div>
        )}
      </Drawer>
    </div>
  )
}
