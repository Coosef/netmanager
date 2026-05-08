import { useState } from 'react'
import {
  Tabs, Table, Button, Tag, Modal, Form, Input, Select, Space,
  Statistic, Row, Col, Card, message, Popconfirm, Typography,
} from 'antd'
import {
  TeamOutlined, SafetyOutlined, PlusOutlined, SendOutlined,
  EditOutlined, DeleteOutlined, KeyOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { orgAdminApi, type OrgUser } from '@/api/orgAdmin'
import type { PermissionSet } from '@/types'

const { Title, Text } = Typography

const SYSTEM_ROLE_LABELS: Record<string, string> = {
  super_admin: 'Süper Admin',
  org_admin: 'Org Yöneticisi',
  member: 'Üye',
}

export default function OrgAdminPage() {
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState('org')
  const [inviteModal, setInviteModal] = useState(false)
  const [permSetModal, setPermSetModal] = useState<PermissionSet | null | 'new'>(null)
  const [assignModal, setAssignModal] = useState<OrgUser | null>(null)
  const [inviteForm] = Form.useForm()
  const [permSetForm] = Form.useForm()
  const [assignForm] = Form.useForm()

  const { data: org } = useQuery({ queryKey: ['org-info'], queryFn: orgAdminApi.getOrg })
  const { data: usersData, isLoading: usersLoading } = useQuery({
    queryKey: ['org-users'],
    queryFn: () => orgAdminApi.listUsers(),
  })
  const { data: permSetsData } = useQuery({
    queryKey: ['org-perm-sets'],
    queryFn: orgAdminApi.listPermSets,
  })

  const inviteMut = useMutation({
    mutationFn: orgAdminApi.invite,
    onSuccess: (data) => {
      message.success(`Davet gönderildi! Token: ${data.invite_token}`)
      setInviteModal(false)
      inviteForm.resetFields()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Davet gönderilemedi'),
  })

  const removeUserMut = useMutation({
    mutationFn: orgAdminApi.removeUser,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['org-users'] }); message.success('Kullanıcı kaldırıldı') },
  })

  const createPermSetMut = useMutation({
    mutationFn: orgAdminApi.createPermSet,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['org-perm-sets'] }); setPermSetModal(null); message.success('Yetki seti oluşturuldu') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const deletePermSetMut = useMutation({
    mutationFn: orgAdminApi.deletePermSet,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['org-perm-sets'] }); message.success('Silindi') },
  })

  const assignPermMut = useMutation({
    mutationFn: ({ userId, data }: { userId: number; data: any }) => orgAdminApi.assignPermission(userId, data),
    onSuccess: () => { setAssignModal(null); message.success('Yetki atandı') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Hata'),
  })

  const permSets = permSetsData?.permission_sets ?? []
  const users = usersData?.users ?? []

  const userColumns = [
    { title: 'Kullanıcı', dataIndex: 'username', render: (v: string, r: OrgUser) => (
      <Space direction="vertical" size={0}>
        <Text strong style={{ color: '#f1f5f9' }}>{v}</Text>
        <Text style={{ color: '#64748b', fontSize: 12 }}>{r.email}</Text>
      </Space>
    )},
    { title: 'Ad Soyad', dataIndex: 'full_name', render: (v: string) => v || '-' },
    { title: 'Rol', dataIndex: 'system_role', render: (v: string) => (
      <Tag color={v === 'org_admin' ? 'blue' : v === 'super_admin' ? 'red' : 'default'}>
        {SYSTEM_ROLE_LABELS[v] ?? v}
      </Tag>
    )},
    { title: 'Durum', dataIndex: 'is_active', render: (v: boolean) => (
      <Tag color={v ? 'green' : 'red'}>{v ? 'Aktif' : 'Pasif'}</Tag>
    )},
    { title: 'Son Giriş', dataIndex: 'last_login', render: (v: string) => v ? new Date(v).toLocaleString('tr') : '-' },
    {
      title: 'İşlem',
      render: (_: any, r: OrgUser) => (
        <Space>
          <Button size="small" icon={<KeyOutlined />} onClick={() => setAssignModal(r)}>Yetki</Button>
          <Popconfirm title="Bu kullanıcıyı kaldır?" onConfirm={() => removeUserMut.mutate(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const permSetColumns = [
    { title: 'Ad', dataIndex: 'name', render: (v: string, r: PermissionSet) => (
      <Space>
        <Text strong style={{ color: '#f1f5f9' }}>{v}</Text>
        {r.org_id === null && <Tag color="purple">Global</Tag>}
        {r.is_default && <Tag color="blue">Varsayılan</Tag>}
      </Space>
    )},
    { title: 'Açıklama', dataIndex: 'description', render: (v: string) => v || '-' },
    { title: 'Son Güncelleme', dataIndex: 'updated_at', render: (v: string) => new Date(v).toLocaleDateString('tr') },
    {
      title: 'İşlem',
      render: (_: any, r: PermissionSet) => r.org_id !== null ? (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => { setPermSetModal(r); permSetForm.setFieldsValue({ name: r.name, description: r.description }) }}>Düzenle</Button>
          <Popconfirm title="Yetki setini sil?" onConfirm={() => deletePermSetMut.mutate(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ) : <Tag color="purple">Salt Okunur</Tag>,
    },
  ]

  return (
    <div style={{ padding: '24px', minHeight: '100vh', background: '#030c1e', color: '#f1f5f9' }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={4} style={{ color: '#f1f5f9', margin: 0 }}>Organizasyon Paneli</Title>
        {org && <Text style={{ color: '#64748b' }}>{org.name}</Text>}
      </div>

      {/* Usage stats */}
      {org && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={6}>
            <Card style={{ background: '#0e1e38', border: '1px solid #1a3458' }}>
              <Statistic title={<span style={{ color: '#64748b' }}>Kullanıcılar</span>}
                value={org.usage.users} suffix={org.plan ? `/ ${org.plan.max_users}` : ''}
                valueStyle={{ color: '#3b82f6' }} />
            </Card>
          </Col>
          {org.plan && (
            <Col span={6}>
              <Card style={{ background: '#0e1e38', border: '1px solid #1a3458' }}>
                <Statistic title={<span style={{ color: '#64748b' }}>Plan</span>}
                  value={org.plan.name} valueStyle={{ color: '#22c55e', fontSize: 14 }} />
              </Card>
            </Col>
          )}
        </Row>
      )}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'org',
            label: <span><TeamOutlined /> Kullanıcılar</span>,
            children: (
              <>
                <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
                  <Text style={{ color: '#94a3b8' }}>Toplam: {usersData?.total ?? 0} kullanıcı</Text>
                  <Button type="primary" icon={<SendOutlined />} onClick={() => setInviteModal(true)}>
                    Kullanıcı Davet Et
                  </Button>
                </div>
                <Table
                  dataSource={users}
                  columns={userColumns}
                  rowKey="id"
                  loading={usersLoading}
                  pagination={{ pageSize: 20 }}
                  style={{ background: '#0a111f' }}
                />
              </>
            ),
          },
          {
            key: 'permissions',
            label: <span><SafetyOutlined /> Yetki Setleri</span>,
            children: (
              <>
                <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => { setPermSetModal('new'); permSetForm.resetFields() }}>
                    Yeni Yetki Seti
                  </Button>
                </div>
                <Table
                  dataSource={permSets}
                  columns={permSetColumns}
                  rowKey="id"
                  pagination={{ pageSize: 20 }}
                  style={{ background: '#0a111f' }}
                />
              </>
            ),
          },
        ]}
      />

      {/* Invite Modal */}
      <Modal
        title="Kullanıcı Davet Et"
        open={inviteModal}
        onCancel={() => setInviteModal(false)}
        onOk={() => inviteForm.submit()}
        confirmLoading={inviteMut.isPending}
      >
        <Form form={inviteForm} layout="vertical" onFinish={(v) => inviteMut.mutate(v)}>
          <Form.Item name="email" label="E-posta" rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="full_name" label="Ad Soyad">
            <Input />
          </Form.Item>
          <Form.Item name="system_role" label="Rol" initialValue="member">
            <Select options={[
              { label: 'Üye', value: 'member' },
              { label: 'Org Yöneticisi', value: 'org_admin' },
            ]} />
          </Form.Item>
          <Form.Item name="permission_set_id" label="Varsayılan Yetki Seti">
            <Select allowClear placeholder="Seçin (isteğe bağlı)"
              options={permSets.filter(p => p.org_id !== null).map(p => ({ label: p.name, value: p.id }))}
            />
          </Form.Item>
          <Form.Item name="expires_hours" label="Geçerlilik (saat)" initialValue={72}>
            <Input type="number" min={1} max={720} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Permission Set Modal */}
      <Modal
        title={permSetModal === 'new' ? 'Yeni Yetki Seti' : 'Yetki Setini Düzenle'}
        open={!!permSetModal}
        onCancel={() => setPermSetModal(null)}
        onOk={() => permSetForm.submit()}
        confirmLoading={createPermSetMut.isPending}
        width={700}
      >
        <Form form={permSetForm} layout="vertical" onFinish={(v) => {
          if (permSetModal === 'new') {
            createPermSetMut.mutate({ name: v.name, description: v.description, cloned_from_id: v.cloned_from_id })
          } else if (permSetModal && typeof permSetModal !== 'string') {
            orgAdminApi.updatePermSet(permSetModal.id, { name: v.name, description: v.description })
              .then(() => { qc.invalidateQueries({ queryKey: ['org-perm-sets'] }); setPermSetModal(null); message.success('Güncellendi') })
          }
        }}>
          <Form.Item name="name" label="Ad" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Açıklama">
            <Input.TextArea rows={2} />
          </Form.Item>
          {permSetModal === 'new' && (
            <Form.Item name="cloned_from_id" label="Global Şablondan Kopyala">
              <Select allowClear placeholder="Seçin (isteğe bağlı)"
                options={permSets.filter(p => p.org_id === null).map(p => ({ label: p.name, value: p.id }))}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* Assign Permission Modal */}
      {assignModal && (
        <Modal
          title={`${assignModal.username} — Yetki Ata`}
          open={!!assignModal}
          onCancel={() => setAssignModal(null)}
          onOk={() => assignForm.submit()}
          confirmLoading={assignPermMut.isPending}
        >
          <Form form={assignForm} layout="vertical" onFinish={(v) => {
            assignPermMut.mutate({
              userId: assignModal.id,
              data: { user_id: assignModal.id, location_id: v.location_id || null, permission_set_id: v.permission_set_id },
            })
          }}>
            <Form.Item name="permission_set_id" label="Yetki Seti" rules={[{ required: true }]}>
              <Select
                options={permSets.map(p => ({ label: `${p.name}${p.org_id === null ? ' (Global)' : ''}`, value: p.id }))}
              />
            </Form.Item>
            <Form.Item name="location_id" label="Lokasyon (boş = tüm org)">
              <Input type="number" placeholder="Lokasyon ID (opsiyonel)" />
            </Form.Item>
          </Form>
        </Modal>
      )}
    </div>
  )
}
