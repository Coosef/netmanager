// useNavGroups — paylaşımlı nav data hook. Sidebar ve TopNav her ikisi de
// kullanır; tek kaynak. Role/permission filtreleme + badge sayıları burada.
import {
  DashboardOutlined, LaptopOutlined, ApartmentOutlined,
  RadarChartOutlined, AlertOutlined, PlayCircleOutlined,
  TeamOutlined, AuditOutlined, RobotOutlined,
  BarChartOutlined, SettingOutlined, LineChartOutlined, FileTextOutlined,
  ThunderboltOutlined, SafetyOutlined, TableOutlined, ClusterOutlined, CalendarOutlined,
  AimOutlined, RiseOutlined, BranchesOutlined, CloudOutlined, FileDoneOutlined,
  HddOutlined, BuildOutlined, EnvironmentOutlined, CodeOutlined, QuestionCircleOutlined,
  GlobalOutlined, DiffOutlined, BugOutlined, BellOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/store/auth'
import { monitorApi } from '@/api/monitor'
import { approvalsApi } from '@/api/approvals'
import { featureFlags } from '@/config/featureFlags'
import type { UserRole } from '@/types'

const ROLE_ORDER: UserRole[] = [
  'location_viewer', 'viewer', 'location_operator', 'operator',
  'location_manager', 'org_viewer', 'admin', 'super_admin',
]
const roleIndex = (role: string): number => ROLE_ORDER.indexOf(role as UserRole)

export interface NavItem {
  key: string
  icon: React.ReactNode
  label: string
  badge?: boolean | 'approval'
  badgeCount?: number      // hook'ta hesaplanır, render aşamasında basit
  minRole?: UserRole
}
export interface NavGroup {
  label: string
  items: NavItem[]
}

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

/** Tek kaynak nav data — Sidebar ve TopNav burayı çağırır. */
export function useNavGroups(): NavGroup[] {
  const { t } = useTranslation()
  const { user, isSuperAdmin, isOrgAdmin, can } = useAuthStore()
  const isSA = isSuperAdmin()
  const isOA = isOrgAdmin()
  const userRoleIdx = roleIndex(user?.role ?? 'viewer')

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

  const GROUPS: NavGroup[] = [
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
        { key: '/monitor', icon: <AlertOutlined />, label: t('nav.monitor'), badge: true, badgeCount: unacked },
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
        { key: '/approvals', icon: <SafetyOutlined />, label: t('nav.approvals'), badge: 'approval', badgeCount: approvalCount?.count ?? 0, minRole: 'location_manager' },
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

  // Role/permission filter — boş gruplar atılır.
  return GROUPS.map((g) => ({ ...g, items: g.items.filter((it) => canSee(it.minRole, it.key)) }))
    .filter((g) => g.items.length > 0)
}
