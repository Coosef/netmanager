import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import AppHeader from './Header'
import LocationGate from './LocationGate'
import CommandPalette from '@/components/CommandPalette'
import CustomizePanel from '@/components/CustomizePanel'
import { useTheme } from '@/contexts/ThemeContext'
import { useCustomize } from '@/contexts/CustomizeContext'
import { useAlarmWatcher } from '@/hooks/useAlarmWatcher'
import { useIsMobile } from '@/hooks/useIsMobile'
import {
  DashboardOutlined, LaptopOutlined, AlertOutlined,
  ApartmentOutlined, SettingOutlined,
} from '@ant-design/icons'

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
  const { isDark, toggle: toggleTheme } = useTheme()
  const { menuPosition } = useCustomize()
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useAlarmWatcher()

  useEffect(() => { setMobileNavOpen(false) }, [location.pathname])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K → CommandPalette (NAV + AKSIYON + CİHAZ arama).
      // Eski GlobalSearchModal yerine — CommandPalette üst kümesi (sayfa
      // ara, tema değiştir, özelleştir, ayrıca cihaz arama dahil).
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const activeColor = '#22d3c5'
  const inactiveColor = isDark ? '#64748b' : '#94a3b8'
  const isActive = (key: string) =>
    key === '/' ? location.pathname === '/' : location.pathname.startsWith(key)

  return (
    // T8.4 — NOC design shell. `:root` (noc.css) is dark by default; the
    // `.theme-light` class flips the design CSS variables for light mode.
    <div className={`nm-app-shell ${isDark ? '' : 'theme-light'}`} style={{ height: '100vh', overflow: 'hidden' }}>
      <style>{LAYOUT_CSS}</style>
      <div className={`nm-root menu-${menuPosition}`}>
        <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
        <div className="nm-main" style={{ gridTemplateRows: 'auto 1fr' }}>
          <AppHeader
            onOpenSearch={() => setPaletteOpen(true)}
            onOpenMobileNav={() => setMobileNavOpen(true)}
          />
          <div className="nm-workspace">
            <div key={location.pathname} style={{ animation: 'pageEnterFade 0.28s ease both', minHeight: '100%' }}>
              {/* Faz 8 Phase F — gate every page on a resolved location context. */}
              <LocationGate>
                <Outlet />
              </LocationGate>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom navigation bar — mobile only */}
      {isMobile && (
        <nav style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          height: 'calc(56px + env(safe-area-inset-bottom))',
          paddingBottom: 'env(safe-area-inset-bottom)',
          background: isDark ? 'rgba(11,19,34,0.97)' : 'rgba(255,255,255,0.97)',
          backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          borderTop: `1px solid ${isDark ? '#1c2538' : '#e2e8f0'}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-around',
          zIndex: 200,
          boxShadow: isDark ? '0 -4px 20px rgba(0,0,0,0.5)' : '0 -2px 12px rgba(0,0,0,0.08)',
        }}>
          {BOTTOM_NAV_ITEMS.map((item) => {
            const active = isActive(item.key)
            return (
              <button key={item.key} onClick={() => navigate(item.key)}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', gap: 3, padding: '8px 0', height: 56,
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: active ? activeColor : inactiveColor,
                  fontSize: 10, fontWeight: active ? 700 : 400, transition: 'color 0.15s',
                  WebkitTapHighlightColor: 'transparent',
                }}>
                <span style={{ fontSize: 20, display: 'block', filter: active ? `drop-shadow(0 0 6px ${activeColor}80)` : undefined }}>
                  {item.icon}
                </span>
                <span style={{ fontSize: 10, lineHeight: 1.2 }}>{item.label}</span>
              </button>
            )
          })}
        </nav>
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onAction={(act) => {
          if (act === 'theme') toggleTheme()
          else if (act === 'customize') setCustomizeOpen(true)
        }}
        isDark={isDark}
      />
      <CustomizePanel open={customizeOpen} onClose={() => setCustomizeOpen(false)} />
    </div>
  )
}
