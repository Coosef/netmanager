/**
 * PR-A — PlatformSidebar invariants.
 *
 * Source-level regression guards on the PLATFORM NAV SCOPE SAFETY
 * ADDENDUM contract:
 *
 *   - exactly 2 ACTIVE items (route + no comingSoon)
 *   - exactly 7 YAKINDA items (comingSoon + no route)
 *   - NO inactive route is registered in App.tsx for Yakında items
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../PlatformSidebar.tsx'),
  'utf-8',
)

const APP_SRC = readFileSync(
  resolve(__dirname, '../../../App.tsx'),
  'utf-8',
)

describe('PlatformSidebar — module import smoke', () => {
  it('default export exists', async () => {
    const mod = await import('../PlatformSidebar')
    expect(mod.default).toBeTypeOf('function')
  })
})

describe('PlatformSidebar — nav contract', () => {
  it('contains exactly 2 ACTIVE items (route, no comingSoon)', () => {
    // Match every item literal block.
    const blocks = SRC.match(/\{\s*key:\s*'\w+'[\s\S]*?\}/g) || []
    const itemBlocks = blocks.filter((b) => b.includes('i18nKey:'))
    const active = itemBlocks.filter(
      (b) => /route:\s*'/.test(b) && !/comingSoon:\s*true/.test(b),
    )
    expect(active.length).toBe(2)
  })

  it('contains 7 YAKINDA items (comingSoon, no route)', () => {
    const blocks = SRC.match(/\{\s*key:\s*'\w+'[\s\S]*?\}/g) || []
    const itemBlocks = blocks.filter((b) => b.includes('i18nKey:'))
    const comingSoon = itemBlocks.filter(
      (b) => /comingSoon:\s*true/.test(b) && !/route:\s*'/.test(b),
    )
    expect(comingSoon.length).toBe(7)
  })

  it('active items are `overview` and `organizations`', () => {
    expect(SRC).toMatch(/key:\s*'overview'[\s\S]*?route:\s*'\/platform\/overview'/)
    expect(SRC).toMatch(/key:\s*'organizations'[\s\S]*?route:\s*'\/platform\/organizations'/)
  })

  it.each([
    'users', 'roles', 'licenses', 'global_health', 'global_audit', 'retention', 'settings',
  ])('Yakında item present: %s', (key) => {
    const re = new RegExp(`key:\\s*'${key}'[\\s\\S]*?comingSoon:\\s*true`)
    expect(SRC).toMatch(re)
  })

  it('renders Yakında badge via sidebar.coming_soon_badge i18n key', () => {
    expect(SRC).toContain("'sidebar.coming_soon_badge'")
  })

  it('comingSoon items have onClick that returns no-op (no navigate)', () => {
    // The handleClick MUST short-circuit on comingSoon || !route.
    expect(SRC).toMatch(/if\s*\(item\.comingSoon\s*\|\|\s*!item\.route\)\s*return/)
  })

  it('App.tsx does NOT register inactive platform routes (PLATFORM NAV SCOPE SAFETY)', () => {
    // Per addendum: no /platform/users, /platform/roles, etc. routes.
    expect(APP_SRC).not.toMatch(/path="users"[\s\S]{0,40}element=\{<PlatformShell/)
    for (const seg of [
      'platform/users', 'platform/roles', 'platform/licenses',
      'platform/global-health', 'platform/global-audit',
      'platform/retention', 'platform/settings',
    ]) {
      const re = new RegExp(`path="${seg.replace(/\//g, '\\/')}"`)
      expect(APP_SRC).not.toMatch(re)
    }
  })

  it('App.tsx DOES register active platform routes', () => {
    expect(APP_SRC).toMatch(/path="overview"\s+element=\{<PlatformOverviewPage/)
    expect(APP_SRC).toMatch(/path="organizations"\s+element=\{<PlatformOrganizationsPage/)
    expect(APP_SRC).toMatch(/path="organizations\/:organizationId"\s+element=\{<PlatformOrganizationDetailPage/)
  })
})
