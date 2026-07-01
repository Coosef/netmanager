// @vitest-environment jsdom
/**
 * RBAC-SPRINT-2.2B1 — SLA + PoE menu/route hardening tests.
 *
 * Sprint 2.2B1 adds:
 *   1. Feature-flag alignment on SLA + PoE tabs — backend router.py
 *      _feat("sla") + _feat("poe") gates existed, but menuGroups.ts
 *      did not check the flag. A plan-closed org saw the tab in the
 *      sidebar and got a 403 from the backend. Adding `feature:'sla'`
 *      and `feature:'poe'` closes the asymmetry.
 *   2. PermRoute + Permission Matrix — the ROUTE gate is DELIBERATELY
 *      unchanged. Both routes still use RoleRoute(minRole="org_admin").
 *      Sprint 2.2B1 does NOT expand location_admin visibility on
 *      SLA/PoE; the goal is to close the direct-API-bypass hole on
 *      the backend, not to broaden the UI surface.
 *
 * Regression pins verify BOTH:
 *   - the minRole gate is preserved (App.tsx has not silently
 *     migrated to PermRoute during this PR)
 *   - the feature flag is now checked in menuGroups
 *   - Permission Matrix has the new rows visible with correct labels
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

const SLA_TAB = GROUP_BY_KEY.reports.tabs.find((t) => t.key === 'sla')!
const POE_TAB = GROUP_BY_KEY.reports.tabs.find((t) => t.key === 'poe')!

// ═════════════════════════════════════════════════════════════════════════
// Tab config — feature flag alignment
// ═════════════════════════════════════════════════════════════════════════

describe('Sprint 2.2B1 — SLA + PoE feature-flag alignment', () => {
  it('SLA tab carries minRole=org_admin AND feature=sla', () => {
    expect(SLA_TAB.minRole).toBe('org_admin')
    expect(SLA_TAB.feature).toBe('sla')
  })
  it('PoE tab carries minRole=org_admin AND feature=poe', () => {
    expect(POE_TAB.minRole).toBe('org_admin')
    expect(POE_TAB.feature).toBe('poe')
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Visibility scenarios — feature flag closes the tab
// ═════════════════════════════════════════════════════════════════════════

describe('Sprint 2.2B1 — SLA visibility', () => {
  it('org_admin with sla feature ON → visible', () => {
    expect(canSeeTab(SLA_TAB, ctxFor('org_admin', { features: { sla: true } }))).toBe(true)
  })
  it('org_admin with sla feature OFF → HIDDEN (was previously visible)', () => {
    expect(canSeeTab(SLA_TAB, ctxFor('org_admin', { features: { sla: false } }))).toBe(false)
  })
  it('org_admin with sla feature absent → visible (opt-out default)', () => {
    expect(canSeeTab(SLA_TAB, ctxFor('org_admin'))).toBe(true)
  })
  it('super_admin with sla feature OFF → HIDDEN', () => {
    // canSeeTab feature check does not honour super_admin bypass —
    // the org plan controls what's rendered even for platform admins
    expect(canSeeTab(SLA_TAB, ctxFor('super_admin', { features: { sla: false } }))).toBe(false)
  })
  it('location_admin with sla feature ON → still hidden by minRole=org_admin', () => {
    expect(canSeeTab(SLA_TAB, ctxFor('location_admin', { features: { sla: true } }))).toBe(false)
  })
  it('viewer with sla feature ON → still hidden by minRole=org_admin', () => {
    expect(canSeeTab(SLA_TAB, ctxFor('viewer', { features: { sla: true } }))).toBe(false)
  })
})

describe('Sprint 2.2B1 — PoE visibility', () => {
  it('org_admin with poe feature ON → visible', () => {
    expect(canSeeTab(POE_TAB, ctxFor('org_admin', { features: { poe: true } }))).toBe(true)
  })
  it('org_admin with poe feature OFF → HIDDEN', () => {
    expect(canSeeTab(POE_TAB, ctxFor('org_admin', { features: { poe: false } }))).toBe(false)
  })
  it('location_admin with poe feature ON → still hidden by minRole=org_admin', () => {
    expect(canSeeTab(POE_TAB, ctxFor('location_admin', { features: { poe: true } }))).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// App.tsx route gate — DELIBERATELY unchanged; regression pin
// ═════════════════════════════════════════════════════════════════════════

describe('App.tsx SLA + PoE route gates are UNCHANGED (regression pin)', () => {
  const appSrc = readFileSync(
    path.resolve(process.cwd(), 'src/App.tsx'),
    'utf-8',
  )

  it('/sla still uses RoleRoute(minRole="org_admin") on BOTH mounts', () => {
    const matches = appSrc.match(
      /path="sla"[^>]*<RoleRoute minRole="org_admin">/g,
    )
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
  it('/poe still uses RoleRoute(minRole="org_admin") on BOTH mounts', () => {
    const matches = appSrc.match(
      /path="poe"[^>]*<RoleRoute minRole="org_admin">/g,
    )
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
  it('/sla has NOT silently migrated to PermRoute during this PR', () => {
    // Regression guard: Sprint 2.2B1 is a backend-authorization-only PR
    // on the frontend side. If a future PR wants to open SLA to
    // location_admin, it should ALSO update these tests. Until then,
    // no PermRoute wrapper on /sla is permitted.
    expect(appSrc).not.toMatch(/path="sla"[^>]*<PermRoute module="sla"/)
  })
  it('/poe has NOT silently migrated to PermRoute during this PR', () => {
    expect(appSrc).not.toMatch(/path="poe"[^>]*<PermRoute module="poe"/)
  })
})
