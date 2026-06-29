import { useState, useEffect } from 'react'
import { App, Dropdown, Avatar, Space, Input, Tooltip, Typography, Popover, Button, Tag, Empty, Modal, Form } from 'antd'
import {
  LogoutOutlined, KeyOutlined, UserOutlined,
  BellOutlined, ReloadOutlined, SearchOutlined,
  SunOutlined, MoonOutlined, CheckOutlined,
  WarningOutlined, CloseCircleOutlined, InfoCircleOutlined,
  MenuOutlined,
  SoundOutlined, NotificationOutlined, FullscreenOutlined, SettingOutlined,
} from '@ant-design/icons'
import CustomizePanel from '@/components/CustomizePanel'
import { useLocation, useNavigate } from 'react-router-dom'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useAuthStore } from '@/store/auth'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { monitorApi } from '@/api/monitor'
import { usersApi } from '@/api/users'
import { useTheme } from '@/contexts/ThemeContext'
import { useCustomize } from '@/contexts/CustomizeContext'
import LocationSelector from './LocationSelector'
import OrganizationSelector from './OrganizationSelector'
import OrgBadge from './OrgBadge'
import AIAssistantButton from './AIAssistantButton'
import { detectPanelMode } from '@/utils/panelMode'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'


const ROLE_COLORS: Record<string, string> = {
  super_admin: '#ef4444', admin: '#f97316', operator: '#3b82f6', viewer: '#22c55e',
}

const HEADER_CSS = `
  @keyframes bellRing {
    0%,55%,100% { transform: rotate(0deg); }
    10%          { transform: rotate(16deg); }
    20%          { transform: rotate(-14deg); }
    30%          { transform: rotate(10deg); }
    40%          { transform: rotate(-8deg); }
    50%          { transform: rotate(0deg); }
  }
`

export default function AppHeader({ onOpenSearch, onOpenMobileNav }: { onOpenSearch?: () => void; onOpenMobileNav?: () => void }) {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const { isDark, toggle } = useTheme()
  const { message } = App.useApp()
  const { t, i18n } = useTranslation()
  const isMobile = useIsMobile()
  const { soundEnabled, setSoundEnabled, applyLayout } = useCustomize()

  // PR-A — panelMode-aware header. The tenant-context widgets switch by
  // surface:
  //   - platform   → no LocationSelector, no OrganizationSelector
  //                  (super-admin operates ABOVE every tenant).
  //   - operations → OrgBadge (URL-authoritative; role-aware dropdown)
  //                  + LocationSelector scoped to the URL org. NO
  //                  OrganizationSelector — URL is authoritative.
  //   - legacy     → existing OrganizationSelector + LocationSelector.
  const panelMode = detectPanelMode(location.pathname)

  const [notifOpen, setNotifOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [pwModalOpen, setPwModalOpen] = useState(false)
  const [pwForm] = Form.useForm()

  // Active role tab — applyLayout id (preset id'leri CustomizeContext'te:
  // operator/admin/exec/wall). Default 'operator' (en yaygın view).
  const [roleTab, setRoleTab] = useState<'operator' | 'admin' | 'exec' | 'wall'>(() => {
    return (localStorage.getItem('nm-role-tab') as any) || 'operator'
  })
  const setRole = (id: 'operator' | 'admin' | 'exec' | 'wall') => {
    setRoleTab(id); localStorage.setItem('nm-role-tab', id)
    applyLayout(id)
  }

  // Clock — saniye bazlı tick.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  // Fullscreen toggle
  const goFullscreen = () => {
    try {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen()
      else document.exitFullscreen()
    } catch { /* no-op */ }
  }

  const changePasswordMutation = useMutation({
    mutationFn: (data: { current_password: string; new_password: string }) => usersApi.changePassword(data),
    onSuccess: () => {
      message.success(t('header.password_changed'))
      setPwModalOpen(false)
      pwForm.resetFields()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('header.password_change_error')),
  })

  // Inline header search kaldırıldı — artık ⌘K palette (CommandPalette)
  // arama görevini üstleniyor (cihaz/nav/aksiyon hepsi orada).

  const { data: stats } = useQuery({
    queryKey: ['monitor-stats'],
    queryFn: () => monitorApi.getStats(),
    refetchInterval: 30000,
  })

  const { data: recentEvents, refetch: refetchEvents } = useQuery({
    queryKey: ['header-recent-events'],
    queryFn: () => monitorApi.getEvents({ limit: 15, hours: 24, unacked_only: true }),
    enabled: notifOpen,
    staleTime: 30_000,
  })

  const ackAllMutation = useMutation({
    mutationFn: monitorApi.acknowledgeAll,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-stats'] })
      qc.invalidateQueries({ queryKey: ['header-recent-events'] })
      message.success(t('header.all_marked_read'))
    },
  })

  const ackOneMutation = useMutation({
    mutationFn: (id: number) => monitorApi.acknowledge(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor-stats'] })
      refetchEvents()
    },
  })

  const unacked = stats?.events_24h.unacknowledged ?? 0

  const handleLogout = () => {
    logout()
    navigate('/login')
    message.success(t('header.logout_success'))
  }

  const menuItems = [
    {
      key: 'info', label: (
        <span style={{ fontSize: 12 }}>
          {user?.username} · {user?.role}
        </span>
      ), disabled: true,
    },
    { type: 'divider' as const },
    // T8.4 — Profil sayfası: kimlik bilgileri, lokasyonlar, şifre + MFA tek
    // sayfada. Eski "Şifre Değiştir" modal kısayolu da korunuyor (hızlı
    // erişim için), MFA yönetimi sadece Profile sayfasında.
    { key: 'profile', icon: <UserOutlined />, label: t('header.profile'), onClick: () => navigate('/profile') },
    { key: 'change-password', icon: <KeyOutlined />, label: t('header.change_password'), onClick: () => { pwForm.resetFields(); setPwModalOpen(true) } },
    { type: 'divider' as const },
    { key: 'logout', icon: <LogoutOutlined />, label: t('header.logout'), danger: true, onClick: handleLogout },
  ]

  const iconColor = isDark ? '#64748b' : '#94a3b8'
  const textColor = isDark ? '#d7e6f5' : '#1e293b'
  const subColor = isDark ? '#64748b' : '#94a3b8'
  const notifBg = isDark ? '#0e1729' : '#ffffff'
  const notifBorder = isDark ? '#1c2538' : '#e2e8f0'
  const notifItemHover = isDark ? '#070b18' : '#f8fafc'

  const sevIcon = (s: string) => {
    if (s === 'critical') return <CloseCircleOutlined style={{ color: '#ef4444' }} />
    if (s === 'warning') return <WarningOutlined style={{ color: '#f59e0b' }} />
    return <InfoCircleOutlined style={{ color: '#3b82f6' }} />
  }

  const notifContent = (
    <div style={{ width: '100%', background: notifBg }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${notifBorder}` }}>
        <Typography.Text style={{ fontWeight: 700, fontSize: 14, color: textColor }}>
          {t('header.notifications')} {unacked > 0 && <Tag color="orange" style={{ fontSize: 11, marginLeft: 4 }}>{unacked}</Tag>}
        </Typography.Text>
        <Space size={8}>
          {unacked > 0 && (
            <Button
              size="small" type="text"
              icon={<CheckOutlined />}
              loading={ackAllMutation.isPending}
              onClick={() => ackAllMutation.mutate()}
              style={{ fontSize: 12, color: subColor }}
            >
              {t('header.mark_all_read')}
            </Button>
          )}
        </Space>
      </div>

      {/* Event list */}
      <div style={{ maxHeight: 380, overflowY: 'auto' }}>
        {(!recentEvents?.items || recentEvents.items.length === 0) ? (
          <Empty description={t('header.no_notifications')} image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: '24px 0' }} />
        ) : (
          recentEvents.items.map((ev) => (
            <div
              key={ev.id}
              style={{
                padding: '10px 16px',
                borderBottom: `1px solid ${notifBorder}`,
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                cursor: 'default',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = notifItemHover }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span style={{ fontSize: 16, marginTop: 2, flexShrink: 0 }}>{sevIcon(ev.severity)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: textColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {ev.title}
                </div>
                {ev.device_hostname && (
                  <div style={{ fontSize: 11, color: subColor }}>{ev.device_hostname}</div>
                )}
                <div style={{ fontSize: 11, color: subColor, marginTop: 2 }}>{dayjs(ev.created_at).fromNow()}</div>
              </div>
              <Button
                size="small" type="text"
                icon={<CheckOutlined />}
                loading={ackOneMutation.isPending}
                onClick={() => ackOneMutation.mutate(ev.id)}
                style={{ color: subColor, flexShrink: 0 }}
              />
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 16px', borderTop: `1px solid ${notifBorder}`, textAlign: 'center' }}>
        <Button
          type="link" size="small"
          onClick={() => { setNotifOpen(false); navigate('/monitor') }}
          style={{ fontSize: 12 }}
        >
          {t('header.view_all_events')}
        </Button>
      </div>
    </div>
  )

  return (
    <>
    <Modal
      open={pwModalOpen}
      onCancel={() => { setPwModalOpen(false); pwForm.resetFields() }}
      title={t('header.change_password')}
      footer={null}
    >
      <Form
        form={pwForm}
        layout="vertical"
        onFinish={(v) => changePasswordMutation.mutate({ current_password: v.current_password, new_password: v.new_password })}
      >
        <Form.Item label={t('header.current_password')} name="current_password" rules={[{ required: true }]}>
          <Input.Password />
        </Form.Item>
        <Form.Item label={t('header.new_password')} name="new_password" rules={[{ required: true, min: 8, message: t('header.password_min_length') }]}>
          <Input.Password />
        </Form.Item>
        <Form.Item
          label={t('header.new_password_confirm')}
          name="confirm"
          dependencies={['new_password']}
          rules={[
            { required: true },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                return Promise.reject(t('header.passwords_mismatch'))
              },
            }),
          ]}
        >
          <Input.Password />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" block loading={changePasswordMutation.isPending} icon={<KeyOutlined />}>
            {t('header.change_password_btn')}
          </Button>
        </Form.Item>
      </Form>
    </Modal>
    <div className="nm-topbar" style={{ position: 'relative', zIndex: 100 }}>
      <style>{HEADER_CSS}</style>

      {/* Hamburger — mobile only */}
      {isMobile && (
        <Button
          type="text"
          icon={<MenuOutlined style={{ fontSize: 18, color: iconColor }} />}
          onClick={onOpenMobileNav}
          style={{ marginRight: 4, padding: '0 8px' }}
        />
      )}

      {/* Role tabs — NOC / Admin / Yönetici (mockup nm-tabs). Tıklayınca
          ilgili preset layout uygulanıyor (Operatör/Admin/Yönetici/NOC Duvarı). */}
      {!isMobile && (
        <div className="nm-tabs">
          {[
            { id: 'operator' as const, label: t('header.role_noc') },
            { id: 'admin' as const,    label: t('header.role_admin') },
            { id: 'exec' as const,     label: t('header.role_exec') },
          ].map((tab) => (
            <div key={tab.id}
              className={`nm-tab ${roleTab === tab.id ? 'active' : ''}`}
              onClick={() => setRole(tab.id)}>
              <span className="dot"></span>
              {tab.label}
            </div>
          ))}
        </div>
      )}

      {/* PR-A — panelMode-aware tenant context widgets.
          - legacy     → existing OrganizationSelector + LocationSelector
          - operations → OrgBadge (URL-authoritative) + LocationSelector
          - platform   → none (super-admin operates ABOVE every tenant) */}
      {panelMode === 'legacy' && <OrganizationSelector />}
      {panelMode === 'operations' && <OrgBadge />}
      {panelMode !== 'platform' && <LocationSelector isMobile={isMobile} />}

      {/* Search — mockup nm-search: tıklanınca ⌘K palette açar */}
      {!isMobile ? (
        <div className="nm-search" onClick={onOpenSearch}
          style={{ cursor: 'pointer', flex: '0 1 360px' }}>
          <SearchOutlined style={{ fontSize: 12, color: 'var(--fg-3)' }} />
          <span style={{ color: 'var(--fg-3)', fontSize: 13 }}>
            {t('header.search_placeholder')}
          </span>
          <kbd>⌘K</kbd>
        </div>
      ) : (
        <Tooltip title={t('header.search_placeholder')}>
          <Button
            type="text"
            icon={<SearchOutlined style={{ color: iconColor, fontSize: 16 }} />}
            onClick={onOpenSearch}
            style={{ padding: '0 8px' }}
          />
        </Tooltip>
      )}

      {/* Clock — mockup nm-clock (HH:MM:SS + DD MMM CMT) */}
      {!isMobile && (
        <div className="nm-clock">
          {/* LANG-INFRA: BCP47 yerine i18n.language; dil değişiminde otomatik takip eder. */}
          <span>{now.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          <small>{now.toLocaleDateString(i18n.language, { day: '2-digit', month: 'short' }).toUpperCase()}{' '}
            {Intl.DateTimeFormat(i18n.language, { timeZoneName: 'short' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value || ''}</small>
        </div>
      )}

      {/* Özelleştir — mockup nm-customize-btn (mint accent button) */}
      <button className={`nm-customize-btn ${customizeOpen ? 'active' : ''}`}
        onClick={() => setCustomizeOpen(true)}>
        <SettingOutlined style={{ fontSize: 13 }} />
        <span>{t('header.customize_btn')}</span>
      </button>
      <CustomizePanel open={customizeOpen} onClose={() => setCustomizeOpen(false)} />

      {/* Sağ ikon grubu: theme / sound / refresh / bell / fullscreen / avatar */}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <Tooltip title={isDark ? t('header.theme_light') : t('header.theme_dark')}>
          <span className="nm-iconbtn" onClick={toggle}>
            {isDark
              ? <SunOutlined style={{ fontSize: 14, color: '#f59e0b' }} />
              : <MoonOutlined style={{ fontSize: 14 }} />}
          </span>
        </Tooltip>

        <Tooltip title={soundEnabled ? t('header.sound_on') : t('header.sound_off')}>
          <span className="nm-iconbtn" onClick={() => setSoundEnabled(!soundEnabled)}
            style={soundEnabled ? { color: 'var(--accent)' } : undefined}>
            {soundEnabled ? <NotificationOutlined style={{ fontSize: 14 }} /> : <SoundOutlined style={{ fontSize: 14 }} />}
          </span>
        </Tooltip>

        {!isMobile && (
          <Tooltip title={t('header.refresh_data')}>
            <span className="nm-iconbtn"
              onClick={() => { qc.invalidateQueries(); message.info(t('header.refreshed')) }}>
              <ReloadOutlined style={{ fontSize: 14 }} />
            </span>
          </Tooltip>
        )}

        {/* Global AI Assistant entry — permission-gated to org_admin+.
            Sits next to Notifications so the icon density matches the
            existing nm-iconbtn rhythm in mobile + desktop layouts. */}
        <AIAssistantButton />

        <Popover
          content={notifContent}
          trigger="click"
          open={notifOpen}
          onOpenChange={setNotifOpen}
          placement="bottomRight"
          arrow={false}
          overlayInnerStyle={{ padding: 0, borderRadius: 10, overflow: 'hidden', width: isMobile ? 'calc(100vw - 16px)' : 360, maxWidth: 360 }}
        >
          <span className="nm-iconbtn" title={t('header.notifications')}>
            <BellOutlined style={{
              fontSize: 14,
              color: unacked > 0 ? '#f97316' : undefined,
              animation: unacked > 0 ? 'bellRing 3s ease-in-out 1s infinite' : undefined,
            }} />
            {unacked > 0 && <span className="pip"></span>}
          </span>
        </Popover>

        <Tooltip title={t('header.fullscreen')}>
          <span className="nm-iconbtn" onClick={goFullscreen}>
            <FullscreenOutlined style={{ fontSize: 14 }} />
          </span>
        </Tooltip>

        <Dropdown menu={{ items: menuItems }} placement="bottomRight" trigger={['click']}>
          <span style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 4 }}>
            <Avatar size={28} style={{ background: ROLE_COLORS[user?.role || 'viewer'], fontSize: 12, flexShrink: 0 }}>
              {user?.username?.[0]?.toUpperCase()}
            </Avatar>
            {!isMobile && <div style={{ lineHeight: 1.1 }}>
              <Typography.Text style={{ color: textColor, fontSize: 12, fontWeight: 600, display: 'block' }}>
                {user?.username}
              </Typography.Text>
              <Typography.Text style={{ color: subColor, fontSize: 10, display: 'block' }}>
                {user?.role}
              </Typography.Text>
            </div>}
          </span>
        </Dropdown>
      </div>
    </div>
    </>
  )
}
