import { useState, useRef } from 'react'
import { App, Layout, Dropdown, Avatar, Space, Badge, Input, Tooltip, Typography, Popover, Button, Tag, Empty, Spin, Select, Modal, Form } from 'antd'
import {
  LogoutOutlined, KeyOutlined,
  BellOutlined, ReloadOutlined, SearchOutlined,
  SunOutlined, MoonOutlined, CheckOutlined,
  WarningOutlined, CloseCircleOutlined, InfoCircleOutlined,
  LaptopOutlined, MenuOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useAuthStore } from '@/store/auth'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { monitorApi } from '@/api/monitor'
import { devicesApi } from '@/api/devices'
import { usersApi } from '@/api/users'
import { useTheme } from '@/contexts/ThemeContext'
import { useSite } from '@/contexts/SiteContext'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'

const { Header } = Layout

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
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const { isDark, toggle } = useTheme()
  const { activeSite, setSite, locations, sitesLoading } = useSite()
  const activeLocation = locations.find((l) => l.name === activeSite)
  const { message } = App.useApp()
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  const [notifOpen, setNotifOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const [pwModalOpen, setPwModalOpen] = useState(false)
  const [pwForm] = Form.useForm()

  const changePasswordMutation = useMutation({
    mutationFn: (data: { current_password: string; new_password: string }) => usersApi.changePassword(data),
    onSuccess: () => {
      message.success(t('header.password_changed'))
      setPwModalOpen(false)
      pwForm.resetFields()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || t('header.password_change_error')),
  })

  const { data: searchResults, isFetching: searchFetching } = useQuery({
    queryKey: ['header-search', search],
    queryFn: () => devicesApi.list({ search: search.trim(), limit: 8 }),
    enabled: search.trim().length >= 2,
    staleTime: 10_000,
  })

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
    { key: 'change-password', icon: <KeyOutlined />, label: t('header.change_password'), onClick: () => { pwForm.resetFields(); setPwModalOpen(true) } },
    { type: 'divider' as const },
    { key: 'logout', icon: <LogoutOutlined />, label: t('header.logout'), danger: true, onClick: handleLogout },
  ]

  const headerBg = isDark ? 'rgba(3,12,30,0.92)' : '#ffffff'
  const headerBorder = isDark ? '#112240' : '#e2e8f0'
  const iconColor = isDark ? '#64748b' : '#94a3b8'
  const textColor = isDark ? '#f1f5f9' : '#1e293b'
  const subColor = isDark ? '#64748b' : '#94a3b8'
  const inputBg = isDark ? '#0e1e38' : '#f8fafc'
  const inputBorder = isDark ? '#1a3458' : '#e2e8f0'
  const notifBg = isDark ? '#0e1e38' : '#ffffff'
  const notifBorder = isDark ? '#1a3458' : '#e2e8f0'
  const notifItemHover = isDark ? '#030c1e' : '#f8fafc'

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
    <Header style={{
      background: headerBg,
      backdropFilter: isDark ? 'blur(12px)' : undefined,
      WebkitBackdropFilter: isDark ? 'blur(12px)' : undefined,
      padding: '0 24px',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      borderBottom: `1px solid ${headerBorder}`,
      height: 60,
      position: 'sticky',
      top: 0,
      zIndex: 100,
      boxShadow: isDark
        ? '0 1px 0 #112240, 0 4px 24px rgba(0,0,0,0.5)'
        : '0 1px 4px rgba(0,0,0,0.06)',
    }}>
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

      <div style={{ flex: 1 }} />

      {/* Location selector — mobile compact dropdown */}
      {isMobile && locations.length > 0 && (
        <Dropdown
          trigger={['click']}
          placement="bottomLeft"
          menu={{
            selectedKeys: activeSite ? [activeSite] : ['__all__'],
            items: [
              {
                key: '__all__',
                label: 'Tüm Lokasyonlar',
                onClick: () => { setSite(null); qc.invalidateQueries() },
              },
              ...locations.map((loc) => ({
                key: loc.name,
                label: (
                  <Space size={6}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: loc.color || '#3b82f6', display: 'inline-block' }} />
                    {loc.name}
                  </Space>
                ),
                onClick: () => { setSite(loc.name); qc.invalidateQueries() },
              })),
            ],
          }}
        >
          <Button type="text" style={{ padding: '0 6px' }}>
            <Space size={4}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: activeLocation?.color || (activeSite ? '#38bdf8' : iconColor),
                flexShrink: 0,
              }} />
              {activeSite && (
                <span style={{ fontSize: 11, color: '#38bdf8', maxWidth: 56, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeSite}
                </span>
              )}
            </Space>
          </Button>
        </Dropdown>
      )}

      {/* Location selector — hidden on mobile */}
      {!isMobile && (
        <Space size={6}>
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            background: activeLocation?.color || (activeSite ? '#38bdf8' : iconColor),
            flexShrink: 0,
          }} />
          <Select
            value={activeSite ?? '__all__'}
            onChange={(v) => {
              const next = v === '__all__' ? null : v
              setSite(next)
              qc.invalidateQueries()
            }}
            loading={sitesLoading}
            size="small"
            style={{
              width: 160,
              background: activeSite ? (isDark ? '#0c2040' : '#e0f0ff') : 'transparent',
              borderRadius: 6,
            }}
            popupMatchSelectWidth={false}
            variant="borderless"
          >
            <Select.Option value="__all__">Tüm Lokasyonlar</Select.Option>
            {locations.map((loc) => (
              <Select.Option key={loc.name} value={loc.name}>
                <Space size={6}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: loc.color || '#3b82f6', flexShrink: 0, display: 'inline-block' }} />
                  {loc.name}
                </Space>
              </Select.Option>
            ))}
          </Select>
        </Space>
      )}

      {/* Search — mobile shows icon button only, desktop shows full input */}
      {isMobile ? (
        <Tooltip title={t('header.search_placeholder')}>
          <Button
            type="text"
            icon={<SearchOutlined style={{ color: iconColor, fontSize: 16 }} />}
            onClick={onOpenSearch}
            style={{ padding: '0 8px' }}
          />
        </Tooltip>
      ) : null}

      {/* Theme toggle — always visible */}
      <Tooltip title={isDark ? t('header.theme_light') : t('header.theme_dark')}>
        <Button
          type="text"
          icon={isDark
            ? <SunOutlined style={{ color: '#f59e0b', fontSize: 16 }} />
            : <MoonOutlined style={{ color: iconColor, fontSize: 16 }} />
          }
          onClick={toggle}
          style={{ padding: '0 8px' }}
        />
      </Tooltip>

      {!isMobile && <Popover
        open={searchOpen && search.trim().length >= 2}
        onOpenChange={(v) => { if (!v) setSearchOpen(false) }}
        placement="bottomLeft"
        arrow={false}
        overlayInnerStyle={{ padding: 0, borderRadius: 10, overflow: 'hidden', width: 340 }}
        content={
          <div ref={searchRef}>
            {searchFetching ? (
              <div style={{ padding: '20px', textAlign: 'center' }}><Spin size="small" /></div>
            ) : !searchResults?.items?.length ? (
              <div style={{ padding: '14px 16px', color: subColor, fontSize: 13 }}>{t('header.search_no_results')}</div>
            ) : (
              <div>
                <div style={{ padding: '8px 14px 4px', fontSize: 11, fontWeight: 600, color: subColor, letterSpacing: '0.06em' }}>
                  {t('header.search_devices')}
                </div>
                {searchResults.items.map((d) => (
                  <div
                    key={d.id}
                    onClick={() => { navigate(`/devices?search=${encodeURIComponent(d.hostname)}`); setSearch(''); setSearchOpen(false) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 14px', cursor: 'pointer',
                      borderTop: `1px solid ${notifBorder}`,
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = notifItemHover }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                  >
                    <LaptopOutlined style={{ color: d.status === 'online' ? '#22c55e' : d.status === 'offline' ? '#ef4444' : '#94a3b8', fontSize: 14 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: textColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.hostname}</div>
                      <div style={{ fontSize: 11, color: subColor }}>{d.ip_address}{d.vendor ? ` · ${d.vendor}` : ''}</div>
                    </div>
                    <Tag style={{ fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}
                      color={d.status === 'online' ? 'green' : d.status === 'offline' ? 'red' : 'default'}>
                      {d.status}
                    </Tag>
                  </div>
                ))}
                <div style={{ padding: '8px 14px', borderTop: `1px solid ${notifBorder}`, textAlign: 'center' }}>
                  <Button type="link" size="small" style={{ fontSize: 12 }}
                    onClick={() => { navigate(`/devices?search=${encodeURIComponent(search.trim())}`); setSearch(''); setSearchOpen(false) }}>
                    "{search.trim()}" için tüm sonuçları göster →
                  </Button>
                </div>
              </div>
            )}
          </div>
        }
      >
        <Input
          prefix={<SearchOutlined style={{ color: iconColor }} />}
          placeholder={t('header.search_placeholder')}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setSearchOpen(true) }}
          onPressEnter={() => {
            if (search.trim()) {
              navigate(`/devices?search=${encodeURIComponent(search.trim())}`)
              setSearch('')
              setSearchOpen(false)
            }
          }}
          onFocus={(e) => {
            setSearchOpen(true)
            if (!search.trim() && onOpenSearch) {
              e.target.blur()
              onOpenSearch()
            }
          }}
          style={{ width: 260, background: inputBg, border: `1px solid ${inputBorder}`, borderRadius: 8 }}
          size="small"
          allowClear
          onClear={() => setSearchOpen(false)}
          suffix={
            !search ? (
              <Tag style={{ fontSize: 10, margin: 0, padding: '0 4px', color: iconColor, borderColor: inputBorder, background: 'transparent' }}>
                ⌘K
              </Tag>
            ) : undefined
          }
        />
      </Popover>}


      {!isMobile && (
        <Tooltip title={t('header.refresh_data')}>
          <ReloadOutlined
            style={{ color: iconColor, fontSize: 16, cursor: 'pointer' }}
            onClick={() => { qc.invalidateQueries(); message.info(t('header.refreshed')) }}
          />
        </Tooltip>
      )}

      <Popover
        content={notifContent}
        trigger="click"
        open={notifOpen}
        onOpenChange={setNotifOpen}
        placement="bottomRight"
        arrow={false}
        overlayInnerStyle={{ padding: 0, borderRadius: 10, overflow: 'hidden', width: isMobile ? 'calc(100vw - 16px)' : 360, maxWidth: 360 }}
      >
        <Badge count={unacked} size="small" overflowCount={99}>
          <BellOutlined
            style={{
              color: unacked > 0 ? '#f97316' : iconColor,
              fontSize: 18,
              cursor: 'pointer',
              display: 'inline-block',
              animation: unacked > 0 ? 'bellRing 3s ease-in-out 1s infinite' : undefined,
            }}
          />
        </Badge>
      </Popover>

      <Dropdown menu={{ items: menuItems }} placement="bottomRight" trigger={['click']}>
        <Space style={{ cursor: 'pointer' }} size={8}>
          <Avatar size={30} style={{ background: ROLE_COLORS[user?.role || 'viewer'], fontSize: 13 }}>
            {user?.username?.[0]?.toUpperCase()}
          </Avatar>
          {!isMobile && <div style={{ lineHeight: 1.2 }}>
            <Typography.Text style={{ color: textColor, fontSize: 13, fontWeight: 600, display: 'block' }}>
              {user?.username}
            </Typography.Text>
            <Typography.Text style={{ color: subColor, fontSize: 11, display: 'block' }}>
              {user?.role}
            </Typography.Text>
          </div>}
        </Space>
      </Dropdown>
    </Header>
    </>
  )
}
