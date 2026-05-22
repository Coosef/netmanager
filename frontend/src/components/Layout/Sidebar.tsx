import { Drawer } from 'antd'
import {
  DashboardOutlined, LaptopOutlined, ApartmentOutlined,
  RadarChartOutlined, AlertOutlined, PlayCircleOutlined,
  TeamOutlined, AuditOutlined, RobotOutlined,
  BarChartOutlined, SettingOutlined, LineChartOutlined, FileTextOutlined,
  ThunderboltOutlined, SafetyOutlined, TableOutlined, ClusterOutlined, CalendarOutlined,
  AimOutlined, RiseOutlined, BranchesOutlined, CloudOutlined, FileDoneOutlined,
  HddOutlined, BuildOutlined, EnvironmentOutlined, CodeOutlined, QuestionCircleOutlined,
  CloseOutlined, GlobalOutlined, DiffOutlined, BugOutlined, BellOutlined,
} from '@ant-design/icons'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { monitorApi } from '@/api/monitor'
import { approvalsApi } from '@/api/approvals'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { featureFlags } from '@/config/featureFlags'
import type { UserRole } from '@/types'

// Role hierarchy order (lowest → highest)
const ROLE_ORDER: UserRole[] = [
  'location_viewer', 'viewer', 'location_operator', 'operator',
  'location_manager', 'org_viewer', 'admin', 'super_admin',
]
const roleIndex = (role: string): number => ROLE_ORDER.indexOf(role as UserRole)

interface SidebarProps {
  mobileOpen?: boolean
  onMobileClose?: () => void
}

export default function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const { user, isSuperAdmin, isOrgAdmin, can } = useAuthStore()
  const isSA = isSuperAdmin()
  const isOA = isOrgAdmin()
  const isMobile = useIsMobile()
  const userRoleIdx = roleIndex(user?.role ?? 'viewer')

  const MODULE_MAP: Record<string, [string, string]> = {
    '/devices': ['devices', 'view'], '/topology': ['topology', 'view'],
    '/ipam': ['ipam', 'view'], '/backups': ['config_backups', 'view'],
    '/monitor': ['monitoring', 'view'], '/incidents': ['monitoring', 'view'],
    '/escalation-rules': ['monitoring', 'view'], '/bandwidth': ['monitoring', 'view'],
    '/mac-arp': ['monitoring', 'view'], '/security-audit': ['monitoring', 'view'],
    '/asset-lifecycle': ['monitoring', 'view'], '/tasks': ['tasks', 'view'],
    '/playbooks': ['playbooks', 'view'], '/config-templates': ['driver_templates', 'view'],
    '/audit': ['audit_logs', 'view'], '/reports': ['reports', 'view'],
    '/users': ['users', 'view'], '/locations': ['locations', 'view'],
    '/agents': ['agents', 'view'], '/driver-templates': ['driver_templates', 'view'],
    '/settings': ['settings', 'view'],
  }

  const canSee = (minRole?: UserRole, key?: string) => {
    if (!minRole && !key) return true
    if (isSA || isOA) return true
    if (key && MODULE_MAP[key]) {
      const [mod, action] = MODULE_MAP[key]
      return can(mod, action)
    }
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

  type NavItem = {
    key: string; icon: React.ReactNode; label: string
    badge?: boolean | 'approval'; minRole?: UserRole
  }
  const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
    {
      label: t('nav_group.main'),
      items: [
        { key: '/', icon: <DashboardOutlined />, label: t('nav.dashboard') },
        { key: '/topology', icon: <ApartmentOutlined />, label: t('nav.topology') },
        ...(featureFlags.topologyV2
          ? [{ key: '/topology-next', icon: <ThunderboltOutlined />, label: 'Topology · Gold' }]
          : []),
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
        { key: '/config-drift', icon: <DiffOutlined />, label: 'Config Drift', minRole: 'org_viewer' },
        { key: '/compliance', icon: <FileDoneOutlined />, label: t('nav.compliance'), minRole: 'location_manager' },
        { key: '/racks', icon: <HddOutlined />, label: t('nav.racks'), minRole: 'admin' },
        { key: '/floor-plan', icon: <BuildOutlined />, label: t('nav.floor_plan'), minRole: 'admin' },
      ],
    },
    {
      label: t('nav_group.monitoring'),
      items: [
        { key: '/monitor', icon: <AlertOutlined />, label: t('nav.monitor'), badge: true },
        { key: '/intelligence', icon: <BugOutlined />, label: 'Ağ Analitik', minRole: 'org_viewer' },
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
        { key: '/synthetic-probes', icon: <RadarChartOutlined />, label: 'Synthetic Probes', minRole: 'org_viewer' },
        { key: '/incidents', icon: <BugOutlined />, label: 'Incident RCA', minRole: 'org_viewer' },
        { key: '/escalation-rules', icon: <BellOutlined />, label: 'Escalation Kuralları', minRole: 'admin' },
        { key: '/services', icon: <ApartmentOutlined />, label: 'Servis Etki Haritası', minRole: 'org_viewer' },
        { key: '/topology-twin', icon: <ApartmentOutlined />, label: 'Network Digital Twin', minRole: 'location_manager' },
        { key: '/reports', icon: <BarChartOutlined />, label: t('nav.reports'), minRole: 'org_viewer' },
      ],
    },
    {
      label: t('nav_group.management'),
      items: [
        ...(isSA ? [{ key: '/superadmin', icon: <GlobalOutlined />, label: '⚙ Platform Paneli', minRole: 'super_admin' as UserRole }] : []),
        ...(isOA && !isSA ? [{ key: '/org-admin', icon: <GlobalOutlined />, label: '⚙ Organizasyon Paneli', minRole: 'admin' as UserRole }] : []),
        { key: '/permissions', icon: <SafetyOutlined />, label: 'Yetki Yönetimi', minRole: 'admin' as UserRole },
        { key: '/ai-assistant', icon: <RobotOutlined />, label: 'AI Ağ Asistanı', minRole: 'admin' },
        { key: '/agents', icon: <RobotOutlined />, label: t('nav.agents'), minRole: 'admin' },
        { key: '/users', icon: <TeamOutlined />, label: t('nav.users'), minRole: 'admin' },
        { key: '/locations', icon: <EnvironmentOutlined />, label: t('nav.locations'), minRole: 'admin' },
        { key: '/audit', icon: <AuditOutlined />, label: t('nav.audit'), minRole: 'org_viewer' },
        { key: '/driver-templates', icon: <CodeOutlined />, label: t('nav.driver_templates'), minRole: 'admin' },
        { key: '/help', icon: <QuestionCircleOutlined />, label: t('nav.help') },
        { key: '/settings', icon: <SettingOutlined />, label: t('nav.settings'), minRole: 'admin' },
      ],
    },
  ]

  const initials = (user?.username ?? 'NM').slice(0, 2).toUpperCase()

  const nav = (
    <aside className="nm-sidebar" style={{ height: '100%' }}>
      <div className="nm-brand" onClick={() => { navigate('/'); if (isMobile) onMobileClose?.() }} style={{ cursor: 'pointer' }}>
        <div className="nm-brand-mark" />
        <div className="nm-brand-name">
          NetManager
          <small>universal cloud</small>
        </div>
        {isMobile && (
          <CloseOutlined onClick={(e) => { e.stopPropagation(); onMobileClose?.() }}
            style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--fg-2)' }} />
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', margin: '0 -10px', padding: '0 10px' }}>
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((it) => canSee(it.minRole, it.key))
          if (!items.length) return null
          return (
            <div key={group.label}>
              <div className="nm-navsect">{group.label}</div>
              {items.map((item) => {
                const active = location.pathname === item.key ||
                  (item.key !== '/' && location.pathname.startsWith(item.key))
                const badgeCount = item.badge === 'approval'
                  ? (approvalCount?.count ?? 0)
                  : item.badge ? unacked : 0
                return (
                  <div key={item.key}
                    className={`nm-navitem ${active ? 'active' : ''}`}
                    onClick={() => { navigate(item.key); if (isMobile) onMobileClose?.() }}>
                    <span className="nm-navicon">{item.icon}</span>
                    <span>{item.label}</span>
                    {badgeCount > 0 && (
                      <span className={`nm-navbadge ${item.badge === 'approval' ? 'warn' : 'crit'}`}>{badgeCount}</span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="nm-sidebar-foot">
        <div className="nm-avatar">{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--fg-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user?.username ?? 'NetManager'}
          </div>
          <small>{user?.role ?? ''}</small>
        </div>
      </div>
    </aside>
  )

  if (isMobile) {
    return (
      <Drawer open={mobileOpen} onClose={onMobileClose} placement="left" width={240}
        styles={{ body: { padding: 0, background: 'var(--bg-1)' }, header: { display: 'none' } }}
        style={{ zIndex: 1001 }}>
        {nav}
      </Drawer>
    )
  }
  return nav
}
