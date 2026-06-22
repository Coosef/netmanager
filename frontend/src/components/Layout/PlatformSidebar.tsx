import { Drawer, Tag, Tooltip } from 'antd'
import {
  CloseOutlined,
  AppstoreOutlined,
  ApartmentOutlined,
  TeamOutlined,
  SafetyOutlined,
  AuditOutlined,
  HeartOutlined,
  SettingOutlined,
  DatabaseOutlined,
  DollarOutlined,
} from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import { useIsMobile } from '@/hooks/useIsMobile'
import CharonLogo from '@/components/CharonLogo'
import type { ReactNode } from 'react'

interface PlatformSidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

interface PlatformNavItem {
  key: string
  i18nKey: string
  icon: ReactNode
  /** When present: clickable, navigates here. When omitted: comingSoon
   *  fallback — Yakında badge + disabled. */
  route?: string
  comingSoon?: boolean
  /** Pathname predicate for highlight — exact + prefix. */
  matchPrefix?: string
}

/**
 * PR-A — Platform / control-plane sidebar.
 *
 * PLATFORM NAV SCOPE SAFETY ADDENDUM contract:
 *   - 2 items AKTİF — `Platform Genel Bakış`, `Firmalar`
 *   - 7 items YAKINDA — disabled + badge + onClick no-op + NO route
 *     (`/platform/users`, `/platform/roles`, `/platform/licenses`,
 *     `/platform/quotas`, `/platform/global-health`, `/platform/audit`,
 *     `/platform/settings`, `/platform/retention`)
 *
 * "Yarım çalışan ekran çıkarma" prensibi: no placeholder routes, no
 * placeholder pages, no fake-active sidebar item.
 */
const PLATFORM_ITEMS: PlatformNavItem[] = [
  {
    key: 'overview',
    i18nKey: 'platform.nav.overview',
    icon: <AppstoreOutlined />,
    route: '/platform/overview',
    matchPrefix: '/platform/overview',
  },
  {
    key: 'organizations',
    i18nKey: 'platform.nav.organizations',
    icon: <ApartmentOutlined />,
    route: '/platform/organizations',
    matchPrefix: '/platform/organizations',
  },
  // ─── Yakında ───────────────────────────────────────────────────────
  {
    key: 'users',
    i18nKey: 'platform.nav.users',
    icon: <TeamOutlined />,
    comingSoon: true,
  },
  {
    key: 'roles',
    i18nKey: 'platform.nav.roles',
    icon: <SafetyOutlined />,
    comingSoon: true,
  },
  {
    key: 'licenses',
    i18nKey: 'platform.nav.licenses',
    icon: <DollarOutlined />,
    comingSoon: true,
  },
  {
    key: 'global_health',
    i18nKey: 'platform.nav.global_health',
    icon: <HeartOutlined />,
    comingSoon: true,
  },
  {
    key: 'global_audit',
    i18nKey: 'platform.nav.global_audit',
    icon: <AuditOutlined />,
    comingSoon: true,
  },
  {
    key: 'retention',
    i18nKey: 'platform.nav.retention',
    icon: <DatabaseOutlined />,
    comingSoon: true,
  },
  {
    key: 'settings',
    i18nKey: 'platform.nav.settings',
    icon: <SettingOutlined />,
    comingSoon: true,
  },
]

// Defensive dev-only assertion: an item with neither a route nor
// comingSoon would silently render as an undisabled-but-noop item — a
// regression that escapes runtime testing because nothing visually
// changes. Catch it at module load.
if (import.meta.env?.DEV) {
  for (const item of PLATFORM_ITEMS) {
    if (!item.route && !item.comingSoon) {
      // eslint-disable-next-line no-console
      console.error(
        `[PlatformSidebar invariant] item '${item.key}' has neither route nor comingSoon — treating as disabled`,
      )
    }
    if (item.route && item.comingSoon) {
      // eslint-disable-next-line no-console
      console.warn(
        `[PlatformSidebar invariant] item '${item.key}' has BOTH route and comingSoon — comingSoon wins`,
      )
    }
  }
}

export default function PlatformSidebar({ mobileOpen = false, onMobileClose }: PlatformSidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuthStore()
  const isMobile = useIsMobile()
  const { t } = useTranslation()

  const initials = (user?.username ?? 'CH').slice(0, 2).toUpperCase()

  const isActive = (item: PlatformNavItem) => {
    if (!item.matchPrefix) return false
    return location.pathname === item.matchPrefix || location.pathname.startsWith(item.matchPrefix + '/')
  }

  const handleClick = (item: PlatformNavItem) => {
    if (item.comingSoon || !item.route) return // no-op
    navigate(item.route)
    if (isMobile) onMobileClose?.()
  }

  const nav = (
    <aside className="nm-sidebar" style={{ height: '100%' }} data-testid="platform-sidebar">
      <div
        className="nm-brand"
        onClick={() => {
          navigate('/platform/overview')
          if (isMobile) onMobileClose?.()
        }}
        style={{ cursor: 'pointer' }}
      >
        <CharonLogo size={32} />
        <div className="nm-brand-name">
          Charon
          <small>{t('platform.brand_sublabel')}</small>
        </div>
        {isMobile && (
          <CloseOutlined
            onClick={(e) => {
              e.stopPropagation()
              onMobileClose?.()
            }}
            style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--fg-2)' }}
          />
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', margin: '0 -10px', padding: '0 10px' }}>
        {PLATFORM_ITEMS.map((item) => {
          const disabled = item.comingSoon || !item.route
          const active = isActive(item)
          return (
            <div
              key={item.key}
              data-testid={`platform-nav-${item.key}`}
              data-coming-soon={item.comingSoon ? 'true' : 'false'}
              aria-disabled={disabled || undefined}
              className={`nm-navitem ${active ? 'active' : ''} ${disabled ? 'is-disabled' : ''}`}
              onClick={() => handleClick(item)}
              style={{
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.55 : 1,
              }}
            >
              <span className="nm-navicon">{item.icon}</span>
              <span>{t(item.i18nKey)}</span>
              {item.comingSoon && (
                <Tooltip title={t('sidebar.coming_soon_tooltip')}>
                  <Tag
                    color="default"
                    style={{ marginLeft: 'auto', fontSize: 10, padding: '0 6px', lineHeight: '16px' }}
                  >
                    {t('sidebar.coming_soon_badge')}
                  </Tag>
                </Tooltip>
              )}
            </div>
          )
        })}
      </div>

      <div className="nm-sidebar-foot">
        <div className="nm-avatar">{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 500,
              color: 'var(--fg-0)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {user?.username ?? 'Charon'}
          </div>
          <small>{user?.role ?? ''}</small>
        </div>
      </div>
    </aside>
  )

  if (isMobile) {
    return (
      <Drawer
        open={mobileOpen}
        onClose={onMobileClose}
        placement="left"
        width={240}
        styles={{ body: { padding: 0, background: 'var(--bg-1)' }, header: { display: 'none' } }}
        style={{ zIndex: 1001 }}
      >
        {nav}
      </Drawer>
    )
  }
  return nav
}
