// @vitest-environment jsdom
/**
 * RBAC-PHASE-1 — Discovery / VLAN / Racks / Map menu + route gates.
 *
 * Before Phase 1 these four inventory tabs were gated by
 * `minRole: 'org_admin'` which is orthogonal to the PermissionSet —
 * a location_admin with "Tam Yetki" could not see them. Phase 1
 * converts the gate to `module: [<feature>, 'view']` so the same
 * permission grid that drives the other RBAC tabs drives these too.
 *
 * The tests below mirror the operator scenarios (A–J) from the prompt:
 *   A. location_admin + discovery:view  → can see Discovery tab + route
 *   B. location_admin + vlan:view       → can see VLAN tab + route
 *   C. location_admin + racks:view      → can see Racks tab + route
 *   D. location_admin + maps:view       → can see Map tab + route
 *   E. location_admin without the perms → cannot see any of the four
 *   F. (location scope) — enforced by backend RLS; documented but not
 *      asserted client-side (frontend has no `location_id` scope to
 *      simulate; the RoleRoute removal does not regress that gate)
 *   G. org_admin / super_admin keep access — covered by H
 *   H. Tam Yetki preset includes the four modules — see
 *      test_rbac_phase1_feature_module_catalog.py::test_full_preset_…
 *   I. racks API verb gates — see test_rbac_phase1 backend file
 *   J. (feature flag) — Racks `feature: 'racks'` is preserved so a
 *      feature-flag-closed org still hides the tab even when the
 *      permission is granted; ipam is the existing reference case.
 *
 * App.tsx route-level gate change (RoleRoute → PermRoute on the
 * 4 routes) is pinned via a source-grep regression so a future
 * refactor cannot silently revert it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  GROUP_BY_KEY,
  canSeeTab,
  type VisibilityContext,
} from '@/utils/menuGroups'
import type { SystemRole } from '@/types'

// ─── Test context builder ────────────────────────────────────────────────────

/**
 * Builds the visibility context a location_admin user with a customised
 * `Tam Yetki`-style permission set would see. `can()` follows the same
 * shape useAuthStore exposes in production — module/action lookup.
 */
function ctxFor(
  role: SystemRole,
  opts: {
    grants?: Record<string, Record<string, boolean>>
    features?: Record<string, boolean>
  } = {},
): VisibilityContext {
  const ROLE_ORDER: SystemRole[] = ['viewer', 'location_admin', 'org_admin', 'super_admin']
  const myIdx = ROLE_ORDER.indexOf(role)
  const grants = opts.grants ?? {}
  return {
    isSuperAdmin: () => role === 'super_admin',
    hasPermission: (minRole) => myIdx >= ROLE_ORDER.indexOf(minRole),
    can: (mod, action) => {
      // super_admin + org_admin bypass — mirrors backend PermissionEngine
      if (role === 'super_admin' || role === 'org_admin') return true
      return !!grants[mod]?.[action]
    },
    features: opts.features ?? {},
  }
}

// ─── Lookups ────────────────────────────────────────────────────────────────

const INVENTORY = GROUP_BY_KEY.inventory
const TABS = {
  discovery: INVENTORY.tabs.find((t) => t.key === 'discovery')!,
  vlan:      INVENTORY.tabs.find((t) => t.key === 'vlan')!,
  racks:     INVENTORY.tabs.find((t) => t.key === 'racks')!,
  map:       INVENTORY.tabs.find((t) => t.key === 'map')!,
}

// ═════════════════════════════════════════════════════════════════════════════
// Tab gate definition matrix
// ═════════════════════════════════════════════════════════════════════════════

describe('Phase 1 — inventory tabs use module gates, not minRole', () => {
  it('discovery tab is gated by module=[discovery, view]', () => {
    expect(TABS.discovery.module).toEqual(['discovery', 'view'])
    expect(TABS.discovery.minRole).toBeUndefined()
  })
  it('vlan tab is gated by module=[vlan, view]', () => {
    expect(TABS.vlan.module).toEqual(['vlan', 'view'])
    expect(TABS.vlan.minRole).toBeUndefined()
  })
  it('racks tab is gated by module=[racks, view] AND keeps feature=racks', () => {
    expect(TABS.racks.module).toEqual(['racks', 'view'])
    expect(TABS.racks.minRole).toBeUndefined()
    expect(TABS.racks.feature).toBe('racks')
  })
  it('map tab is gated by module=[maps, view]', () => {
    expect(TABS.map.module).toEqual(['maps', 'view'])
    expect(TABS.map.minRole).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A — D. location_admin with full grant on each module sees its tab
// ═════════════════════════════════════════════════════════════════════════════

describe('A–D — location_admin with the granted module can see each tab', () => {
  it('(A) discovery.view = true → discovery tab visible', () => {
    const ctx = ctxFor('location_admin', {
      grants: { discovery: { view: true } },
    })
    expect(canSeeTab(TABS.discovery, ctx)).toBe(true)
  })
  it('(B) vlan.view = true → vlan tab visible', () => {
    const ctx = ctxFor('location_admin', {
      grants: { vlan: { view: true } },
    })
    expect(canSeeTab(TABS.vlan, ctx)).toBe(true)
  })
  it('(C) racks.view = true + features.racks enabled → racks tab visible', () => {
    const ctx = ctxFor('location_admin', {
      grants: { racks: { view: true } },
      features: { racks: true },
    })
    expect(canSeeTab(TABS.racks, ctx)).toBe(true)
  })
  it('(D) maps.view = true → map tab visible', () => {
    const ctx = ctxFor('location_admin', {
      grants: { maps: { view: true } },
    })
    expect(canSeeTab(TABS.map, ctx)).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// E. Same user without the permissions does NOT see the tabs
// ═════════════════════════════════════════════════════════════════════════════

describe('E — location_admin without the granted module cannot see the tab', () => {
  it('discovery.view = false → discovery tab hidden', () => {
    const ctx = ctxFor('location_admin')   // no grants
    expect(canSeeTab(TABS.discovery, ctx)).toBe(false)
  })
  it('vlan.view = false → vlan tab hidden', () => {
    const ctx = ctxFor('location_admin')
    expect(canSeeTab(TABS.vlan, ctx)).toBe(false)
  })
  it('racks.view = false → racks tab hidden (even when features.racks = true)', () => {
    const ctx = ctxFor('location_admin', { features: { racks: true } })
    expect(canSeeTab(TABS.racks, ctx)).toBe(false)
  })
  it('maps.view = false → map tab hidden', () => {
    const ctx = ctxFor('location_admin')
    expect(canSeeTab(TABS.map, ctx)).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// G. org_admin / super_admin keep access (PermissionEngine bypass mirror)
// ═════════════════════════════════════════════════════════════════════════════

describe('G — org_admin and super_admin keep their pre-Phase-1 access', () => {
  it('org_admin can see all four tabs without explicit grants', () => {
    const ctx = ctxFor('org_admin', { features: { racks: true } })
    expect(canSeeTab(TABS.discovery, ctx)).toBe(true)
    expect(canSeeTab(TABS.vlan, ctx)).toBe(true)
    expect(canSeeTab(TABS.racks, ctx)).toBe(true)
    expect(canSeeTab(TABS.map, ctx)).toBe(true)
  })
  it('super_admin can see all four tabs without explicit grants', () => {
    const ctx = ctxFor('super_admin', { features: { racks: true } })
    expect(canSeeTab(TABS.discovery, ctx)).toBe(true)
    expect(canSeeTab(TABS.vlan, ctx)).toBe(true)
    expect(canSeeTab(TABS.racks, ctx)).toBe(true)
    expect(canSeeTab(TABS.map, ctx)).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// J. feature flag closed still hides the tab (Racks) when granted
// ═════════════════════════════════════════════════════════════════════════════

describe('J — feature-flag-closed org hides tab even when permission granted', () => {
  it('racks feature OFF + racks.view true → tab still hidden', () => {
    const ctx = ctxFor('location_admin', {
      grants: { racks: { view: true } },
      features: { racks: false },
    })
    expect(canSeeTab(TABS.racks, ctx)).toBe(false)
  })
  it('racks feature OFF + super_admin → tab still hidden (existing behavior)', () => {
    const ctx = ctxFor('super_admin', { features: { racks: false } })
    expect(canSeeTab(TABS.racks, ctx)).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// App.tsx route gate alignment — source-grep regression pin
// ═════════════════════════════════════════════════════════════════════════════

describe('App.tsx route gates use PermRoute, not RoleRoute', () => {
  const appSrc = readFileSync(
    path.resolve(process.cwd(), 'src/App.tsx'),
    'utf-8',
  )

  // The same gate must appear in BOTH mount blocks (canonical
  // /app/org/:id/* and legacy single-segment). A future refactor
  // that only updates one of them is exactly the regression this
  // test catches.
  it('/discovery uses PermRoute(discovery, view)', () => {
    const matches = appSrc.match(
      /path="discovery"[^>]*<PermRoute module="discovery" action="view">/g,
    )
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
  it('/vlan uses PermRoute(vlan, view)', () => {
    const matches = appSrc.match(
      /path="vlan"[^>]*<PermRoute module="vlan" action="view">/g,
    )
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
  it('/racks uses PermRoute(racks, view)', () => {
    const matches = appSrc.match(
      /path="racks"[^>]*<PermRoute module="racks" action="view">/g,
    )
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
  it('/floor-plan uses PermRoute(maps, view)', () => {
    const matches = appSrc.match(
      /path="floor-plan"[^>]*<PermRoute module="maps" action="view">/g,
    )
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
  it('no RoleRoute(minRole="org_admin") survives on the four Phase 1 routes', () => {
    // Build the negative set: a regex matching any of the four
    // routes that is STILL wrapped in RoleRoute would indicate
    // partial migration.
    const PHASE1_ROUTES = ['discovery', 'vlan', 'racks', 'floor-plan']
    for (const route of PHASE1_ROUTES) {
      const pattern = new RegExp(
        `path="${route}"[^>]*<RoleRoute minRole="org_admin">`,
      )
      expect(appSrc).not.toMatch(pattern)
    }
  })
})
