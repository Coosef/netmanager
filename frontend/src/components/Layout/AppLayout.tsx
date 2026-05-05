import { useEffect, useState } from 'react'
import { Layout } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import AppHeader from './Header'
import GlobalSearchModal from './GlobalSearchModal'
import { useTheme } from '@/contexts/ThemeContext'
import { useAlarmWatcher } from '@/hooks/useAlarmWatcher'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  DashboardOutlined, LaptopOutlined, AlertOutlined,
  ApartmentOutlined, SettingOutlined,
} from '@ant-design/icons'

const { Content } = Layout

const LAYOUT_CSS = `
  @keyframes pageEnterFade {
    from { opacity: 0; transform: translateY(7px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`

const BOTTOM_NAV_ITEMS = [
  { key: '/',        icon: <DashboardOutlined />,  label: 'Ana Sayfa' },
  { key: '/devices', icon: <LaptopOutlined />,      label: 'Cihazlar' },
  { key: '/topology',icon: <ApartmentOutlined />,   label: 'Topoloji' },
  { key: '/monitor', icon: <AlertOutlined />,        label: 'Olaylar' },
  { key: '/settings',icon: <SettingOutlined />,      label: 'Ayarlar' },
]

export default function AppLayout() {
  const { isDark } = useTheme()
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const layoutBg = isDark ? '#030c1e' : '#f1f5f9'
  const [searchOpen, setSearchOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useAlarmWatcher()

  useEffect(() => { setMobileNavOpen(false) }, [location.pathname])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const bottomNavBg = isDark ? 'rgba(3,12,30,0.97)' : 'rgba(255,255,255,0.97)'
  const bottomNavBorder = isDark ? '#112240' : '#e2e8f0'
  const activeColor = '#3b82f6'
  const inactiveColor = isDark ? '#64748b' : '#94a3b8'

  const isActive = (key: string) =>
    key === '/' ? location.pathname === '/' : location.pathname.startsWith(key)

  return (
    <Layout style={{ minHeight: '100vh', background: layoutBg }}>
      <style>{LAYOUT_CSS}</style>
      <Sidebar
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />
      <Layout style={{ background: layoutBg }}>
        <AppHeader
          onOpenSearch={() => setSearchOpen(true)}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />
        <Content style={{
          padding: isMobile ? '12px 14px' : '20px 24px',
          paddingBottom: isMobile ? 'calc(64px + max(16px, env(safe-area-inset-bottom)))' : '20px',
          minHeight: 'calc(100vh - 60px)',
          backgroundImage: isDark
            ? 'radial-gradient(circle, rgba(0,195,255,0.03) 1px, transparent 0)'
            : undefined,
          backgroundSize: isDark ? '28px 28px' : undefined,
        }}>
          <div key={location.pathname} style={{ animation: 'pageEnterFade 0.28s ease both' }}>
            <Outlet />
          </div>
        </Content>
      </Layout>

      {/* Bottom navigation bar — mobile only */}
      {isMobile && (
        <nav style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: 'calc(56px + env(safe-area-inset-bottom))',
          paddingBottom: 'env(safe-area-inset-bottom)',
          background: bottomNavBg,
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderTop: `1px solid ${bottomNavBorder}`,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-around',
          zIndex: 200,
          boxShadow: isDark ? '0 -4px 20px rgba(0,0,0,0.5)' : '0 -2px 12px rgba(0,0,0,0.08)',
        }}>
          {BOTTOM_NAV_ITEMS.map((item) => {
            const active = isActive(item.key)
            return (
              <button
                key={item.key}
                onClick={() => navigate(item.key)}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 3,
                  padding: '8px 0',
                  height: 56,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: active ? activeColor : inactiveColor,
                  fontSize: 10,
                  fontWeight: active ? 700 : 400,
                  transition: 'color 0.15s',
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <span style={{
                  fontSize: 20,
                  display: 'block',
                  filter: active ? `drop-shadow(0 0 6px ${activeColor}80)` : undefined,
                }}>
                  {item.icon}
                </span>
                <span style={{ fontSize: 10, lineHeight: 1.2 }}>{item.label}</span>
                {active && (
                  <span style={{
                    position: 'absolute',
                    top: 0,
                    width: 24,
                    height: 2,
                    borderRadius: 1,
                    background: activeColor,
                  }} />
                )}
              </button>
            )
          })}
        </nav>
      )}

      <GlobalSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </Layout>
  )
}
