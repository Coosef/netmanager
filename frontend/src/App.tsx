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

import { ThemeProvider, useTheme } from '@/contexts/ThemeContext'
import { SiteProvider } from '@/contexts/SiteContext'
import { useAuthStore } from '@/store/auth'
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
import ComplianceCheckPage from '@/pages/ComplianceCheck'
import RacksPage from '@/pages/Racks'
import TenantsPage from '@/pages/Tenants'
import LocationsPage from '@/pages/Locations'
import FloorPlanPage from '@/pages/FloorPlan'
import AlertRulesPage from '@/pages/AlertRules'
import DriverTemplatesPage from '@/pages/DriverTemplates'
import HelpPage from '@/pages/Help'

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
              <Route path="discovery" element={<LldpInventoryPage />} />
              <Route path="monitor" element={<MonitorPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="audit" element={<AuditLogPage />} />
              <Route path="agents" element={<AgentsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="playbooks" element={<PlaybooksPage />} />
              <Route path="approvals" element={<ApprovalsPage />} />
              <Route path="mac-arp" element={<MacArpPage />} />
              <Route path="ipam" element={<IpamPage />} />
              <Route path="security-audit" element={<SecurityAuditPage />} />
              <Route path="asset-lifecycle" element={<AssetLifecyclePage />} />
              <Route path="diagnostics" element={<DiagnosticsPage />} />
              <Route path="bandwidth" element={<BandwidthMonitorPage />} />
              <Route path="config-templates" element={<ConfigTemplatesPage />} />
              <Route path="change-management" element={<ChangeManagementPage />} />
              <Route path="sla" element={<SlaReportPage />} />
              <Route path="vlan" element={<VlanManagementPage />} />
              <Route path="backups" element={<BackupCenterPage />} />
              <Route path="compliance" element={<ComplianceCheckPage />} />
              <Route path="racks" element={<RacksPage />} />
              <Route path="tenants" element={<TenantsPage />} />
              <Route path="locations" element={<LocationsPage />} />
              <Route path="floor-plan" element={<FloorPlanPage />} />
              <Route path="alert-rules" element={<AlertRulesPage />} />
              <Route path="driver-templates" element={<DriverTemplatesPage />} />
              <Route path="help" element={<HelpPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SiteProvider>
          <ThemedApp />
        </SiteProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
