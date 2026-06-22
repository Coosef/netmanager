/**
 * PR-A — LegacyRedirect contract.
 *
 * Three legacy entry points (`/dashboard`, `/devices`, `/agents`) keep
 * working for bookmarks / external links / email but redirect to the
 * URL-authoritative `/app/org/:resolvedOrgId/<segment>`. The resolution
 * order (activeOrgId → user.org_id) is locked down here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SRC = readFileSync(
  resolve(__dirname, '../LegacyRedirect.tsx'),
  'utf-8',
)

describe('LegacyRedirect — module import smoke', () => {
  it('default export exists', async () => {
    const mod = await import('../LegacyRedirect')
    expect(mod.default).toBeTypeOf('function')
  })
})

describe('LegacyRedirect — org resolution contract', () => {
  it('accepts segment: dashboard | devices | agents (PR-A allowlist)', () => {
    expect(SRC).toMatch(/segment:\s*'dashboard'\s*\|\s*'devices'\s*\|\s*'agents'/)
  })

  it('redirects to /app/org/:resolvedOrgId/:segment', () => {
    expect(SRC).toMatch(
      /Navigate\s+to=\{`\/app\/org\/\$\{resolvedOrgId\}\/\$\{segment\}`\}\s+replace/,
    )
  })

  it('resolution order: activeOrgId → user.org_id', () => {
    expect(SRC).toMatch(/activeOrgId\s*\?\?\s*user\.org_id\s*\?\?\s*null/)
  })

  it('super-admin without resolved org → /platform/overview', () => {
    expect(SRC).toMatch(/<Navigate\s+to="\/platform\/overview"\s+replace\s*\/>/)
  })

  it('non-super-admin without resolved org → / (RootRedirect handles fallback)', () => {
    expect(SRC).toMatch(/<Navigate\s+to="\/"\s+replace\s*\/>/)
  })

  it('waits for ctxResolved before deciding (no premature redirect)', () => {
    expect(SRC).toMatch(/if\s*\(!ctxResolved\)\s*return\s*null/)
  })
})
