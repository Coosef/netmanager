/**
 * PR-A — OrgRouteShell contract.
 *
 * Source-level regression guards on the URL-authoritative org context.
 * Every claim the rest of PR-A makes about activeOrgId staying in sync
 * with the :organizationId URL param relies on this shell's logic, so
 * we lock it down at the source level (mirrors the codebase convention
 * established in RootRedirect.test.tsx).
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

describe('OrgRouteShell — URL-authoritative contract', () => {
  it('reads :organizationId from useParams', () => {
    expect(SRC).toContain("from 'react-router-dom'")
    expect(SRC).toMatch(/useParams<\{\s*organizationId:\s*string\s*\}>/)
  })

  it('renders <Outlet /> on the happy path', () => {
    expect(SRC).toMatch(/return\s+<Outlet\s*\/>/)
  })

  it('uses useAuthStore to detect super-admin + read user.org_id', () => {
    expect(SRC).toContain("from '@/store/auth'")
    expect(SRC).toMatch(/system_role\s*===\s*'super_admin'/)
    expect(SRC).toMatch(/user\?\.org_id/)
  })

  it('syncs activeOrgId from URL for super-admin (PR-A2: only inside transition block)', () => {
    // PR-A2 — the setOrganization call is gated on isPlatformSuperAdmin
    // within the transition phase (not at top of effect). Normal users
    // skip the preference sync since the backend ignores X-Org-Id for them.
    expect(SRC).toMatch(/isPlatformSuperAdmin/)
    expect(SRC).toMatch(/setOrganization\(routeOrgId\)/)
  })

  it('PR-A2: lastCommittedOrgRef short-circuits same-org navigation', () => {
    // PR-A2 replaces the PR-A `if (activeOrgId === routeOrgId) return`
    // pattern with a ref-based commit-on-validation check so cache wipe
    // only fires when the org actually changes from the previously-
    // validated value.
    expect(SRC).toMatch(/lastCommittedOrgRef\.current === routeOrgId/)
  })

  it('redirects mismatched non-super-admin to their home org (no scope escalation)', () => {
    expect(SRC).toMatch(
      /Navigate\s+to=\{`\/app\/org\/\$\{userOrgId\}\/dashboard`\}\s+replace/,
    )
  })

  it('defends against invalid :organizationId (NaN, non-positive)', () => {
    expect(SRC).toMatch(/Number\.isFinite\(routeOrgId\)/)
    expect(SRC).toMatch(/routeOrgId\s*<=\s*0|routeOrgId\s*>\s*0/)
  })

  it('PR-A2: validating phase waits for ctxResolved', () => {
    // The validation effect runs only in `gateState === 'validating'`
    // and short-circuits while ctx is not yet resolved.
    expect(SRC).toMatch(/if\s*\(\s*!ctxResolved\s*\)\s*return/)
  })
})
