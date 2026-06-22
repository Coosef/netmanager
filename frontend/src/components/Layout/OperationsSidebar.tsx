import { Drawer, Tag, Tooltip } from 'antd'
import {
  CloseOutlined,
  DashboardOutlined,
  DesktopOutlined,
  ApartmentOutlined,
  ClusterOutlined,
  SearchOutlined,
  EyeOutlined,
  BellOutlined,
  SettingOutlined,
  RobotOutlined,
  SafetyOutlined,
  BarChartOutlined,
  ToolOutlined,
  TeamOutlined,
  AuditOutlined,
  OrderedListOutlined,
  GlobalOutlined,
  TagOutlined,
} from '@ant-design/icons'
import { useNavigate, useLocation, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import { useIsMobile } from '@/hooks/useIsMobile'
import CharonLogo from '@/components/CharonLogo'
import type { ReactNode } from 'react'

interface OperationsSidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

interface OperationsNavItem {
  key: string
  i18nKey: string
  icon: ReactNode
  /** Operations panel slug — combined with `/app/org/:id/` to build the
   *  canonical URL-authoritative route. Omit for comingSoon items. */
  segment?: string
  comingSoon?: boolean
}

/**
 * PR-A — Operations / org-scoped sidebar.
 *
 * OPERATIONS LEGACY ESCAPE SAFETY ADDENDUM contract:
 *
 *   ACTIVE (3 items) — every active item builds a route under
 *   `/app/org/:organizationId/<segment>`. URL-authoritative org context
 *   is preserved on every sidebar click.
 *
 *     - Dashboard           → /app/org/:id/dashboard
 *     - Ağ Envanteri        → /app/org/:id/devices
 *     - Proxy Ajanlar       → /app/org/:id/agents
 *
 *   YAKINDA (14+ items) — every legacy operations module appears as a
 *   disabled + "Yakında" badge item. NO `segment`, NO legacy `route`,
 *   NO navigation. The previous addendum allowed these to redirect to
 *   `/topology`, `/monitor`, etc. — the present addendum forbids that
 *   because such a click would escape the URL-authoritative org context
 *   and re-enter the legacy header+localStorage model, defeating the
 *   entire PR-A goal.
 *
 *   "Yarım çalışan ekran çıkarma" prensibi applies to operations too:
 *   no placeholder routes, no placeholder pages, no fake-active item.
 */
const OPERATIONS_ITEMS: OperationsNavItem[] = [
  // ─── AKTİF ─────────────────────────────────────────────────────────
  { key: 'dashboard', i18nKey: 'operations.nav.dashboard', icon: <DashboardOutlined />,  segment: 'dashboard' },
  { key: 'devices',   i18nKey: 'operations.nav.devices',   icon: <DesktopOutlined />,    segment: 'devices'   },
  { key: 'agents',    i18nKey: 'operations.nav.agents',    icon: <ClusterOutlined />,    segment: 'agents'    },
  // ─── YAKINDA ───────────────────────────────────────────────────────
  { key: 'topology',          i18nKey: 'operations.nav.topology',          icon: <ApartmentOutlined />,  comingSoon: true },
  { key: 'discovery',         i18nKey: 'operations.nav.discovery',         icon: <SearchOutlined />,     comingSoon: true },
  { key: 'monitoring',        i18nKey: 'operations.nav.monitoring',        icon: <EyeOutlined />,        comingSoon: true },
  { key: 'alerts',            i18nKey: 'operations.nav.alerts',            icon: <BellOutlined />,       comingSoon: true },
  { key: 'config',            i18nKey: 'operations.nav.config',            icon: <SettingOutlined />,    comingSoon: true },
  { key: 'automation',        i18nKey: 'operations.nav.automation',        icon: <RobotOutlined />,      comingSoon: true },
  { key: 'security',          i18nKey: 'operations.nav.security',          icon: <SafetyOutlined />,     comingSoon: true },
  { key: 'reports',           i18nKey: 'operations.nav.reports',           icon: <BarChartOutlined />,   comingSoon: true },
  { key: 'tools',             i18nKey: 'operations.nav.tools',             icon: <ToolOutlined />,       comingSoon: true },
  { key: 'org_users',         i18nKey: 'operations.nav.org_users',         icon: <TeamOutlined />,       comingSoon: true },
  { key: 'org_audit',         i18nKey: 'operations.nav.org_audit',         icon: <AuditOutlined />,      comingSoon: true },
  { key: 'tasks',             i18nKey: 'operations.nav.tasks',             icon: <OrderedListOutlined />, comingSoon: true },
  { key: 'ipam',              i18nKey: 'operations.nav.ipam',              icon: <GlobalOutlined />,     comingSoon: true },
  { key: 'vlan',              i18nKey: 'operations.nav.vlan',              icon: <TagOutlined />,        comingSoon: true },
]

// Dev-only invariants:
//   1. active item segment MUST NOT contain '/' or '..' (single-segment)
//   2. active item MUST NOT also be comingSoon
//   3. comingSoon item MUST NOT have a segment (defensive: the segment
//      would silently become reachable as a sidebar escape path)
if (import.meta.env?.DEV) {
  for (const item of OPERATIONS_ITEMS) {
    if (item.segment && (item.segment.includes('/') || item.segment.includes('..'))) {
      // eslint-disable-next-line no-console
      console.error(
        `[OperationsSidebar invariant] item '${item.key}' segment '${item.segment}' is not single-segment`,
      )
    }
    if (item.segment && item.comingSoon) {
      // eslint-disable-next-line no-console
      console.error(
        `[OperationsSidebar invariant] item '${item.key}' has BOTH segment and comingSoon — comingSoon wins, escape risk`,
      )
    }
    if (!item.segment && !item.comingSoon) {
      // eslint-disable-next-line no-console
      console.error(
        `[OperationsSidebar invariant] item '${item.key}' has neither segment nor comingSoon — treating as disabled`,
      )
    }
  }
}

export default function OperationsSidebar({ mobileOpen = false, onMobileClose }: OperationsSidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams<{ organizationId?: string }>()
  const { user } = useAuthStore()
  const isMobile = useIsMobile()
  const { t } = useTranslation()

  const initials = (user?.username ?? 'CH').slice(0, 2).toUpperCase()

  // The `:organizationId` route param is the SOLE source of truth for
  // every active sidebar item's route. We never derive it from
  // `activeOrgId` or `user.org_id` — that would re-introduce the
  // header-state escape PR-A is designed to close.
  const routeOrgId = params.organizationId ?? null

  const homeOf = (segment: string) =>
    routeOrgId ? `/app/org/${routeOrgId}/${segment}` : '/'

  const isActive = (item: OperationsNavItem) => {
    if (!item.segment || !routeOrgId) return false
    const target = `/app/org/${routeOrgId}/${item.segment}`
    return location.pathname === target || location.pathname.startsWith(target + '/')
  }

  const handleClick = (item: OperationsNavItem) => {
    if (item.comingSoon || !item.segment) return // no-op
    if (!routeOrgId) return // defensive: cannot navigate without route org
    navigate(homeOf(item.segment))
    if (isMobile) onMobileClose?.()
  }

  const nav = (
    <aside className="nm-sidebar" style={{ height: '100%' }} data-testid="operations-sidebar">
      <div
        className="nm-brand"
        onClick={() => {
          if (routeOrgId) navigate(homeOf('dashboard'))
          if (isMobile) onMobileClose?.()
        }}
        style={{ cursor: 'pointer' }}
      >
        <CharonLogo size={32} />
        <div className="nm-brand-name">
          Charon
          <small>{t('operations.brand_sublabel')}</small>
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
        {OPERATIONS_ITEMS.map((item) => {
          const disabled = item.comingSoon || !item.segment
          const active = isActive(item)
          return (
            <div
              key={item.key}
              data-testid={`operations-nav-${item.key}`}
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
