// @vitest-environment jsdom
/**
 * RBAC-SPRINT-2.2B2 — Services module regression pins.
 *
 * Sprint 2.2B2 is a BACKEND-authorization-only PR. The frontend does
 * only two things:
 *   1. Adds a Services row to the Permission Matrix (view + manage
 *      verbs) so an org_admin can toggle the new backend gates via
 *      the UI editor.
 *   2. INTENTIONALLY leaves the /services route + menu at
 *      RoleRoute(minRole="org_admin") — no PermRoute migration, no
 *      location_admin visibility expansion.
 *
 * These tests pin the intentional non-changes so a future PR that
 * migrates Services to PermRoute must also update this test file
 * (providing an intentional review checkpoint).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { GROUP_BY_KEY } from '@/utils/menuGroups'

// ═════════════════════════════════════════════════════════════════════════
// menuGroups.ts — services tab still uses minRole gate
// ═════════════════════════════════════════════════════════════════════════

describe('Sprint 2.2B2 — services menu tab is UNCHANGED (regression pin)', () => {
  const servicesTab = GROUP_BY_KEY.alerts.tabs.find((t) => t.key === 'services')!

  it('services tab exists in the alerts group', () => {
    expect(servicesTab).toBeDefined()
    expect(servicesTab.route).toBe('/services')
  })
  it('services tab still gates on minRole=org_admin', () => {
    expect(servicesTab.minRole).toBe('org_admin')
  })
  it('services tab has NO module gate (not migrated to PermRoute)', () => {
    // Regression pin: Sprint 2.2B2 is backend-authorization-only.
    // If a future PR opens Services to location_admin, it should
    // ALSO update this assertion.
    expect(servicesTab.module).toBeUndefined()
  })
  it('services tab has NO feature flag yet', () => {
    // No `_feat("services")` in router.py → no `feature` field
    // needed on the menu entry. Kept as intentional pin so a
    // future feature-flag alignment PR touches this test too.
    expect(servicesTab.feature).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════
// App.tsx — services route still uses RoleRoute on BOTH mounts
// ═════════════════════════════════════════════════════════════════════════

describe('App.tsx /services route gate is UNCHANGED (regression pin)', () => {
  const appSrc = readFileSync(
    path.resolve(process.cwd(), 'src/App.tsx'),
    'utf-8',
  )

  it('/services still uses RoleRoute(minRole="org_admin") on BOTH mounts', () => {
    const matches = appSrc.match(
      /path="services"[^>]*<RoleRoute minRole="org_admin">/g,
    )
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('/services has NOT silently migrated to PermRoute during this PR', () => {
    // If a future PR wants to open Services to location_admin, it
    // should ALSO update this test. Until then, no PermRoute
    // wrapper on /services is permitted.
    expect(appSrc).not.toMatch(/path="services"[^>]*<PermRoute module="services"/)
  })
})
