import { useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Sidebar from './Sidebar'
import TopNav from './TopNav'
import AppHeader from './Header'
import LocationGate from './LocationGate'
import MenuGroupNav from './MenuGroupNav'
import CommandPalette from '@/components/CommandPalette'
import CustomizePanel from '@/components/CustomizePanel'
import NocWallOverlay from '@/components/NocWallOverlay'
import { useTheme } from '@/contexts/ThemeContext'
import { useCustomize } from '@/contexts/CustomizeContext'
import { NocWallProvider, useNocWall } from '@/contexts/NocWallContext'
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

  /* MenuGroupNav — sayfa içerik öncesi yatay tab strip (Faz 3). */
  .nm-mg-nav {
    display: flex;
    flex-wrap: nowrap;
    gap: 2px;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 8px 14px 0;
    background: transparent;
    border-bottom: 1px solid var(--border-0);
    scrollbar-width: thin;
  }
  .nm-mg-nav::-webkit-scrollbar { height: 4px; }
  .nm-mg-nav::-webkit-scrollbar-thumb { background: var(--border-0); border-radius: 2px; }
  .nm-mg-tab {
    flex: 0 0 auto;
    padding: 8px 16px;
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--fg-2);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
    white-space: nowrap;
    border-radius: 4px 4px 0 0;
  }
  .nm-mg-tab:hover { color: var(--fg-0); background: var(--bg-1); }
  .nm-mg-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
`

// AppLayout — NocWallProvider ile sarmalı (useNavigate gerekiyor; provider
// BrowserRouter altında olmalı). Tüm gerçek layout AppLayoutInner'da.
export default function AppLayout() {
  return (
    <NocWallProvider>
      <AppLayoutInner />
    </NocWallProvider>
  )
}

function AppLayoutInner() {
  const { isDark, toggle: toggleTheme } = useTheme()
  const { menuPosition, soundEnabled, setSoundEnabled } = useCustomize()
  const wall = useNocWall()
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const { t } = useTranslation()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const BOTTOM_NAV_ITEMS = useMemo(() => [
    { key: '/',         icon: <DashboardOutlined />,  label: t('mobile_nav.home') },
    { key: '/devices',  icon: <LaptopOutlined />,     label: t('mobile_nav.devices') },
    { key: '/topology', icon: <ApartmentOutlined />,  label: t('mobile_nav.topology') },
    { key: '/monitor',  icon: <AlertOutlined />,      label: t('mobile_nav.events') },
    { key: '/settings', icon: <SettingOutlined />,    label: t('mobile_nav.settings') },
  ], [t])

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
        {/* menu=side iken Sidebar (sol), menu=top iken Sidebar gizleniyor
            (.menu-top .nm-sidebar { display: none } noc.css'te) ve TopNav
            üstte yatay dropdown'larla geliyor. AppHeader iki modda da var. */}
        <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
        <div className="nm-main" style={{
          gridTemplateRows: menuPosition === 'top' ? 'auto auto 1fr' : 'auto 1fr',
        }}>
          {menuPosition === 'top' && <TopNav />}
          <AppHeader
            onOpenSearch={() => setPaletteOpen(true)}
            onOpenMobileNav={() => setMobileNavOpen(true)}
          />
          <div className="nm-workspace">
            {/* Faz 3 menu restructure: yatay tab strip — aktif grup tab'ları.
                Dashboard veya bilinmeyen route'ta render edilmez (null döner). */}
            <MenuGroupNav />
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
          else if (act === 'sound-toggle') setSoundEnabled(!soundEnabled)
          else if (act === 'wall-start') wall.start()
          else if (act === 'wall-stop') wall.stop()
        }}
        isDark={isDark}
        soundEnabled={soundEnabled}
        wallActive={wall.active}
      />
      <CustomizePanel open={customizeOpen} onClose={() => setCustomizeOpen(false)} />
      <NocWallOverlay />
    </div>
  )
}
