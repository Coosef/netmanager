import { useState } from 'react'
import { Alert, App, Button, Form, Modal, Select, Space, Typography } from 'antd'
import { KeyOutlined, ApartmentOutlined, UserSwitchOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
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
      message.success(
        res.profile_name
          ? t('devices.group_profile.toast_assigned', { group: res.group_name, count: res.updated, profile: res.profile_name })
          : t('devices.group_profile.toast_removed', { group: res.group_name, count: res.updated })
      )
      queryClient.invalidateQueries({ queryKey: ['devices'] })
      handleClose()
    },
    onError: (err: any) => message.error(err?.response?.data?.detail || t('devices.group_profile.toast_failed')),
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
    { label: <Text type="secondary">{t('devices.group_profile.profile_remove')}</Text>, value: null },
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
          <span>{t('devices.group_profile.title')}</span>
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
        message={t('devices.group_profile.alert_title')}
        description={t('devices.group_profile.alert_desc')}
      />

      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Form.Item label={t('devices.group_profile.group_label')} name="group_id" rules={[{ required: true, message: t('devices.group_profile.group_required') }]}>
          <Select
            showSearch
            placeholder={t('devices.group_profile.group_placeholder')}
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
          label={t('devices.group_profile.profile_label')}
          name="credential_profile_id"
          rules={[{ required: false }]}
          help={
            selectedGroupId
              ? t('devices.group_profile.profile_help_empty')
              : undefined
          }
        >
          <Select
            showSearch
            placeholder={t('devices.group_profile.profile_placeholder')}
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
            <Button onClick={handleClose}>{t('common.cancel')}</Button>
            <Button
              type="primary"
              htmlType="submit"
              icon={<KeyOutlined />}
              loading={mutation.isPending}
              disabled={!selectedGroupId}
            >
              {t('devices.group_profile.assign_btn')}
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  )
}
