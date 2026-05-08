import { useState } from 'react'
import { ConfigProvider, Form, Input, Button, Alert, theme } from 'antd'
import { UserOutlined, LockOutlined, WifiOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { authApi } from '@/api/auth'
import { useAuthStore } from '@/store/auth'
import { useTranslation } from 'react-i18next'

const LOGIN_DARK = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#3b82f6',
    colorBgContainer: 'rgba(255,255,255,0.06)',
    colorBgElevated: '#1e293b',
    colorBorder: 'rgba(255,255,255,0.12)',
    colorText: '#f1f5f9',
    colorTextPlaceholder: '#64748b',
    borderRadius: 8,
  },
}

const LOGIN_CSS = `
  @keyframes loginGridMove {
    0%   { background-position: 0 0, 0 0; }
    100% { background-position: 50px 50px, 50px 50px; }
  }
  @keyframes loginOrbFloat {
    0%,100% { transform: translateY(0) scale(1); opacity: 0.8; }
    50%      { transform: translateY(-28px) scale(1.06); opacity: 1; }
  }
  @keyframes loginLogoGlow {
    0%,100% { box-shadow: 0 0 18px #3b82f660, 0 0 36px #1d4ed840; }
    50%      { box-shadow: 0 0 28px #3b82f6aa, 0 0 56px #1d4ed870; }
  }
  @keyframes loginCardIn {
    from { opacity: 0; transform: translateY(24px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0)   scale(1); }
  }
  @keyframes loginScan {
    0%   { top: -2px; opacity: 0.8; }
    100% { top: 100%; opacity: 0; }
  }
  .login-btn.ant-btn-primary {
    background: linear-gradient(90deg, #3b82f6, #1d4ed8) !important;
    border: none !important;
    box-shadow: 0 4px 20px #3b82f640 !important;
  }
  .login-btn.ant-btn-primary:hover {
    background: linear-gradient(90deg, #60a5fa, #3b82f6) !important;
    box-shadow: 0 6px 28px #3b82f680 !important;
  }
  .login-btn.ant-btn-primary:disabled {
    background: #1e3a5f !important;
  }
`

export default function LoginPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { setAuth } = useAuthStore()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true)
    setError('')
    try {
      const res = await authApi.login(values.username, values.password)
      setAuth(
        res.access_token,
        {
          id: res.user_id,
          username: res.username,
          role: res.role as any,
          system_role: (res.system_role as any) ?? 'member',
          tenant_id: res.tenant_id,
          org_id: res.org_id,
        },
        res.permissions,
      )
      navigate('/')
    } catch {
      setError(t('login.error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#050d1a',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <style>{LOGIN_CSS}</style>

      {/* Animated grid background */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: `
          linear-gradient(rgba(59,130,246,0.07) 1px, transparent 1px),
          linear-gradient(90deg, rgba(59,130,246,0.07) 1px, transparent 1px)
        `,
        backgroundSize: '50px 50px',
        animation: 'loginGridMove 10s linear infinite',
      }} />

      {/* Ambient glow orbs */}
      <div style={{
        position: 'absolute', top: '8%', left: '12%',
        width: 450, height: 450, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(59,130,246,0.14) 0%, transparent 70%)',
        animation: 'loginOrbFloat 9s ease-in-out infinite',
        pointerEvents: 'none', filter: 'blur(22px)',
      }} />
      <div style={{
        position: 'absolute', bottom: '12%', right: '8%',
        width: 320, height: 320, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(29,78,216,0.18) 0%, transparent 70%)',
        animation: 'loginOrbFloat 12s ease-in-out infinite reverse',
        pointerEvents: 'none', filter: 'blur(28px)',
      }} />
      <div style={{
        position: 'absolute', top: '45%', right: '22%',
        width: 220, height: 220, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)',
        animation: 'loginOrbFloat 15s ease-in-out infinite',
        pointerEvents: 'none', filter: 'blur(16px)',
      }} />

      {/* Glassmorphism card */}
      <div style={{
        position: 'relative',
        width: 400,
        background: 'rgba(10,17,32,0.88)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(59,130,246,0.22)',
        borderRadius: 18,
        padding: '44px 40px 36px',
        boxShadow: '0 8px 56px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.06)',
        animation: 'loginCardIn 0.55s cubic-bezier(0.22,1,0.36,1) both',
        overflow: 'hidden',
      }}>

        {/* Animated scan line */}
        <div style={{
          position: 'absolute', left: 0, right: 0, height: 2, zIndex: 10,
          background: 'linear-gradient(90deg, transparent 0%, #3b82f640 30%, #3b82f6aa 50%, #3b82f640 70%, transparent 100%)',
          animation: 'loginScan 4.5s linear infinite',
          pointerEvents: 'none',
        }} />

        <ConfigProvider theme={LOGIN_DARK}>
          {/* Logo + title */}
          <div style={{ textAlign: 'center', marginBottom: 36 }}>
            <div style={{
              width: 64, height: 64, borderRadius: 16,
              background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 18px',
              animation: 'loginLogoGlow 3s ease-in-out infinite',
            }}>
              <WifiOutlined style={{ color: '#fff', fontSize: 30 }} />
            </div>
            <div style={{ color: '#f1f5f9', fontWeight: 800, fontSize: 24, letterSpacing: 0.5, lineHeight: 1 }}>
              NetManager
            </div>
            <div style={{ color: '#475569', fontSize: 13, marginTop: 6 }}>
              {t('login.subtitle')}
            </div>
          </div>

          {error && (
            <Alert
              message={error}
              type="error"
              showIcon
              style={{ marginBottom: 20, background: '#3f0f0f', border: '1px solid #ef444440', borderRadius: 8 }}
            />
          )}

          <Form onFinish={onFinish} autoComplete="off" size="large">
            <Form.Item name="username" rules={[{ required: true, message: t('login.username_required') }]}>
              <Input
                prefix={<UserOutlined style={{ color: '#64748b' }} />}
                placeholder={t('login.username')}
                style={{ borderRadius: 8, height: 46 }}
              />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: t('login.password_required') }]}>
              <Input.Password
                prefix={<LockOutlined style={{ color: '#64748b' }} />}
                placeholder={t('login.password')}
                style={{ borderRadius: 8, height: 46 }}
              />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0, marginTop: 4 }}>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                block
                className="login-btn"
                style={{ height: 48, fontSize: 15, fontWeight: 700, borderRadius: 8 }}
              >
                {t('login.login_btn')}
              </Button>
            </Form.Item>
          </Form>
        </ConfigProvider>

        <div style={{ textAlign: 'center', marginTop: 24, color: '#1e3a5f', fontSize: 11, letterSpacing: 0.5 }}>
          NETWORK MANAGEMENT PLATFORM
        </div>
      </div>
    </div>
  )
}
