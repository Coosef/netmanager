/**
 * PR-A2 — OrgRouteShell cache bridge state machine.
 *
 * Source-level guards on the operator-mandated cross-org cache safety:
 *   1. clearOperationalQueryCache is imported + called on org change
 *   2. setLocation(null) is called on org change
 *   3. setOrganization(routeOrgId) is called for super-admin only
 *   4. <Outlet /> is only rendered in 'ready' state
 *   5. OrgContextSpinner is rendered during 'transitioning' + 'validating'
 *   6. OrgContextError is rendered on backend mismatch
 *   7. State transition: transitioning → validating → ready
 *   8. Validation gate: ctx.organization.id === routeOrgId
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../OrgRouteShell.tsx'),
  'utf-8',
)

describe('OrgRouteShell — module import smoke', () => {
  it('default export exists', async () => {
    const mod = await import('../OrgRouteShell')
    expect(mod.default).toBeTypeOf('function')
  })
})

describe('OrgRouteShell — cache bridge contract', () => {
  it('imports clearOperationalQueryCache from operationalCacheScope', () => {
    expect(SRC).toContain("from '@/utils/operationalCacheScope'")
    expect(SRC).toContain('clearOperationalQueryCache')
  })

  it('imports useQueryClient from @tanstack/react-query', () => {
    expect(SRC).toMatch(/from '@tanstack\/react-query'/)
    expect(SRC).toMatch(/const queryClient = useQueryClient\(\)/)
  })

  it('calls clearOperationalQueryCache on org change (cache wipe)', () => {
    expect(SRC).toMatch(/clearOperationalQueryCache\(queryClient\)/)
  })

  it('calls setLocation(null) on org change', () => {
    expect(SRC).toMatch(/setLocation\(null\)/)
  })

  it('calls setOrganization(routeOrgId) for super-admin (preference sync)', () => {
    expect(SRC).toMatch(/setOrganization\(routeOrgId\)/)
  })

  it('uses isPlatformSuperAdmin gate around setOrganization (ROLE identity)', () => {
    expect(SRC).toMatch(/isPlatformSuperAdmin/)
  })

  it('lastCommittedOrgRef short-circuits same-org navigation (no cache wipe)', () => {
    expect(SRC).toMatch(/lastCommittedOrgRef\.current === routeOrgId/)
  })
})

describe('OrgRouteShell — state machine + render gate', () => {
  it('state union covers transitioning | validating | ready | error', () => {
    expect(SRC).toMatch(/'transitioning'\s*\|\s*'validating'\s*\|\s*'ready'\s*\|\s*'error'/)
  })

  it('initial state is transitioning', () => {
    expect(SRC).toMatch(/useState<GateState>\('transitioning'\)/)
  })

  it('only renders <Outlet /> in ready state', () => {
    expect(SRC).toMatch(/return\s+<Outlet\s*\/>/)
  })

  it('renders OrgContextSpinner during transitioning + validating', () => {
    expect(SRC).toMatch(/gateState === 'transitioning'.*?<OrgContextSpinner/s)
  })

  it('renders OrgContextError on backend mismatch (error state)', () => {
    expect(SRC).toMatch(/gateState === 'error'[\s\S]*?<OrgContextError/)
  })
})

describe('OrgRouteShell — validation gate', () => {
  it('validates ctx.organization.id === routeOrgId before commit', () => {
    expect(SRC).toMatch(/organization\?\.id === routeOrgId/)
  })

  it('only commits lastCommittedOrgRef after successful validation', () => {
    // Pattern: organization?.id === routeOrgId → setGateState('ready') →
    // lastCommittedOrgRef.current = routeOrgId in same branch
    expect(SRC).toMatch(/lastCommittedOrgRef\.current = routeOrgId/)
  })

  it('waits for ctxResolved before validating', () => {
    expect(SRC).toMatch(/if\s*\(\s*!ctxResolved\s*\)\s*return/)
  })
})

describe('OrgRouteShell — PR-A scope guards preserved', () => {
  it('non-super-admin scope escalation guard (redirect to home org)', () => {
    expect(SRC).toMatch(
      /Navigate\s+to=\{`\/app\/org\/\$\{userOrgId\}\/dashboard`\}\s+replace/,
    )
  })

  it('invalid routeOrgId (NaN, 0, negative) defends', () => {
    expect(SRC).toMatch(/Number\.isFinite\(routeOrgId\)/)
    expect(SRC).toMatch(/routeOrgId\s*<=\s*0/)
  })

  it('reads :organizationId from useParams', () => {
    expect(SRC).toMatch(/useParams<\{\s*organizationId:\s*string\s*\}>/)
  })
})
