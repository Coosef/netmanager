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

  it('syncs activeOrgId from URL only for super-admin', () => {
    // The useEffect must guard on isPlatformSuperAdmin before calling
    // setOrganization — without this, a normal user would attempt an
    // X-Org-Id override that the backend ignores anyway, and the local
    // SiteContext state would drift away from the JWT-fixed tenant.
    expect(SRC).toMatch(/if\s*\(!isPlatformSuperAdmin\)\s*return/)
    expect(SRC).toMatch(/setOrganization\(routeOrgId\)/)
  })

  it('skips re-sync when activeOrgId already matches routeOrgId (no spurious refetch)', () => {
    // PR #103 anti-flicker contract — never invalidate queries when
    // the active org is already correct.
    expect(SRC).toMatch(/if\s*\(activeOrgId\s*===\s*routeOrgId\)\s*return/)
  })

  it('redirects mismatched non-super-admin to their home org (no scope escalation)', () => {
    // Normal user attempting to visit another tenant's URL gets pushed
    // back to their own /app/org/<userOrgId>/dashboard — the URL cannot
    // be used as a scope-escalation vector.
    expect(SRC).toMatch(
      /Navigate\s+to=\{`\/app\/org\/\$\{userOrgId\}\/dashboard`\}\s+replace/,
    )
  })

  it('defends against invalid :organizationId (NaN, non-positive)', () => {
    expect(SRC).toMatch(/Number\.isFinite\(routeOrgId\)/)
    expect(SRC).toMatch(/routeOrgId\s*<=\s*0|routeOrgId\s*>\s*0/)
  })

  it('waits for ctxResolved before deciding scope (no flash redirect)', () => {
    expect(SRC).toMatch(/if\s*\(!ctxResolved\)\s*return\s*null/)
  })
})
