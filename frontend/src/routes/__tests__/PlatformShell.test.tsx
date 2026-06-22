/**
 * PR-A — PlatformShell guard.
 *
 * Source-level regression guards on the super_admin-only `/platform/*`
 * gate. Mirrors the convention in RootRedirect.test.tsx.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../PlatformShell.tsx'),
  'utf-8',
)

describe('PlatformShell — module import smoke', () => {
  it('default export exists', async () => {
    const mod = await import('../PlatformShell')
    expect(mod.default).toBeTypeOf('function')
  })
})

describe('PlatformShell — super_admin-only gate', () => {
  it('uses useAuthStore to read user.system_role', () => {
    expect(SRC).toContain("from '@/store/auth'")
    expect(SRC).toMatch(/user\?.system_role|user\.system_role/)
  })

  it('renders <Outlet /> on the happy path', () => {
    expect(SRC).toMatch(/return\s+<Outlet\s*\/>/)
  })

  it('redirects non-super-admin to /', () => {
    expect(SRC).toMatch(/<Navigate\s+to="\/"\s+replace\s*\/>/)
  })

  it('gate considers ROLE identity (system_role) not BYPASS state (is_super_admin)', () => {
    // A scoped super-admin (X-Org-Id active) has system_role==='super_admin'
    // but backend ctx.is_super_admin===false. The gate MUST let them
    // walk back to the platform panel — using the role identity, NOT
    // the bypass-state. This locks down the regression PR #107
    // closed for the OrganizationSelector visibility check.
    expect(SRC).toMatch(/system_role\s*!==\s*'super_admin'/)
    expect(SRC).toContain('isPlatformSuperAdmin')
  })

  it('waits for ctxResolved before redirecting (no flash)', () => {
    expect(SRC).toMatch(/if\s*\(!ctxResolved\)\s*return\s*null/)
  })
})
