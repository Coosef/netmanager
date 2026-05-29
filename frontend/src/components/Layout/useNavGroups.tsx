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
import { useSite } from '@/contexts/SiteContext'
import { monitorApi } from '@/api/monitor'
import { approvalsApi } from '@/api/approvals'
import { featureFlags } from '@/config/featureFlags'
import type { SystemRole } from '@/types'

// RBAC F2 — 4-role hierarchy (lowest → highest). Must stay symmetric with
// the backend SystemRole enum and the auth store's ROLE_ORDER.
const ROLE_ORDER: SystemRole[] = ['viewer', 'location_admin', 'org_admin', 'super_admin']
const roleIndex = (role: string): number => ROLE_ORDER.indexOf(role as SystemRole)

export interface NavItem {
  key: string
  icon: React.ReactNode
  label: string
  badge?: boolean | 'approval'
  badgeCount?: number      // hook'ta hesaplanır, render aşamasında basit
  minRole?: SystemRole
}
export interface NavGroup {
  label: string
  items: NavItem[]
}

// T10 Faz A1 — nav route → lisans feature anahtarı. Org planında modül
// EXPLICIT kapalıysa (features[key] === false) nav öğesi gizlenir. Backend
// router'ında da aynı anahtar require_feature ile gate'li — FE gizlese de
// API 403 döner. Buradaki anahtarlar backend FEATURES registry ile birebir.
const FEATURE_MAP: Record<string, string> = {
  '/topology': 'topology', '/topology-next': 'topology',
  '/topology-twin': 'topology_twin',
  '/ipam': 'ipam', '/firmware': 'firmware', '/poe': 'poe',
  '/config-builder': 'config_builder', '/config-drift': 'config_drift',
  '/sla': 'sla', '/synthetic-probes': 'synthetic_probes',
  '/incidents': 'incidents', '/escalation-rules': 'escalation',
  '/ai-assistant': 'ai_assistant', '/agents': 'agents',
  '/change-management': 'change_management', '/racks': 'racks',
  '/security-policies': 'security_policy',
}

const MODULE_MAP: Record<string, [string, string]> = {
  '/devices': ['devices', 'view'], '/topology': ['topology', 'view'],
  '/ipam': ['ipam', 'view'], '/backups': ['config_backups', 'view'],
  '/monitor': ['monitoring', 'view'], '/live': ['monitoring', 'view'], '/incidents': ['monitoring', 'view'],
  '/escalation-rules': ['monitoring', 'view'], '/bandwidth': ['monitoring', 'view'],
  '/mac-arp': ['monitoring', 'view'], '/security-audit': ['monitoring', 'view'],
  '/asset-lifecycle': ['monitoring', 'view'], '/tasks': ['tasks', 'view'],
  '/playbooks': ['playbooks', 'view'], '/config-templates': ['driver_templates', 'view'],
  '/config-builder': ['config_backups', 'view'],
  '/audit': ['audit_logs', 'view'], '/terminal-sessions': ['audit_logs', 'view'],
  '/reports': ['reports', 'view'],
  '/users': ['users', 'view'], '/locations': ['locations', 'view'],
  '/agents': ['agents', 'view'], '/driver-templates': ['driver_templates', 'view'],
  '/settings': ['settings', 'view'],
}

/** Tek kaynak nav data — Sidebar ve TopNav burayı çağırır. */
export function useNavGroups(): NavGroup[] {
  const { t } = useTranslation()
  const { user, isSuperAdmin, isOrgAdmin, can } = useAuthStore()
  const { features } = useSite()
  const isSA = isSuperAdmin()
  const isOA = isOrgAdmin()
  const userRoleIdx = roleIndex(user?.role ?? 'viewer')

  // T10 Faz A1 — feature (lisans) kapısı. Opt-out: anahtar yok / true →
  // göster; yalnız EXPLICIT false gizler. Super-admin'e context tüm
  // feature'ları true verir, dolayısıyla burada ekstra bypass gerekmez.
  const featureOk = (key?: string) => {
    if (!key) return true
    const feat = FEATURE_MAP[key]
    if (!feat) return true
    return features[feat] !== false
  }

  const canSee = (minRole?: SystemRole, key?: string) => {
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
        // T4.6 cutover — when V2 is canonical the primary 'Topoloji'
        // entry already routes to V2 (App.tsx route swap), so the
        // separate '/topology-next' chip is redundant; only show it
        // when V2 exists but isn't canonical yet (mid-rollout).
        { key: '/topology', icon: <ApartmentOutlined />, label: t('nav.topology') },
        ...(featureFlags.topologyV2 && !featureFlags.topologyV2Canonical
          ? [{ key: '/topology-next', icon: <ThunderboltOutlined />, label: 'Topology · Gold' }]
          : []),
        { key: '/devices', icon: <LaptopOutlined />, label: t('nav.devices') },
      ],
    },
    {
      label: t('nav_group.discovery'),
      items: [
        { key: '/discovery', icon: <RadarChartOutlined />, label: t('nav.discovery'), minRole: 'org_admin' },
        { key: '/ipam', icon: <ClusterOutlined />, label: t('nav.ipam'), minRole: 'viewer' },
        { key: '/vlan', icon: <BranchesOutlined />, label: t('nav.vlan'), minRole: 'viewer' },
        { key: '/backups', icon: <CloudOutlined />, label: t('nav.backups'), minRole: 'location_admin' },
        { key: '/config-drift', icon: <DiffOutlined />, label: 'Config Drift', minRole: 'viewer' },
        { key: '/compliance', icon: <FileDoneOutlined />, label: t('nav.compliance'), minRole: 'location_admin' },
        { key: '/racks', icon: <HddOutlined />, label: t('nav.racks'), minRole: 'org_admin' },
        { key: '/floor-plan', icon: <BuildOutlined />, label: t('nav.floor_plan'), minRole: 'org_admin' },
      ],
    },
    {
      label: t('nav_group.monitoring'),
      items: [
        { key: '/monitor', icon: <AlertOutlined />, label: t('nav.monitor'), badge: true, badgeCount: unacked },
        { key: '/live', icon: <ThunderboltOutlined />, label: 'Canlı İzleme', minRole: 'viewer' },
        { key: '/intelligence', icon: <BugOutlined />, label: 'Ağ Analitik', minRole: 'viewer' },
        { key: '/alert-rules', icon: <AlertOutlined />, label: t('nav.alert_rules'), minRole: 'org_admin' },
        { key: '/bandwidth', icon: <LineChartOutlined />, label: t('nav.bandwidth'), minRole: 'viewer' },
        { key: '/mac-arp', icon: <TableOutlined />, label: t('nav.port_intelligence'), minRole: 'viewer' },
        { key: '/security-audit', icon: <SafetyOutlined />, label: t('nav.security_audit'), minRole: 'viewer' },
        { key: '/security-policies', icon: <SafetyOutlined />, label: 'Güvenlik Politikaları', minRole: 'viewer' },
        { key: '/asset-lifecycle', icon: <CalendarOutlined />, label: t('nav.asset_lifecycle'), minRole: 'viewer' },
        { key: '/diagnostics', icon: <AimOutlined />, label: t('nav.diagnostics'), minRole: 'viewer' },
        { key: '/tasks', icon: <PlayCircleOutlined />, label: t('nav.tasks'), minRole: 'viewer' },
        { key: '/playbooks', icon: <ThunderboltOutlined />, label: t('nav.playbooks'), minRole: 'org_admin' },
        { key: '/config-templates', icon: <FileTextOutlined />, label: t('nav.config_templates'), minRole: 'org_admin' },
        { key: '/config-builder', icon: <BuildOutlined />, label: 'Easy Config Builder', minRole: 'org_admin' },
        { key: '/change-management', icon: <CalendarOutlined />, label: t('nav.change_management'), minRole: 'location_admin' },
        { key: '/approvals', icon: <SafetyOutlined />, label: t('nav.approvals'), badge: 'approval', badgeCount: approvalCount?.count ?? 0, minRole: 'location_admin' },
        { key: '/sla', icon: <RiseOutlined />, label: t('nav.sla'), minRole: 'viewer' },
        { key: '/poe', icon: <ThunderboltOutlined />, label: 'PoE / Enerji', minRole: 'viewer' },
        { key: '/firmware', icon: <CloudOutlined />, label: 'Firmware', minRole: 'org_admin' },
        { key: '/synthetic-probes', icon: <RadarChartOutlined />, label: 'Synthetic Probes', minRole: 'viewer' },
        { key: '/incidents', icon: <BugOutlined />, label: 'Incident RCA', minRole: 'viewer' },
        { key: '/escalation-rules', icon: <BellOutlined />, label: 'Escalation Kuralları', minRole: 'org_admin' },
        { key: '/services', icon: <ApartmentOutlined />, label: 'Servis Etki Haritası', minRole: 'viewer' },
        { key: '/topology-twin', icon: <ApartmentOutlined />, label: 'Network Digital Twin', minRole: 'location_admin' },
        { key: '/reports', icon: <BarChartOutlined />, label: t('nav.reports'), minRole: 'viewer' },
      ],
    },
    {
      label: t('nav_group.management'),
      items: [
        ...(isSA ? [{ key: '/superadmin', icon: <GlobalOutlined />, label: '⚙ Platform Paneli', minRole: 'super_admin' as SystemRole }] : []),
        ...(isOA && !isSA ? [{ key: '/org-admin', icon: <GlobalOutlined />, label: '⚙ Organizasyon Paneli', minRole: 'org_admin' as SystemRole }] : []),
        { key: '/permissions', icon: <SafetyOutlined />, label: 'Yetki Yönetimi', minRole: 'org_admin' as SystemRole },
        { key: '/ai-assistant', icon: <RobotOutlined />, label: 'AI Ağ Asistanı', minRole: 'org_admin' },
        { key: '/agents', icon: <RobotOutlined />, label: t('nav.agents'), minRole: 'org_admin' },
        { key: '/users', icon: <TeamOutlined />, label: t('nav.users'), minRole: 'org_admin' },
        { key: '/locations', icon: <EnvironmentOutlined />, label: t('nav.locations'), minRole: 'org_admin' },
        { key: '/audit', icon: <AuditOutlined />, label: t('nav.audit'), minRole: 'viewer' },
        { key: '/terminal-sessions', icon: <AuditOutlined />, label: 'SSH Oturum Audit', minRole: 'viewer' },
        { key: '/driver-templates', icon: <CodeOutlined />, label: t('nav.driver_templates'), minRole: 'org_admin' },
        { key: '/help', icon: <QuestionCircleOutlined />, label: t('nav.help') },
        { key: '/settings', icon: <SettingOutlined />, label: t('nav.settings'), minRole: 'org_admin' },
      ],
    },
  ]

  // Role/permission + feature (lisans) filtresi — boş gruplar atılır.
  return GROUPS.map((g) => ({ ...g, items: g.items.filter((it) => canSee(it.minRole, it.key) && featureOk(it.key)) }))
    .filter((g) => g.items.length > 0)
}
