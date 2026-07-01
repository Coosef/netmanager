import { useState, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { App as AntApp, ConfigProvider, theme } from 'antd'
import { QueryClientProvider } from '@tanstack/react-query'
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
import { AIAssistantProvider } from '@/contexts/AIAssistantContext'
import AIAssistantDrawer from '@/components/AIAssistantDrawer'
import { useAuthStore } from '@/store/auth'
import { useHasHydrated } from '@/hooks/useHasHydrated'
import type { SystemRole } from '@/types'
import { authApi } from '@/api/auth'
import AppLayout from '@/components/Layout/AppLayout'
import LoginPage from '@/pages/Login'
import DashboardPage from '@/pages/Dashboard'
import RootRedirect from '@/routes/RootRedirect'
import ProtectedRouteLoading from '@/routes/ProtectedRouteLoading'
import PlatformShell from '@/routes/PlatformShell'
import OrgRouteShell from '@/routes/OrgRouteShell'
import LegacyRedirect from '@/routes/LegacyRedirect'
import PlatformOverviewPage from '@/pages/Platform/PlatformOverviewPage'
import PlatformOrganizationsPage from '@/pages/Platform/PlatformOrganizationsPage'
import PlatformOrganizationDetailPage from '@/pages/Platform/PlatformOrganizationDetailPage'
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

// P0.2 (2026-06-24) — single QueryClient instance moved to
// `@/lib/queryClient` so the auth store's `logout` action can invalidate
// cached context queries without crossing the React/non-React boundary
// the inline declaration created. Same defaults, same provider wiring.
import { queryClient } from '@/lib/queryClient'

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
  // AUTH-GUARD-TOKEN-FIRST-FIX (2026-06-10) — token-first karar matrisi.
  //
  // Eski mimari (PR #47 hidrasyon hotfix):
  //   if (!hydrated) return null
  //   return token ? children : <Navigate to="/login">
  //
  // Problem: Login submit sonrası setAuth store'a token yazar AMA
  // `useHasHydrated()` Login → Dashboard navigate'i sırasında bir nedenle
  // false kalabiliyor (Zustand persist `hasHydrated()` API'sinin chunked
  // load veya React Router navigate timing race). `null` döndüğünde
  // AppLayout MOUNT OLMUYORDU — kullanıcı blank screen görüyordu (canlı
  // browser raporu: URL=/dashboard, token=var, rootText="", dashboardVisible=false).
  //
  // Yeni token-first matris:
  //   token VAR              → children (hydrated bağımsız — store
  //                             gerçeği authoritative)
  //   token YOK + !hydrated  → görünür <ProtectedRouteLoading> (blank YOK)
  //   token YOK + hydrated   → <Navigate to="/login">
  //
  // Temel kural: token store'da mevcutken auth guard'ın kullanıcıyı
  // bloklaması YASAK.
  const hydrated = useHasHydrated()
  const token = useAuthStore((s) => s.token)
  if (token) return <>{children}</>
  if (!hydrated) return <ProtectedRouteLoading />
  return <Navigate to="/login" replace />
}

// Sprint 1A — RBAC canonical 4-role alignment. Legacy 8-rol ROLE_ORDER
// kaldırıldı; tek doğruluk kaynağı `store/auth.ts` (hasPermission).
//
// `minRole`: minimum gerekli canonical rol (auth.ts SystemRole). Yazım
// hatalı / legacy literal verilirse normalizeRole canonical'a çevirir,
// indexOf=-1 kalırsa defansif guard fail-closed döner.
//
// `excludeRoles` (opsiyonel): canonical rolleri açıkça hariç tutar —
// hiyerarşi gerekçesini bypass eder. /org-admin için super_admin URL'i
// kapatmak amacıyla eklendi (menü zaten gizli); büyük refactor değil,
// minimal prop.
function RoleRoute({ children, minRole, excludeRoles }: {
  children: React.ReactNode
  minRole: SystemRole
  excludeRoles?: SystemRole[]
}) {
  const hasPermission = useAuthStore((s) => s.hasPermission)
  const systemRole = useAuthStore((s) => s.user?.system_role)
  if (excludeRoles && systemRole && excludeRoles.includes(systemRole)) {
    return <Navigate to="/" replace />
  }
  return hasPermission(minRole) ? <>{children}</> : <Navigate to="/" replace />
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
  const hydrated = useHasHydrated()

  // Re-fetch permissions on every app load so stale/null localStorage entries
  // get refreshed. AUTH-PERSIST-HYDRATION-HOTFIX — `hydrated` artık Zustand
  // persist'in kendi flag'inden okunur, store state alanı race açmaz.
  useEffect(() => {
    if (!hydrated || !token || !user) return
    authApi.myPermissions().then((res) => {
      setAuth(token, user, res.permissions)
    }).catch(() => {/* silently ignore — server unreachable */})
  }, [token, hydrated]) // eslint-disable-line react-hooks/exhaustive-deps

  // location-agent-permissions / user-language-profile —
  // Apply server-persisted user preferred_language as early as the
  // store has hydrated AND a user object is available. Without this
  // hook, a fresh login on a new device would surface the localStorage
  // value (or the 'tr' default) until the user manually re-picks the
  // language. The change fires through i18next so all already-mounted
  // components re-render via react-i18next's subscription.
  useEffect(() => {
    if (!hydrated || !user) return
    const preferred = (user as { preferred_language?: string | null }).preferred_language
    if (preferred && preferred !== i18n.language) {
      i18n.changeLanguage(preferred)
    }
  }, [hydrated, user]) // eslint-disable-line react-hooks/exhaustive-deps

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
        {/* PR-A REVISED — SiteProvider is now mounted INSIDE BrowserRouter
            so it can call useLocation() and derive routeOrgId for its
            queryKey + cleanup gating. The provider remains pure state
            (Zustand-free); React Router context is the only new
            dependency. */}
        <BrowserRouter>
          <SiteProvider>
          <AIAssistantProvider>
          {/* Global AI assistant drawer — mounts once at app level, stays
              open across route changes. The entry point is in <Header />
              and is itself permission-gated. Mounting the drawer here
              (vs. inside individual routes) is what makes "open from
              any page, keep open across navigation" work without
              re-mount churn. */}
          <AIAssistantDrawer />
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
              {/* P0 LOGIN-AUTH-LOOP-FIX (2026-06-10) — `/` artık doğrudan
                  Dashboard render etmiyor; RootRedirect auth+hidrasyona
                  göre `/dashboard` veya `/login`'e güvenli navigate yapar.
                  Login success direkt `/dashboard`'a gider, `/` üzerinden
                  geçmez — page-reload döngüsü kırılır.

                  PR-A (2026-06-22) — RootRedirect rolü gözeten matrise
                  dönüştürüldü:
                    super_admin       → /platform/overview
                    normal user       → /app/org/<orgId>/dashboard */}
              <Route index element={<RootRedirect />} />

              {/* PR-A — PLATFORM control plane. super_admin-only. The
                  inactive items (Platform Kullanıcıları / Roller / Lisanslar
                  / Kotalar / Global Sağlık / Global Audit / Platform
                  Ayarları / Retention) intentionally have NO routes per
                  PLATFORM NAV SCOPE SAFETY ADDENDUM — they appear in the
                  PlatformSidebar as Yakında disabled items only. */}
              <Route path="platform" element={<PlatformShell />}>
                <Route index element={<Navigate to="/platform/overview" replace />} />
                <Route path="overview" element={<PlatformOverviewPage />} />
                <Route path="organizations" element={<PlatformOrganizationsPage />} />
                <Route path="organizations/:organizationId" element={<PlatformOrganizationDetailPage />} />
              </Route>

              {/* PR-A — URL-AUTHORITATIVE operations panel. The
                  :organizationId in the URL is the SOLE source of org
                  context — SiteContext.activeOrgId is kept in sync via
                  OrgRouteShell. Normal users may only enter their own
                  org route; super_admin may scope into any org. The
                  inactive operations modules (Topology / Discovery / ...)
                  appear as Yakında disabled items in OperationsSidebar —
                  NO `/app/org/:id/<inactive>` routes are registered per
                  OPERATIONS LEGACY ESCAPE SAFETY ADDENDUM. */}
              <Route path="app/org/:organizationId" element={<OrgRouteShell />}>
                <Route index element={<Navigate to="dashboard" replace />} />
                {/* PR-A foundation routes (migrated) */}
                <Route path="dashboard" element={<DashboardPage />} />
                <Route path="devices" element={<DevicesPage />} />
                <Route path="devices/:deviceId" element={<RoleRoute minRole="viewer"><DeviceDetailPage /></RoleRoute>} />
                <Route path="devices/:deviceId/ports" element={<RedirectToPortsTab />} />
                <Route path="agents" element={<AgentsPage />} />
                {/* PR-A2 — 40 alias route: mevcut çalışan operations
                    modüllerini /app/org/:id/<segment> altına bağlar.
                    Eski page component'leri aynen reuse edilir;
                    mevcut RBAC wrapper'ları korunur. */}
                {/* Inventory */}
                <Route path="topology" element={featureFlags.topologyV2Canonical ? <TopologyV2Page /> : <TopologyPage />} />
                <Route path="topology-classic" element={<TopologyPage />} />
                <Route path="topology-next" element={<TopologyV2Page />} />
                {/* RBAC-PHASE-1 (2026-06-30) — Discovery / VLAN / Racks /
                    Floor Plan now drive their gate from the permission
                    set grid, NOT system_role. A location_admin with
                    "Tam Yetki" can reach all four pages within their
                    assigned location scope; org_admin and super_admin
                    keep their previous reach (PermissionEngine
                    short-circuits to True for those roles). */}
                <Route path="discovery" element={<PermRoute module="discovery" action="view"><LldpInventoryPage /></PermRoute>} />
                <Route path="ipam" element={<PermRoute module="ipam" action="view"><IpamPage /></PermRoute>} />
                <Route path="vlan" element={<PermRoute module="vlan" action="view"><VlanManagementPage /></PermRoute>} />
                <Route path="racks" element={<PermRoute module="racks" action="view"><RacksPage /></PermRoute>} />
                <Route path="floor-plan" element={<PermRoute module="maps" action="view"><FloorPlanPage /></PermRoute>} />
                {/* Monitoring */}
                <Route path="monitor" element={<MonitorPage />} />
                <Route path="live" element={<PermRoute module="monitoring" action="view"><LiveMonitorPage /></PermRoute>} />
                <Route path="intelligence" element={<PermRoute module="monitoring" action="view"><IntelligencePage /></PermRoute>} />
                <Route path="bandwidth" element={<PermRoute module="monitoring" action="view"><BandwidthMonitorPage /></PermRoute>} />
                <Route path="mac-arp" element={<PermRoute module="monitoring" action="view"><MacArpPage /></PermRoute>} />
                <Route path="synthetic-probes" element={<PermRoute module="monitoring" action="view"><SyntheticProbesPage /></PermRoute>} />
                {/* Alerts */}
                <Route path="alert-rules" element={<RoleRoute minRole="org_admin"><AlertRulesPage /></RoleRoute>} />
                <Route path="escalation-rules" element={<RoleRoute minRole="org_admin"><EscalationRulesPage /></RoleRoute>} />
                <Route path="incidents" element={<PermRoute module="monitoring" action="view"><IncidentsPage /></PermRoute>} />
                <Route path="services" element={<RoleRoute minRole="org_admin"><ServicesPage /></RoleRoute>} />
                {/* Config */}
                <Route path="config-drift" element={<RoleRoute minRole="org_admin"><ConfigDriftPage /></RoleRoute>} />
                <Route path="config-templates" element={<PermRoute module="driver_templates" action="view"><ConfigTemplatesPage /></PermRoute>} />
                <Route path="config-builder" element={<PermRoute module="config_backups" action="view"><ConfigBuilderPage /></PermRoute>} />
                <Route path="backups" element={<PermRoute module="config_backups" action="view"><BackupCenterPage /></PermRoute>} />
                <Route path="firmware" element={<RoleRoute minRole="org_admin"><FirmwarePage /></RoleRoute>} />
                <Route path="driver-templates" element={<PermRoute module="driver_templates" action="view"><DriverTemplatesPage /></PermRoute>} />
                {/* Automation */}
                <Route path="tasks" element={<TasksPage />} />
                <Route path="playbooks" element={<PermRoute module="playbooks" action="view"><PlaybooksPage /></PermRoute>} />
                <Route path="change-management" element={<RoleRoute minRole="location_admin"><ChangeManagementPage /></RoleRoute>} />
                <Route path="approvals" element={<RoleRoute minRole="location_admin"><ApprovalsPage /></RoleRoute>} />
                {/* Security */}
                <Route path="security-audit" element={<PermRoute module="monitoring" action="view"><SecurityAuditPage /></PermRoute>} />
                <Route path="security-policies" element={<RoleRoute minRole="viewer"><SecurityPoliciesPage /></RoleRoute>} />
                <Route path="compliance" element={<RoleRoute minRole="location_admin"><ComplianceCheckPage /></RoleRoute>} />
                <Route path="asset-lifecycle" element={<PermRoute module="monitoring" action="view"><AssetLifecyclePage /></PermRoute>} />
                {/* Reports */}
                <Route path="sla" element={<RoleRoute minRole="org_admin"><SlaReportPage /></RoleRoute>} />
                <Route path="poe" element={<RoleRoute minRole="org_admin"><PoeDashboardPage /></RoleRoute>} />
                <Route path="reports" element={<PermRoute module="reports" action="view"><ReportsPage /></PermRoute>} />
                <Route path="topology-twin" element={<RoleRoute minRole="location_admin"><TopologyTwinPage /></RoleRoute>} />
                {/* Tools */}
                <Route path="diagnostics" element={<RoleRoute minRole="viewer"><DiagnosticsPage /></RoleRoute>} />
                <Route path="ai-assistant" element={<RoleRoute minRole="org_admin"><AIAssistantPage /></RoleRoute>} />
                {/* admin_users */}
                <Route path="users" element={<PermRoute module="users" action="view"><UsersPage /></PermRoute>} />
                <Route path="permissions" element={<RoleRoute minRole="org_admin"><PermissionsPage /></RoleRoute>} />
                <Route path="locations" element={<PermRoute module="locations" action="view"><LocationsPage /></PermRoute>} />
                {/* admin_audit */}
                <Route path="audit" element={<PermRoute module="audit_logs" action="view"><AuditLogPage /></PermRoute>} />
                <Route path="terminal-sessions" element={<PermRoute module="audit_logs" action="view"><TerminalSessionsPage /></PermRoute>} />
              </Route>

              {/* PR-A — legacy bookmark / external-link compatibility.
                  Three legacy entry points now redirect to their canonical
                  URL-authoritative target; the other legacy operations
                  routes below stay UNCHANGED but become unreachable from
                  OperationsSidebar (per OPERATIONS LEGACY ESCAPE SAFETY
                  ADDENDUM). */}
              <Route path="dashboard" element={<LegacyRedirect segment="dashboard" />} />
              <Route path="devices" element={<LegacyRedirect segment="devices" />} />
              <Route path="agents" element={<LegacyRedirect segment="agents" />} />

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
              <Route path="discovery" element={<PermRoute module="discovery" action="view"><LldpInventoryPage /></PermRoute>} />
              <Route path="monitor" element={<MonitorPage />} />
              <Route path="live" element={<PermRoute module="monitoring" action="view"><LiveMonitorPage /></PermRoute>} />
              <Route path="reports" element={<PermRoute module="reports" action="view"><ReportsPage /></PermRoute>} />
              <Route path="users" element={<PermRoute module="users" action="view"><UsersPage /></PermRoute>} />
              <Route path="audit" element={<PermRoute module="audit_logs" action="view"><AuditLogPage /></PermRoute>} />
              <Route path="terminal-sessions" element={<PermRoute module="audit_logs" action="view"><TerminalSessionsPage /></PermRoute>} />
              {/* T10 C7.B — eski ports route'unu yeni Detail sayfasındaki Ports sekmesine yönlendir
                  (eski bookmark'lar kırılmaz). Gerçek Ports sekmesi içeriği C7.C'de gelecek. */}
              <Route path="devices/:deviceId/ports" element={<RedirectToPortsTab />} />
              {/* PR-A — /agents legacy route artık LegacyRedirect (yukarıda).
                  Doğrudan AgentsPage route'u kaldırıldı; canonical hedef
                  /app/org/:id/agents olur. */}
              {/* Sprint 1A-fix2 — /settings şimdilik super_admin-only.
                  Kullanıcı-yönelik ayarlar ileride ayrı "Ayarlar" menüsüne
                  taşınacak; o sprintte hangi alt-bölümler hangi role açılır
                  yeniden tasarlanır. */}
              <Route path="settings" element={<RoleRoute minRole="super_admin"><SettingsPage /></RoleRoute>} />
              {/* Profil — her authenticated kullanıcı kendi sayfası. Permission
                  gate yok; içerideki /users/me endpoint'leri zaten self-only. */}
              <Route path="profile" element={<ProfilePage />} />
              <Route path="playbooks" element={<PermRoute module="playbooks" action="view"><PlaybooksPage /></PermRoute>} />
              <Route path="approvals" element={<RoleRoute minRole="location_admin"><ApprovalsPage /></RoleRoute>} />
              <Route path="mac-arp" element={<PermRoute module="monitoring" action="view"><MacArpPage /></PermRoute>} />
              <Route path="ipam" element={<PermRoute module="ipam" action="view"><IpamPage /></PermRoute>} />
              <Route path="security-audit" element={<PermRoute module="monitoring" action="view"><SecurityAuditPage /></PermRoute>} />
              <Route path="asset-lifecycle" element={<PermRoute module="monitoring" action="view"><AssetLifecyclePage /></PermRoute>} />
              <Route path="diagnostics" element={<RoleRoute minRole="viewer"><DiagnosticsPage /></RoleRoute>} />
              <Route path="bandwidth" element={<PermRoute module="monitoring" action="view"><BandwidthMonitorPage /></PermRoute>} />
              <Route path="config-templates" element={<PermRoute module="driver_templates" action="view"><ConfigTemplatesPage /></PermRoute>} />
              <Route path="config-builder" element={<PermRoute module="config_backups" action="view"><ConfigBuilderPage /></PermRoute>} />
              <Route path="poe" element={<RoleRoute minRole="org_admin"><PoeDashboardPage /></RoleRoute>} />
              <Route path="firmware" element={<RoleRoute minRole="org_admin"><FirmwarePage /></RoleRoute>} />
              <Route path="change-management" element={<RoleRoute minRole="location_admin"><ChangeManagementPage /></RoleRoute>} />
              <Route path="sla" element={<RoleRoute minRole="org_admin"><SlaReportPage /></RoleRoute>} />
              <Route path="vlan" element={<PermRoute module="vlan" action="view"><VlanManagementPage /></PermRoute>} />
              <Route path="backups" element={<PermRoute module="config_backups" action="view"><BackupCenterPage /></PermRoute>} />
              <Route path="config-drift" element={<RoleRoute minRole="org_admin"><ConfigDriftPage /></RoleRoute>} />
              <Route path="intelligence" element={<PermRoute module="monitoring" action="view"><IntelligencePage /></PermRoute>} />
              <Route path="compliance" element={<RoleRoute minRole="location_admin"><ComplianceCheckPage /></RoleRoute>} />
              <Route path="racks" element={<PermRoute module="racks" action="view"><RacksPage /></PermRoute>} />
              {/* M6 final drop — the standalone `/tenants` page is gone. */}
              <Route path="locations" element={<PermRoute module="locations" action="view"><LocationsPage /></PermRoute>} />
              <Route path="floor-plan" element={<PermRoute module="maps" action="view"><FloorPlanPage /></PermRoute>} />
              <Route path="alert-rules" element={<RoleRoute minRole="org_admin"><AlertRulesPage /></RoleRoute>} />
              <Route path="security-policies" element={<RoleRoute minRole="viewer"><SecurityPoliciesPage /></RoleRoute>} />
              <Route path="driver-templates" element={<PermRoute module="driver_templates" action="view"><DriverTemplatesPage /></PermRoute>} />
              <Route path="help" element={<HelpPage />} />
              <Route path="services" element={<RoleRoute minRole="org_admin"><ServicesPage /></RoleRoute>} />
              <Route path="topology-twin" element={<RoleRoute minRole="location_admin"><TopologyTwinPage /></RoleRoute>} />
              <Route path="ai-assistant" element={<RoleRoute minRole="org_admin"><AIAssistantPage /></RoleRoute>} />
              <Route path="superadmin" element={<RoleRoute minRole="super_admin"><SuperAdminPage /></RoleRoute>} />
              {/* Sprint 1A-fix2 — /org-admin Platform Management altından
                  kaldırıldı; route şimdilik super_admin-only (debug erişimi).
                  Org admin için ayrı Organizasyon paneli ihtiyacı ileride
                  ayrı tasarlanacak. */}
              <Route path="org-admin" element={<RoleRoute minRole="super_admin"><OrgAdminPage /></RoleRoute>} />
              <Route path="permissions" element={<RoleRoute minRole="org_admin"><PermissionsPage /></RoleRoute>} />
              <Route path="synthetic-probes" element={<PermRoute module="monitoring" action="view"><SyntheticProbesPage /></PermRoute>} />
              <Route path="incidents" element={<PermRoute module="monitoring" action="view"><IncidentsPage /></PermRoute>} />
              <Route path="escalation-rules" element={<RoleRoute minRole="org_admin"><EscalationRulesPage /></RoleRoute>} />
            </Route>
          </Routes>
          </AIAssistantProvider>
          </SiteProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  )
}

export default function App() {
  // PR-A REVISED — SiteProvider moved into ThemedApp (inside
  // BrowserRouter) so it can derive routeOrgId from useLocation.
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <CustomizeProvider>
            <ThemedApp />
          </CustomizeProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
