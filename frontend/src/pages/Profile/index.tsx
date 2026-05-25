// Kişisel profil sayfası — her authenticated kullanıcı kendi bilgilerini
// görebilir, şifresini değiştirebilir ve MFA'sını yönetebilir.
//
// Önceki yapıda MFA ve şifre değiştirme sadece Settings içindeydi; Settings
// admin-only oldug˘u için viewer / location_admin kullanıcılar kendi MFA'sını
// yönetemiyor du. Profile sayfası izinden bağımsız (sadece authenticated).
//
// İçerik:
//   1) Kimlik kartı  — kullanıcı adı, ad soyad, email, organizasyon, rol
//   2) Lokasyonlar   — atanmış lokasyonlar + per-location rol
//   3) Şifre tab     — current + new + confirm (POST /users/me/change-password)
//   4) MFA tab       — mevcut <MfaTab /> reuse (TOTP enroll/disable/regenerate)

import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Alert, Button, Card, Form, Input, Space, Tabs, Tag, Tooltip, Typography, App } from 'antd'
import {
  UserOutlined, MailOutlined, EnvironmentOutlined, ApartmentOutlined,
  SafetyOutlined, KeyOutlined, LockOutlined, CrownOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { authApi } from '@/api/auth'
import { usersApi } from '@/api/users'
import MfaTab from '@/pages/Settings/MfaTab'
import { useAuthStore } from '@/store/auth'

const { Title, Text } = Typography

// ── 4-role display labels + accent colors ───────────────────────────────────
const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Süper Yönetici',
  org_admin: 'Organizasyon Yöneticisi',
  location_admin: 'Lokasyon Yöneticisi',
  viewer: 'Görüntüleyici',
  // legacy aliases that may still appear in old user rows
  admin: 'Yönetici',
  location_manager: 'Lokasyon Yöneticisi',
  location_operator: 'Lokasyon Operatörü',
  read_only: 'Salt Okunur',
}
function roleColor(r: string): string {
  if (r === 'super_admin') return '#a855f7'
  if (r === 'org_admin' || r === 'admin') return '#ef4444'
  if (r === 'location_admin' || r === 'location_manager' || r === 'location_operator') return '#f59e0b'
  return '#22c55e'
}
function roleHint(r: string): string {
  if (r === 'super_admin') return 'Tüm organizasyonlara erişim, sistem ayarları.'
  if (r === 'org_admin')   return 'Tüm organizasyon kaynaklarını yönetir.'
  if (r === 'location_admin') return 'Atanmış lokasyon(lar)da yazma yetkisi.'
  if (r === 'viewer') return 'Salt okunur — değişiklik yapamaz.'
  return ''
}

// ── Sub: Identity card ──────────────────────────────────────────────────────
function IdentityCard() {
  const { data: me, isLoading } = useQuery({
    queryKey: ['auth-me'],
    queryFn: () => authApi.me(),
  })

  if (isLoading || !me) {
    return <Card loading style={{ minHeight: 180 }} />
  }
  const role = me.system_role || me.role || 'viewer'
  const initials = (me.full_name || me.username).slice(0, 2).toUpperCase()

  return (
    <Card>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: roleColor(role) + '22',
          color: roleColor(role),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, fontWeight: 700, border: `2px solid ${roleColor(role)}55`,
        }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <Title level={4} style={{ margin: 0 }}>
            {me.full_name || me.username}
          </Title>
          <Text type="secondary" style={{ fontFamily: 'monospace' }}>@{me.username}</Text>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
            <span><MailOutlined /> {me.email || '—'}</span>
            {me.organization_name && (
              <span><ApartmentOutlined /> {me.organization_name}</span>
            )}
            {me.last_login && (
              <Tooltip title={dayjs(me.last_login).format('DD.MM.YYYY HH:mm:ss')}>
                <span>Son giriş: {dayjs(me.last_login).fromNow()}</span>
              </Tooltip>
            )}
          </div>
        </div>
        <Tooltip title={roleHint(role)}>
          <Tag
            icon={<CrownOutlined />}
            color={roleColor(role)}
            style={{ fontSize: 13, padding: '4px 10px' }}
          >
            {ROLE_LABEL[role] || role}
          </Tag>
        </Tooltip>
      </div>
    </Card>
  )
}

// ── Sub: Locations card ─────────────────────────────────────────────────────
function LocationsCard() {
  const { user } = useAuthStore()
  // String compare — eski 'admin' alias DB'de kalmış olabilir (M6 öncesi
  // yaratılmış kullanıcılar). Narrow type ile karşılaştırma uyumsuz olduğu
  // için string'e cast.
  const role = String(user?.system_role || user?.role || '')
  const isOrgWide = role === 'super_admin' || role === 'org_admin' || role === 'admin'

  const { data: locations = [], isLoading } = useQuery({
    queryKey: ['my-locations'],
    queryFn: () => usersApi.getMyLocations(),
    enabled: !isOrgWide,   // org-wide roller için endpoint boş döner; isteği atlama
  })

  return (
    <Card
      title={<><EnvironmentOutlined /> Yetkili Olduğunuz Lokasyonlar</>}
      size="small"
    >
      {isOrgWide ? (
        <Alert
          type="info" showIcon
          message="Organizasyon Geneli Yetki"
          description="Bu rolün belirli bir lokasyon kısıtlaması yok — organizasyondaki TÜM lokasyonlara erişiminiz var."
        />
      ) : isLoading ? (
        <Text type="secondary">Yükleniyor…</Text>
      ) : locations.length === 0 ? (
        <Alert
          type="warning" showIcon
          message="Henüz lokasyon ataması yok"
          description="Bir lokasyona erişiminiz olması için yöneticiniz size atama yapmalı."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {locations.map((l) => (
            <div key={l.location_id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px',
              border: '1px solid var(--border)', borderRadius: 8,
            }}>
              <EnvironmentOutlined style={{ color: 'var(--accent)' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{l.location_name}</div>
                {l.assigned_at && (
                  <div style={{ fontSize: 11, color: 'var(--fg-3)' }}>
                    Atanma: {dayjs(l.assigned_at).format('DD.MM.YYYY')}
                  </div>
                )}
              </div>
              <Tag color={l.loc_role === 'admin' ? 'red' : l.loc_role === 'operator' ? 'orange' : 'green'}>
                {l.loc_role === 'admin' ? 'Yönetici' : l.loc_role === 'operator' ? 'Operatör' : 'Görüntüleyici'}
              </Tag>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ── Sub: Change-password tab ────────────────────────────────────────────────
function PasswordTab() {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  const changeMutation = useMutation({
    mutationFn: (v: { current_password: string; new_password: string }) => usersApi.changePassword(v),
    onSuccess: () => {
      message.success('Şifreniz güncellendi')
      form.resetFields()
    },
    onError: (e: any) => {
      const detail = e?.response?.data?.detail || 'Şifre değiştirilemedi'
      message.error(detail)
    },
  })

  const onFinish = async (v: { current: string; new: string; confirm: string }) => {
    if (v.new !== v.confirm) { message.error('Yeni şifreler eşleşmiyor'); return }
    if (v.new.length < 8) { message.error('Yeni şifre en az 8 karakter olmalı'); return }
    if (v.new === v.current) { message.error('Yeni şifre eskisinden farklı olmalı'); return }
    setSubmitting(true)
    try {
      await changeMutation.mutateAsync({ current_password: v.current, new_password: v.new })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <Alert
        type="info" showIcon icon={<KeyOutlined />}
        message="Şifrenizi düzenli olarak güncelleyin"
        description="En az 8 karakter, harf + rakam karışımı önerilir. Şifrenizi başkalarıyla paylaşmayın."
        style={{ marginBottom: 16 }}
      />
      <Form layout="vertical" form={form} onFinish={onFinish}>
        <Form.Item name="current" label="Mevcut Şifre" rules={[{ required: true, message: 'Mevcut şifre gerekli' }]}>
          <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="new" label="Yeni Şifre" rules={[{ required: true, min: 8, message: 'En az 8 karakter' }]}>
          <Input.Password prefix={<KeyOutlined />} autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="confirm" label="Yeni Şifre (Tekrar)" rules={[{ required: true, message: 'Şifreyi tekrar girin' }]}>
          <Input.Password prefix={<KeyOutlined />} autoComplete="new-password" />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={submitting}>
            Şifreyi Değiştir
          </Button>
          <Button onClick={() => form.resetFields()} disabled={submitting}>
            Temizle
          </Button>
        </Space>
      </Form>
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function ProfilePage() {
  return (
    <div className="nm-page" style={{ padding: '4px 2px' }}>
      <div className="nm-page-hd">
        <div className="title-block">
          <div className="nm-crumbs"><span>Hesap</span><span>Profilim</span></div>
          <h1 className="nm-page-title">
            <UserOutlined /> Profilim
          </h1>
          <div className="nm-page-sub">
            Kişisel bilgileriniz, lokasyon yetkileri, şifre ve çok faktörlü doğrulama (MFA)
            yönetimi tek sayfada.
          </div>
        </div>
      </div>

      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <IdentityCard />
        <LocationsCard />

        <Card size="small" styles={{ body: { padding: 0 } }}>
          <Tabs
            defaultActiveKey="password"
            tabBarStyle={{ padding: '0 16px', marginBottom: 0 }}
            items={[
              {
                key: 'password',
                label: <Space><KeyOutlined />Şifre</Space>,
                children: <div style={{ padding: 16 }}><PasswordTab /></div>,
              },
              {
                key: 'mfa',
                label: <Space><SafetyOutlined />Çok Faktörlü Doğrulama</Space>,
                children: <div style={{ padding: 16 }}><MfaTab /></div>,
              },
            ]}
          />
        </Card>
      </Space>
    </div>
  )
}
