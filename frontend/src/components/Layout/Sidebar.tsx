import { useState } from 'react'
import { Layout, Badge, Tooltip, Drawer } from 'antd'
import {
  DashboardOutlined, LaptopOutlined, ApartmentOutlined,
  RadarChartOutlined, AlertOutlined, PlayCircleOutlined,
  TeamOutlined, AuditOutlined, RobotOutlined,
  BarChartOutlined, WifiOutlined, SettingOutlined, LineChartOutlined, FileTextOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, ThunderboltOutlined,
  SafetyOutlined, TableOutlined, ClusterOutlined, CalendarOutlined,
  AimOutlined, RiseOutlined, BranchesOutlined, CloudOutlined, FileDoneOutlined,
  HddOutlined, BuildOutlined, EnvironmentOutlined, CodeOutlined, QuestionCircleOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { monitorApi } from '@/api/monitor'
import { approvalsApi } from '@/api/approvals'
import { useTheme } from '@/contexts/ThemeContext'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import { useIsMobile } from '@/hooks/useIsMobile'
import type { UserRole } from '@/types'

const { Sider } = Layout

const SIDEBAR_CSS = `
  @keyframes sideLogoGlow {
    0%,100% { box-shadow: 0 0 14px #3b82f660, 0 0 28px #1d4ed840; }
    50%      { box-shadow: 0 0 22px #3b82f6aa, 0 0 44px #1d4ed860; }
  }
  @keyframes sideActivePulse {
    0%,100% { box-shadow: 0 0 8px  #3b82f620; }
    50%      { box-shadow: 0 0 18px #3b82f650; }
  }
  .side-item {
    transition: background 0.12s ease, transform 0.1s ease !important;
  }
  .side-item:hover {
    transform: translateX(2px) !important;
  }
  .side-active {
    animation: sideActivePulse 3.5s ease-in-out infinite;
  }
`

// Role hierarchy order (lowest → highest)
const ROLE_ORDER: UserRole[] = [
  'location_viewer',
  'viewer',
  'location_operator',
  'operator',
  'location_manager',
  'org_viewer',
  'admin',
  'super_admin',
]

function roleIndex(role: string): number {
  return ROLE_ORDER.indexOf(role as UserRole)
}

interface SidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

export default function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { isDark } = useTheme()
  const { t } = useTranslation()
  const { user, isSuperAdmin } = useAuthStore()
  const isSA = isSuperAdmin()
  const isMobile = useIsMobile()

  const userRoleIdx = roleIndex(user?.role ?? 'viewer')

  const canSee = (minRole?: UserRole) => {
    if (!minRole) return true
    return userRoleIdx >= roleIndex(minRole)
  }

  const { data: stats } = useQuery({
    queryKey: ['monitor-stats'],
    queryFn: () => monitorApi.getStats(),
    refetchInterval: 30000,
  })

  const { data: approvalCount } = useQuery({
    queryKey: ['approval-pending-count'],
    queryFn: approvalsApi.pendingCount,
    refetchInterval: 30000,
  })

  const unacked = stats?.events_24h.unacknowledged ?? 0
  const healthScore = stats?.health_score ?? 0
  const healthColor = healthScore >= 80 ? '#22c55e' : healthScore >= 50 ? '#f59e0b' : '#ef4444'
  const healthLabel = healthScore >= 80 ? t('sidebar.health_ok') : healthScore >= 50 ? t('sidebar.health_warn') : t('sidebar.health_crit')

  const siderBg = isDark ? '#030c1e' : '#ffffff'
  const borderColor = isDark ? '#112240' : '#e2e8f0'
  const textPrimary = isDark ? '#f1f5f9' : '#1e293b'
  const textSecondary = isDark ? '#94a3b8' : '#64748b'
  const groupLabel = isDark ? '#3a5578' : '#94a3b8'
  const activeItemBg = isDark ? '#1d4ed820' : '#eff6ff'
  const hoverItemBg = isDark ? '#0e1e38' : '#f8fafc'
  const trackBg = isDark ? '#0e1e38' : '#f1f5f9'

  const isCollapsed = isMobile ? false : collapsed

  type NavItem = {
    key: string
    icon: React.ReactNode
    label: string
    badge?: boolean | 'approval'
    minRole?: UserRole
  }

  const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
    {
      label: t('nav_group.main'),
      items: [
        { key: '/', icon: <DashboardOutlined />, label: t('nav.dashboard') },
        { key: '/topology', icon: <ApartmentOutlined />, label: t('nav.topology') },
        { key: '/devices', icon: <LaptopOutlined />, label: t('nav.devices') },
      ],
    },
    {
      label: t('nav_group.discovery'),
      items: [
        { key: '/discovery', icon: <RadarChartOutlined />, label: t('nav.discovery'), minRole: 'admin' },
        { key: '/ipam', icon: <ClusterOutlined />, label: t('nav.ipam'), minRole: 'org_viewer' },
        { key: '/vlan', icon: <BranchesOutlined />, label: t('nav.vlan'), minRole: 'org_viewer' },
        { key: '/backups', icon: <CloudOutlined />, label: t('nav.backups'), minRole: 'location_manager' },
        { key: '/compliance', icon: <FileDoneOutlined />, label: t('nav.compliance'), minRole: 'location_manager' },
        { key: '/racks', icon: <HddOutlined />, label: t('nav.racks'), minRole: 'admin' },
        { key: '/floor-plan', icon: <BuildOutlined />, label: t('nav.floor_plan'), minRole: 'admin' },
      ],
    },
    {
      label: t('nav_group.monitoring'),
      items: [
        { key: '/monitor', icon: <AlertOutlined />, label: t('nav.monitor'), badge: true },
        { key: '/alert-rules', icon: <AlertOutlined />, label: t('nav.alert_rules'), minRole: 'admin' },
        { key: '/bandwidth', icon: <LineChartOutlined />, label: t('nav.bandwidth'), minRole: 'org_viewer' },
        { key: '/mac-arp', icon: <TableOutlined />, label: t('nav.port_intelligence'), minRole: 'org_viewer' },
        { key: '/security-audit', icon: <SafetyOutlined />, label: t('nav.security_audit'), minRole: 'org_viewer' },
        { key: '/asset-lifecycle', icon: <CalendarOutlined />, label: t('nav.asset_lifecycle'), minRole: 'org_viewer' },
        { key: '/diagnostics', icon: <AimOutlined />, label: t('nav.diagnostics'), minRole: 'operator' },
        { key: '/tasks', icon: <PlayCircleOutlined />, label: t('nav.tasks'), minRole: 'operator' },
        { key: '/playbooks', icon: <ThunderboltOutlined />, label: t('nav.playbooks'), minRole: 'admin' },
        { key: '/config-templates', icon: <FileTextOutlined />, label: t('nav.config_templates'), minRole: 'admin' },
        { key: '/change-management', icon: <CalendarOutlined />, label: t('nav.change_management'), minRole: 'location_manager' },
        { key: '/approvals', icon: <SafetyOutlined />, label: t('nav.approvals'), badge: 'approval', minRole: 'location_manager' },
        { key: '/sla', icon: <RiseOutlined />, label: t('nav.sla'), minRole: 'org_viewer' },
        { key: '/services', icon: <ApartmentOutlined />, label: 'Servis Etki Haritası', minRole: 'org_viewer' },
        { key: '/topology-twin', icon: <ApartmentOutlined />, label: 'Network Digital Twin', minRole: 'location_manager' },
        { key: '/reports', icon: <BarChartOutlined />, label: t('nav.reports'), minRole: 'org_viewer' },
      ],
    },
    {
      label: t('nav_group.management'),
      items: [
        { key: '/ai-assistant', icon: <RobotOutlined />, label: 'AI Ağ Asistanı', minRole: 'admin' },
        { key: '/agents', icon: <RobotOutlined />, label: t('nav.agents'), minRole: 'admin' },
        { key: '/users', icon: <TeamOutlined />, label: t('nav.users'), minRole: 'admin' },
        { key: '/locations', icon: <EnvironmentOutlined />, label: t('nav.locations'), minRole: 'admin' },
        ...(isSA ? [{ key: '/tenants', icon: <ApartmentOutlined />, label: t('nav.tenants'), minRole: 'super_admin' as UserRole }] : []),
        { key: '/audit', icon: <AuditOutlined />, label: t('nav.audit'), minRole: 'org_viewer' },
        { key: '/driver-templates', icon: <CodeOutlined />, label: t('nav.driver_templates'), minRole: 'admin' },
        { key: '/help', icon: <QuestionCircleOutlined />, label: t('nav.help') },
        { key: '/settings', icon: <SettingOutlined />, label: t('nav.settings'), minRole: 'admin' },
      ],
    },
  ]

  const navContent = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: siderBg }}>
      <style>{SIDEBAR_CSS}</style>

      {/* Logo */}
      <div style={{
        height: 60, display: 'flex', alignItems: 'center',
        padding: '0 20px', borderBottom: `1px solid ${borderColor}`,
        gap: 10, flexShrink: 0,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
          animation: isDark ? 'sideLogoGlow 3s ease-in-out infinite' : undefined,
        }}>
          <WifiOutlined style={{ color: '#fff', fontSize: 16 }} />
        </div>
        {!isCollapsed && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: textPrimary, fontWeight: 700, fontSize: 15, lineHeight: 1.2 }}>NetManager</div>
            <div style={{ color: textSecondary, fontSize: 10 }}>Universal Cloud Network Manager</div>
          </div>
        )}
        {isMobile && (
          <CloseOutlined
            onClick={onMobileClose}
            style={{ color: textSecondary, fontSize: 16, cursor: 'pointer', flexShrink: 0 }}
          />
        )}
      </div>

      {/* Nav groups */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '8px 0' }}>
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter((item) => canSee(item.minRole))
          if (visibleItems.length === 0) return null
          return (
            <div key={group.label}>
              {!isCollapsed && (
                <div style={{
                  color: groupLabel, fontSize: 10, fontWeight: 600,
                  padding: '12px 20px 4px', letterSpacing: '0.08em',
                }}>
                  {group.label}
                </div>
              )}
              {visibleItems.map((item) => {
                const isActive = location.pathname === item.key ||
                  (item.key !== '/' && location.pathname.startsWith(item.key))
                const badgeType = item.badge
                const badgeCount = badgeType === 'approval'
                  ? (approvalCount?.count ?? 0)
                  : badgeType ? unacked : 0
                const showBadge = badgeCount > 0

                const content = (
                  <div
                    key={item.key}
                    onClick={() => { navigate(item.key); if (isMobile) onMobileClose?.() }}
                    className={`side-item${isActive ? ' side-active' : ''}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: isCollapsed ? '10px 0' : '9px 12px 9px 20px',
                      margin: '1px 8px', borderRadius: 6, cursor: 'pointer',
                      background: isActive ? activeItemBg : 'transparent',
                      borderLeft: isActive ? '3px solid #3b82f6' : '3px solid transparent',
                      transition: 'all 0.15s',
                      justifyContent: isCollapsed ? 'center' : 'flex-start',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) (e.currentTarget as HTMLElement).style.background = hoverItemBg
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'
                    }}
                  >
                    <span style={{ color: isActive ? '#3b82f6' : textSecondary, fontSize: 16, flexShrink: 0 }}>
                      {item.icon}
                    </span>
                    {!isCollapsed && (
                      <>
                        <span style={{ color: isActive ? textPrimary : textSecondary, fontSize: 13, flex: 1, fontWeight: isActive ? 600 : 400 }}>
                          {item.label}
                        </span>
                        {showBadge && (
                          <Badge count={badgeCount} size="small" style={{ backgroundColor: badgeType === 'approval' ? '#f59e0b' : '#ef4444' }} />
                        )}
                      </>
                    )}
                  </div>
                )

                return isCollapsed ? (
                  <Tooltip key={item.key} title={item.label} placement="right">
                    {content}
                  </Tooltip>
                ) : content
              })}
            </div>
          )
        })}
      </div>

      {/* System status */}
      {!isCollapsed && (
        <div style={{ borderTop: `1px solid ${borderColor}`, padding: '12px 16px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: healthColor, flexShrink: 0 }} />
            <span style={{ color: textSecondary, fontSize: 11 }}>{t('sidebar.health_status')}</span>
            <span style={{ color: healthColor, fontSize: 11, fontWeight: 600, marginLeft: 'auto' }}>{healthLabel}</span>
          </div>
          <div style={{ background: trackBg, borderRadius: 4, height: 4, overflow: 'hidden' }}>
            <div style={{ background: healthColor, width: `${healthScore}%`, height: '100%', transition: 'width 1s' }} />
          </div>
          <div style={{ color: groupLabel, fontSize: 10, marginTop: 4 }}>{t('sidebar.score')}: {healthScore}/100</div>
        </div>
      )}

      {/* Collapse toggle — desktop only */}
      {!isMobile && (
        <div
          onClick={() => setCollapsed(!collapsed)}
          style={{
            borderTop: `1px solid ${borderColor}`, padding: '12px',
            display: 'flex', justifyContent: collapsed ? 'center' : 'flex-end',
            cursor: 'pointer', color: textSecondary, flexShrink: 0,
          }}
        >
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </div>
      )}
    </div>
  )

  if (isMobile) {
    return (
      <Drawer
        open={mobileOpen}
        onClose={onMobileClose}
        placement="left"
        width={260}
        styles={{ body: { padding: 0, background: siderBg }, header: { display: 'none' } }}
        style={{ zIndex: 1001 }}
      >
        {navContent}
      </Drawer>
    )
  }

  return (
    <Sider
      width={220}
      collapsedWidth={64}
      collapsed={collapsed}
      onCollapse={setCollapsed}
      style={{
        background: siderBg,
        borderRight: `1px solid ${borderColor}`,
        overflow: 'hidden',
        position: 'sticky',
        top: 0,
        height: '100vh',
        boxShadow: isDark ? '4px 0 24px rgba(0,0,0,0.6), inset -1px 0 0 #3b82f610' : '1px 0 4px rgba(0,0,0,0.06)',
      }}
    >
      {navContent}
    </Sider>
  )
}
