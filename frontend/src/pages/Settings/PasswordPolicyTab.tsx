/**
 * PasswordPolicyTab — Org bazlı şifre kuralları yönetimi.
 *
 * T9 Tur 2 #3. Org admin / super admin değiştirebilir.
 *   - Min uzunluk, complexity flag'leri, history count, expiry days
 *   - "İlk login'de şifre değiştir" toggle
 *   - Anlık şifre test alanı (canlı validate)
 *   - "Global default'a dön" butonu (org override sil)
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Form, Input, InputNumber, Popconfirm,
  Space, Switch, Tag, Typography, message,
} from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined, LockOutlined,
  SafetyOutlined, UndoOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { passwordPolicyApi } from '@/api/passwordPolicy'
import { useAuthStore } from '@/store/auth'

const { Text, Paragraph } = Typography

export default function PasswordPolicyTab() {
  const qc = useQueryClient()
  const { t } = useTranslation()
  const { user } = useAuthStore()
  const canEdit = user?.system_role === 'super_admin' || user?.system_role === 'org_admin'
  const [form] = Form.useForm()
  const [testPw, setTestPw] = useState('')

  const policyQ = useQuery({
    queryKey: ['password-policy'],
    queryFn: passwordPolicyApi.get,
  })

  // Form'a effective policy'i yükle
  useEffect(() => {
    if (policyQ.data) {
      form.setFieldsValue(policyQ.data)
    }
  }, [policyQ.data, form])

  const upsertMut = useMutation({
    mutationFn: passwordPolicyApi.upsert,
    onSuccess: () => {
      message.success(t('settings.password_policy.toast.updated'))
      qc.invalidateQueries({ queryKey: ['password-policy'] })
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail || t('settings.password_policy.toast.save_failed'))
    },
  })

  const resetMut = useMutation({
    mutationFn: passwordPolicyApi.resetToGlobal,
    onSuccess: () => {
      message.success(t('settings.password_policy.toast.reset_done'))
      qc.invalidateQueries({ queryKey: ['password-policy'] })
    },
  })

  // Canlı test
  const validateQ = useQuery({
    queryKey: ['password-policy-validate', testPw],
    queryFn: () => passwordPolicyApi.validate(testPw),
    enabled: testPw.length > 0,
  })

  const isOrgOverride = useMemo(
    () => policyQ.data?.source?.startsWith('org-') ?? false,
    [policyQ.data?.source],
  )

  if (!canEdit) {
    return (
      <Alert
        type="warning" showIcon
        message={t('settings.password_policy.no_permission_title')}
        description={t('settings.password_policy.no_permission_desc')}
      />
    )
  }

  if (policyQ.isLoading) return <Text style={{ color: 'var(--fg-3)' }}>{t('common.loading')}</Text>

  return (
    <Space direction="vertical" size={18} style={{ width: '100%' }}>
      <div>
        <Space size={8} style={{ marginBottom: 6 }}>
          <SafetyOutlined style={{ fontSize: 18, color: 'var(--accent)' }} />
          <Text strong style={{ fontSize: 15 }}>{t('settings.password_policy.page_title')}</Text>
          {isOrgOverride ? (
            <Tag color="cyan">{t('settings.system.scope.org_override')}</Tag>
          ) : (
            <Tag>{t('settings.password_policy.tag_global_default')}</Tag>
          )}
        </Space>
        <Paragraph style={{ color: 'var(--fg-3)', fontSize: 12, marginBottom: 0 }}>
          {t('settings.password_policy.intro')}&nbsp;
          <code>{policyQ.data?.source}</code>
        </Paragraph>
      </div>

      <Card title={t('settings.password_policy.card_rules_title')} extra={
        isOrgOverride && (
          <Popconfirm
            title={t('settings.password_policy.popconfirm.reset_title')}
            description={t('settings.password_policy.popconfirm.reset_desc')}
            onConfirm={() => resetMut.mutate()}
          >
            <Button size="small" icon={<UndoOutlined />}>{t('settings.password_policy.btn_back_to_global')}</Button>
          </Popconfirm>
        )
      }>
        <Form
          form={form}
          layout="vertical"
          onFinish={(vals) => upsertMut.mutate(vals)}
        >
          <Form.Item label={t('settings.password_policy.form.min_length_label')} name="min_length"
            rules={[{ required: true, type: 'number', min: 4, max: 128 }]}>
            <InputNumber min={4} max={128} style={{ width: 120 }} />
          </Form.Item>

          <Form.Item label={
            <Space>{t('settings.password_policy.form.classes_label')}</Space>
          }>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Form.Item name="require_uppercase" valuePropName="checked" noStyle>
                <Switch checkedChildren="A-Z" unCheckedChildren="A-Z" />
              </Form.Item>
              <Space size={8}>
                <Form.Item name="require_lowercase" valuePropName="checked" noStyle>
                  <Switch checkedChildren="a-z" unCheckedChildren="a-z" />
                </Form.Item>
                <Form.Item name="require_digit" valuePropName="checked" noStyle>
                  <Switch checkedChildren="0-9" unCheckedChildren="0-9" />
                </Form.Item>
                <Form.Item name="require_special" valuePropName="checked" noStyle>
                  <Switch checkedChildren="!@#" unCheckedChildren="!@#" />
                </Form.Item>
              </Space>
            </Space>
          </Form.Item>

          <Form.Item label={t('settings.password_policy.form.history_label')} name="history_count"
            tooltip={t('settings.password_policy.form.history_tooltip')}>
            <InputNumber min={0} max={24} style={{ width: 120 }} addonAfter={t('settings.password_policy.unit.password_short')} />
          </Form.Item>

          <Form.Item label={t('settings.password_policy.form.expiry_label')} name="expiry_days"
            tooltip={t('settings.password_policy.form.expiry_tooltip')}>
            <InputNumber min={0} max={3650} style={{ width: 120 }} addonAfter={t('settings.unit.day')} />
          </Form.Item>

          <Form.Item label={t('settings.password_policy.form.force_change_label')}
            name="force_change_on_first_login" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Button type="primary" htmlType="submit" loading={upsertMut.isPending}>
            {t('common.save')}
          </Button>
        </Form>
      </Card>

      <Card title={<Space><LockOutlined /> {t('settings.password_policy.tester_card_title')}</Space>}>
        <Paragraph style={{ color: 'var(--fg-3)', fontSize: 12 }}>
          {t('settings.password_policy.tester_hint')}
        </Paragraph>
        <Input.Password
          placeholder={t('settings.password_policy.tester_placeholder')}
          value={testPw} onChange={(e) => setTestPw(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        {testPw.length > 0 && validateQ.data && (
          validateQ.data.ok ? (
            <Alert
              type="success" showIcon
              icon={<CheckCircleOutlined />}
              message={t('settings.password_policy.tester_pass_message')}
              description={t('settings.password_policy.tester_source', { source: validateQ.data.policy_source })}
            />
          ) : (
            <Alert
              type="error" showIcon
              icon={<CloseCircleOutlined />}
              message={t('settings.password_policy.tester_fail_message')}
              description={
                <ul style={{ marginBottom: 0, paddingLeft: 18 }}>
                  {validateQ.data.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              }
            />
          )
        )}
      </Card>
    </Space>
  )
}
