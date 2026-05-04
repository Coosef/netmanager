import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Form, Input, Spin, Typography } from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined, WifiOutlined,
} from '@ant-design/icons'
import { invitesApi } from '@/api/invites'

const { Title, Text } = Typography

type State = 'loading' | 'ready' | 'error' | 'success'

export default function InviteAcceptPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') || ''

  const [state, setState] = useState<State>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()

  useEffect(() => {
    if (!token) { setState('error'); setErrorMsg('Token bulunamadı'); return }
    invitesApi.check(token)
      .then((data) => { setInviteEmail(data.email); setInviteRole(data.role); setState('ready') })
      .catch((e) => { setState('error'); setErrorMsg(e?.response?.data?.detail || 'Geçersiz davet linki') })
  }, [token])

  const handleSubmit = async () => {
    const vals = await form.validateFields()
    setSubmitting(true)
    try {
      await invitesApi.accept(token, vals.username, vals.password, vals.full_name || '')
      setState('success')
    } catch (e: any) {
      setErrorMsg(e?.response?.data?.detail || 'Kayıt başarısız')
      setSubmitting(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #030c1e 0%, #071224 50%, #0e1e38 100%)',
      padding: 24,
    }}>
      <div style={{
        background: '#0e1e38', border: '1px solid #1a3458', borderRadius: 16,
        padding: '40px 36px', width: '100%', maxWidth: 420,
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14, margin: '0 auto 12px',
            background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <WifiOutlined style={{ color: '#fff', fontSize: 24 }} />
          </div>
          <div style={{ color: '#f1f5f9', fontWeight: 800, fontSize: 18 }}>NetManager</div>
          <div style={{ color: '#64748b', fontSize: 11, letterSpacing: 2 }}>NETWORK INTELLIGENCE PLATFORM</div>
        </div>

        {state === 'loading' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <Spin size="large" />
            <div style={{ color: '#64748b', marginTop: 12 }}>Davet doğrulanıyor...</div>
          </div>
        )}

        {state === 'error' && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <CloseCircleOutlined style={{ fontSize: 40, color: '#ef4444', display: 'block', marginBottom: 12 }} />
            <Title level={5} style={{ color: '#f1f5f9', margin: '0 0 8px' }}>Davet Geçersiz</Title>
            <Text style={{ color: '#94a3b8', fontSize: 13 }}>{errorMsg}</Text>
            <Button
              type="primary"
              block
              style={{ marginTop: 24 }}
              onClick={() => navigate('/login')}
            >
              Giriş Sayfasına Dön
            </Button>
          </div>
        )}

        {state === 'success' && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <CheckCircleOutlined style={{ fontSize: 40, color: '#22c55e', display: 'block', marginBottom: 12 }} />
            <Title level={5} style={{ color: '#f1f5f9', margin: '0 0 8px' }}>Hesabınız Oluşturuldu</Title>
            <Text style={{ color: '#94a3b8', fontSize: 13 }}>
              Şimdi giriş yapabilirsiniz.
            </Text>
            <Button
              type="primary"
              block
              style={{ marginTop: 24 }}
              onClick={() => navigate('/login')}
            >
              Giriş Yap
            </Button>
          </div>
        )}

        {state === 'ready' && (
          <>
            <div style={{ background: '#071224', border: '1px solid #1a3458', borderRadius: 8, padding: '10px 14px', marginBottom: 24 }}>
              <Text style={{ color: '#94a3b8', fontSize: 12 }}>
                <strong style={{ color: '#3b82f6' }}>{inviteEmail}</strong> için davet linki.
                Rol: <strong style={{ color: '#f1f5f9' }}>{inviteRole}</strong>
              </Text>
            </div>

            <Form form={form} layout="vertical" onFinish={handleSubmit}>
              <Form.Item
                label={<span style={{ color: '#94a3b8', fontSize: 12 }}>Ad Soyad</span>}
                name="full_name"
              >
                <Input
                  placeholder="Ad Soyad (isteğe bağlı)"
                  style={{ background: '#071224', borderColor: '#1a3458', color: '#f1f5f9' }}
                />
              </Form.Item>

              <Form.Item
                label={<span style={{ color: '#94a3b8', fontSize: 12 }}>Kullanıcı Adı</span>}
                name="username"
                rules={[{ required: true, message: 'Kullanıcı adı zorunlu' }]}
              >
                <Input
                  placeholder="kullaniciadi"
                  style={{ background: '#071224', borderColor: '#1a3458', color: '#f1f5f9' }}
                />
              </Form.Item>

              <Form.Item
                label={<span style={{ color: '#94a3b8', fontSize: 12 }}>Şifre</span>}
                name="password"
                rules={[
                  { required: true, message: 'Şifre zorunlu' },
                  { min: 8, message: 'En az 8 karakter' },
                ]}
              >
                <Input.Password
                  placeholder="En az 8 karakter"
                  style={{ background: '#071224', borderColor: '#1a3458', color: '#f1f5f9' }}
                />
              </Form.Item>

              <Form.Item
                label={<span style={{ color: '#94a3b8', fontSize: 12 }}>Şifre Tekrar</span>}
                name="confirm"
                dependencies={['password']}
                rules={[
                  { required: true, message: 'Şifre tekrarı zorunlu' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('password') === value) return Promise.resolve()
                      return Promise.reject(new Error('Şifreler eşleşmiyor'))
                    },
                  }),
                ]}
              >
                <Input.Password
                  placeholder="Şifrenizi tekrar girin"
                  style={{ background: '#071224', borderColor: '#1a3458', color: '#f1f5f9' }}
                />
              </Form.Item>

              {errorMsg && (
                <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>{errorMsg}</div>
              )}

              <Button
                type="primary"
                block
                htmlType="submit"
                loading={submitting}
                size="large"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', border: 'none', height: 44 }}
              >
                Hesap Oluştur
              </Button>
            </Form>
          </>
        )}
      </div>
    </div>
  )
}
