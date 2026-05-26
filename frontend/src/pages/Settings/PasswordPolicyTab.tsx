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
import { passwordPolicyApi } from '@/api/passwordPolicy'
import { useAuthStore } from '@/store/auth'

const { Text, Paragraph } = Typography

export default function PasswordPolicyTab() {
  const qc = useQueryClient()
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
      message.success('Şifre politikası güncellendi')
      qc.invalidateQueries({ queryKey: ['password-policy'] })
    },
    onError: (err: any) => {
      message.error(err?.response?.data?.detail || 'Politika kaydedilemedi')
    },
  })

  const resetMut = useMutation({
    mutationFn: passwordPolicyApi.resetToGlobal,
    onSuccess: () => {
      message.success('Org özel politikası silindi — global default geçerli')
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
        message="Yetersiz yetki"
        description="Şifre politikasını sadece org_admin veya super_admin görüntüleyip değiştirebilir."
      />
    )
  }

  if (policyQ.isLoading) return <Text style={{ color: 'var(--fg-3)' }}>Yükleniyor…</Text>

  return (
    <Space direction="vertical" size={18} style={{ width: '100%' }}>
      <div>
        <Space size={8} style={{ marginBottom: 6 }}>
          <SafetyOutlined style={{ fontSize: 18, color: 'var(--accent)' }} />
          <Text strong style={{ fontSize: 15 }}>Şifre Politikası</Text>
          {isOrgOverride ? (
            <Tag color="cyan">Org Özel</Tag>
          ) : (
            <Tag>Global Varsayılan</Tag>
          )}
        </Space>
        <Paragraph style={{ color: 'var(--fg-3)', fontSize: 12, marginBottom: 0 }}>
          Bu kurallar yeni kullanıcı oluşturma, kullanıcı kendi şifresini değiştirirken
          ve admin reset sonrasında uygulanır. Kaynak:&nbsp;
          <code>{policyQ.data?.source}</code>
        </Paragraph>
      </div>

      <Card title="Kurallar" extra={
        isOrgOverride && (
          <Popconfirm
            title="Org özel politikasını sil"
            description="Bu org global default'a döner. Devam edilsin mi?"
            onConfirm={() => resetMut.mutate()}
          >
            <Button size="small" icon={<UndoOutlined />}>Global'e Dön</Button>
          </Popconfirm>
        )
      }>
        <Form
          form={form}
          layout="vertical"
          onFinish={(vals) => upsertMut.mutate(vals)}
        >
          <Form.Item label="Minimum uzunluk" name="min_length"
            rules={[{ required: true, type: 'number', min: 4, max: 128 }]}>
            <InputNumber min={4} max={128} style={{ width: 120 }} />
          </Form.Item>

          <Form.Item label={
            <Space>Karakter sınıfı zorunlulukları</Space>
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

          <Form.Item label="Geçmiş tekrar kontrolü (history)" name="history_count"
            tooltip="Son N şifrenin tekrar kullanılmasını engelle. 0 = kontrol yok.">
            <InputNumber min={0} max={24} style={{ width: 120 }} addonAfter="şifre" />
          </Form.Item>

          <Form.Item label="Şifre süresi (gün)" name="expiry_days"
            tooltip="Bu sürenin sonunda kullanıcı zorla şifre değiştirir. 0 = expire yok.">
            <InputNumber min={0} max={3650} style={{ width: 120 }} addonAfter="gün" />
          </Form.Item>

          <Form.Item label="İlk login'de zorla şifre değiştir"
            name="force_change_on_first_login" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Button type="primary" htmlType="submit" loading={upsertMut.isPending}>
            Kaydet
          </Button>
        </Form>
      </Card>

      <Card title={<Space><LockOutlined /> Şifre Test Aracı</Space>}>
        <Paragraph style={{ color: 'var(--fg-3)', fontSize: 12 }}>
          Bir şifrenin mevcut politikadan geçip geçmediğini görmek için aşağıya yazın.
        </Paragraph>
        <Input.Password
          placeholder="Test edilecek şifre…"
          value={testPw} onChange={(e) => setTestPw(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        {testPw.length > 0 && validateQ.data && (
          validateQ.data.ok ? (
            <Alert
              type="success" showIcon
              icon={<CheckCircleOutlined />}
              message="Şifre politikadan geçti ✓"
              description={`Politika kaynağı: ${validateQ.data.policy_source}`}
            />
          ) : (
            <Alert
              type="error" showIcon
              icon={<CloseCircleOutlined />}
              message="Şifre politikadan geçemedi"
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
