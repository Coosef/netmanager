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

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Card, Form, Input, Radio, Space, Tabs, Tag, Tooltip, Typography, App } from 'antd'
import {
  UserOutlined, MailOutlined, EnvironmentOutlined, ApartmentOutlined,
  SafetyOutlined, KeyOutlined, LockOutlined, CrownOutlined,
  GlobalOutlined, CheckCircleOutlined, WarningOutlined,
  TranslationOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
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

// ── Sub: IP Allowlist tab (T9 Tur 2 #4 follow-up) ──────────────────────────
function IpAllowlistTab() {
  const { message } = App.useApp()
  const [form] = Form.useForm()

  const { data: status, refetch } = useQuery({
    queryKey: ['my-login-ip'],
    queryFn: () => usersApi.getMyLoginIp(),
  })

  // Sync form with backend value the first time data loads.
  useState(() => {
    // no-op — Form.Item initialValue handles it via key on data change below.
  })

  const save = useMutation({
    mutationFn: (allowed_ips: string | null) => usersApi.updateMyAllowedIps(allowed_ips),
    onSuccess: () => {
      message.success('IP allowlist güncellendi')
      refetch()
    },
    onError: (e: any) => {
      message.error(e?.response?.data?.detail || 'Kaydedilemedi', 8)
    },
  })

  const currentIp = status?.client_ip || '—'
  const currentAllow = status?.allowed_ips || ''
  const matches = status?.matches_current_allowlist ?? true
  const isUnrestricted = !currentAllow.trim()

  return (
    <div style={{ maxWidth: 640 }}>
      <Alert
        type="info"
        showIcon
        icon={<GlobalOutlined />}
        message="Hangi IP'lerden giriş yapabileceğinizi siz belirleyin"
        description={
          <span>
            CSV formatında IP veya CIDR girin: <Text code>10.0.0.5</Text>,{' '}
            <Text code>192.168.1.0/24</Text>. Boş bırakırsanız her yerden giriş açıktır.
            <br />
            Kayıt sırasında mevcut IP'niz listede yoksa kabul edilmez (self-lockout koruması).
          </span>
        }
        style={{ marginBottom: 16 }}
      />

      {/* Current IP card */}
      <Card
        size="small"
        style={{ marginBottom: 16, background: 'var(--bg-2)' }}
        title={<><GlobalOutlined /> Şu Anki Bağlantı</>}
      >
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text type="secondary">IP:</Text>
            <Text code style={{ fontSize: 14, fontWeight: 600 }}>{currentIp}</Text>
            <Tooltip title="Bu satırı kopyalayıp aşağıdaki kutuya yapıştırabilirsiniz">
              <Button
                size="small" type="link"
                onClick={() => {
                  if (status?.client_ip) {
                    navigator.clipboard?.writeText(status.client_ip)
                    message.info('Kopyalandı')
                  }
                }}
              >
                Kopyala
              </Button>
            </Tooltip>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text type="secondary">Mevcut durum:</Text>
            {isUnrestricted ? (
              <Tag>Kısıt yok — her yerden giriş açık</Tag>
            ) : matches ? (
              <Tag color="green" icon={<CheckCircleOutlined />}>Bu IP listede</Tag>
            ) : (
              <Tag color="red" icon={<WarningOutlined />}>Bu IP listede DEĞİL</Tag>
            )}
          </div>
        </Space>
      </Card>

      <Form
        layout="vertical"
        form={form}
        key={status?.allowed_ips ?? '__unset__'}
        initialValues={{ allowed_ips: currentAllow }}
        onFinish={(v: { allowed_ips: string }) => {
          const csv = (v.allowed_ips || '').trim()
          save.mutate(csv || null)
        }}
      >
        <Form.Item
          name="allowed_ips"
          label="İzinli IP / CIDR Listesi (CSV)"
          help="Örnek: 10.0.0.0/8, 192.168.1.5, 78.135.0.0/16"
        >
          <Input.TextArea
            rows={4}
            placeholder="Boş bırak = kısıt yok"
            allowClear
          />
        </Form.Item>
        <Space>
          <Button
            type="primary" htmlType="submit" loading={save.isPending}
            icon={<SafetyOutlined />}
          >
            Kaydet
          </Button>
          <Button
            onClick={() => {
              if (!status?.client_ip) return
              const cur = (form.getFieldValue('allowed_ips') || '').trim()
              const next = cur ? `${cur}, ${status.client_ip}` : status.client_ip
              form.setFieldValue('allowed_ips', next)
            }}
            disabled={!status?.client_ip}
          >
            Mevcut IP'mi Ekle
          </Button>
          <Button
            danger
            onClick={() => {
              form.setFieldValue('allowed_ips', '')
              save.mutate(null)
            }}
            loading={save.isPending}
          >
            Kısıtı Kaldır (Hepsine Aç)
          </Button>
        </Space>
      </Form>
    </div>
  )
}


// ── Sub: Language tab ────────────────────────────────────────────────────────
//
// System Language / Sistem Dili — server-persisted user-preferred locale.
// Lives next to Password / MFA / IP Allowlist because it is, like those, a
// per-user preference that has to survive across devices.
//
// The runtime fallback chain (no preference → org default → browser →
// 'tr') is documented at backend `app.models.user.User.preferred_language`.
// This tab only handles the explicit-preference layer.

const LANGUAGE_OPTIONS: { code: string; label: string; native: string }[] = [
  { code: 'tr', label: 'Türkçe',  native: 'Türkçe'   },
  { code: 'en', label: 'English', native: 'English'  },
  { code: 'de', label: 'Deutsch', native: 'Deutsch'  },
  { code: 'ru', label: 'Русский', native: 'Русский'  },
]

function LanguageTab() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const { message } = App.useApp()

  // Initial fetch — server-side preference is the source of truth.
  const { data: prefs, isLoading } = useQuery({
    queryKey: ['users-me-preferences'],
    queryFn: () => usersApi.getMyPreferences(),
  })

  // Local working copy so we can rollback on backend failure without
  // touching the global runtime.
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => {
    if (prefs !== undefined) setDraft(prefs.preferred_language ?? i18n.language)
  }, [prefs, i18n.language])

  const previousRuntime = i18n.language

  const updateMut = useMutation({
    mutationFn: (code: string | null) => usersApi.updateMyPreferences(code),
    onSuccess: (saved) => {
      const code = saved.preferred_language
      // Apply runtime change ONLY after the backend persists. If the
      // backend response carries NULL (cleared preference), keep the
      // current runtime — the next page load picks up the fallback
      // chain.
      if (code) {
        i18n.changeLanguage(code)
      }
      queryClient.invalidateQueries({ queryKey: ['users-me-preferences'] })
      message.success(t('profile.language_save_success', 'Dil tercihiniz kaydedildi.'))
    },
    onError: () => {
      // Backend rejected the change — revert the runtime so the UI
      // does not show a language the server doesn't agree with.
      i18n.changeLanguage(previousRuntime)
      setDraft(prefs?.preferred_language ?? previousRuntime)
      message.error(t('profile.language_save_failed', 'Dil tercihi kaydedilemedi. Lütfen tekrar deneyin.'))
    },
  })

  const dirty = draft !== null && draft !== (prefs?.preferred_language ?? previousRuntime)

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }} data-testid="profile-language-tab">
      <div>
        <Title level={5} style={{ marginBottom: 4 }}>
          <TranslationOutlined style={{ marginRight: 8 }} />
          {t('profile.language_title', 'Sistem Dili')}
        </Title>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t(
            'profile.language_helper',
            'Menüler ve sistem metinleri seçtiğiniz dilde gösterilir. Tercih hesabınıza bağlanır ve diğer cihazlarda da geçerli olur.',
          )}
        </Text>
      </div>

      <Radio.Group
        value={draft ?? i18n.language}
        onChange={(e) => setDraft(e.target.value)}
        disabled={isLoading || updateMut.isPending}
        data-testid="profile-language-radio-group"
      >
        <Space direction="vertical">
          {LANGUAGE_OPTIONS.map((opt) => (
            <Radio key={opt.code} value={opt.code} data-testid={`profile-language-${opt.code}`}>
              <Space>
                <span>{opt.native}</span>
                <Text type="secondary" style={{ fontSize: 11 }}>({opt.code})</Text>
              </Space>
            </Radio>
          ))}
        </Space>
      </Radio.Group>

      <Space>
        <Button
          type="primary"
          loading={updateMut.isPending}
          disabled={!dirty}
          onClick={() => updateMut.mutate(draft)}
          data-testid="profile-language-save"
        >
          {t('common.save', 'Kaydet')}
        </Button>
        {prefs?.preferred_language && (
          <Button
            onClick={() => {
              setDraft(null)
              updateMut.mutate(null)
            }}
            disabled={updateMut.isPending}
            data-testid="profile-language-clear"
          >
            {t('profile.language_clear', 'Tercihi temizle')}
          </Button>
        )}
      </Space>

      {prefs?.preferred_language && (
        <Alert
          type="info"
          showIcon
          message={t(
            'profile.language_current_persisted',
            'Sunucuda kayıtlı tercih: {{code}}',
            { code: prefs.preferred_language },
          )}
        />
      )}
    </Space>
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
              {
                key: 'ip-allowlist',
                label: <Space><GlobalOutlined />IP Allowlist</Space>,
                children: <div style={{ padding: 16 }}><IpAllowlistTab /></div>,
              },
              {
                key: 'language',
                label: <Space><TranslationOutlined />Sistem Dili</Space>,
                children: <div style={{ padding: 16 }}><LanguageTab /></div>,
              },
            ]}
          />
        </Card>
      </Space>
    </div>
  )
}
