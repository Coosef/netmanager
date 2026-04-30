import { useState } from 'react'
import { Alert, App, Button, Form, Modal, Select, Space, Typography } from 'antd'
import { KeyOutlined, ApartmentOutlined, UserSwitchOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { devicesApi } from '@/api/devices'
import { credentialProfilesApi } from '@/api/credentialProfiles'
import type { DeviceGroup } from '@/types'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
}

export default function GroupProfileModal({ open, onClose }: Props) {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const [form] = Form.useForm()
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)

  const { data: groups = [] } = useQuery<DeviceGroup[]>({
    queryKey: ['device-groups'],
    queryFn: devicesApi.listGroups,
    enabled: open,
  })

  const { data: profiles = [] } = useQuery({
    queryKey: ['credential-profiles'],
    queryFn: credentialProfilesApi.list,
    enabled: open,
  })

  const mutation = useMutation({
    mutationFn: ({ groupId, profileId }: { groupId: number; profileId: number | null }) =>
      devicesApi.assignGroupCredentialProfile(groupId, profileId),
    onSuccess: (res) => {
      const profileLabel = res.profile_name ? `"${res.profile_name}"` : 'kaldırıldı'
      message.success(
        `${res.group_name} grubundaki ${res.updated} cihaza credential profil ${profileLabel === 'kaldırıldı' ? profileLabel : `atandı: ${profileLabel}`}`
      )
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      handleClose()
    },
    onError: (err: any) => message.error(err?.response?.data?.detail || 'Atama başarısız'),
  })

  const handleClose = () => {
    form.resetFields()
    setSelectedGroupId(null)
    onClose()
  }

  const onFinish = (values: { group_id: number; credential_profile_id: number | null }) => {
    mutation.mutate({ groupId: values.group_id, profileId: values.credential_profile_id ?? null })
  }

  const groupOptions = groups.map((g: DeviceGroup) => ({
    label: (
      <Space size={6}>
        <ApartmentOutlined style={{ color: '#1677ff' }} />
        <span>{g.name}</span>
        {g.description && <Text type="secondary" style={{ fontSize: 11 }}>— {g.description}</Text>}
      </Space>
    ),
    value: g.id,
  }))

  const profileOptions = [
    { label: <Text type="secondary">— Profil Kaldır —</Text>, value: null },
    ...profiles.map((p) => ({
      label: (
        <Space size={6}>
          <KeyOutlined style={{ color: '#faad14' }} />
          <span>{p.name}</span>
          {p.description && <Text type="secondary" style={{ fontSize: 11 }}>— {p.description}</Text>}
        </Space>
      ),
      value: p.id,
    })),
  ]

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      title={
        <Space>
          <UserSwitchOutlined style={{ color: '#1677ff' }} />
          <span>Gruba Credential Profil Ata</span>
        </Space>
      }
      footer={null}
      width={480}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20, fontSize: 12 }}
        message="Seçilen gruptaki tüm cihazların credential profili toplu olarak güncellenir."
        description="Cihaza bireysel atanan profil varsa bu işlem onu geçersiz kılar."
      />

      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Form.Item label="Cihaz Grubu" name="group_id" rules={[{ required: true, message: 'Grup seçin' }]}>
          <Select
            showSearch
            placeholder="Grup seçin..."
            options={groupOptions}
            onChange={(v) => setSelectedGroupId(v)}
            filterOption={(input, option) =>
              (option?.value?.toString() ?? '').includes(input) ||
              groups.find((g) => g.id === option?.value)?.name?.toLowerCase().includes(input.toLowerCase()) ||
              false
            }
          />
        </Form.Item>

        <Form.Item
          label="Credential Profil"
          name="credential_profile_id"
          rules={[{ required: false }]}
          help={
            selectedGroupId
              ? 'Boş bırakırsanız gruptaki cihazların profil ataması kaldırılır.'
              : undefined
          }
        >
          <Select
            showSearch
            placeholder="Profil seçin (boş = kaldır)..."
            options={profileOptions}
            allowClear
            filterOption={(input, option) =>
              profiles.find((p) => p.id === option?.value)?.name?.toLowerCase().includes(input.toLowerCase()) ||
              false
            }
          />
        </Form.Item>

        <Form.Item style={{ marginBottom: 0 }}>
          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button onClick={handleClose}>İptal</Button>
            <Button
              type="primary"
              htmlType="submit"
              icon={<KeyOutlined />}
              loading={mutation.isPending}
              disabled={!selectedGroupId}
            >
              Ata
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  )
}
