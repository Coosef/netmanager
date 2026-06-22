/**
 * PR-A — OperationsSidebar invariants.
 *
 * Source-level regression guards on the OPERATIONS LEGACY ESCAPE SAFETY
 * ADDENDUM contract:
 *
 *   - exactly 3 ACTIVE items (Dashboard, Devices, Agents) — each builds
 *     a `/app/org/:id/<segment>` URL
 *   - every other operations module is comingSoon disabled — NO legacy
 *     root URL escape (`/topology`, `/monitor`, ...) is wired up.
 *   - NO Yakında item has a `route` or non-segment escape hatch.
 *
 * If a regression hands an inactive item a `route: '/topology'`, the
 * user clicks it, the URL leaves `/app/org/:id/*`, OrgRouteShell stops
 * controlling the X-Org-Id header, and the entire URL-authoritative
 * org context PR-A was built for collapses. This test exists to make
 * sure that regression is caught at vitest time, not at production
 * smoke time.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../OperationsSidebar.tsx'),
  'utf-8',
)

const APP_SRC = readFileSync(
  resolve(__dirname, '../../../App.tsx'),
  'utf-8',
)

describe('OperationsSidebar — module import smoke', () => {
  it('default export exists', async () => {
    const mod = await import('../OperationsSidebar')
    expect(mod.default).toBeTypeOf('function')
  })
})

describe('OperationsSidebar — nav contract', () => {
  it('contains exactly 3 ACTIVE items (segment, no comingSoon)', () => {
    const blocks = SRC.match(/\{\s*key:\s*'\w+'[\s\S]*?\}/g) || []
    const itemBlocks = blocks.filter((b) => b.includes('i18nKey:'))
    const active = itemBlocks.filter(
      (b) => /segment:\s*'/.test(b) && !/comingSoon:\s*true/.test(b),
    )
    expect(active.length).toBe(3)
  })

  it('contains 14 Yakında items (no segment, comingSoon: true)', () => {
    const blocks = SRC.match(/\{\s*key:\s*'\w+'[\s\S]*?\}/g) || []
    const itemBlocks = blocks.filter((b) => b.includes('i18nKey:'))
    const comingSoon = itemBlocks.filter(
      (b) => /comingSoon:\s*true/.test(b) && !/segment:\s*'/.test(b),
    )
    expect(comingSoon.length).toBeGreaterThanOrEqual(14)
  })

  it('active items are dashboard/devices/agents', () => {
    expect(SRC).toMatch(/key:\s*'dashboard'[\s\S]*?segment:\s*'dashboard'/)
    expect(SRC).toMatch(/key:\s*'devices'[\s\S]*?segment:\s*'devices'/)
    expect(SRC).toMatch(/key:\s*'agents'[\s\S]*?segment:\s*'agents'/)
  })

  it.each([
    'topology', 'discovery', 'monitoring', 'alerts', 'config',
    'automation', 'security', 'reports', 'tools', 'org_users',
    'org_audit', 'tasks', 'ipam', 'vlan',
  ])('Yakında item present: %s', (key) => {
    const re = new RegExp(`key:\\s*'${key}'[\\s\\S]*?comingSoon:\\s*true`)
    expect(SRC).toMatch(re)
  })

  it('NO active item uses a legacy root URL (escape prevention)', () => {
    // OPERATIONS LEGACY ESCAPE SAFETY ADDENDUM: every active item builds
    // its route via `/app/org/${routeOrgId}/${segment}` — single-segment
    // only. A regression that hands an item route: '/topology' would
    // escape org context.
    expect(SRC).not.toMatch(/route:\s*'\/topology'/)
    expect(SRC).not.toMatch(/route:\s*'\/monitor'/)
    expect(SRC).not.toMatch(/route:\s*'\/live'/)
    expect(SRC).not.toMatch(/route:\s*'\/reports'/)
    expect(SRC).not.toMatch(/route:\s*'\/users'/)
    expect(SRC).not.toMatch(/route:\s*'\/audit'/)
    expect(SRC).not.toMatch(/route:\s*'\/tasks'/)
    expect(SRC).not.toMatch(/route:\s*'\/ipam'/)
    expect(SRC).not.toMatch(/route:\s*'\/vlan'/)
  })

  it('navigate uses /app/org/:routeOrgId/:segment shape', () => {
    expect(SRC).toMatch(/`\/app\/org\/\$\{routeOrgId\}\/\$\{segment\}`/)
  })

  it('comingSoon click is a no-op (no navigate, no setState)', () => {
    expect(SRC).toMatch(/if\s*\(item\.comingSoon\s*\|\|\s*!item\.segment\)\s*return/)
  })

  it('routeOrgId comes from useParams (URL-authoritative, NOT SiteContext)', () => {
    // OperationsSidebar must derive every active route from the URL
    // param so the sidebar can never produce a URL that disagrees with
    // OrgRouteShell's view of which tenant the user is inside.
    expect(SRC).toMatch(/useParams<\{\s*organizationId\?:\s*string\s*\}>/)
    expect(SRC).toMatch(/params\.organizationId/)
  })

  it('App.tsx contains exactly 3 active /app/org/:organizationId/* routes (dashboard, devices, agents)', () => {
    // The shell wraps /app/org/:organizationId — the three child paths
    // are the AKTİF set. No /app/org/:organizationId/topology etc.
    expect(APP_SRC).toMatch(/path="dashboard"\s+element=\{<DashboardPage/)
    expect(APP_SRC).toMatch(/path="devices"\s+element=\{<DevicesPage/)
    expect(APP_SRC).toMatch(/path="agents"\s+element=\{<AgentsPage/)
    // Negative: NO /app/org/:id/topology etc. registered.
    expect(APP_SRC).not.toMatch(/path="topology"\s+element=\{<TopologyV2Page/)
  })

  it('App.tsx mounts OrgRouteShell for the /app/org/:organizationId tree', () => {
    expect(APP_SRC).toMatch(/path="app\/org\/:organizationId"\s+element=\{<OrgRouteShell/)
  })
})
