import { useState, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { App as AntApp, ConfigProvider, theme } from 'antd'
import trTR from 'antd/locale/tr_TR'
import enUS from 'antd/locale/en_US'
import ruRU from 'antd/locale/ru_RU'
import deDE from 'antd/locale/de_DE'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/tr'
import i18n from './i18n'

import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext'
import { SiteProvider } from '@/contexts/SiteContext'
import { useAuthStore } from '@/store/auth'
import { authApi } from '@/api/auth'
import AppLayout from '@/components/Layout/AppLayout'
import LoginPage from '@/pages/Login'
import DashboardPage from '@/pages/Dashboard'
import DevicesPage from '@/pages/Devices'
import TasksPage from '@/pages/Tasks'
import UsersPage from '@/pages/Users'
import AuditLogPage from '@/pages/AuditLog'
import MonitorPage from '@/pages/Monitor'
import TopologyPage from '@/pages/Topology'
import LldpInventoryPage from '@/pages/LldpInventory'
import AgentsPage from '@/pages/Agents'
import ReportsPage from '@/pages/Reports'
import SettingsPage from '@/pages/Settings'
import PlaybooksPage from '@/pages/Playbooks'
import ApprovalsPage from '@/pages/Approvals'
import MacArpPage from '@/pages/MacArp'
import IpamPage from '@/pages/Ipam'
import SecurityAuditPage from '@/pages/SecurityAudit'
import AssetLifecyclePage from '@/pages/AssetLifecycle'
import DiagnosticsPage from '@/pages/Diagnostics'
import BandwidthMonitorPage from '@/pages/BandwidthMonitor'
import ConfigTemplatesPage from '@/pages/ConfigTemplates'
import ChangeManagementPage from '@/pages/ChangeManagement'
import SlaReportPage from '@/pages/SlaReport'
import VlanManagementPage from '@/pages/VlanManagement'
import BackupCenterPage from '@/pages/BackupCenter'
import ConfigDriftPage from '@/pages/ConfigDrift'
import IntelligencePage from '@/pages/Intelligence'
import ComplianceCheckPage from '@/pages/ComplianceCheck'
import RacksPage from '@/pages/Racks'
import TenantsPage from '@/pages/Tenants'
import LocationsPage from '@/pages/Locations'
import FloorPlanPage from '@/pages/FloorPlan'
import AlertRulesPage from '@/pages/AlertRules'
import DriverTemplatesPage from '@/pages/DriverTemplates'
import HelpPage from '@/pages/Help'
import ServicesPage from '@/pages/Services'
import TopologyTwinPage from '@/pages/TopologyTwin'
import AIAssistantPage from '@/pages/AIAssistant'
import SuperAdminPage from '@/pages/SuperAdmin'
import OrgAdminPage from '@/pages/OrgAdmin'
import PermissionsPage from '@/pages/Permissions'
import InviteAcceptPage from '@/pages/InviteAccept'
import SyntheticProbesPage from '@/pages/SyntheticProbes'

dayjs.extend(relativeTime)
dayjs.locale('tr')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000 },
  },
})

const DARK_TOKENS = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#3b82f6',
    colorBgBase: '#030c1e',
    colorBgContainer: '#0e1e38',
    colorBgElevated: '#0e1e38',
    colorBgLayout: '#030c1e',
    colorBorder: '#1a3458',
    colorBorderSecondary: '#112240',
    colorText: '#f1f5f9',
    colorTextSecondary: '#94a3b8',
    colorTextTertiary: '#64748b',
    borderRadius: 8,
  },
  components: {
    Layout: { siderBg: '#030c1e', headerBg: '#030c1e', bodyBg: '#030c1e' },
    Menu: { darkItemBg: '#030c1e', darkSubMenuItemBg: '#030c1e', darkItemSelectedBg: '#1d4ed8', darkItemHoverBg: '#0e1e38' },
    Card: { colorBgContainer: '#0e1e38', colorBorderSecondary: '#1a3458' },
    Table: { colorBgContainer: '#0e1e38', headerBg: '#071224', rowHoverBg: '#122040' },
    Modal: { contentBg: '#0e1e38', headerBg: '#0e1e38', footerBg: '#0e1e38' },
    Drawer: { colorBgElevated: '#0e1e38' },
    Select: { colorBgContainer: '#0e1e38', colorBgElevated: '#0e1e38' },
    Input: { colorBgContainer: '#0e1e38', colorBorder: '#1a3458' },
    Tabs: { colorBorderSecondary: '#1a3458' },
    Popover: { colorBgElevated: '#0e1e38' },
    Tooltip: { colorBgSpotlight: '#1a3458' },
    Segmented: { itemSelectedBg: '#3b82f6' },
  },
}

const LIGHT_TOKENS = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#3b82f6',
    borderRadius: 8,
  },
}

const ANTD_LOCALES: Record<string, object> = {
  tr: trTR,
  en: enUS,
  ru: ruRU,
  de: deDE,
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuthStore()
  return token ? <>{children}</> : <Navigate to="/login" replace />
}

// Role hierarchy order — same as auth store
const ROLE_ORDER = [
  'location_viewer', 'viewer', 'location_operator', 'operator',
  'location_manager', 'org_viewer', 'admin', 'super_admin',
] as const

function RoleRoute({ children, minRole }: { children: React.ReactNode; minRole: string }) {
  const { user } = useAuthStore()
  const userIdx = ROLE_ORDER.indexOf((user?.role ?? 'viewer') as any)
  const reqIdx  = ROLE_ORDER.indexOf(minRole as any)
  if (userIdx < reqIdx) return <Navigate to="/" replace />
  return <>{children}</>
}

// Permission-based route guard — mirrors the sidebar MODULE_MAP check.
// Allows access when can(module, action) is true (which already handles SA/OrgAdmin bypass).
function PermRoute({ children, module, action }: { children: React.ReactNode; module: string; action: string }) {
  const { can } = useAuthStore()
  return can(module, action) ? <>{children}</> : <Navigate to="/" replace />
}

const GLOBAL_CSS_DARK = `
  :root { color-scheme: dark; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: #030c1e; }
  ::-webkit-scrollbar-thumb { background: #1a3458; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #234870; }
  ::selection { background: #3b82f640; color: #f1f5f9; }
  .ant-card { transition: box-shadow 0.2s, border-color 0.2s; }
  .ant-card:hover { box-shadow: 0 4px 20px rgba(59,130,246,0.08) !important; }
  .ant-table-row { transition: background 0.1s; }
  .ant-btn-primary { box-shadow: 0 0 12px rgba(59,130,246,0.25) !important; }
  .ant-table-placeholder { background: transparent !important; }
  .ant-table-placeholder .ant-empty-description { color: #475569 !important; }
  .ant-table-placeholder .ant-empty-image svg { opacity: 0.25; }
  .ant-table-placeholder td { border-bottom: none !important; }
  .perm-user-row td { border-bottom: 1px solid #112240 !important; }
  .perm-user-row:last-child td { border-bottom: none !important; }
  .ant-modal-content { background: #0e1e38 !important; border: 1px solid #1a3458 !important; }
  .ant-modal-header { background: #0e1e38 !important; border-bottom: 1px solid #1a3458 !important; }
  .ant-modal-footer { border-top: 1px solid #1a3458 !important; }
  .ant-modal-title { color: #f1f5f9 !important; }
  .ant-select-dropdown { background: #0e1e38 !important; border: 1px solid #1a3458 !important; }
  .ant-select-item { color: #94a3b8 !important; }
  .ant-select-item-option-active { background: #122040 !important; }
  .ant-select-item-option-selected { background: #1d4ed820 !important; color: #3b82f6 !important; }
  .ant-select-dropdown .ant-empty-description { color: #475569 !important; }
`

const GLOBAL_CSS_LIGHT = `
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: #f1f5f9; }
  ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
  ::selection { background: #3b82f630; }
  .ant-card { transition: box-shadow 0.2s, border-color 0.2s; }
  .ant-btn-primary { box-shadow: 0 0 12px rgba(59,130,246,0.15) !important; }
`

function ThemedApp() {
  const { isDark } = useTheme()
  const [antdLocale, setAntdLocale] = useState(ANTD_LOCALES[i18n.language] || trTR)
  const { token, setAuth, user } = useAuthStore()

  // Re-fetch permissions on every app load so stale/null localStorage entries get refreshed
  useEffect(() => {
    if (!token || !user) return
    authApi.myPermissions().then((res) => {
      setAuth(token, user, res.permissions)
    }).catch(() => {/* silently ignore — server unreachable */})
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handler = (lng: string) => {
      setAntdLocale(ANTD_LOCALES[lng] || trTR)
    }
    i18n.on('languageChanged', handler)
    return () => i18n.off('languageChanged', handler)
  }, [])

  return (
    <ConfigProvider locale={antdLocale as any} theme={isDark ? DARK_TOKENS : LIGHT_TOKENS}>
      <style>{isDark ? GLOBAL_CSS_DARK : GLOBAL_CSS_LIGHT}</style>
      <AntApp>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/invite" element={<InviteAcceptPage />} />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="devices" element={<DevicesPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="topology" element={<TopologyPage />} />
              <Route path="discovery" element={<RoleRoute minRole="admin"><LldpInventoryPage /></RoleRoute>} />
              <Route path="monitor" element={<MonitorPage />} />
              <Route path="reports" element={<PermRoute module="reports" action="view"><ReportsPage /></PermRoute>} />
              <Route path="users" element={<PermRoute module="users" action="view"><UsersPage /></PermRoute>} />
              <Route path="audit" element={<PermRoute module="audit_logs" action="view"><AuditLogPage /></PermRoute>} />
              <Route path="agents" element={<PermRoute module="agents" action="view"><AgentsPage /></PermRoute>} />
              <Route path="settings" element={<PermRoute module="settings" action="view"><SettingsPage /></PermRoute>} />
              <Route path="playbooks" element={<PermRoute module="playbooks" action="view"><PlaybooksPage /></PermRoute>} />
              <Route path="approvals" element={<RoleRoute minRole="location_manager"><ApprovalsPage /></RoleRoute>} />
              <Route path="mac-arp" element={<PermRoute module="monitoring" action="view"><MacArpPage /></PermRoute>} />
              <Route path="ipam" element={<PermRoute module="ipam" action="view"><IpamPage /></PermRoute>} />
              <Route path="security-audit" element={<PermRoute module="monitoring" action="view"><SecurityAuditPage /></PermRoute>} />
              <Route path="asset-lifecycle" element={<PermRoute module="monitoring" action="view"><AssetLifecyclePage /></PermRoute>} />
              <Route path="diagnostics" element={<RoleRoute minRole="operator"><DiagnosticsPage /></RoleRoute>} />
              <Route path="bandwidth" element={<PermRoute module="monitoring" action="view"><BandwidthMonitorPage /></PermRoute>} />
              <Route path="config-templates" element={<PermRoute module="driver_templates" action="view"><ConfigTemplatesPage /></PermRoute>} />
              <Route path="change-management" element={<RoleRoute minRole="location_manager"><ChangeManagementPage /></RoleRoute>} />
              <Route path="sla" element={<RoleRoute minRole="org_viewer"><SlaReportPage /></RoleRoute>} />
              <Route path="vlan" element={<RoleRoute minRole="org_viewer"><VlanManagementPage /></RoleRoute>} />
              <Route path="backups" element={<PermRoute module="config_backups" action="view"><BackupCenterPage /></PermRoute>} />
              <Route path="config-drift" element={<RoleRoute minRole="org_viewer"><ConfigDriftPage /></RoleRoute>} />
              <Route path="intelligence" element={<RoleRoute minRole="org_viewer"><IntelligencePage /></RoleRoute>} />
              <Route path="compliance" element={<RoleRoute minRole="location_manager"><ComplianceCheckPage /></RoleRoute>} />
              <Route path="racks" element={<RoleRoute minRole="admin"><RacksPage /></RoleRoute>} />
              <Route path="tenants" element={<RoleRoute minRole="super_admin"><TenantsPage /></RoleRoute>} />
              <Route path="locations" element={<PermRoute module="locations" action="view"><LocationsPage /></PermRoute>} />
              <Route path="floor-plan" element={<RoleRoute minRole="admin"><FloorPlanPage /></RoleRoute>} />
              <Route path="alert-rules" element={<RoleRoute minRole="admin"><AlertRulesPage /></RoleRoute>} />
              <Route path="driver-templates" element={<PermRoute module="driver_templates" action="view"><DriverTemplatesPage /></PermRoute>} />
              <Route path="help" element={<HelpPage />} />
              <Route path="services" element={<RoleRoute minRole="org_viewer"><ServicesPage /></RoleRoute>} />
              <Route path="topology-twin" element={<RoleRoute minRole="location_manager"><TopologyTwinPage /></RoleRoute>} />
              <Route path="ai-assistant" element={<RoleRoute minRole="admin"><AIAssistantPage /></RoleRoute>} />
              <Route path="superadmin" element={<RoleRoute minRole="super_admin"><SuperAdminPage /></RoleRoute>} />
              <Route path="org-admin" element={<RoleRoute minRole="admin"><OrgAdminPage /></RoleRoute>} />
              <Route path="permissions" element={<RoleRoute minRole="admin"><PermissionsPage /></RoleRoute>} />
              <Route path="synthetic-probes" element={<PermRoute module="monitoring" action="view"><SyntheticProbesPage /></PermRoute>} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <SiteProvider>
            <ThemedApp />
          </SiteProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
