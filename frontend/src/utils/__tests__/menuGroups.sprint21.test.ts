// @vitest-environment jsdom
/**
 * RBAC-SPRINT-2.1 — Intelligence menu + route gate alignment tests.
 *
 * Pre-Sprint-2.1 the /intelligence tab (analytics analytics under the
 * Monitoring group) was gated by `minRole: 'org_admin'`. Sprint 2.1
 * re-aligns it to `module: ['monitoring', 'view']` so:
 *
 *   1. The gate cascade for Intelligence matches the other Monitoring
 *      surface tabs (alerts, live, bandwidth, mac-arp) which already
 *      use `monitoring:view`. Consistency reduces operator surprise.
 *   2. A location_admin whose permission set grants `monitoring:view`
 *      can see Intelligence within their location scope (backend
 *      already implements RLS-based scoping via Device.location_id
 *      on every risk-score / MTTR / anomaly query).
 *   3. The permission matrix keeps its Phase 1 cardinality — no new
 *      module row for a single-verb read-only surface (mirrors the
 *      Phase 1 topology:view decision).
 *
 * Also pinned: App.tsx source-grep regression to catch any future
 * refactor that reverts /intelligence to RoleRoute.
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
      if (role === 'super_admin' || role === 'org_admin') return true
      return !!grants[mod]?.[action]
    },
    features: opts.features ?? {},
  }
}

// ─── Lookup Intelligence tab ─────────────────────────────────────────────────

const INTELLIGENCE_TAB = GROUP_BY_KEY.monitoring.tabs.find((t) => t.key === 'analytics')!

// ═════════════════════════════════════════════════════════════════════════════
// Tab gate definition
// ═════════════════════════════════════════════════════════════════════════════

describe('Sprint 2.1 — Intelligence tab uses monitoring:view module gate', () => {
  it('analytics tab is gated by module=[monitoring, view] and NOT minRole', () => {
    expect(INTELLIGENCE_TAB.module).toEqual(['monitoring', 'view'])
    expect(INTELLIGENCE_TAB.minRole).toBeUndefined()
  })
  it('analytics tab lives in the monitoring group', () => {
    expect(INTELLIGENCE_TAB.route).toBe('/intelligence')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Visibility scenarios
// ═════════════════════════════════════════════════════════════════════════════

describe('Sprint 2.1 — Intelligence visibility by role + permission', () => {
  it('location_admin with monitoring.view = true → visible', () => {
    const ctx = ctxFor('location_admin', {
      grants: { monitoring: { view: true } },
    })
    expect(canSeeTab(INTELLIGENCE_TAB, ctx)).toBe(true)
  })

  it('location_admin without monitoring.view → hidden', () => {
    const ctx = ctxFor('location_admin')
    expect(canSeeTab(INTELLIGENCE_TAB, ctx)).toBe(false)
  })

  it('viewer without monitoring.view → hidden', () => {
    const ctx = ctxFor('viewer')
    expect(canSeeTab(INTELLIGENCE_TAB, ctx)).toBe(false)
  })

  it('viewer with monitoring.view = true → visible', () => {
    const ctx = ctxFor('viewer', {
      grants: { monitoring: { view: true } },
    })
    expect(canSeeTab(INTELLIGENCE_TAB, ctx)).toBe(true)
  })

  it('org_admin → visible (PermissionEngine bypass mirror)', () => {
    const ctx = ctxFor('org_admin')
    expect(canSeeTab(INTELLIGENCE_TAB, ctx)).toBe(true)
  })

  it('super_admin → visible', () => {
    const ctx = ctxFor('super_admin')
    expect(canSeeTab(INTELLIGENCE_TAB, ctx)).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// App.tsx route gate alignment — source-grep regression pin
// ═════════════════════════════════════════════════════════════════════════════

describe('App.tsx route gate uses PermRoute(monitoring, view) for /intelligence', () => {
  const appSrc = readFileSync(
    path.resolve(process.cwd(), 'src/App.tsx'),
    'utf-8',
  )

  it('/intelligence uses PermRoute(monitoring, view) on BOTH mounts', () => {
    const matches = appSrc.match(
      /path="intelligence"[^>]*<PermRoute module="monitoring" action="view">/g,
    )
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('no RoleRoute(minRole="org_admin") survives on /intelligence', () => {
    const pattern = /path="intelligence"[^>]*<RoleRoute minRole="org_admin">/
    expect(appSrc).not.toMatch(pattern)
  })
})
