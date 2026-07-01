/**
 * Charon menü yeniden yapılandırma — Faz 2 helper'ları.
 *
 * Plan A (URL koru, sidebar grouping + tab navigation): Mevcut route'lar
 * değişmez, yalnız sidebar 54 öğeden 12 ana gruba indirilir; her grup
 * sayfa içinde yatay tab strip ile alt sayfalarını gösterir.
 *
 * Detay: `docs/CHARON_MENU_RESTRUCTURE_PLAN.md`
 *
 * Bu dosya **veri + saf fonksiyon** katmanıdır. Sidebar / MenuGroupNav
 * UI component'leri Faz 3'te bu helper'ları kullanır; Faz 2 PR'ı
 * kullanıcıya görsel değişiklik getirmez.
 */

import type { SystemRole } from '@/types'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type GroupKey =
  | 'dashboard'
  | 'inventory'
  | 'monitoring'
  | 'alerts'
  | 'config'
  | 'automation'
  | 'security'
  | 'reports'
  | 'tools'
  | 'admin_users'
  | 'admin_audit'
  | 'admin_platform'

export interface TabDef {
  /** Tab anahtarı — group içinde benzersiz, snake_case. Örn: 'switch', 'topology'. */
  key: string
  /** Mevcut route — DOKUNULMAZ; Plan A gereği URL değişmez. */
  route: string
  /** i18n anahtarı — `nav.tab.<group>.<key>` formatı. */
  i18nKey: string
  /** Hiyerarşik minimum rol. Verilmezse tab'ı herkes görür (auth dışı). */
  minRole?: SystemRole
  /** Org context feature flag adı. Örn: 'topology', 'ipam', 'agents'. */
  feature?: string
  /** Page-level RBAC: [module, action]. Örn: ['devices', 'view']. */
  module?: readonly [string, string]
  /**
   * Edge case: yalnız non-super-admin rolüne göster (mevcut `/org-admin`
   * sayfası süper admin için görünmez). minRole zaten org_admin; bu flag
   * ayrıca süper admin'i ELER.
   */
  excludeSuperAdmin?: boolean
}

export interface GroupDef {
  /** Grup anahtarı. */
  key: GroupKey
  /** i18n anahtarı — `nav.group.<key>` formatı. */
  i18nKey: string
  /**
   * Tek sayfa grupları için (Dashboard) doğrudan route. Tab'lı gruplar
   * için undefined — sidebar tıklamasında ilk yetkili tab'a yönlendirilir.
   */
  route?: string
  /** Sıralı tab listesi. Tek sayfa grup için boş. */
  tabs: readonly TabDef[]
}

/**
 * Sidebar / MenuGroupNav görünürlük kararı için minimum auth context.
 * useAuthStore'dan birebir karşılık gelir.
 */
export interface VisibilityContext {
  can: (module: string, action: string) => boolean
  hasPermission: (minRole: SystemRole) => boolean
  isSuperAdmin: () => boolean
  features: Readonly<Record<string, boolean>>
}

// ─────────────────────────────────────────────────────────────────────────────
// Group definitions — 12 grup, ~49 tab (Dashboard hariç)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Karar referansı (kullanıcı onayı 2026-06-08):
 *   1. Plan A — URL'ler korunur (route'lar dokunulmaz)
 *   2. Harita = FloorPlan (`/floor-plan`)
 *   3. IP Scanner sistemde yok → kapsam dışı; Tools yalnız 2 tab
 *   4. LldpInventory → Ağ Envanteri grubu içinde ayrı 'LLDP Envanteri' tab
 *   5. /org-admin → Platform Yönetimi 4. tab 'Organizasyon Paneli'
 *   6. SSH Termination KAPALI (TerminalSessions read-only audit)
 *   7. DriverTemplates içeriği dokunulmaz; yalnız tab grouping
 */
export const GROUP_DEFINITIONS: readonly GroupDef[] = [
  {
    key: 'dashboard',
    i18nKey: 'nav.group.dashboard',
    route: '/',
    tabs: [],
  },
  {
    key: 'inventory',
    i18nKey: 'nav.group.inventory',
    tabs: [
      // HOTFIX 2026-06-08: 'lldp' ayrı tab kaldırıldı. Mevcut sistemde
      // /lldp-inventory route'u yok; LldpInventoryPage zaten /discovery
      // route'una bağlı. 'discovery' tab'ı "Keşif Envanteri" label'ıyla
      // tek tab olarak Keşif/LLDP envanterini temsil eder.
      { key: 'switch',    route: '/devices',     i18nKey: 'nav.tab.inventory.switch',    module: ['devices', 'view'] },
      { key: 'topology',  route: '/topology',    i18nKey: 'nav.tab.inventory.topology',  feature: 'topology' },
      // RBAC-PHASE-1 (2026-06-30) — Discovery / VLAN / Racks / Map
      // gated by the permission grid, NOT system_role. A location_admin
      // with "Tam Yetki" can see all four tabs within their assigned
      // location scope. Existing `feature` flags on racks (and ipam)
      // are preserved so a feature-flag-closed org still hides the tab
      // even when the permission is granted.
      { key: 'discovery', route: '/discovery',   i18nKey: 'nav.tab.inventory.discovery', module: ['discovery', 'view'] },
      { key: 'ipam',      route: '/ipam',        i18nKey: 'nav.tab.inventory.ipam',      module: ['ipam', 'view'], feature: 'ipam' },
      { key: 'vlan',      route: '/vlan',        i18nKey: 'nav.tab.inventory.vlan',      module: ['vlan', 'view'] },
      { key: 'racks',     route: '/racks',       i18nKey: 'nav.tab.inventory.racks',     module: ['racks', 'view'], feature: 'racks' },
      { key: 'map',       route: '/floor-plan',  i18nKey: 'nav.tab.inventory.map',       module: ['maps', 'view'] },
    ],
  },
  {
    key: 'monitoring',
    i18nKey: 'nav.group.monitoring',
    tabs: [
      { key: 'alerts',            route: '/monitor',           i18nKey: 'nav.tab.monitoring.alerts',            module: ['monitoring', 'view'] },
      { key: 'live',              route: '/live',              i18nKey: 'nav.tab.monitoring.live',              module: ['monitoring', 'view'] },
      // RBAC-SPRINT-2.1 (2026-07-01) — Intelligence gate aligned with
      // Monitoring surface. Intelligence is read-only analytics on
      // NetworkEvent + Device rows the Monitoring pages already
      // expose; reusing `monitoring:view` keeps the permission matrix
      // cardinality low (matches Phase 1 topology:view pattern).
      // location_admin with monitoring:view sees Intelligence within
      // their assigned location scope.
      { key: 'analytics',         route: '/intelligence',      i18nKey: 'nav.tab.monitoring.analytics',         module: ['monitoring', 'view'] },
      { key: 'bandwidth',         route: '/bandwidth',         i18nKey: 'nav.tab.monitoring.bandwidth',         module: ['monitoring', 'view'] },
      { key: 'port_intelligence', route: '/mac-arp',           i18nKey: 'nav.tab.monitoring.port_intelligence', module: ['monitoring', 'view'] },
      { key: 'probes',            route: '/synthetic-probes',  i18nKey: 'nav.tab.monitoring.probes' },
    ],
  },
  {
    key: 'alerts',
    i18nKey: 'nav.group.alerts',
    tabs: [
      { key: 'rules',       route: '/alert-rules',      i18nKey: 'nav.tab.alerts.rules',       minRole: 'org_admin' },
      { key: 'escalation',  route: '/escalation-rules', i18nKey: 'nav.tab.alerts.escalation',  minRole: 'org_admin' },
      { key: 'incidents',   route: '/incidents',        i18nKey: 'nav.tab.alerts.incidents' },
      { key: 'services',    route: '/services',         i18nKey: 'nav.tab.alerts.services',    minRole: 'org_admin' },
    ],
  },
  {
    key: 'config',
    i18nKey: 'nav.group.config',
    tabs: [
      { key: 'drift',     route: '/config-drift',     i18nKey: 'nav.tab.config.drift',     minRole: 'org_admin' },
      { key: 'templates', route: '/config-templates', i18nKey: 'nav.tab.config.templates', module: ['driver_templates', 'view'] },
      { key: 'builder',   route: '/config-builder',   i18nKey: 'nav.tab.config.builder',   module: ['config_backups', 'view'] },
      { key: 'backups',   route: '/backups',          i18nKey: 'nav.tab.config.backups',   minRole: 'location_admin' },
      { key: 'firmware',  route: '/firmware',         i18nKey: 'nav.tab.config.firmware',  minRole: 'org_admin' },
      // DriverTemplates: W1-F kuralı 'içeriğe dokunulmaz' — sadece tab grouping
      { key: 'drivers',   route: '/driver-templates', i18nKey: 'nav.tab.config.drivers',   module: ['driver_templates', 'view'] },
    ],
  },
  {
    key: 'automation',
    i18nKey: 'nav.group.automation',
    tabs: [
      { key: 'tasks',      route: '/tasks',             i18nKey: 'nav.tab.automation.tasks',      module: ['tasks', 'view'] },
      { key: 'playbooks',  route: '/playbooks',         i18nKey: 'nav.tab.automation.playbooks',  module: ['playbooks', 'view'] },
      { key: 'change',     route: '/change-management', i18nKey: 'nav.tab.automation.change',     minRole: 'location_admin' },
      { key: 'approvals',  route: '/approvals',         i18nKey: 'nav.tab.automation.approvals',  minRole: 'location_admin' },
    ],
  },
  {
    key: 'security',
    i18nKey: 'nav.group.security',
    tabs: [
      { key: 'audit',      route: '/security-audit',    i18nKey: 'nav.tab.security.audit' },
      { key: 'policies',   route: '/security-policies', i18nKey: 'nav.tab.security.policies' },
      { key: 'compliance', route: '/compliance',        i18nKey: 'nav.tab.security.compliance', minRole: 'location_admin' },
      { key: 'lifecycle',  route: '/asset-lifecycle',   i18nKey: 'nav.tab.security.lifecycle' },
    ],
  },
  {
    key: 'reports',
    i18nKey: 'nav.group.reports',
    tabs: [
      { key: 'sla',     route: '/sla',           i18nKey: 'nav.tab.reports.sla',     minRole: 'org_admin' },
      { key: 'poe',     route: '/poe',           i18nKey: 'nav.tab.reports.poe',     minRole: 'org_admin' },
      { key: 'reports', route: '/reports',       i18nKey: 'nav.tab.reports.reports', module: ['reports', 'view'] },
      { key: 'twin',    route: '/topology-twin', i18nKey: 'nav.tab.reports.twin',    minRole: 'location_admin' },
    ],
  },
  {
    key: 'tools',
    i18nKey: 'nav.group.tools',
    tabs: [
      { key: 'diagnostics', route: '/diagnostics',  i18nKey: 'nav.tab.tools.diagnostics' },
      // IP Scanner kapsam dışı (karar 3, 2026-06-08) — Tools 2 tab.
      { key: 'ai',          route: '/ai-assistant', i18nKey: 'nav.tab.tools.ai', minRole: 'org_admin', feature: 'ai_assistant' },
    ],
  },
  {
    key: 'admin_users',
    i18nKey: 'nav.group.admin_users',
    tabs: [
      { key: 'users',       route: '/users',       i18nKey: 'nav.tab.admin_users.users',       module: ['users', 'view'] },
      { key: 'permissions', route: '/permissions', i18nKey: 'nav.tab.admin_users.permissions', minRole: 'org_admin' },
      { key: 'locations',   route: '/locations',   i18nKey: 'nav.tab.admin_users.locations',   module: ['locations', 'view'] },
      { key: 'agents',      route: '/agents',      i18nKey: 'nav.tab.admin_users.agents',      minRole: 'org_admin', feature: 'agents' },
    ],
  },
  {
    key: 'admin_audit',
    i18nKey: 'nav.group.admin_audit',
    tabs: [
      { key: 'logs', route: '/audit',              i18nKey: 'nav.tab.admin_audit.logs', module: ['audit_logs', 'view'] },
      // SSH Termination KAPALI (karar 6) — TerminalSessions read-only audit
      { key: 'ssh',  route: '/terminal-sessions',  i18nKey: 'nav.tab.admin_audit.ssh' },
    ],
  },
  {
    // Sprint 1A-fix2 (2026-06-08): Platform Yönetimi yalnız super_admin'e
    // görünür. organization tab silindi (org_admin için ayrı menü ileride);
    // help tab buradan çıkarıldı (route hala açık, ileride ayrı menüye
    // taşınacak); settings tab super_admin-only.
    key: 'admin_platform',
    i18nKey: 'nav.group.admin_platform',
    tabs: [
      { key: 'platform', route: '/superadmin', i18nKey: 'nav.tab.admin_platform.platform', minRole: 'super_admin' },
      { key: 'settings', route: '/settings',   i18nKey: 'nav.tab.admin_platform.settings', minRole: 'super_admin' },
    ],
  },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Pre-computed lookups (test'te + Sidebar'da kullanılır)
// ─────────────────────────────────────────────────────────────────────────────

/** Route → grup anahtarı O(1) lookup. */
export const ROUTE_TO_GROUP: Readonly<Record<string, GroupKey>> = (() => {
  const map: Record<string, GroupKey> = {}
  for (const group of GROUP_DEFINITIONS) {
    if (group.route) map[group.route] = group.key
    for (const tab of group.tabs) {
      map[tab.route] = group.key
    }
  }
  return map
})()

/** Group key → GroupDef O(1) lookup. */
export const GROUP_BY_KEY: Readonly<Record<GroupKey, GroupDef>> = (() => {
  const map = {} as Record<GroupKey, GroupDef>
  for (const group of GROUP_DEFINITIONS) {
    map[group.key] = group
  }
  return map
})()

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Geçerli pathname'in hangi gruba ait olduğunu döner. Exact match önce
 * denenir; sonra ``startsWith(route + '/')`` ile drill-down route'lar
 * (örn. ``/devices/42`` → ``inventory``) eşleştirilir.
 *
 * Hiçbir grup eşleşmezse ``null`` döner — bilinmeyen route, sidebar'da
 * aktif grup highlight'i olmaz (mevcut davranış).
 */
export function getActiveGroup(pathname: string): GroupKey | null {
  if (pathname in ROUTE_TO_GROUP) return ROUTE_TO_GROUP[pathname]
  // Drill-down match — uzun route'lar önce
  const routes = Object.keys(ROUTE_TO_GROUP).sort((a, b) => b.length - a.length)
  for (const route of routes) {
    if (route === '/') continue // dashboard catch-all olmamalı
    if (pathname.startsWith(route + '/')) return ROUTE_TO_GROUP[route]
  }
  return null
}

/**
 * Tek bir tab'ın görünürlük kontrolü. Cascade:
 *   1. feature flag — kapalıysa false
 *   2. minRole — sağlanmıyorsa false
 *   3. excludeSuperAdmin — super_admin ise false
 *   4. module — page-level RBAC; kapalıysa false
 *   5. hepsi geçerse true
 */
export function canSeeTab(tab: TabDef, ctx: VisibilityContext): boolean {
  if (tab.feature && ctx.features[tab.feature] === false) return false
  if (tab.minRole && !ctx.hasPermission(tab.minRole)) return false
  if (tab.excludeSuperAdmin && ctx.isSuperAdmin()) return false
  if (tab.module && !ctx.can(tab.module[0], tab.module[1])) return false
  return true
}

/**
 * Grup görünürlüğü — Dashboard her zaman görünür; diğer gruplar için en
 * az 1 görünür tab şartı (yetkisi olmayan kullanıcıya boş grup
 * gösterilmez).
 */
export function canSeeGroup(group: GroupDef, ctx: VisibilityContext): boolean {
  if (group.key === 'dashboard') return true
  return group.tabs.some((tab) => canSeeTab(tab, ctx))
}

/**
 * Grupta görünür tab listesi — orijinal sırayı korur.
 * Sidebar tıklamasında yönlendirilecek ilk tab burası tarafından belirlenir.
 */
export function getVisibleTabs(group: GroupDef, ctx: VisibilityContext): TabDef[] {
  return group.tabs.filter((tab) => canSeeTab(tab, ctx))
}

/**
 * Grubun ilk yetkili tab'ı. Yoksa ``null``. Sidebar grup tıklamasında
 * kullanılır — kullanıcıyı buraya yönlendiririz, hiçbir tab yetkisi
 * yoksa hiç sidebar'da grup görünmez (canSeeGroup false).
 */
export function getFirstVisibleTab(group: GroupDef, ctx: VisibilityContext): TabDef | null {
  for (const tab of group.tabs) {
    if (canSeeTab(tab, ctx)) return tab
  }
  return null
}

/**
 * Görünür ana grup listesi — sidebar render için. Boş gruplar elenir.
 */
export function getVisibleGroups(ctx: VisibilityContext): GroupDef[] {
  return GROUP_DEFINITIONS.filter((group) => canSeeGroup(group, ctx))
}

/**
 * PR-A2 — operations panel route prefix helper.
 *
 * When the user is inside `/app/org/:organizationId/*`, every legacy
 * single-segment tab route MUST be re-anchored under the same org URL
 * prefix so the URL-authoritative cache bridge in OrgRouteShell remains
 * unbroken. A bare `navigate('/topology')` from inside the operations
 * panel would escape to the legacy panel and drop org context.
 *
 * Rules:
 *   - `routeOrgId == null`         → no prefix (legacy / platform shell)
 *   - route already begins with `/app/org/` → return as-is
 *   - route is `/` (dashboard sentinel) → `/app/org/<orgId>/dashboard`
 *   - other absolute route `/segment[?...]` → `/app/org/<orgId>/segment[?...]`
 *
 * Pure for unit testing — Sidebar / MenuGroupNav delegate every prefix
 * decision to this helper so a regression that drifts the two is
 * impossible.
 */
export function prefixRouteForOperations(route: string, routeOrgId: number | null): string {
  if (routeOrgId == null) return route
  if (route.startsWith(`/app/org/${routeOrgId}/`)) return route
  if (route.startsWith('/app/org/')) return route
  if (route === '/') return `/app/org/${routeOrgId}/dashboard`
  if (route.startsWith('/')) return `/app/org/${routeOrgId}${route}`
  return `/app/org/${routeOrgId}/${route}`
}
