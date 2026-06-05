import { useState, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { App as AntApp, ConfigProvider, theme } from 'antd'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
// LANG-INFRA: dayjs locale paketleri + AntD locale registry + dayjs.locale()
// otomatik switch i18n/ modülünün içine alındı. App.tsx artık yeni dil
// ekleme sürecinde dokunulmaz.
import i18n, { getAntdLocale } from './i18n'

import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext'
import { CustomizeProvider } from '@/contexts/CustomizeContext'
import { SiteProvider } from '@/contexts/SiteContext'
import { useAuthStore } from '@/store/auth'
import { authApi } from '@/api/auth'
import AppLayout from '@/components/Layout/AppLayout'
import LoginPage from '@/pages/Login'
import DashboardPage from '@/pages/Dashboard'
import DevicesPage from '@/pages/Devices'
import DeviceDetailPage from '@/pages/Devices/DeviceDetailPage'
// T10 C7.B — eski /devices/:id/ports yeni Detail sayfasındaki Ports sekmesine yönlendir.
function RedirectToPortsTab() {
  const { deviceId } = useParams<{ deviceId: string }>()
  return <Navigate to={`/devices/${deviceId}?tab=ports`} replace />
}
import TasksPage from '@/pages/Tasks'
import UsersPage from '@/pages/Users'
import AuditLogPage from '@/pages/AuditLog'
import TerminalSessionsPage from '@/pages/TerminalSessions'
// T10 C7.B — DevicePortsPage artık doğrudan route'lanmıyor (eski /ports yolu Detail
// sayfasındaki ?tab=ports'a redirect). Mevcut sayfa dosyası kalır; içeriği C7.C'de
// Detail Page Ports sekmesinde embed/yeniden kullanılacak.
import MonitorPage from '@/pages/Monitor'
import LiveMonitorPage from '@/pages/LiveMonitor'
import TopologyPage from '@/pages/Topology'
import TopologyV2Page from '@/pages/TopologyV2'
import { featureFlags } from '@/config/featureFlags'
import LldpInventoryPage from '@/pages/LldpInventory'
import AgentsPage from '@/pages/Agents'
import ReportsPage from '@/pages/Reports'
import SettingsPage from '@/pages/Settings'
import ProfilePage from '@/pages/Profile'
import PlaybooksPage from '@/pages/Playbooks'
import ApprovalsPage from '@/pages/Approvals'
import MacArpPage from '@/pages/MacArp'
import IpamPage from '@/pages/Ipam'
import SecurityAuditPage from '@/pages/SecurityAudit'
import AssetLifecyclePage from '@/pages/AssetLifecycle'
import DiagnosticsPage from '@/pages/Diagnostics'
import BandwidthMonitorPage from '@/pages/BandwidthMonitor'
import ConfigTemplatesPage from '@/pages/ConfigTemplates'
import ConfigBuilderPage from '@/pages/ConfigBuilder'
import PoeDashboardPage from '@/pages/PoeDashboard'
import FirmwarePage from '@/pages/Firmware'
import ChangeManagementPage from '@/pages/ChangeManagement'
import SlaReportPage from '@/pages/SlaReport'
import VlanManagementPage from '@/pages/VlanManagement'
import BackupCenterPage from '@/pages/BackupCenter'
import ConfigDriftPage from '@/pages/ConfigDrift'
import IntelligencePage from '@/pages/Intelligence'
import ComplianceCheckPage from '@/pages/ComplianceCheck'
import RacksPage from '@/pages/Racks'
import LocationsPage from '@/pages/Locations'
import FloorPlanPage from '@/pages/FloorPlan'
import AlertRulesPage from '@/pages/AlertRules'
import SecurityPoliciesPage from '@/pages/SecurityPolicies'
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
import IncidentsPage from '@/pages/Incidents'
import SshTerminalPage from '@/pages/SshTerminalPage'
import EscalationRulesPage from '@/pages/EscalationRules'

dayjs.extend(relativeTime)
// LANG-INFRA: dayjs.locale() artık i18n modülünün içindeki languageChanged
// listener'ı tarafından yönetiliyor (init + dil değişimi otomatik).

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30000 },
  },
})

// T8.4 — dark theme retuned to the NOC design palette (canvas #070b18,
// panels #0e1729, borders #1c2538, teal accent #22d3c5) + IBM Plex Sans.
const NOC_FONT = "'IBM Plex Sans', system-ui, -apple-system, sans-serif"
// Dark tokens — netmanager/project/styles.css'ten oklch değerlerinin
// yaklaşık hex karşılıkları. noc.css'in :root --bg-X tokenleriyle senkron.
// oklch(0.16 0.012 250) ≈ #21262e (page); 0.19/0.22/0.26 katman.
const DARK_TOKENS = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#3b82f6',
    colorInfo: '#22d3c5',
    colorBgBase: '#21262e',
    colorBgContainer: '#272d36',
    colorBgElevated: '#272d36',
    colorBgLayout: '#21262e',
    colorBorder: '#3b4250',
    colorBorderSecondary: '#323843',
    colorText: '#e5e7eb',
    colorTextSecondary: '#9ca3af',
    colorTextTertiary: '#6b7280',
    borderRadius: 8,
    fontFamily: NOC_FONT,
  },
  components: {
    Layout: { siderBg: '#272d36', headerBg: '#272d36', bodyBg: '#21262e' },
    Menu: {
      darkItemBg: '#272d36', darkSubMenuItemBg: '#272d36',
      darkItemSelectedBg: 'rgba(59,130,246,0.20)', darkItemSelectedColor: '#60a5fa',
      darkItemHoverBg: '#2d343f',
    },
    Card: { colorBgContainer: '#272d36', colorBorderSecondary: '#3b4250' },
    Table: { colorBgContainer: '#272d36', headerBg: '#21262e', rowHoverBg: '#2d343f' },
    Modal: { contentBg: '#272d36', headerBg: '#272d36', footerBg: '#272d36' },
    Drawer: { colorBgElevated: '#272d36' },
    Select: { colorBgContainer: '#272d36', colorBgElevated: '#272d36' },
    Input: { colorBgContainer: '#272d36', colorBorder: '#3b4250' },
    Tabs: { colorBorderSecondary: '#3b4250' },
    Popover: { colorBgElevated: '#272d36' },
    Tooltip: { colorBgSpotlight: '#3b4250' },
    Segmented: { itemSelectedBg: '#3b82f6' },
  },
}

const LIGHT_TOKENS = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#3b82f6',
    borderRadius: 8,
    fontFamily: NOC_FONT,
  },
}

// LANG-INFRA: ANTD_LOCALES hardcoded map kaldırıldı. AntD locale registry
// `frontend/src/i18n/antdLocales.ts` dosyasında. `getAntdLocale(code)` ile
// alınır; yeni dil için App.tsx dokunulmaz.

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

// GLOBAL_CSS_DARK — DARK_TOKENS ile aynı palet. Orijinal NOC tasarımı
// (netmanager styles.css) oklch(0.16/0.19/0.22/0.26 0.012-0.014 250)
// → hex #21262e / #272d36 / #2d343f / #353d49.
const GLOBAL_CSS_DARK = `
  :root { color-scheme: dark; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: #21262e; }
  ::-webkit-scrollbar-thumb { background: #3b4250; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #4a5263; }
  ::selection { background: #22d3c540; color: #e5e7eb; }
  .ant-card { transition: box-shadow 0.2s, border-color 0.2s; }
  .ant-card:hover { box-shadow: 0 4px 20px rgba(34,211,197,0.08) !important; }
  .ant-table-row { transition: background 0.1s; }
  .ant-btn-primary { box-shadow: 0 0 12px rgba(59,130,246,0.25) !important; }
  .ant-table-placeholder { background: transparent !important; }
  .ant-table-placeholder .ant-empty-description { color: #6b7280 !important; }
  .ant-table-placeholder .ant-empty-image svg { opacity: 0.25; }
  .ant-table-placeholder td { border-bottom: none !important; }
  .perm-user-row td { border-bottom: 1px solid #323843 !important; }
  .perm-user-row:last-child td { border-bottom: none !important; }
  .ant-modal-content { background: #272d36 !important; border: 1px solid #3b4250 !important; }
  .ant-modal-header { background: #272d36 !important; border-bottom: 1px solid #3b4250 !important; }
  .ant-modal-footer { border-top: 1px solid #3b4250 !important; }
  .ant-modal-title { color: #e5e7eb !important; }
  .ant-select-dropdown { background: #272d36 !important; border: 1px solid #3b4250 !important; }
  .ant-select-item { color: #9ca3af !important; }
  .ant-select-item-option-active { background: #2d343f !important; }
  .ant-select-item-option-selected { background: #1d4ed820 !important; color: #60a5fa !important; }
  .ant-select-dropdown .ant-empty-description { color: #6b7280 !important; }
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
  const [antdLocale, setAntdLocale] = useState(getAntdLocale(i18n.language))
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
      setAntdLocale(getAntdLocale(lng))
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
            <Route path="/ssh/:deviceId" element={<ProtectedRoute><SshTerminalPage /></ProtectedRoute>} />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="devices" element={<DevicesPage />} />
              {/* T10 C7.B — kalıcı Device Detail sayfası (sekmeli). */}
              <Route path="devices/:deviceId" element={<RoleRoute minRole="viewer"><DeviceDetailPage /></RoleRoute>} />
              <Route path="tasks" element={<TasksPage />} />
              {/* T4.6 cutover — V2 canonical at /topology when the flag is on.
                  /topology-classic is a permanent kill-switch / escape hatch:
                  the legacy React Flow page is always reachable by URL even
                  when the flag flips on, so operators with muscle memory
                  can still get the old view if V2 surfaces an unexpected
                  issue. /topology-next stays as the explicit "next" alias
                  so any deep links still work. */}
              <Route path="topology"
                element={featureFlags.topologyV2Canonical ? <TopologyV2Page /> : <TopologyPage />} />
              <Route path="topology-classic" element={<TopologyPage />} />
              <Route path="topology-next" element={<TopologyV2Page />} />
              <Route path="discovery" element={<RoleRoute minRole="admin"><LldpInventoryPage /></RoleRoute>} />
              <Route path="monitor" element={<MonitorPage />} />
              <Route path="live" element={<PermRoute module="monitoring" action="view"><LiveMonitorPage /></PermRoute>} />
              <Route path="reports" element={<PermRoute module="reports" action="view"><ReportsPage /></PermRoute>} />
              <Route path="users" element={<PermRoute module="users" action="view"><UsersPage /></PermRoute>} />
              <Route path="audit" element={<PermRoute module="audit_logs" action="view"><AuditLogPage /></PermRoute>} />
              <Route path="terminal-sessions" element={<PermRoute module="audit_logs" action="view"><TerminalSessionsPage /></PermRoute>} />
              {/* T10 C7.B — eski ports route'unu yeni Detail sayfasındaki Ports sekmesine yönlendir
                  (eski bookmark'lar kırılmaz). Gerçek Ports sekmesi içeriği C7.C'de gelecek. */}
              <Route path="devices/:deviceId/ports" element={<RedirectToPortsTab />} />
              <Route path="agents" element={<PermRoute module="agents" action="view"><AgentsPage /></PermRoute>} />
              <Route path="settings" element={<PermRoute module="settings" action="view"><SettingsPage /></PermRoute>} />
              {/* Profil — her authenticated kullanıcı kendi sayfası. Permission
                  gate yok; içerideki /users/me endpoint'leri zaten self-only. */}
              <Route path="profile" element={<ProfilePage />} />
              <Route path="playbooks" element={<PermRoute module="playbooks" action="view"><PlaybooksPage /></PermRoute>} />
              <Route path="approvals" element={<RoleRoute minRole="location_manager"><ApprovalsPage /></RoleRoute>} />
              <Route path="mac-arp" element={<PermRoute module="monitoring" action="view"><MacArpPage /></PermRoute>} />
              <Route path="ipam" element={<PermRoute module="ipam" action="view"><IpamPage /></PermRoute>} />
              <Route path="security-audit" element={<PermRoute module="monitoring" action="view"><SecurityAuditPage /></PermRoute>} />
              <Route path="asset-lifecycle" element={<PermRoute module="monitoring" action="view"><AssetLifecyclePage /></PermRoute>} />
              <Route path="diagnostics" element={<RoleRoute minRole="operator"><DiagnosticsPage /></RoleRoute>} />
              <Route path="bandwidth" element={<PermRoute module="monitoring" action="view"><BandwidthMonitorPage /></PermRoute>} />
              <Route path="config-templates" element={<PermRoute module="driver_templates" action="view"><ConfigTemplatesPage /></PermRoute>} />
              <Route path="config-builder" element={<PermRoute module="config_backups" action="view"><ConfigBuilderPage /></PermRoute>} />
              <Route path="poe" element={<RoleRoute minRole="org_viewer"><PoeDashboardPage /></RoleRoute>} />
              <Route path="firmware" element={<RoleRoute minRole="org_admin"><FirmwarePage /></RoleRoute>} />
              <Route path="change-management" element={<RoleRoute minRole="location_manager"><ChangeManagementPage /></RoleRoute>} />
              <Route path="sla" element={<RoleRoute minRole="org_viewer"><SlaReportPage /></RoleRoute>} />
              <Route path="vlan" element={<RoleRoute minRole="org_viewer"><VlanManagementPage /></RoleRoute>} />
              <Route path="backups" element={<PermRoute module="config_backups" action="view"><BackupCenterPage /></PermRoute>} />
              <Route path="config-drift" element={<RoleRoute minRole="org_viewer"><ConfigDriftPage /></RoleRoute>} />
              <Route path="intelligence" element={<RoleRoute minRole="org_viewer"><IntelligencePage /></RoleRoute>} />
              <Route path="compliance" element={<RoleRoute minRole="location_manager"><ComplianceCheckPage /></RoleRoute>} />
              <Route path="racks" element={<RoleRoute minRole="admin"><RacksPage /></RoleRoute>} />
              {/* M6 final drop — the standalone `/tenants` page is gone. */}
              <Route path="locations" element={<PermRoute module="locations" action="view"><LocationsPage /></PermRoute>} />
              <Route path="floor-plan" element={<RoleRoute minRole="admin"><FloorPlanPage /></RoleRoute>} />
              <Route path="alert-rules" element={<RoleRoute minRole="admin"><AlertRulesPage /></RoleRoute>} />
              <Route path="security-policies" element={<RoleRoute minRole="viewer"><SecurityPoliciesPage /></RoleRoute>} />
              <Route path="driver-templates" element={<PermRoute module="driver_templates" action="view"><DriverTemplatesPage /></PermRoute>} />
              <Route path="help" element={<HelpPage />} />
              <Route path="services" element={<RoleRoute minRole="org_viewer"><ServicesPage /></RoleRoute>} />
              <Route path="topology-twin" element={<RoleRoute minRole="location_manager"><TopologyTwinPage /></RoleRoute>} />
              <Route path="ai-assistant" element={<RoleRoute minRole="admin"><AIAssistantPage /></RoleRoute>} />
              <Route path="superadmin" element={<RoleRoute minRole="super_admin"><SuperAdminPage /></RoleRoute>} />
              <Route path="org-admin" element={<RoleRoute minRole="admin"><OrgAdminPage /></RoleRoute>} />
              <Route path="permissions" element={<RoleRoute minRole="admin"><PermissionsPage /></RoleRoute>} />
              <Route path="synthetic-probes" element={<PermRoute module="monitoring" action="view"><SyntheticProbesPage /></PermRoute>} />
              <Route path="incidents" element={<PermRoute module="monitoring" action="view"><IncidentsPage /></PermRoute>} />
              <Route path="escalation-rules" element={<RoleRoute minRole="admin"><EscalationRulesPage /></RoleRoute>} />
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
          <CustomizeProvider>
            <SiteProvider>
              <ThemedApp />
            </SiteProvider>
          </CustomizeProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
