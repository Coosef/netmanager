/**
 * MenuGroupNav + Sidebar entegrasyon davranış testleri.
 *
 * Saf mantık testleri Faz 2'de `utils/__tests__/menuGroups.test.ts` içinde
 * (55 test). Bu dosya React component imports + render mantığını + 12
 * grup × 4 rol ana akış varyasyonlarını doğrular.
 */
import { describe, it, expect } from 'vitest'
import {
  GROUP_BY_KEY,
  GROUP_DEFINITIONS,
  ROUTE_TO_GROUP,
  getActiveGroup,
  getFirstVisibleTab,
  getVisibleGroups,
  getVisibleTabs,
  canSeeTab,
  type VisibilityContext,
} from '@/utils/menuGroups'
import type { SystemRole } from '@/types'

// ─── Test fixture: helper ─────────────────────────────────────────────────

function ctxFor(role: SystemRole, features: Record<string, boolean> = {}): VisibilityContext {
  const ROLE_ORDER: SystemRole[] = ['viewer', 'location_admin', 'org_admin', 'super_admin']
  const myIdx = ROLE_ORDER.indexOf(role)
  return {
    isSuperAdmin: () => role === 'super_admin',
    hasPermission: (minRole) => myIdx >= ROLE_ORDER.indexOf(minRole),
    can: (_mod, action) => {
      if (role === 'super_admin' || role === 'org_admin') return true
      if (role === 'location_admin') return action !== 'delete'
      return action === 'view'
    },
    features,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Component imports — modül yüklenir mi (collection smoke)
// ═════════════════════════════════════════════════════════════════════════════

describe('Layout component module imports', () => {
  it('MenuGroupNav default export bir fonksiyondur', async () => {
    const mod = await import('@/components/Layout/MenuGroupNav')
    expect(typeof mod.default).toBe('function')
  })

  it('Sidebar default export bir fonksiyondur', async () => {
    const mod = await import('@/components/Layout/Sidebar')
    expect(typeof mod.default).toBe('function')
  })

  it('TopNav default export bir fonksiyondur', async () => {
    const mod = await import('@/components/Layout/TopNav')
    expect(typeof mod.default).toBe('function')
  })

  it('useNavGroups hook + useVisibilityContext export edilmiştir', async () => {
    const mod = await import('@/components/Layout/useNavGroups')
    expect(typeof mod.useNavGroups).toBe('function')
    expect(typeof mod.useVisibilityContext).toBe('function')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 12 ana grup görünürlük matrisi — 4 rol × 12 grup = 48 hücre
// ═════════════════════════════════════════════════════════════════════════════

describe('12 ana grup × 4 rol görünürlük matrisi', () => {
  const ROLES: SystemRole[] = ['super_admin', 'org_admin', 'location_admin', 'viewer']

  it('super_admin tüm 12 grubu görür', () => {
    expect(getVisibleGroups(ctxFor('super_admin'))).toHaveLength(12)
  })

  it('Sprint 1A-fix2: org_admin 11 grubu görür (admin_platform hariç super_admin-only)', () => {
    const groups = getVisibleGroups(ctxFor('org_admin'))
    expect(groups).toHaveLength(11)
    expect(groups.find((g) => g.key === 'admin_platform')).toBeUndefined()
  })

  it('location_admin Dashboard + en az birkaç grup görür', () => {
    const groups = getVisibleGroups(ctxFor('location_admin'))
    expect(groups.length).toBeGreaterThan(0)
    expect(groups.find((g) => g.key === 'dashboard')).toBeDefined()
  })

  it('viewer Dashboard + view-only grupları görür', () => {
    const groups = getVisibleGroups(ctxFor('viewer'))
    expect(groups.find((g) => g.key === 'dashboard')).toBeDefined()
  })

  it('hiç-yetki context\'i: yalnız kısıtsız tab içeren gruplar görünür', () => {
    const deny: VisibilityContext = {
      isSuperAdmin: () => false, hasPermission: () => false,
      can: () => false, features: {},
    }
    const groupKeys = getVisibleGroups(deny).map((g) => g.key)
    expect(groupKeys).toContain('dashboard')
    expect(groupKeys).not.toContain('automation')  // tüm tab'lar kısıtlı
    expect(groupKeys).not.toContain('admin_users') // tüm tab'lar kısıtlı
  })

  it('48 hücre — her rol × her grup için en az 1 görünür tab veya gruba erişim', () => {
    for (const role of ROLES) {
      const visible = new Set(getVisibleGroups(ctxFor(role)).map((g) => g.key))
      for (const group of GROUP_DEFINITIONS) {
        if (visible.has(group.key)) {
          // Görünürse: ya tab içermez (Dashboard) ya da en az 1 yetkili tab
          if (group.tabs.length > 0) {
            expect(getVisibleTabs(group, ctxFor(role)).length,
              `${role}/${group.key} görünür ama yetkili tab yok`).toBeGreaterThan(0)
          }
        }
      }
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Route → aktif grup eşlemesi (Sidebar highlight)
// ═════════════════════════════════════════════════════════════════════════════

describe('Route → aktif grup eşlemesi', () => {
  it('Dashboard rotası → dashboard grubu', () => {
    expect(getActiveGroup('/')).toBe('dashboard')
  })

  it('Inventory route\'ları (7 tab) → inventory grubu', () => {
    // HOTFIX 2026-06-08: /lldp-inventory route sistemde yok; helper'dan
    // çift kayıt silindi. 'discovery' tab'ı LldpInventoryPage'i temsil eder.
    expect(getActiveGroup('/devices')).toBe('inventory')
    expect(getActiveGroup('/topology')).toBe('inventory')
    expect(getActiveGroup('/discovery')).toBe('inventory')
    expect(getActiveGroup('/ipam')).toBe('inventory')
    expect(getActiveGroup('/vlan')).toBe('inventory')
    expect(getActiveGroup('/racks')).toBe('inventory')
    expect(getActiveGroup('/floor-plan')).toBe('inventory')
  })

  it('Monitoring + Alerts + Config + Automation + Security + Reports route\'ları', () => {
    expect(getActiveGroup('/monitor')).toBe('monitoring')
    expect(getActiveGroup('/alert-rules')).toBe('alerts')
    expect(getActiveGroup('/config-drift')).toBe('config')
    expect(getActiveGroup('/tasks')).toBe('automation')
    expect(getActiveGroup('/security-audit')).toBe('security')
    expect(getActiveGroup('/sla')).toBe('reports')
    expect(getActiveGroup('/diagnostics')).toBe('tools')
  })

  it('Admin route\'ları → admin_users / admin_audit / admin_platform', () => {
    expect(getActiveGroup('/users')).toBe('admin_users')
    expect(getActiveGroup('/agents')).toBe('admin_users')
    expect(getActiveGroup('/audit')).toBe('admin_audit')
    expect(getActiveGroup('/terminal-sessions')).toBe('admin_audit')
    expect(getActiveGroup('/superadmin')).toBe('admin_platform')
    expect(getActiveGroup('/settings')).toBe('admin_platform')
    // Sprint 1A-fix2: /org-admin ve /help admin_platform'dan çıkarıldı.
    expect(getActiveGroup('/org-admin')).toBeNull()
    expect(getActiveGroup('/help')).toBeNull()
  })

  it('Drill-down route → ana grup (DeviceDetail)', () => {
    expect(getActiveGroup('/devices/42')).toBe('inventory')
    expect(getActiveGroup('/devices/42/ports')).toBe('inventory')
  })

  it('Substring çakışması: /topology-twin (reports) vs /topology (inventory)', () => {
    expect(getActiveGroup('/topology-twin')).toBe('reports')
    expect(getActiveGroup('/topology')).toBe('inventory')
  })

  it('Bilinmeyen route → null (Sidebar highlight YOK)', () => {
    expect(getActiveGroup('/nope')).toBeNull()
    expect(getActiveGroup('/random/path')).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// İlk yetkili tab yönlendirme (Sidebar grup tıklama)
// ═════════════════════════════════════════════════════════════════════════════

describe('Sidebar grup tıklamasında ilk yetkili tab yönlendirme', () => {
  it('inventory — super_admin için ilk tab Switch (/devices)', () => {
    const tab = getFirstVisibleTab(GROUP_BY_KEY.inventory, ctxFor('super_admin'))
    expect(tab?.key).toBe('switch')
    expect(tab?.route).toBe('/devices')
  })

  it('inventory — devices kapalıysa ikinci tab (Topoloji)', () => {
    const ctx: VisibilityContext = {
      ...ctxFor('org_admin'),
      can: (mod, _action) => mod !== 'devices',
    }
    const tab = getFirstVisibleTab(GROUP_BY_KEY.inventory, ctx)
    expect(tab?.key).toBe('topology')
  })

  it('Sprint 1A-fix2: admin_platform — viewer için yetkili tab yok', () => {
    // admin_platform 2 tab (platform + settings) — her ikisi de super_admin.
    expect(getFirstVisibleTab(GROUP_BY_KEY.admin_platform, ctxFor('viewer'))).toBeNull()
  })

  it('admin_platform — super_admin için Platform Paneli', () => {
    const tab = getFirstVisibleTab(GROUP_BY_KEY.admin_platform, ctxFor('super_admin'))
    expect(tab?.key).toBe('platform')
  })

  it('Sprint 1A-fix2: admin_platform — org_admin için yetkili tab yok (organization silindi)', () => {
    expect(getFirstVisibleTab(GROUP_BY_KEY.admin_platform, ctxFor('org_admin'))).toBeNull()
  })

  it('Dashboard grubunun tab\'ı yok → null (sidebar route="/" zaten)', () => {
    expect(getFirstVisibleTab(GROUP_BY_KEY.dashboard, ctxFor('viewer'))).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Permission filter — yetkisi olmayan tab MenuGroupNav'da görünmez
// ═════════════════════════════════════════════════════════════════════════════

describe('MenuGroupNav permission filter', () => {
  it('viewer config grubunda Firmware/Backups/Drift gizli; templates görünür', () => {
    // Sprint 1A: drift artık org_admin gerektirir (route guard ile hizalı).
    const visible = getVisibleTabs(GROUP_BY_KEY.config, ctxFor('viewer'))
    const visibleKeys = visible.map((t) => t.key)
    expect(visibleKeys).not.toContain('firmware')
    expect(visibleKeys).not.toContain('backups')
    expect(visibleKeys).not.toContain('drift')
    expect(visibleKeys).toContain('templates') // module: ['driver_templates','view']
  })

  it('feature off → ilgili tab gizli (ipam kapalı)', () => {
    const ctx = ctxFor('org_admin', { ipam: false })
    const tab = GROUP_BY_KEY.inventory.tabs.find((t) => t.key === 'ipam')!
    expect(canSeeTab(tab, ctx)).toBe(false)
  })

  it('Sprint 1A-fix2: admin_platform yalnız super_admin\'e görünür', () => {
    // 4 rol × admin_platform görünürlük matrisi (canSeeGroup).
    // Sprint 1A-fix2 öncesinde 4 rol için de görünürdü (help gate'siz +
    // settings module: settings:view); şimdi yalnız super_admin.
    const adminPlatform = GROUP_BY_KEY.admin_platform
    expect(adminPlatform.tabs.every((t) => t.minRole === 'super_admin')).toBe(true)
    expect(adminPlatform.tabs).toHaveLength(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Faz 3 guardrail — Sidebar/TopNav/MenuGroupNav helper kullanımı
// ═════════════════════════════════════════════════════════════════════════════

describe('Faz 3 guardrail\'ları (kullanıcı karar uygulaması)', () => {
  it('Dashboard her zaman görünür, hiçbir koşul gizleyemez', () => {
    const deny: VisibilityContext = {
      isSuperAdmin: () => false, hasPermission: () => false,
      can: () => false, features: { /* hiç feature on */ },
    }
    const groups = getVisibleGroups(deny)
    expect(groups[0].key).toBe('dashboard')
  })

  it('HOTFIX 2026-06-08: Keşif Envanteri tek tab /discovery üzerinden', () => {
    // /lldp-inventory route sistemde yoktu; çift kayıt silindi. Mevcut
    // /discovery route LldpInventoryPage'i render eder; tab adı "Keşif
    // Envanteri" olarak korunur (i18n).
    expect(ROUTE_TO_GROUP['/lldp-inventory']).toBeUndefined()
    expect(ROUTE_TO_GROUP['/discovery']).toBe('inventory')
  })

  it('Sprint 1A-fix2: Karar 5 GERİ ALINDI — Organizasyon Paneli admin_platform\'dan çıkarıldı', () => {
    // Karar 5 (Charon Menu 2026-06-08): Organizasyon Paneli Platform
    // Yönetimi 4. tab, org_admin'e açıktı (excludeSuperAdmin).
    // Sprint 1A-fix2 (manuel smoke sonrası): Platform Yönetimi yalnız
    // super_admin. organization tab silindi.
    expect(GROUP_BY_KEY.admin_platform.tabs.find((t) => t.key === 'organization')).toBeUndefined()
  })

  it('Karar 6: SSH Termination KAPALI — terminal-sessions yalnız read-only audit', () => {
    const sshTab = GROUP_BY_KEY.admin_audit.tabs.find((t) => t.key === 'ssh')!
    expect(sshTab.route).toBe('/terminal-sessions')
    // Hiç yeni terminate route eklenmedi
    expect(ROUTE_TO_GROUP['/terminal-sessions/terminate']).toBeUndefined()
  })

  it('Karar 7: DriverTemplates Config grubunda + module korunur', () => {
    const driversTab = GROUP_BY_KEY.config.tabs.find((t) => t.key === 'drivers')!
    expect(driversTab.route).toBe('/driver-templates')
    expect(driversTab.module).toEqual(['driver_templates', 'view'])
  })
})
