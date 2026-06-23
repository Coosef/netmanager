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

  it('P0 HOTFIX — transitionStartedOrgRef short-circuits same-org navigation (no cache wipe)', () => {
    expect(SRC).toMatch(/transitionStartedOrgRef\.current === routeOrgId/)
  })

  it('P0 HOTFIX — old lastCommittedOrgRef identifier is GONE (only mentioned in historical comments)', () => {
    // The old name implied the ref was set on validation success only.
    // P0 hotfix renames to `transitionStartedOrgRef` AND moves the
    // assignment to the START of the transition (optimistic lock) so
    // dependency-cycle re-fires short-circuit immediately.
    // The old identifier may still appear in historical-context comments
    // (renamed from / load-bearing bug). Strip comments before asserting.
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(codeOnly).not.toMatch(/lastCommittedOrgRef/)
  })
})

describe('OrgRouteShell — P0 HOTFIX optimistic transition lock', () => {
  it('transitionStartedOrgRef assigned BEFORE clearOperationalQueryCache (optimistic lock at top of effect)', () => {
    // The lock must be acquired BEFORE the cache wipe + state updates
    // so any dep-change re-entry during the same render cycle hits the
    // short-circuit guard. Without this, isPlatformSuperAdmin /
    // activeOrgId flicker during the cache-wipe → ctx-refetch cycle
    // re-entered the transition body, kept wiping the ctx query, and
    // hammered /context/current at ~6 req/sec in production.
    // Strip comments before order-asserting.
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const assignIdx = codeOnly.indexOf('transitionStartedOrgRef.current = routeOrgId')
    const wipeIdx = codeOnly.indexOf('clearOperationalQueryCache(queryClient)')
    expect(assignIdx).toBeGreaterThan(0)
    expect(wipeIdx).toBeGreaterThan(0)
    expect(assignIdx).toBeLessThan(wipeIdx)
  })

  it('guard appears BEFORE the optimistic assignment (early-return on same routeOrgId)', () => {
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const guardIdx = codeOnly.indexOf('transitionStartedOrgRef.current === routeOrgId')
    const assignIdx = codeOnly.indexOf('transitionStartedOrgRef.current = routeOrgId')
    expect(guardIdx).toBeGreaterThan(0)
    expect(assignIdx).toBeGreaterThan(0)
    expect(guardIdx).toBeLessThan(assignIdx)
  })

  it('validation-success branch does NOT re-assign the ref (already committed at transition start)', () => {
    // The success branch only flips gateState to 'ready'; the
    // optimistic ref was already set at transition start. A regression
    // that adds `transitionStartedOrgRef.current = routeOrgId` inside
    // the success branch would still work but signals confusion.
    const successBlock = SRC.match(/if \(organization\?\.id === routeOrgId\) \{([\s\S]*?)\} else if/)?.[1] ?? ''
    expect(successBlock).not.toMatch(/transitionStartedOrgRef\.current = routeOrgId/)
    expect(successBlock).toMatch(/setGateState\('ready'\)/)
  })

  it('error/retry handler resets transitionStartedOrgRef to null', () => {
    // P0 HOTFIX retry contract: clearing the ref releases the optimistic
    // lock so the next dep-change tick re-fires the transition.
    expect(SRC).toMatch(/onRetry=\{\(\) => \{[\s\S]+?transitionStartedOrgRef\.current = null/)
  })

  it('error/retry handler re-acquires the lock after cache wipe (before setGateState validating)', () => {
    // Defensive: the retry handler RE-SETS the ref to routeOrgId AFTER
    // the cache wipe so the imminent dep-change re-fire short-circuits.
    expect(SRC).toMatch(
      /onRetry=\{[\s\S]+?clearOperationalQueryCache\(queryClient\)[\s\S]+?transitionStartedOrgRef\.current = routeOrgId/,
    )
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

  it('P0 HOTFIX: validation success flips gateState to ready (ref already committed at transition start)', () => {
    // After P0 hotfix, the validation effect does NOT re-assign the ref
    // (it was already set at transition start via the optimistic lock).
    // It only transitions gateState to 'ready' on a successful match.
    // Strip comments before order-asserting (the success branch carries
    // an explanatory comment block that would otherwise blow the gap).
    const codeOnly = SRC.replace(/\/\/[^\n]*\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    const cmpIdx = codeOnly.indexOf('organization?.id === routeOrgId')
    const readyIdx = codeOnly.indexOf("setGateState('ready')")
    expect(cmpIdx).toBeGreaterThan(0)
    expect(readyIdx).toBeGreaterThan(0)
    expect(cmpIdx).toBeLessThan(readyIdx)
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
