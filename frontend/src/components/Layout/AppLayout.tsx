import { useEffect, useState } from 'react'
import { Layout } from 'antd'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import AppHeader from './Header'
import GlobalSearchModal from './GlobalSearchModal'
import { useTheme } from '@/contexts/ThemeContext'
import { useAlarmWatcher } from '@/hooks/useAlarmWatcher'
import { useIsMobile } from '@/hooks/useIsMobile'

const { Content } = Layout

const LAYOUT_CSS = `
  @keyframes pageEnterFade {
    from { opacity: 0; transform: translateY(7px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`

export default function AppLayout() {
  const { isDark } = useTheme()
  const location = useLocation()
  const isMobile = useIsMobile()
  const layoutBg = isDark ? '#030c1e' : '#f1f5f9'
  const [searchOpen, setSearchOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useAlarmWatcher()

  // close mobile nav on route change
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
      <GlobalSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </Layout>
  )
}
