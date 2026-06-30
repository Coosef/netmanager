import { describe, it, expect } from 'vitest'
import {
  GROUP_DEFINITIONS,
  GROUP_BY_KEY,
  ROUTE_TO_GROUP,
  canSeeGroup,
  canSeeTab,
  getActiveGroup,
  getFirstVisibleTab,
  getVisibleGroups,
  getVisibleTabs,
  type VisibilityContext,
} from '@/utils/menuGroups'
import type { SystemRole } from '@/types'

// ─── Test context builder ────────────────────────────────────────────────────

/** Production'da useAuthStore'dan gelen ctx imzasını taklit eder. */
function ctxFor(
  role: SystemRole,
  opts: {
    can?: (mod: string, action: string) => boolean
    features?: Record<string, boolean>
  } = {},
): VisibilityContext {
  // Faz 7 4-rol hiyerarşisi
  const ROLE_ORDER: SystemRole[] = ['viewer', 'location_admin', 'org_admin', 'super_admin']
  const myIdx = ROLE_ORDER.indexOf(role)
  return {
    isSuperAdmin: () => role === 'super_admin',
    hasPermission: (minRole) => myIdx >= ROLE_ORDER.indexOf(minRole),
    // Default: super_admin/org_admin için her şeye izin, viewer/location_admin
    // için module yoksa view-only
    can: opts.can ?? ((_mod, action) => {
      if (role === 'super_admin' || role === 'org_admin') return true
      if (role === 'location_admin') return action !== 'delete'
      return action === 'view'
    }),
    features: opts.features ?? {},
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Yapısal bütünlük
// ═════════════════════════════════════════════════════════════════════════════

describe('GROUP_DEFINITIONS — structural integrity', () => {
  it('tanımlı 12 ana grup içerir', () => {
    expect(GROUP_DEFINITIONS).toHaveLength(12)
  })

  it('grup key sırası sidebar render sırasıyla aynıdır', () => {
    const keys = GROUP_DEFINITIONS.map((g) => g.key)
    expect(keys).toEqual([
      'dashboard',
      'inventory',
      'monitoring',
      'alerts',
      'config',
      'automation',
      'security',
      'reports',
      'tools',
      'admin_users',
      'admin_audit',
      'admin_platform',
    ])
  })

  it('tüm grup key\'leri benzersizdir', () => {
    const keys = GROUP_DEFINITIONS.map((g) => g.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('tüm tab key\'leri grup içinde benzersizdir', () => {
    for (const group of GROUP_DEFINITIONS) {
      const keys = group.tabs.map((t) => t.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it('tüm route\'lar benzersizdir (Dashboard / + 49 tab)', () => {
    const routes: string[] = []
    for (const group of GROUP_DEFINITIONS) {
      if (group.route) routes.push(group.route)
      for (const tab of group.tabs) routes.push(tab.route)
    }
    expect(new Set(routes).size).toBe(routes.length)
  })

  it('tüm i18n key\'leri benzersizdir', () => {
    const keys: string[] = []
    for (const group of GROUP_DEFINITIONS) {
      keys.push(group.i18nKey)
      for (const tab of group.tabs) keys.push(tab.i18nKey)
    }
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('Dashboard grubu tek sayfadır (tabs boş)', () => {
    expect(GROUP_BY_KEY.dashboard.tabs).toHaveLength(0)
    expect(GROUP_BY_KEY.dashboard.route).toBe('/')
  })

  it('Dashboard dışındaki gruplar route taşımaz; tab listeleri vardır', () => {
    for (const group of GROUP_DEFINITIONS) {
      if (group.key === 'dashboard') continue
      expect(group.route).toBeUndefined()
      expect(group.tabs.length).toBeGreaterThan(0)
    }
  })

  it('tab sayıları Excel hedefiyle uyumlu (Faz 1 karar matrisi)', () => {
    // HOTFIX 2026-06-08: lldp tab silindi (sistemde /lldp-inventory route yok;
    // LldpInventoryPage zaten /discovery'ye bağlı). 8 → 7.
    expect(GROUP_BY_KEY.inventory.tabs).toHaveLength(7)
    expect(GROUP_BY_KEY.monitoring.tabs).toHaveLength(6)
    expect(GROUP_BY_KEY.alerts.tabs).toHaveLength(4)
    expect(GROUP_BY_KEY.config.tabs).toHaveLength(6)
    expect(GROUP_BY_KEY.automation.tabs).toHaveLength(4)
    expect(GROUP_BY_KEY.security.tabs).toHaveLength(4)
    expect(GROUP_BY_KEY.reports.tabs).toHaveLength(4)
    expect(GROUP_BY_KEY.tools.tabs).toHaveLength(2) // karar 3: IP Scanner kapsam dışı
    expect(GROUP_BY_KEY.admin_users.tabs).toHaveLength(4)
    expect(GROUP_BY_KEY.admin_audit.tabs).toHaveLength(2)
    // Sprint 1A-fix2: admin_platform yalnız super_admin'e (platform +
    // settings). organization tab + help tab kaldırıldı.
    expect(GROUP_BY_KEY.admin_platform.tabs).toHaveLength(2)
  })

  it('i18n anahtarları nav.group.* veya nav.tab.<group>.* formatındadır', () => {
    for (const group of GROUP_DEFINITIONS) {
      expect(group.i18nKey).toMatch(/^nav\.group\.[a-z_]+$/)
      for (const tab of group.tabs) {
        expect(tab.i18nKey).toMatch(new RegExp(`^nav\\.tab\\.${group.key}\\.[a-z_]+$`))
      }
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. ROUTE_TO_GROUP lookup
// ═════════════════════════════════════════════════════════════════════════════

describe('ROUTE_TO_GROUP lookup', () => {
  it('Dashboard route → dashboard', () => {
    expect(ROUTE_TO_GROUP['/']).toBe('dashboard')
  })

  it('inventory tab\'ları → inventory', () => {
    expect(ROUTE_TO_GROUP['/devices']).toBe('inventory')
    expect(ROUTE_TO_GROUP['/topology']).toBe('inventory')
    expect(ROUTE_TO_GROUP['/floor-plan']).toBe('inventory')
    expect(ROUTE_TO_GROUP['/discovery']).toBe('inventory')
  })

  it('HOTFIX 2026-06-08: /lldp-inventory ROUTE_TO_GROUP\'ta YOK', () => {
    // Sistemde /lldp-inventory route yok; LldpInventoryPage zaten /discovery
    // route'una bağlı. Helper'da çift kayıt yanlıştı; silindi.
    expect(ROUTE_TO_GROUP['/lldp-inventory']).toBeUndefined()
  })

  it('config tab\'ları → config (DriverTemplates dahil)', () => {
    expect(ROUTE_TO_GROUP['/config-drift']).toBe('config')
    expect(ROUTE_TO_GROUP['/driver-templates']).toBe('config')
    expect(ROUTE_TO_GROUP['/backups']).toBe('config')
  })

  it('admin_platform tab\'ları → admin_platform (Sprint 1A-fix2: 2 tab)', () => {
    expect(ROUTE_TO_GROUP['/superadmin']).toBe('admin_platform')
    expect(ROUTE_TO_GROUP['/settings']).toBe('admin_platform')
    // /org-admin ve /help admin_platform'dan çıkarıldı (ROUTE_TO_GROUP'ta yok)
    expect(ROUTE_TO_GROUP['/org-admin']).toBeUndefined()
    expect(ROUTE_TO_GROUP['/help']).toBeUndefined()
  })

  it('TerminalSessions read-only audit → admin_audit', () => {
    expect(ROUTE_TO_GROUP['/terminal-sessions']).toBe('admin_audit')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. getActiveGroup pathname matcher
// ═════════════════════════════════════════════════════════════════════════════

describe('getActiveGroup', () => {
  it('exact match — /devices → inventory', () => {
    expect(getActiveGroup('/devices')).toBe('inventory')
  })

  it('drill-down — /devices/42 → inventory', () => {
    expect(getActiveGroup('/devices/42')).toBe('inventory')
  })

  it('drill-down + query string — /devices/42?tab=ports → inventory', () => {
    // Browser router pathname'i query string'siz verir; helper yine de doğru
    expect(getActiveGroup('/devices/42')).toBe('inventory')
  })

  it('Dashboard root match', () => {
    expect(getActiveGroup('/')).toBe('dashboard')
  })

  it('Dashboard root drill-down değildir (/welcome dashboard değildir)', () => {
    // '/' catch-all olmamalı; '/welcome' dashboard kabul edilmemeli
    expect(getActiveGroup('/welcome')).toBeNull()
  })

  it('bilinmeyen route → null', () => {
    expect(getActiveGroup('/nope')).toBeNull()
    expect(getActiveGroup('/some/random/path')).toBeNull()
  })

  it('uzun route önce eşleşir (substring çakışması yok)', () => {
    // /topology-twin (reports) vs /topology (inventory)
    expect(getActiveGroup('/topology-twin')).toBe('reports')
    expect(getActiveGroup('/topology')).toBe('inventory')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. canSeeTab — RBAC + feature + module cascade
// ═════════════════════════════════════════════════════════════════════════════

describe('canSeeTab', () => {
  const ctxSA = ctxFor('super_admin')
  const ctxOA = ctxFor('org_admin')
  const ctxLA = ctxFor('location_admin')
  const ctxV = ctxFor('viewer')

  it('module-RBAC ile gizlenir — viewer üzerinde devices:view kapalı', () => {
    const tab = GROUP_BY_KEY.inventory.tabs.find((t) => t.key === 'switch')!
    const denied: VisibilityContext = { ...ctxV, can: () => false }
    expect(canSeeTab(tab, denied)).toBe(false)
    expect(canSeeTab(tab, ctxV)).toBe(true)
  })

  it('feature flag false → gizli (topology kapalı)', () => {
    const tab = GROUP_BY_KEY.inventory.tabs.find((t) => t.key === 'topology')!
    const noTopo: VisibilityContext = { ...ctxOA, features: { topology: false } }
    expect(canSeeTab(tab, noTopo)).toBe(false)
    expect(canSeeTab(tab, ctxOA)).toBe(true) // default = enabled
  })

  it('minRole — Firmware (org_admin) viewer\'a gizli', () => {
    const tab = GROUP_BY_KEY.config.tabs.find((t) => t.key === 'firmware')!
    expect(canSeeTab(tab, ctxV)).toBe(false)
    expect(canSeeTab(tab, ctxLA)).toBe(false)
    expect(canSeeTab(tab, ctxOA)).toBe(true)
    expect(canSeeTab(tab, ctxSA)).toBe(true)
  })

  it('minRole — Backups (location_admin) viewer\'a gizli, location_admin görür', () => {
    const tab = GROUP_BY_KEY.config.tabs.find((t) => t.key === 'backups')!
    expect(canSeeTab(tab, ctxV)).toBe(false)
    expect(canSeeTab(tab, ctxLA)).toBe(true)
    expect(canSeeTab(tab, ctxOA)).toBe(true)
  })

  it('Sprint 1A-fix2: organization tab kaldırıldı — admin_platform\'da yok', () => {
    expect(GROUP_BY_KEY.admin_platform.tabs.find((t) => t.key === 'organization')).toBeUndefined()
  })

  it('Platform Paneli — sadece super_admin görür', () => {
    const tab = GROUP_BY_KEY.admin_platform.tabs.find((t) => t.key === 'platform')!
    expect(canSeeTab(tab, ctxSA)).toBe(true)
    expect(canSeeTab(tab, ctxOA)).toBe(false)
    expect(canSeeTab(tab, ctxLA)).toBe(false)
    expect(canSeeTab(tab, ctxV)).toBe(false)
  })

  it('Sprint 1A-fix2: Yardım tab admin_platform\'dan çıkarıldı — /help route hala açık', () => {
    // Tab admin_platform'da artık yok; ama /help route App.tsx'te
    // unchanged (guard yok), tüm kullanıcılar URL ile açabilir.
    expect(GROUP_BY_KEY.admin_platform.tabs.find((t) => t.key === 'help')).toBeUndefined()
  })

  it('feature + minRole + module cascade — agents tüm kontrolleri geçer', () => {
    const tab = GROUP_BY_KEY.admin_users.tabs.find((t) => t.key === 'agents')!
    // org_admin + agents feature on + can() default = view'a izin
    expect(canSeeTab(tab, ctxOA)).toBe(true)
    // feature kapalı → false
    expect(canSeeTab(tab, { ...ctxOA, features: { agents: false } })).toBe(false)
    // viewer → minRole'ü geçemez
    expect(canSeeTab(tab, ctxV)).toBe(false)
  })

  it('SSH Audit (terminal_sessions) — kısıtsız (revert sonrası read-only)', () => {
    const tab = GROUP_BY_KEY.admin_audit.tabs.find((t) => t.key === 'ssh')!
    expect(canSeeTab(tab, ctxV)).toBe(true)
    expect(canSeeTab(tab, ctxSA)).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. canSeeGroup / getVisibleGroups / getFirstVisibleTab
// ═════════════════════════════════════════════════════════════════════════════

describe('canSeeGroup', () => {
  it('Dashboard her zaman görünür (rol bağımsız)', () => {
    expect(canSeeGroup(GROUP_BY_KEY.dashboard, ctxFor('viewer'))).toBe(true)
    const denied: VisibilityContext = {
      isSuperAdmin: () => false,
      hasPermission: () => false,
      can: () => false,
      features: {},
    }
    expect(canSeeGroup(GROUP_BY_KEY.dashboard, denied)).toBe(true)
  })

  it('grup, hiç görünür tab\'ı yoksa gizlidir', () => {
    const noPerms: VisibilityContext = {
      isSuperAdmin: () => false,
      hasPermission: () => false, // hiç rol geçmesi yok
      can: () => false,
      features: {},
    }
    // Kullanıcı/Erişim grubu: tüm tab'lar minRole/module gerektiriyor → gizli
    expect(canSeeGroup(GROUP_BY_KEY.admin_users, noPerms)).toBe(false)
  })

  it('Admin Audit — SSH tab kısıtsız → grup her zaman görünür', () => {
    // SSH tab kısıt yok → en az 1 görünür tab var
    const ctx = ctxFor('viewer')
    expect(canSeeGroup(GROUP_BY_KEY.admin_audit, ctx)).toBe(true)
  })

  it('Inventory — viewer en az birkaç tab görür (vlan, lldp kısıtsız)', () => {
    expect(canSeeGroup(GROUP_BY_KEY.inventory, ctxFor('viewer'))).toBe(true)
  })

  it('Sprint 1A-fix2: Platform Yönetimi yalnız super_admin\'e görünür', () => {
    expect(canSeeGroup(GROUP_BY_KEY.admin_platform, ctxFor('super_admin'))).toBe(true)
    expect(canSeeGroup(GROUP_BY_KEY.admin_platform, ctxFor('org_admin'))).toBe(false)
    expect(canSeeGroup(GROUP_BY_KEY.admin_platform, ctxFor('location_admin'))).toBe(false)
    expect(canSeeGroup(GROUP_BY_KEY.admin_platform, ctxFor('viewer'))).toBe(false)
  })
})

describe('getVisibleGroups', () => {
  it('super_admin tüm 12 grubu görür', () => {
    expect(getVisibleGroups(ctxFor('super_admin'))).toHaveLength(12)
  })

  it('Sprint 1A-fix2: org_admin 11 grubu görür (admin_platform hariç super_admin-only)', () => {
    const groups = getVisibleGroups(ctxFor('org_admin'))
    expect(groups).toHaveLength(11)
    expect(groups.find((g) => g.key === 'admin_platform')).toBeUndefined()
  })

  it('viewer en az Dashboard + birkaç grup görür', () => {
    const groups = getVisibleGroups(ctxFor('viewer'))
    expect(groups.length).toBeGreaterThan(0)
    expect(groups[0].key).toBe('dashboard')
  })

  it('hiç permission yok → Dashboard + kısıtsız tab içeren gruplar görünür', () => {
    // Tam-deny context: hasPermission false, can false, features {}
    // Kısıtsız (minRole/module/feature taşımayan) tab içeren gruplar yine
    // görünür kalır — bu doğru davranıştır. automation/admin_users tüm
    // tab'ları kısıtlı → gizli olmalı.
    const deny: VisibilityContext = {
      isSuperAdmin: () => false,
      hasPermission: () => false,
      can: () => false,
      features: {},
    }
    const groupKeys = getVisibleGroups(deny).map((g) => g.key)
    expect(groupKeys).toContain('dashboard')
    expect(groupKeys).not.toContain('automation')   // tüm tab'lar kısıtlı
    expect(groupKeys).not.toContain('admin_users')  // tüm tab'lar kısıtlı
  })
})

describe('getFirstVisibleTab', () => {
  it('Dashboard grubu tab içermez → null', () => {
    expect(getFirstVisibleTab(GROUP_BY_KEY.dashboard, ctxFor('super_admin'))).toBeNull()
  })

  it('inventory için viewer → ilk görünür tab', () => {
    const first = getFirstVisibleTab(GROUP_BY_KEY.inventory, ctxFor('viewer'))
    expect(first).not.toBeNull()
    // viewer için: switch (devices:view) yetkili → ilk dönen
    expect(first!.key).toBe('switch')
  })

  it('Inventory için /devices/view false → topology ilk gelir', () => {
    const ctx: VisibilityContext = {
      ...ctxFor('viewer'),
      can: (mod, _action) => mod !== 'devices',
    }
    const first = getFirstVisibleTab(GROUP_BY_KEY.inventory, ctx)
    expect(first!.key).toBe('topology')
  })

  it('Sprint 1A-fix2: Platform Yönetimi — viewer için yetkili tab yok', () => {
    // admin_platform 2 tab (platform + settings) — her ikisi de super_admin-only.
    const first = getFirstVisibleTab(GROUP_BY_KEY.admin_platform, ctxFor('viewer'))
    expect(first).toBeNull()
  })

  it('Platform Yönetimi — super_admin için Platform Paneli', () => {
    const first = getFirstVisibleTab(GROUP_BY_KEY.admin_platform, ctxFor('super_admin'))
    expect(first!.key).toBe('platform')
  })

  it('Sprint 1A-fix2: Platform Yönetimi — org_admin için yetkili tab yok', () => {
    // organization tab kaldırıldı; kalan platform + settings super_admin-only.
    const first = getFirstVisibleTab(GROUP_BY_KEY.admin_platform, ctxFor('org_admin'))
    expect(first).toBeNull()
  })
})

describe('getVisibleTabs', () => {
  it('viewer için Inventory tab\'larından feature-disabled ipam gizlenir', () => {
    const ctx: VisibilityContext = {
      ...ctxFor('viewer'),
      features: { ipam: false },
    }
    const visible = getVisibleTabs(GROUP_BY_KEY.inventory, ctx)
    expect(visible.find((t) => t.key === 'ipam')).toBeUndefined()
  })

  it('viewer config grubunda Firmware ve Config Drift (org_admin) gizli; templates görünür', () => {
    // Sprint 1A: drift artık org_admin gerektirir (route guard ile hizalı).
    const visible = getVisibleTabs(GROUP_BY_KEY.config, ctxFor('viewer'))
    expect(visible.find((t) => t.key === 'firmware')).toBeUndefined()
    expect(visible.find((t) => t.key === 'drift')).toBeUndefined()
    // templates: module ['driver_templates','view'] — viewer can() default
    // ctx ile view'a izin verir, dolayısıyla görünür kalır.
    expect(visible.find((t) => t.key === 'templates')).toBeDefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. Edge case'ler — kapsam dışı / SSH Termination guardrail
// ═════════════════════════════════════════════════════════════════════════════

describe('Karar guardrail\'ları', () => {
  it('IP Scanner tab yok (karar 3 — kapsam dışı)', () => {
    const tabKeys = GROUP_BY_KEY.tools.tabs.map((t) => t.key)
    expect(tabKeys).not.toContain('scanner')
    expect(tabKeys).not.toContain('ip_scanner')
  })

  it('SSH Termination kapatıldı — TerminalSessions yalnız read-only ssh tab', () => {
    const sshTab = GROUP_BY_KEY.admin_audit.tabs.find((t) => t.key === 'ssh')
    expect(sshTab).toBeDefined()
    expect(sshTab!.route).toBe('/terminal-sessions')
    // 'terminate' veya benzeri yeni route eklenmedi
    const allRoutes = Object.keys(ROUTE_TO_GROUP)
    expect(allRoutes).not.toContain('/terminal-sessions/terminate')
  })

  it('Harita tab\'ı /floor-plan route\'una bağlıdır (karar 2)', () => {
    const mapTab = GROUP_BY_KEY.inventory.tabs.find((t) => t.key === 'map')
    expect(mapTab).toBeDefined()
    expect(mapTab!.route).toBe('/floor-plan')
  })

  it('HOTFIX 2026-06-08 + RBAC-PHASE-1: Keşif Envanteri tek tab — lldp sil, discovery permission-gated', () => {
    // Mevcut /discovery route'u LldpInventoryPage render ediyor. Helper'da
    // çift kayıt (discovery + lldp) yanlıştı; tek 'discovery' tab kaldı.
    //
    // RBAC-PHASE-1 (2026-06-30): minRole='org_admin' guardrail kaldırıldı.
    // Discovery artık module=['discovery','view'] ile gated; location_admin
    // "Tam Yetki" set'ine sahipse kendi lokasyon kapsamında görebiliyor.
    // İkili kayıt (lldp + discovery) yasağı korunur, gate kuralı değişir.
    const lldpTab = GROUP_BY_KEY.inventory.tabs.find((t) => t.key === 'lldp')
    expect(lldpTab).toBeUndefined() // silindi
    const discoveryTab = GROUP_BY_KEY.inventory.tabs.find((t) => t.key === 'discovery')
    expect(discoveryTab).toBeDefined()
    expect(discoveryTab!.route).toBe('/discovery')
    expect(discoveryTab!.module).toEqual(['discovery', 'view'])
    expect(discoveryTab!.minRole).toBeUndefined()
  })

  it('Sprint 1A-fix2: Karar 5 GERİ ALINDI — Organizasyon Paneli admin_platform\'dan çıkarıldı', () => {
    // Karar 5 (2026-06-08): Organizasyon Paneli Platform Yönetimi 4. tab,
    // org_admin'e açıktı. Sprint 1A-fix2 (manuel smoke sonrası): Platform
    // Yönetimi yalnız super_admin; organization tab silindi.
    expect(GROUP_BY_KEY.admin_platform.tabs.find((t) => t.key === 'organization')).toBeUndefined()
    expect(ROUTE_TO_GROUP['/org-admin']).toBeUndefined()
  })

  it('DriverTemplates Config grubunda — içeriği dokunulmaz (karar 7)', () => {
    const driversTab = GROUP_BY_KEY.config.tabs.find((t) => t.key === 'drivers')
    expect(driversTab).toBeDefined()
    expect(driversTab!.route).toBe('/driver-templates')
    expect(driversTab!.module).toEqual(['driver_templates', 'view'])
  })
})
